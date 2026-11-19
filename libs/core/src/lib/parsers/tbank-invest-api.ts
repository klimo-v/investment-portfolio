import Decimal from 'decimal.js';
import type { RawRow } from '../import';
import type { InstrumentIdentifiers } from '../instrument-identity';
import { isValidIsin } from '../isin';

/**
 * Маппер ответов T-Invest API (метод `OperationsService/GetOperationsByCursor`)
 * в общий формат `RawRow` (CLAUDE.md §7, OCP: новый источник = новый «парсер»,
 * конвейер импорта ниже не меняется).
 *
 * Функция чистая и не тянет Node-зависимостей — поэтому живёт в `libs/core`
 * рядом с `broker-html-report.ts` и тестируется фикстурами. HTTP-клиент,
 * пагинация и токен — на бэке (`apps/api/.../import/tbank/`).
 *
 * Соглашения совместимы с ранее импортированными отчётами Т-Банка:
 * цена — за единицу и БЕЗ НКД,
 * выплаты — нетто (за вычетом налога), `brokerRef` сделки — её биржевой номер.
 * Это не косметика: по `brokerRef` работает дедупликация (`makeDedupeKey`),
 * поэтому сделка, уже импортированная из XLSX-отчёта, обязана дать тот же ключ
 * при импорте через API — иначе вся история задвоится.
 */

/** Денежная величина T-Invest API: целая часть строкой + наноединицы */
export interface TbankMoneyValue {
  currency?: string;
  units?: string;
  nano?: number;
}

/** Одна сделка внутри операции (частичное исполнение заявки) */
export interface TbankOperationTrade {
  /** Номер сделки на бирже — он же «Номер сделки» в XLSX-отчёте */
  num?: string;
  /** То же поле в ответах старого метода GetOperations */
  tradeId?: string;
  date?: string;
  quantity?: string;
  price?: TbankMoneyValue;
}

/** Элемент ответа GetOperationsByCursor */
export interface TbankOperationItem {
  id?: string;
  /** Ссылка на родительскую операцию: так налог связан со своим дивидендом */
  parentOperationId?: string;
  date?: string;
  /** Машинный тип операции, напр. OPERATION_TYPE_BUY */
  type?: string;
  /** Человекочитаемое описание от брокера */
  description?: string;
  state?: string;
  instrumentUid?: string;
  figi?: string;
  /** share | bond | etf | currency | futures | … */
  instrumentType?: string;
  payment?: TbankMoneyValue;
  price?: TbankMoneyValue;
  commission?: TbankMoneyValue;
  /** НКД по облигации — в цену НЕ входит (как и в XLSX-отчёте) */
  accruedInt?: TbankMoneyValue;
  quantity?: string;
  quantityDone?: string;
  tradesInfo?: { trades?: TbankOperationTrade[] };
}

/** Справочные поля инструмента (InstrumentsService/GetInstrumentBy) */
export interface TbankInstrumentRef {
  ticker?: string;
  isin?: string;
  figi?: string;
  uid?: string;
  name?: string;
  currency?: string;
  instrumentType?: string;
}

/**
 * Типы операций брокера → ключи, которые уже понимает `classifyOperationType`
 * (`libs/core/src/lib/import.ts`). Намеренно НЕ полный: неизвестный тип не
 * маппится, а пробрасывается как есть и подсвечивается в предпросмотре как
 * `warn` — так новые типы операций у брокера видно, а не молча превращаются
 * в «покупку».
 */
