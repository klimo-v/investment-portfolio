import { z } from 'zod';
import { OperationType, type Operation } from './schemas';

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
  ticker?: string;
  currency?: string;
  broker?: string;
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

/** Убирает разделители разрядов и приводит к десятичной строке */
function normalizeNumber(raw: string | undefined, fallback = '0'): string {
  if (!raw) return fallback;
  const cleaned = raw.replace(/\s/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : fallback;
}

/** Классификация типа операции из брокер-специфичной строки */
export function classifyOperationType(
  raw: RawRow,
): { type: z.infer<typeof OperationType>; confidence: 'ok' | 'warn'; reason?: string } {
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
  };

  const matched = map[t];
  if (matched) return { type: matched, confidence: 'ok' };

  // не распознано — по умолчанию Buy, но помечаем как требующее проверки
  return {
    type: 'Buy',
    confidence: 'warn',
    reason: `Неизвестный тип операции: "${raw.tradeType}". Проверьте вручную.`,
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
    /** accountRef — признак счёта из отчёта (docs/04-roadmap.md §3.1), пробуется прежде broker/батч-дефолта */
    resolvePortfolio: (broker?: string, accountRef?: string) => string | null;
    /** name — резервный ключ, когда ticker/ISIN нет в справочнике (см. RawRow.name) */
    resolveInstrument: (ticker?: string, name?: string) => string | null;
    /** true, если для тикера система выбрана явно в этом импорте (не батч-дефолт) */
    systemChosenForTicker?: (ticker?: string) => boolean;
  },
): NormalizedRow | { error: string } {
  const date = normalizeDate(raw.date);
  if (!date) return { error: `Не удалось распознать дату: "${raw.date}"` };

  // Резолвим инструмент ДО системы: один и тот же актив брокер может репортить то
  // тикером, то ISIN (внебиржевые сделки/выплаты — реальный случай, docs/04-roadmap.md
  // §3.1-подобный). Выбор системы должен быть ОДИН на реальный инструмент, а не
  // разный для каждого сырого кода — иначе одна и та же бумага молча расползается
  // на две позиции с разными системами (движок группирует по instrumentId+systemId).
  const instrumentId = raw.ticker ? resolvers.resolveInstrument(raw.ticker, raw.name) : null;
  const systemKey = instrumentId ?? raw.ticker;

  const systemId = resolvers.resolveSystem(raw.system, systemKey);
  const portfolioId = resolvers.resolvePortfolio(raw.broker, raw.accountRef);
  if (!systemId) return { error: `Неизвестная система: "${raw.system}"` };
  if (!portfolioId) return { error: `Неизвестный портфель/брокер: "${raw.broker}"` };

  let { type, confidence, reason } = classifyOperationType(raw);

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
  };

  return { operation, confidence, reason, dedupeKey: makeDedupeKey(operation), systemUncertain };
}
