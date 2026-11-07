import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { Yv1Overview } from '@core';
import { StatusChip, type ChipTone } from '@web-shared';

type Bridge = Yv1Overview['bridge'];

/**
 * Статус моста: последний целый снимок, возраст, список снимков (целые и нет) и дыры
 * по торговым дням. Дыра — торговый день без целого снимка после вечернего клиринга
 * (≥ 19:10 МСК): по нему данные моста неполны и заменяются журналом автомата.
 */
@Component({
  selector: 'app-yv1-bridge-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, StatusChip],
  template: `
    <mat-card>
      <h3>Статус моста</h3>
      @if (bridge().lastComplete; as last) {
        <p>
          Последний целый снимок: <b>{{ last.snapId }}</b> (торговая дата {{ last.tradeDate }}, скрипт v{{ last.scriptVersion }}).
          @if (last.ageMinutes !== null) {
            Возраст: {{ age(last.ageMinutes) }}.
          }
        </p>
      } @else {
        <p>
          <app-status-chip tone="danger">нет целых снимков</app-status-chip>
          Запустите <code>quik_snapshot.lua</code> в QUIK и нажмите «Обновить».
        </p>
      }

      <p class="muted">
        Покрыто дней с целым снимком после клиринга: {{ bridge().coverage.covered.length }} из
        {{ bridge().coverage.tradingDays.length }}.
        @if (bridge().coverage.holes.length > 0) {
          Дыры: {{ bridge().coverage.holes.length }}.
        }
      </p>

      @if (bridge().coverage.holes.length > 0) {
        <ul class="holes">
          @for (h of bridge().coverage.holes; track h.date) {
            <li><b>{{ h.date }}</b> — {{ h.reason }}</li>
          }
        </ul>
      }

      <div class="table-scroll">
        <table class="yv1-table">
          <thead>
            <tr>
              <th>Снимок</th>
              <th>Локальное время</th>
              <th>Торг. дата</th>
              <th>v</th>
              <th>Строк</th>
              <th>Сдвиг часов</th>
              <th>Состояние</th>
            </tr>
          </thead>
          <tbody>
            @for (s of bridge().snapshots; track s.snapId) {
              <tr>
                <td>{{ s.snapId }}</td>
                <td>{{ s.localTime }}</td>
                <td>{{ s.tradeDate }}</td>
                <td>{{ s.scriptVersion }}</td>
                <td>{{ s.rawLines }}</td>
                <td>{{ skew(s.clockSkewSec) }}</td>
                <td>
                  <app-status-chip [tone]="tone(s.complete)">{{ s.complete ? 'целый' : 'не целый' }}</app-status-chip>
                  @if (!s.complete) {
                    <span class="muted"> {{ s.reasons.join('; ') }}</span>
                  }
                </td>
              </tr>
            }
            @for (id of bridge().unfinished; track id) {
              <tr>
                <td>{{ id }}</td>
                <td colspan="5" class="muted">нет строки в индексе</td>
                <td><app-status-chip tone="warn">незавершённый</app-status-chip></td>
              </tr>
            }
          </tbody>
        </table>
      </div>
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
      .muted {
        color: var(--app-text-muted);
        font-size: 13px;
      }
      .holes {
        margin: 0 0 12px;
        padding-left: 18px;
        font-size: 13px;
      }
    `,
  ],
})
export class Yv1BridgeStatus {
  readonly bridge = input.required<Bridge>();

  protected tone(complete: boolean): ChipTone {
    return complete ? 'success' : 'warn';
  }

  protected age(minutes: number): string {
    if (minutes < 90) return `${minutes} мин`;
    const h = minutes / 60;
    return h < 48 ? `${h.toFixed(1)} ч` : `${(h / 24).toFixed(1)} сут`;
  }

  /** local − server: ночью ≈ 30 минут, днём 0 — это диагностика, на времена сделок не влияет */
  protected skew(sec: number | null): string {
    if (sec === null) return '—';
    const abs = Math.abs(sec);
    return `${sec < 0 ? '−' : ''}${Math.floor(abs / 60)} мин ${abs % 60} с`;
  }
}
