import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { and, asc, eq, inArray, like, ne, or } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import {
  DEBT_RATE_PER_DAY,
  QsnapFormatError,
  assessSnapshots,
  buildYv1Overview,
  countRawLines,
  curveToCsv,
  cyclesToDailyResults,
  parseAutomatDaily,
  parseAutomatLog,
  parseAutomatSignals,
  parseAutomatTrades,
  parseQsnapIndex,
  parseQsnapRaw,
  pivotSnapshot,
  type AutomatDay,
  type AutomatLogDay,
  type AutomatSignal,
  type AutomatTrade,
  type FeeRounding,
  type QsnapRawRow,
  type SnapshotAssessment,
  type Yv1Corridor,
  type Yv1Overview,
  type Yv1SnapshotInput,
} from '@core';
import { fromAppRoot } from '../../../app-paths';
import { recordSnapshotInvalidation } from '../../../db/snapshot-invalidations';
import { StrategySourceError, loadStrategyContext, type StrategyContext } from './strategy-context';
import {
  qsnapRaw,
  qsnapSnapshots,
  strategyConfigs,
  strategyDailyResults,
  systems,
  yv1AutomatDays,
  yv1AutomatLogs,
  yv1AutomatSignals,
  yv1AutomatTrades,
  yv1Settings,
} from '../../../db/schema';

export interface Yv1Paths {
  /** каталог from_quik моста — ТОЛЬКО ЧТЕНИЕ */
  bridgeDir: string;
  /** бэктестовая кривая `date,ret,equity` стратегического репозитория — только чтение; null — не найдена */
  backtestCsv: string | null;
  /** заранее заданный коридор; null — файла нет */
  corridorFile: string | null;
}

/**
 * Пути берутся из окружения, а не зашиваются:
 *  - QUIK_BRIDGE_DIR (по умолчанию ~/quik_bridge/from_quik);
 *  - YV1_BACKTEST_CSV (по умолчанию соседний репозиторий strategy-backtester-vectorbt);
 *  - YV1_CORRIDOR_FILE (по умолчанию docs/yv1-corridor.json).
 */
export function resolveYv1Paths(env: NodeJS.ProcessEnv = process.env): Yv1Paths {
  const bridgeDir = env['QUIK_BRIDGE_DIR'] ?? join(homedir(), 'quik_bridge', 'from_quik');
  const sibling = resolve(
    fromAppRoot('..'),
    'strategy-backtester-vectorbt/data-reports/yv1_2vh_rub_report_2026-11-05/daily_yv1_2vh.csv',
  );
  const backtest = env['YV1_BACKTEST_CSV'] ?? sibling;
  const corridor = env['YV1_CORRIDOR_FILE'] ?? fromAppRoot('docs', 'yv1-corridor.json');
  return {
    bridgeDir,
    backtestCsv: existsSync(backtest) ? backtest : null,
    corridorFile: existsSync(corridor) ? corridor : null,
  };
}

const cp1251 = new TextDecoder('windows-1251');
/** Файлы моста — cp1251 (читаем побайтово, не меняя файл) */
const readCp1251 = (path: string): string => cp1251.decode(readFileSync(path));
const readUtf8 = (path: string): string => readFileSync(path, 'utf-8');

export interface SnapshotImportReport {
  total: number;
  imported: string[];
  alreadyImported: number;
  /** не целые: записаны в журнал снимков, в расчёт не идут */
  incomplete: { snapId: string; reasons: string[] }[];
  /** есть в raw, нет в индексе */
  unfinished: string[];
  /** уже импортированный снимок изменился в файле — не перезаписываем */
  conflicts: string[];
}

export interface AutomatImportReport {
  trades: number;
  days: number;
  signals: number;
  logs: number;
  missingFiles: string[];
  skipped: string[];
}

export interface Yv1RefreshReport {
  at: string;
  snapshots: SnapshotImportReport;
  automat: AutomatImportReport;
  /** сколько дней результата записано в ленту портфеля */
  resultDays: number;
}

const SettingsSchema = z.object({
  initialCapital: z.string().regex(/^\d+(\.\d+)?$/, 'Капитал — положительное число').nullable(),
  feeRounding: z.enum(['ceil', 'half-up']),
  debtRatePerDay: z.string().regex(/^\d+(\.\d+)?$/),
  backtestScale: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
});
export type Yv1SettingsState = z.infer<typeof SettingsSchema>;
export const Yv1SettingsPatchSchema = SettingsSchema.partial();
export type Yv1SettingsPatch = z.infer<typeof Yv1SettingsPatchSchema>;

