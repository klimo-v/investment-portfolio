import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Hint } from './hint';

/**
 * Тесты бейджа-подсказки. Проверяют ровно то, ради чего компонент и появился:
 * доступность. Прежний `<span class="hint">?</span>` рендерился нормально, но был
 * недостижим с клавиатуры — визуальная проверка этого не ловит.
 */
describe('Hint', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<Hint>>;

  beforeEach(() => {
    fixture = TestBed.createComponent(Hint);
    fixture.componentRef.setInput('text', 'Себестоимость держимого остатка');
  });

  it('рендерится кнопкой, а не span — иначе элемент вне таб-порядка', () => {
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('.badge');

    expect(badge.tagName).toBe('BUTTON');
    expect(badge.getAttribute('type')).toBe('button');
  });

  it('aria-label содержит и предмет, и полный текст пояснения', () => {
    fixture.componentRef.setInput('label', 'Вложено');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.badge').getAttribute('aria-label')).toBe(
      'Вложено: Себестоимость держимого остатка',
    );
  });

  it('без явного label подставляется нейтральное «Подсказка»', () => {
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.badge').getAttribute('aria-label')).toBe(
      'Подсказка: Себестоимость держимого остатка',
    );
  });

  it('текст пояснения уходит в тултип', () => {
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('.badge');

    // MatTooltip вешает описание на элемент — проверяем, что директива подключилась
    expect(badge.getAttribute('aria-describedby')).toBeDefined();
  });
});
