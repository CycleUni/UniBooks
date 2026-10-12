import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TPipe } from '../../core/i18n.service';

/**
 * `ui-seller-reputation`: a seller's rating, review count and completed
 * sales, as serialized on every listing (`seller_average_rating`,
 * `seller_review_count`, `seller_completed_sales`).
 *
 * Shared by the listing card and the listing page so the two cannot drift.
 * Phrasing content only (spans), so it is valid inside a link or a button.
 *
 * A seller nobody has reviewed yet reads "New seller", never "0 ★" — a zero
 * rating says *bad seller*, and that is not what an empty history means.
 * "New seller" is only for a seller with no sales either: one who has sold
 * but not been reviewed reads "N sales · No reviews yet".
 */
@Component({
  selector: 'ui-seller-reputation',
  standalone: true,
  imports: [CommonModule, TPipe],
  template: `
    <span class="reputation" *ngIf="reviews > 0 && rating != null; else newSeller">
      <!-- A bare "★ 4.5" is read aloud as "black star four point five". -->
      <span class="stars" aria-hidden="true">★ {{ ratingText }}</span>
      <span class="sr-only">{{ 'seller.ratingAria' | t: { rating: ratingText } }}</span>
      <span class="sep" aria-hidden="true">·</span>
      <span>{{
        (reviews === 1 ? 'seller.reviewCountOne' : 'seller.reviewCount') | t: { n: reviews }
      }}</span>
      <ng-container *ngIf="sold > 0">
        <span class="sep" aria-hidden="true">·</span>
        <span>{{
          (sold === 1 ? 'seller.salesCountOne' : 'seller.salesCount') | t: { n: sold }
        }}</span>
      </ng-container>
    </span>
    <ng-template #newSeller>
      <span class="reputation unreviewed" *ngIf="sold > 0; else noHistory">
        <span>{{
          (sold === 1 ? 'seller.salesCountOne' : 'seller.salesCount') | t: { n: sold }
        }}</span>
        <span class="sep" aria-hidden="true">·</span>
        <span>{{ 'seller.noReviews' | t }}</span>
      </span>
    </ng-template>
    <ng-template #noHistory>
      <span class="reputation new-seller">{{ 'seller.newSeller' | t }}</span>
    </ng-template>
  `,
  styles: [
    `
      :host {
        display: inline;
      }
      .reputation {
        font-size: var(--text-sm);
        color: var(--muted);
      }
      .stars {
        color: var(--ink);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .sep {
        margin: 0 4px;
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
    `,
  ],
})
export class UiSellerReputation {
  /** Average rating, or null for a seller with no rated reviews yet. */
  @Input() rating: number | null | undefined = null;
  @Input() reviewCount: number | null | undefined = 0;
  @Input() sales: number | null | undefined = 0;

  // Cached listing payloads from before these fields existed carry none of
  // them; treat that exactly like a seller with no history.
  get reviews(): number {
    return this.reviewCount ?? 0;
  }
  get sold(): number {
    return this.sales ?? 0;
  }
  /** Always one decimal, so 4 and 4.0 do not render as different ratings. */
  get ratingText(): string {
    return (this.rating ?? 0).toFixed(1);
  }
}