const CorridorFileSchema = z.object({
  minCycles: z.number().int().min(0).default(30),
  netPerCycleRetPct: z.object({ min: z.number().nullable(), max: z.number().nullable() }),
});

const UNFINISHED_KEY = 'unfinishedSnapshots';
/** Таблицы, нужные расчёту; остальное сырьё хранится, но при расчёте не читается */
const NEEDED_TABLES = [
  'trades',
  'orders',
  'futures_client_holding',
  'futures_client_limits',
  'money_limits',
  'calc_trades',
];

/** Текущее время МСК как `YYYY-MM-DD HH:MM:SS` */
export function nowMsk(date: Date = new Date()): string {
  return date.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' });
}

/**
 * Хранилище среза ЮВ1: импорт файлов моста и автомата в БД и сборка обзора.
 * Без Nest-зависимостей — одинаково работает из API и из CLI (`pnpm yv1:refresh`).
 *
 * Идемпотентность:
 *  - снимок импортируется целиком в одной транзакции под ключом snap_id; повтор и
 *    перезапуск с середины не дублируют строки;
 *  - уже импортированный снимок, изменившийся в файле, не перезаписывается — попадает в `conflicts`;
 *  - файлы автомата переписываются upsert'ом по trade_num / дате.
 */
export class Yv1Store {
  /** Контекст стратегии: без него хранилище не знает, чьи это данные */
  readonly ctx: StrategyContext;

  /**
   * @param systemId какая стратегия; без него берётся единственная с адаптером quik-bridge
   */
  constructor(
    private readonly db: BetterSQLite3Database,
    private readonly paths: Yv1Paths = resolveYv1Paths(),
    systemId?: string,
  ) {
    this.ctx = loadStrategyContext(db, systemId);
  }

  refresh(): Yv1RefreshReport {
    const snapshots = this.importSnapshots();
    const automat = this.importAutomat();
    const resultDays = this.materializeResults();
    return { at: nowMsk(), snapshots, automat, resultDays };
  }

  /**
   * Пересобрать ленту реализованного результата стратегии (`strategy_daily_results`) из
   * закрытых циклов. Лента производная: целиком заменяется в одной транзакции, поэтому
   * повтор идемпотентен, а исправленные данные источника не оставляют устаревших дней.
   */
  materializeResults(): number {
    const days = cyclesToDailyResults(this.overview().cycles);
    // что изменилось против прежней ленты: добавленные, исчезнувшие и поправленные дни
    const before = new Map(
      this.db
        .select({ date: strategyDailyResults.date, netRub: strategyDailyResults.netRub })
        .from(strategyDailyResults)
        .where(eq(strategyDailyResults.systemId, this.ctx.systemId))
        .all()
        .map((r) => [r.date, r.netRub]),
    );
    const after = new Map(days.map((d) => [d.date, d.netRub]));
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((d) => before.get(d) !== after.get(d)).sort();
    this.db.transaction((tx) => {
      tx.delete(strategyDailyResults).where(eq(strategyDailyResults.systemId, this.ctx.systemId)).run();
      for (const d of days) {
        tx.insert(strategyDailyResults)
          .values({
            systemId: this.ctx.systemId,
            date: d.date,
            pricePnlRub: d.pricePnlRub,
            costsRub: d.costsRub,
            debtInterestRub: d.debtInterestRub,
            netRub: d.netRub,
            cycles: d.cycles,
          })
          .run();
      }
    });
    // Лента входит в P&L и деньги портфеля: правка задним числом портит уже снятые снимки.
    // Для новых дней позже последнего снимка recordSnapshotInvalidation ничего не пишет.
    if (changed.length > 0) {
      const name = this.db.select({ name: systems.name }).from(systems).where(eq(systems.id, this.ctx.systemId)).get()?.name;
      recordSnapshotInvalidation(this.db, {
        kind: 'strategy-sync',
        operationDate: changed[0],
        description: `Результат стратегии «${name ?? this.ctx.systemId}»: изменилось дней — ${changed.length}`,
        affectedCount: changed.length,
      });
    }
    return days.length;
  }

