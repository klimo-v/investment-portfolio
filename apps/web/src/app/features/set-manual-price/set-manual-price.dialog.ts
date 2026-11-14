import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { form, FormField } from '@angular/forms/signals';

export interface SetManualPriceData {
  ticker: string;
  currency: string;
  /** Средняя цена покупки — стартовое значение, чтобы не вводить с нуля */
  avgBuyPrice: string;
  avgPriceCurrency: string;
  priceCurrency?: string | null;
  currentPrice?: string | null;
  /** Фьючерс: цена вводится в ₽ за контракт (с учётом множителя серии), а не за «штуку» */
  perContract?: boolean;
}

export interface SetManualPriceResult {
  price: string;
}

/**
 * Диалог ручной установки цены — для инструментов без автоматического источника
 * котировок (marketSource='manual'): бумага реальна и держится в портфеле, просто
 * взять цену неоткуда (нет на MOEX/Binance под этим тикером), в отличие от
 * дубль-инструмента, которому нужен MergeInstrumentDialog, а не своя цена.
 */
@Component({
  selector: 'app-set-manual-price-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, FormField],
  template: `
    <h2 mat-dialog-title>
      {{ data.currentPrice == null ? 'Указать цену' : 'Изменить цену' }} «{{ data.ticker }}» вручную
    </h2>
    <mat-dialog-content>
      <p class="muted">
        Для «{{ data.ticker }}» нет автоматического источника котировок — «Обновить цены» её не
        тронет, обновлять придётся самостоятельно.
      </p>
      <mat-form-field appearance="outline">
        <mat-label>{{
          data.perContract ? 'Цена, ₽ за контракт' : 'Цена, ' + data.currency
        }}</mat-label>
        <input matInput type="number" [formField]="priceForm.price" />
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()">Отмена</button>
      <button mat-flat-button color="primary" [disabled]="!isValid()" (click)="apply()">
        Сохранить
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      mat-dialog-content {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
      }
      .muted {
        margin: 0 0 8px;
        color: var(--app-text-muted);
      }
    `,
  ],
})
export class SetManualPriceDialog {
  private readonly dialogRef = inject(MatDialogRef<SetManualPriceDialog, SetManualPriceResult>);
  protected readonly data = inject<SetManualPriceData>(MAT_DIALOG_DATA);

  private readonly model = signal({ price:
    this.data.currentPrice != null && this.data.priceCurrency === this.data.currency
      ? this.data.currentPrice
      : this.data.avgPriceCurrency === this.data.currency ? this.data.avgBuyPrice : '',
  });
  protected readonly priceForm = form(this.model);

  protected readonly isValid = computed(() => {
    const price = Number(this.model().price);
    return Number.isFinite(price) && price > 0;
  });

  protected cancel(): void {
    this.dialogRef.close();
  }

  protected apply(): void {
    if (!this.isValid()) return;
    this.dialogRef.close({ price: this.model().price.trim() });
  }
}
