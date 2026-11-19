import type Database from 'better-sqlite3';
import Decimal from 'decimal.js';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import {
  calculatePositions,
  cashBalanceRub,
  findPossibleDuplicates,
  normalizeCode,
  type PossibleDuplicate,
} from '@core';
import { InstrumentIdentityService } from '../app/modules/instruments/instrument-identity.service';
import { instrumentIdentifiers, instruments, operations, portfolios } from './schema';
import { rowToOperation } from './operation-row';
import { insertIdentifier } from './instrument-identifiers-store';

/**
 * Миграция данных: уже существующие дубли в справочнике (TMON@ рядом с TMON и т. п.).
 * Выполняется ТЕМ ЖЕ кодом слияния, что и кнопка «Слить» (InstrumentIdentityService.merge),
 * а не отдельным SQL — поэтому и результат тот же: идентификаторы переезжают на цель.
 *
 * Три класса случаев:
 *  1. Детерминированные — тикер после нормализации совпал с тикером другого инструмента
 *     того же типа и валюты → слияние.
 *  2. Одиночный «TMON@» (пары нет) — id НЕ меняем (на него ссылаются операции, цены,
 *     котировки): правим только отображаемый ticker и добавляем идентификатор; источник
 *     цены пользователь выбирает сам (подсказка в отчёте).
 *  3. Недетерминированные (TCS00… ↔ RU000…) — автоматически не трогаем, только в отчёт.
 */
export interface MergeStep {
  sourceId: string;
  targetId: string;
  operations: number;
  reason: string;
}
export interface RenameStep {
  instrumentId: string;
  from: string;
  to: string;
  hint: string;
}
export interface DuplicateMergePlan {
  merges: MergeStep[];
  renames: RenameStep[];
  /** только отчёт: решает человек */
  manual: Array<{ a: string; b: string; reason: string }>;
}

type Db = BetterSQLite3Database;

export function planDuplicateMerge(db: Db): DuplicateMergePlan {
  const all = db.select().from(instruments).all();
  const opCount = (id: string): number => db.select().from(operations).where(eq(operations.instrumentId, id)).all().length;
  const dups = findPossibleDuplicates(
    all.map((i) => ({ id: i.id, ticker: i.ticker, type: i.type, currency: i.currency, name: i.name, isin: i.isin })),
  );

  const merges: MergeStep[] = [];
  const manual: DuplicateMergePlan['manual'] = [];
  const consumed = new Set<string>();
  for (const d of dups) {
    // цель — тот, чей тикер уже в нормализованном виде (TMON), источник — «TMON@»
    if (d.deterministic) {
      const [target, source] = orderByNormalized(d);
      if (consumed.has(source.id)) continue;
      consumed.add(source.id);
      merges.push({ sourceId: source.id, targetId: target.id, operations: opCount(source.id), reason: d.reason });
    } else {
      manual.push({ a: d.a.id, b: d.b.id, reason: d.reason });
    }
  }

  const merging = new Set(merges.map((m) => m.sourceId));
  const renames: RenameStep[] = [];
  for (const i of all) {
    const normalized = normalizeCode(i.ticker);
    if (!normalized || normalized === i.ticker || merging.has(i.id)) continue;
    renames.push({
      instrumentId: i.id,
      from: i.ticker,
      to: normalized,
      hint:
        i.marketSource === 'manual'
          ? `у «${i.id}» источник цены «manual» — выберите источник (например «Найти цену через API» для ${normalized}), id не меняется`
          : `источник цены: ${i.marketSource}`,
    });
  }
  return { merges, renames, manual };
}

function orderByNormalized(d: PossibleDuplicate): [PossibleDuplicate['a'], PossibleDuplicate['a']] {
  return d.a.ticker === normalizeCode(d.a.ticker) ? [d.a, d.b] : [d.b, d.a];
}

/** Применить план: слияния через общий сервис, переименование — только поле ticker */
export function applyDuplicateMerge(db: Db, plan: DuplicateMergePlan, identity: InstrumentIdentityService): void {
  for (const m of plan.merges) identity.merge(m.sourceId, m.targetId);
  for (const r of plan.renames) {
    db.update(instruments).set({ ticker: r.to }).where(eq(instruments.id, r.instrumentId)).run();
    insertIdentifier(db, { scheme: 'ticker', value: r.to, instrumentId: r.instrumentId, origin: 'manual' });
  }
}

