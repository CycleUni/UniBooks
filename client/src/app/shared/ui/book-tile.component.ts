import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { TPipe } from '../../core/i18n.service';
import { CountCapPipe } from '../pipes/count-cap.pipe';
import { PricePipe } from '../pipes/price.pipe';
import { UiBookCover } from './book-cover.component';

/**
 * `book-tile`: a bookstore-catalog-style card for the Book-discovery layer
 * (home "recently added"/"most wanted", search results). Distinct from
 * `ui-listing-row`/`ui-listing-card`, which render real per-seller Listings
 * with marketplace chrome — this component only ever represents a Book.
 *
 * `mode` switches what the stamp tag and the sub-title line show:
 * - 'sellers' (default): price stamp + "N sellers" line, for normal
 *   book-discovery contexts where the book has active listings.
 * - 'waitlist': waiting-count stamp (in the --flag hue) and no seller/price
 *   line, for "most wanted" contexts where a book may have zero listings.
 *
 * The tile body is a real anchor whenever the caller supplies `link` — it
 * used to be a bare `<div (click)>`, which meant the single most important
 * interaction on the home page (open a book) was unreachable by keyboard and
 * invisible to screen readers, and lost middle-click/"open in new tab"/SEO
 * along the way. Callers that still navigate imperatively get a `<button>`
 * instead of a div, so those stay focusable too.
 *
 * Projected `[tile-actions]` content is deliberately a *sibling* of that
 * anchor, not a child: those slots hold real buttons, and interactive
 * elements cannot be nested inside a link without breaking both HTML
 * validity and keyboard traversal.
 */
@Component({
  selector: 'ui-book-tile',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, TPipe, UiBookCover, CountCapPipe, PricePipe],
  template: `
    <div class="book-tile" [class.feature]="feature">
      <a
        *ngIf="link"
        class="tile-body hover-card"
        [regionLink]="link"
        [queryParams]="linkParams"
        [state]="linkState"
        (click)="tileClick.emit()"
      >
        <ng-container *ngTemplateOutlet="body"></ng-container>
      </a>

      <button *ngIf="!link" type="button" class="tile-body hover-card" (click)="tileClick.emit()">
        <ng-container *ngTemplateOutlet="body"></ng-container>
      </button>

      <ng-template #body>
        <span class="tile-cover hover-card-cover">
          <ui-book-cover
            [coverUrl]="coverUrl"
            [title]="title"
            [author]="author"
            [isbn]="isbn"
            [zoom]="3"
            [priority]="priority"
          ></ui-book-cover>

          <span class="price-tag stamp-tag" *ngIf="mode === 'sellers'" [class.unpriced]="!hasPrice">
            <ng-container *ngIf="hasPrice && !isFree">
              {{ (isFromPrice ? 'bookTile.priceFrom' : 'bookTile.price') | t:{price: (priceValue | price)} }}
            </ng-container>
            <ng-container *ngIf="hasPrice && isFree">
              {{ 'bookTile.priceFree' | t }}
            </ng-container>
            <ng-container *ngIf="!hasPrice">{{ 'bookTile.priceUnknown' | t }}</ng-container>
          </span>
          <!-- Only when someone actually is waiting. A "0 waiting" stamp on a
               book nobody has asked for states the absence of demand as though
               it were a metric — the same trap as printing NT$ 0 for a book
               with no price. -->
          <span class="price-tag stamp-tag waitlist" *ngIf="mode === 'waitlist' && hasWaiting">
            {{ 'home.waitingCount' | t:{n: waitingValue | countCap} }}
          </span>
        </span>

        <h3 class="tile-title book-title-serif">{{ title }}</h3>
        <span class="tile-meta" *ngIf="author || isbn">
          <span *ngIf="author">{{ author }}</span><span *ngIf="isbn"><ng-container *ngIf="author"> · </ng-container>{{ isbn }}</span>
        </span>

        <span class="tile-sellers card-subtext" *ngIf="mode === 'sellers'">
          {{ (sellerCount === 1 ? 'bookTile.sellerCountOne' : 'bookTile.sellerCount') | t:{n: (sellerCount ?? 0) | countCap} }}
        </span>
        <!-- Condition is the single fact a used-book buyer decides on, and it
             was only visible after opening the detail page — the tile read as
             a new-book catalogue entry. -->
        <span class="tile-conditions" *ngIf="mode === 'sellers' && conditionKeys.length">
          <span class="cond-chip" *ngFor="let c of conditionKeys">{{ ('cond.' + c) | t }}</span>
        </span>
      </ng-template>

      <div class="tile-actions">
        <ng-content select="[tile-actions]"></ng-content>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }
    /* Deliberately no border/background/padding on the tile itself — a
       boxed shape reads as a "card" regardless of how light the border is,
       which collapses the intended distinction from ui-listing-card's
       marketplace styling (that one DOES get a real border, on purpose,
       see its own component). Here the cover image's own shadow is what
       gives the tile presence, same as the approved mockup: the book sits
       on the page like a photo, not inside a frame. */
    .book-tile {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-width: 0;
    }
    /* Resets so the anchor/button carrying the tile keeps looking like the
       old div: both ship UA styles (button centres text, adds a border and
       its own font) that would otherwise redraw every tile. */
    .tile-body {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      text-align: left;
      width: 100%;
      min-width: 0;
      padding: 0;
      border: none;
      background: none;
      font: inherit;
      color: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    .tile-cover {
      position: relative;
      display: block;
      aspect-ratio: 5 / 7;
      border-radius: var(--radius-xs);
      background-color: var(--surface-card);
      box-shadow: var(--shadow-card);
      margin-bottom: var(--space-3);
      transition: box-shadow var(--motion-base) ease, transform var(--motion-base) ease;
    }
    /* The "feature" tile is meant to look larger/more prominent than a
       regular tile, not differently-shaped: real book covers are portrait
       (scanned/photographed at a fixed ratio), so forcing a landscape
       aspect-ratio here would crop title art off the top/bottom. It stays
       5:7 like a regular tile and gets its size purely from spanning more
       grid columns/rows in the parent layout (see recent-listings.component
       / search.ts's .discover-grid). */
    /* shape comes from the global .stamp-tag */
    .price-tag { left: -6px; bottom: -6px; color: var(--accent); }
    /* A book whose aggregate price is 0/absent used to print "NT$ 0" in the
       most prominent spot on the tile, which reads as a real price and is the
       fastest way to lose a marketplace's credibility. */
    .price-tag.unpriced {
      color: var(--muted);
      font-family: inherit;
      font-weight: 500;
    }
    .price-tag.waitlist {
      color: var(--flag);
    }
    .tile-title {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      margin: 0 0 var(--space-1);
      font-size: var(--text-base);
      font-weight: 700;
      line-height: 1.3;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    /* Deliberately stays below --text-xl (.section-heading's size, 20px):
       a feature-tile title that size would tie visually with the section
       heading above it instead of reading as one level down. */
    .book-tile.feature .tile-title {
      font-size: var(--text-lg);
    }
    .tile-meta {
      display: block;
      margin: 0 0 var(--space-1);
      font-size: var(--text-sm);
      color: var(--muted);
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .tile-actions:empty {
      display: none;
    }
    .tile-actions {
      margin-top: var(--space-2);
    }
  `]
})
export class UiBookTile {
  @Input() coverUrl?: string;
  @Input() title: string = '';
  @Input() author?: string;
  @Input() isbn?: string;
  @Input() feature: boolean = false;
  /** Passed to the cover; see UiBookCover.priority. */
  @Input() priority = false;
  @Input() mode: 'sellers' | 'waitlist' = 'sellers';

