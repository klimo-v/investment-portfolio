import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import type { InstrumentType } from '@core';
import { ReferenceApi } from '../../entities/reference/reference.api';

export interface MergeInstrumentData {
  sourceId: string;
  sourceTicker: string;
  type: InstrumentType;
}

export interface MergeInstrumentResult {
  targetId: string;
}

/**
 * Диалог слияния дубль-инструмента (docs: TMON@/TMON, TCS00A10B4K3/RU000A10B4K3) —
 * брокерский импорт иногда заводит два справочных инструмента на один реальный
 * актив под разными кодами (тикер/ISIN/имя при этом могут не совпадать вовсе),
 * и надёжного автоматического признака дубля нет — распознаёт и подтверждает
 * пользователь. Слияние переносит операции source на target и удаляет source.
 *
 * Список целей — только инструменты ТОГО ЖЕ типа (иначе смысла в слиянии нет —
 * это разные классы активов), кроме самого source.
 */
@Component({
  selector: 'app-merge-instrument-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatButtonModule, MatFormFieldModule, MatSelectModule],
  template: `
    <h2 mat-dialog-title>Объединить «{{ data.sourceTicker }}» с другим инструментом</h2>
    <mat-dialog-content>
      <p class="muted">
        Все операции «{{ data.sourceTicker }}» перейдут на выбранный инструмент, а
        «{{ data.sourceTicker }}» будет удалён из справочника. Действие необратимо.
      </p>
      <p class="warn-note">
        Графики динамики на дашборде пересчитаются из журнала сами; история цен слитого
        инструмента перейдёт к выбранному.
      </p>

      <mat-form-field appearance="outline">
        <mat-label>Слить в</mat-label>
        <mat-select [value]="targetId()" (valueChange)="targetId.set($event)">
          @for (i of targets(); track i.id) {
            <mat-option [value]="i.id">
              {{ i.ticker }}{{ i.name ? ' — ' + i.name : '' }}
            </mat-option>
          }
        </mat-select>
      </mat-form-field>

      @if (targets().length === 0) {
        <p class="muted">Нет других инструментов того же типа, с которыми можно объединить.</p>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()">Отмена</button>
      <button mat-flat-button color="warn" [disabled]="!targetId()" (click)="apply()">
        Объединить
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      mat-dialog-content {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 360px;
      }
      .muted {
        margin: 0 0 8px;
        color: var(--app-text-muted);
      }
      .warn-note {
        margin: 0 0 8px;
        padding: 8px;
        border-radius: 4px;
        background: color-mix(in srgb, var(--app-warn) 12%, transparent);
        color: var(--app-warn);
        font-size: 0.85em;
      }
    `,
  ],
})
export class MergeInstrumentDialog {
  private readonly dialogRef = inject(MatDialogRef<MergeInstrumentDialog, MergeInstrumentResult>);
  protected readonly data = inject<MergeInstrumentData>(MAT_DIALOG_DATA);
  private readonly reference = inject(ReferenceApi);

  protected readonly targetId = signal<string | undefined>(undefined);

  protected readonly targets = computed(() =>
    (this.reference.instruments.value() ?? []).filter(
      (i) => i.id !== this.data.sourceId && i.type === this.data.type,
    ),
  );

  protected cancel(): void {
    this.dialogRef.close();
  }

  protected apply(): void {
    const targetId = this.targetId();
    if (!targetId) return;
    this.dialogRef.close({ targetId });
  }
}