const OPERATION_TYPE_MAP: Record<string, string> = {
  OPERATION_TYPE_BUY: 'buy',
  OPERATION_TYPE_BUY_CARD: 'buy',
  OPERATION_TYPE_BUY_MARGIN: 'buy',
  OPERATION_TYPE_SELL: 'sell',
  OPERATION_TYPE_SELL_CARD: 'sell',
  OPERATION_TYPE_SELL_MARGIN: 'sell',
  OPERATION_TYPE_INPUT: 'deposit',
  OPERATION_TYPE_INPUT_SWIFT: 'deposit',
  OPERATION_TYPE_INPUT_ACQUIRING: 'deposit',
  OPERATION_TYPE_OUTPUT: 'withdraw',
  OPERATION_TYPE_OUTPUT_SWIFT: 'withdraw',
  OPERATION_TYPE_OUTPUT_ACQUIRING: 'withdraw',
  OPERATION_TYPE_DIVIDEND: 'dividend',
  OPERATION_TYPE_COUPON: 'coupon',
  // погашение облигации приходит деньгами на счёт, как и купон
  OPERATION_TYPE_BOND_REPAYMENT: 'coupon',
  OPERATION_TYPE_BOND_REPAYMENT_FULL: 'coupon',
  // налоги: знак суммы несёт payment (возврат и корректировка — положительный payment, см. signedAmount)
  OPERATION_TYPE_TAX: 'tax',
  OPERATION_TYPE_TAX_PROGRESSIVE: 'tax',
  OPERATION_TYPE_TAX_CORRECTION: 'tax',
  OPERATION_TYPE_TAX_CORRECTION_PROGRESSIVE: 'tax',
  OPERATION_TYPE_TAX_CORRECTION_COUPON: 'tax',
  OPERATION_TYPE_DIVIDEND_TAX: 'tax',
  OPERATION_TYPE_DIVIDEND_TAX_PROGRESSIVE: 'tax',
  OPERATION_TYPE_COUPON_TAX: 'tax',
  OPERATION_TYPE_BOND_TAX: 'tax',
  OPERATION_TYPE_BOND_TAX_PROGRESSIVE: 'tax',
  OPERATION_TYPE_BENEFIT_TAX: 'tax',
  OPERATION_TYPE_BENEFIT_TAX_PROGRESSIVE: 'tax',
  OPERATION_TYPE_TAX_REPO: 'tax',
  OPERATION_TYPE_TAX_REPO_PROGRESSIVE: 'tax',
  OPERATION_TYPE_TAX_REPO_REFUND: 'tax',
  OPERATION_TYPE_TAX_REPO_REFUND_PROGRESSIVE: 'tax',
  OPERATION_TYPE_BROKER_FEE: 'fee',
  OPERATION_TYPE_SERVICE_FEE: 'fee',
  OPERATION_TYPE_MARGIN_FEE: 'fee',
  OPERATION_TYPE_SUCCESS_FEE: 'fee',
  OPERATION_TYPE_TRACK_MFEE: 'fee',
  OPERATION_TYPE_TRACK_PFEE: 'fee',
  OPERATION_TYPE_OVERNIGHT: 'fee',
  OPERATION_TYPE_CASH_FEE: 'fee',
  OPERATION_TYPE_OUT_FEE: 'fee',
  OPERATION_TYPE_ADVICE_FEE: 'fee',
  OPERATION_TYPE_OUT_STAMP_DUTY: 'fee',
  // перевод денег между своими счетами (знак — в данных, как у Transfer)
  OPERATION_TYPE_TRANS_IIS_BS: 'transfer',
  OPERATION_TYPE_TRANS_BS_BS: 'transfer',
  OPERATION_TYPE_TRANS_IIS_IIS: 'transfer',
  // DIV_EXT разбирается отдельно (дивиденд «на карту»), в карту не входит. Остальное
  // неизвестное НЕ угадывается: classifyOperationType отдаёт ошибку предпросмотра.
};

/** Расходные категории: сумма в журнале = −payment (payment брокера — со знаком движения денег) */
const EXPENSE_TYPES = new Set(['tax', 'fee', 'withdraw']);

/**
 * Сумма денежной операции со знаком по правилу П2: знак задаёт брокер (`payment`), тип — только
 * категория. Расходные (налог, комиссия, вывод): amount = −payment; доходные (ввод, дивиденд,
 * купон) и перевод: amount = +payment. Отрицательная сумма — возврат или сторно.
 */
function signedAmount(tradeType: string, payment: Decimal): Decimal {
  return EXPENSE_TYPES.has(tradeType) ? payment.neg() : payment;
}

function moscowTimestamp(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) return undefined;
  return new Date(timestamp + 3 * 3_600_000).toISOString();
}

