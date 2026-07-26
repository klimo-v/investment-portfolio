import { describe, it, expect } from 'vitest';
import { LoadingService } from './loading.service';

describe('LoadingService', () => {
  it('isLoading — false, пока нет активных запросов', () => {
    const service = new LoadingService();
    expect(service.isLoading()).toBe(false);
  });

  it('isLoading — true, пока хотя бы один запрос активен (параллельные запросы)', () => {
    const service = new LoadingService();
    service.start();
    service.start();
    expect(service.isLoading()).toBe(true);

    service.stop();
    expect(service.isLoading()).toBe(true); // второй запрос ещё не завершился

    service.stop();
    expect(service.isLoading()).toBe(false);
  });

  it('stop() не уходит в минус при лишнем вызове', () => {
    const service = new LoadingService();
    service.stop();
    service.stop();
    expect(service.isLoading()).toBe(false);
  });
});
