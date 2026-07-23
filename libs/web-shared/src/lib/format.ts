/**
 * Форматирование чисел, валют, P&L для интерфейса (docs/03-ux-plan.md).
 * Разделители разрядов, знак валюты, цвет прибыль/убыток.
 */

export function formatMoney(value: string | number, currency = 'RUB'): string {
  const num = typeof value === 'string' ? Number(value) : value;
  const symbols: Record<string, string> = { RUB: '₽', USD: '$', USDT: '$' };
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
  return `${formatted} ${symbols[currency] ?? currency}`;
}

export function formatPercent(value: string | number): string {
  const num = typeof value === 'string' ? Number(value) : value;
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(2)}%`;
}

/** Класс цвета для P&L: положительный — зелёный, отрицательный — красный */
export function pnlColorClass(value: string | number): 'pnl-positive' | 'pnl-negative' | 'pnl-zero' {
  const num = typeof value === 'string' ? Number(value) : value;
  if (num > 0) return 'pnl-positive';
  if (num < 0) return 'pnl-negative';
  return 'pnl-zero';
}
