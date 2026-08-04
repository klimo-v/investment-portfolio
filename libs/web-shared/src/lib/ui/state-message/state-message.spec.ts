import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { StateMessage } from './state-message';

describe('StateMessage', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<StateMessage>>;

  beforeEach(() => {
    fixture = TestBed.createComponent(StateMessage);
    fixture.componentRef.setInput('kind', 'empty');
    fixture.componentRef.setInput('title', 'Операций пока нет');
  });

  it('рендерит заголовок и подсказку', () => {
    fixture.componentRef.setInput('hint', 'Добавьте первую операцию или импортируйте отчёт');
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Операций пока нет');
    expect(el.textContent).toContain('Добавьте первую операцию');
  });

  it('без retryLabel кнопки нет — пустое состояние не всегда можно «повторить»', () => {
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });

  it('с retryLabel показывает кнопку и эмитит retry по клику', () => {
    const onRetry = vi.fn();
    fixture.componentRef.setInput('retryLabel', 'Повторить');
    fixture.componentInstance.retry.subscribe(onRetry);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('button').click();

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('иконка зависит от kind, но своя перебивает', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.state-icon').textContent.trim()).toBe('inbox');

    fixture.componentRef.setInput('kind', 'error');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.state-icon').textContent.trim()).toBe(
      'error_outline',
    );

    fixture.componentRef.setInput('icon', 'cloud_off');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.state-icon').textContent.trim()).toBe('cloud_off');
  });

  it('role="status" — смена состояния объявляется скринридером без перевода фокуса', () => {
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.state').getAttribute('role')).toBe('status');
  });
});
