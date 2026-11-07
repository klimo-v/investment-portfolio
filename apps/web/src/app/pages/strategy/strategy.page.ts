import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { ConfirmService, StateMessage, StatusChip, extractErrorMessage, formatMoney, type ChipTone } from '@web-shared';
import { StrategyListApi } from '../../entities/strategy/strategy-list.api';
import { StrategyApi } from '../../entities/strategy/strategy.api';
import { Yv1Controls } from '../../features/yv1-controls/yv1-controls';
import { Yv1BridgeStatus } from '../../widgets/yv1-bridge-status/yv1-bridge-status';
import { Yv1Costs } from '../../widgets/yv1-costs/yv1-costs';
import { Yv1CyclesTable } from '../../widgets/yv1-cycles-table/yv1-cycles-table';
import { Yv1Discrepancies } from '../../widgets/yv1-discrepancies/yv1-discrepancies';
import { Yv1EquityChart } from '../../widgets/yv1-equity-chart/yv1-equity-chart';

const VERDICT_TONE: Record<string, ChipTone> = {
  preliminary: 'warn',
  'no-corridor': 'neutral',
  inside: 'success',
  outside: 'danger',
};

/**
 * Страница стратегии `/strategies/:systemId`: фактический учёт торговой системы по файлам
 * источника (сейчас — мост QUIK). Страница только собирает данные и раскладывает виджеты
 * (FSD); расчёты — в @core. `systemId` приходит из маршрута (withComponentInputBinding).
 */
@Component({
  selector: 'app-strategy-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    StateMessage,
    StatusChip,
    Yv1Controls,
    Yv1BridgeStatus,
    Yv1EquityChart,
    Yv1CyclesTable,
    Yv1Costs,
    Yv1Discrepancies,
  ],
  template: `
    <div class="page-header">
      <h1 class="page-title">{{ title() }} — факт по мосту QUIK</h1>
      @if (strategy(); as s) {
        <span class="muted">{{ s.portfolioName ? 'Портфель: ' + s.portfolioName : 'Портфель не привязан' }}</span>
        <span class="spacer"></span>
        <button mat-stroked-button type="button" class="danger" [disabled]="removing()" (click)="remove(s.name)">
          <mat-icon>delete</mat-icon>
          Удалить стратегию
        </button>
      }
      @if (errorMessage()) {
        <p class="error">{{ errorMessage() }}</p>
      }
    </div>

    @if (overview.error()) {
      <app-state-message
        kind="error"
        title="Не удалось получить данные стратегии"
        hint="Проверьте, что API запущен и применены миграции; нажмите «Обновить из моста» после первого запуска."
      />
    } @else if (data(); as d) {
      <app-yv1-controls [systemId]="systemId()" [settings]="d.settings" [hasCurve]="d.curve !== null" />

      <mat-card class="verdict">
        <app-status-chip [tone]="verdictTone()">{{ verdictLabel() }}</app-status-chip>
        <span>{{ d.verdict.note }}</span>
        <span class="muted">
          Всего сделок: {{ d.counts.yv1 }} ТС
          @if (d.counts.unallocated > 0) {
            , {{ d.counts.unallocated }} не распределено
          }
          @if (d.counts.otherStrategy > 0) {
            , {{ d.counts.otherStrategy }} из журналов других стратегий на этом счёте
          }
          ; целых снимков {{ d.counts.snapshotsComplete }}. Знаменатель:
          {{ d.settings.initialCapital ? money(d.settings.initialCapital) : 'не задан' }}.
        </span>
      </mat-card>

      <div class="stack">
        <app-yv1-equity-chart [curve]="d.curve" [backtest]="d.backtest" />
        <app-yv1-cycles-table [cycles]="d.cycles" />
        <app-yv1-costs [data]="d" />
        <app-yv1-discrepancies [discrepancies]="d.discrepancies" />
        <app-yv1-bridge-status [bridge]="d.bridge" />
      </div>
    } @else {
      <p>Загрузка…</p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        overflow-y: auto;
      }
      .stack {
        display: grid;
        gap: 16px;
        margin-top: 16px;
      }
      .verdict {
        margin-top: 12px;
        padding: 12px 16px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px 16px;
        align-items: center;
      }
      .muted {
        color: var(--app-text-muted);
        font-size: 13px;
      }
      .spacer {
        flex: 1;
      }
      .danger {
        color: var(--app-danger);
      }
      .error {
        color: var(--app-danger);
        width: 100%;
        margin: 4px 0 0;
      }
    `,
  ],
})
export class StrategyPage {
  protected readonly api = inject(StrategyApi);
  private readonly confirm = inject(ConfirmService);
  private readonly router = inject(Router);
  private readonly strategies = inject(StrategyListApi).list;

  /** id торговой системы из маршрута */
  readonly systemId = input.required<string>();

  protected readonly overview = this.api.overview(this.systemId);
  protected readonly strategy = computed(
    () => (this.strategies.hasValue() ? this.strategies.value().find((s) => s.systemId === this.systemId()) : undefined) ?? null,
  );
  protected readonly title = computed(() => this.strategy()?.name ?? 'Стратегия');
  protected readonly data = computed(() => (this.overview.hasValue() ? this.overview.value() : null));
  protected readonly money = (v: string): string => formatMoney(v);

  protected readonly verdictTone = computed<ChipTone>(() => VERDICT_TONE[this.data()?.verdict.status ?? 'preliminary'] ?? 'neutral');
  protected readonly verdictLabel = computed(() => {
    switch (this.data()?.verdict.status) {
      case 'inside':
        return 'в коридоре';
      case 'outside':
        return 'вне коридора';
      case 'no-corridor':
        return 'коридор не задан';
      default:
        return 'предварительно';
    }
  });

  protected readonly removing = signal(false);
  protected readonly errorMessage = signal('');

  /**
   * Удаление необратимо: показываем, что пропадёт (журнал, дни результата в портфеле), и просим
   * подтверждение. Система и снимки моста остаются — систему можно удалить отдельно.
   */
  protected async remove(name: string): Promise<void> {
    const d = this.data();
    const confirmed = await this.confirm.ask({
      title: `Удалить стратегию «${name}»?`,
      message:
        `Будут удалены журнал сделок автомата (${d?.counts.yv1 ?? 0} сделок), настройки и результат стратегии в портфеле. ` +
        'Торговая система, снимки моста и файлы источника не затрагиваются. Действие необратимо.',
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!confirmed) return;
    this.errorMessage.set('');
    this.removing.set(true);
    try {
      await this.api.remove(this.systemId(), true);
      // сначала уходим со страницы удалённой стратегии, и только потом инвалидируем данные
      await this.router.navigate(['/strategies']);
      this.api.invalidateAfterRemoval();
    } catch (err) {
      this.errorMessage.set(extractErrorMessage(err, 'Не удалось удалить стратегию.'));
    } finally {
      this.removing.set(false);
    }
  }
}
