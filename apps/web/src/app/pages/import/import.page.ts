import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { ImportApi, type PreviewResult } from '../../entities/import/import.api';

/**
 * Страница «Импорт» (docs/03-ux-plan.md, шаг 5).
 * CSV → предпросмотр с подсветкой распознавания → импорт → откат.
 */
@Component({
  selector: 'app-import-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatButtonModule, MatIconModule, MatTableModule],
  template: `
    <h1 class="page-title">Импорт</h1>

    <mat-card class="upload">
      <p>Загрузите CSV-отчёт. Колонки: Дата, Система, Тикер, Валюта, Брокер, Тип сделки,
        Между портфелями, Количество, Цена, Комиссия, Курс к RUB, Примечание.</p>
      <input
        type="file"
        accept=".csv,text/csv"
        (change)="onFile($event)"
        #fileInput
      />
    </mat-card>

    @if (preview()) {
      <mat-card class="summary">
        <span class="chip ok">Распознано: {{ preview()!.summary.ok }}</span>
        <span class="chip warn">Проверить: {{ preview()!.summary.warn }}</span>
        <span class="chip dup">Дубли: {{ preview()!.summary.duplicate }}</span>
        <span class="chip err">Ошибки: {{ preview()!.summary.error }}</span>
        <span class="spacer"></span>
        <button
          mat-flat-button
          color="primary"
          [disabled]="importing() || (preview()!.summary.ok + preview()!.summary.warn) === 0"
          (click)="commit()"
        >
          {{ importing() ? 'Импорт…' : 'Импортировать (' + (preview()!.summary.ok + preview()!.summary.warn) + ')' }}
        </button>
      </mat-card>

      <mat-card>
        <table mat-table [dataSource]="preview()!.rows">
          <ng-container matColumnDef="status">
            <th mat-header-cell *matHeaderCellDef>Статус</th>
            <td mat-cell *matCellDef="let r">
              <span class="chip" [class]="statusClass(r.confidence)">{{ statusLabel(r.confidence) }}</span>
            </td>
          </ng-container>
          <ng-container matColumnDef="date">
            <th mat-header-cell *matHeaderCellDef>Дата</th>
            <td mat-cell *matCellDef="let r">{{ r.operation?.date || '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="type">
            <th mat-header-cell *matHeaderCellDef>Тип</th>
            <td mat-cell *matCellDef="let r">{{ r.operation?.operationType || '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="ticker">
            <th mat-header-cell *matHeaderCellDef>Тикер</th>
            <td mat-cell *matCellDef="let r">{{ r.operation?.instrumentId || '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="qty">
            <th mat-header-cell *matHeaderCellDef>Кол-во</th>
            <td mat-cell *matCellDef="let r">{{ r.operation?.quantity || '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="price">
            <th mat-header-cell *matHeaderCellDef>Цена</th>
            <td mat-cell *matCellDef="let r">{{ r.operation?.price || '—' }}</td>
          </ng-container>
          <ng-container matColumnDef="reason">
            <th mat-header-cell *matHeaderCellDef>Примечание</th>
            <td mat-cell *matCellDef="let r">{{ r.reason || '' }}</td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="columns"></tr>
          <tr mat-row *matRowDef="let row; columns: columns"></tr>
        </table>
      </mat-card>
    }

    @if (lastBatch()) {
      <mat-card class="done">
        <span>Импортировано {{ lastBatch()!.imported }} операций.</span>
        <button mat-stroked-button (click)="rollback()">Откатить загрузку</button>
      </mat-card>
    }

    @if (errorMessage()) {
      <p class="error">{{ errorMessage() }}</p>
    }
  `,
  styles: [
    `
      .upload,
      .summary,
      .done {
        margin-bottom: 16px;
        padding: 16px;
      }
      .summary,
      .done {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .spacer {
        flex: 1;
      }
      table {
        width: 100%;
      }
      .chip {
        padding: 2px 10px;
        border-radius: 12px;
        font-size: 12px;
        white-space: nowrap;
      }
      .chip.ok {
        background: #e8f5e9;
        color: #2e7d32;
      }
      .chip.warn {
        background: #fff8e1;
        color: #f57f17;
      }
      .chip.dup {
        background: #eceff1;
        color: #607d8b;
      }
      .chip.err {
        background: #ffebee;
        color: #c62828;
      }
      .error {
        color: #c62828;
      }
    `,
  ],
})
export class ImportPage {
  private readonly api = inject(ImportApi);

  protected readonly columns = ['status', 'date', 'type', 'ticker', 'qty', 'price', 'reason'];
  protected readonly preview = signal<PreviewResult | null>(null);
  protected readonly importing = signal(false);
  protected readonly lastBatch = signal<{ batchId: string; imported: number } | null>(null);
  protected readonly errorMessage = signal('');

  private csvContent = '';

  protected onFile(event: Event): void {
    this.errorMessage.set('');
    this.lastBatch.set(null);
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      this.csvContent = String(reader.result ?? '');
      try {
        const result = await this.api.preview(this.csvContent);
        this.preview.set(result);
      } catch {
        this.errorMessage.set('Не удалось разобрать файл. Проверьте формат CSV.');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  protected async commit(): Promise<void> {
    this.importing.set(true);
    this.errorMessage.set('');
    try {
      const result = await this.api.commit(this.csvContent);
      this.lastBatch.set(result);
      this.preview.set(null);
    } catch {
      this.errorMessage.set('Не удалось импортировать. Попробуйте ещё раз.');
    } finally {
      this.importing.set(false);
    }
  }

  protected async rollback(): Promise<void> {
    const batch = this.lastBatch();
    if (!batch) return;
    try {
      await this.api.rollback(batch.batchId);
      this.lastBatch.set(null);
    } catch {
      this.errorMessage.set('Не удалось откатить загрузку.');
    }
  }

  protected statusClass(c: string): string {
    return { ok: 'ok', warn: 'warn', duplicate: 'dup', error: 'err' }[c] ?? '';
  }

  protected statusLabel(c: string): string {
    return { ok: 'OK', warn: 'Проверить', duplicate: 'Дубль', error: 'Ошибка' }[c] ?? c;
  }
}
