import Decimal from 'decimal.js';
import { z } from 'zod';
import { OperationType, type Operation } from './schemas';
import { identityKey, type InstrumentIdentifiers, type InstrumentSuggestion } from './instrument-identity';

/**
 * Движок импорта: нормализация «сырых» строк отчёта брокера в операции +
 * классификация типа операции + дедупликация (docs/02-data-model.md §6, CLAUDE.md §7).
 *
 * Архитектура: каждый брокер = свой парсер, приводящий файл к RawRow[] (OCP/LSP).
 * Дальнейшая нормализация и классификация — общие для всех брокеров (DRY).
 */

/** Сырая строка после парсинга файла брокера (уже приведённая к единым ключам) */
export interface RawRow {
  date: string; // любой распознаваемый формат даты
  system?: string;
  instrumentType?: string;
  /**
   * Биржевой тикер (только он). Валидный ISIN в этом поле шаг `normalizeRawRows` сам
   * переносит в `identifiers.isin`, хвост «@» срезается там же.
   */
  ticker?: string;
  /**
   * Структурированные идентификаторы инструмента, которые парсер реально знает
   * (docs/02-data-model.md, «Идентичность инструментов»). Заполняет парсер, не
   * дублируя их в `ticker`.
   */
  identifiers?: InstrumentIdentifiers;
  currency?: string;
  tradeType?: string; // Buy/Sell/Deposit/… или брокер-специфичное
  betweenPortfolios?: string; // "Да"/"Нет"/true
  quantity?: string;
  price?: string;
  fee?: string;
  leverage?: string;
  fxRate?: string;
  note?: string;
  /**
   * Признак СЧЁТА брокера из самого отчёта (напр. торговый код ИИС) —
   * не путать с торговой системой (`system`), которая в отчётах брокеров
   * не встречается никогда и всегда назначается пользователем
   * (docs/04-roadmap.md §3.1). Один отчёт может содержать операции разных
   * счетов (обычный брокерский ↔ ИИС) — этот признак позволяет их различать.
   */
  accountRef?: string;
  /** Тип счёта, если его удалось определить из текста отчёта */
  accountKind?: 'IIS' | 'Brokerage';
  /**
   * Уникальный номер операции у брокера (docs/02-data-model.md §6), если он есть
   * в отчёте. Используется как первичный ключ дедупликации вместо хэша по
   * значениям — важно, когда брокер исполняет много идентичных по цифрам сделок
   * в один день (напр. регулярный автоинвест в один и тот же фонд по одной цене) —
   * хэш date+ticker+type+qty+price тогда схлопывает РАЗНЫЕ сделки в «дубль».
   */
  brokerRef?: string;
  /**
   * Название бумаги из отчёта (напр. «ЛУКОЙЛ»), если брокер его указывает.
   * Один и тот же инструмент брокер может репортить то тикером, то ISIN
   * (напр. внебиржевые сделки) — имя остаётся неизменным в обоих случаях и
   * служит резервным ключом резолва инструмента, когда ни тикер, ни ISIN не
   * находятся в справочнике (apps/api/.../import.service.ts, ensureInstruments).
   */
  name?: string;
  /**
   * Время сделки «ЧЧ:ММ:СС» (если брокер его указывает). Нужно для порядка сделок
   * внутри дня — от него зависит результат по шортам (фьючерсы).
   */
  time?: string;
  /**
   * Номер ОПЕРАЦИИ-РОДИТЕЛЯ у брокера, к которой относится эта строка. Так API Т-Банка
   * присылает комиссию отдельной строкой (OPERATION_TYPE_BROKER_FEE с
   * parentOperationId). Шаг нормализации `attachParentFees` прибавляет сумму такой
   * строки к `fee` родителя (поиск по `brokerRef` в той же загрузке) и убирает её из
   * списка — любой парсер может пользоваться этим полем.
   */
  parentBrokerRef?: string;
  /**
   * Причина, по которой строку нельзя импортировать (напр. опцион или неизвестная
   * серия фьючерса). Если задана, `normalizeRow` возвращает ошибку с этим текстом,
   * и операция не создаётся — пользователь видит строку с понятной причиной.
   */
  skipReason?: string;
  /**
   * Общий ключ связанных строк одного факта, который разложен на несколько операций
   * (дивиденд «на карту»: Dividend + Withdraw; валюта на счёт: Deposit + Buy валюты).
   */
  transferGroup?: string;
}

