import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { I18nService } from '../../core/i18n.service';

/** One step of the trail. The last item is the current page and never links,
 *  even if it carries a `link`.
 *
 *  `labelKey` (an i18n key) wins over `label` when both are given: it is
 *  resolved at render time, so a static trail built once still follows a
 *  language switch without the page having to rebuild the array. */
export interface BreadcrumbItem {
  label?: string;
  labelKey?: string;
  /** In-site path, e.g. `'/'` or `['/search']`. Rendered through
   *  `regionLink`, so it must NOT already carry the region prefix. */
  link?: any[] | string;
  queryParams?: Record<string, any>;
}

/** The nav's accessible name. */
const NAV_LABEL_KEY = 'common.breadcrumb';

/**
 * `<ui-breadcrumb [items]="...">` — the "where am I" trail for pages that can
 * be entered cold from a shared link or a search engine, where the back
 * button has no history to offer.
 *
 * Links go through `regionLink`, never a bare `routerLink`: without it the
 * region prefix is dropped and the trail navigates out of the active region.
 */
@Component({
  selector: 'ui-breadcrumb',
  standalone: true,
  imports: [CommonModule, RegionLinkDirective],
  template: `
    <nav class="breadcrumb" [attr.aria-label]="navLabel" *ngIf="items.length > 0">
      <ol>
        <li *ngFor="let item of items; let i = index; let last = last; trackBy: trackByItem">
          <!-- The separator is drawn by CSS on this empty span so no reader
               ever announces it as text. -->
          <span class="crumb-sep" aria-hidden="true" *ngIf="i > 0"></span>
          <a *ngIf="item.link && !last" class="crumb-link" [regionLink]="item.link" [queryParams]="item.queryParams">{{ labelOf(item) }}</a>
          <span *ngIf="!item.link || last" class="crumb-current" [attr.aria-current]="last ? 'page' : null">{{ labelOf(item) }}</span>
        </li>
      </ol>
    </nav>
  `,
  styles: [`
    /* Phones show the layout's app bar (back + page title) on the pages that
       use this breadcrumb, so it would only repeat it. Same breakpoint as the
       app bar in layout.component.css. */
    @media (max-width: 900px) {
      :host { display: none; }
    }
    .breadcrumb {
      margin-bottom: var(--space-4);
    }
    ol {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-1);
      list-style: none;
      margin: 0;
      padding: 0;
      font-size: var(--text-sm);
      line-height: 1.4;
    }
    li {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      min-width: 0;
    }
    .crumb-sep::before {
      content: '›';
      color: var(--line-strong);
    }
    .crumb-link {
      color: var(--muted);
      text-decoration: none;
    }
    .crumb-link:hover {
      color: var(--ink);
      text-decoration: underline;
    }
    .crumb-current {
      color: var(--ink-soft);
      font-weight: 500;
      /* Book titles can run long; keep the trail on one line instead of
         letting it wrap into a paragraph above the page heading. */
      max-width: 32ch;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `]
})
export class UiBreadcrumb {
  @Input() items: BreadcrumbItem[] = [];

  private i18n = inject(I18nService);

  get navLabel(): string {
    return this.i18n.t(NAV_LABEL_KEY);
  }

  labelOf(item: BreadcrumbItem): string {
    return item.labelKey ? this.i18n.t(item.labelKey) : (item.label ?? '');
  }

  /** Keyed on what the crumb actually is, so a caller exposing `items` as a
   *  getter (a fresh array every change detection run) doesn't tear down and
   *  rebuild the trail's DOM on every cycle. */
  trackByItem(index: number, item: BreadcrumbItem): string {
    return `${item.labelKey ?? item.label ?? ''}|${JSON.stringify(item.link ?? '')}`;
  }
}
