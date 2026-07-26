import { describe, it, expect } from 'vitest';
import { extractErrorMessage } from './extract-error-message';

describe('extractErrorMessage', () => {
  it('достаёт сообщение из HttpErrorResponse-подобного объекта', () => {
    const err = { error: { message: 'Портфель используется в операциях' } };
    expect(extractErrorMessage(err, 'fallback')).toBe('Портфель используется в операциях');
  });

  it('возвращает fallback, если структура ошибки не распознана', () => {
    expect(extractErrorMessage(new Error('boom'), 'fallback')).toBe('fallback');
    expect(extractErrorMessage(null, 'fallback')).toBe('fallback');
    expect(extractErrorMessage({ error: 'plain string' }, 'fallback')).toBe('fallback');
  });
});
