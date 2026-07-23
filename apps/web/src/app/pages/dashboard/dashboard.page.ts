import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatCardModule } from '@angular/material/card';

/** Страница «Дашборд» (docs/03-ux-plan.md, шаг 4). Плейсхолдер под графики Фазы 5. */
@Component({
  selector: 'app-dashboard-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule],
  template: `
    <h1 class="page-title">Дашборд</h1>
    <mat-card>
      <p>Сводка по всем системам, P&L по стратегиям, топ прибыль/убыток.</p>
      <p>Графики (ngx-echarts) подключаются в Фазе 5 — см. docs/04-roadmap.md.</p>
    </mat-card>
  `,
})
export class DashboardPage {}
