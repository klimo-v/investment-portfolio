import { describe, it, expect } from 'vitest';
import { defaultSyncRange } from './import.page';
import { toIsoDate } from '../../shared/iso-date';

/**
 * Период синхронизации по умолчанию. Ошибка тут не падает, а тихо перетягивает
 * уже импортированные операции (или, наоборот, пропускает день) — поэтому
 * проверяем именно границы, а не только «функция что-то вернула».
 */

// полдень, а не полночь: маскирует ошибки конвертации дат через UTC
const today = new Date(2026, 7, 5, 12, 0, 0);

describe('defaultSyncRange', () => {
  it('начинает со следующего дня после последней операции в журнале', () => {
    const { from, to } = defaultSyncRange('2026-07-31', today);

    expect(toIsoDate(from)).toBe('2026-08-01');
    expect(toIsoDate(to)).toBe('2026-08-05');
  });

  it('корректно переходит через границу месяца и года', () => {
    expect(toIsoDate(defaultSyncRange('2025-12-31', today).from)).toBe('2026-01-01');
    expect(toIsoDate(defaultSyncRange('2026-02-28', today).from)).toBe('2026-03-01');
  });

  it('на пустом журнале берёт последние 90 дней', () => {
    const { from, to } = defaultSyncRange(null, today);

    expect(toIsoDate(from)).toBe('2026-05-07');
    expect(toIsoDate(to)).toBe('2026-08-05');
  });

  it('не отдаёт перевёрнутый период, если в журнале есть операции «из будущего»', () => {
    const { from, to } = defaultSyncRange('2026-12-31', today);

    expect(from.getTime()).toBeLessThanOrEqual(to.getTime());
    expect(toIsoDate(from)).toBe('2026-08-05');
  });

  it('мусор вместо даты трактуется как пустой журнал', () => {
    expect(toIsoDate(defaultSyncRange('вчера', today).from)).toBe('2026-05-07');
  });
});
