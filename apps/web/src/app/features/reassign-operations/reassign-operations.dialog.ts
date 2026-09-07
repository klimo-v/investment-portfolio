import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { ReferenceApi } from '../../entities/reference/reference.api';

export interface ReassignOperationsData {
  count: number;
}

export interface ReassignOperationsResult {
  systemId?: string;
  portfolioId?: string;
}

/**
 * Диалог массового переназначения выбранных операций на другую систему и/или
 * портфель (docs/04-roadmap.md §3.1): один отчёт брокера может содержать сделки
 * разных систем и лежащие на разных счетах (обычный ↔ ИИС) — импорт размечает
 * их батчем «на глаз», здесь — точечная корректировка после загрузки.
 * Оба поля необязательны, но хотя бы одно должно быть выбрано.
 */
@Component({
  selector: 'app-reassign-operations-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatButtonModule, MatFormFieldModule, MatSelectModule],
  template: `
    <h2 mat-dialog-title>Назначить систему/портфель</h2>
    <mat-dialog-content>
      <p class="muted">Операций выбрано: {{ data.count }}. Незаполненное поле не меняется.</p>
      <p class="warn-note">
        Переназначение задним числом делает недостоверными уже снятые снимки портфеля
        (просадка и график динамики на дашборде). Историю не стираем — на дашборде
        загорится предупреждение с таблицей изменений.
      </p>

      <mat-form-field appearance="outline">
        <mat-label>Система</mat-label>
        <mat-select [value]="systemId()" (valueChange)="systemId.set($event)">
          <mat-option [value]="undefined">— не менять —</mat-option>
          @for (s of reference.systems.value() ?? []; track s.id) {
            <mat-option [value]="s.id">{{ s.name }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-form-field appearance="outline">
        <mat-label>Портфель</mat-label>
        <mat-select [value]="portfolioId()" (valueChange)="portfolioId.set($event)">
          <mat-option [value]="undefined">— не менять —</mat-option>
          @for (p of reference.portfolios.value() ?? []; track p.id) {
            <mat-option [value]="p.id">{{ p.name }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()">Отмена</button>
      <button mat-flat-button color="primary" [disabled]="!canApply()" (click)="apply()">
        Применить
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      mat-dialog-content {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 320px;
      }
      /* .muted, а не .hint: имя .hint зарезервировано под бейдж-подсказку «?» */
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
export class ReassignOperationsDialog {
  private readonly dialogRef = inject(MatDialogRef<ReassignOperationsDialog, ReassignOperationsResult>);
  protected readonly data = inject<ReassignOperationsData>(MAT_DIALOG_DATA);
  protected readonly reference = inject(ReferenceApi);

  protected readonly systemId = signal<string | undefined>(undefined);
  protected readonly portfolioId = signal<string | undefined>(undefined);

  protected readonly canApply = computed(() => !!this.systemId() || !!this.portfolioId());

  protected cancel(): void {
    this.dialogRef.close();
  }

  protected apply(): void {
    this.dialogRef.close({ systemId: this.systemId(), portfolioId: this.portfolioId() });
  }
}
