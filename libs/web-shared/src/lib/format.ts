/**
 * Форматирование чисел, валют, P&L для интерфейса (docs/03-ux-plan.md).
 * Разделители разрядов, знак валюты, цвет прибыль/убыток.
 */

export function formatMoney(value: string | number | null | undefined, currency = 'RUB'): string {
  if (value === null || value === undefined) return '—';
  const num = typeof value === 'string' ? Number(value) : value;
  const symbols: Record<string, string> = { RUB: '₽', USD: '$', USDT: '$' };
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
  return `${formatted} ${symbols[currency] ?? currency}`;
}

/**
 * Рубли из ЧИСЛА, а не из decimal-строки. Отдельная функция, потому что вызов
 * `formatMoney(v.toFixed(2), 'RUB')` слово в слово повторялся на трёх страницах:
 * `toFixed(2)` там не косметика, а способ не отдать в Intl число с хвостом
 * двоичной дроби. null/undefined — неизвестное значение, показываем прочерк.
 */
export function formatRub(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : formatMoney(value.toFixed(2), 'RUB');
}

export function formatPercent(value: string | number): string {
  const num = typeof value === 'string' ? Number(value) : value;
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(2)}%`;
}

/**
 * Процент или «—», если метрика не определена (например, вложено = 0 и ROI
 * считать не от чего). Прочерк — именно `null`, а не ноль: «0%» означало бы
 * «посчитали, вышло по нулям», а это другое утверждение.
 */
export function formatPercentOrDash(value: number | null): string {
  return value === null ? '—' : formatPercent(value);
}

/** Класс цвета для P&L: положительный — зелёный, отрицательный — красный */
export function pnlColorClass(value: string | number): 'pnl-positive' | 'pnl-negative' | 'pnl-zero' {
  const num = typeof value === 'string' ? Number(value) : value;
  if (num > 0) return 'pnl-positive';
  if (num < 0) return 'pnl-negative';
  return 'pnl-zero';
}

/** Известная часть текущей стоимости; ноль является полноценной оценкой. */
export function formatValuation(value: number | null | undefined, unvaluedPositionCount: number): string {
  if (unvaluedPositionCount === 0) return formatRub(value);
  const known = value === null || value === undefined ? 'Оценка недоступна' : `${formatRub(value)} по оценённым позициям`;
  return `${known} · без оценки: ${unvaluedPositionCount}`;
}

/** Цена единицы: сохраняем до восьми знаков, суммы денег остаются с двумя. */
export function formatPrice(value: string | number | null | undefined, currency = 'RUB'): string {
  if (value === null || value === undefined) return '—';
  const symbols: Record<string, string> = { RUB: '₽', USD: '$', USDT: '$' };
  return `${new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  }).format(Number(value))} ${symbols[currency] ?? currency}`;
}
