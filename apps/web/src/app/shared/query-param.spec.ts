import { describe, it, expect, beforeEach } from 'vitest';
import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { queryParams, type QueryParams } from './query-param';

/**
 * Регрессионный тест на реальный баг с дашборда (2026-08-05): переключение периода
 * визуально срабатывало, но данные не менялись, а после пары переключений тумблер
 * показывал одно, а фильтр значил другое.
 *
 * Причина была не в фильтре, а в записи: `setPeriod` делал ДВЕ-ТРИ навигации подряд
 * (период + обнуление границ). Роутер отменяет текущую навигацию, когда стартует
 * следующая, а `queryParamsHandling: 'merge'` считает базу от ещё не изменившегося
 * адреса — выживал только последний вызов, и `period` терялся по дороге.
 *
 * Поэтому тест проверяет не «сигнал обновился», а именно ПАЧКУ параметров: одна
 * навигация — ничего не теряется.
 */
@Component({
  selector: 'app-query-param-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class HostComponent {
  readonly params: QueryParams = queryParams();
  readonly router = inject(Router);
}

describe('queryParams', () => {
  let host: HostComponent;

  beforeEach(async () => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    // Стартуем роутер: без начальной навигации ActivatedRoute пуст
    await host.router.navigate([]);
    fixture.detectChanges();
  });

  it('пишет и читает параметр', async () => {
    await host.params.patch({ period: 'ytd' });

    expect(host.router.url).toContain('period=ytd');
    expect(host.params.read('period')()).toBe('ytd');
  });

  it('пачка параметров доезжает целиком, а не только последний', async () => {
    // Ровно сценарий setPeriod: выставить период И стереть границы произвольного
    await host.params.patch({ from: '2026-01-01', till: '2026-03-01' });
    await host.params.patch({ period: 'ytd', from: null, till: null });

    expect(host.params.read('period')()).toBe('ytd');
    expect(host.params.read('from')()).toBeNull();
    expect(host.params.read('till')()).toBeNull();
  });

  it('пустое значение вычищает параметр из адреса, а не пишет пустую строку', async () => {
    await host.params.patch({ system: 'sys-1' });
    expect(host.params.read('system')()).toBe('sys-1');

    await host.params.patch({ system: '' });
    expect(host.params.read('system')()).toBeNull();
    expect(host.router.url).not.toContain('system=');
  });

  it('не трогает параметры, которых нет в пачке', async () => {
    await host.params.patch({ system: 'sys-1', period: 'ytd' });
    await host.params.patch({ period: '1y' });

    expect(host.params.read('system')()).toBe('sys-1');
    expect(host.params.read('period')()).toBe('1y');
  });
});

describe('queryParams: почему patch, а не по одному параметру', () => {
  /**
   * Тест фиксирует НЕжелаемое поведение роутера — причину, по которой patch()
   * принимает пачку. Если Angular однажды перестанет отменять навигации, тест
   * покраснеет, и от patch() можно будет отказаться осознанно, а не случайно.
   *
   * Проверено на этом же коде: две навигации подряд оставляют адрес «/» — то есть
   * теряется НЕ ТОЛЬКО первый параметр, а вообще оба.
   */
  it('две навигации подряд гасят друг друга', async () => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fixture = TestBed.createComponent(HostComponent);
    const h = fixture.componentInstance;
    await h.router.navigate([]);

    const first = h.params.patch({ period: 'ytd' });
    const second = h.params.patch({ from: null });
    await Promise.all([first, second]);

    expect(h.router.url).not.toContain('period=ytd');
  });
});
