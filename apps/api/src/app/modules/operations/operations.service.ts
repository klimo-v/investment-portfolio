import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import {
  calculatePositions,
  calculateTrades,
  cashBalanceRub,
  futureUnrealizedPnl,
  reconcileFuturesSettlement,
  marketValueRub,
  realizedPnlInRange,
  xirr,
  periodCashFlows,
  OperationSchema,
  OperationReassignSchema,
  type Effectiveness,
  type Operation,
  type Position,
  type SettlementCheckDto,
  type DashboardSummary,
  type Trade,
  type TradeResult,
} from '@core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  operations,
  instruments,
  systems,
  portfolios,
  quotes,
  futuresSettlements,
  type OperationRow,
} from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import {
  recordSnapshotInvalidation,
  type SnapshotInvalidationEntry,
  type SnapshotInvalidationKind,
} from '../../../db/snapshot-invalidations';
import { QuotesService } from '../quotes/quotes.service';

/** Фильтр сводки дашборда (docs/05-review-usability.md §2/§3 — глобальный фильтр) */
export interface SummaryFilter {
  systemId?: string;
  portfolioId?: string;
  /** дата операции ≥ from (YYYY-MM-DD) */
  from?: string;
  /** дата операции ≤ till (YYYY-MM-DD) */
  till?: string;
}

/** Срез сделок: система/портфель сужают журнал, период — по дате закрытия */
export interface TradeFilter {
  systemId?: string;
  portfolioId?: string;
  from?: string;
  till?: string;
}

/** Сделка движка вместе с рыночной оценкой остатка (null — оценки нет или остатка нет) */
export interface ValuedTrade {
  trade: TradeResult;
  currentPrice: string | null;
  priceCurrency: string | null;
  /** рыночная стоимость остатка; у фьючерса — нереализованный результат */
  currentValueRub: string | null;
}

/**
 * Сервис операций — бизнес-логика (GRASP: Controller тонкий, логика здесь).
 * Хранение — Drizzle + SQLite (Фаза 1, docs/04-roadmap.md).
 */
@Injectable()
export class OperationsService {
  constructor(
    @Inject(DB) private readonly db: BetterSQLite3Database,
    private readonly quotesService: QuotesService,
  ) {}

  /**
   * id фьючерсных инструментов. Движок не знает типов (в операции только id), поэтому
   * набор передаётся ему снаружи — для этих инструментов включается учёт позиции
   * со знаком (шорт допустим), см. libs/core/futures-engine.ts.
   */
  futureIds(): Set<string> {
    return new Set(
      this.db
        .select({ id: instruments.id })
        .from(instruments)
        .where(eq(instruments.type, 'Future'))
        .all()
        .map((r) => r.id),
    );
  }

  /**
   * Сверка движка с вариационной маржой брокера по фьючерсам (core/futures-settlement.ts).
   * Берётся последний импортированный отчёт по паре «портфель × инструмент»; считается
   * по ВСЕМУ журналу портфеля (ВМ не делится между системами). Ключ — `портфель|инструмент`.
   */
  settlementChecks(): Map<string, SettlementCheckDto & { ticker: string; portfolioId: string; systemIds: Set<string> }> {
    const rows = this.db.select().from(futuresSettlements).all();
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const key = `${r.portfolioId}|${r.instrumentId}`;
      const prev = latest.get(key);
      if (!prev || r.date > prev.date) latest.set(key, r);
    }
    if (latest.size === 0) return new Map();