/** Итог резолва инструмента для одной строки (то, что нужно normalizeRow) */
export interface InstrumentResolution {
  instrumentId: string | null;
  /** Идентификаторы указывают на разные инструменты и т. п. — строка не импортируется */
  conflict?: string;
  /** Инструмента ещё нет в справочнике (будет заведён при commit) */
  isNew?: boolean;
  /** Похожие существующие инструменты — подсказка для новой строки */
  suggestions?: InstrumentSuggestion[];
}

/** Результат нормализации одной строки */
export interface NormalizedRow {
  operation: Operation;
  /** уверенность классификации: ok — распознано, warn — требует проверки */
  confidence: 'ok' | 'warn';
  /** пояснение при warn */
  reason?: string;
  /** ключ дедупликации */
  dedupeKey: string;
  /**
   * Система назначена батч-дефолтом, а не выбрана явно для этого тикера в этом
   * импорте (docs/04-roadmap.md §3.1) — один отчёт может содержать сделки разных
   * систем, единый батч-дефолт для всего файла в таком случае ненадёжен, строка
   * требует проверки.
   */
  systemUncertain?: boolean;
}

/** Нормализация даты в YYYY-MM-DD из распространённых форматов */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  // уже ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // MM/DD/YYYY или M/D/YYYY (как в Google Sheets пользователя)
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const [, m, d, y] = us;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // DD.MM.YYYY (частый в РФ-отчётах)
  const ru = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (ru) {
    const [, d, m, y] = ru;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

/** Время «ЧЧ:ММ[:СС]» → «ЧЧ:ММ:СС»; нераспознанное — undefined */
function normalizeTime(raw: string | undefined): string | undefined {
  const m = raw?.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}` : undefined;
}

/** Убирает разделители разрядов и приводит к десятичной строке */
export function normalizeNumber(raw: string | undefined, fallback = '0'): string {
  if (!raw) return fallback;
  const cleaned = raw.replace(/\s/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : fallback;
}

/** Классификация типа операции из брокер-специфичной строки */
export function classifyOperationType(
  raw: RawRow,
): { type: z.infer<typeof OperationType>; confidence: 'ok' | 'warn'; reason?: string } | { type: null; confidence: 'warn'; reason: string } {
  const t = (raw.tradeType ?? '').trim().toLowerCase();
  const between = (raw.betweenPortfolios ?? '').trim().toLowerCase();

  // перевод между портфелями имеет приоритет
  if (between === 'да' || between === 'yes' || between === 'true') {
    return { type: 'Transfer', confidence: 'ok' };
  }

  const map: Record<string, z.infer<typeof OperationType>> = {
    buy: 'Buy',
    покупка: 'Buy',
    sell: 'Sell',
    продажа: 'Sell',
    deposit: 'Deposit',
    ввод: 'Deposit',
    пополнение: 'Deposit',
    withdraw: 'Withdraw',
    вывод: 'Withdraw',
    dividend: 'Dividend',
    дивиденд: 'Dividend',
    coupon: 'Coupon',
    купон: 'Coupon',
    tax: 'Tax',
    налог: 'Tax',
    fee: 'Fee',
    комиссия: 'Fee',
    transfer: 'Transfer',
    перевод: 'Transfer',
  };

  const matched = map[t];
  if (matched) return { type: matched, confidence: 'ok' };

  // не распознано — НЕ угадываем (раньше по умолчанию был Buy, и «выплата на карту» молча
  // становилась покупкой 0 × 0): строка не импортируется, причина видна в предпросмотре
  return {
    type: null,
    confidence: 'warn',
    reason: `Неизвестный тип операции: "${raw.tradeType}" — строка не учтена. Нужна поддержка типа в парсере.`,
  };
}

/**
 * Ключ дедупликации: приоритет — уникальный `brokerRef`, если он есть
 * (docs/02-data-model.md §6); иначе хэш по значениям (дата+тикер+тип+кол-во+цена).
 * Хэш-фоллбэк ложно схлопывает РАЗНЫЕ сделки с одинаковыми цифрами (напр. много
 * одинаковых автоинвест-покупок фонда за день) — поэтому brokerRef, когда он
 * есть, всегда в приоритете.
 */
export function makeDedupeKey(op: Operation): string {
  if (op.brokerRef) return `ref:${op.brokerRef}`;
  return [op.date, op.instrumentId ?? '', op.operationType, op.quantity, op.price].join('|');
}

/**
 * Нормализует одну сырую строку в операцию.
 * systemId/portfolioId/instrumentId ожидаются уже сопоставленными (по имени → id),
 * либо передаются резолверы.
 */
export function normalizeRow(
  raw: RawRow,
  resolvers: {
    /** ticker — для точечного выбора системы в рамках импорта (docs/04-roadmap.md §3.1), пробуется после name */
    resolveSystem: (name?: string, ticker?: string) => string | null;
    /** accountRef — признак счёта из отчёта (docs/04-roadmap.md §3.1), пробуется прежде батч-дефолта */
    resolvePortfolio: (accountRef?: string) => string | null;
    /**
     * Резолв инструмента строки (core/instrument-identity.ts: planInstrumentIdentities).
     * Принимает всю строку: ключи — идентификаторы, тикер и название (RawRow.name).
     */
    resolveInstrument: (raw: RawRow) => InstrumentResolution;
    /** true, если для тикера система выбрана явно в этом импорте (не батч-дефолт) */
    systemChosenForTicker?: (ticker?: string) => boolean;
  },
): NormalizedRow | { error: string } {
  if (raw.skipReason) return { error: raw.skipReason };

  const date = normalizeDate(raw.date);
  if (!date) return { error: `Не удалось распознать дату: "${raw.date}"` };

  // Резолвим инструмент ДО системы: один и тот же актив брокер может репортить то
  // тикером, то ISIN (внебиржевые сделки/выплаты — реальный случай, docs/04-roadmap.md
  // §3.1-подобный). Выбор системы должен быть ОДИН на реальный инструмент, а не
  // разный для каждого сырого кода — иначе одна и та же бумага молча расползается
  // на две позиции с разными системами (движок группирует по instrumentId+systemId).
  const identity = resolvers.resolveInstrument(raw);
  if (identity.conflict) return { error: identity.conflict };
  const instrumentId = identity.instrumentId;
  const systemKey = instrumentId ?? identityKey(raw);

  const systemId = resolvers.resolveSystem(raw.system, systemKey);
  const portfolioId = resolvers.resolvePortfolio(raw.accountRef);
  if (!systemId) return { error: `Неизвестная система: "${raw.system}"` };
  if (!portfolioId) {
    return {
      error: raw.accountRef
        ? `Неизвестный портфель для счёта отчёта "${raw.accountRef}"`
        : 'Портфель не определён — выберите портфель по умолчанию для импорта',
    };
  }

  // confidence/reason ниже могут быть понижены до warn, тип операции — нет
  const classified = classifyOperationType(raw);
  if (classified.type === null) return { error: classified.reason };
  const type = classified.type;
  let confidence = classified.confidence;
  let reason = classified.reason;

  // Система не пришла явно (типично для HTML-отчётов) и не выбрана явно для этого
  // инструмента в этом импорте — значит, взята из батч-дефолта, а он один на весь
  // файл, который в общем случае содержит сделки разных систем (§3.1). Намеренно
  // не запоминаем выбор между импортами: один и тот же инструмент в разное время
  // может относиться к разным системам — это решение пользователя, а не его свойство.
  // Не ошибка — операция всё равно импортируется, но строка требует проверки.
  const systemUncertain =
    !raw.system && !!systemKey && !(resolvers.systemChosenForTicker?.(systemKey) ?? true);
  if (systemUncertain && confidence === 'ok') {
    confidence = 'warn';
    reason = `Система назначена по умолчанию — выберите систему для "${systemKey}"`;
  }
  // Новый инструмент, похожий на уже известный: связывать автоматически нельзя (решает
  // человек), но молча заводить дубль тоже нельзя — подсказываем в предпросмотре.
  const similar = identity.isNew ? identity.suggestions?.[0] : undefined;
  if (similar && confidence === 'ok') {
    confidence = 'warn';
    reason = `Новый инструмент «${systemKey}» — возможно, это «${similar.ticker}» (${similar.reason}). Выберите существующий или оставьте новый.`;
  }

  const operation: Operation = {
    date,
    systemId,
    portfolioId,
    instrumentId,
    operationType: type,
    quantity: normalizeNumber(raw.quantity, '1'),
    price: normalizeNumber(raw.price, '0'),
    fee: normalizeNumber(raw.fee, '0'),
    fxRate: normalizeNumber(raw.fxRate, '1'),
    currency: (raw.currency ?? 'RUB').trim() || 'RUB',
    note: raw.note?.trim() || undefined,
    brokerRef: raw.brokerRef,
    executedAt: normalizeTime(raw.time),
    transferGroup: raw.transferGroup,
  };

  return { operation, confidence, reason, dedupeKey: makeDedupeKey(operation), systemUncertain };
}


/**
 * Общий шаг нормализации: строки с `parentBrokerRef` (комиссия, пришедшая отдельной
 * строкой) прибавляются к `fee` родительской строки с таким `brokerRef` и убираются
 * из списка. Иначе комиссия висела бы отдельной операцией без инструмента — в сделке и
 * статистике системы её не видно.
 *
 * Идемпотентно: сумма считается внутри одной загрузки (родитель + его дети), поэтому
 * повторный импорт даёт то же `fee`, а не удвоенное. Если родителя в загрузке нет,
 * строка остаётся как есть (обычная комиссия) — прибавлять вслепую к операции из базы
 * нельзя: без учёта уже прибавленных детей повторная загрузка удвоила бы комиссию.
 */
export function attachParentFees(rows: RawRow[]): RawRow[] {
  const parents = new Map<string, RawRow>();
  for (const r of rows) {
    if (r.brokerRef && !r.parentBrokerRef) parents.set(r.brokerRef, r);
  }
  const extra = new Map<string, Decimal>();
  const consumed = new Set<RawRow>();
  for (const r of rows) {
    if (!r.parentBrokerRef || !parents.has(r.parentBrokerRef)) continue;
    // сумма комиссии: колонка fee, а если её нет — price × quantity (строка типа «Комиссия»)
    const amount = r.fee
      ? new Decimal(normalizeNumber(r.fee, '0'))
      : new Decimal(normalizeNumber(r.price, '0')).mul(normalizeNumber(r.quantity, '1'));
    extra.set(r.parentBrokerRef, (extra.get(r.parentBrokerRef) ?? new Decimal(0)).plus(amount));
    consumed.add(r);
  }
  return rows
    .filter((r) => !consumed.has(r))
    .map((r) => {
      const add = r.brokerRef ? extra.get(r.brokerRef) : undefined;
      if (!add || r.parentBrokerRef) return r;
      return { ...r, fee: new Decimal(normalizeNumber(r.fee, '0')).plus(add).toString() };
    });
}

// ───────────────────────── обновление операции из первичного источника ─────────────────────────

/** Откуда пришли данные: отчёт/API брокера авторитетны для денег, прочее — нет */
export type FieldSource = 'broker' | 'annotation';

/** Поля операции, за которые отвечает брокер */
export type BrokerField = 'fee' | 'price' | 'quantity' | 'executedAt' | 'fxRate';

export interface FieldChange {
  field: BrokerField;
  /** было (как в базе) */
  from: string | null;
  /** станет */
  to: string;
}

const same = (a: string, b: string): boolean => new Decimal(a).eq(new Decimal(b));

/**
 * Единая политика приоритета источников при повторном импорте той же операции
 * (совпал `brokerRef` и портфель). Отчёт и API брокера авторитетны для денег и
 * количества; всё остальное (система, заметки, прочая разметка пользователя) этой
 * функцией не трогается вообще. Аннотации (CSV QUIK и подобное) не меняют НИ ОДНОГО
 * поля операции.
 *
 * Правила по полям:
 *  - `fee`: обновляется, только если пришла положительная комиссия, отличная от
 *    сохранённой. Комиссия «0» не затирает уже известную (источник мог её не знать).
 *  - `price`, `quantity`: любое расхождение — брокер прав.
 *  - `fxRate`: любое расхождение — брокер прав (курс обязателен для нерублёвых строк, см. foreign-cash.ts).
 *  - `executedAt`: обновляется, если источник дал время и оно отличается; пустое время
 *    существующее не стирает.
 */
export function mergeBrokerFields(
  existing: Pick<Operation, 'fee' | 'price' | 'quantity' | 'executedAt' | 'fxRate'>,
  incoming: Pick<Operation, 'fee' | 'price' | 'quantity' | 'executedAt' | 'fxRate'>,
  source: FieldSource = 'broker',
): FieldChange[] {
  if (source !== 'broker') return [];
  const changes: FieldChange[] = [];
  const exFee = existing.fee ?? '0';
  const inFee = incoming.fee ?? '0';
  if (new Decimal(inFee).gt(0) && !same(exFee, inFee)) {
    changes.push({ field: 'fee', from: exFee, to: inFee });
  }
  if (!same(existing.price, incoming.price)) {
    changes.push({ field: 'price', from: existing.price, to: incoming.price });
  }
  if (!same(existing.quantity, incoming.quantity)) {
    changes.push({ field: 'quantity', from: existing.quantity, to: incoming.quantity });
  }
  // курс к рублю: нерублёвая сумма с курсом 1 читалась как рубли (валютное пополнение) — брокерский курс исправляет
  const exFx = existing.fxRate ?? '1';
  const inFx = incoming.fxRate ?? '1';
  if (!same(exFx, inFx)) {
    changes.push({ field: 'fxRate', from: exFx, to: inFx });
  }
  if (incoming.executedAt && incoming.executedAt !== existing.executedAt) {
    changes.push({ field: 'executedAt', from: existing.executedAt ?? null, to: incoming.executedAt });
  }
  return changes;
}
