import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { Yv1Overview } from '@core';
import { StateMessage, StatusChip, type ChipTone } from '@web-shared';

type Item = Yv1Overview['discrepancies'][number];

const TONE: Record<Item['severity'], ChipTone> = { error: 'danger', warn: 'warn', info: 'info' };
const LABEL: Record<Item['severity'], string> = { error: 'ошибка', warn: 'внимание', info: 'инфо' };

/**
 * Расхождения мост ↔ автомат ↔ расчёты. Не сглаживаются: каждый пункт остаётся в списке,
 * пока источник данных не изменится. Автомат сам по себе остаётся источником истины по
 * принадлежности сделки ТС; мост — по ценам, времени и комиссиям.
 */
@Component({
  selector: 'app-yv1-discrepancies',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, StatusChip, StateMessage],
  template: `
    <mat-card>
      <h3>Расхождения ({{ items().length }})</h3>
      @if (items().length === 0) {
        <app-state-message kind="empty" icon="check_circle" title="Расхождений нет" hint="Мост, журнал автомата и расчёты сходятся." />
      } @else {
        <div class="table-scroll">
          <table class="yv1-table">
            <thead>
              <tr>
                <th>Уровень</th>
                <th>Тип</th>
                <th>Дата</th>
                <th>Что не так</th>
              </tr>
            </thead>
            <tbody>
              @for (d of items(); track $index) {
                <tr>
                  <td><app-status-chip [tone]="tone(d)">{{ label(d) }}</app-status-chip></td>
                  <td>{{ d.kind }}</td>
                  <td>{{ d.date ?? '—' }}</td>
                  <td class="msg">{{ d.message }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </mat-card>
  `,
  styles: [
    `
      mat-card {
        padding: 16px;
      }
      h3 {
        margin: 0 0 8px;
        font-weight: 500;
      }
      .msg {
        white-space: normal;
        min-width: 320px;
      }
    `,
  ],
})
export class Yv1Discrepancies {
  readonly discrepancies = input.required<readonly Item[]>();
  protected readonly items = computed(() => this.discrepancies());
  protected tone(d: Item): ChipTone {
    return TONE[d.severity];
  }
  protected label(d: Item): string {
    return LABEL[d.severity];
  }
}
