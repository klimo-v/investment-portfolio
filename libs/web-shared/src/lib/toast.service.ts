import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';

/**
 * Единая точка показа тостов (CLAUDE.md: единообразная обратная связь по всем
 * серверным операциям). Обёртка над MatSnackBar — панельные классы стилизуют
 * успех/ошибку/инфо в глобальном styles.scss (снэкбар рендерится в оверлее,
 * вне дерева компонента, поэтому стили не могут быть локальными).
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly snackBar = inject(MatSnackBar);

  success(message: string): void {
    this.snackBar.open(message, 'Закрыть', { duration: 4000, panelClass: 'toast-success' });
  }

  error(message: string): void {
    this.snackBar.open(message, 'Закрыть', { duration: 6000, panelClass: 'toast-error' });
  }

  info(message: string): void {
    this.snackBar.open(message, 'Закрыть', { duration: 4000, panelClass: 'toast-info' });
  }
}
