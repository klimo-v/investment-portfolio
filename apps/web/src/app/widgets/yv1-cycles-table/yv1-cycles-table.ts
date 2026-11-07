import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import type { Yv1CycleView } from '@core';
import { formatMoney, formatPercentOrDash, pnlColorClass, StateMessage, StatusChip } from '@web-shared';

const FLAG_LABEL: Record<string, string> = {
  'fees-incomplete': 'нет части биржевых сборов',
  'slippage-partial': 'проскальзывание не по всем сделкам',
  'not-closed': 'цикл не закрыт',
};

/**
 * Циклы ТС: вход по половинам (h1 13:00, h2 15:00) → выход следующего торгового дня.
 * Результат по цене точен по сделкам; net = результат − комиссии (брокер по тарифу
 * 0.015 %, биржа и клиринг из QUIK) − модель процентов по долгу. «К начальному» и «к
 * текущему» — два знаменателя: капитал на старте и капитал на момент входа цикла.
 */
@Component({
  selector: 'app-yv1-cycles-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatButtonModule, MatIconModule, StateMessage, StatusChip],
  template: `
    <mat-card>
      <h3>Циклы</h3>
      @if (cycles().length === 0) {
        <app-state-message
          kind="empty"
          icon="swap_vert"
          title="Циклов нет"
          hint="Цикл появится, когда в журнале автомата или в снимке моста будут сделки ТС."
        />
      } @else {
        <div class="table-scroll">
          <table class="yv1-table">
            <thead>
              <tr>
                <th></th>
                <th>Вход → выход</th>
                <th>Напр.</th>
                <th>Контракт</th>
                <th class="num">Контр.</th>
                <th class="num">Цена вх. / вых.</th>
                <th class="num">По цене, ₽</th>
                <th class="num">Издержки, ₽</th>
                <th class="num">Долг, ₽</th>
                <th class="num">Net, ₽</th>
                <th class="num">% к начальному</th>
                <th class="num">% к текущему</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              @for (c of cycles(); track c.id) {
                <tr>
                  <td>
                    <button
                      mat-icon-button
                      type="button"
                      [attr.aria-expanded]="expanded() === c.id"
                      [attr.aria-label]="'Сделки цикла ' + c.id"
                      (click)="toggle(c.id)"
                    >
                      <mat-icon>{{ expanded() === c.id ? 'expand_less' : 'expand_more' }}</mat-icon>
                    </button>
                  </td>
                  <td>{{ c.openDate }} → {{ c.closeDate ?? '…' }}</td>
                  <td>{{ direction(c.direction) }}</td>
                  <td>{{ c.contracts.join(', ') }}</td>
                  <td class="num">{{ c.entryQty }}</td>
                  <td class="num">{{ price(c.avgEntryPrice) }} / {{ price(c.avgExitPrice) }}</td>
                  <td class="num" [class]="cls(c.pnlPrice)">{{ money(c.pnlPrice) }}</td>
                  <td class="num">{{ money(c.costs.total) }}</td>
                  <td class="num">{{ money(c.debtInterest) }}</td>
                  <td class="num" [class]="cls(c.netRub)">{{ money(c.netRub) }}</td>
                  <td class="num">{{ pct(c.retInitialPct) }}</td>
                  <td class="num">{{ pct(c.retCurrentPct) }}</td>
                  <td>
                    <app-status-chip [tone]="c.status === 'closed' ? 'neutral' : 'info'">{{ status(c.status) }}</app-status-chip>
                    @for (f of c.flags; track f) {
                      <span class="flag" [title]="flag(f)">⚑</span>
                    }
                  </td>
                </tr>
                @if (expanded() === c.id) {
                  <tr class="legs">
                    <td></td>
                    <td colspan="12">
                      <table class="yv1-table">
                        <thead>
                          <tr>
                            <th>Сделка</th>
                            <th>Время (МСК)</th>
                            <th>Роль</th>
                            <th>Сторона</th>
                            <th class="num">Контр.</th>
                            <th class="num">Цена</th>
                            <th>Контракт</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (l of c.legs; track l.tradeNum + l.role) {
                            <tr>
                              <td>{{ l.tradeNum }}</td>
                              <td>{{ l.date }} {{ l.time }}</td>
                              <td>{{ l.role === 'entry' ? 'вход ' + (l.reason ?? '') : 'выход' }}</td>
                              <td>{{ l.side === 'B' ? 'покупка' : 'продажа' }}</td>
                              <td class="num">{{ l.qty }}@if (l.qty !== l.fillQty) { из {{ l.fillQty }} }</td>
                              <td class="num">{{ l.price }}</td>
                              <td>{{ l.contract }}</td>
                            </tr>
                          }
                        </tbody>
                      </table>
                      <p class="detail">
                        Комиссии: брокер (тариф) {{ money(c.costs.brokerModel) }}, оценка QUIK {{ money(c.costs.brokerQuik) }},
                        биржа {{ money(c.costs.exchange) }}, клиринг {{ money(c.costs.clearing) }}.
                        Проскальзывание входа: {{ slip(c.slipEntryRub) }}; выхода: {{ slip(c.slipExitRub) }}.
                        @for (f of c.flags; track f) {
                          <br />⚑ {{ flag(f) }}
                        }
                      </p>
                    </td>
                  </tr>
                }
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
      .flag {
        margin-left: 4px;
        color: var(--app-chip-warn-fg);
        cursor: help;
      }
      .detail {
        margin: 8px 0 0;
        font-size: 12px;
        color: var(--app-text-muted);
        white-space: normal;
      }
    `,
  ],
})
export class Yv1CyclesTable {
  readonly cycles = input.required<readonly Yv1CycleView[]>();
  protected readonly expanded = signal<string | null>(null);

  protected readonly money = (v: string): string => formatMoney(v);
  protected readonly pct = formatPercentOrDash;
  protected readonly cls = pnlColorClass;

  protected toggle(id: string): void {
    this.expanded.update((cur) => (cur === id ? null : id));
  }
  protected direction(d: Yv1CycleView['direction']): string {
    return d === 'long' ? 'лонг' : d === 'short' ? 'шорт' : 'смешан.';
  }
  protected status(s: Yv1CycleView['status']): string {
    return s === 'closed' ? 'закрыт' : s === 'open' ? 'открыт' : 'частично';
  }
  protected price(v: string | null): string {
    return v === null ? '—' : Number(v).toFixed(3);
  }
  protected slip(v: string | null): string {
    return v === null ? 'нет данных' : formatMoney(v);
  }
  protected flag(f: string): string {
    return FLAG_LABEL[f] ?? f;
  }
}
