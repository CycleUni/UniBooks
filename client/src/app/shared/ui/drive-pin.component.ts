import { ChangeDetectorRef, Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { I18nService, TPipe } from '../../core/i18n.service';
import { intlLocale } from '../../core/i18n';
import { AuthStore } from '../../core/auth.store';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { RegionLinkService } from '../../core/region-link.service';
import type { DriveClaim, DriveHead } from '../../core/services/drive.service';
import { UiButton } from './button.component';
import { UiDriveClaimDialog } from './drive-claim-dialog.component';

/** A drive's close time as the page language writes a date and time. */
export function claimDeadline(iso: string | null, lang: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(intlLocale(lang as any), {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * One student organization giving a title away: who gives it, copies left,
 * how many registered, and the 登記領取 button, which opens the registration
 * form, or the viewer's own registration to change. One entry per
 * organization however many copies it holds: students register for the
 * title, not a copy.
 *
 * Two looks. On a book page it is a banner above the listings, the same
 * paper panel the page uses for its waitlist banner. Under a book tile
 * (`compact`: a drive's page, a school's home page) it is the tile's status
 * lines and button, as the account page's book requests are.
 */
@Component({
  selector: 'ui-drive-pin',
  standalone: true,
  imports: [CommonModule, TPipe, UiButton, UiDriveClaimDialog, RegionLinkDirective],
  template: `
    <div class="drive-banner" *ngIf="!compact">
      <div class="banner-text">
        <span class="banner-head">
          <span class="cond-chip">{{ 'drive.giveaway' | t }}</span>
          <a class="banner-org" regionLink="/drive" [queryParams]="{ id: drive.id }">{{
            drive.organization.display_name
          }}</a>
        </span>
        <span class="banner-meta">
          {{ 'drive.counts' | t: { remaining: remaining, claimants: claimants } }}
          · {{ drive.open ? ('drive.closesAt' | t: { time: deadline }) : ('drive.closed' | t) }}
        </span>
        <span class="banner-mine" *ngIf="claim">{{ 'drive.youRegistered' | t }}</span>
      </div>
      <ng-container *ngTemplateOutlet="action"></ng-container>
    </div>

    <div class="tile-status" *ngIf="compact">
      <span class="status-line">{{
        'drive.counts' | t: { remaining: remaining, claimants: claimants }
      }}</span>
      <span class="status-line mine" *ngIf="claim">{{ 'drive.youRegistered' | t }}</span>
      <ng-container *ngTemplateOutlet="action"></ng-container>
    </div>

    <ng-template #action>
      <ui-button
        *ngIf="drive.open && !claim"
        [variant]="compact ? 'primary' : 'white'"
        [disabled]="remaining === 0"
        (onClick)="start()"
      >
        {{ 'drive.register' | t }}
      </ui-button>
      <ui-button *ngIf="drive.open && claim" variant="ghost" (onClick)="start()">{{
        'drive.editClaim' | t
      }}</ui-button>
    </ng-template>

    <ui-drive-claim-dialog
      *ngIf="dialogOpen"
      [drive]="drive"
      [bookId]="bookId"
      [bookTitle]="bookTitle"
      [claim]="claim"
      (saved)="onSaved($event)"
      (close)="dialogOpen = false"
    ></ui-drive-claim-dialog>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      /* The book page's .waitlist-banner, so the two panels read as one system. */
      .drive-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-4);
        padding: 16px 24px;
        background-color: var(--paper-warm);
        border: 1px solid var(--line);
        border-radius: var(--radius-panel);
      }
      .banner-text {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-width: 0;
      }
      .banner-head {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .banner-org {
        color: var(--ink);
        font-weight: 700;
        font-size: var(--text-md);
        text-decoration: none;
      }
      .banner-org:hover {
        color: var(--accent);
      }
      .banner-meta {
        color: var(--muted);
        font-weight: 500;
        font-size: var(--text-base);
      }
      .banner-mine,
      .status-line.mine {
        color: var(--success);
        font-weight: 500;
        font-size: var(--text-sm);
      }
      .tile-status {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
      }
      .status-line {
        font-size: var(--text-sm);
        color: var(--muted);
      }
      @media (max-width: 768px) {
        .drive-banner {
          flex-direction: column;
          align-items: flex-start;
          gap: 12px;
          padding: 16px;
        }
      }
    `,
  ],
})
export class UiDrivePin {
  private auth = inject(AuthStore);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);

  @Input({ required: true }) drive!: DriveHead;
  @Input({ required: true }) bookId!: string;
  @Input() bookTitle = '';
  @Input() remaining = 0;
  @Input() claimants = 0;
  @Input() claim: DriveClaim | null = null;
  /** Under a book tile rather than a banner on a book page. */
  @Input() compact = false;
  /** The viewer's registration changed: the new one, or null once cancelled. */
  @Output() claimChange = new EventEmitter<DriveClaim | null>();

  dialogOpen = false;

  get deadline(): string {
    return claimDeadline(this.drive.claim_closes_at, this.i18n.lang());
  }

  start(): void {
    if (!this.auth.isAuthenticated()) {
      this.router.navigate(this.regionLink.path(['/login']), {
        queryParams: { returnUrl: this.router.url },
      });
      return;
    }
    this.dialogOpen = true;
  }

  onSaved(claim: DriveClaim | null): void {
    // Registering adds one to the count; cancelling takes one off.
    if (!this.claim && claim) this.claimants += 1;
    if (this.claim && !claim) this.claimants = Math.max(0, this.claimants - 1);
    this.claim = claim;
    this.dialogOpen = false;
    this.claimChange.emit(claim);
    this.cdr.markForCheck();
  }
}
