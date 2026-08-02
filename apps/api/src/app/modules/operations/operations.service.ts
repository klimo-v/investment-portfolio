import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  calculatePositions,
  calculateTrades,
  realizedPnlInRange,
  xirr,
  periodCashFlows,
  OperationSchema,
  OperationReassignSchema,
  type Effectiveness,
  type Operation,
  type Position,
  type DashboardSummary,
  type Trade,
} from '@core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  operations,
  instruments,
  systems,
  portfolios,
  quotes,
  type OperationRow,
} from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { invalidateSnapshots } from '../../../db/invalidate-snapshots';
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

  list(): Operation[] {
    const rows = this.db.select().from(operations).all();
    return rows.map(rowToOperation);
  }

  /** Валидация тела через Zod (CLAUDE.md §8 — не доверяем клиенту), затем запись в БД */
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
        importBatchId: parsed.importBatchId ?? null,
      })
      .run();

    return { ...parsed, id };
  }

  /**
   * Удалить операцию по id (безвозвратно — пересчёт позиций/сделок исключит её).
   * Стираем историю снимков (docs/05-review-usability.md §2) — задним числом
   * меняется то, что должно было быть посчитано на каждую прошлую дату захвата,
   * а без исторических цен на каждый день старые снимки нельзя пересчитать
   * под исправленные данные (см. invalidateSnapshots).
   */
  delete(id: string): void {
    this.db.delete(operations).where(eq(operations.id, id)).run();
    invalidateSnapshots(this.db);
  }

  /**
   * Переназначить операцию на другую систему и/или портфель (docs/04-roadmap.md §3.1) —
   * например, при разборе отчёта, где сделки лежат в разных системах/на разных счетах
   * брокера (обычный ↔ ИИС), а батч-разметки при импорте оказалось недостаточно.
   * Валидация через Zod (CLAUDE.md §8); существование id проверяет FK-констрейнт БД.
   * Стирает историю снимков — см. invalidateSnapshots (то же обоснование, что у delete()).
   */
  reassign(id: string, raw: unknown): void {
    const patch = OperationReassignSchema.parse(raw);
    this.db
      .update(operations)
      .set(patch)
      .where(eq(operations.id, id))
      .run();
    invalidateSnapshots(this.db);
  }

  /**
   * Позиции считает общий движок из libs/core (DRY: одна логика фронт+бэк),
   * затем обогащаем текущей ценой из кэша котировок и пересчётом стоимости/P&L в RUB.
   * Принимает список операций (по умолчанию — весь журнал), чтобы `summary()` мог
   * посчитать позиции на отфильтрованном срезе (глобальный фильтр дашборда).
   */
  async positions(ops: Operation[] = this.list()): Promise<Position[]> {
    const instrumentRows = this.db.select().from(instruments).all();
    const quoteRows = this.db.select().from(quotes).all();
    const instrumentById = new Map(instrumentRows.map((i) => [i.id, i]));
    const quoteByInstrument = new Map(quoteRows.map((q) => [q.instrumentId, q]));

    const result: Position[] = [];
    for (const p of calculatePositions(ops)) {
      const instrument = instrumentById.get(p.instrumentId);
      const currency = instrument?.currency ?? 'RUB';
      const quote = quoteByInstrument.get(p.instrumentId);

      let currentPrice: string | null = null;
      let currentValueRub: string | null = null;
      let pnlRub: string | null = null;

      if (quote) {
        currentPrice = quote.price;
        // курс валюты инструмента к рублю (для валютных позиций)
        const fx = await this.quotesService.getFxRate(currency);
        const qty = Number(p.quantity);
        const valueCcy = qty * Number(quote.price);
        const valueRub = valueCcy * fx;
        currentValueRub = valueRub.toFixed(2);
        // P&L в рублях = текущая стоимость − вложено (в RUB) + дивиденды/купоны
        const pnl =
          valueRub - Number(p.investedRub) + Number(p.dividendsRub) + Number(p.couponsRub);
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
        dividendsRub: p.dividendsRub.toFixed(2),
        couponsRub: p.couponsRub.toFixed(2),
        currentPrice,
        currentValueRub,
        pnlRub,
      });
    }
    return result;
  }

  /**
   * Сделки собираются движком из операций (docs/02-data-model.md §2.5): сделка
   * открывается первой покупкой и закрывается, когда остаток уходит в ноль.
   * Открытые сделки обогащаем текущей ценой/P&L, как и позиции.
   */
  async trades(): Promise<Trade[]> {
    const ops = this.list();
    const instrumentRows = this.db.select().from(instruments).all();
    const quoteRows = this.db.select().from(quotes).all();
    const instrumentById = new Map(instrumentRows.map((i) => [i.id, i]));
    const quoteByInstrument = new Map(quoteRows.map((q) => [q.instrumentId, q]));

    const result: Trade[] = [];
    for (const t of calculateTrades(ops)) {
      const instrument = instrumentById.get(t.instrumentId);
      const currency = instrument?.currency ?? 'RUB';
      const quote = quoteByInstrument.get(t.instrumentId);

      let currentPrice: string | null = null;
      let currentValueRub: string | null = null;

      if (quote && t.quantity.gt(0)) {
        currentPrice = quote.price;
        const fx = await this.quotesService.getFxRate(currency);
        const valueRub = Number(t.quantity) * Number(quote.price) * fx;
        currentValueRub = valueRub.toFixed(2);
      }
      // P&L = реализованный (по проданной части) + нереализованный (по остатку) + выплаты
      const unrealizedRub = currentValueRub ? Number(currentValueRub) - Number(t.investedRub) : 0;
      const pnlRub = (
        Number(t.realizedPnlRub) +
        unrealizedRub +
        Number(t.dividendsRub) +
        Number(t.couponsRub)
      ).toFixed(2);

      result.push({
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
        currentPrice,
        currentValueRub,
        pnlRub,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        operationIds: t.operationIds,
      });
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
        ),
      }))
      .sort((a, b) => b.pnlRub - a.pnlRub);

    // breakdown прибыль/убыток по инструментам (сортировка по величине P&L)
    const breakdown = positions
      .filter((p) => p.pnlRub !== null)
      .map((p) => ({ ticker: p.ticker, pnlRub: Number(p.pnlRub) }))
      .sort((a, b) => b.pnlRub - a.pnlRub);

    const totals = this.effectiveness(opsUpTo, positions, today, filter.from);

    return { timeline, bySystem, byPortfolio, breakdown, totals };
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
    periodFrom?: string,
  ): Effectiveness {
    const periodOps = periodFrom ? ops.filter((o) => o.date >= periodFrom) : ops;

    const currentValueRub = positions.reduce((s, p) => s + Number(p.currentValueRub ?? 0), 0);
    const investedRub = positions.reduce((s, p) => s + Number(p.investedRub), 0);
    const dividendsRub = periodOps.reduce((s, op) => {
      if (op.operationType !== 'Dividend' && op.operationType !== 'Coupon') return s;
      return s + Number(op.quantity) * Number(op.price) * Number(op.fxRate);
    }, 0);
    const realizedPnlRub = realizedPnlInRange(ops, periodFrom).reduce(
      (s, r) => s + r.realizedPnlRub.toNumber(),
      0,
    );
    const unrealizedPnlRub = positions.reduce(
      (s, p) => (p.currentValueRub === null ? s : s + (Number(p.currentValueRub) - Number(p.investedRub))),
      0,
    );
    const pnlRub = realizedPnlRub + unrealizedPnlRub + dividendsRub;

    const flows = periodCashFlows(ops, periodFrom, currentValueRub, today);
    const rate = xirr(flows);

    return {
      investedRub,
      currentValueRub,
      realizedPnlRub,
      unrealizedPnlRub,
      dividendsRub,
      pnlRub,
      roiPct: investedRub > 0 ? (pnlRub / investedRub) * 100 : null,
      dividendYieldPct: investedRub > 0 ? (dividendsRub / investedRub) * 100 : null,
      xirrPct: rate === null ? null : rate * 100,
    };
  }
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
    importBatchId: row.importBatchId,
  };
}
