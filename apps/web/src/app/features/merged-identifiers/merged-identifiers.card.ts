import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { DatePipe } from '@angular/common';
import { ReferenceApi } from '../../entities/reference/reference.api';

const SCHEME_LABEL: Record<string, string> = {
  ticker: 'тикер',
  isin: 'ISIN',
  figi: 'figi',
  tbank_uid: 'tbank_uid',
  broker_code: 'код брокера',
  name: 'название',
};

/**
 * «Привязанные коды»: инструменты, к которым слиянием присоединены чужие коды. Только чтение.
 * Слияние необратимо и раньше нигде не показывалось — ошибочное (юань в золото) оставалось
 * незамеченным, пока оценка не выросла до миллионов. Пометка срабатывает, когда у инструмента
 * больше одного биржевого тикера (libs/core: identityConflicts).
 * Дата — «код добавлен», а не дата слияния: слияние created_at не обновляет, дату слияния даст журнал.
 */
@Component({
  selector: 'app-merged-identifiers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, DatePipe],
  template: `
    @if (items().length > 0) {
      <mat-card class="merged">
        <h2 class="title">Привязанные коды</h2>
        <p class="hint">
          Инструменты, к которым при слиянии присоединены другие коды. Дата — когда код добавлен,
          а не когда выполнено слияние.
        </p>
        @for (i of items(); track i.instrumentId) {
          <div class="instrument">
            <div class="head">
              <b>{{ i.ticker }}</b>
              @if (i.name) {
                <span class="muted">{{ i.name }}</span>
              }
              @if (i.conflicting) {
                <span class="warn">
                  Подозрительное слияние: несколько тикеров — {{ i.tickers.join(', ') }}
                </span>
              }
            </div>
            @for (e of i.entries; track e.scheme + e.value) {
              <div class="code" [class.merged-code]="e.origin === 'merge'">
                <span class="scheme">{{ label(e.scheme) }}</span>
                <span class="value">{{ e.value }}</span>
                <span class="muted">
                  {{ e.origin === 'merge' ? 'слит' : e.origin === 'manual' ? 'вручную' : 'импорт' }},
                  код добавлен {{ e.createdAt.replace(' ', 'T') | date: 'dd.MM.yyyy HH:mm' }}
                </span>
              </div>
            }
          </div>
        }
      </mat-card>
    }
  `,
  styles: [
    `
      .merged {
        padding: 16px;
        margin-bottom: 16px;
      }
      .title {
        margin: 0 0 4px;
        font-size: 1rem;
      }
      .hint,
      .muted {
        color: var(--app-text-muted);
        font-size: 0.85em;
      }
      .hint {
        margin: 0 0 8px;
      }
      .instrument {
        padding: 6px 0;
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: baseline;
      }
      .warn {
        color: var(--mat-sys-error, #b3261e);
        font-weight: 500;
      }
      .code {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        padding-left: 12px;
      }
      .scheme {
        min-width: 90px;
        color: var(--app-text-muted);
      }
      .value {
        font-family: monospace;
        min-width: 200px;
      }
      .merged-code .value {
        font-weight: 500;
      }
    `,
  ],
})
export class MergedIdentifiersCard {
  private readonly reference = inject(ReferenceApi);
  protected readonly items = computed(() => this.reference.mergedIdentifiers.value() ?? []);
  protected label(scheme: string): string {
    return SCHEME_LABEL[scheme] ?? scheme;
  }
}