  /**
   * Привязать счёт стратегии к портфелю. Лента результата читает портфель из конфига, ей
   * перезапись не нужна. Снимки моста не трогаем: они описывают счёт целиком, и один каталог
   * моста — это один счёт, общий для всех стратегий на нём.
   */
  linkPortfolio(portfolioId: string): void {
    this.db.update(strategyConfigs).set({ portfolioId }).where(eq(strategyConfigs.systemId, this.ctx.systemId)).run();
    this.ctx.portfolioId = portfolioId;
  }

  /* -------------------------------------------------------------- импорт снимков */

  importSnapshots(): SnapshotImportReport {
    const rawPath = join(this.paths.bridgeDir, 'qsnap_raw.csv');
    const indexPath = join(this.paths.bridgeDir, 'qsnap_index.csv');
    for (const p of [rawPath, indexPath]) {
      if (!existsSync(p)) throw new StrategySourceError(`Файл моста не найден: ${p}. Проверьте QUIK_BRIDGE_DIR.`);
    }
    const rawRows = parseQsnapRaw(readCp1251(rawPath));
    const index = parseQsnapIndex(readCp1251(indexPath));
    const { snapshots, unfinished } = assessSnapshots(index, countRawLines(rawRows));

    const existing = new Map(
      this.db
        .select({ snapId: qsnapSnapshots.snapId, rawLines: qsnapSnapshots.rawLines, complete: qsnapSnapshots.complete })
        .from(qsnapSnapshots)
        .all()
        .map((r) => [r.snapId, r]),
    );

    const rawBySnap = new Map<string, QsnapRawRow[]>();
    const completeToImport = new Set(
      snapshots.filter((s) => s.complete && !existing.has(s.snapId)).map((s) => s.snapId),
    );
    for (const r of rawRows) {
      if (!completeToImport.has(r.snapId)) continue;
      let list = rawBySnap.get(r.snapId);
      if (!list) rawBySnap.set(r.snapId, (list = []));
      list.push(r);
    }

    const report: SnapshotImportReport = {
      total: snapshots.length,
      imported: [],
      alreadyImported: 0,
      incomplete: [],
      unfinished,
      conflicts: [],
    };

    for (const a of snapshots) {
      const prev = existing.get(a.snapId);
      if (prev) {
        if (prev.rawLines !== a.index.rawLines || prev.complete !== (a.complete ? 1 : 0)) {
          report.conflicts.push(a.snapId);
        } else {
          report.alreadyImported++;
        }
        if (!a.complete) report.incomplete.push({ snapId: a.snapId, reasons: a.reasons });
        continue;
      }
      this.db.transaction((tx) => {
        tx.insert(qsnapSnapshots)
          .values({
            snapId: a.snapId,
            portfolioId: this.ctx.portfolioId,
            localTime: a.index.localTime,
            serverTime: a.index.serverTime,
            serverTimeEnd: a.index.serverTimeEnd,
            tradeDate: a.index.tradeDate,
            connected: a.index.connected ? 1 : 0,
            quikVersion: a.index.quikVersion,
            scriptVersion: a.index.scriptVersion,
            status: a.index.status,
            rawLines: a.index.rawLines,
            rawBytes: a.index.rawBytes,
            floatIds: a.index.floatIds,
            counts: a.index.counts,
            errors: a.index.errors,
            clockSkewSec: a.clockSkewSec,
            complete: a.complete ? 1 : 0,
            reasons: a.reasons.join(' | '),
          })
          .onConflictDoNothing()
          .run();
        const raw = rawBySnap.get(a.snapId) ?? [];
        for (let i = 0; i < raw.length; i += 1000) {
          tx.insert(qsnapRaw)
            .values(
              raw.slice(i, i + 1000).map((r) => ({
                snapId: r.snapId,
                tableName: r.table,
                rowNo: r.row,
                field: r.field,
                value: r.value,
              })),
            )
            .onConflictDoNothing()
            .run();
        }
      });
      report.imported.push(a.snapId);
      if (!a.complete) report.incomplete.push({ snapId: a.snapId, reasons: a.reasons });
    }

    this.setSetting(UNFINISHED_KEY, JSON.stringify(unfinished));
    return report;
  }

