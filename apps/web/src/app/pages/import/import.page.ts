import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { ImportApi, type PreviewResult, type ImportFormat } from '../../entities/import/import.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { ImportAnnotations } from '../../features/import-annotations/import-annotations';
import { parseIsoDate, toIsoDate } from '../../shared/iso-date';
import { StatusChip, extractErrorMessage, type ChipTone } from '@web-shared';

/** Источник строк импорта: файл-отчёт или прямая синхронизация с брокером */
export type ImportSource = 'file' | 'tbank';

/**
 * Период синхронизации по умолчанию. Начало — СЛЕДУЮЩИЙ день после последней
 * операции в журнале: у выплат (дивиденды, купоны) номер операции в API и в
 * xlsx-отчёте разный, поэтому пересечение периодов дедупликация по `brokerRef`
 * не поймает — его проще не создавать. Пустой журнал → последние 90 дней.
 *
 * Чистая функция: «сегодня» приходит аргументом, а не берётся из new Date()
 * внутри — иначе её нельзя протестировать, не подменяя часы (тот же приём, что
 * в periodToRange, widgets/dashboard-filters/dashboard-filter.state.ts).
 */
export function defaultSyncRange(
  lastOperationDate: string | null,
  today: Date,
): { from: Date; to: Date } {
  const last = parseIsoDate(lastOperationDate);
  const from = new Date(today);
  if (last) {
    from.setTime(last.getTime());
    from.setDate(from.getDate() + 1);
  } else {
    from.setDate(from.getDate() - 90);
  }
  // журнал уже содержит операции «из будущего» относительно часов машины —
  // не отдаём брокеру перевёрнутый период
  return { from: from > today ? new Date(today) : from, to: new Date(today) };
}

/**
 * Страница «Импорт» (docs/03-ux-plan.md, шаг 5).
 * CSV, HTML- или xlsx-отчёт брокера либо прямая выгрузка из T-Invest API →
 * предпросмотр с подсветкой → импорт → откат. Оба источника дают одни и те же
 * строки на бэке, поэтому вся разметка и весь предпросмотр ниже — общие.
 * Портфель и система задаются на весь батч (в данных брокера их нет).
 * xlsx — бинарный формат, читается как base64 (в отличие от CSV/HTML — текст).
 */
