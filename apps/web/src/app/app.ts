import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';

interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly icon: string;
}

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
  ],
  template: `
    <mat-toolbar color="primary">
      <button mat-icon-button (click)="opened.set(!opened())" aria-label="Меню">
        <mat-icon>menu</mat-icon>
      </button>
      <span>Investment Portfolio</span>
    </mat-toolbar>

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
      .shell {
        height: calc(100vh - 64px);
      }
      .content {
        padding: 24px;
      }
    `,
  ],
})
export class App {
  protected readonly opened = signal(true);

  protected readonly nav: readonly NavItem[] = [
    { path: 'dashboard', label: 'Дашборд', icon: 'dashboard' },
    { path: 'portfolio', label: 'Портфель', icon: 'account_balance_wallet' },
    { path: 'operations', label: 'Операции', icon: 'edit_note' },
    { path: 'trades', label: 'Сделки', icon: 'folder' },
    { path: 'import', label: 'Импорт', icon: 'upload_file' },
  ];
}
