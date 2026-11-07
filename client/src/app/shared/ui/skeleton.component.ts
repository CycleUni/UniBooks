import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TPipe } from '../../core/i18n.service';

/**
 * Loading placeholder.
 *
 * The shape has to match what actually arrives, or the "placeholder" causes
 * the layout shift it exists to prevent. There used to be exactly one shape —
 * a horizontal 88x124 cover beside two text bars — and it was being used to
 * stand in for a grid of portrait book tiles and for a list of one-line
 * waitlist rows as well, so two of its three call sites snapped to a
 * completely different layout the moment data landed.
 */
@Component({
  selector: 'ui-skeleton',
  standalone: true,
  imports: [CommonModule, TPipe],
  template: `
    <div class="skeleton" [ngClass]="variant === 'discover-grid' ? 'discover-grid' : 'v-' + variant" [class.with-thumb]="thumb" role="status" aria-busy="true">
      <!-- The whole block used to be aria-hidden, so a screen reader was told
           nothing at all was happening while these four call sites waited on
           the network — the plain-text "loading" states elsewhere at least
           said something. The shapes themselves carry no text, so the only
           thing to announce is this label. -->
      <span class="sr-only" *ngIf="variant !== 'spinner'">{{ 'common.loading' | t }}</span>
      <ng-container [ngSwitch]="variant">

        <!-- Admin pages: a ring and a visible label instead of a shape. The
             admin screens are tables, KPI cards and read-only field grids that
             change shape page by page, and one generic shape that is wrong for
             most of them only promised a layout that never arrived. -->
        <ng-container *ngSwitchCase="'spinner'">
          <span class="s-spinner" aria-hidden="true"></span>
          <span class="s-spinner-label">{{ 'common.loading' | t }}</span>
        </ng-container>

        <!-- Title left, count right. With [thumb], a small cover leads each
             row, as in the home waitlist. -->
        <ng-container *ngSwitchCase="'row'">
          <div class="s-line" *ngFor="let i of slots">
            <div class="s-thumb pulse" *ngIf="thumb"></div>
            <div class="s-bar pulse w-60"></div>
            <div class="s-bar pulse w-15"></div>
          </div>
        </ng-container>

        <ng-container *ngSwitchCase="'card-row'">
          <div class="s-card" *ngFor="let i of slots">
            <div class="s-bar pulse w-40"></div>
            <div class="s-bar pulse w-80"></div>
          </div>
        </ng-container>

        <ng-container *ngSwitchCase="'discover-grid'">
          <div class="s-tile" *ngFor="let i of slots" [class.feature-tile]="i === 0">
            <div class="s-tile-cover pulse"></div>
            <div class="s-bar pulse w-80"></div>
            <div class="s-bar pulse w-50"></div>
          </div>
        </ng-container>

        <ng-container *ngSwitchCase="'report'">
          <div class="s-report-card" *ngFor="let i of slots">
            <div  style="display: flex; justify-content: space-between; margin-bottom: 12px;">
              <div class="s-bar pulse w-40"></div>
              <div class="s-bar pulse w-15"></div>
            </div>
            <div class="s-bar pulse w-60 h-24"></div>
            <div class="s-bar pulse w-80"  style="margin-top: 12px;"></div>
          </div>
        </ng-container>

        <ng-container *ngSwitchCase="'order'">
          <div class="s-order-card" *ngFor="let i of slots">
            <div  class="mb-4" style="display: flex; justify-content: space-between;">
              <div class="s-bar pulse w-15"></div>
              <div class="s-bar pulse w-15"></div>
            </div>
            <div  style="display: flex; justify-content: space-between;">
              <div  class="flex-1" style="display: flex; flex-direction: column; gap: 8px;">
                <div class="s-bar pulse w-60 h-24"></div>
                <div class="s-bar pulse w-40"></div>
                <div class="s-bar pulse w-40"></div>
              </div>
              <div class="s-bar pulse w-15 h-24"></div>
            </div>
          </div>
        </ng-container>

        <ng-container *ngSwitchCase="'table'">
          <div class="s-table">
            <div class="s-table-header">
              <div class="s-bar pulse w-15"></div>
              <div class="s-bar pulse w-15"></div>
              <div class="s-bar pulse w-15"></div>
              <div class="s-bar pulse w-15"></div>
            </div>
            <div class="s-table-row" *ngFor="let i of slots">
              <div class="s-bar pulse w-15"></div>
              <div class="s-bar pulse w-15"></div>
              <div class="s-bar pulse w-15"></div>
              <div class="s-bar pulse w-15"></div>
            </div>
          </div>
        </ng-container>

        <!-- Mirrors .chat-item in the messages inbox. -->
        <ng-container *ngSwitchCase="'chat-list'">
          <div class="s-chat" *ngFor="let i of slots">
            <div class="s-chat-thumb pulse"></div>
            <div class="s-chat-info">
              <div class="s-bar pulse w-40"></div>
              <div class="s-bar pulse w-60"></div>
              <div class="s-bar pulse w-80"></div>
            </div>
          </div>
        </ng-container>

        <!-- Message bubbles, alternating sides as a conversation does. -->
        <ng-container *ngSwitchCase="'chat-bubbles'">
          <div class="s-bubble pulse" *ngFor="let i of slots" [class.self]="i % 2 === 1" [style.width.%]="bubbleWidths[i % bubbleWidths.length]"></div>
        </ng-container>

        <!-- One page, not a list: count is ignored. -->
        <ng-container *ngSwitchCase="'detail'">
          <div class="s-detail">
            <div class="s-gallery pulse"></div>
            <div class="s-detail-info">
              <div class="s-bar pulse w-80 h-32"></div>
              <div class="s-bar pulse w-40"></div>
              <div class="s-bar pulse w-40 h-32 s-price"></div>
              <div class="s-seller pulse"></div>
              <div class="s-bar pulse w-60"></div>
              <div class="s-bar pulse w-50"></div>
            </div>
          </div>
        </ng-container>

        <!-- A form still waiting for the values it edits: a label over an
             input per field, then the submit button. Empty inputs in its
             place read as "you have no name and no email". -->
        <ng-container *ngSwitchCase="'form'">
          <div class="s-field" *ngFor="let i of slots">
            <div class="s-bar pulse s-label"></div>
            <div class="s-input pulse"></div>
          </div>
          <div class="s-submit pulse"></div>
        </ng-container>

        <!-- A card of setting rows: label and description on the left, the
             control (switch, dropdown) on the right. -->
        <ng-container *ngSwitchCase="'settings-rows'">
          <div class="s-setting" *ngFor="let i of slots">
            <div class="s-setting-text">
              <div class="s-bar pulse w-40"></div>
              <div class="s-bar pulse w-80 s-desc"></div>
            </div>
            <div class="s-control pulse"></div>
          </div>
        </ng-container>

        <!-- Icon plus two lines, for compact item rows that are not books
             (passkeys). -->
        <ng-container *ngSwitchCase="'item-row'">
          <div class="s-item" *ngFor="let i of slots">
            <div class="s-item-icon pulse"></div>
            <div class="s-setting-text">
              <div class="s-bar pulse w-40"></div>
              <div class="s-bar pulse w-60 s-desc"></div>
            </div>
          </div>
        </ng-container>

        <!-- Mirrors .book-header on the book page: a 200x280 cover beside
             the title and its label/value rows. One block: count is ignored. -->
        <ng-container *ngSwitchCase="'book-header'">
          <div class="s-book-cover pulse"></div>
          <div class="s-book-info">
            <div class="s-bar pulse w-80 h-32 s-book-title"></div>
            <div class="s-meta-row" *ngFor="let i of metaRows">
              <div class="s-bar pulse s-meta-label"></div>
              <div class="s-bar pulse w-50"></div>
            </div>
          </div>
        </ng-container>

        <!-- Mirrors .seller-header: a round avatar beside name and meta, in a
             bordered card. One block: count is ignored. -->
        <ng-container *ngSwitchCase="'profile-header'">
          <div class="s-avatar pulse"></div>
          <div class="s-book-info">
            <div class="s-bar pulse w-40 h-32"></div>
            <div class="s-bar pulse w-50"></div>
            <div class="s-bar pulse w-15"></div>
          </div>
        </ng-container>

        <!-- Mirrors ui-listing-card in the book page's .listings-grid: photo,
             price beside condition, seller, then two buttons. -->
        <ng-container *ngSwitchCase="'listing-cards'">
          <div class="s-listing-card" *ngFor="let i of slots">
            <div class="s-tile-cover pulse"></div>
            <div class="s-card-head">
              <div class="s-bar pulse w-40 h-24"></div>
              <div class="s-bar pulse w-15"></div>
            </div>
            <div class="s-bar pulse w-80"></div>
            <div class="s-card-buttons">
              <div class="s-button pulse"></div>
              <div class="s-button pulse"></div>
            </div>
          </div>
        </ng-container>

        <!-- Mirrors .checkout-grid: the order summary card (cover, title,
             price) beside the meetup form card. One block: count is ignored. -->
        <ng-container *ngSwitchCase="'checkout'">
          <div class="s-panel">
            <div class="s-bar pulse w-40"></div>
            <div class="s-summary">
              <div class="s-summary-cover pulse"></div>
              <div class="s-book-info">
                <div class="s-bar pulse w-80"></div>
                <div class="s-bar pulse w-50"></div>
                <div class="s-bar pulse w-40 h-24"></div>
              </div>
            </div>
          </div>
          <div class="s-panel">
            <div class="s-bar pulse w-50"></div>
            <div class="s-bar pulse w-80 s-desc"></div>
            <div class="s-field" *ngFor="let i of [0, 1]">
              <div class="s-bar pulse s-label"></div>
              <div class="s-input pulse"></div>
            </div>
            <div class="s-input pulse"></div>
          </div>
        </ng-container>

        <!-- Mirrors .book-match in the sell flow's ISBN results: a 60x84
             cover beside title and ISBN, in an accent-edged card. -->
        <ng-container *ngSwitchCase="'book-match'">
          <div class="s-match" *ngFor="let i of slots">
            <div class="s-match-cover pulse"></div>
            <div class="s-book-info">
              <div class="s-bar pulse w-80"></div>
              <div class="s-bar pulse w-40 s-desc"></div>
            </div>
          </div>
        </ng-container>

        <ng-container *ngSwitchCase="'list'">
          <div class="skeleton-row" *ngFor="let i of slots">
            <div class="s-cover pulse"></div>
            <div class="s-info">
              <div class="s-bar pulse w-60 h-24"></div>
              <div class="s-bar pulse w-40"></div>
            </div>
            <!-- ui-listing-row's .actions: the price over a badge. -->
            <div class="s-actions">
              <div class="s-bar pulse s-price-bar"></div>
              <div class="s-bar pulse s-badge"></div>
            </div>
          </div>
        </ng-container>

        <!-- Default: shape-neutral text lines, so a call site that names no
             variant never gets a book cover it did not ask for. -->
        <ng-container *ngSwitchDefault>
          <div class="s-lines" *ngFor="let i of slots">
            <div class="s-bar pulse w-60"></div>
            <div class="s-bar pulse w-80 s-desc"></div>
          </div>
        </ng-container>

      </ng-container>
    </div>
  `,
  styles: [`
    :host { display: block; position: relative; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    /* --line-strong, not --line. --line is 1.48:1 against the page ground,
       and the pulse then dipped it to 1.12:1 — for roughly a third of every
       1.5s cycle the placeholder was effectively not on screen. The fill is
       now 3.4:1 at rest and the pulse floor is 0.5, so the shapes stay
       between 2.4:1 and 1.7:1 throughout. */
    .pulse {
      background-color: var(--line-strong);
      animation: pulse 1.5s infinite ease-in-out;
      border-radius: var(--radius-xs);
    }
    .s-bar { height: 16px; }
    .h-24 { height: 24px; }
    .h-32 { height: 32px; }
    .w-80 { width: 80%; }
    .w-60 { width: 60%; }
    .w-50 { width: 50%; }
    .w-40 { width: 40%; }
    .w-15 { width: 15%; }

    /* list: mirrors ui-listing-row — cover, text, then the price column.
       Its own container, so the row narrows at the same 580px the real row
       does (both are measured on the row's width, not the viewport's). */
    .v-list { container-type: inline-size; }
    .skeleton-row {
      display: flex;
      gap: var(--space-4);
      padding: var(--space-4) 0;
      border-bottom: 1px solid var(--line);
    }
    .s-actions {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: var(--space-2);
      min-width: 100px;
      flex-shrink: 0;
    }
    .s-price-bar { width: 72px; height: 28px; }
    .s-badge { width: 56px; height: 20px; border-radius: 10px; }
    @container (max-width: 580px) {
      .skeleton-row { flex-wrap: wrap; }
      .skeleton-row .s-cover { width: 64px; height: 90px; }
      .s-actions {
        width: 100%;
        min-width: 0;
        flex-direction: row;
        align-items: center;
        justify-content: flex-end;
      }
      .s-price-bar { height: 24px; }
    }
    .s-cover {
      width: 88px;
      height: 124px;
      flex-shrink: 0;
    }
    .s-info {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding-top: var(--space-2);
    }

    /* discover-grid tiles */
    .s-tile { display: flex; flex-direction: column; gap: var(--space-2); }
    .s-tile-cover { aspect-ratio: 5 / 7; width: 100%; }

    /* row: title-left / count-right lines (waitlist) */
    .s-line {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-3) 0;
      border-bottom: 1px dashed var(--line);
    }
    .s-line .s-bar.w-60 { flex: 1; width: auto; max-width: 60%; }
    .with-thumb .s-line .s-bar.w-60 { max-width: none; }
    .s-thumb { flex: 0 0 auto; width: 34px; height: 48px; }
    .with-thumb .s-line:last-child { border-bottom: none; }
    /* The home waitlist lays its rows out in 240px columns from 769px. */
    @media (min-width: 769px) {
      .v-row.with-thumb {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        column-gap: var(--space-6);
      }
      .with-thumb .s-line:last-child { border-bottom: 1px dashed var(--line); }
    }

    /* card-row: mirrors ui-category-rail — bordered 240px cards, with the
       rail's 48px side gutters for its scroll buttons. */
    .v-card-row {
      display: flex;
      gap: var(--space-4);
      overflow: hidden;
      padding-inline: 48px;
    }
    .s-card {
      flex: 0 0 240px;
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: var(--space-5);
      border: 1px solid var(--line);
      border-radius: var(--radius-panel);
    }
    @media (max-width: 768px) {
      .v-card-row { padding-inline: 0; }
    }
    @media (max-width: 420px) {
      .s-card { flex: 0 0 calc(100% - 32px); }
    }

    /* book-header: mirrors .book-header in book.ts */
    .v-book-header {
      display: flex;
      gap: 32px;
      margin-bottom: 48px;
    }
    .s-book-cover {
      width: 200px;
      height: 280px;
      flex-shrink: 0;
      border-radius: var(--radius-sm);
    }
    .s-book-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .s-book-title { margin-bottom: var(--space-3); }
    .s-meta-row {
      display: grid;
      grid-template-columns: 120px 1fr;
      padding: var(--space-2) 0;
    }
    .s-meta-label { width: 64px; }
    @media (max-width: 768px) {
      .v-book-header { flex-direction: column; gap: 24px; margin-bottom: 32px; }
      .s-book-cover { width: 140px; height: 196px; margin: 8px auto; }
      .s-meta-row { grid-template-columns: 88px 1fr; }
    }

    /* profile-header: mirrors .seller-header in seller.ts */
    .v-profile-header {
      display: flex;
      align-items: center;
      gap: 24px;
      padding: 32px;
      margin-bottom: 32px;
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    .s-avatar { width: 64px; height: 64px; flex-shrink: 0; border-radius: 50%; }

    /* listing-cards: mirrors .listings-grid + ui-listing-card in book.ts */
    .v-listing-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(max(150px, 19%), 1fr));
      gap: 16px;
    }
    .s-listing-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: var(--radius-xs);
    }
    .s-card-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: var(--space-1);
    }
    .s-card-buttons { display: flex; gap: 8px; padding-top: var(--space-2); }
    .s-button { flex: 1; height: 36px; border-radius: var(--radius-control); }
    @media (max-width: 768px) {
      .v-listing-cards { gap: 12px; }
    }

    /* checkout: mirrors .checkout-grid in checkout.ts */
    .v-checkout {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      align-items: start;
    }
    .s-panel {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      padding: 24px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-card);
    }
    .s-summary { display: flex; gap: 16px; }
    .s-summary-cover { width: 80px; height: 120px; flex-shrink: 0; }
    @media (max-width: 768px) {
      .v-checkout { grid-template-columns: 1fr; }
    }

    /* book-match: mirrors .book-match in sell.css */
    .s-match {
      display: flex;
      gap: 16px;
      padding: 16px;
      margin-top: 16px;
      border: 1px solid var(--line);
      border-left: 3px solid var(--line-strong);
      border-radius: var(--radius-panel);
    }
    .s-match-cover { width: 60px; height: 84px; flex-shrink: 0; }

    /* spinner: admin pages */
    .v-spinner {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-3);
      padding: var(--space-7) 0;
      color: var(--muted);
      font-size: var(--text-base);
    }
    .s-spinner {
      width: 20px;
      height: 20px;
      border: 2px solid var(--line-strong);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .s-spinner { animation-duration: 2.4s; }
    }

    /* report: mirrors .report-card in reports.ts */
    .v-report {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .s-report-card {
      background: var(--surface-card);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px 20px;
    }

    /* order: mirrors .order-card in orders.ts */
    .v-order {
      display: flex;
      flex-direction: column;
    }
    .s-order-card {
      padding: 24px 0;
      border-bottom: 1px solid var(--line);
    }

    /* table: mirrors .admin-table in admin pages */
    .s-table {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .s-table-header {
      padding: 12px 16px;
      border-bottom: 2px solid var(--line);
      display: flex;
      justify-content: space-between;
    }
    .s-table-row {
      padding: 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
    }
    .s-table-row:last-child {
      border-bottom: none;
    }

    /* detail: mirrors .product-layout in listing-detail.css — one column,
       then a 400px 3:4 gallery beside the details from 768px */
    .s-detail {
      display: grid;
      grid-template-columns: 1fr;
      gap: 40px;
      padding: 32px;
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    @media (min-width: 768px) {
      .s-detail { grid-template-columns: 400px 1fr; }
    }
    .s-gallery { width: 100%; aspect-ratio: 3 / 4; }
    .s-detail-info {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .s-price { margin-top: var(--space-4); }
    .s-seller { height: 88px; border-radius: 8px; }

    /* chat-list: mirrors .chat-item in inbox-list.component.ts */
    .s-chat {
      display: flex;
      gap: 10px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
    }
    .s-chat-thumb { width: 40px; height: 52px; flex-shrink: 0; }
    .s-chat-info { flex: 1; display: flex; flex-direction: column; gap: 8px; }
    .s-chat .s-bar { height: 12px; }

    /* chat-bubbles: mirrors .msg-bubble in messages.css */
    .v-chat-bubbles { display: flex; flex-direction: column; gap: 16px; }
    .s-bubble { height: 40px; border-radius: 12px; align-self: flex-start; }
    .s-bubble.self { align-self: flex-end; }

    /* form: mirrors a .form-group of ui-input fields */
    .v-form { display: flex; flex-direction: column; gap: var(--space-5); }
    .s-field { display: flex; flex-direction: column; gap: var(--space-2); }
    .s-label { width: 30%; height: 14px; }
    .s-input { height: 40px; border-radius: var(--radius-control); }
    .s-submit { width: 120px; height: 40px; border-radius: var(--radius-control); }

    /* settings-rows: mirrors .notification-list in notifications.ts */
    .v-settings-rows {
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      background: var(--surface-card);
    }
    .s-setting {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      padding: var(--space-4) var(--space-5);
    }
    .s-setting + .s-setting { border-top: 1px solid var(--line); }
    .s-setting-text { flex: 1; display: flex; flex-direction: column; gap: var(--space-2); }
    .s-desc { height: 12px; }
    .s-lines { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) 0; }
    .s-item { display: flex; align-items: center; gap: var(--space-4); padding: var(--space-4) 0; }
    .s-item-icon { width: 40px; height: 40px; flex-shrink: 0; border-radius: 50%; }
    .s-control { width: 44px; height: 24px; flex-shrink: 0; border-radius: 12px; }

    @keyframes pulse {
      0% { opacity: 0.75; }
      50% { opacity: 0.5; }
      100% { opacity: 0.75; }
    }
  `]
})
export class UiSkeleton {
  @Input() count: number = 3;
  @Input() variant: 'list' | 'row' | 'card-row' | 'discover-grid' | 'report' | 'order' | 'table' | 'detail' | 'chat-list' | 'chat-bubbles' | 'form' | 'settings-rows' | 'item-row' | 'lines' | 'spinner' | 'book-header' | 'profile-header' | 'listing-cards' | 'checkout' | 'book-match' = 'lines';
  /** row only: lead each row with a small cover (the home waitlist). */
  @Input() thumb = false;

  readonly metaRows = [0, 1, 2, 3];

  readonly bubbleWidths = [55, 40, 65, 35, 50];

  get slots(): number[] {
    return Array.from({ length: Math.max(0, this.count) }, (_, i) => i);
  }
}
