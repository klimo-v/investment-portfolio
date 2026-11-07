import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { form, FormField, required } from '@angular/forms/signals';
import { extractErrorMessage } from '@web-shared';
import { ReferenceApi } from '../../entities/reference/reference.api';
import { StrategyListApi } from '../../entities/strategy/strategy-list.api';
import { StrategyApi } from '../../entities/strategy/strategy.api';

/** Значение селекта «Система» для создания новой системы вместе со стратегией */
const NEW_SYSTEM = '__new__';

/** Префикс файлов журнала автомата: `<префикс>_trades.csv` и т.д. (то же правило, что на бэкенде) */
const PREFIX_RE = /^[a-z][a-z0-9]*$/;

/**
 * Диалог «Новая стратегия»: торговая система (существующая без стратегии или новая),
 * портфель-счёт и префикс файлов журнала автомата в каталоге моста QUIK. Источник сейчас
 * один (мост QUIK), поэтому выбора адаптера нет. Ошибки сервера (занятый префикс и т.п.)
 * показываются как есть.
 */
@Component({
  selector: 'app-new-strategy-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, FormField],
  template: `
    <h2 mat-dialog-title>Новая стратегия</h2>
    <mat-dialog-content>
      <form class="form">
        <mat-form-field appearance="outline">
          <mat-label>Торговая система</mat-label>
          <select matNativeControl [formField]="f.systemId">
            <option [value]="newSystem">＋ Создать новую систему</option>
            @for (s of freeSystems(); track s.id) {
              <option [value]="s.id">{{ s.name }}</option>
            }
          </select>
        </mat-form-field>

        @if (isNewSystem()) {
          <mat-form-field appearance="outline">
            <mat-label>Название</mat-label>
            <input matInput [formField]="f.name" />
            @for (e of f.name().errors(); track e.kind) {
              <mat-error>{{ e.message }}</mat-error>
            }
          </mat-form-field>
        }

        <mat-form-field appearance="outline">
          <mat-label>Портфель (счёт)</mat-label>
          <select matNativeControl [formField]="f.portfolioId">
            <option value="" disabled>— выберите —</option>
            @for (p of portfolios(); track p.id) {
              <option [value]="p.id">{{ p.name }}</option>
            }
          </select>
          @for (e of f.portfolioId().errors(); track e.kind) {
            <mat-error>{{ e.message }}</mat-error>
          }
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Префикс журнала автомата</mat-label>
          <input matInput [formField]="f.journalPrefix" autocomplete="off" placeholder="например, zz" />
          <mat-hint>
            Файлы в каталоге моста: {{ prefixPreview() }}_trades.csv, {{ prefixPreview() }}_daily.csv, …
          </mat-hint>
          @if (prefixError(); as msg) {
            <mat-error>{{ msg }}</mat-error>
          }
        </mat-form-field>
      </form>

      @if (errorMessage()) {
        <p class="error">{{ errorMessage() }}</p>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button type="button" (click)="close()">Отмена</button>
      <button mat-flat-button type="button" [disabled]="!canSubmit() || saving()" (click)="submit()">
        Создать
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .form {
        display: grid;
        gap: 4px;
        min-width: min(420px, 80vw);
      }
      .error {
        color: var(--app-danger);
        margin: 8px 0 0;
      }
    `,
  ],
})
export class NewStrategyDialog {
  private readonly dialogRef = inject(MatDialogRef<NewStrategyDialog>);
  private readonly router = inject(Router);
  private readonly referenceApi = inject(ReferenceApi);
  private readonly strategyList = inject(StrategyListApi).list;
  private readonly strategyApi = inject(StrategyApi);

  protected readonly newSystem = NEW_SYSTEM;
  protected readonly portfolios = computed(() => this.referenceApi.portfolios.value() ?? []);

  /** Системы, у которых ещё нет стратегии */
  protected readonly freeSystems = computed(() => {
    const taken = new Set((this.strategyList.hasValue() ? this.strategyList.value() : []).map((s) => s.systemId));
    return (this.referenceApi.systems.value() ?? []).filter((s) => s.id && !taken.has(s.id));
  });

  protected readonly saving = signal(false);
  protected readonly errorMessage = signal('');

  private readonly model = signal({ systemId: NEW_SYSTEM, name: '', portfolioId: '', journalPrefix: '' });
  protected readonly f = form(this.model, (path) => {
    required(path.portfolioId, { message: 'Выберите портфель' });
    required(path.journalPrefix, { message: 'Укажите префикс журнала' });
  });

  protected readonly isNewSystem = computed(() => this.model().systemId === NEW_SYSTEM);
  protected readonly prefixPreview = computed(() => this.model().journalPrefix.trim() || '<префикс>');

  protected readonly prefixError = computed(() => {
    const p = this.model().journalPrefix.trim();
    return p !== '' && !PREFIX_RE.test(p) ? 'Латиница в нижнем регистре и цифры, начиная с буквы' : '';
  });

  protected readonly canSubmit = computed(() => {
    const m = this.model();
    return (
      m.portfolioId !== '' &&
      PREFIX_RE.test(m.journalPrefix.trim()) &&
      (m.systemId !== NEW_SYSTEM || m.name.trim() !== '')
    );
  });

  protected close(): void {
    this.dialogRef.close();
  }

  protected async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.errorMessage.set('');
    this.saving.set(true);
    try {
      const m = this.model();
      const created = await this.strategyApi.create({
        ...(m.systemId === NEW_SYSTEM ? { name: m.name.trim() } : { systemId: m.systemId }),
        portfolioId: m.portfolioId,
        params: { journalPrefix: m.journalPrefix.trim() },
      });
      // новая система появилась и в справочнике — обновим его для остальных диалогов
      this.referenceApi.systems.reload();
      this.dialogRef.close();
      await this.router.navigate(['/strategies', created.systemId]);
    } catch (err) {
      this.errorMessage.set(extractErrorMessage(err, 'Не удалось создать стратегию.'));
    } finally {
      this.saving.set(false);
    }
  }
}
