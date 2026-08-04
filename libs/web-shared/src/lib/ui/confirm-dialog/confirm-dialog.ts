import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';

export interface ConfirmData {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Необратимое действие — кнопка подтверждения краснеет */
  danger?: boolean;
}

/**
 * Диалог подтверждения вместо нативного `confirm()`.
 *
 * Нативный вызов был в трёх местах, включая массовое удаление операций с
 * трёхстрочным предупреждением о необратимости. Проблемы: он блокирует поток,
 * не стилизуется, выпадает из фокус-менеджмента приложения и в некоторых
 * браузерах подавляется вместе с остальными модалками страницы.
 *
 * Открывается через ConfirmService — компонент напрямую дёргать не нужно.
 */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      <p class="message">{{ data.message }}</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" (click)="close(false)">
        {{ data.cancelLabel ?? 'Отмена' }}
      </button>
      <button
        mat-flat-button
        type="button"
        cdkFocusInitial
        [class.danger]="data.danger"
        (click)="close(true)"
      >
        {{ data.confirmLabel ?? 'Подтвердить' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .message {
        margin: 0;
        max-width: 46ch;
        white-space: pre-line;
      }
      .danger {
        background: var(--app-danger);
        color: var(--mat-sys-on-error);
      }
    `,
  ],
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmData>(MAT_DIALOG_DATA);
  private readonly dialogRef = inject(MatDialogRef<ConfirmDialog, boolean>);

  protected close(result: boolean): void {
    this.dialogRef.close(result);
  }
}
