import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { UiButton } from '../../shared/ui/button.component';
import { UiEmpty } from '../../shared/ui/empty.component';
import { UiBookTile } from '../../shared/ui/book-tile.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { TPipe, I18nService } from '../../core/i18n.service';
import { AccountService } from '../../core/services/account.service';
import { RegionLinkService } from '../../core/region-link.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService } from '../../core/services/confirm.service';


@Component({
  selector: 'app-account-subscriptions',
  standalone: true,
  imports: [CommonModule, UiButton, UiEmpty, UiBookTile, UiSkeleton, UiErrorState, TPipe],
  template: `
    <div class="section-head-row">
      <h2 class="section-heading">{{ 'acct.tabSubs' | t }}</h2>
      <ui-button variant="ghost" *ngIf="!loading && mySubscriptions.length > 0" (onClick)="cancelAllSubscriptions()">{{ 'acct.cancelAllSubs' | t }}</ui-button>
    </div>

    <!-- Until the first response lands the list is unknown, not empty:
         showing "no subscriptions" and then swapping in the grid read as
         the page contradicting itself. -->
    <ui-skeleton *ngIf="loading" variant="discover-grid" [count]="4"></ui-skeleton>

    <ui-error-state
      *ngIf="!loading && loadFailed"
      [message]="'common.error' | t"
      (retry)="loadSubscriptions()"
    ></ui-error-state>

    <div class="discover-grid" *ngIf="!loading && !loadFailed && mySubscriptions.length > 0">
      <ui-book-tile
        *ngFor="let sub of mySubscriptions"
        [title]="sub.bookTitle"
        [isbn]="sub.isbn"
        [coverUrl]="sub.bookCoverUrl"
        mode="waitlist"
        [waitingCount]="sub.newListingsCount"
        [link]="sub.isbn ? ['/search'] : undefined"
        [linkParams]="{ q: sub.isbn }"
      >
        <div tile-actions class="tile-actions-inner">
          <span class="sub-status" [class.available]="sub.newListingsCount > 0">
            <ng-container *ngIf="sub.newListingsCount === 0">{{ 'acct.noOneListed' | t }}</ng-container>
            <ng-container *ngIf="sub.newListingsCount > 0">{{ 'acct.newListings' | t:{n: sub.newListingsCount} }}</ng-container>
          </span>
          <ui-button *ngIf="sub.newListingsCount > 0" (onClick)="$event.stopPropagation(); viewBook(sub)">{{ 'acct.viewNow' | t }}</ui-button>
          <ui-button variant="ghost" *ngIf="sub.newListingsCount === 0" (onClick)="$event.stopPropagation(); cancelSubscription(sub.id)">{{ 'acct.cancelNotify' | t }}</ui-button>
        </div>
      </ui-book-tile>
    </div>

    <ui-empty *ngIf="!loading && !loadFailed && mySubscriptions.length === 0" [message]="'acct.noSubs' | t"></ui-empty>
  `,
  styles: [`
    /* .discover-grid is declared once, globally. A copy here would win on
       specificity — view encapsulation adds an attribute selector — and this
       one silently did, with a 160px track against the global 180px. */
    .tile-actions-inner {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      margin-top: 8px;
    }
    .sub-status {
      font-size: var(--text-sm);
      color: var(--muted);
    }
    .sub-status.available { color: var(--flag); font-weight: 500; }
  `]
})
export class SubscriptionsComponent implements OnInit {
  mySubscriptions: any[] = [];
  loading = true;
  loadFailed = false;

  private accountService = inject(AccountService);
  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);
  readonly i18n = inject(I18nService);

  private toast = inject(ToastService);
  private confirms = inject(ConfirmService);
  ngOnInit() {
    this.loadSubscriptions();
  }

  /**
   * `quiet` refreshes after an unsubscribe without swapping the grid for a
   * skeleton: the list is already on screen and only shrinks.
   */
  loadSubscriptions(quiet = false) {
    if (!quiet) this.loading = true;
    this.loadFailed = false;
    this.accountService.getMySubscriptions().subscribe({
      next: (subs) => {
        this.mySubscriptions = subs;
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('Failed to load subscriptions', err);
        this.loading = false;
        // Keep what is already listed; only an empty first load is a failure.
        this.loadFailed = this.mySubscriptions.length === 0;
        this.cdr.markForCheck();
      }
    });
  }

  async cancelSubscription(id: string) {
    if (await this.confirms.askDanger(this.i18n.t('acct.confirmCancelSub'))) {
      this.accountService.unsubscribe(id).subscribe({
        next: () => this.loadSubscriptions(true),
        error: (err) => {
          console.error('Failed to unsubscribe', err);
          this.toast.error(this.i18n.t('acct.unsubscribeFailed'));
        }
      });
    }
  }

  async cancelAllSubscriptions() {
    if (await this.confirms.askDanger(this.i18n.t('acct.confirmCancelAllSubs'))) {
      this.accountService.unsubscribeAll().subscribe({
        next: () => this.loadSubscriptions(true),
        error: (err) => {
          console.error('Failed to unsubscribe all', err);
          this.toast.error(this.i18n.t('acct.unsubscribeFailed'));
        }
      });
    }
  }

  viewBook(sub: any) {
    if (sub.isbn) {
      this.router.navigate(this.regionLink.path(['/search']), { queryParams: { q: sub.isbn } });
    }
  }
}
