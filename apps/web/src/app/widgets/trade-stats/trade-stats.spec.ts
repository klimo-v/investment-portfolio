import { provideRouter } from '@angular/router';
import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TradeStats, type TradeStatRow } from './trade-stats';

/**
 * Смоук-тест виджета статистики: считает ли он разрез по системам и не показывает
 * ли таблицу там, где сравнивать не с чем.
 *
 * Сами формулы (win rate, profit factor, матожидание) живут в @core и покрыты
 * своими тестами — здесь проверяется склейка: группировка, подстановка имён и
 * отбрасывание разрезов без закрытых сделок.
 */
function trade(overrides: Partial<TradeStatRow> = {}): TradeStatRow {
  return {
    systemId: 'sys-1',
    portfolioId: 'pf-1',
    status: 'Closed',
    realizedPnlRub: 1000,
    openedAt: '2026-01-10',
    closedAt: '2026-02-10',
    ...overrides,
  };
}

describe('TradeStats', () => {
  function render(trades: TradeStatRow[]) {
    const fixture = TestBed.createComponent(TradeStats);
    fixture.componentRef.setInput('trades', trades);
    fixture.componentRef.setInput(
      'systemNames',
      new Map([
        ['sys-1', 'Дивидендная'],
        ['sys-2', 'Спекулятивная'],
      ]),
    );
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [TradeStats], providers: [provideRouter([])] }),
  );

  it('без закрытых сделок показывает объяснение вместо пустых нулей', () => {
    const fixture = render([trade({ status: 'Open', closedAt: null })]);
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Нет закрытых сделок');
    // Проверяем заголовок карточки, а не «Win rate»: это словосочетание есть и в
    // тексте пустого состояния — объясняет, почему статистики нет
    expect(text).not.toContain('Статистика закрытых сделок');
  });

  it('считает сводку по закрытым сделкам', () => {
    const fixture = render([
      trade({ realizedPnlRub: 1000 }),
      trade({ realizedPnlRub: -500 }),
      // Открытая в статистику попасть не должна: это ещё не результат
      trade({ status: 'Open', closedAt: null, realizedPnlRub: 0 }),
    ]);
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Win rate');
    expect(text).toContain('50%');
  });

  it('разрез по системам сохраняет ссылку даже для одной системы', () => {
    const single = render([trade(), trade()]);
    expect(single.nativeElement.querySelector('a')?.getAttribute('href')).toBe('/systems/sys-1');

    const many = render([trade(), trade({ systemId: 'sys-2', realizedPnlRub: -300 })]);
    const text = many.nativeElement.textContent as string;
    expect(text).not.toContain('Недостаточно систем');
    // Имена подставляются из справочника, а не показываются как id
    expect(text).toContain('Дивидендная');
    expect(text).toContain('Спекулятивная');
    expect(text).not.toContain('sys-1');
  });
});