  /* -------------------------------------------------------------- импорт файлов автомата */

  importAutomat(): AutomatImportReport {
    const dir = this.paths.bridgeDir;
    if (!existsSync(dir)) throw new StrategySourceError(`Каталог моста не найден: ${dir}. Проверьте QUIK_BRIDGE_DIR.`);
    const names = readdirSync(dir);
    const prefix = this.ctx.params.journalPrefix;
    const f = {
      trades: `${prefix}_trades.csv`,
      tradesBefore: new RegExp(`^${prefix}_trades_before_.*\\.csv$`),
      fills: `${prefix}_fills.csv`,
      daily: `${prefix}_daily.csv`,
      signals: `${prefix}_signals.csv`,
      signalsBefore: new RegExp(`^${prefix}_signals_before_.*\\.csv$`),
      log: new RegExp(`^${prefix}_log_(\\d{4}-\\d{2}-\\d{2})\\.txt$`),
    };
    const report: AutomatImportReport = { trades: 0, days: 0, signals: 0, logs: 0, missingFiles: [], skipped: [] };

    // сделки: основной журнал первым — при совпадении trade_num он выигрывает
    const tradeFiles = [
      ...names.filter((n) => n === f.trades),
      ...names.filter((n) => f.tradesBefore.test(n)).sort(),
      ...names.filter((n) => n === f.fills),
    ];
    if (!names.includes(f.trades)) report.missingFiles.push(f.trades);
    const trades = new Map<string, AutomatTrade>();
    for (const file of tradeFiles) {
      try {
        for (const t of parseAutomatTrades(readUtf8(join(dir, file)), file)) if (!trades.has(t.tradeNum)) trades.set(t.tradeNum, t);
      } catch (e) {
        if (!(e instanceof QsnapFormatError)) throw e;
        report.skipped.push(`${file}: ${e.message}`);
      }
    }
    // номер сделки глобален: если он уже записан в журнал другой стратегии — не отбираем его
    const foreign = new Set<string>();
    const tradeNums = [...trades.keys()];
    for (let i = 0; i < tradeNums.length; i += 500) {
      for (const r of this.db
        .select({ tradeNum: yv1AutomatTrades.tradeNum })
        .from(yv1AutomatTrades)
        .where(and(inArray(yv1AutomatTrades.tradeNum, tradeNums.slice(i, i + 500)), ne(yv1AutomatTrades.systemId, this.ctx.systemId)))
        .all()) {
        foreign.add(r.tradeNum);
      }
    }
    for (const num of foreign) {
      trades.delete(num);
      report.skipped.push(`сделка ${num} уже в журнале другой стратегии`);
    }
    this.db.transaction((tx) => {
      for (const t of trades.values()) {
        const values = {
          tradeNum: t.tradeNum,
          systemId: this.ctx.systemId,
          orderNum: t.orderNum,
          date: t.date,
          time: t.time,
          contract: t.contract,
          side: t.side,
          qty: t.qty,
          price: t.price,
          reason: t.reason,
          refPrice: t.refPrice,
          slipRub: t.slipRub,
          brokerFeeQuik: t.brokerFeeQuik,
          exchangeFee: t.exchangeFee,
          clearingFee: t.clearingFee,
          techCenterFee: t.techCenterFee,
          sourceFile: t.sourceFile,
        };
        tx.insert(yv1AutomatTrades).values(values).onConflictDoUpdate({ target: yv1AutomatTrades.tradeNum, set: values }).run();
      }
    });
    report.trades = trades.size;

    const upsertByDate = (
      table: typeof yv1AutomatDays | typeof yv1AutomatSignals | typeof yv1AutomatLogs,
      items: { date: string }[],
    ): void => {
      this.db.transaction((tx) => {
        for (const it of items) {
          const payload = JSON.stringify(it);
          tx.insert(table)
            .values({ systemId: this.ctx.systemId, date: it.date, payload })
            .onConflictDoUpdate({ target: [table.systemId, table.date], set: { payload } })
            .run();
        }
      });
    };

    if (names.includes(f.daily)) {
      try {
        const days = parseAutomatDaily(readUtf8(join(dir, f.daily)));
        upsertByDate(yv1AutomatDays, days);
        report.days = days.length;
      } catch (e) {
        if (!(e instanceof QsnapFormatError)) throw e;
        report.skipped.push(`${f.daily}: ${e.message}`);
      }
    } else report.missingFiles.push(f.daily);

    // основной файл первым — при пересечении дат он выигрывает (как и у журнала сделок)
    const signalFiles = [
      ...names.filter((n) => n === f.signals),
      ...names.filter((n) => f.signalsBefore.test(n)).sort(),
    ];
    const signals = new Map<string, AutomatSignal>();
    for (const file of signalFiles) {
      try {
        for (const s of parseAutomatSignals(readUtf8(join(dir, file)))) if (!signals.has(s.date)) signals.set(s.date, s);
      } catch (e) {
        if (!(e instanceof QsnapFormatError)) throw e;
        report.skipped.push(`${file}: ${e.message}`);
      }
    }
    upsertByDate(yv1AutomatSignals, [...signals.values()]);
    report.signals = signals.size;

    const logs: AutomatLogDay[] = [];
    for (const n of names) {
      const m = n.match(f.log);
      if (!m) continue;
      try {
        logs.push(parseAutomatLog(readUtf8(join(dir, n)), m[1]));
      } catch (e) {
        if (!(e instanceof QsnapFormatError)) throw e;
        report.skipped.push(`${n}: ${e.message}`);
      }
    }
    upsertByDate(yv1AutomatLogs, logs);
    report.logs = logs.length;
    return report;
  }

