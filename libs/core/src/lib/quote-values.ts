import Decimal from 'decimal.js';

/** Проверка десятичных строк без перевода в Number и потери точности.
 * Нулевая цена допустима; отрицательная расчётная цена — только у фьючерса.
 * НКД может отсутствовать или равняться нулю.
 */
export function quoteValuesIssue(
  price: unknown,
  accrued: unknown,
  allowNegativePrice = false,
): string | null {
  const decimal = (value: unknown): Decimal | null => {
    if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))
      return null;
    try {
      const result = new Decimal(value);
      return result.isFinite() ? result : null;
    } catch {
      return null;
    }
  };
  const p = decimal(price);
  if (!p || (!allowNegativePrice && p.isNegative() && !p.isZero())) return 'Некорректная цена';
  if (accrued !== null && accrued !== undefined) {
    const a = decimal(accrued);
    if (!a || (a.isNegative() && !a.isZero())) return 'Некорректный НКД';
  }
  return null;
}

/** Обычная десятичная запись для API и SQLite, без округления и Number.
 * Вызывать после quoteValuesIssue: недопустимые наблюдения сохраняют свою диагностику.
 */
export function plainQuoteDecimal(value: string): string {
  return new Decimal(value).toFixed();
}
