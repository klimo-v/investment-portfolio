/**
 * Валидатор ISIN (ISO 6166) — единственный на проект. Заменяет три разных регэкспа
 * (import.service, broker-html-report, tbank-xlsx-report), каждый из которых знал
 * только «RU…».
 *
 * Три проверки, все обязательны:
 *  1. формат: 2 буквы + 9 букв/цифр + 1 контрольная цифра (12 символов);
 *  2. код страны — из ISO 3166-1 alpha-2 (плюс служебные коды ISO 6166: XS, EU, …).
 *     Это отсекает внутренние коды брокера и СЕКОД вида `SU52002RMFS1`: формат у них
 *     случайно совпадает с ISIN, а контрольная сумма сходится с вероятностью 1/10;
 *  3. контрольная цифра по алгоритму Луна (буквы раскрываются в числа 10…35).
 *
 * Пример невалидного кода: `TCS00A10B4K3` — внутренний код Т-Банка (нет кода страны).
 */

/** ISO 3166-1 alpha-2 + служебные префиксы ISO 6166 (XS — международные выпуски, EU, …) */
const COUNTRY_CODES = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
    'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO ' +
    'JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR ' +
    'MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO ' +
    'RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV ' +
    'TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW ' +
    'XS EU XA XB XC XD XF'
  ).split(' '),
);

const ISIN_FORMAT = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** Алгоритм Луна над строкой, в которой буквы уже раскрыты в числа (A=10 … Z=35) */
function luhnValid(isin: string): boolean {
  const digits = [...isin].map((ch) => String(parseInt(ch, 36))).join('');
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Валидный ISIN: формат + код страны + контрольная цифра. Регистр не важен. */
export function isValidIsin(code: string | null | undefined): boolean {
  if (!code) return false;
  const s = code.trim().toUpperCase();
  return ISIN_FORMAT.test(s) && COUNTRY_CODES.has(s.slice(0, 2)) && luhnValid(s);
}
