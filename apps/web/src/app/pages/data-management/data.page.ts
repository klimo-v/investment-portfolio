import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { RouterLink } from '@angular/router';

const Preview = z.object({
  id: z.string(),
  accounts: z.number(),
  operations: z.number(),
  systems: z.number(),
});
type Preview = z.infer<typeof Preview>;

@Component({
  selector: 'app-data-confirm',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatButtonModule, MatInputModule, MatFormFieldModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      <p>{{ data.message }}</p>
      @if (data.clear) {
        <p>Для отдельного подтверждения введите УДАЛИТЬ.</p>
        <mat-form-field
          ><mat-label>Подтверждение удаления</mat-label>
          <input
            matInput
            (input)="confirmation.set($any($event.target).value)"
            autocomplete="off"
          />
        </mat-form-field>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button [mat-dialog-close]="false">Отмена</button>
      <button
        mat-flat-button
        [disabled]="data.clear && confirmation() !== 'УДАЛИТЬ'"
        [mat-dialog-close]="true"
      >
        {{ data.clear ? 'Удалить все данные' : 'Заменить текущие данные' }}
      </button>
    </mat-dialog-actions>
  `,
})
export class DataConfirmDialog {
  protected readonly data = inject<{ title: string; message: string; clear?: boolean }>(
    MAT_DIALOG_DATA,
  );
  protected readonly confirmation = signal('');
}

@Component({
  selector: 'app-data-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, RouterLink],
  template: `
    <h1>Данные</h1>
    <section>
      <h2>Скачать резервную копию</h2>
      <p>
        Один файл SQLite содержит весь портфель, операции, справочники, котировки и историю
        миграций. Финансовые данные в файле доступны в читаемом виде, без шифрования. Храните его в
        безопасном месте.
      </p>
      <p>
        Токен T-Invest, настройки Mac и браузера, исходные файлы отчётов с диска в копию не входят.
      </p>
      <p>
        Выберите папку в окне сохранения браузера, в том числе папку облачного диска. Если браузер
        сохраняет автоматически, включите запрос места сохранения в его настройках.
      </p>
      <a mat-flat-button href="/api/data/backup" download>Скачать резервную копию</a>
    </section>
    <section>
      <h2>Восстановить из файла</h2>
      <p>
        Текущие данные будут заменены целиком после проверки файла и вашего подтверждения.
        Максимальный размер — 512 МиБ. Проверенная копия доступна для подтверждения 15 минут.
      </p>
      <input
        #file
        type="file"
        accept=".sqlite,.db,application/octet-stream"
        hidden
        (change)="selectFile(file)"
      />
      <button mat-stroked-button [disabled]="busy()" (click)="file.click()">Выбрать файл</button>
    </section>
    <section>
      <h2>Удалить все данные портфеля</h2>
      <p>
        Будут удалены все счета, системы, инструменты, операции, история импорта, цены и прочие
        данные базы. Откроется пустой рабочий портфель. Скачанные копии и настройки подключения
        сохранятся.
      </p>
      <p>Перед удалением рекомендуем скачать резервную копию кнопкой выше.</p>
      <button mat-stroked-button [disabled]="busy()" (click)="clear()">
        Удалить все данные портфеля
      </button>
    </section>
    @if (busy()) {
      <p role="status">{{ progress() }}</p>
    }
    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    <p>
      <a routerLink="/operations">Создать операцию</a> ·
      <a routerLink="/portfolio">Открыть портфель</a>
    </p>
  `,
  styles: `
    :host {
      display: block;
      max-width: 860px;
      margin: 0 auto;
      padding: 24px;
    }
    section {
      margin-bottom: 28px;
    }
    p {
      line-height: 1.6;
    }
    [role='alert'] {
      color: var(--mat-sys-error, #b3261e);
    }
  `,
})
export class DataPage {
  private readonly http = inject(HttpClient);
  private readonly dialog = inject(MatDialog);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly progress = signal('');

  protected async selectFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 512 * 1024 * 1024) {
      this.error.set('Файл превышает лимит 512 МиБ.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.progress.set('Загрузка и проверка копии…');
    let preview: Preview | undefined;
    try {
      preview = Preview.parse(
        await firstValueFrom(
          this.http.post<unknown>('/api/data/preview', file, {
            headers: { 'Content-Type': 'application/octet-stream' },
          }),
        ),
      );
      this.progress.set('Ожидание подтверждения…');
      const confirmed = await firstValueFrom(
        this.dialog
          .open(DataConfirmDialog, {
            data: {
              title: 'Восстановить портфель?',
              message: `В копии: счетов — ${preview.accounts}, операций — ${preview.operations}, систем — ${preview.systems}. Текущая база будет заменена целиком.`,
            },
          })
          .afterClosed(),
      );
      if (!confirmed) return;
      this.progress.set('Восстановление портфеля…');
      await firstValueFrom(
        this.http.post('/api/data/restore', { id: preview.id, confirmation: 'REPLACE' }),
      );
      preview = undefined;
      window.location.assign('/portfolio');
    } catch (error) {
      this.showError(error);
    } finally {
      if (preview)
        await firstValueFrom(this.http.delete(`/api/data/preview/${preview.id}`)).catch(
          () => undefined,
        );
      this.busy.set(false);
    }
  }
  protected async clear(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.progress.set('Ожидание подтверждения…');
    try {
      const confirmed = await firstValueFrom(
        this.dialog
          .open(DataConfirmDialog, {
            data: {
              title: 'Удалить все данные портфеля?',
              clear: true,
              message:
                'Все данные базы будут удалены. Скачайте резервную копию перед продолжением. Скачанные файлы и настройки подключения сохранятся.',
            },
          })
          .afterClosed(),
      );
      if (!confirmed) return;
      this.progress.set('Очистка портфеля…');
      await firstValueFrom(this.http.post('/api/data/clear', { confirmation: 'DELETE ALL' }));
      window.location.assign('/portfolio');
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy.set(false);
    }
  }
  private showError(error: unknown): void {
    const body =
      error instanceof HttpErrorResponse ? (error.error as { message?: unknown }) : undefined;
    this.error.set(
      typeof body?.message === 'string'
        ? body.message
        : 'Не удалось выполнить действие. Рабочая база сохранена.',
    );
  }
}
