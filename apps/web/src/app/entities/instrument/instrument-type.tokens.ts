import type { InstrumentType } from '@core';
import { chartSemantic, seriesColor } from '@web-shared';

/**
 * Представление типа инструмента на фронте: русская подпись, порядок вывода и цвет
 * в диаграммах. Слой FSD — entities: это знание о бизнес-сущности, а не о UI, поэтому
 * оно НЕ живёт в UI-ките (`libs/web-shared` не должен знать про InstrumentType).
 *
 * Цвета берём индексами из общей палитры `CHART_SERIES`, а не литералами: иначе на
 * одном экране круговая диаграмма и линии по инструментам разъезжаются по оттенкам.
 */
export const TYPE_LABEL: Record<InstrumentType, string> = {
  Stock: 'Акции',
  Bond: 'Облигации',
  ETF: 'Фонды (ETF)',
  Currency: 'Валюта',
  Crypto: 'Крипта',
  Cash: 'Кэш',
  Future: 'Фьючерсы',
};

/** Порядок групп на странице «Портфель» — от самого частого типа к редкому */
export const TYPE_ORDER: InstrumentType[] = ['Stock', 'Bond', 'ETF', 'Currency', 'Crypto', 'Future', 'Cash'];

export const TYPE_COLOR: Record<InstrumentType, string> = {
  Stock: seriesColor(0),
  Bond: seriesColor(1),
  Currency: seriesColor(2),
  ETF: seriesColor(3),
  Crypto: seriesColor(6),
  Future: seriesColor(4),
  // Кэш — не «ещё один инструмент», а нейтральный остаток: берём нейтральный
  // смысловой цвет, а не следующий оттенок из палитры серий
  Cash: chartSemantic(false).neutral,
};
