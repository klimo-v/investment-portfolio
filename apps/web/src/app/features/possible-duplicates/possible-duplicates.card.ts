import { StateMessage } from '@web-shared';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import type { InstrumentType } from '@core';
import { ReferenceApi, type PossibleDuplicate } from '../../entities/reference/reference.api';
import { MergeInstrumentDialog } from '../merge-instrument/merge-instrument.dialog';

/**
 * Список «Возможные дубли» справочника инструментов. Пары находят те же эвристики,
 * что и подсказки в предпросмотре импорта (libs/core: findPossibleDuplicates), — это
 * подсказка, а не решение: слияние необратимо и подтверждается в диалоге.
 * Нужен потому, что синк с Т-Банком не имеет предпросмотра и может завести дубль
 * (TMON@ рядом с TMON, TCS00… рядом с RU000…), а искать их глазами неудобно.
 */
@Component({
  selector: 'app-possible-duplicates',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StateMessage, MatCardModule, MatButtonModule],
  template: `
    @if (reference.possibleDuplicates.error()) {
      <app-state-message
        kind="error"
        title="Не удалось загрузить возможные дубли"
        retryLabel="Повторить"
        (retry)="reference.possibleDuplicates.reload()"
      />
    }

    @if (duplicates().length > 0) {
      <mat-card class="duplicates">
        <h2 class="title">Возможные дубли инструментов</h2>
        <p class="hint">
          Похожие инструменты в справочнике. Это подсказка: если это один и тот же актив, объедините
          — операции и цены перейдут на выбранный, а выбор запомнится, и при повторном импорте дубль
          не вернётся.
        </p>
        @for (d of duplicates(); track d.sourceId + d.targetId) {
          <div class="row">
            <span class="pair">
              <b>{{ d.sourceTicker }}</b> → <b>{{ d.targetTicker }}</b>
              @if (d.sourceName || d.targetName) {
                <span class="muted">({{ d.sourceName ?? '—' }} / {{ d.targetName ?? '—' }})</span>
              }
            </span>
            <span class="muted reason">{{ d.reason }}</span>
            <button mat-stroked-button (click)="merge(d)">Слить…</button>
          </div>
        }
      </mat-card>
    }
  `,
  styles: [
    `
      .duplicates {
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
      .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
        padding: 4px 0;
      }
      .pair {
        min-width: 220px;
      }
      .reason {
        flex: 1;
      }
    `,
  ],
})
export class PossibleDuplicatesCard {
  protected readonly reference = inject(ReferenceApi);
  private readonly dialog = inject(MatDialog);

  protected readonly duplicates = computed(() =>
    this.reference.possibleDuplicates.hasValue() ? this.reference.possibleDuplicates.value() : [],
  );

  /** Диалог слияния с уже выбранной целью; подтверждение — необратимое действие */
  protected async merge(d: PossibleDuplicate): Promise<void> {
    const ref = this.dialog.open(MergeInstrumentDialog, {
      autoFocus: false,
      data: {
        sourceId: d.sourceId,
        sourceTicker: d.sourceTicker,
        type: d.type as InstrumentType,
        suggestedTargetId: d.targetId,
      },
    });
    const result = await firstValueFrom(ref.afterClosed());
    if (!result) return;
    await this.reference.mergeInstruments(d.sourceId, result.targetId, result.confirmWarnings);
  }
}