  /* -------------------------------------------------------------- настройки */

  getSettings(): Yv1SettingsState {
    const map = new Map(
      this.db
        .select()
        .from(yv1Settings)
        .where(eq(yv1Settings.systemId, this.ctx.systemId))
        .all()
        .map((r) => [r.key, r.value]),
    );
    return {
      initialCapital: map.get('initialCapital') ?? null,
      feeRounding: (map.get('feeRounding') as FeeRounding | undefined) ?? 'ceil',
      debtRatePerDay: map.get('debtRatePerDay') ?? DEBT_RATE_PER_DAY,
      backtestScale: map.get('backtestScale') ?? null,
    };
  }

  updateSettings(patch: Yv1SettingsPatch): Yv1SettingsState {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        this.db
          .delete(yv1Settings)
          .where(and(eq(yv1Settings.systemId, this.ctx.systemId), eq(yv1Settings.key, key)))
          .run();
      }
      else if (value !== undefined) this.setSetting(key, value);
    }
    return this.getSettings();
  }

  private setSetting(key: string, value: string): void {
    this.db
      .insert(yv1Settings)
      .values({ systemId: this.ctx.systemId, key, value })
      .onConflictDoUpdate({ target: [yv1Settings.systemId, yv1Settings.key], set: { value } })
      .run();
  }

  /* -------------------------------------------------------------- обзор */

  overview(now: string = nowMsk()): Yv1Overview {
    // Снимки — данные счёта, общие для всех стратегий на этом мосте: фильтра по портфелю нет.
    // (`portfolio_id` у снимка — лишь пометка, чьим портфелем он был импортирован.)
    const rows = this.db.select().from(qsnapSnapshots).orderBy(asc(qsnapSnapshots.snapId)).all();
    const assessments: SnapshotAssessment[] = rows.map((r) => ({
      snapId: r.snapId,
      index: {
        snapId: r.snapId,
        localTime: r.localTime,
        serverTime: r.serverTime,
        serverTimeEnd: r.serverTimeEnd,
        tradeDate: r.tradeDate,
        connected: r.connected === 1,
        quikVersion: r.quikVersion,
        scriptVersion: r.scriptVersion,
        status: r.status,
        rawLines: r.rawLines,
        rawBytes: r.rawBytes,
        floatIds: r.floatIds,
        counts: r.counts,
        errors: r.errors,
      },
      rawLinesActual: r.rawLines,
      complete: r.complete === 1,
      reasons: r.reasons ? r.reasons.split(' | ') : [],
      clockSkewSec: r.clockSkewSec,
    }));

    const completeIds = assessments.filter((a) => a.complete).map((a) => a.snapId);
    const rawBySnap = new Map<string, QsnapRawRow[]>();
    // пачками по snap_id — не упираемся в лимит переменных SQLite
    for (let i = 0; i < completeIds.length; i += 200) {
      const raw = this.db
        .select()
        .from(qsnapRaw)
        .where(
          and(
            inArray(qsnapRaw.snapId, completeIds.slice(i, i + 200)),
            or(inArray(qsnapRaw.tableName, NEEDED_TABLES), like(qsnapRaw.tableName, 'param:%')),
          ),
        )
        .all();
      for (const r of raw) {
        let list = rawBySnap.get(r.snapId);
        if (!list) rawBySnap.set(r.snapId, (list = []));
        list.push({ snapId: r.snapId, table: r.tableName, row: r.rowNo, field: r.field, value: r.value });
      }
    }
    const snapshots: Yv1SnapshotInput[] = assessments.map((a) => ({
      assessment: a,
      tables: a.complete ? pivotSnapshot(rawBySnap.get(a.snapId) ?? []) : null,
    }));

    const automatTrades: AutomatTrade[] = this.db
      .select()
      .from(yv1AutomatTrades)
      .where(eq(yv1AutomatTrades.systemId, this.ctx.systemId))
      .all()
      .map((t) => ({
        tradeNum: t.tradeNum,
        orderNum: t.orderNum,
        date: t.date,
        time: t.time,
        contract: t.contract,
        side: t.side,
        qty: t.qty,
        price: t.price,
        reason: t.reason,
        refPrice: t.refPrice,
        slipRub: t.slipRub,
        brokerFeeQuik: t.brokerFeeQuik,
        exchangeFee: t.exchangeFee,
        clearingFee: t.clearingFee,
        techCenterFee: t.techCenterFee,
        sourceFile: t.sourceFile,
      }));
    const parseDays = <T>(table: typeof yv1AutomatDays | typeof yv1AutomatSignals | typeof yv1AutomatLogs): T[] =>
      this.db
        .select()
        .from(table)
        .where(eq(table.systemId, this.ctx.systemId))
        .all()
        .map((r) => JSON.parse(r.payload) as T);

    // сделки журналов других стратегий на том же счёте: для этой стратегии они не «не распределено»
    const otherStrategyTradeNums = new Set(
      this.db
        .select({ tradeNum: yv1AutomatTrades.tradeNum })
        .from(yv1AutomatTrades)
        .where(ne(yv1AutomatTrades.systemId, this.ctx.systemId))
        .all()
        .map((r) => r.tradeNum),
    );

    const unfinished = this.readJson<string[]>(UNFINISHED_KEY, []);
    return buildYv1Overview({
      now,
      otherStrategyTradeNums,
      snapshots,
      unfinished,
      automat: {
        trades: automatTrades,
        daily: parseDays<AutomatDay>(yv1AutomatDays),
        signals: parseDays<AutomatSignal>(yv1AutomatSignals),
        logs: parseDays<AutomatLogDay>(yv1AutomatLogs),
      },
      settings: this.getSettings(),
      backtest: this.readBacktest(),
      corridor: this.readCorridor(),
    });
  }

  /** CSV кривой `date,ret,equity`; ошибка, если кривую посчитать нельзя */
  curveCsv(now?: string): string {
    const o = this.overview(now);
    if (!o.curve) {
      throw new StrategySourceError(
        o.settings.initialCapital === null
          ? 'Кривую не посчитать: не задан начальный капитал (настройки ЮВ1).'
          : 'Кривую не посчитать: нет закрытых циклов.',
      );
    }
    return curveToCsv(o.curve);
  }

  private readJson<T>(key: string, fallback: T): T {
    const row = this.db
      .select()
      .from(yv1Settings)
      .where(and(eq(yv1Settings.systemId, this.ctx.systemId), eq(yv1Settings.key, key)))
      .get();
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  private readBacktest(): { date: string; ret: number }[] | null {
    if (!this.paths.backtestCsv) return null;
    try {
      const lines = readUtf8(this.paths.backtestCsv).split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines[0] !== 'date,ret,equity') return null;
      return lines.slice(1).map((l) => {
        const [date, ret] = l.split(',');
        return { date, ret: Number(ret) };
      });
    } catch {
      return null;
    }
  }

  private readCorridor(): Yv1Corridor | null {
    if (!this.paths.corridorFile) return null;
    try {
      return CorridorFileSchema.parse(JSON.parse(readUtf8(this.paths.corridorFile)));
    } catch {
      return null;
    }
  }
}
