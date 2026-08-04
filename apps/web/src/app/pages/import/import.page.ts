import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { ImportApi, type PreviewResult, type ImportFormat } from '../../entities/import/import.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { StatusChip, type ChipTone } from '@web-shared';

/**
 * Страница «Импорт» (docs/03-ux-plan.md, шаг 5).
 * CSV, HTML- или xlsx-отчёт брокера → предпросмотр с подсветкой → импорт → откат.
 * Для HTML/xlsx портфель и система задаются на весь батч (в отчёте их нет).
 * xlsx — бинарный формат, читается как base64 (в отличие от CSV/HTML — текст).
 */
@Component({
  selector: 'app-import-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatTableModule,
    MatFormFieldModule,
    MatSelectModule,
    StatusChip,
  ],
  template: `
    <h1 class="page-title">Импорт</h1>

    <mat-card class="upload">
      <p>
        Загрузите <b>CSV</b>, <b>HTML-отчёт брокера</b> или <b>xlsx-отчёт Т-Банка</b>.
        Для CSV колонки: Дата, Система, Тикер, Валюта, Брокер, Тип сделки, Между
        портфелями, Количество, Цена, Комиссия, Курс к RUB, Примечание. Формат
        HTML/xlsx-отчёта распознаётся автоматически.
      </p>
      <!--
        Голый <input type="file"> не имел ни подписи, ни aria-label: скринридер
        объявлял его просто «кнопка выбора файла», а прозаическое описание выше
        программно с ним связано не было. Прячем нативный контрол и вешаем на него
        <label>, оформленный как кнопка Material — доступное имя приходит от label,
        клавиатурная активация работает штатно.
      -->
      <input
        id="import-file"
        class="file-input"
        type="file"
        accept=".csv,.html,.htm,.xlsx,text/csv,text/html,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        (change)="onFile($event)"
      />
      <label class="file-picker" for="import-file">
        <mat-icon>attach_file</mat-icon>
        <span>Выбрать файл</span>
      </label>

      @if (fileName()) {
        <p class="file">
          Файл: <b>{{ fileName() }}</b> · формат: <b>{{ format().toUpperCase() }}</b>
        </p>
      }

      <div class="batch">
        <mat-form-field appearance="outline">
          <mat-label>Портфель</mat-label>
          <mat-select [value]="portfolioId()" (valueChange)="setPortfolio($event)">
            @for (p of portfolios(); track p.id) {
              <mat-option [value]="p.id">{{ p.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Система</mat-label>
          <mat-select [value]="systemId()" (valueChange)="setSystem($event)">
            @for (s of systems(); track s.id) {
              <mat-option [value]="s.id">{{ s.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      </div>

      @if (format() !== 'csv' && !batchReady()) {
        <p class="warn-note">Для этого формата выберите портфель и систему — они применятся ко всем операциям файла.</p>
      }
    </mat-card>

    @if (preview()) {
      <mat-card class="summary">
        <app-status-chip tone="success">Распознано: {{ preview()!.summary.ok }}</app-status-chip>
        <app-status-chip tone="warn">Проверить: {{ preview()!.summary.warn }}</app-status-chip>
        <app-status-chip tone="neutral">Дубли: {{ preview()!.summary.duplicate }}</app-status-chip>
        <app-status-chip tone="danger">Ошибки: {{ preview()!.summary.error }}</app-status-chip>
        <span class="spacer"></span>
        <button
          mat-flat-button
          color="primary"
          [disabled]="importing() || importableCount() === 0"
          (click)="commit()"
        >
          {{ importing() ? 'Импорт…' : 'Импортировать (' + importableCount() + ')' }}
        </button>
      </mat-card>

      @if (uncertainTickers().length > 0) {
        <mat-card class="rules">
          <p class="rules-hint">
            Система для этих тикеров назначена по умолчанию (батч) — один отчёт может
            содержать сделки разных систем. Выберите систему для каждого тикера —
            подставится в этом импорте; выбор не сохраняется на будущее, так как один
            и тот же тикер в другой раз может относиться к другой системе.
          </p>
          @for (ticker of uncertainTickers(); track ticker) {
            <div class="rule-row">
              <span class="rule-ticker">{{ ticker }}</span>
              <mat-form-field appearance="outline">
                <mat-label>Система</mat-label>
                <mat-select [value]="tickerSystem(ticker)" (valueChange)="setTickerSystem(ticker, $event)">
                  @for (s of systems(); track s.id) {
                    <mat-option [value]="s.id">{{ s.name }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
            </div>
          }
        </mat-card>
      }

      <mat-card>
        <table mat-table [dataSource]="preview()!.rows">
          <ng-container matColumnDef="status">
            <th mat-header-cell *matHeaderCellDef>Статус</th>
            <td mat-cell *matCellDef="let r">
              <app-status-chip [tone]="statusTone(r.confidence)">{{ statusLabel(r.confidence) }}</app-status-chip>
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
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
      }
      /*
       * Нативный input скрыт, но НЕ через display:none — так он выпал бы из
       * таб-порядка, и выбрать файл с клавиатуры стало бы нельзя вообще.
       * Клип оставляет его фокусируемым, а видимую роль играет label.
       */
      .file-input {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
      .file-picker {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
        padding: 0 16px;
        height: 40px;
        border: 1px solid var(--app-outline);
        border-radius: var(--mat-sys-corner-full);
        color: var(--mat-sys-primary);
        cursor: pointer;
        user-select: none;
      }
      .file-picker:hover {
        background: color-mix(in srgb, var(--mat-sys-primary) 8%, transparent);
      }
      /* Фокус нативного input'а отражаем на label — он и есть видимый контрол */
      .file-input:focus-visible + .file-picker,
      .file-picker:focus-within {
        outline: 2px solid var(--mat-sys-primary);
        outline-offset: 2px;
      }
      .batch {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        margin-top: 12px;
      }
      /* flex-basis вместо min-width: жёсткие 220px не давали ряду сжаться на телефоне */
      .batch mat-form-field {
        flex: 1 1 220px;
        min-width: 0;
      }
      .rules {
        padding: 16px;
      }
      .rules-hint {
        margin: 0 0 12px;
        color: var(--app-text-muted);
      }
      .rule-row {
        display: flex;
        align-items: start;
        gap: 12px;
        margin-bottom: 4px;
      }
      .rule-ticker {
        min-width: 80px;
        font-weight: 500;
        line-height: 56px;
      }
      .rule-row mat-form-field {
        flex: 1 1 200px;
        min-width: 0;
      }
      .file {
        margin: 8px 0 0;
        color: var(--app-text-muted);
      }
      /* .warn-note, а не .hint: имя .hint зарезервировано под бейдж-подсказку «?» */
      .warn-note {
        margin: 4px 0 0;
        color: var(--app-warn);
      }
      .spacer {
        flex: 1;
      }
      table {
        width: 100%;
      }
      /* .error — глобальный (styles.scss) */
    `,
  ],
})
export class ImportPage {
  private readonly api = inject(ImportApi);
  private readonly reference = inject(ReferenceApi);

