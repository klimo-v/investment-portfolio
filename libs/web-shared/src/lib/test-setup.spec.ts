import { describe, it, expect } from 'vitest';
import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

/**
 * Дымовой тест самой обвязки (test-setup.ts), а не какой-то фичи: проверяет, что
 * TestBed в этой либе умеет компилировать standalone-компонент, что нативный
 * control flow работает и что обнаружение изменений идёт БЕЗ Zone.js. Если он
 * покраснел — сломана инфраструктура тестов UI-кита, а не отдельный компонент.
 */
@Component({
  selector: 'app-probe',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (label()) {
      <span class="label">{{ label() }}</span>
    }
  `,
})
class ProbeComponent {
  readonly label = input('');
}

describe('обвязка TestBed для UI-кита', () => {
  it('компилирует standalone-компонент и рендерит @if по входу', () => {
    const fixture = TestBed.createComponent(ProbeComponent);
    fixture.componentRef.setInput('label', 'Вложено');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.label')?.textContent).toBe('Вложено');
  });

  it('перерисовывает по сигналу без Zone.js (zoneless, CLAUDE.md §4)', async () => {
    const text = signal('до');

    @Component({
      selector: 'app-probe-signal',
      changeDetection: ChangeDetectionStrategy.OnPush,
      template: `<span class="value">{{ text() }}</span>`,
    })
    class SignalProbe {
      readonly text = text;
    }

    const fixture = TestBed.createComponent(SignalProbe);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.value').textContent).toBe('до');

    text.set('после');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.value').textContent).toBe('после');
  });
});