/** Время операции «ЧЧ:ММ:СС» по Москве (как в отчётах брокера) из метки UTC. */
function toMskTime(raw: string | undefined): string | undefined {
  return moscowTimestamp(raw)?.slice(11, 19);
}

/** Типы инструментов брокера → типы справочника (schemas.ts, InstrumentSchema) */
const INSTRUMENT_TYPE_MAP: Record<string, string> = {
  share: 'Stock',
  bond: 'Bond',
  etf: 'ETF',
  currency: 'Currency',
};

const BUY_SELL = new Set(['buy', 'sell']);
/** Налоги, которые сворачиваются в свою родительскую выплату (нетто) */
const WITHHOLDING_TAX_TYPES = new Set([
  'OPERATION_TYPE_DIVIDEND_TAX',
  'OPERATION_TYPE_DIVIDEND_TAX_PROGRESSIVE',
  'OPERATION_TYPE_COUPON_TAX',
  'OPERATION_TYPE_BOND_TAX',
]);
/** Выплаты: количество не имеет смысла, вся сумма кладётся в цену. */
const PAYOUT_TYPES = new Set(['dividend', 'coupon', 'tax', 'fee', 'deposit', 'withdraw', 'transfer']);
/** Дивиденд, выплаченный «на карту» минуя брокерский счёт */
const DIV_EXT = 'OPERATION_TYPE_DIV_EXT';

/**
 * MoneyValue/Quotation → десятичная строка. Знак несут ОБА поля (units и nano),
 * поэтому они просто складываются. Через decimal.js, никакого `Number`
 * (CLAUDE.md §11: деньги не через float).
 */
export function moneyToDecimal(value: TbankMoneyValue | undefined): Decimal {
  if (!value) return new Decimal(0);
  const units = new Decimal(value.units ?? '0');
  const nano = new Decimal(value.nano ?? 0).div(1_000_000_000);
  return units.plus(nano);
}

function reportedMoney(value: TbankMoneyValue | undefined): Decimal | undefined {
  if (!value || (value.units === undefined && value.nano === undefined)) return undefined;
  if (value.units !== undefined && (typeof value.units !== 'string' || !/^-?\d+$/.test(value.units))) {
    return undefined;
  }
  const nano = value.nano === undefined ? 0 : value.nano;
  if (!Number.isInteger(nano) || Math.abs(nano) >= 1_000_000_000) return undefined;
  const units = new Decimal(value.units ?? '0');
  if ((units.gt(0) && nano < 0) || (units.lt(0) && nano > 0)) return undefined;
  return moneyToDecimal(value);
}

function positiveQuantity(value: string | undefined): Decimal | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const quantity = new Decimal(value);
  return quantity.gt(0) ? quantity : undefined;
}

const executionNumber = (trade: TbankOperationTrade): string | undefined =>
  trade.num?.trim() || trade.tradeId?.trim() || undefined;

