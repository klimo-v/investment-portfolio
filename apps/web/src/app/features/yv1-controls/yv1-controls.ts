import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import type { Yv1Overview } from '@core';
import { StrategyApi, type Yv1RefreshReport } from '../../entities/strategy/strategy.api';

/**
 * Управление стратегией: обновление из источника (мост QUIK) одной кнопкой, знаменатель (начальный
 * капитал) и выгрузка кривой в CSV. Эквивалент CLI `pnpm yv1:refresh`.
 */
@Component({
  selector: 'app-yv1-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule],
  template: `
    <div class="controls">
      <button mat-flat-button type="button" [disabled]="busy()" (click)="refresh()">
        <mat-icon>sync</mat-icon>
        {{ busy() ? 'Читаю мост…' : 'Обновить из моста' }}
      </button>

      <mat-form-field appearance="outline" subscriptSizing="dynamic" class="capital">
        <mat-label>Начальный капитал ТС, ₽</mat-label>
        <input
          matInput
          inputmode="decimal"
          [value]="settings().initialCapital ?? ''"
          (keydown.enter)="saveCapital($any($event.target).value)"
          (blur)="saveCapital($any($event.target).value)"
        />
        <mat-hint>
          @if (settings().capitalSource === 'automat-log') {
            из лога автомата (CAPITAL); задайте своё значение
          } @else if (settings().capitalSource === 'settings') {
            задан вручную
          } @else {
            не задан — доходность в % не считается
          }
        </mat-hint>
      </mat-form-field>

      <a
        mat-stroked-button
        [href]="csvUrl()"
        download="strategy_live_curve.csv"
        [class.disabled]="!hasCurve()"
        [attr.aria-disabled]="!hasCurve()"
        [attr.tabindex]="hasCurve() ? null : -1"
      >
        <mat-icon>download</mat-icon>
        Кривая в CSV
      </a>
    </div>

    @if (report(); as r) {
      <p class="report">
        Снимков: новых {{ r.snapshots.imported.length }}, уже были {{ r.snapshots.alreadyImported }},
        не целых {{ r.snapshots.incomplete.length }}, незавершённых {{ r.snapshots.unfinished.length }}.
        Журнал автомата: сделок {{ r.automat.trades }}, дней {{ r.automat.days }}.
        @if (r.snapshots.conflicts.length > 0) {
          <b>Изменились в файле уже импортированные снимки: {{ r.snapshots.conflicts.join(', ') }} — не перезаписаны.</b>
        }
      </p>
    }
  `,
  styles: [
    `
      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
      }
      .capital {
        width: 260px;
      }
      a.disabled {
        pointer-events: none;
        opacity: 0.5;
      }
      .report {
        margin: 8px 0 0;
        font-size: 13px;
        color: var(--app-text-muted);
      }
    `,
  ],
})
export class Yv1Controls {
  private readonly api = inject(StrategyApi);

  /** Стратегия, которой управляем */
  readonly systemId = input.required<string>();
  readonly settings = input.required<Yv1Overview['settings']>();
  readonly hasCurve = input(false);

  protected readonly busy = signal(false);
  protected readonly report = signal<Yv1RefreshReport | null>(null);
  protected readonly csvUrl = computed(() => this.api.curveCsvUrl(this.systemId()));
  private lastSent: string | null = null;

  protected async refresh(): Promise<void> {
    this.busy.set(true);
    try {
      this.report.set(await this.api.refresh(this.systemId()));
    } finally {
      this.busy.set(false);
    }
  }

  protected async saveCapital(raw: string): Promise<void> {
    const value = raw.replace(/\s/g, '').replace(',', '.');
    // сравниваем с тем, что показано в поле (в т.ч. значением из лога), и с последним отправленным:
    // просто Tab через поле или Enter + blur не должны «прибивать» значение и слать повторный PUT
    if (value === (this.settings().initialCapital ?? '') || value === this.lastSent) return;
    if (value !== '' && !/^\d+(\.\d+)?$/.test(value)) return;
    this.lastSent = value;
    try {
      await this.api.saveSettings(this.systemId(), { initialCapital: value === '' ? null : value });
    } catch (e) {
      this.lastSent = null;
      throw e;
    }
  }
}
