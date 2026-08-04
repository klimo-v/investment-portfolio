import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { LoadingService, ThemeService, type ThemeMode } from '@web-shared';

interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly icon: string;
}

/**
 * Иконка и подпись кнопки темы. Подпись описывает и текущее состояние, и результат
 * нажатия: у иконки-кнопки без текста иначе нет способа сообщить, что она вообще
 * делает и в каком режиме находится.
 */
const THEME_UI: Record<ThemeMode, { icon: string; label: string }> = {
  light: { icon: 'light_mode', label: 'Тема: светлая. Переключить на тёмную' },
  dark: { icon: 'dark_mode', label: 'Тема: тёмная. Переключить на системную' },
  system: { icon: 'brightness_auto', label: 'Тема: как в системе. Переключить на светлую' },
};

/**
 * Корневой компонент-оболочка: боковое меню + область роутов.
 * Standalone, OnPush, signals, нативный control flow (CLAUDE.md §3).
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatToolbarModule,
    MatSidenavModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatProgressBarModule,
    MatTooltipModule,
  ],
  template: `
    <div class="toolbar-wrap">
      <mat-toolbar color="primary">
        <button mat-icon-button (click)="opened.set(!opened())" aria-label="Меню">
          <mat-icon>menu</mat-icon>
        </button>
        <span>Investment Portfolio</span>
        <span class="toolbar-spacer"></span>
        <button
          mat-icon-button
          (click)="theme.cycle()"
          [attr.aria-label]="themeLabel()"
          [matTooltip]="themeLabel()"
        >
          <mat-icon>{{ themeIcon() }}</mat-icon>
        </button>
      </mat-toolbar>
      @if (loading.isLoading()) {
        <mat-progress-bar mode="indeterminate" class="global-progress" />
      }
    </div>

    <mat-sidenav-container class="shell">
      <mat-sidenav mode="side" [opened]="opened()">
        <mat-nav-list>
          @for (item of nav; track item.path) {
            <a
              mat-list-item
              [routerLink]="item.path"
              routerLinkActive
              #rla="routerLinkActive"
              [activated]="rla.isActive"
            >
              <mat-icon matListItemIcon>{{ item.icon }}</mat-icon>
              <span matListItemTitle>{{ item.label }}</span>
            </a>
          }
        </mat-nav-list>
      </mat-sidenav>

      <mat-sidenav-content class="content">
        <router-outlet />
      </mat-sidenav-content>
    </mat-sidenav-container>
  `,
  styles: [
    `
      .toolbar-wrap {
        position: relative;
      }
      .toolbar-spacer {
        flex: 1;
      }
      .global-progress {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
      }
      .shell {
        height: calc(100vh - 64px);
      }
      mat-sidenav {
        border-right: 1px solid var(--app-outline);
        background: var(--app-sidenav-bg);
      }
      .content {
        display: flex;
        flex-direction: column;
        padding: var(--app-page-pad);
        box-sizing: border-box;
        height: 100%;
      }
    `,
  ],
})
export class App {
  protected readonly loading = inject(LoadingService);
  protected readonly theme = inject(ThemeService);
  protected readonly opened = signal(true);

  protected readonly themeIcon = computed(() => THEME_UI[this.theme.mode()].icon);
  /** Подпись описывает и текущее состояние, и результат нажатия — иначе кнопка «немая» */
  protected readonly themeLabel = computed(() => THEME_UI[this.theme.mode()].label);

  protected readonly nav: readonly NavItem[] = [
    { path: 'dashboard', label: 'Дашборд', icon: 'dashboard' },
    { path: 'portfolio', label: 'Портфель', icon: 'account_balance_wallet' },
    { path: 'operations', label: 'Операции', icon: 'edit_note' },
    { path: 'trades', label: 'Сделки', icon: 'folder' },
    { path: 'import', label: 'Импорт', icon: 'upload_file' },
  ];
}
