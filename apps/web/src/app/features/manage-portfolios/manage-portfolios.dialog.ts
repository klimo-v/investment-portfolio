import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { form, FormField, required } from '@angular/forms/signals';
import { ReferenceApi } from '../../entities/reference/reference.api';

/**
 * Диалог управления портфелями (docs/03-ux-plan.md §«Справочники»): создание и
 * удаление брокерских счетов. Удаление отклоняется бэкендом, если на портфель
 * уже ссылаются операции — ошибка сервера показывается пользователю как есть.
 */
@Component({
  selector: 'app-manage-portfolios-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatListModule,
    MatFormFieldModule,
    MatInputModule,
    FormField,
  ],
  template: `
    <h2 mat-dialog-title>Портфели</h2>
    <mat-dialog-content>
      <mat-nav-list class="list">
        @for (p of portfolios(); track p.id) {
          <mat-list-item>
            <span matListItemTitle>{{ p.name }}</span>
            <span matListItemLine>
              {{ p.broker }} · {{ p.baseCurrency }}
              @if (p.accountRef) {
                · счёт отчёта: {{ p.accountRef }}
              }
            </span>
            <button
              mat-icon-button
              matListItemMeta
              [disabled]="deletingId() === p.id"
              (click)="remove(p.id)"
              aria-label="Удалить портфель"
            >
              <mat-icon>delete</mat-icon>
            </button>
          </mat-list-item>
        } @empty {
          <p class="empty">Портфелей пока нет.</p>
        }
      </mat-nav-list>

      @if (errorMessage()) {
        <p class="error">{{ errorMessage() }}</p>
      }

      <form class="add-form">
        <mat-form-field appearance="outline">
          <mat-label>Название</mat-label>
          <input matInput [formField]="addForm.name" />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Брокер</mat-label>
          <input matInput [formField]="addForm.broker" />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Валюта</mat-label>
          <input matInput [formField]="addForm.baseCurrency" />
        </mat-form-field>
        <button
          mat-stroked-button
          type="button"
          [disabled]="addForm().invalid() || saving()"
          (click)="add()"
        >
          <mat-icon>add</mat-icon>
          Добавить
        </button>
      </form>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="close()">Закрыть</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .list {
        min-width: 420px;
        max-height: 320px;
        overflow-y: auto;
      }
      .add-form {
        display: flex;
        gap: 8px;
        align-items: start;
        margin-top: 16px;
      }
      .add-form mat-form-field {
        flex: 1;
      }
      .error {
        color: #c62828;
        margin: 8px 0 0;
      }
      .empty {
        color: rgba(0, 0, 0, 0.6);
        padding: 8px 0;
      }
    `,
  ],
})
export class ManagePortfoliosDialog {
  private readonly dialogRef = inject(MatDialogRef<ManagePortfoliosDialog>);
  private readonly referenceApi = inject(ReferenceApi);

  protected readonly portfolios = computed(() => this.referenceApi.portfolios.value() ?? []);

  protected readonly saving = signal(false);
  protected readonly deletingId = signal<string | null>(null);
  protected readonly errorMessage = signal('');

  private readonly model = signal({ name: '', broker: '', baseCurrency: 'RUB' });
  protected readonly addForm = form(this.model, (path) => {
    required(path.name, { message: 'Укажите название' });
    required(path.broker, { message: 'Укажите брокера' });
    required(path.baseCurrency, { message: 'Укажите валюту' });
  });

  protected close(): void {
    this.dialogRef.close();
  }

  protected async add(): Promise<void> {
    this.errorMessage.set('');
    this.saving.set(true);
    try {
      const m = this.model();
      await this.referenceApi.createPortfolio({
        name: m.name,
        broker: m.broker,
        baseCurrency: m.baseCurrency,
      });
      this.model.set({ name: '', broker: '', baseCurrency: 'RUB' });
    } catch {
      this.errorMessage.set('Не удалось создать портфель. Проверьте поля.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(id: string): Promise<void> {
    if (!confirm('Удалить этот портфель?')) return;
    this.errorMessage.set('');
    this.deletingId.set(id);
    try {
      await this.referenceApi.deletePortfolio(id);
    } catch (err) {
      this.errorMessage.set(extractErrorMessage(err));
    } finally {
      this.deletingId.set(null);
    }
  }
}

/** Достаём сообщение об ошибке из HttpErrorResponse (Nest BadRequestException) */
function extractErrorMessage(err: unknown): string {
  if (
    err &&
    typeof err === 'object' &&
    'error' in err &&
    err.error &&
    typeof err.error === 'object' &&
    'message' in err.error &&
    typeof err.error.message === 'string'
  ) {
    return err.error.message;
  }
  return 'Не удалось удалить портфель.';
}
