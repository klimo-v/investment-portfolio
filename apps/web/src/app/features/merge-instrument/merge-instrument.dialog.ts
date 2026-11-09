import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatCheckboxModule } from '@angular/material/checkbox';
import type { InstrumentType } from '@core';
import { ReferenceApi } from '../../entities/reference/reference.api';

export interface MergeInstrumentData {
  sourceId: string;
  sourceTicker: string;
  type: InstrumentType;
  /** Предложенная цель слияния (из списка «Возможные дубли») — подставляется в выбор */
  suggestedTargetId?: string;
}

export interface MergeInstrumentResult {
  targetId: string;
  /** пользователь явно подтвердил предупреждения проверок слияния */
  confirmWarnings: boolean;
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
  imports: [MatDialogModule, MatButtonModule, MatFormFieldModule, MatSelectModule, MatCheckboxModule],
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

      @if (preview.value(); as p) {
        <p class="muted">
          Перейдёт: операций — {{ p.consequences.operations }}, кодов — {{ p.consequences.codes }}, цен —
          {{ p.consequences.prices }}{{ p.consequences.pricesDiscarded ? ' (' + p.consequences.pricesDiscarded + ' цен в другой валюте будут отброшены)' : '' }}.
        </p>
        @for (b of p.blockers; track b.code) {
          <p class="blocker">Запрещено: {{ b.message }}</p>
        }
        @for (w of p.warnings; track w.code) {
          <p class="warn-note">{{ w.message }}</p>
        }
        @if (p.warnings.length > 0 && p.blockers.length === 0) {
          <mat-checkbox [checked]="confirmed()" (change)="confirmed.set($event.checked)">
            Понимаю риск, это один и тот же актив
          </mat-checkbox>
        }
      }
      @if (preview.error()) {
        <p class="blocker">Не удалось проверить слияние.</p>
      }

      @if (targets().length === 0) {
        <p class="muted">Нет других инструментов того же типа, с которыми можно объединить.</p>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()">Отмена</button>
      <button mat-flat-button color="warn" [disabled]="!canApply()" (click)="apply()">
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
      .blocker {
        margin: 0 0 8px;
        padding: 8px;
        border-radius: 4px;
        background: color-mix(in srgb, var(--app-warn) 20%, transparent);
        color: var(--app-warn);
        font-weight: 500;
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

  protected readonly targetId = signal<string | undefined>(this.data.suggestedTargetId);

  protected readonly confirmed = signal(false);

  /** Предпросмотр проверок слияния для выбранной цели; смена цели сбрасывает подтверждение */
  protected readonly preview = resource({
    params: () => this.targetId(),
    loader: async ({ params }) => {
      this.confirmed.set(false);
      return params ? this.reference.mergePreview(this.data.sourceId, params) : undefined;
    },
  });

  /** Подтвердить можно, когда проверки загружены, блокировок нет, а предупреждения отмечены */
  protected readonly canApply = computed(() => {
    const p = this.preview.value();
    if (!this.targetId() || !p || this.preview.isLoading()) return false;
    return p.blockers.length === 0 && (p.warnings.length === 0 || this.confirmed());
  });

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
    if (!targetId || !this.canApply()) return;
    this.dialogRef.close({ targetId, confirmWarnings: this.confirmed() });
  }
}
