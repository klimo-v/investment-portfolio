import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { MergedIdentifiersDialog } from './merged-identifiers.dialog';

/**
 * Кнопка «Привязанные коды» (вместо раскрытой карточки — она занимала много места на странице).
 * Показывается, только если есть инструменты со слитыми кодами; подозрительное слияние
 * (больше одного биржевого тикера) подсвечивается. Вся информация — в модалке.
 */
@Component({
  selector: 'app-merged-identifiers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule],
  template: `
    @if (items().length > 0) {
      <div class="row">
        <button mat-stroked-button (click)="open()">
          <mat-icon>{{ suspicious() > 0 ? 'warning' : 'link' }}</mat-icon>
          Привязанные коды ({{ items().length }})
        </button>
        @if (suspicious() > 0) {
          <span class="warn">Подозрительных слияний: {{ suspicious() }}</span>
        }
      </div>
    }
  `,
  styles: [
    `
      .row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 16px;
      }
      .warn {
        color: var(--app-warn);
        font-weight: 500;
      }
    `,
  ],
})
export class MergedIdentifiersCard {
  private readonly reference = inject(ReferenceApi);
  private readonly dialog = inject(MatDialog);

  protected readonly items = computed(() => this.reference.mergedIdentifiers.value() ?? []);
  protected readonly suspicious = computed(() => this.items().filter((i) => i.conflicting).length);

  protected open(): void {
    this.dialog.open(MergedIdentifiersDialog, { autoFocus: false, maxWidth: '95vw' });
  }
}
