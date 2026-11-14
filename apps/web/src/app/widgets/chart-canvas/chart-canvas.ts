import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { BaseChartDirective } from 'ng2-charts';
import type { ChartConfiguration, ChartType } from 'chart.js';
import { provideAppCharts, syncChartDefaultsWithTheme } from '../../shared/chart.providers';

/**
 * Холст графика: контейнер фиксированной высоты + <canvas> под Chart.js.
 *
 * Единственное место во всём приложении, которое импортирует `ng2-charts` и
 * `chart.js`. За счёт этого Chart.js попадает ровно в один общий ленивый чанк:
 * виджеты-графики зависят от этого компонента, а страницы подключают виджеты через
 * @defer — до первой прокрутки до графика библиотека не загружается вовсе.
 *
 * Высоту задаёт контейнер, а не canvas: у Chart.js `responsive: true`, и без
 * фиксированной высоты предка график схлопывается в ноль.
 */
@Component({
  selector: 'app-chart-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BaseChartDirective],
  // Регистрация Chart.js — здесь, а не в app.config.ts (см. shared/chart.providers.ts)
  providers: [provideAppCharts()],
  template: `
    <div class="chart-box" [class.tall]="tall()">
      <canvas
        baseChart
        [type]="config().type"
        [data]="config().data"
        [options]="config().options"
        [plugins]="config().plugins ?? []"
      >
      </canvas>
    </div>
  `,
})
export class ChartCanvas<T extends ChartType = ChartType> {
  /** Готовая конфигурация — собирает её виджет, который знает про свои данные */
  readonly config = input.required<ChartConfiguration<T>>();
  /** Высокий вариант (--app-chart-h-tall) для графиков с длинным списком рядов */
  readonly tall = input(false);

  /** Дефолты Chart.js под тему; идемпотентно — переживает несколько холстов на странице */
  private readonly chartDefaults = syncChartDefaultsWithTheme();
}
