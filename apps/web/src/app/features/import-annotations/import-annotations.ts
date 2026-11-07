import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { extractErrorMessage, StatusChip } from '@web-shared';
import { ImportApi, type AnnotationPreview } from '../../entities/import/import.api';

/**
 * Загрузка данных исполнения из CSV терминала (необязательное обогащение): тег входа/
 * выхода и сигнальная цена для уже импортированных операций. Сопоставление идёт по
 * номеру сделки из отчёта брокера, поэтому сначала импортируйте отчёт. Комиссии из
 * файла игнорируются — факт комиссии берётся из отчёта брокера.
 *
 * Сценарий как у основного импорта: предпросмотр (ничего не пишет) → подтверждение.
 * Строки, которые не нашли пару, показываются с причиной и не теряются молча.
 */
@Component({
  selector: 'app-import-annotations',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatButtonModule, MatIconModule, MatTableModule, StatusChip],
  template: `
    <mat-card class="card">
      <h3>Данные исполнения (необязательно)</h3>
      <p class="hint">
        CSV выгрузки терминала (например, QUIK): тег причины входа/выхода и сигнальная цена.
        Привязывается к уже импортированным сделкам по их номеру — по ним считается
        проскальзывание на странице системы. Комиссии из файла не используются.
      </p>
      <input id="annotations-file" class="file-input" type="file" accept=".csv,text/csv" (change)="onFile($event)" />
      <label class="file-picker" for="annotations-file">
        <mat-icon>attach_file</mat-icon>
        <span>Выбрать CSV</span>
      </label>
      @if (fileName()) {
        <span class="file">Файл: <b>{{ fileName() }}</b></span>
      }

      @if (preview(); as p) {
        <div class="summary">
          <app-status-chip tone="success">Привяжется: {{ p.summary.matched }}</app-status-chip>
          <app-status-chip tone="warn">Без пары: {{ p.summary.error }}</app-status-chip>
          <span class="spacer"></span>
          <button mat-flat-button color="primary" [disabled]="saving() || p.summary.matched === 0" (click)="commit()">
            {{ saving() ? 'Сохранение…' : 'Сохранить (' + p.summary.matched + ')' }}
          </button>
        </div>
        <table mat-table [dataSource]="p.rows">
          <ng-container matColumnDef="status">
            <th mat-header-cell *matHeaderCellDef>Статус</th>
            <td mat-cell *matCellDef="let r">
              <app-status-chip [tone]="r.status === 'matched' ? 'success' : 'warn'">{{
                r.status === 'matched' ? 'OK' : 'Без пары'
              }}</app-status-chip>
            </td>
          </ng-container>
          <ng-container matColumnDef="line">
            <th mat-header-cell *matHeaderCellDef>Строка</th>
            <td mat-cell *matCellDef="let r">{{ r.line || '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="deal">
            <th mat-header-cell *matHeaderCellDef>Сделка</th>
            <td mat-cell *matCellDef="let r">
              {{ r.brokerRef ? '№ ' + r.brokerRef + ' · ' + r.side + ' ' + r.quantity + ' @ ' + r.price : '—' }}
            </td>
          </ng-container>
          <ng-container matColumnDef="tag">
            <th mat-header-cell *matHeaderCellDef>Тег</th>
            <td mat-cell *matCellDef="let r">{{ r.tag || '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="signal">
            <th mat-header-cell *matHeaderCellDef>Сигнальная цена</th>
            <td mat-cell *matCellDef="let r">{{ r.signalPrice || '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="reason">
            <th mat-header-cell *matHeaderCellDef>Причина</th>
            <td mat-cell *matCellDef="let r">{{ r.reason || '' }}</td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="columns"></tr>
          <tr mat-row *matRowDef="let row; columns: columns"></tr>
        </table>
      }
      @if (result()) {
        <p class="done">{{ result() }}</p>
      }
      @if (error()) {
        <p class="error">{{ error() }}</p>
      }
    </mat-card>
  `,
  styles: [
    `
      .card {
        padding: 16px;
        margin-top: 16px;
      }
      h3 {
        margin: 0 0 8px;
        font-weight: 500;
      }
      .hint {
        margin: 0 0 12px;
        font-size: 13px;
        color: var(--app-text-muted);
        max-width: 80ch;
      }
      .file {
        margin-left: 12px;
        font-size: 13px;
      }
      /* нативный input спрятан клипом, а не display:none — остаётся фокусируемым с клавиатуры */
      .file-input {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
      }
      .file-picker {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        padding: 6px 12px;
        border: 1px solid var(--app-border, currentColor);
        border-radius: 8px;
      }
      .file-input:focus-visible + .file-picker {
        outline: 2px solid var(--mat-sys-primary);
      }
      .summary {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
        margin: 16px 0 8px;
      }
      .spacer {
        flex: 1;
      }
      table {
        width: 100%;
      }
    `,
  ],
})
export class ImportAnnotations {
  private readonly api = inject(ImportApi);

  protected readonly columns = ['status', 'line', 'deal', 'tag', 'signal', 'reason'];
  protected readonly fileName = signal('');
  protected readonly preview = signal<AnnotationPreview | null>(null);
  protected readonly saving = signal(false);
  protected readonly result = signal('');
  protected readonly error = signal('');
  private content = '';

  protected async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    this.preview.set(null);
    this.result.set('');
    this.error.set('');
    if (!file) return;
    this.fileName.set(file.name);
    try {
      this.content = await file.text();
      this.preview.set(await this.api.annotationsPreview(this.content));
    } catch (e) {
      this.error.set(extractErrorMessage(e, 'Не удалось разобрать файл.'));
    }
  }

  protected async commit(): Promise<void> {
    this.saving.set(true);
    this.error.set('');
    try {
      const res = await this.api.annotationsCommit(this.content);
      this.result.set(
        `Сохранено: ${res.saved}.` + (res.skipped.length ? ` Без пары осталось: ${res.skipped.length}.` : ''),
      );
    } catch (e) {
      this.error.set(extractErrorMessage(e, 'Не удалось сохранить данные исполнения.'));
    } finally {
      this.saving.set(false);
    }
  }
}
