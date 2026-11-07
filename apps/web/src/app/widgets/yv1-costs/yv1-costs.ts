import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { Yv1Overview } from '@core';
import { formatMoney, formatPercentOrDash, pnlColorClass, StatusChip } from '@web-shared';

/**
 * Месяцы, текущая позиция, издержки и проскальзывание, тест полноты. Всё, что отвечает
 * на вопрос «из чего складывается результат и сходится ли учёт с QUIK».
 */
@Component({
  selector: 'app-yv1-costs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, StatusChip],
  template: `
    <div class="grid">
      <mat-card>
        <h3>Итоги по месяцам</h3>
        @if (data().months.length === 0) {
          <p class="muted">Закрытых циклов пока нет.</p>
        } @else {
          <table class="yv1-table">
            <thead>
              <tr>
                <th>Месяц</th>
                <th class="num">Циклов</th>
                <th class="num">В плюс</th>
                <th class="num">Net, ₽</th>
                <th class="num">Издержки, ₽</th>
                <th class="num">% к нач.</th>
              </tr>
            </thead>
            <tbody>
              @for (m of data().months; track m.month) {
                <tr>
                  <td>{{ m.month }}</td>
                  <td class="num">{{ m.cycles }}</td>
                  <td class="num">{{ m.wins }}</td>
                  <td class="num" [class]="cls(m.netRub)">{{ money(m.netRub) }}</td>
                  <td class="num">{{ money(m.feesRub) }}</td>
                  <td class="num">{{ pct(m.retInitialPct) }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </mat-card>

      <mat-card>
        <h3>Текущая позиция</h3>
        @if (data().position; as p) {
          <p>
            <b>{{ p.contract }}</b>: по снимку {{ p.bridgeNet ?? 'нет данных' }}, по журналу сделок {{ p.journalNet }} контр.
          </p>
          <p class="muted">
            на {{ p.asOf ?? '—' }}; LAST {{ p.lastPrice ?? '—' }}, расчётная {{ p.settlePrice ?? '—' }}
            @if (p.unrealizedRub !== null) {
              ; нереализовано (индикативно) {{ money(p.unrealizedRub) }}
            }
          </p>
        } @else {
          <p class="muted">Позиций нет.</p>
        }
        <h3>Вариационная маржа по дням</h3>
        <p class="muted">«Начислена» — снимок до клиринга, в рубли ещё не проведена; итоговой считается только после клиринга.</p>
        <table class="yv1-table">
          <tbody>
            @for (v of data().vmDays; track v.date + v.source) {
              <tr>
                <td>{{ v.date }}</td>
                <td>{{ v.source === 'bridge' ? 'мост' : 'автомат' }}</td>
                <td class="num" [class]="cls(v.valueRub)">{{ money(v.valueRub) }}</td>
                <td>{{ v.status === 'posted' ? 'проведена' : 'начислена' }}</td>
              </tr>
            }
          </tbody>
        </table>
      </mat-card>

      <mat-card>
        <h3>Издержки и проскальзывание</h3>
        <table class="yv1-table">
          <tbody>
            <tr><td>Брокер по тарифу 0.015 % (модель)</td><td class="num">{{ money(data().costs.brokerModel) }}</td></tr>
            <tr><td>Брокер — оценка QUIK (не списание)</td><td class="num">{{ money(data().costs.brokerQuik) }}</td></tr>
            <tr><td>Биржа</td><td class="num">{{ money(data().costs.exchange) }}</td></tr>
            <tr><td>Клиринг</td><td class="num">{{ money(data().costs.clearing) }}</td></tr>
            <tr><td><b>Итого вычитается</b></td><td class="num"><b>{{ money(data().costs.total) }}</b></td></tr>
            <tr>
              <td>QUIK / модель по брокеру</td>
              <td class="num">{{ data().costs.quikToModelRatio ?? '—' }}</td>
            </tr>
            <tr>
              <td>Вход: проскальзывание (против ref_price)</td>
              <td class="num">{{ slip(data().slippage.entryRub) }}</td>
            </tr>
            <tr>
              <td>Выход: проскальзывание (против open 10:20)</td>
              <td class="num">{{ slip(data().slippage.exitRub) }}</td>
            </tr>
          </tbody>
        </table>
        @if (!data().costs.complete) {
          <p class="muted">У части сделок нет биржевых сборов (автомат их не записал) — издержки занижены.</p>
        }
        @if (data().costs.calcTrades; as c) {
          <p class="muted">calc_trades: {{ c.rows }} строк, макс. расхождение брокерской части с моделью {{ c.maxBrokerDiff }} ₽.</p>
        }
      </mat-card>

      <mat-card>
        <h3>Тест полноты (рубли Т1 внутри дня)</h3>
        <p class="muted">Изменение рублей = комиссии QUIK по ТС + по сделкам других стратегий + по не распределённым + сделки фонда + проведённая ВМ. Невязка должна быть 0.</p>
        @for (w of data().completeness; track w.snapId) {
          <p>
            {{ w.snapId }} ({{ w.tradeDate }}):
            @if (!w.applicable) {
              <app-status-chip tone="neutral">не считается</app-status-chip> {{ w.note }}
            } @else {
              <app-status-chip [tone]="w.ok ? 'success' : 'danger'">{{ w.ok ? 'сходится' : 'невязка' }}</app-status-chip>
              Δ {{ money(w.delta ?? '0') }}, объяснено {{ money(w.explained ?? '0') }}, невязка {{ money(w.residual ?? '0') }}
            }
          </p>
        } @empty {
          <p class="muted">Нет целых снимков.</p>
        }
      </mat-card>
    </div>
  `,
  styles: [
    `
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
        gap: 16px;
      }
      mat-card {
        padding: 16px;
        overflow-x: auto;
      }
      h3 {
        margin: 12px 0 8px;
        font-weight: 500;
      }
      h3:first-child {
        margin-top: 0;
      }
      .muted {
        color: var(--app-text-muted);
        font-size: 13px;
      }
    `,
  ],
})
export class Yv1Costs {
  readonly data = input.required<Yv1Overview>();

  protected readonly money = (v: string): string => formatMoney(v);
  protected readonly pct = formatPercentOrDash;
  protected readonly cls = pnlColorClass;
  protected slip(v: string | null): string {
    return v === null ? 'нет данных' : formatMoney(v);
  }
}
