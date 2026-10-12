import { Component, inject } from '@angular/core';
import { TPipe } from '../../core/i18n.service';
import { SeoService } from '../../core/services/seo.service';
import { NavigationHistoryService } from '../../core/services/navigation-history.service';

/**
 * The phone header of a page pushed over a tab (a book, a listing, a seller,
 * checkout...): back, and the page's name centred between equal-width sides.
 * The layout renders it in place of the logo header on those pages; on wide
 * screens it never shows.
 *
 * The title is the page's SEO name, so every page that sets its title gets
 * one here without doing anything else.
 *
 * Back returns to the previous page (NavigationHistoryService), not the
 * previous URL, and is hidden when this session has no earlier page — after
 * a reload, or arriving from a shared link.
 */
@Component({
  selector: 'ui-app-bar',
  standalone: true,
  imports: [TPipe],
  template: `
    @if (navHistory.canGoBack) {
      <button type="button" class="back" (click)="navHistory.goBack()" [attr.aria-label]="'common.back' | t">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" aria-hidden="true">
          <path d="M15 5l-7 7 7 7"/>
        </svg>
      </button>
    } @else {
      <span aria-hidden="true"></span>
    }
    <span class="title">{{ seo.pageName() }}</span>
    <span aria-hidden="true"></span>
  `,
  styles: [`
    :host {
      display: none;
    }
    /* Same breakpoint as the layout's mobile header. */
    @media (max-width: 900px) {
      :host {
        display: grid;
        grid-template-columns: 48px minmax(0, 1fr) 48px;
        align-items: center;
        min-height: 52px;
        padding: 0 4px;
      }
    }
    .back {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      border: none;
      border-radius: 50%;
      background: none;
      color: var(--ink);
      cursor: pointer;
    }
    .back:active {
      background: var(--paper-warm);
    }
    .title {
      font-size: var(--text-base);
      font-weight: 600;
      text-align: center;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `]
})
export class UiAppBar {
  readonly seo = inject(SeoService);
  readonly navHistory = inject(NavigationHistoryService);
}
