import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { form, FormField, required } from '@angular/forms/signals';
import { extractErrorMessage } from '@web-shared';
import { ReferenceApi } from '../../entities/reference/reference.api';

/**
 * Диалог управления системами/стратегиями (docs/03-ux-plan.md §«Справочники»):
 * создание и удаление. Удаление отклоняется бэкендом, если на систему уже
 * ссылаются операции — ошибка сервера показывается пользователю как есть.
 */
@Component({
  selector: 'app-manage-systems-dialog',
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
    <h2 mat-dialog-title>Системы</h2>
    <mat-dialog-content>
      <mat-nav-list class="list">
        @for (s of systems(); track s.id) {
          <mat-list-item>
            <span matListItemTitle>{{ s.name }}</span>
            @if (s.description) {
              <span matListItemLine>{{ s.description }}</span>
            }
            <button
              mat-icon-button
              matListItemMeta
              [disabled]="deletingId() === s.id"
              (click)="remove(s.id)"
              aria-label="Удалить систему"
            >
              <mat-icon>delete</mat-icon>
            </button>
          </mat-list-item>
        } @empty {
          <p class="empty">Систем пока нет.</p>
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
        min-width: 100%;
        max-height: 560px;
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
export class ManageSystemsDialog {
  private readonly dialogRef = inject(MatDialogRef<ManageSystemsDialog>);
  private readonly referenceApi = inject(ReferenceApi);

  protected readonly systems = computed(() => this.referenceApi.systems.value() ?? []);

  protected readonly saving = signal(false);
  protected readonly deletingId = signal<string | null>(null);
  protected readonly errorMessage = signal('');

  private readonly model = signal({ name: '' });
  protected readonly addForm = form(this.model, (path) => {
    required(path.name, { message: 'Укажите название' });
  });

  protected close(): void {
    this.dialogRef.close();
  }

  protected async add(): Promise<void> {
    this.errorMessage.set('');
    this.saving.set(true);
    try {
      const m = this.model();
      await this.referenceApi.createSystem({ name: m.name });
      this.model.set({ name: '' });
    } catch {
      this.errorMessage.set('Не удалось создать систему. Проверьте поля.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(id: string): Promise<void> {
    if (!confirm('Удалить эту систему?')) return;
    this.errorMessage.set('');
    this.deletingId.set(id);
    try {
      await this.referenceApi.deleteSystem(id);
    } catch (err) {
      this.errorMessage.set(extractErrorMessage(err, 'Не удалось удалить систему.'));
    } finally {
      this.deletingId.set(null);
    }
  }
}
