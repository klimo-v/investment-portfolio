import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatCardModule } from '@angular/material/card';

/** Страница «Импорт» (docs/03-ux-plan.md, шаг 5). Загрузка отчётов брокеров — Фаза 3. */
@Component({
  selector: 'app-import-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule],
  template: `
    <h1 class="page-title">Импорт</h1>
    <mat-card>
      <p>Загрузка отчёта брокера → парсер → предпросмотр → импорт.</p>
      <p>Движок сам определяет тип операции и переводы между портфелями — Фаза 3.</p>
    </mat-card>
  `,
})
export class ImportPage {}