function grossAmounts(
  item: TbankOperationItem,
  trades: TbankOperationTrade[],
  currency: string,
  groupIssue: string | undefined,
): { amounts: Decimal[]; source: NonNullable<RawRow['grossTradeAmountSource']> } | { problem: string } {
  if (groupIssue) return { problem: groupIssue };
  const prices = trades.map((trade) => trade.price);
  for (const [label, value] of [
    ['платежа', item.payment], ['цены операции', item.price], ['НКД', item.accruedInt],
    ...prices.map((price) => ['цены исполнения', price] as const),
  ] as const) {
    if (value && value.currency?.toUpperCase() !== currency) {
      return { problem: `Валюта ${label} неизвестна или отличается от ${currency}` };
    }
  }
  if (OPERATION_TYPE_MAP[item.type ?? ''] === 'sell') {
    return { problem: 'Знак и состав сделки продажи в payment не подтверждены' };
  }
  if (item.type !== 'OPERATION_TYPE_BUY' || currency !== 'RUB') {
    return { problem: 'Состав платежа для этого вида сделки или валюты не подтверждён' };
  }

  const payment = reportedMoney(item.payment)?.neg();
  if (!payment?.gt(0) || payment.decimalPlaces() > 2) {
    return { problem: 'Некорректный платёж покупки (payment)' };
  }

  if (trades.some((trade) => !executionNumber(trade))) {
    return { problem: 'Биржевые номера исполнений отсутствуют или повторяются' };
  }
  const quantities = trades.flatMap((trade) => positiveQuantity(trade.quantity) ?? []);
  const done = positiveQuantity(item.quantityDone);
  if (!trades.length || !done || quantities.length !== trades.length || !Decimal.sum(...quantities).eq(done)) {
    return { problem: 'Список исполнений не совпадает с исполненным объёмом (quantityDone)' };
  }
  const cleanPrices = prices.flatMap((price) => {
    const amount = reportedMoney(price);
    return amount?.gt(0) ? [amount] : [];
  });
  if (cleanPrices.length !== trades.length) return { problem: 'Некорректная чистая цена исполнения' };
  const accrued = reportedMoney(item.accruedInt);
  if (item.accruedInt && (!accrued || accrued.lt(0))) return { problem: 'Некорректный НКД (accruedInt)' };
  if (trades.length === 1) return { amounts: [payment], source: 'tbank-payment' };

  const days = trades.map((trade) => moscowTimestamp(trade.date)?.slice(0, 10));
  if (!days[0] || days.some((day) => day !== days[0]) || cleanPrices.some((price) => !price.eq(cleanPrices[0]))) {
    return { problem: 'Исполнения группы имеют разные даты или цены либо дата неизвестна' };
  }
  if (!accrued) return { problem: 'В API нет НКД по группе исполнений (accruedInt)' };
  const accruedPerUnit = accrued.div(done);
  if (accruedPerUnit.decimalPlaces() > 2 || !accruedPerUnit.mul(done).eq(accrued)) {
    return { problem: 'НКД на бумагу не подтверждён с точностью до копейки' };
  }
  const amounts = quantities.map((qty, i) =>
    cleanPrices[i].mul(qty).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).plus(accruedPerUnit.mul(qty)),
  );
  if (!Decimal.sum(...amounts).eq(payment)) {
    return { problem: 'Сумма исполнений с НКД расходится с payment до копейки' };
  }
  return { amounts, source: 'tbank-reconciled' };
}

/** `2024-03-15T10:30:00Z` → `2024-03-15` (normalizeDate ждёт ISO-дату) */
function toIsoDate(raw: string | undefined): string {
  return (raw ?? '').slice(0, 10);
}

/**
 * Раскладывает комиссию операции по её сделкам пропорционально объёму.
 * Остаток от округления отдаётся последней сделке, поэтому сумма комиссий по
 * строкам в точности равна комиссии операции — иначе итоговые затраты по
 * позиции разошлись бы с отчётом брокера на копейки.
 */
function allocateFee(commission: Decimal, weights: Decimal[]): Decimal[] {
  const total = weights.reduce((acc, w) => acc.plus(w), new Decimal(0));
  if (commission.isZero() || total.isZero()) return weights.map(() => new Decimal(0));

  const allocated = weights.map((w) =>
    commission.times(w).div(total).toDecimalPlaces(2, Decimal.ROUND_DOWN),
  );
  const rest = commission.minus(allocated.reduce((acc, a) => acc.plus(a), new Decimal(0)));
  allocated[allocated.length - 1] = allocated[allocated.length - 1].plus(rest);
  return allocated;
}

/** Идентификаторы инструмента из операции и справочной карточки брокера */
function tbankIdentifiers(
  item: TbankOperationItem,
  instrument: TbankInstrumentRef | undefined,
): InstrumentIdentifiers | undefined {
  const ids: InstrumentIdentifiers = {};
  const rawIsin = instrument?.isin?.trim();
  if (rawIsin) {
    if (isValidIsin(rawIsin)) ids.isin = rawIsin.toUpperCase();
    else ids.brokerCode = rawIsin.toUpperCase();
  }
  const figi = item.figi || instrument?.figi;
  if (figi) ids.figi = figi;
  const uid = item.instrumentUid || instrument?.uid;
  if (uid) ids.tbankUid = uid;
  return Object.keys(ids).length > 0 ? ids : undefined;
}

