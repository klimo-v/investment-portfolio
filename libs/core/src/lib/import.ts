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

/** Ключ дедупликации: дата+тикер+тип+кол-во+цена (когда нет broker_ref) */
export function makeDedupeKey(op: Operation): string {
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
    resolveSystem: (name?: string) => string | null;
    resolvePortfolio: (broker?: string) => string | null;
    resolveInstrument: (ticker?: string) => string | null;
  },
): NormalizedRow | { error: string } {
  const date = normalizeDate(raw.date);
  if (!date) return { error: `Не удалось распознать дату: "${raw.date}"` };

  const systemId = resolvers.resolveSystem(raw.system);
  const portfolioId = resolvers.resolvePortfolio(raw.broker);
  if (!systemId) return { error: `Неизвестная система: "${raw.system}"` };
  if (!portfolioId) return { error: `Неизвестный портфель/брокер: "${raw.broker}"` };

  const { type, confidence, reason } = classifyOperationType(raw);
  const instrumentId = raw.ticker ? resolvers.resolveInstrument(raw.ticker) : null;

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
  };

  return { operation, confidence, reason, dedupeKey: makeDedupeKey(operation) };
}
