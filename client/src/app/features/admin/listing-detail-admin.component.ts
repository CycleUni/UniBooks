import { parseAdminError } from '../../core/admin-error.util';
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminListing } from '../../core/services/admin.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiButton } from '../../shared/ui/button.component';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiCheckbox } from '../../shared/ui/checkbox.component';
import { UiInput } from '../../shared/ui/input.component';
import { PricePipe } from '../../shared/pipes/price.pipe';
import { ForceCancelModalComponent } from './force-cancel-modal.component';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { RegionLinkService } from '../../core/region-link.service';

@Component({
  selector: 'app-admin-listing-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, TPipe, UiErrorState, UiSkeleton, UiButton, UiDropdown, UiCheckbox, UiInput, PricePipe, ForceCancelModalComponent, RegionLinkDirective],
  template: `
    <a [regionLink]="['/admin', 'listings']" class="back-link">&larr; {{ 'admin.backToList' | t }}</a>

    <ui-skeleton *ngIf="loading" variant="form" [count]="4"></ui-skeleton>
    <!-- A failed load used to leave only the back link, with no word why. -->
    <ui-error-state *ngIf="!loading && loadError" [message]="loadError" (retry)="load()"></ui-error-state>

    <div class="detail-card" *ngIf="!loading && listing">
      <h2>{{ listing.book?.title }}</h2>

      <div class="field-grid">
        <div class="field"><label>{{ 'admin.colSeller' | t }}</label><span>{{ listing.seller?.email }}</span></div>
        <div class="field"><label>{{ 'admin.colSchool' | t }}</label><span>{{ listing.school?.name || '—' }}</span></div>
        <div class="field"><label>{{ 'admin.colPrice' | t }}</label><span>{{ listing.price | price: listing.currency }}</span></div>
        <div class="field"><label>{{ 'admin.colCondition' | t }}</label><span>{{ ('cond.' + listing.condition) | t }}</span></div>
      </div>

      <ui-dropdown [label]="'admin.colStatus' | t" [options]="statusOptions" [ngModel]="status" (ngModelChange)="onStatusChange($event)"></ui-dropdown>

      <div class="lock-section">
        <ui-checkbox [label]="'admin.lockListing' | t" [(ngModel)]="adminLocked"></ui-checkbox>
        <div *ngIf="adminLocked" class="lock-reason">
          <ui-input [label]="'admin.lockReason' | t" [(ngModel)]="adminLockReason"></ui-input>
        </div>
      </div>

      <div *ngIf="errorMsg" class="inline-msg error">{{ errorMsg }}</div>
      <div *ngIf="savedMsg" class="inline-msg ok">{{ savedMsg }}</div>

      <div class="detail-actions">
        <ui-button (onClick)="save()" [disabled]="saving || deleting">{{ (saving ? 'admin.saving' : 'admin.save') | t }}</ui-button>
        <ui-button variant="danger" (onClick)="deleteListing()" [disabled]="saving || deleting">{{ 'common.delete' | t }}</ui-button>
      </div>
    </div>

    <app-force-cancel-modal
      *ngIf="openOrdersToCancel && listing"
      [listingId]="listing.id"
      [openOrders]="openOrdersToCancel"
      (closed)="openOrdersToCancel = 0"
      (submitted)="onDeleted()"
    ></app-force-cancel-modal>
  `,
  styles: [`

    .detail-card { background: var(--surface-card); border: 1px solid var(--line); border-radius: 8px; padding: 24px; max-width: 520px; box-shadow: var(--shadow-card-lg); }
    .detail-card h2 { margin-top: 0; }
    .lock-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
    .lock-reason { margin-top: 12px; }
    .detail-actions { display: flex; gap: 8px; }
    .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
    .field { display: flex; flex-direction: column; gap: 2px; }
    .field label { font-size: var(--text-xs); color: var(--muted); }
    .field span { font-size: var(--text-base); color: var(--ink); }
  `]
})
export class AdminListingDetailComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private adminService = inject(AdminService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);
  private confirms = inject(ConfirmService);

  listing: AdminListing | null = null;
  loading = true;
  /** Why the last load failed. */
  loadError = '';
  saving = false;
  errorMsg = '';
  savedMsg = '';
  deleting = false;
  status = '';
  adminLocked = false;
  adminLockReason = '';

  // Taking a listing down locks it by default, or the seller could just set
  // it back to active; the admin can still untick the box.
  onStatusChange(status: string) {
    if (status === 'removed' && this.status !== 'removed') this.adminLocked = true;
    this.status = status;
  }

  get statusOptions() {
    return [
      { value: 'active', label: this.i18n.t('admin.listingStatus.active') },
      { value: 'reserved', label: this.i18n.t('admin.listingStatus.reserved') },
      { value: 'sold', label: this.i18n.t('admin.listingStatus.sold') },
      { value: 'removed', label: this.i18n.t('admin.listingStatus.removed') },
    ];
  }

  ngOnInit() {
    this.load();
  }

  load() {
    const id = this.route.snapshot.paramMap.get('id')!;
    this.loading = true;
    this.loadError = '';
    this.adminService.getListing(id).subscribe({
      next: (listing) => {
        this.listing = listing;
        this.status = listing.status;
        this.adminLocked = !!listing.admin_locked;
        this.adminLockReason = listing.admin_lock_reason || '';
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loading = false;
        this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
        this.cdr.markForCheck();
      }
    });
  }

  save() {
    if (!this.listing) return;
    this.saving = true;
    this.errorMsg = '';
    this.savedMsg = '';

    this.adminService.updateListingStatus(this.listing.id, {
      status: this.status,
      admin_locked: this.adminLocked,
      admin_lock_reason: this.adminLockReason
    }).subscribe({
      next: (updated) => {
        this.listing = updated;
        this.saving = false;
        this.savedMsg = this.i18n.t('admin.saved');
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.saving = false;
        this.errorMsg = parseAdminError(err, this.i18n, 'admin.errGeneric');
        this.cdr.markForCheck();
      }
    });
  }

  /** Open orders the server will cancel if the delete goes ahead; non-zero
   *  shows the modal that asks for the reason it needs for that. */
  openOrdersToCancel = 0;

  // The seller cannot delete a listing an admin has locked (the record is
  // kept), so removing it for good is done here. Finished orders keep their
  // own record; open ones are cancelled on the platform's behalf, which the
  // server only does with a written reason — it answers the first attempt
  // with how many there are, and the modal collects the reason.
  async deleteListing() {
    if (!this.listing) return;
    const confirmed = await this.confirms.askDanger(this.i18n.t('admin.confirmDeleteListing'), {
      confirmLabel: this.i18n.t('common.delete'),
    });
    if (!confirmed) return;
    this.deleting = true;
    this.errorMsg = '';
    this.savedMsg = '';
    this.cdr.markForCheck();
    this.adminService.deleteListing(this.listing.id).subscribe({
      next: () => this.onDeleted(),
      error: (err) => {
        this.deleting = false;
        const openOrders = err?.error?.open_orders;
        if (err?.error?.error?.code === 'admin.errInvalidReason' && openOrders > 0) {
          this.openOrdersToCancel = openOrders;
        } else {
          this.errorMsg = parseAdminError(err, this.i18n, 'admin.errDeleteFailed');
        }
        this.cdr.markForCheck();
      },
    });
  }

  onDeleted() {
    this.openOrdersToCancel = 0;
    this.router.navigate(this.regionLink.path(['/admin', 'listings']));
  }
}