  /**
   * Router target for the tile. When set, the tile renders as a real anchor
   * with an href; when omitted it falls back to a `<button>` and the caller
   * handles navigation in `(tileClick)`.
   */
  @Input() link?: any[] | string;
  @Input() linkParams?: Record<string, any>;
  /** Router navigation state for the link — kept out of the href, see bookPreviewState(). */
  @Input() linkState?: Record<string, any>;

  // mode: 'sellers'
  /** Number of active listings for this book, not distinct sellers. */
  @Input() sellerCount?: number;
  /** Map of condition slug -> number of listings, as returned by recent_books/. */
  @Input() conditions?: Record<string, number> | null;
  @Input() minPrice: number | null = null;
  /** minPrice is the cheapest of copies priced differently, so it reads "from". */
  @Input() isFromPrice: boolean = false;

  // mode: 'waitlist'
  @Input() waitingCount?: number;

  @Output() tileClick = new EventEmitter<void>();

  /** Treat a missing or negative aggregate as "no price known yet". */
  get hasPrice(): boolean {
    return this.minPrice !== null && this.minPrice !== undefined && this.minPrice >= 0;
  }

  get isFree(): boolean {
    return this.minPrice === 0;
  }

  /**
   * Condition slugs present for this book, most-listed first and capped at
   * two so the tile previews what a buyer would find without turning into a
   * tag cloud.
   */
  get conditionKeys(): string[] {
    if (!this.conditions) return [];
    return Object.entries(this.conditions)
      .filter(([, n]) => Number(n) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 2)
      .map(([slug]) => slug);
  }

  /** Narrowed for the template: only read when hasPrice is true. */
  get priceValue(): number {
    return this.minPrice ?? 0;
  }

  /** An *ngIf guard does not narrow the expression's type, so these do it. */
  get hasWaiting(): boolean {
    return (this.waitingCount ?? 0) > 0;
  }
  get waitingValue(): number {
    return this.waitingCount ?? 0;
  }
}

