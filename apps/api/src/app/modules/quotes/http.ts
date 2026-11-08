/**
 * Все запросы к внешним источникам котировок идут с таймаутом: расчёт доходности и бенчмарка ждёт
 * догрузку истории и графика купонов, и зависший источник не должен подвешивать дашборд. Таймаут —
 * это обычный сбой источника: ошибка логируется, расчёт идёт по уже загруженному.
 */
export const FETCH_TIMEOUT_MS = 10_000;

export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