/**
 * Ответы GetOperationsByCursor → строки импорта.
 *
 * @param items    элементы операций (уже собранные со всех страниц курсора)
 * @param accountId идентификатор счёта у брокера — попадает в `accountRef`,
 *                  по нему `learnAccountMapping` привяжет счёт к портфелю
 * @param instruments справочник `instrumentUid → поля инструмента`: сами операции
 *                  несут только uid/figi, тикер приходится дозапрашивать
 */
export function mapTbankOperations(
  items: TbankOperationItem[],
  accountId: string,
  instruments: Map<string, TbankInstrumentRef> = new Map(),
): RawRow[] {
  const executed = items.filter((i) => i.state === 'OPERATION_STATE_EXECUTED');
  const byId = new Map(executed.filter((i) => i.id).map((i) => [i.id as string, i]));

  // Удержанный налог со ссылкой на выплату (parentOperationId) сворачивается в родителя
  // (нетто = выплата − налог) — сумма налога
  // со знаком (−payment): возврат налога уменьшает удержанное, а не прибавляется к нему.
  // ЗАМЕЧАНИЕ: на реальных данных (2026) API ссылку на родителя у налога не ставит — налог
  // идёт отдельной строкой Tax; ветка работает для случаев, когда ссылка есть.
  const withheldByParent = new Map<string, Decimal>();
  for (const item of executed) {
    if (!item.parentOperationId || !WITHHOLDING_TAX_TYPES.has(item.type ?? '')) continue;
    if (!byId.has(item.parentOperationId)) continue;
    const prev = withheldByParent.get(item.parentOperationId) ?? new Decimal(0);
    withheldByParent.set(item.parentOperationId, prev.plus(moneyToDecimal(item.payment).neg()));
  }

  // П1: одно списание брокера — одна запись. Комиссию сделки брокер присылает дважды: полем
  // `commission` сделки и дочерней операцией BROKER_FEE (на реальных данных суммы совпадают в 76
  // из 76 случаев). Берём сумму дочерних BROKER_FEE, если они есть (факт списания), иначе
  // `commission`. Никогда не складываем. Дочерняя комиссия отдельной строкой не идёт.
  const childFeeByParent = new Map<string, TbankMoneyValue[]>();
  const foldedFees = new Set<TbankOperationItem>();
  const foldedFeeIds = new Set<string>();
  for (const item of executed) {
    if (item.type !== 'OPERATION_TYPE_BROKER_FEE' || !item.parentOperationId) continue;
    const parent = byId.get(item.parentOperationId);
    if (!parent || !BUY_SELL.has(OPERATION_TYPE_MAP[parent.type ?? ''] ?? '')) continue;
    foldedFees.add(item);
    if (item.id && foldedFeeIds.has(item.id)) continue;
    if (item.id) foldedFeeIds.add(item.id);
    const fees = childFeeByParent.get(item.parentOperationId) ?? [];
    fees.push(item.payment ?? {});
    childFeeByParent.set(item.parentOperationId, fees);
  }

  // Налог «на карту»: API присылает его отдельной строкой без ссылки на выплату — ищем по
  // инструменту и дню. Если в тот же день есть и обычная выплата по бумаге, налог делится
  // пропорционально суммам выплат.
  const dayKey = (i: TbankOperationItem): string => `${i.instrumentUid ?? i.figi ?? ''}|${toIsoDate(i.date)}`;
  const taxByDay = new Map<string, Decimal>();
  const payoutSumByDay = new Map<string, Decimal>();
  for (const item of executed) {
    const isUnlinkedTax = WITHHOLDING_TAX_TYPES.has(item.type ?? '') && !(item.parentOperationId && byId.has(item.parentOperationId));
    if (isUnlinkedTax) taxByDay.set(dayKey(item), (taxByDay.get(dayKey(item)) ?? new Decimal(0)).plus(moneyToDecimal(item.payment).neg()));
    if (item.type === 'OPERATION_TYPE_DIVIDEND' || item.type === DIV_EXT) {
      payoutSumByDay.set(dayKey(item), (payoutSumByDay.get(dayKey(item)) ?? new Decimal(0)).plus(moneyToDecimal(item.payment)));
    }
  }
  const cardTax = (item: TbankOperationItem): Decimal => {
    const total = taxByDay.get(dayKey(item));
    const payouts = payoutSumByDay.get(dayKey(item));
    if (!total || !payouts || payouts.isZero()) return new Decimal(0);
    return total.times(moneyToDecimal(item.payment)).div(payouts).toDecimalPlaces(2);
  };

  const rows: RawRow[] = [];
  for (const item of executed) {
    if (foldedFees.has(item)) continue;
    // налог, уже учтённый в нетто-сумме родительской выплаты — отдельной строкой не идёт
    if (item.parentOperationId && WITHHOLDING_TAX_TYPES.has(item.type ?? '') && byId.has(item.parentOperationId)) continue;

    const instrument = item.instrumentUid ? instruments.get(item.instrumentUid) : undefined;
    // тикер — только биржевой; ISIN, figi и uid идут отдельными идентификаторами
    // (раньше всё складывалось в ticker и теряло смысл). «ISIN» брокера, не прошедший
    // проверку (TCS00A10B4K3), — внутренний код брокера, а не ISIN.
    const ticker = instrument?.ticker || undefined;
    const identifiers = tbankIdentifiers(item, instrument);
    const settlementCurrency = item.payment?.currency || instrument?.currency;
    const currency = (settlementCurrency ?? 'rub').toUpperCase();
    const isDivExt = item.type === DIV_EXT;
    const tradeType = isDivExt ? 'dividend' : (OPERATION_TYPE_MAP[item.type ?? ''] ?? item.type ?? '');

    const base = {
      date: toIsoDate(item.date),
      time: toMskTime(item.date),
      ticker,
      ...(identifiers ? { identifiers } : {}),
      name: instrument?.name,
      instrumentType: INSTRUMENT_TYPE_MAP[instrument?.instrumentType ?? item.instrumentType ?? ''],
      currency,
      tradeType,
      accountRef: accountId,
    } satisfies Partial<RawRow>;

    if (PAYOUT_TYPES.has(tradeType)) {
      const payment = moneyToDecimal(item.payment);
      const withheld = item.id ? withheldByParent.get(item.id) : undefined;
      // П2: знак задаёт брокер; отрицательная сумма — возврат/сторно (кэш вычитает расходы,
      // минус на минус даёт приход). Удержанный налог (если есть родитель) вычитается один раз.
      const amount = signedAmount(tradeType, payment).minus(withheld ?? 0);
      const isRefund = EXPENSE_TYPES.has(tradeType) && payment.gt(0);
      const group = isDivExt && item.id ? `divext:${item.id}` : undefined;
      rows.push({
        ...base,
        quantity: '1',
        price: amount.toFixed(),
        fee: '0',
        note: isRefund
          ? `${item.description ?? tradeType} (возврат)`
          : withheld
            ? `${item.description ?? tradeType} нетто (налог учтён)`
            : item.description,
        // для выплат номер операции у брокера свой в API и в XLSX-отчёте — общего
        // ключа нет, поэтому пересечение периодов с файловым импортом ловится не
        // дедупликацией, а диапазоном дат (по умолчанию — с последней операции в базе)
        brokerRef: item.id,
        ...(group ? { transferGroup: group } : {}),
      });
      if (isDivExt) {
        // Дивиденд «на карту» деньгами на брокерский счёт не приходил и налог со счёта не
        // списывался (сверка с GetPositions): дивиденд (брутто) + налог остаются доходом, а
        // выплата на карту — выводом на сумму брутто − налог. Три записи в кэше дают ноль.
        const net = payment.minus(cardTax(item));
        rows.push({
          date: base.date,
          time: base.time,
          currency,
          tradeType: 'withdraw',
          accountRef: accountId,
          quantity: '1',
          price: net.toFixed(),
          fee: '0',
          note: `${item.description ?? 'Выплата на карту'} (нетто, мимо кэша)`,
          brokerRef: item.id ? `${item.id}:card` : undefined,
          ...(group ? { transferGroup: group } : {}),
        });
      }
      continue;
    }

    const trades = item.tradesInfo?.trades ?? [];
    const childFees = item.id ? childFeeByParent.get(item.id) : undefined;
    const feeValues = childFees ?? (item.commission ? [item.commission] : []);
    const checkFee = (value: TbankMoneyValue): string | undefined => {
      const amount = reportedMoney(value);
      // Некоторые ответы содержат пустой объект commission вместо отсутствующего поля.
      if (value === item.commission && amount === undefined && Object.keys(value).length === 0) return undefined;
      if (!amount) return 'Некорректная комиссия в ответе Т‑Банка';
      if (amount.isZero() && !value.currency) return undefined;
      if (value.currency?.toUpperCase() !== currency) return `Валюта комиссии неизвестна или отличается от ${currency}`;
      return undefined;
    };
    const currencyIssue = base.instrumentType === 'Bond' && !settlementCurrency
      ? 'Неизвестна валюта расчётов по облигации' : undefined;
    const feeIssue = feeValues.map(checkFee).find(Boolean);
    const commission = (feeIssue ? [] : feeValues).reduce((total, value) => {
      const amount = reportedMoney(value) ?? new Decimal(0);
      return total.plus(childFees ? amount.neg() : amount.abs());
    }, new Decimal(0));
    const numbers = trades.map(executionNumber);
    // Без разных номеров импорт схлопнет несколько исполнений в одну операцию.
    const refIssue = trades.length > 1 && (numbers.includes(undefined) || new Set(numbers).size !== trades.length)
      ? 'Биржевые номера исполнений отсутствуют или повторяются'
      : undefined;
    const isTrade = BUY_SELL.has(tradeType);
    const gross = isTrade && base.instrumentType === 'Bond'
      ? grossAmounts(item, trades, currency, currencyIssue ?? refIssue ?? feeIssue)
      : undefined;
    const grossTradeAmountIssue = gross && 'problem' in gross ? gross.problem : undefined;
    const priceIssue = (value: TbankMoneyValue | undefined): string | undefined => {
      if (!isTrade) return undefined;
      if (!reportedMoney(value)?.gt(0)) return 'Некорректная чистая цена сделки';
      if (value?.currency?.toUpperCase() !== currency) return `Валюта чистой цены неизвестна или отличается от ${currency}`;
      return undefined;
    };

    if (!isTrade || trades.length === 0) {
      const quantity = positiveQuantity(item.quantityDone ?? item.quantity);
      rows.push({
        ...base,
        quantity: quantity?.toFixed() ?? '0',
        price: reportedMoney(item.price)?.abs().toFixed() ?? '0',
        fee: commission.toFixed(),
        note: item.description,
        brokerRef: item.id,
        grossTradeAmountIssue,
        skipReason: currencyIssue ?? feeIssue ?? priceIssue(item.price) ??
          (isTrade && !quantity ? 'Некорректное количество сделки' : undefined),
      });
      continue;
    }

    const groupIssue = currencyIssue ?? refIssue ?? feeIssue ?? trades.map((trade) => priceIssue(trade.price) ??
      (positiveQuantity(trade.quantity) ? undefined : 'Некорректное количество исполнения')).find(Boolean);
    const fees = groupIssue ? [] : allocateFee(commission, trades.map((trade) =>
      reportedMoney(trade.price)!.mul(positiveQuantity(trade.quantity)!),
    ));
    trades.forEach((trade, i) => {
      const num = numbers[i];
      rows.push({
        ...base,
        date: toIsoDate(trade.date ?? item.date),
        time: toMskTime(trade.date ?? item.date),
        quantity: positiveQuantity(trade.quantity)?.toFixed() ?? '0',
        price: reportedMoney(trade.price)?.abs().toFixed() ?? '0',
        fee: fees[i]?.toFixed() ?? '0',
        note: num ? `Сделка № ${num}` : item.description,
        brokerRef: num || item.id,
        executionRef: num,
        grossTradeAmount: gross && 'amounts' in gross ? gross.amounts[i].toFixed() : undefined,
        grossTradeAmountSource: gross && 'source' in gross ? gross.source : undefined,
        grossTradeAmountIssue,
        skipReason: groupIssue,
      });
    });
  }

  return rows;
}
