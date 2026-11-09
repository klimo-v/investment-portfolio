import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { InstrumentType, SplitPlan } from '@core';
import { OperationApi } from '../../entities/operation/operation.api';
import { ReferenceApi, type MergeUndoView } from '../../entities/reference/reference.api';

export interface SplitInstrumentData {
  /** инструмент, из которого выделяем (при откате — цель слияния) */
  instrumentId: string;
  ticker: string;
  /** режим отката слияния из журнала; без него — ручное «Выделить инструмент заново» */
  mergeId?: string;
}

type Side = 'source' | 'target';

const INSTRUMENT_TYPES: InstrumentType[] = ['Stock', 'Bond', 'ETF', 'Currency', 'Crypto', 'Cash', 'Future'];

/**
 * Разделение инструмента. Один диалог на два сценария:
 *  - «Выделить инструмент заново» — для слияний без журнала: пользователь сам выбирает операции и коды;
 *  - «Отменить слияние» — тот же план, заполненный по журналу; неясные операции (без кода или с новым
 *    кодом) распределяются явно, пока этого не сделано — подтвердить нельзя.
 * Любое подтверждение сопровождается предпросмотром: количество и средняя цена до/после, продажи без позиции.
 */
@Component({
  selector: 'app-split-instrument-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    MatDialogModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <h2 mat-dialog-title>
      {{ isUndo ? 'Отменить слияние' : 'Выделить инструмент заново' }}: «{{ data.ticker }}»
    </h2>
    <mat-dialog-content>
      @if (isUndo) {
        @if (undo(); as u) {
          <p class="muted">
            Слияние «{{ u.merge.sourceTicker }}» → «{{ data.ticker }}». «{{ u.merge.sourceTicker }}» будет восстановлен:
            операции, коды, цены и котировка вернутся из снимка журнала. Изменённое после слияния не трогается.
          </p>
          <p>
            Источнику: <b>{{ u.plan.toSource.length }}</b> операций; остаются у цели: <b>{{ u.plan.toTarget.length }}</b>;
            неясных: <b>{{ u.plan.unclear.length }}</b>.
          </p>
          @if (u.plan.skippedOperations.length > 0) {
            <p class="warn-note">Удалены или переназначены после слияния и будут пропущены: {{ u.plan.skippedOperations.join(', ') }}.</p>
          }
          @if (u.plan.identifiersAfterMerge.length > 0) {
            <p class="muted">Коды, добавленные после слияния, остаются у цели:</p>
            @for (c of u.plan.identifiersAfterMerge; track c.scheme + c.value) {
              <div class="code">{{ c.scheme }}: {{ c.value }}</div>
            }
          }
          @if (u.plan.identifiersMissing.length > 0) {
            <p class="muted">Коды из снимка, которых у цели уже нет, будут пропущены: {{ missingCodes() }}.</p>
          }
          @if (unclearOps().length > 0) {
            <h3 class="sub">Неясные операции — решите, чья каждая</h3>
            <p class="muted">У этих операций нет кода или он новый, определить автоматически нельзя.</p>
            <div class="bulk">
              <button mat-stroked-button (click)="assignAll('target')">Все — цели</button>
              <button mat-stroked-button (click)="assignAll('source')">Все — источнику</button>
            </div>
            @for (o of unclearOps(); track o.id) {
              <div class="op">
                <span class="op-text">{{ o.date }} {{ o.operationType }} {{ o.quantity }} × {{ o.price }}</span>
                <mat-button-toggle-group [value]="assignments()[o.id] ?? null" (change)="assign(o.id, $event.value)">
                  <mat-button-toggle value="source">Источнику</mat-button-toggle>
                  <mat-button-toggle value="target">Цели</mat-button-toggle>
                </mat-button-toggle-group>
              </div>
            }
          }
          @for (e of u.plan.errors; track e) {
            <p class="blocker">{{ e }}</p>
          }
        } @else {
          <p class="muted">Загружаю план отката…</p>
        }
      } @else {
        <div class="form">
          <mat-form-field appearance="outline">
            <mat-label>Тикер нового инструмента</mat-label>
            <input matInput [value]="newTicker()" (input)="setTicker($any($event.target).value)" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Идентификатор</mat-label>
            <input matInput [value]="newId()" (input)="newId.set($any($event.target).value); resetPreview()" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Название</mat-label>
            <input matInput [value]="newName()" (input)="newName.set($any($event.target).value); resetPreview()" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Тип</mat-label>
            <mat-select [value]="newType()" (valueChange)="newType.set($event); resetPreview()">
              @for (t of types; track t) {
                <mat-option [value]="t">{{ t }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Источник цен</mat-label>
            <mat-select [value]="marketSource()" (valueChange)="marketSource.set($event); resetPreview()">
              @for (m of sources; track m) {
                <mat-option [value]="m">{{ m }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Новое название у «{{ data.ticker }}» (необязательно)</mat-label>
            <input matInput [value]="remainingName()" (input)="remainingName.set($any($event.target).value); resetPreview()" />
          </mat-form-field>
        </div>

        <h3 class="sub">Операции, которые уйдут в новый инструмент ({{ selectedOps().size }} из {{ ops().length }})</h3>
        @for (o of ops(); track o.id) {
          <mat-checkbox [checked]="selectedOps().has(o.id!)" (change)="toggleOp(o.id!, $event.checked)">
            {{ o.date }} {{ o.operationType }} {{ o.quantity }} × {{ o.price }}
          </mat-checkbox>
        }
        <h3 class="sub">Коды, которые уйдут в новый инструмент</h3>
        @for (c of codes(); track c.key) {
          <mat-checkbox [checked]="selectedCodes().has(c.key)" (change)="toggleCode(c.key, $event.checked)">
            {{ c.key }} <span class="muted">({{ c.origin }})</span>
          </mat-checkbox>
        }
        <div class="bulk">
          <button mat-stroked-button (click)="refreshPreview()" [disabled]="busy()">Предпросмотр</button>
        </div>
      }

      @if (previewData(); as p) {
        <h3 class="sub">Предпросмотр</h3>
        <table class="preview">
          <tr><th></th><th>операций</th><th>позиции (кол-во @ средняя)</th><th>продаж без позиции</th></tr>
          @for (row of rows(p); track row.label) {
            <tr>
              <td>{{ row.label }}</td>
              <td>{{ row.side.operations }}</td>
              <td>
                @for (pos of row.side.positions; track pos.systemId + pos.portfolioId) {
                  <div>{{ pos.quantity | number: '1.0-8' }} &#64; {{ pos.avgBuyPrice | number: '1.0-4' }}</div>
                } @empty {
                  —
                }
              </td>
              <td>{{ row.side.orphanSells }}</td>
            </tr>
          }
        </table>
        @for (w of warnings(); track w) {
          <p class="warn-note">{{ w }}</p>
        }
        @for (e of errors(); track e) {
          <p class="blocker">{{ e }}</p>
        }
        @if (orphanAppear()) {
          <mat-checkbox [checked]="confirmOrphan()" (change)="confirmOrphan.set($event.checked)">
            Понимаю: появятся продажи без позиции
          </mat-checkbox>
        }
      }
      @if (failure()) {
        <p class="blocker">{{ failure() }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()">Закрыть</button>
      <button mat-flat-button color="warn" [disabled]="!canApply()" (click)="apply()">
        {{ isUndo ? 'Отменить слияние' : 'Выделить' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      mat-dialog-content {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 420px;
        max-height: 70vh;
      }
      .form {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0 12px;
      }
      .sub {
        margin: 12px 0 2px;
        font-size: 0.95rem;
      }
      .muted {
        color: var(--app-text-muted);
        font-size: 0.85em;
      }
      .code {
        font-family: monospace;
        padding-left: 12px;
      }
      .bulk {
        display: flex;
        gap: 8px;
        margin: 6px 0;
      }
      .op {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .preview {
        border-collapse: collapse;
        font-size: 0.9em;
      }
      .preview th,
      .preview td {
        text-align: left;
        padding: 2px 10px 2px 0;
      }
      .warn-note,
      .blocker {
        margin: 4px 0;
        padding: 8px;
        border-radius: 4px;
        background: color-mix(in srgb, var(--app-warn) 14%, transparent);
        color: var(--app-warn);
        font-size: 0.85em;
      }
      .blocker {
        font-weight: 500;
      }
    `,
  ],
})
export class SplitInstrumentDialog {
  protected readonly data = inject<SplitInstrumentData>(MAT_DIALOG_DATA);
  private readonly dialogRef = inject(MatDialogRef<SplitInstrumentDialog, boolean>);
  private readonly reference = inject(ReferenceApi);
  private readonly operationApi = inject(OperationApi);

  protected readonly isUndo = !!this.data.mergeId;
  protected readonly types = INSTRUMENT_TYPES;
  protected readonly sources = ['moex', 'cbr', 'binance', 'manual'] as const;

  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly confirmOrphan = signal(false);

  // ── ручное разделение ──
  private readonly instrument = computed(() => (this.reference.instruments.value() ?? []).find((i) => i.id === this.data.instrumentId));
  protected readonly newTicker = signal('');
  protected readonly newId = signal('');
  protected readonly newName = signal('');
  protected readonly newType = signal<InstrumentType>(this.instrument()?.type ?? 'Stock');
  protected readonly marketSource = signal<(typeof this.sources)[number]>('moex');
  protected readonly remainingName = signal('');
  protected readonly ops = computed(() =>
    (this.operationApi.operations.value() ?? []).filter((o) => o.instrumentId === this.data.instrumentId && !!o.id),
  );
  protected readonly selectedOps = signal<ReadonlySet<string>>(new Set());
  protected readonly codesResource = signal<{ key: string; origin: string }[]>([]);
  protected readonly codes = this.codesResource.asReadonly();
  protected readonly selectedCodes = signal<ReadonlySet<string>>(new Set());
  private readonly manualPreview = signal<SplitPlan | null>(null);

  // ── откат слияния ──
  protected readonly undo = signal<MergeUndoView | null>(null);
  protected readonly assignments = signal<Partial<Record<string, Side>>>({});
  /** Все неясные операции из первого ответа: назначенные не пропадают из списка, назначение можно поправить */
  protected readonly unclearOps = signal<MergeUndoView['plan']['unclear']>([]);
  /** Номер последнего запроса плана: устаревший ответ не перезаписывает свежий */
  private undoRequestSeq = 0;

  protected readonly previewData = computed(() => (this.isUndo ? this.undo()?.preview ?? null : this.manualPreview()?.preview ?? null));
  protected readonly warnings = computed(() => this.manualPreview()?.warnings ?? []);
  protected readonly errors = computed(() => this.manualPreview()?.errors ?? []);
  protected readonly orphanAppear = computed(() => {
    if (!this.isUndo) return this.manualPreview()?.orphanSellsAppear ?? false;
    const p = this.undo()?.preview;
    return !!p && (p.remaining.orphanSells > p.before.orphanSells || p.created.orphanSells > p.before.orphanSells);
  });
  protected readonly missingCodes = computed(() => this.undo()?.plan.identifiersMissing.map((c) => `${c.scheme}:${c.value}`).join(', ') ?? '');

  protected readonly canApply = computed(() => {
    if (this.busy()) return false;
    if (this.orphanAppear() && !this.confirmOrphan()) return false;
    if (this.isUndo) return !!this.undo() && this.undo()!.plan.errors.length === 0;
    const p = this.manualPreview();
    return !!p && p.errors.length === 0 && this.selectedOps().size > 0;
  });

  constructor() {
    if (this.isUndo) {
      void this.reloadUndo();
    } else {
      this.newName.set('');
      void this.loadCodes();
    }
  }

  protected rows(p: NonNullable<ReturnType<typeof this.previewData>>) {
    return [
      { label: 'Было', side: p.before },
      { label: this.isUndo ? 'Останется у цели' : `Останется у «${this.data.ticker}»`, side: p.remaining },
      { label: this.isUndo ? 'Источник (восстановится)' : 'Новый инструмент', side: p.created },
    ];
  }

  // ───────── ручной режим ─────────
  protected setTicker(v: string): void {
    // идентификатор по умолчанию совпадает с тикером, пока пользователь не правил его сам
    if (this.newId() === this.newTicker()) this.newId.set(v);
    this.newTicker.set(v);
    this.manualPreview.set(null);
  }

  protected resetPreview(): void {
    this.manualPreview.set(null);
    this.confirmOrphan.set(false);
  }

  protected toggleOp(id: string, checked: boolean): void {
    this.selectedOps.update((s) => toggled(s, id, checked));
    this.manualPreview.set(null);
  }

  protected toggleCode(key: string, checked: boolean): void {
    this.selectedCodes.update((s) => toggled(s, key, checked));
    this.manualPreview.set(null);
  }

  private async loadCodes(): Promise<void> {
    try {
      const res = await this.reference.instrumentIdentifiers(this.data.instrumentId);
      this.codesResource.set(res.entries.map((e) => ({ key: `${e.scheme}:${e.value}`, origin: e.origin })));
    } catch {
      this.failure.set('Не удалось загрузить коды инструмента.');
    }
  }

  private manualRequest() {
    return {
      newInstrument: {
        id: this.newId().trim(),
        ticker: this.newTicker().trim(),
        type: this.newType(),
        currency: this.instrument()?.currency ?? 'RUB',
        name: this.newName().trim() || null,
        marketSource: this.marketSource(),
      },
      operationIds: [...this.selectedOps()],
      identifierKeys: [...this.selectedCodes()],
      fieldPatches: this.remainingName().trim() ? { name: this.remainingName().trim() } : undefined,
      confirmOrphanSells: this.confirmOrphan(),
    };
  }

  protected async refreshPreview(): Promise<void> {
    this.failure.set(null);
    this.busy.set(true);
    try {
      this.manualPreview.set(await this.reference.splitPreview(this.data.instrumentId, this.manualRequest()));
    } catch (e) {
      this.failure.set(describe(e));
    } finally {
      this.busy.set(false);
    }
  }

  // ───────── откат ─────────
  protected assign(opId: string, side: Side): void {
    this.assignments.update((a) => ({ ...a, [opId]: side }));
    void this.reloadUndo();
  }

  protected assignAll(side: Side): void {
    this.assignments.update((a) => ({ ...a, ...Object.fromEntries(this.unclearOps().map((o) => [o.id, side])) }));
    void this.reloadUndo();
  }

  private assignmentLists() {
    const entries = Object.entries(this.assignments());
    return {
      toSource: entries.filter(([, s]) => s === 'source').map(([id]) => id),
      toTarget: entries.filter(([, s]) => s === 'target').map(([id]) => id),
    };
  }

  private async reloadUndo(): Promise<void> {
    const seq = ++this.undoRequestSeq;
    this.busy.set(true);
    this.failure.set(null);
    try {
      const view = await this.reference.undoPlan(this.data.mergeId!, this.assignmentLists());
      if (seq !== this.undoRequestSeq) return; // пришёл ответ на более новый запрос — этот устарел
      this.undo.set(view);
      this.unclearOps.update((known) => {
        const ids = new Set(known.map((o) => o.id));
        return [...known, ...view.plan.unclear.filter((o) => !ids.has(o.id))];
      });
    } catch (e) {
      if (seq === this.undoRequestSeq) this.failure.set(describe(e));
    } finally {
      if (seq === this.undoRequestSeq) this.busy.set(false);
    }
  }

  protected cancel(): void {
    this.dialogRef.close(false);
  }

  protected async apply(): Promise<void> {
    this.failure.set(null);
    this.busy.set(true);
    try {
      if (this.isUndo) {
        await this.reference.undoMerge(this.data.mergeId!, { assignments: this.assignmentLists(), confirmOrphanSells: this.confirmOrphan() });
      } else {
        await this.reference.splitInstrument(this.data.instrumentId, this.manualRequest());
      }
      this.dialogRef.close(true);
    } catch (e) {
      this.failure.set(describe(e));
      this.busy.set(false);
    }
  }
}

function toggled(set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

function describe(e: unknown): string {
  const body = (e as { error?: { message?: string } })?.error?.message;
  return body ?? (e instanceof Error ? e.message : 'Не удалось выполнить запрос.');
}
