import Decimal from 'decimal.js';
import type { Operation } from './schemas';
import { calculatePositions } from './engine';
import { futureUnrealizedPnl } from './futures-engine';

/**
 * Сверка результата движка с вариационной маржой (ВМ) брокера — контроль качества
 * данных, а НЕ источник P&L (docs/02-data-model.md: способ А). Ловит пропущенные или
 * задвоенные сделки, неверные цены и множитель серии.
 *
 * ВМ привязана к счёту и инструменту, а не к торговой системе, поэтому сверка идёт по
 * паре «портфель × инструмент» по операциям всех систем сразу.
 */

/** Допустимое расхождение, ₽ (округления брокера) */
export const SETTLEMENT_TOLERANCE_RUB = 1;

/** Что берём из отчёта (см. FuturesSettlement парсера; хранится в futures_settlements) */
export interface SettlementInput {
  /** начало периода отчёта (ISO); null — неизвестно */
  periodFrom: string | null;
  /** конец периода (ISO) */
  date: string;
  vmPeriod: string;
  vmPlanned: string;
  /** позиция на начало периода и расчётная цена (₽ за контракт); цена null — позиции не было */
  qtyStart: string;
  markStart: string | null;
  markEnd: string | null;
}

export type SettlementStatus =
  /** расхождение в пределах допуска */
  | 'ok'
  /** расхождение больше допуска — данные журнала не сходятся с брокером */
  | 'mismatch'
  /** посчитать нельзя (нет расчётной цены при открытой позиции и т. п.) */
  | 'unknown';

export interface SettlementCheck {
  status: SettlementStatus;
  /** результат движка за период: реализованный gross + нереализованный по расчётной цене */
  engineRub: Decimal | null;
  /** ВМ за период + плановая ВМ */
  brokerRub: Decimal;
  /** движок − брокер */
  diffRub: Decimal | null;
  /** дата конца периода отчёта */
  asOf: string;
  /** пояснение для статуса unknown */
  reason?: string;
}

/** Состояние инструмента на дату: реализованный результат ДО комиссий и нереализованный по цене */
function stateAt(
  ops: Operation[],
  instrumentId: string,
  mark: string | null,
): { gross: Decimal; unrealized: Decimal; openQty: Decimal } {
  const positions = calculatePositions(ops, { futureIds: new Set([instrumentId]) });
  // calculatePositions вычитает комиссию из реализованного — возвращаем её обратно:
  // ВМ брокера комиссий не содержит
  const fees = ops.reduce((s, o) => s.plus(new Decimal(o.fee ?? '0').mul(o.fxRate ?? '1')), new Decimal(0));
  const gross = positions.reduce((s, p) => s.plus(p.realizedPnlRub), new Decimal(0)).plus(fees);
  // позиция у брокера нетто по счёту: лонг одной системы гасит шорт другой
  const openQty = positions.reduce((s, p) => s.plus(p.quantity), new Decimal(0)).abs();
  let unrealized = new Decimal(0);
  if (mark !== null) {
    unrealized = positions.reduce((s, p) => s.plus(futureUnrealizedPnl(p, mark)), new Decimal(0));
  }
  return { gross, unrealized, openQty };
}

/**
 * Результат движка за период отчёта против «ВМ за период + плановая ВМ».
 *   движок = [реализ.gross(≤конец) + нереализ.(конец)] − [реализ.gross(<начало) + нереализ.(начало)]
 * Позиция, перешедшая из прошлого периода, оценивается по расчётной цене на начало
 * (она есть в отчёте), поэтому сверка работает и на отчётах за часть истории.
 * `operations` — все операции журнала (фильтр по портфелю и инструменту — здесь).
 */
export function reconcileFuturesSettlement(
  operations: readonly Operation[],
  instrumentId: string,
  portfolioId: string,
  settlement: SettlementInput,
): SettlementCheck {
  const brokerRub = new Decimal(settlement.vmPeriod).plus(settlement.vmPlanned);
  const mine = operations.filter(
    (o) => o.instrumentId === instrumentId && o.portfolioId === portfolioId,
  );
  const end = stateAt(
    mine.filter((o) => o.date <= settlement.date),
    instrumentId,
    settlement.markEnd,
  );
  const unknown = (reason: string): SettlementCheck => ({
    status: 'unknown',
    engineRub: null,
    brokerRub,
    diffRub: null,
    asOf: settlement.date,
    reason,
  });

  if (end.openQty.gt(0) && settlement.markEnd === null) {
    return unknown('В отчёте нет расчётной цены на конец периода при открытой позиции');
  }
  if (!settlement.periodFrom) return unknown('В отчёте не найдено начало периода');

  const start = stateAt(
    mine.filter((o) => o.date < (settlement.periodFrom as string)),
    instrumentId,
    settlement.markStart,
  );
  if (start.openQty.gt(0) && settlement.markStart === null) {
    return unknown('Позиция перешла из прошлого периода, а расчётной цены на начало в отчёте нет');
  }
  if (!new Decimal(settlement.qtyStart).abs().eq(start.openQty)) {
    return unknown(
      `Позиция на начало периода в журнале (${start.openQty}) не совпадает с отчётом (${new Decimal(settlement.qtyStart).abs()})`,
    );
  }

  const engineRub = end.gross.plus(end.unrealized).minus(start.gross.plus(start.unrealized));
  const diffRub = engineRub.minus(brokerRub);
  return {
    status: diffRub.abs().lte(SETTLEMENT_TOLERANCE_RUB) ? 'ok' : 'mismatch',
    engineRub,
    brokerRub,
    diffRub,
    asOf: settlement.date,
  };
}