// ───────────────────────── инварианты ─────────────────────────

export interface PortfolioInvariants {
  portfolioId: string;
  name: string;
  operations: number;
  openPositions: number;
  investedRub: string;
  realizedPnlRub: string;
  incomeRub: string;
  cashRub: string;
}
export interface Invariants {
  operations: number;
  portfolios: PortfolioInvariants[];
}

/**
 * Что НЕ должно меняться от слияния дублей: число операций, по каждому портфелю —
 * количество позиций, вложено, реализованный P&L, доходы и кэш. Считается чистым
 * движком из журнала (те же функции, что и /api/operations/summary), без цен: меняться
 * может только оценка инструмента, у которого появилась цена.
 */
export function collectInvariants(db: Db): Invariants {
  const ops = db.select().from(operations).all().map(rowToOperation);
  const futureIds = new Set(
    db.select().from(instruments).all().filter((i) => i.type === 'Future').map((i) => i.id),
  );
  const rows = db.select().from(portfolios).all().map((p) => {
    const mine = ops.filter((o) => o.portfolioId === p.id);
    const positions = calculatePositions(mine, { futureIds });
    const sum = (f: (pos: (typeof positions)[number]) => Decimal): string =>
      positions.reduce((acc, pos) => acc.plus(f(pos)), new Decimal(0)).toFixed(2);
    return {
      portfolioId: p.id,
      name: p.name,
      operations: mine.length,
      openPositions: positions.filter((x) => !x.quantity.isZero()).length,
      investedRub: sum((x) => x.investedRub),
      realizedPnlRub: sum((x) => x.realizedPnlRub),
      incomeRub: sum((x) => x.dividendsRub.plus(x.couponsRub)),
      cashRub: cashBalanceRub(mine, futureIds).toFixed(2),
    };
  });
  return { operations: ops.length, portfolios: rows };
}

/** Различия инвариантов до/после; пусто — всё совпало */
export function diffInvariants(before: Invariants, after: Invariants): string[] {
  const out: string[] = [];
  if (before.operations !== after.operations) out.push(`операций было ${before.operations}, стало ${after.operations}`);
  for (const b of before.portfolios) {
    const a = after.portfolios.find((x) => x.portfolioId === b.portfolioId);
    if (!a) {
      out.push(`портфель «${b.name}» исчез`);
      continue;
    }
    for (const k of ['operations', 'openPositions', 'investedRub', 'realizedPnlRub', 'incomeRub', 'cashRub'] as const) {
      if (b[k] !== a[k]) out.push(`«${b.name}»: ${k} было ${b[k]}, стало ${a[k]}`);
    }
  }
  return out;
}

/**
 * Применяет план одной транзакцией с проверкой инвариантов до/после: расхождение →
 * ROLLBACK и отчёт. Резервную копию файла БД делает вызывающий (CLI) заранее.
 */
export function runDuplicateMerge(
  sqlite: Database.Database,
  plan: DuplicateMergePlan,
): { applied: boolean; before: Invariants; after: Invariants; problems: string[] } {
  const db = drizzle(sqlite);
  const identity = new InstrumentIdentityService(db);
  const before = collectInvariants(db);
  sqlite.exec('BEGIN');
  try {
    applyDuplicateMerge(db, plan, identity);
    const after = collectInvariants(db);
    const problems = diffInvariants(before, after);
    if (problems.length > 0) {
      sqlite.exec('ROLLBACK');
      return { applied: false, before, after, problems };
    }
    sqlite.exec('COMMIT');
    return { applied: true, before, after, problems };
  } catch (e) {
    sqlite.exec('ROLLBACK');
    throw e;
  }
}

/** Сколько идентификаторов у инструмента — для отчёта */
export function identifierCount(db: Db, instrumentId: string): number {
  return db.select().from(instrumentIdentifiers).where(eq(instrumentIdentifiers.instrumentId, instrumentId)).all().length;
}
