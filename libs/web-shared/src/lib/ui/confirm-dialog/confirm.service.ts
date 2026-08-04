import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { ConfirmDialog, type ConfirmData } from './confirm-dialog';

/**
 * Спрашивает подтверждение. Обёртка нужна, чтобы вызов на месте оставался
 * однострочным — иначе замена `confirm()` на MatDialog утяжелила бы каждый из трёх
 * вызовов до пяти строк с ручной подпиской, и соблазн оставить нативный вызов был
 * бы велик.
 *
 * Возвращает Promise, а не Observable: диалог даёт ровно одно значение и
 * завершается, а вызывающий код — императивные обработчики (`await`), не потоки
 * (CLAUDE.md §5).
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly dialog = inject(MatDialog);

  async ask(data: ConfirmData): Promise<boolean> {
    const ref = this.dialog.open<ConfirmDialog, ConfirmData, boolean>(ConfirmDialog, {
      data,
      autoFocus: false,
      maxWidth: '95vw',
    });
    // Закрытие по Esc/клику вне окна отдаёт undefined — это отказ
    return (await firstValueFrom(ref.afterClosed())) ?? false;
  }
}
