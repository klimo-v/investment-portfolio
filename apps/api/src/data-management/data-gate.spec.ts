import { describe, expect, it } from 'vitest';
import { firstValueFrom, from } from 'rxjs';
import type { ExecutionContext } from '@nestjs/common';
import { dataGate, DataGateInterceptor } from './data-gate';

function context(method = 'POST', generation = dataGate.generation): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method, headers: { 'x-portfolio-generation': generation } }),
    }),
  } as unknown as ExecutionContext;
}
describe('ограждение незавершённых запросов и старых вкладок', () => {
  it('пока async импорт не завершён, замена запрещена; ошибка освобождает ограждение', async () => {
    let fail!: (error: Error) => void;
    const work = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    const result = firstValueFrom(
      new DataGateInterceptor().intercept(context(), { handle: () => from(work) }),
    );
    expect(dataGate.active).toBe(1);
    expect(() => dataGate.assertIdle()).toThrow(/импорт/);
    fail(new Error('import failed'));
    await expect(result).rejects.toThrow('import failed');
    expect(dataGate.active).toBe(0);
  });
  it('запись из старой вкладки отвергается до вызова сервиса', () => {
    const previous = dataGate.generation;
    dataGate.changed();
    expect(() =>
      new DataGateInterceptor().intercept(context('POST', previous), { handle: () => from([]) }),
    ).toThrow(/Обновите/);
    expect(dataGate.active).toBe(0);
  });
});
