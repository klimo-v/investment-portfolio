/**
 * Справочник срочных контрактов (фьючерсов): множитель серии, переводящий
 * котировку отчёта брокера в рубли за контракт (docs/02-data-model.md, фьючерсы).
 *
 * Пример: CNY-12.26, цена в отчёте 12,467 → 12467 ₽ за контракт (множитель 1000).
 * Количество остаётся в контрактах.
 */

/**
 * Серия фьючерса → параметры.
 *  - `multiplier` — ₽ за пункт котировки (только степени десяти);
 *  - `quikCode` — префикс кода контракта в терминале QUIK (CNY ↔ «CR»: CRZ6 = CNY-12.26).
 *    Нужен только для сверки выгрузок исполнения с операциями журнала (annotations.ts).
 */
export const FUTURES_SPECS: Readonly<Record<string, { multiplier: number; quikCode: string }>> = {
  CNY: { multiplier: 1000, quikCode: 'CR' },
};

/** Буква месяца экспирации фьючерса (стандарт биржи): F = январь … Z = декабрь */
const MONTH_CODES = 'FGHJKMNQUVXZ';

/**
 * Код контракта QUIK → тикер отчёта брокера: «CRZ6» → «CNY-12.26». Год однозначный
 * (последняя цифра), считаем его в текущем десятилетии 2020-х. null — серия неизвестна
 * или код не распознан.
 */
export function quikCodeToTicker(code: string): string | null {
  const m = code.trim().toUpperCase().match(/^([A-Z0-9]{1,3}?)([FGHJKMNQUVXZ])(\d)$/);
  if (!m) return null;
  const series = Object.entries(FUTURES_SPECS).find(([, spec]) => spec.quikCode === m[1])?.[0];
  if (!series) return null;
  const month = String(MONTH_CODES.indexOf(m[2]) + 1).padStart(2, '0');
  return `${series}-${month}.2${m[3]}`;
}

/** Серия из кода контракта: «CNY-12.26» → «CNY» */
export function futuresSeries(contractCode: string): string | null {
  const m = contractCode.trim().match(/^([A-Za-z0-9]+)-\d{1,2}\.\d{2}$/);
  return m ? m[1].toUpperCase() : null;
}

/** Множитель серии контракта или null, если серия неизвестна */
export function futuresMultiplier(contractCode: string): number | null {
  const series = futuresSeries(contractCode);
  if (!series) return null;
  return FUTURES_SPECS[series]?.multiplier ?? null;
}

/**
 * Умножить десятичную строку на степень десяти СДВИГОМ запятой — без `number`,
 * чтобы не терять точность (CLAUDE.md §11: деньги не во float).
 * «12.467» × 1000 → «12467»; «12.27» × 1000 → «12270».
 */
export function scaleByPowerOfTen(value: string, multiplier: number): string {
  const exp = Math.round(Math.log10(multiplier));
  if (!Number.isInteger(exp) || 10 ** exp !== multiplier) {
    throw new Error(`Множитель ${multiplier} не является степенью десяти`);
  }
  const m = value.trim().match(/^(-?)(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[2] && !m[3])) throw new Error(`Не число: "${value}"`);
  const [, sign, intPart = '', fracPart = ''] = m;
  const frac = fracPart.padEnd(exp, '0');
  const shifted = (intPart || '0') + frac.slice(0, exp);
  const rest = frac.slice(exp);
  const intDigits = shifted.replace(/^0+(?=\d)/, '');
  const out = rest ? `${intDigits}.${rest}` : intDigits;
  return out === '0' ? '0' : sign + out;
}
