import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { DatePipe } from '@angular/common';
import { ReferenceApi, type InstrumentIdentifiers } from '../../entities/reference/reference.api';
import { SplitInstrumentDialog } from '../../features/split-instrument/split-instrument.dialog';

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
  selector: 'app-merged-identifiers-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatButtonModule, DatePipe],
  template: `
    <h2 mat-dialog-title>Привязанные коды</h2>
    <mat-dialog-content>
      <p class="hint">
        Инструменты, к которым при слиянии присоединены другие коды. У слияний из журнала указаны источник и дата;
        дата у кода — когда код добавлен, а не когда выполнено слияние.
      </p>
      @for (i of items(); track i.instrumentId) {
        <div class="instrument">
          <div class="head">
            <b>{{ i.ticker }}</b>
            @if (i.name) {
              <span class="muted">{{ i.name }}</span>
            }
            @if (i.conflicting) {
              <span class="warn">Подозрительное слияние: несколько тикеров — {{ i.tickers.join(', ') }}</span>
            }
          </div>
          @for (m of i.merges; track m.id) {
            <div class="journal">
              Слито из <b>{{ m.sourceTicker }}</b
              >{{ m.sourceName ? ' (' + m.sourceName + ')' : '' }},
              {{ utc(m.at) | date: 'dd.MM.yyyy HH:mm' }}{{ m.undone ? ' — отменено' : '' }}
              @if (!m.undone && m.targetId === i.instrumentId) {
                <button mat-stroked-button (click)="undoMerge(i, m.id)">Отменить слияние…</button>
              } @else if (!m.undone) {
                <span class="muted">(слияние в промежуточный инструмент — отменяется в обратном порядке)</span>
              }
            </div>
          }
          @if (i.merges.length === 0) {
            <div class="journal muted">
              Слито до включения журнала: дата и источник неизвестны.
              <button mat-stroked-button (click)="splitManually(i)">Выделить инструмент заново…</button>
            </div>
          }
          @for (e of i.entries; track e.scheme + e.value) {
            <div class="code" [class.merged-code]="e.origin === 'merge'">
              <span class="scheme">{{ label(e.scheme) }}</span>
              <span class="value">{{ e.value }}</span>
              <span class="muted">
                {{ e.origin === 'merge' ? 'слит' : e.origin === 'manual' ? 'вручную' : 'импорт' }},
                код добавлен {{ utc(e.createdAt) | date: 'dd.MM.yyyy HH:mm' }}
              </span>
            </div>
          }
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Закрыть</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      mat-dialog-content {
        min-width: min(720px, 80vw);
        max-height: 70vh;
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
      .journal {
        padding-left: 12px;
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
export class MergedIdentifiersDialog {
  private readonly reference = inject(ReferenceApi);
  protected readonly items = computed(() => this.reference.mergedIdentifiers.value() ?? []);
  private readonly dialog = inject(MatDialog);

  /** Откат слияния из журнала: тот же диалог разделения с планом по снимку */
  protected undoMerge(i: InstrumentIdentifiers, mergeId: string): void {
    this.dialog.open(SplitInstrumentDialog, { autoFocus: false, data: { instrumentId: i.instrumentId, ticker: i.ticker, mergeId } });
  }

  /** Слияние без записи в журнале: операции и коды выбирает пользователь */
  protected splitManually(i: InstrumentIdentifiers): void {
    this.dialog.open(SplitInstrumentDialog, { autoFocus: false, data: { instrumentId: i.instrumentId, ticker: i.ticker } });
  }

  /** Время из БД — UTC без зоны (`datetime('now')`): помечаем зону, иначе браузер прочтёт его как локальное */
  protected utc(dbTime: string): string {
    return dbTime.replace(' ', 'T') + 'Z';
  }

  protected label(scheme: string): string {
    return SCHEME_LABEL[scheme] ?? scheme;
  }
}
