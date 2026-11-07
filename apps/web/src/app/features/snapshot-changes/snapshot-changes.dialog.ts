import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import type { SnapshotInvalidationKind, SnapshotStaleness } from '@core';

/** Что пользователь выбрал в модалке; undefined — закрыл, ничего не делая */
export type SnapshotChangesResult = 'acknowledge' | 'clear';

/** Человекочитаемое «что произошло с журналом» — enum с бэка сам по себе непонятен */
const KIND_LABELS: Record<SnapshotInvalidationKind, string> = {
  add: 'добавлена задним числом',
  delete: 'удалена',
  reassign: 'переназначена',
  merge: 'слияние инструментов',
  'import-commit': 'импортированы задним числом',
  'import-rollback': 'откат импорта',
  'strategy-sync': 'пересчёт результата стратегии',
};

/**
 * «Что изменилось после снимков» — таблица правок журнала операций, из-за которых
 * накопленным снимкам нельзя доверять.
 *
 * Раньше на такую правку история снимков просто стиралась целиком: одна удалённая
 * операция уносила месяцы точек графика. Теперь история сохраняется, а пользователь
 * видит здесь, что именно разъехалось, и сам решает — «понятно, скрыть» (цифры
 * остаются, предупреждение гаснет) или «очистить историю» (начать копить заново).
 *
 * Почему снимки нельзя просто пересчитать: снимок кумулятивен (весь журнал на дату
 * захвата), а дневных цен по каждой бумаге в системе нет — есть только текущая
 * котировка. Восстановить прошлую стоимость под исправленные данные не из чего.
 */
@Component({
  selector: 'app-snapshot-changes-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>Что изменилось после снимков</h2>
    <mat-dialog-content>
      <p class="warn-note">
        @if (data.staleSince; as since) {
          Снимкам с {{ since }} доверять нельзя.
        } @else {
          Снимкам доверять нельзя.
        }
        Они посчитаны по журналу операций, который с тех пор изменился задним числом, а пересчитать
        их не из чего: дневных цен по каждой бумаге в системе нет — только текущая котировка.
      </p>

      @if (data.entries.length > 0) {
        <!-- nowrap-колонки на узком экране вылезают за диалог — скроллим таблицу, не страницу -->
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Когда</th>
                <th>Что произошло</th>
                <th>Операция</th>
                <th>Тикер</th>
                <th>Дата операции</th>
              </tr>
            </thead>
            <tbody>
              @for (e of data.entries; track e.id) {
                <tr [class.acknowledged]="e.acknowledged">
                  <td>{{ e.at }}</td>
                  <td>{{ kindLabel(e.kind) }}</td>
                  <td>{{ e.description }}</td>
                  <td>{{ e.ticker ?? '—' }}</td>
                  <td>{{ e.operationDate }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="muted">Бледные строки вы уже отмечали как просмотренные.</p>
      } @else {
        <p class="muted">Изменений не зафиксировано.</p>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="close()">Закрыть</button>
      <button mat-button color="warn" (click)="clear()">Очистить историю снимков</button>
      <button mat-flat-button (click)="acknowledge()">Понятно, скрыть</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      mat-dialog-content {
        min-width: min(720px, 90vw);
      }
      .warn-note {
        margin: 0 0 12px;
        padding: 8px;
        border-radius: 4px;
        background: color-mix(in srgb, var(--app-warn) 12%, transparent);
        color: var(--app-warn);
        font-size: 0.85em;
      }
      .muted {
        margin: 8px 0 0;
        color: var(--app-text-muted);
        font-size: 0.85em;
      }
      .scroll {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      th,
      td {
        text-align: left;
        padding: 6px 8px;
        border-bottom: 1px solid var(--app-outline);
        white-space: nowrap;
      }
      th {
        color: var(--app-text-muted);
        font-weight: 500;
      }
      /* уже просмотренные записи не убираем — они объясняют, почему история рваная */
      tr.acknowledged td {
        color: var(--app-text-muted);
      }
    `,
  ],
})
export class SnapshotChangesDialog {
  private readonly dialogRef = inject(
    MatDialogRef<SnapshotChangesDialog, SnapshotChangesResult>,
  );
  protected readonly data = inject<SnapshotStaleness>(MAT_DIALOG_DATA);

  protected kindLabel(kind: SnapshotInvalidationKind): string {
    return KIND_LABELS[kind];
  }

  protected close(): void {
    this.dialogRef.close();
  }

  protected acknowledge(): void {
    this.dialogRef.close('acknowledge');
  }

  protected clear(): void {
    this.dialogRef.close('clear');
  }
}