  protected readonly columns = ['status', 'date', 'type', 'ticker', 'qty', 'price', 'reason'];
  protected readonly preview = signal<PreviewResult | null>(null);
  protected readonly importing = signal(false);
  protected readonly lastBatch = signal<{ batchId: string; imported: number } | null>(null);
  protected readonly errorMessage = signal('');

  protected readonly fileName = signal('');
  protected readonly format = signal<ImportFormat>('csv');
  protected readonly portfolioId = signal<string | undefined>(undefined);
  protected readonly systemId = signal<string | undefined>(undefined);

  protected readonly portfolios = computed(() => this.reference.portfolios.value() ?? []);
  protected readonly systems = computed(() => this.reference.systems.value() ?? []);

  /** Для HTML-отчёта нужны портфель и система (в файле их нет); для CSV — опционально */
  protected readonly batchReady = computed(
    () => this.format() === 'csv' || (!!this.portfolioId() && !!this.systemId()),
  );

  /** Сколько строк реально импортируется (ok + warn) */
  protected readonly importableCount = computed(() => {
    const s = this.preview()?.summary;
    return s ? s.ok + s.warn : 0;
  });

  /** Тикеры, для которых система назначена батч-дефолтом, а не выбрана явно (§3.1) */
  protected readonly uncertainTickers = computed(() => {
    const rows = this.preview()?.rows ?? [];
    return [...new Set(rows.filter((r) => r.systemUncertain && r.ticker).map((r) => r.ticker!))];
  });