@Component({
  selector: 'app-import-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatTableModule,
    MatFormFieldModule,
    MatSelectModule,
    MatDatepickerModule,
    ImportAnnotations,
    StatusChip,
  ],
  template: `
    <h1 class="page-title">Импорт</h1>

    <mat-card class="upload">
      @if (tbankAvailable()) {
        <mat-button-toggle-group
          class="source"
          aria-label="Источник данных"
          [value]="source()"
          (valueChange)="setSource($event)"
        >
          <mat-button-toggle value="file">Файл-отчёт</mat-button-toggle>
          <mat-button-toggle value="tbank">T-Bank API</mat-button-toggle>
        </mat-button-toggle-group>
      }

      @if (source() === 'file') {
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
      } @else {
        <p>
          Операции берутся напрямую из T-Invest API по токену <b>только для чтения</b>:
          приложение читает историю счёта и не может выставлять заявки. Сделки, уже
          загруженные из xlsx-отчёта, распознаются как дубли по номеру сделки.
        </p>

        <div class="batch">
          <mat-form-field appearance="outline">
            <mat-label>Счёт у брокера</mat-label>
            <mat-select [value]="accountId()" (valueChange)="accountId.set($event)">
              @for (a of accounts(); track a.id) {
                <mat-option [value]="a.id">{{ a.name || a.id }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Период</mat-label>
            <mat-date-range-input [rangePicker]="rangePicker">
              <input matStartDate placeholder="От" [value]="from()" (dateChange)="from.set($event.value)" />
              <input matEndDate placeholder="До" [value]="to()" (dateChange)="to.set($event.value)" />
            </mat-date-range-input>
            <mat-datepicker-toggle matIconSuffix [for]="rangePicker"></mat-datepicker-toggle>
            <mat-date-range-picker #rangePicker></mat-date-range-picker>
          </mat-form-field>
        </div>

        <button
          mat-flat-button
          color="primary"
          [disabled]="fetching() || !accountId() || !from() || !to()"
          (click)="fetchFromTbank()"
        >
          {{ fetching() ? 'Загрузка…' : 'Загрузить операции' }}
        </button>
        @if (accounts().length === 0 && !accountsLoading()) {
          <p class="warn-note">Брокер не вернул ни одного счёта — проверьте токен.</p>
        }
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

      @if (!batchReady()) {
        <p class="warn-note">
          Выберите портфель и систему — они применятся ко всем операциям
          {{ source() === 'file' ? 'файла' : 'выгрузки' }}.
        </p>
      }
    </mat-card>

    @if (preview()) {
      <mat-card class="summary">
        <app-status-chip tone="success">Распознано: {{ preview()!.summary.ok }}</app-status-chip>
        <app-status-chip tone="warn">Проверить: {{ preview()!.summary.warn }}</app-status-chip>
        <app-status-chip tone="info">Обновятся: {{ preview()!.summary.update }}</app-status-chip>
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
            <td mat-cell *matCellDef="let r">
              @if (r.confidence === 'update') {
                @for (c of r.changes; track c.field) {
                  <div>{{ fieldLabel(c.field) }}: {{ c.from ?? '—' }} → {{ c.to }}</div>
                }
              } @else {
                {{ r.reason || '' }}
              }
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="columns"></tr>
          <tr mat-row *matRowDef="let row; columns: columns"></tr>
        </table>
      </mat-card>
    }

    @if (lastBatch()) {
      <mat-card class="done">
        <span>
          Импортировано {{ lastBatch()!.imported }} операций@if (lastBatch()!.updated > 0) {, обновлено {{ lastBatch()!.updated }}}.
        </span>
        <button mat-stroked-button (click)="rollback()">Откатить загрузку</button>
      </mat-card>
    }

    @if (errorMessage()) {
      <p class="error">{{ errorMessage() }}</p>
    }

    <app-import-annotations />
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
      .source {
        margin-bottom: 12px;
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
  protected readonly lastBatch = signal<{ batchId: string; imported: number; updated: number } | null>(null);
  protected readonly errorMessage = signal('');

  protected readonly fileName = signal('');
  protected readonly format = signal<ImportFormat>('csv');
  protected readonly portfolioId = signal<string | undefined>(undefined);
  protected readonly systemId = signal<string | undefined>(undefined);

  protected readonly portfolios = computed(() => this.reference.portfolios.value() ?? []);
  protected readonly systems = computed(() => this.reference.systems.value() ?? []);

  /** Источник строк: файл-отчёт или прямая выгрузка из T-Invest API */
  protected readonly source = signal<ImportSource>('file');
  protected readonly fetching = signal(false);
  protected readonly accountId = signal<string | undefined>(undefined);

  /** Вкладку синхронизации показываем, только если на бэке настроен токен */
  protected readonly tbankAvailable = computed(
    () => this.api.tbankStatus.value()?.configured ?? false,
  );
  protected readonly accounts = computed(() => this.api.tbankAccounts.value() ?? []);
  protected readonly accountsLoading = computed(() => this.api.tbankAccounts.isLoading());

  /**
   * Границы периода синхронизации. `linkedSignal`, а не `effect`, пишущий в
   * сигнал: значение по умолчанию вычисляется из даты последней операции, но
   * остаётся правимым пользователем и пересчитывается, когда статус подгрузился.
   */
  protected readonly from = linkedSignal<Date | null>(
    () => defaultSyncRange(this.api.tbankStatus.value()?.lastOperationDate ?? null, new Date()).from,
  );
  protected readonly to = linkedSignal<Date | null>(
    () => defaultSyncRange(this.api.tbankStatus.value()?.lastOperationDate ?? null, new Date()).to,
  );

  /**
   * Портфель и система задаются на весь батч: в данных брокера их нет ни в
   * файле-отчёте, ни в API. Исключение — CSV, где колонки есть в самом файле.
   */
  protected readonly batchReady = computed(
    () =>
      (this.source() === 'file' && this.format() === 'csv') ||
      (!!this.portfolioId() && !!this.systemId()),
  );

  /** Сколько строк реально импортируется (ok + warn) */
  protected readonly importableCount = computed(() => {
    const s = this.preview()?.summary;
    return s ? s.ok + s.warn + s.update : 0;
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

  /** Смена источника обнуляет всё, что относилось к предыдущему */
  protected setSource(source: ImportSource): void {
    if (source === this.source()) return;
    this.source.set(source);
    this.resetInput();
    this.fileName.set('');
    this.fileContent = '';
    this.format.set('csv');
  }

  /**
   * Выгрузка операций из T-Invest API. Кнопка заблокирована на время запроса —
   * повторный клик не должен запускать вторую синхронизацию (CLAUDE.md §5,
   * семантика exhaustMap). В базу здесь ничего не пишется: получаем uploadId и
   * дальше идём обычным путём предпросмотра.
   */
  protected async fetchFromTbank(): Promise<void> {
    const accountId = this.accountId();
    const from = this.from();
    const to = this.to();
    if (!accountId || !from || !to || this.fetching()) return;

    this.fetching.set(true);
    this.resetInput();
    try {
      const result = await this.api.tbankFetch({
        accountId,
        from: toIsoDate(from),
        to: toIsoDate(to),
      });
      this.uploadId = result.uploadId;
      if (result.rows === 0) {
        this.errorMessage.set('За выбранный период у брокера нет операций.');
        return;
      }
      await this.tryPreview();
    } catch (e: unknown) {
      this.errorMessage.set(extractErrorMessage(e, 'Не удалось получить операции у брокера.'));
    } finally {
      this.fetching.set(false);
    }
  }

  /** Сброс состояния предыдущей загрузки (общий для обоих источников) */
  private resetInput(): void {
    this.errorMessage.set('');
    this.lastBatch.set(null);
    this.preview.set(null);
    this.tickerSystemChoices.set({});
    this.uploadId = undefined;
  }

  protected onFile(event: Event): void {
    this.resetInput();
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

  /** Предпросмотр запускается автоматически, когда есть данные и достаточно разметки */
  private async tryPreview(): Promise<void> {
    if ((!this.fileContent && !this.uploadId) || !this.batchReady()) return;
    this.errorMessage.set('');
    try {
      const result = await this.api.preview(this.request());
      this.uploadId = result.uploadId;
      this.preview.set(result);
    } catch (e: unknown) {
      this.errorMessage.set(
        extractErrorMessage(
          e,
          this.source() === 'file'
            ? 'Не удалось разобрать файл. Проверьте формат.'
            : 'Не удалось разобрать выгрузку. Загрузите операции заново.',
        ),
      );
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

  /**
   * Content шлём только пока нет uploadId — дальше бэк переиспользует уже
   * распарсенные строки. У выгрузки из API содержимого нет вовсе: там всегда
   * uploadId, а формат файла не имеет смысла и не передаётся.
   */
  private request() {
    const fromApi = this.source() === 'tbank';
    return {
      content: fromApi || this.uploadId ? undefined : this.fileContent,
      uploadId: this.uploadId,
      format: fromApi ? undefined : this.format(),
      systemId: this.systemId(),
      portfolioId: this.portfolioId(),
      tickerSystemOverrides: this.tickerSystemChoices(),
    };
  }

  protected statusTone(c: string): ChipTone {
    return (
      ({ ok: 'success', warn: 'warn', update: 'info', duplicate: 'neutral', error: 'danger' } as const)[c] ??
      'neutral'
    );
  }

  protected statusLabel(c: string): string {
    return { ok: 'OK', warn: 'Проверить', update: 'Обновить', duplicate: 'Дубль', error: 'Ошибка' }[c] ?? c;
  }

  protected fieldLabel(field: string): string {
    return (
      { fee: 'Комиссия', price: 'Цена', quantity: 'Кол-во', executedAt: 'Время' } as Record<string, string>
    )[field] ?? field;
  }
}
