import { afterEach, describe, expect, it, vi } from 'vitest';
import { CbrProvider, CBR_RETRY_MS } from './cbr.provider';
import { fetchWithTimeout } from './http';
vi.mock('./http', () => ({ fetchWithTimeout: vi.fn() }));
const fetchRate = vi.mocked(fetchWithTimeout);
const response = (Value: unknown, Nominal: unknown = 1) =>
  ({
    ok: true,
    json: async () => ({ Valute: { USD: { Value, Nominal } } }),
  }) as Response;
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('CbrProvider: только достоверный курс', () => {
  it('RUB = 1 без сети; сбой с пустым кешем = null', async () => {
    fetchRate.mockRejectedValue(new Error('offline'));
    const cbr = new CbrProvider();
    expect(await cbr.getRateOrNull('RUB')).toBe(1);
    expect(fetchRate).not.toHaveBeenCalled();
    expect(await cbr.getRateOrNull('USD')).toBeNull();
  });
  it.each([
    [0, 1],
    [-90, 1],
    [NaN, 1],
    [Infinity, 1],
    ['90', 1],
    [90, 0],
    [90, -1],
    [90, NaN],
  ])('не принимает Value=%s Nominal=%s', async (value, nominal) => {
    fetchRate.mockResolvedValue(response(value, nominal));
    expect(await new CbrProvider().getRateOrNull('USD')).toBeNull();
  });
  it('использует валидный кеш даже после истечения TTL и сбоя/некорректного ответа', async () => {
    vi.useFakeTimers();
    const cbr = new CbrProvider();
    fetchRate.mockResolvedValueOnce(response(900, 10));
    expect(await cbr.getRateOrNull('USD')).toBe(90);
    vi.advanceTimersByTime(3600001);
    fetchRate.mockRejectedValueOnce(new Error('offline'));
    expect(await cbr.getRateOrNull('USD')).toBe(90);
    fetchRate.mockResolvedValueOnce(response(0));
    expect(await cbr.getRateOrNull('USD')).toBe(90);
  });
  it('объединяет параллельные валюты, выдерживает паузу после 503 и возобновляет загрузку', async () => {
    vi.useFakeTimers();
    const cbr = new CbrProvider();
    fetchRate.mockResolvedValue({ ok: false, status: 503 } as Response);
    expect(
      await Promise.all([
        cbr.getRateOrNull('USD'),
        cbr.getRateOrNull('EUR'),
        cbr.getRateOrNull('USD'),
      ]),
    ).toEqual([null, null, null]);
    expect(fetchRate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CBR_RETRY_MS - 1);
    expect(await cbr.getRateOrNull('USD')).toBeNull();
    expect(fetchRate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    fetchRate.mockResolvedValue(response(95));
    expect(await cbr.getRateOrNull('USD')).toBe(95);
    expect(fetchRate).toHaveBeenCalledTimes(2);
    await cbr.getRateOrNull('USD');
    expect(fetchRate).toHaveBeenCalledTimes(2);
  });
  it('после отказа с заполненным кешем возвращает старый курс всем ожидающим и внутри паузы', async () => {
    vi.useFakeTimers();
    const cbr = new CbrProvider();
    fetchRate.mockResolvedValueOnce(response(90));
    await cbr.getRateOrNull('USD');
    vi.advanceTimersByTime(3600001);
    fetchRate.mockResolvedValue({ ok: false, status: 503 } as Response);
    expect(await Promise.all([cbr.getRateOrNull('USD'), cbr.getRateOrNull('USD')])).toEqual([
      90, 90,
    ]);
    expect(fetchRate).toHaveBeenCalledTimes(2);
    expect(await cbr.getRateOrNull('USD')).toBe(90);
    expect(fetchRate).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(CBR_RETRY_MS);
    fetchRate.mockResolvedValue(response(95));
    expect(await cbr.getRateOrNull('USD')).toBe(95);
    expect(fetchRate).toHaveBeenCalledTimes(3);
  });
});