  /**
   * Выбор системы по тикеру для ТЕКУЩЕГО импорта (docs/04-roadmap.md §3.1) — не
   * персистентное правило: тот же тикер в другой раз может уйти в другую систему,
   * поэтому карта живёт только пока открыта страница и сбрасывается при новом файле.
   */
  private readonly tickerSystemChoices = signal<Record<string, string>>({});

  private fileContent = '';
  /**
   * Id файла, уже распарсенного бэком (из ответа preview()). Пока он есть,
   * правки батч-разметки/тикер-выбора шлют его вместо содержимого файла —
   * иначе для большого xlsx-отчёта каждый чих пересылал бы весь файл заново
   * и заново гонял бы его через парсер (docs/04-roadmap.md §3.1).
   */
  private uploadId: string | undefined;

  protected onFile(event: Event): void {
    this.errorMessage.set('');
    this.lastBatch.set(null);
    this.preview.set(null);
    this.tickerSystemChoices.set({});
    this.uploadId = undefined;
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.fileName.set(file.name);
    const format: ImportFormat = /\.xlsx$/i.test(file.name)
      ? 'xlsx'
      : /\.html?$/i.test(file.name)
        ? 'html'
        : 'csv';
    this.format.set(format);

    const reader = new FileReader();
    if (format === 'xlsx') {
      // xlsx — бинарный формат, передаём на бэк как base64 (data URL без префикса)
      reader.onload = () => {
        const dataUrl = String(reader.result ?? '');
        this.fileContent = dataUrl.slice(dataUrl.indexOf(',') + 1);
        this.tryPreview();
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => {
        this.fileContent = String(reader.result ?? '');
        this.tryPreview();
      };
      reader.readAsText(file, 'utf-8');
    }
  }

  protected setPortfolio(id: string): void {
    this.portfolioId.set(id);
    this.tryPreview();
  }

  protected setSystem(id: string): void {
    this.systemId.set(id);
    this.tryPreview();
  }

  protected tickerSystem(ticker: string): string | undefined {
    return this.tickerSystemChoices()[ticker];
  }

  /** Выбрать систему для тикера в этом импорте и сразу пересчитать предпросмотр */
  protected setTickerSystem(ticker: string, systemId: string): void {
    this.tickerSystemChoices.update((m) => ({ ...m, [ticker]: systemId }));
    this.tryPreview();
  }

  /** Предпросмотр запускается автоматически, когда есть файл и достаточно разметки */
  private async tryPreview(): Promise<void> {
    if ((!this.fileContent && !this.uploadId) || !this.batchReady()) return;
    this.errorMessage.set('');
    try {
      const result = await this.api.preview(this.request());
      this.uploadId = result.uploadId;
      this.preview.set(result);
    } catch {
      this.errorMessage.set('Не удалось разобрать файл. Проверьте формат.');
    }
  }

  protected async commit(): Promise<void> {
    if (!this.batchReady()) return;
    this.importing.set(true);
    this.errorMessage.set('');
    try {
      const result = await this.api.commit(this.request());
      this.lastBatch.set(result);
      this.preview.set(null);
      this.uploadId = undefined; // батч закоммичен — кэш файла на бэке уже очищен
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

  /** Content шлём только пока нет uploadId — дальше бэк переиспользует уже распарсенные строки */
  private request() {
    return {
      content: this.uploadId ? undefined : this.fileContent,
      uploadId: this.uploadId,
      format: this.format(),
      systemId: this.systemId(),
      portfolioId: this.portfolioId(),
      tickerSystemOverrides: this.tickerSystemChoices(),
    };
  }

  protected statusTone(c: string): ChipTone {
    return (
      ({ ok: 'success', warn: 'warn', duplicate: 'neutral', error: 'danger' } as const)[c] ??
      'neutral'
    );
  }

  protected statusLabel(c: string): string {
    return { ok: 'OK', warn: 'Проверить', duplicate: 'Дубль', error: 'Ошибка' }[c] ?? c;
  }
}
