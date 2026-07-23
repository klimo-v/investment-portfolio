import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { form, FormField, required } from '@angular/forms/signals';
import { OperationApi } from '../../entities/operation/operation.api';
import { ReferenceApi } from '../../entities/reference/reference.api';
import type { Operation } from '@core';

/** Типы операций для выпадающего списка */
const OPERATION_TYPES = [
  'Buy',
  'Sell',
  'Deposit',
  'Withdraw',
  'Dividend',
  'Coupon',
  'Tax',
  'Fee',
  'Transfer',
] as const;

/**
 * Диалог добавления операции на Signal Forms (docs/03-ux-plan.md, шаг 1).
 * Поля адаптируются под тип операции; валидация декларативная в схеме формы.
 */
@Component({
  selector: 'app-add-operation-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    FormField,
  ],
  template: `
    <h2 mat-dialog-title>Новая операция</h2>
    <mat-dialog-content>
      <form class="op-form">
        <mat-form-field appearance="outline">
          <mat-label>Тип операции</mat-label>
          <select matNativeControl [formField]="opForm.operationType">
            @for (t of operationTypes; track t) {
              <option [value]="t">{{ t }}</option>
            }
          </select>
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Дата</mat-label>
          <input matInput type="date" [formField]="opForm.date" />
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Система</mat-label>
          <select matNativeControl [formField]="opForm.systemId">
            <option value="" disabled>— выберите —</option>
            @for (s of systems(); track s.id) {
              <option [value]="s.id">{{ s.name }}</option>
            }
          </select>
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Портфель</mat-label>
          <select matNativeControl [formField]="opForm.portfolioId">
            <option value="" disabled>— выберите —</option>
            @for (p of portfolios(); track p.id) {
              <option [value]="p.id">{{ p.name }}</option>
            }
          </select>
        </mat-form-field>

        @if (needsInstrument()) {
          <mat-form-field appearance="outline">
            <mat-label>Инструмент</mat-label>
            <select matNativeControl [formField]="opForm.instrumentId">
              <option value="" disabled>— выберите —</option>
              @for (i of instruments(); track i.id) {
                <option [value]="i.id">{{ i.ticker }}</option>
              }
            </select>
          </mat-form-field>
        }

        @if (needsQuantityPrice()) {
          <mat-form-field appearance="outline">
            <mat-label>Количество</mat-label>
            <input matInput type="number" [formField]="opForm.quantity" />
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Цена</mat-label>
            <input matInput type="number" [formField]="opForm.price" />
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Комиссия</mat-label>
            <input matInput type="number" [formField]="opForm.fee" />
          </mat-form-field>
        }

        @if (isCashAmount()) {
          <mat-form-field appearance="outline">
            <mat-label>Сумма</mat-label>
            <input matInput type="number" [formField]="opForm.price" />
          </mat-form-field>
        }

        <mat-form-field appearance="outline">
          <mat-label>Валюта</mat-label>
          <input matInput [formField]="opForm.currency" />
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Курс к RUB</mat-label>
          <input matInput type="number" [formField]="opForm.fxRate" />
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Примечание</mat-label>
          <input matInput [formField]="opForm.note" />
        </mat-form-field>
      </form>

      @if (errorMessage()) {
        <p class="error">{{ errorMessage() }}</p>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="close()">Отмена</button>
      <button
        mat-flat-button
        color="primary"
        [disabled]="opForm().invalid() || saving()"
        (click)="save()"
      >
        {{ saving() ? 'Сохранение…' : 'Сохранить' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .op-form {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px 16px;
        min-width: 480px;
        padding-top: 8px;
      }
      .op-form mat-form-field {
        width: 100%;
      }
      .error {
        color: #c62828;
        margin: 8px 0 0;
      }
    `,
  ],
})
export class AddOperationDialog {
  private readonly dialogRef = inject(MatDialogRef<AddOperationDialog>);
  private readonly operationApi = inject(OperationApi);
  private readonly referenceApi = inject(ReferenceApi);

  protected readonly operationTypes = OPERATION_TYPES;
  protected readonly saving = signal(false);
  protected readonly errorMessage = signal('');

  protected readonly systems = computed(() => this.referenceApi.systems.value() ?? []);
  protected readonly portfolios = computed(() => this.referenceApi.portfolios.value() ?? []);
  protected readonly instruments = computed(() => this.referenceApi.instruments.value() ?? []);

  /** Модель формы. undefined недопустим — все поля с дефолтами (Signal Forms). */
  private readonly model = signal({
    operationType: 'Buy' as (typeof OPERATION_TYPES)[number],
    date: new Date().toISOString().slice(0, 10),
    systemId: '',
    portfolioId: '',
    instrumentId: '',
    quantity: '1',
    price: '0',
    fee: '0',
    currency: 'RUB',
    fxRate: '1',
    note: '',
  });

  protected readonly opForm = form(this.model, (path) => {
    required(path.date, { message: 'Укажите дату' });
    required(path.systemId, { message: 'Выберите систему' });
    required(path.portfolioId, { message: 'Выберите портфель' });
  });

  /** Нужен ли выбор инструмента под текущий тип операции */
  protected readonly needsInstrument = computed(() => {
    const t = this.model().operationType;
    return t === 'Buy' || t === 'Sell' || t === 'Dividend' || t === 'Coupon';
  });

  protected readonly needsQuantityPrice = computed(() => {
    const t = this.model().operationType;
    return t === 'Buy' || t === 'Sell';
  });

  protected readonly isCashAmount = computed(() => {
    const t = this.model().operationType;
    return t === 'Deposit' || t === 'Withdraw' || t === 'Dividend' || t === 'Coupon' || t === 'Tax';
  });

  protected close(): void {
    this.dialogRef.close(false);
  }

  protected async save(): Promise<void> {
    this.errorMessage.set('');
    this.saving.set(true);
    try {
      const m = this.model();
      const payload: Operation = {
        date: m.date,
        systemId: m.systemId,
        portfolioId: m.portfolioId,
        instrumentId: this.needsInstrument() ? m.instrumentId : null,
        operationType: m.operationType,
        quantity: m.quantity,
        price: m.price,
        fee: m.fee,
        fxRate: m.fxRate,
        currency: m.currency,
        note: m.note || undefined,
      };
      await this.operationApi.add(payload);
      this.dialogRef.close(true);
    } catch (err) {
      this.errorMessage.set('Не удалось сохранить операцию. Проверьте поля.');
    } finally {
      this.saving.set(false);
    }
  }
}