    const ops = this.list();
    const tickerById = new Map(this.db.select().from(instruments).all().map((i) => [i.id, i.ticker]));
    const result = new Map<string, SettlementCheckDto & { ticker: string; portfolioId: string; systemIds: Set<string> }>();
    for (const [key, st] of latest) {
      const check = reconcileFuturesSettlement(ops, st.instrumentId, st.portfolioId, st);
      result.set(key, {
        status: check.status,
        diffRub: check.diffRub?.toFixed(2) ?? null,
        engineRub: check.engineRub?.toFixed(2) ?? null,
        brokerRub: check.brokerRub.toFixed(2),
        asOf: check.asOf,
        reason: check.reason ?? null,
        ticker: tickerById.get(st.instrumentId) ?? st.instrumentId,
        portfolioId: st.portfolioId,
        systemIds: new Set(
          ops
            .filter((o) => o.instrumentId === st.instrumentId && o.portfolioId === st.portfolioId)
            .map((o) => o.systemId),
        ),
      });
    }
    return result;
  }

  list(): Operation[] {
    const rows = this.db.select().from(operations).all();
    return rows.map(rowToOperation);
  }

  /**
   * Валидация тела через Zod (CLAUDE.md §8 — не доверяем клиенту), затем запись в БД.
   * Операция, датированная ЗАДНИМ ЧИСЛОМ (раньше последнего снимка), меняет то, что
   * должно было быть посчитано на прошлые даты захвата — помечаем снимки
   * недостоверными (recordSnapshotInvalidation сам решит, есть ли что портить:
   * обычное добавление сегодняшним числом ничего не пишет).
   */
  add(raw: unknown): Operation {
    const parsed = OperationSchema.parse(raw);
    const id = parsed.id ?? randomUUID();

    this.db
      .insert(operations)
      .values({
        id,
        date: parsed.date,
        systemId: parsed.systemId,
        portfolioId: parsed.portfolioId,
        instrumentId: parsed.instrumentId ?? null,
        operationType: parsed.operationType,
        quantity: parsed.quantity,
        price: parsed.price,
        fee: parsed.fee ?? '0',
        fxRate: parsed.fxRate ?? '1',
        currency: parsed.currency,
        transferGroup: parsed.transferGroup ?? null,
        tradeId: parsed.tradeId ?? null,
        note: parsed.note ?? null,
        brokerRef: parsed.brokerRef ?? null,
        executedAt: parsed.executedAt ?? null,
        importBatchId: parsed.importBatchId ?? null,
      })
      .run();

    recordSnapshotInvalidation(this.db, this.changeEntry(parsed, 'add'));

    return { ...parsed, id };
  }

  /**
   * Удалить операцию по id (безвозвратно — пересчёт позиций/сделок исключит её).
   * Задним числом меняется то, что должно было быть посчитано на каждую прошлую дату
   * захвата, а пересчитать старые снимки не из чего — дневных цен по бумагам нет.
   * Историю снимков не стираем, а помечаем недостоверной (см.
   * recordSnapshotInvalidation): пользователь увидит на дашборде, что именно изменилось.
   *
   * Строку читаем ДО удаления — после неё описания уже не собрать.
   */
  delete(id: string): void {
    const [row] = this.db.select().from(operations).where(eq(operations.id, id)).all();
    this.db.delete(operations).where(eq(operations.id, id)).run();
    if (!row) return;

    recordSnapshotInvalidation(this.db, this.changeEntry(rowToOperation(row), 'delete'));
  }

  /**
   * Переназначить операцию на другую систему и/или портфель (docs/04-roadmap.md §3.1) —
   * например, при разборе отчёта, где сделки лежат в разных системах/на разных счетах
   * брокера (обычный ↔ ИИС), а батч-разметки при импорте оказалось недостаточно.
   * Валидация через Zod (CLAUDE.md §8); существование id проверяет FK-констрейнт БД.
   * Помечает историю снимков недостоверной — то же обоснование, что у delete().
   */
  reassign(id: string, raw: unknown): void {
    const patch = OperationReassignSchema.parse(raw);
    const [row] = this.db.select().from(operations).where(eq(operations.id, id)).all();
    this.db.update(operations).set(patch).where(eq(operations.id, id)).run();
    if (!row) return;

    recordSnapshotInvalidation(this.db, this.changeEntry(rowToOperation(row), 'reassign'));
  }

  /**
   * Запись «что изменилось» для таблицы в модалке дашборда.
   *
   * Тип операции не переводим — в журнале на странице «Операции» он тоже показан
   * как есть (Buy/Sell/Deposit…), и расхождение сбивало бы с толку. Тикер ищем
   * ровно один раз: он нужен и в описании, и отдельной колонкой.
   */
  private changeEntry(op: Operation, kind: SnapshotInvalidationKind): SnapshotInvalidationEntry {
    const ticker = this.tickerOf(op.instrumentId);
    const qty = trimZeros(op.quantity);

    return {
      kind,
      operationDate: op.date,
      description: ticker ? `${op.operationType} ${qty} ${ticker}` : `${op.operationType} ${qty}`,
      ticker,
    };
  }

  /** Тикер инструмента; null — кэш-операция (Deposit/Withdraw) без инструмента */
  private tickerOf(instrumentId: string | null | undefined): string | null {
    if (!instrumentId) return null;
    const [row] = this.db.select().from(instruments).where(eq(instruments.id, instrumentId)).all();
    return row?.ticker ?? null;
  }

  /**
   * Позиции считает общий движок из libs/core (DRY: одна логика фронт+бэк),
   * затем обогащаем текущей ценой из кэша котировок и пересчётом стоимости/P&L в RUB.
   * Принимает список операций (по умолчанию — весь журнал), чтобы `summary()` мог
   * посчитать позиции на отфильтрованном срезе (глобальный фильтр дашборда).
   */
  async positions(ops: Operation[] = this.list()): Promise<Position[]> {
    const futureIds = this.futureIds();
    const instrumentRows = this.db.select().from(instruments).all();
    const quoteRows = this.db.select().from(quotes).all();
    const instrumentById = new Map(instrumentRows.map((i) => [i.id, i]));
    const quoteByInstrument = new Map(quoteRows.map((q) => [q.instrumentId, q]));

    const checks = this.settlementChecks();
    const result: Position[] = [];
    for (const p of calculatePositions(ops, { futureIds })) {
      const instrument = instrumentById.get(p.instrumentId);
      const currency = instrument?.currency ?? 'RUB';
      const quote = quoteByInstrument.get(p.instrumentId);
      const isFuture = futureIds.has(p.instrumentId);

      let currentPrice: string | null = null;
      let priceCurrency: string | null = null;
      let accruedInterestRub: string | null = null;
      let currentValueRub: string | null = null;
      let pnlRub: string | null = null;

      if (quote && isFuture) {
        // фьючерс: «стоимость» = нереализованный результат (расчётная − средняя) × кол-во
        // со знаком; quantity × price для шорта было бы бессмыслицей. Цена в ₽ за контракт.
        currentPrice = quote.price;
        priceCurrency = 'RUB';
        currentValueRub = futureUnrealizedPnl(p, quote.price).toFixed(2);
      } else if (quote) {
        currentPrice = quote.price;
        // курс берём по валюте КОТИРОВКИ, а не инструмента: у замещающих облигаций
        // цена приходит в валюте номинала, и они расходятся (см. quotes.currency)
        priceCurrency = quote.currency || currency;
        const fx = await this.quotesService.getFxRate(priceCurrency);
        // у НКД своя валюта: биржа отдаёт его в валюте расчётов режима торгов,
        // а цену — в валюте номинала (см. quotes.accruedCurrency)
        const accruedFx =
          quote.accruedInterest === null
            ? fx
            : await this.quotesService.getFxRate(quote.accruedCurrency || priceCurrency);

        currentValueRub = marketValueRub({
          quantity: p.quantity,
          price: quote.price,
          fxRate: fx,
          accruedInterest: quote.accruedInterest,
          accruedFxRate: accruedFx,
        }).toFixed(2);
        // НКД отдаём отдельно: в «Стоимости» он уже учтён, но без своей колонки
        // строка выглядела бы как ошибка — стоимость не сходится с ценой × количество
        if (quote.accruedInterest !== null) {
          accruedInterestRub = new Decimal(p.quantity)
            .mul(quote.accruedInterest)
            .mul(accruedFx)
            .toFixed(2);
        }
      }
      // P&L считаем, если знаем рыночную стоимость остатка (котировка есть), либо
      // остатка нет вовсе (позиция закрыта, qty=0) — тогда нереализованная часть
      // тривиально нулевая и цена для неё не нужна. Если позиция ОТКРЫТА и котировки
      // нет — итог посчитать нельзя (не с чем сравнить вложенное), оставляем «—»,
      // а не молча показываем ноль вместо «неизвестно».
      if (quote || p.quantity.isZero()) {
        // реализ. (по проданным частям) + нереализ. (по остатку) + дивиденды/купоны —
        // тот же состав, что и в trades() ниже; раньше здесь не было реализованного
        // P&L, из-за чего закрытая позиция с прибылью только от продажи показывала 0
        const unrealizedRub = currentValueRub ? Number(currentValueRub) - Number(p.investedRub) : 0;
        const pnl =
          Number(p.realizedPnlRub) + unrealizedRub + Number(p.dividendsRub) + Number(p.couponsRub);
        pnlRub = pnl.toFixed(2);
      }

      result.push({
        instrumentId: p.instrumentId,
        ticker: instrument?.ticker ?? p.instrumentId,
        systemId: p.systemId,
        portfolioId: p.portfolioId,
        type: instrument?.type ?? 'Stock',
        currency,
        quantity: p.quantity.toString(),
        avgBuyPrice: p.avgBuyPrice.toFixed(2),
        investedCcy: p.investedCcy.toFixed(2),
        investedRub: p.investedRub.toFixed(2),
        realizedPnlRub: p.realizedPnlRub.toFixed(2),
        dividendsRub: p.dividendsRub.toFixed(2),
        couponsRub: p.couponsRub.toFixed(2),
        avgPriceCurrency: p.tradeCurrency || currency,
        currentPrice,
        priceCurrency,
        accruedInterestRub,
        currentValueRub,
        pnlRub,
        settlementCheck: this.checkFor(checks, p.portfolioId, p.instrumentId),
      });
    }
    return result;
  }

  /** Сверка для позиции без служебных полей (ключ, системы) */
  private checkFor(
    checks: ReturnType<OperationsService['settlementChecks']>,
    portfolioId: string,
    instrumentId: string,
  ): SettlementCheckDto | null {
    const c = checks.get(`${portfolioId}|${instrumentId}`);
    if (!c) return null;
    const { diffRub, engineRub, brokerRub, asOf, reason, status } = c;
    return { status, diffRub, engineRub, brokerRub, asOf, reason };
  }

  /**
   * Сделки собираются движком из операций (docs/02-data-model.md §2.5): сделка
   * открывается первой покупкой и закрывается, когда остаток уходит в ноль.
   * Открытые сделки обогащаем текущей ценой/P&L, как и позиции.
   */
  async trades(): Promise<Trade[]> {
    const instrumentById = new Map(this.db.select().from(instruments).all().map((i) => [i.id, i]));
    return (await this.valuedTrades()).map(({ trade: t, currentPrice, priceCurrency, currentValueRub }) => {
      const instrument = instrumentById.get(t.instrumentId);
      const currency = instrument?.currency ?? 'RUB';
      // P&L = реализованный (по проданной части) + нереализованный (по остатку) + выплаты
      const unrealizedRub = currentValueRub ? Number(currentValueRub) - Number(t.investedRub) : 0;
      const pnlRub = (
        Number(t.realizedPnlRub) +
        unrealizedRub +
        Number(t.dividendsRub) +
        Number(t.couponsRub)
      ).toFixed(2);

      return {
        id: t.operationIds[0],
        instrumentId: t.instrumentId,
        ticker: instrument?.ticker ?? t.instrumentId,
        systemId: t.systemId,
        portfolioId: t.portfolioId,
        type: instrument?.type ?? 'Stock',
        currency,
        status: t.status,
        quantity: t.quantity.toString(),
        qtyBought: t.qtyBought.toString(),
        qtySold: t.qtySold.toString(),
        avgBuyPrice: t.avgBuyPrice.toFixed(2),
        investedCcy: t.investedCcy.toFixed(2),
        investedRub: t.investedRub.toFixed(2),
        proceedsCcy: t.proceedsCcy.toFixed(2),
        proceedsRub: t.proceedsRub.toFixed(2),
        realizedPnlCcy: t.realizedPnlCcy.toFixed(2),
        realizedPnlRub: t.realizedPnlRub.toFixed(2),
        dividendsRub: t.dividendsRub.toFixed(2),
        couponsRub: t.couponsRub.toFixed(2),
        avgPriceCurrency: t.tradeCurrency || currency,
        currentPrice,
        priceCurrency,
        currentValueRub,
        pnlRub,
        direction: t.direction,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        openedTime: t.openedTime,
        closedTime: t.closedTime,
        feesRub: t.feesRub.toFixed(2),
        operationIds: t.operationIds,
      };
    });
  }

  /**
   * Сделки движка с рыночной оценкой остатка — ЕДИНСТВЕННОЕ место, где открытая сделка
   * оценивается по котировке (trades() и статистика системы берут оценку отсюда, DRY).
   * Фильтр сужает журнал до расчёта (система/портфель/`till`); `from` отбрасывает
   * сделки, закрытые раньше начала периода, — открытые остаются всегда (это состояние
   * «сейчас»). Историю до `from` движку отдаём целиком: от неё зависит средняя цена.
   */
  async valuedTrades(filter: TradeFilter = {}): Promise<ValuedTrade[]> {
    const ops = this.list().filter(
      (o) =>
        (!filter.systemId || o.systemId === filter.systemId) &&
        (!filter.portfolioId || o.portfolioId === filter.portfolioId) &&
        (!filter.till || o.date <= filter.till),
    );
    const futureIds = this.futureIds();
    const instrumentById = new Map(this.db.select().from(instruments).all().map((i) => [i.id, i]));
    const quoteByInstrument = new Map(this.db.select().from(quotes).all().map((q) => [q.instrumentId, q]));

    // Котировки только текущие. Если `till` в прошлом, сделки «открытые на till» нельзя
    // честно оценить сегодняшней ценой (смесь прошлого и настоящего) — оценку не даём
    const pastTill = !!filter.till && filter.till < new Date().toISOString().slice(0, 10);

    const result: ValuedTrade[] = [];
    for (const t of calculateTrades(ops, { futureIds })) {
      if (filter.from && t.closedAt && t.closedAt < filter.from) continue;
      const currency = instrumentById.get(t.instrumentId)?.currency ?? 'RUB';
      const quote = pastTill ? undefined : quoteByInstrument.get(t.instrumentId);

      let currentPrice: string | null = null;
      let priceCurrency: string | null = null;
      let currentValueRub: string | null = null;

      if (quote && futureIds.has(t.instrumentId)) {
        // открытая фьючерсная сделка (кол-во со знаком): оценка = нереализованный результат
        if (!t.quantity.isZero()) {
          currentPrice = quote.price;
          priceCurrency = 'RUB';
          currentValueRub = futureUnrealizedPnl(
            { quantity: t.quantity, avgBuyPrice: t.avgBuyPrice },
            quote.price,
          ).toFixed(2);
        }
      } else if (quote && t.quantity.gt(0)) {
        currentPrice = quote.price;
        // та же оценка, что и в positions(): курс по валюте котировки, НКД в стоимости.
        // Расхождение формул между страницами уже было источником «пропавших денег»
        priceCurrency = quote.currency || currency;
        const fx = await this.quotesService.getFxRate(priceCurrency);
        const accruedFx =
          quote.accruedInterest === null
            ? fx
            : await this.quotesService.getFxRate(quote.accruedCurrency || priceCurrency);

        currentValueRub = marketValueRub({
          quantity: t.quantity,
          price: quote.price,
          fxRate: fx,
          accruedInterest: quote.accruedInterest,
          accruedFxRate: accruedFx,
        }).toFixed(2);
      }
      result.push({ trade: t, currentPrice, priceCurrency, currentValueRub });
    }
    return result;
  }

  /**
   * Агрегаты для дашборда (логика построения — из portfolio_dashboard.html):
   * помесячный поток/доход для комбо-графика, метрики эффективности по системам и
   * портфелям (ROI/XIRR/реализ./нереализ./див.доходность — docs/05-review-usability.md
   * §1), breakdown по тикерам.
   *
   * Глобальный фильтр (§2/§3): system/portfolio сужают журнал операций сразу.
   * Период (`from`/`till`) сужает и «Эффективность» тоже, но КОРРЕКТНО — без бага
   * «за 1 год/YTD ничего не вижу» на buy-and-hold без свежих операций внутри окна:
   * - «Вложено»/«Текущая стоимость»/«Нереализ.» — себестоимость/стоимость ТЕКУЩЕГО
   *   остатка. Формально это состояние «на конец периода», но при
   *   средневзвешенном методе учёта оно математически совпадает с полной историей
   *   (среднюю цену остатка нельзя восстановить иначе, чем по всей цепочке покупок) —
   *   поэтому считаем по всей истории до `till`, не обрезая по `from`: тот же
   *   результат, но без риска обнулить позицию, если по ней не было операций в
   *   узком окне.
   * - «Реализ.»/«Дивиденды» — наоборот, ИМЕННО то, что реально продано/получено
   *   внутри [`from`, `till`] (см. effectiveness()): реализованный P&L — через
   *   realizedPnlInRange() (себестоимость проданного всё равно берёт из полной
   *   истории покупок, иначе была бы искажена, если покупка была до периода).
   * - XIRR — денежно-взвешенная доходность за период: капитал, вложенный ДО
   *   начала периода, сворачивается в синтетический отток датой `from` (иначе не с
   *   чем сравнить терминальный поток на buy-and-hold без операций в окне).
   */
  async summary(filter: SummaryFilter = {}): Promise<DashboardSummary> {
    const allOps = this.list();
    const opsUpTo = allOps.filter(
      (o) =>
        (!filter.systemId || o.systemId === filter.systemId) &&
        (!filter.portfolioId || o.portfolioId === filter.portfolioId) &&
        (!filter.till || o.date <= filter.till),
    );
    const periodOps = opsUpTo.filter((o) => !filter.from || o.date >= filter.from);
    const positions = await this.positions(opsUpTo);
    const futureIds = this.futureIds();
    const systemRows = this.db.select().from(systems).all();
    const portfolioRows = this.db.select().from(portfolios).all();
    const systemName = new Map(systemRows.map((s) => [s.id, s.name]));
    const portfolioName = new Map(portfolioRows.map((p) => [p.id, p.name]));
    const today = new Date().toISOString().slice(0, 10);

    // временной ряд по месяцам: поток кэша и доход (дивиденды/купоны) — по periodOps,
    // это честный срез «что происходило в этом окне»
    const monthly = new Map<string, { flow: number; income: number }>();
    for (const op of periodOps) {
      const period = op.date.slice(0, 7); // YYYY-MM
      const bucket = monthly.get(period) ?? { flow: 0, income: 0 };
      const amount = Number(op.quantity) * Number(op.price) * Number(op.fxRate);
      if (op.operationType === 'Deposit') bucket.flow += amount;
      else if (op.operationType === 'Withdraw') bucket.flow -= amount;
      else if (op.operationType === 'Dividend' || op.operationType === 'Coupon')
        bucket.income += amount;
      monthly.set(period, bucket);
    }
    const timeline = [...monthly.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([period, v]) => ({ period, flow: v.flow, income: v.income }));

    // эффективность по системам: срез операций/позиций/сделок по systemId
    const systemIds = [...new Set(positions.map((p) => p.systemId))];
    const bySystem = systemIds
      .map((systemId) => ({
        systemId,
        name: systemName.get(systemId) ?? systemId,
        ...this.effectiveness(
          opsUpTo.filter((o) => o.systemId === systemId),
          positions.filter((p) => p.systemId === systemId),
          today,
          filter.from,
          futureIds,
        ),
      }))
      .sort((a, b) => b.pnlRub - a.pnlRub);

    // эффективность по портфелям/счетам
    const portfolioIds = [...new Set(positions.map((p) => p.portfolioId))];
    const byPortfolio = portfolioIds
      .map((portfolioId) => ({
        portfolioId,
        name: portfolioName.get(portfolioId) ?? portfolioId,
        ...this.effectiveness(
          opsUpTo.filter((o) => o.portfolioId === portfolioId),
          positions.filter((p) => p.portfolioId === portfolioId),
          today,
          filter.from,
          futureIds,
        ),
      }))
      .sort((a, b) => b.pnlRub - a.pnlRub);

    // breakdown прибыль/убыток по инструментам (сортировка по величине P&L)
    const breakdown = positions
      .filter((p) => p.pnlRub !== null)
      .map((p) => ({ ticker: p.ticker, pnlRub: Number(p.pnlRub) }))
      .sort((a, b) => b.pnlRub - a.pnlRub);

    const totals = this.effectiveness(opsUpTo, positions, today, filter.from, futureIds);

    // Свободные деньги считаем по opsUpTo, т.е. по ВСЕЙ истории до `till` и намеренно
    // без `filter.from`: остаток на счёте — величина на момент, а не за период
    // (см. cash.ts). Фильтр по системе/портфелю при этом действует — он уже применён
    // к opsUpTo, и срез по портфелю даёт остаток именно этого счёта.
    const cashRub = cashBalanceRub(opsUpTo, futureIds).toNumber();
    const cash = { cashRub, totalValueRub: totals.currentValueRub + cashRub };

    return { timeline, bySystem, byPortfolio, breakdown, totals, cash };
  }

  /**
   * Метрики эффективности среза (docs/05-review-usability.md §1). `ops` — вся
   * история (до `till`) по срезу система/портфель, `positions` — из неё же
   * (см. summary()). `periodFrom` — начало выбранного периода, если он задан.
   *
   * «Вложено»/«Текущая стоимость»/«Нереализ.» — из `positions`, т.е. по всей
   * истории, НЕ по `periodOps`: при средневзвешенном методе учёта себестоимость
   * текущего остатка математически совпадает что при полном пересчёте, что при
   * пересчёте от синтетической точки старта на `periodFrom` — иначе (расчёт
   * только по операциям внутри периода) позиция, купленная до его начала и не
   * тронутая внутри, целиком пропадала бы из сводки (баг «за 1 год/YTD не вижу
   * XIRR/Вложено» на buy-and-hold без свежих операций в окне).
   *
   * «Реализ.» — через realizedPnlInRange(ops, periodFrom): только от продаж
   * ВНУТРИ периода, но себестоимость проданного — по полной истории покупок
   * (иначе была бы искажена, если покупка была до начала периода).
   * «Дивиденды» — прямая сумма Dividend/Coupon-операций ВНУТРИ периода
   * (себестоимость для этого не нужна, дата операции = дата получения денег).
   * ROI и дивидендную доходность нормируем на «Вложено» — себестоимость
   * держимого остатка (сходится с колонкой «Вложено» на странице «Сделки»), а не
   * на сумму всех покупок: при перезаходах в позицию она кратно завышена
   * оборотом. У полностью закрытых срезов вложено = 0 → ROI не определён (null):
   * годовую доходность там показывает XIRR.
   *
   * XIRR считаем через periodCashFlows() (libs/core/metrics.ts) по фактическим
   * потокам, плюс терминальный приток текущей стоимости остатка на сегодня. Если
   * `periodFrom` задан, капитал, уже вложенный ДО начала периода И всё ещё
   * удерживаемый (не проданный) к концу истории, сворачивается в один
   * синтетический отток датой `periodFrom` — иначе на buy-and-hold без операций
   * внутри окна не с чем сравнивать терминальный поток и xirr() всегда вернёт null.
   *
   * ВАЖНО (баг, найден и исправлен 2026-08-01): если внутри периода происходит
   * продажа позиции, ОТКРЫТОЙ до periodFrom, её себестоимость НЕ сворачивается в
   * синтетику на periodFrom — periodCashFlows() ведёт FIFO по лотам с их
   * РЕАЛЬНЫМИ датами покупки: себестоимость проданной доли идёт оттоком на
   * настоящую историческую дату покупки лота, а выручка — обычным притоком на
   * дату продажи. В синтетику на periodFrom попадает только себестоимость того,
   * что реально продолжает удерживаться. Без этого более ранние попытки давали
   * либо задвоение капитала (вся себестоимость и вся выручка одновременно), либо
   * заниженный XIRR (учёт только realized P&L), либо завышенный (компенсация
   * себестоимости на дату periodFrom вместо настоящей даты покупки) — см.
   * подробный doc-comment и историю трёх итераций в libs/core/metrics.ts.
   */
  private effectiveness(
    ops: Operation[],
    positions: Position[],
    today: string,
    periodFrom: string | undefined,
    /** фьючерсные инструменты: вне XIRR и ROI, их результат — в P&L */
    futureIds: ReadonlySet<string>,
  ): Effectiveness {
    const periodOps = periodFrom ? ops.filter((o) => o.date >= periodFrom) : ops;

    const currentValueRub = positions.reduce((s, p) => s + Number(p.currentValueRub ?? 0), 0);
    const investedRub = positions.reduce((s, p) => s + Number(p.investedRub), 0);
    const dividendsRub = periodOps.reduce((s, op) => {
      if (op.operationType !== 'Dividend' && op.operationType !== 'Coupon') return s;
      return s + Number(op.quantity) * Number(op.price) * Number(op.fxRate);
    }, 0);
    const realized = realizedPnlInRange(ops, periodFrom, undefined, { futureIds });
    const realizedPnlRub = realized.reduce((s, r) => s + r.realizedPnlRub.toNumber(), 0);
    const unrealizedPnlRub = positions.reduce(
      (s, p) =>
        p.currentValueRub === null ? s : s + (Number(p.currentValueRub) - Number(p.investedRub)),
      0,
    );
    const pnlRub = realizedPnlRub + unrealizedPnlRub + dividendsRub;

    // Фьючерсы вне XIRR (их денежных вложений нет — оценка это нереализованный результат)
    // и вне ROI (результат без знаменателя исказил бы процент): считаем «без них».
    const futuresPnlRub =
      realized
        .filter((r) => futureIds.has(r.instrumentId))
        .reduce((s, r) => s + r.realizedPnlRub.toNumber(), 0) +
      positions
        .filter((p) => futureIds.has(p.instrumentId))
        .reduce((s, p) => s + Number(p.currentValueRub ?? 0), 0);
    const spotValueRub = positions
      .filter((p) => !futureIds.has(p.instrumentId))
      .reduce((s, p) => s + Number(p.currentValueRub ?? 0), 0);
    const flows = periodCashFlows(ops, periodFrom, spotValueRub, today, futureIds);
    const rate = xirr(flows);

    return {
      investedRub,
      currentValueRub,
      realizedPnlRub,
      unrealizedPnlRub,
      dividendsRub,
      pnlRub,
      roiPct: investedRub > 0 ? ((pnlRub - futuresPnlRub) / investedRub) * 100 : null,
      dividendYieldPct: investedRub > 0 ? (dividendsRub / investedRub) * 100 : null,
      xirrPct: rate === null ? null : rate * 100,
    };
  }
}

/**
 * Хвостовые нули десятичной строки для человекочитаемого описания: количество в БД
 * лежит как «10.000000», а в таблице изменений хочется видеть «10».
 */
function trimZeros(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/\.?0+$/, '') || '0';
}

function rowToOperation(row: OperationRow): Operation {
  return {
    id: row.id,
    date: row.date,
    systemId: row.systemId,
    portfolioId: row.portfolioId,
    instrumentId: row.instrumentId,
    operationType: row.operationType as Operation['operationType'],
    quantity: row.quantity,
    price: row.price,
    fee: row.fee,
    fxRate: row.fxRate,
    currency: row.currency,
    transferGroup: row.transferGroup,
    tradeId: row.tradeId,
    note: row.note ?? undefined,
    brokerRef: row.brokerRef ?? undefined,
    executedAt: row.executedAt,
    importBatchId: row.importBatchId,
  };
}
