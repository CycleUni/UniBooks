import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { I18nService, TPipe } from '../../core/i18n.service';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { DriveService, type ClaimStatus, type DriveClaim, type MyClaim } from '../../core/services/drive.service';
import { UiBookTile } from '../../shared/ui/book-tile.component';
import { UiButton } from '../../shared/ui/button.component';
import { UiDriveClaimDialog } from '../../shared/ui/drive-claim-dialog.component';
import { claimDeadline } from '../../shared/ui/drive-pin.component';
import { UiEmpty } from '../../shared/ui/empty.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiSkeleton } from '../../shared/ui/skeleton.component';

const STATUS_KEYS: Record<ClaimStatus, string> = {
  registered: 'drive.statusRegistered',
  won: 'drive.statusWon',
  waitlisted: 'drive.statusWaitlisted',
  not_won: 'drive.statusNotWon',
  picked_up: 'drive.statusPickedUp',
  forfeited: 'drive.statusForfeited',
  cancelled: 'drive.claimCancelled',
};

/**
 * 領書登記: the free books this account registered for with student
 * organizations' book drives, where each stands, and, while a drive still
 * takes registrations, changing or cancelling one. Drawn as 我的求書 is
 * (subscriptions.ts): a grid of book tiles with the state under each.
 */
@Component({
  selector: 'app-account-claims',
  standalone: true,
  imports: [CommonModule, TPipe, RegionLinkDirective, UiBookTile, UiButton, UiDriveClaimDialog, UiEmpty, UiErrorState, UiSkeleton],
  template: `
    <div class="section-head-row">
      <h2 class="section-heading">{{ 'acct.tabClaims' | t }}</h2>
    </div>

    <ui-skeleton *ngIf="loading" variant="discover-grid" [count]="4"></ui-skeleton>
    <ui-error-state *ngIf="!loading && failed" [message]="'common.error' | t" (retry)="load()"></ui-error-state>
    <ui-empty *ngIf="!loading && !failed && !claims.length" [message]="'drive.myClaimsEmpty' | t"></ui-empty>

    <div class="discover-grid" *ngIf="!loading && !failed && claims.length">
      <ui-book-tile
        *ngFor="let c of claims; trackBy: trackClaim"
        mode="plain"
        [title]="c.book.title"
        [author]="c.book.authors"
        [coverUrl]="c.book.cover_url"
        [link]="['/book']"
        [linkParams]="{ id: c.book.id }"
      >
        <div tile-actions class="tile-actions-inner">
          <a class="claim-drive" regionLink="/drive" [queryParams]="{ id: c.drive.id }">{{ c.drive.organization.display_name }}</a>
          <span class="claim-status" [class.live]="isLive(c)">{{ statusKey(c) | t }}</span>
          <span class="claim-status" *ngIf="isLive(c)">{{ 'drive.closesAt' | t: { time: deadline(c) } }}</span>
          <ui-button *ngIf="isLive(c)" variant="ghost" (onClick)="editing = c">{{ 'drive.editClaim' | t }}</ui-button>
        </div>
      </ui-book-tile>
    </div>

    <ui-drive-claim-dialog
      *ngIf="editing"
      [drive]="editing.drive"
      [bookId]="editing.book.id"
      [bookTitle]="editing.book.title"
      [claim]="editing"
      (saved)="onSaved($event)"
      (close)="editing = null"
    ></ui-drive-claim-dialog>
  `,
  styles: [`
    /* subscriptions.ts's tile actions and status line. */
    .tile-actions-inner { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin-top: 8px; }
    .claim-drive { font-size: var(--text-sm); color: var(--ink-soft); text-decoration: none; }
    .claim-drive:hover { color: var(--accent); }
    .claim-status { font-size: var(--text-sm); color: var(--muted); }
    .claim-status.live { color: var(--success); font-weight: 500; }
  `],
})
export class ClaimsComponent implements OnInit {
  private drives = inject(DriveService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);

  claims: MyClaim[] = [];
  loading = true;
  failed = false;
  editing: MyClaim | null = null;

  trackClaim = (_: number, c: MyClaim) => c.id;
  /** Still taking registrations, so it can be changed or cancelled. */
  isLive = (c: MyClaim) => c.status === 'registered' && c.drive.open;
  // A registration left waiting when its organization ended the drive is not waiting any more.
  statusKey = (c: MyClaim) =>
    c.status === 'registered' && c.drive.status === 'closed' ? 'drive.statusDriveEnded' : (STATUS_KEYS[c.status] ?? 'drive.statusRegistered');
  deadline = (c: MyClaim) => claimDeadline(c.drive.claim_closes_at, this.i18n.lang());

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.failed = false;
    this.cdr.markForCheck();
    this.drives.mine().subscribe({
      next: (res) => {
        this.claims = res.results;
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.loading = false;
        this.failed = true;
        this.cdr.markForCheck();
      },
    });
  }

  onSaved(claim: DriveClaim | null): void {
    const editing = this.editing;
    this.editing = null;
    if (!editing) return;
    // Cancelled registrations leave the list; a changed one keeps its book and drive.
    this.claims = claim
      ? this.claims.map((c) => (c.id === claim.id ? { ...c, ...claim } : c))
      : this.claims.filter((c) => c.id !== editing.id);
    this.cdr.markForCheck();
  }
}
