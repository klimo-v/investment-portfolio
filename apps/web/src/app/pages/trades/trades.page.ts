import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatCardModule } from '@angular/material/card';

/** Страница «Сделки» (docs/03-ux-plan.md, шаг 2). Только просмотр, считается из операций. */
@Component({
  selector: 'app-trades-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule],
  template: `
    <h1 class="page-title">Сделки</h1>
    <mat-card>
      <p>Открытые и закрытые сделки со статусом и P&L.</p>
      <p>Строятся из журнала операций автоматически — Фаза 2.</p>
    </mat-card>
  `,
})
export class TradesPage {}
