import { ChangeDetectorRef, Component, EventEmitter, Input, OnInit, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { I18nService, TPipe } from '../../core/i18n.service';
import { parseApiError } from '../../core/api-error.util';
import { AuthStore } from '../../core/auth.store';
import { ConfirmService } from '../../core/services/confirm.service';
import { MetadataService } from '../../core/services/metadata.service';
import { ToastService } from '../../core/services/toast.service';
import { DriveService, type DriveClaim, type DriveHead } from '../../core/services/drive.service';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { UiButton } from './button.component';
import { UiDropdown, type DropdownOption } from './dropdown.component';
import { UiFocusTrapDirective } from './focus-trap.directive';

const GRADES = [1, 2, 3, 4, 5, 6, 7];

/**
 * Registering for one title of a book drive (登記領取), or changing and
 * cancelling that registration. Owns the whole interaction: the student
 * number (only one staff approved, read only), the department (the region's
 * list by college, or typed in), the year, the request and its feedback.
 * The host says which drive and title, and hears the result in `saved`.
 * It is drawn as the site's confirm dialog is (ui-confirm-dialog), so the two
 * read as one family; the confirm that cancelling asks for opens above it.
 */
@Component({
  selector: 'ui-drive-claim-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, TPipe, UiButton, UiDropdown, UiFocusTrapDirective, RegionLinkDirective],
  template: `
    <div class="claim-overlay" (click)="close.emit()">
      <div class="claim-dialog" (click)="$event.stopPropagation()" uiFocusTrap="claim-title" (escape)="close.emit()">
        <h2 class="claim-title" id="claim-title">{{ (claim ? 'drive.claimEditTitle' : 'drive.claimTitle') | t }}</h2>
        <div class="claim-subject">
          <p class="claim-book book-title-serif">{{ bookTitle }}</p>
          <p class="claim-org">{{ drive.organization.display_name }} · {{ drive.title }}</p>
        </div>

        <!-- The book page's paper panel: something to do first, not an error. -->
        <div class="claim-panel" *ngIf="!claim && !verified" role="note">
          <p>{{ 'drive.claimNeedsVerification' | t }}</p>
          <ui-button variant="white" [link]="['/account', 'verification']" (onClick)="close.emit()">{{ 'drive.claimVerifyLink' | t }}</ui-button>
        </div>

        <div class="claim-fields" *ngIf="claim || verified">
          <div class="claim-field">
            <span class="claim-label">{{ 'drive.studentNumber' | t }}</span>
            <span class="claim-number" *ngIf="studentNumber">{{ studentNumber }} <span class="claim-note">{{ 'drive.studentNumberVerified' | t }}</span></span>
            <span class="claim-note" *ngIf="!studentNumber && !loading">
              {{ 'drive.studentNumberMissing' | t }}
              <a regionLink="/account/verification" (click)="close.emit()">{{ 'drive.studentNumberVerify' | t }}</a>
            </span>
          </div>
          <div class="claim-field">
            <ui-dropdown
              [label]="'drive.department' | t"
              [placeholder]="'drive.departmentPlaceholder' | t"
              [options]="departmentOptions"
              [allowCustom]="true"
              [(ngModel)]="department"
            ></ui-dropdown>
            <span class="claim-note" *ngIf="fromRoster">{{ 'drive.fromRoster' | t }}</span>
          </div>
          <ui-dropdown [label]="'drive.grade' | t" [searchable]="false" [options]="gradeOptions" [(ngModel)]="grade"></ui-dropdown>
          <p class="claim-explain">{{ 'drive.claimExplain' | t: { max: drive.max_claims_per_user } }}</p>
        </div>

        <p *ngIf="error" class="claim-error" role="alert">{{ error }}</p>

        <div class="claim-actions">
          <span class="claim-action claim-action--start" *ngIf="claim">
            <ui-button variant="ghost" [disabled]="busy" (onClick)="cancelClaim()">{{ 'drive.cancelClaim' | t }}</ui-button>
          </span>
          <span class="claim-action">
            <ui-button variant="ghost" (onClick)="close.emit()">{{ 'common.cancel' | t }}</ui-button>
          </span>
          <span class="claim-action" *ngIf="claim || verified">
            <ui-button [disabled]="busy || loading" (onClick)="submit()">
              {{ busy ? ('drive.saving' | t) : ((claim ? 'drive.saveClaim' : 'drive.submitClaim') | t) }}
            </ui-button>
          </span>
        </div>
      </div>
    </div>
  `,
  styles: [`
    /* ui-confirm-dialog's overlay and panel; z-index below it, so the confirm for cancelling opens on top. */
    .claim-overlay {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-4);
      background: rgba(0, 0, 0, 0.5);
      animation: claim-fade 140ms ease-out;
    }
    .claim-dialog {
      box-sizing: border-box;
      width: 100%;
      max-width: 460px;
      max-height: calc(100dvh - 2 * var(--space-4));
      overflow-y: auto;
      padding: var(--space-5);
      background: var(--surface-raised);
      border: 1px solid var(--surface-raised-border);
      border-radius: var(--radius-card);
      box-shadow: var(--shadow-card-lg);
      color: var(--ink);
    }
    .claim-title { margin: 0 0 var(--space-3); font-size: var(--text-xl); line-height: 1.3; }
    .claim-subject { margin-bottom: var(--space-4); }
    .claim-book { margin: 0; font-size: var(--text-lg); line-height: 1.35; }
    .claim-org { margin: var(--space-1) 0 0; color: var(--ink-soft); font-size: var(--text-sm); }
    .claim-panel {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
      padding: 16px;
      margin-bottom: var(--space-4);
      background-color: var(--paper-warm);
      border: 1px solid var(--line);
      border-radius: var(--radius-panel);
    }
    .claim-panel p { margin: 0; color: var(--ink-soft); line-height: 1.5; }
    .claim-fields { display: flex; flex-direction: column; gap: var(--space-4); }
    .claim-field { display: flex; flex-direction: column; gap: var(--space-1); }
    .claim-label { font-size: var(--text-base); font-weight: 500; color: var(--ink); }
    .claim-number { font-variant-numeric: tabular-nums; letter-spacing: 0.04em; }
    .claim-number .claim-note { letter-spacing: normal; }
      .claim-note a {
        color: var(--accent);
        font-weight: 500;
      }
    .claim-note { color: var(--muted); font-size: var(--text-sm); line-height: 1.5; }
    .claim-explain { margin: 0; color: var(--muted); font-size: var(--text-sm); line-height: 1.5; }
    .claim-error { margin: var(--space-3) 0 0; color: var(--danger); font-size: var(--text-sm); }
    .claim-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-5); }
    .claim-action--start { margin-right: auto; }
    @media (max-width: 380px) {
      .claim-actions { flex-direction: column-reverse; }
      .claim-action { width: 100%; }
      .claim-action--start { margin-right: 0; }
    }
    @keyframes claim-fade { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .claim-overlay { animation: none; } }
  `],
})
export class UiDriveClaimDialog implements OnInit {
  private drives = inject(DriveService);
  private metadata = inject(MetadataService);
  private auth = inject(AuthStore);
  private confirms = inject(ConfirmService);
  private toasts = inject(ToastService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);

  @Input({ required: true }) drive!: DriveHead;
  @Input({ required: true }) bookId!: string;
  @Input() bookTitle = '';
  /** The viewer's live registration for this title, to change or cancel; null to register. */
  @Input() claim: DriveClaim | null = null;
  /** The registration as it now stands (null once cancelled). */
  @Output() saved = new EventEmitter<DriveClaim | null>();
  @Output() close = new EventEmitter<void>();

  department = '';
  grade = '';
  studentNumber = '';
  fromRoster = false;
  departmentOptions: DropdownOption[] = [];
  readonly gradeOptions: DropdownOption[] = [
    { value: '', label: this.i18n.t('drive.gradeNone') },
    ...GRADES.map((g) => ({ value: String(g), label: this.i18n.t('drive.gradeN', { n: g }) })),
  ];
  loading = true;
  busy = false;
  error = '';

  get verified(): boolean {
    return this.auth.isVerifiedIn(this.drive.region);
  }

  ngOnInit(): void {
    this.metadata.getMetadataWithRetry().subscribe({
      next: (data) => {
        this.departmentOptions = (data?.categories ?? []).flatMap((c: any) =>
          (c.departments ?? []).map((d: { name: string; aliases?: string[] }) => ({
            value: d.name,
            label: d.name,
            group: c.title,
            keywords: d.aliases ?? [],
          })),
        );
        this.cdr.markForCheck();
      },
    });
    if (this.claim) {
      this.studentNumber = this.claim.student_number;
      this.department = this.claim.department;
      this.grade = this.claim.grade ? String(this.claim.grade) : '';
      this.loading = false;
      return;
    }
    if (!this.verified) {
      this.loading = false;
      return;
    }
    this.drives.defaults(this.drive.id).subscribe({
      next: (d) => {
        this.studentNumber = d.student_number;
        this.department = d.department;
        this.grade = d.grade ? String(d.grade) : '';
        this.fromRoster = d.from_roster;
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.loading = false;
        this.cdr.markForCheck();
      },
    });
  }

  submit(): void {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    const input = {
      department: this.department.trim(),
      grade: this.grade ? Number(this.grade) : null,
    };
    const req = this.claim
      ? this.drives.update(this.drive.id, this.claim.id, input)
      : this.drives.register(this.drive.id, this.bookId, input);
    req.subscribe({
      next: (claim) => {
        this.busy = false;
        this.toasts.success(this.i18n.t(this.claim ? 'drive.claimSaved' : 'drive.claimRegistered'));
        this.saved.emit(claim);
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.busy = false;
        this.error = parseApiError(err, this.i18n, 'drive.claimFailed');
        this.cdr.markForCheck();
      },
    });
  }

  async cancelClaim(): Promise<void> {
    if (!this.claim || this.busy) return;
    const ok = await this.confirms.askDanger(
      this.i18n.t('drive.cancelClaimConfirm', { title: this.bookTitle }),
      {
        confirmLabel: this.i18n.t('drive.cancelClaim'),
      },
    );
    if (!ok) return;
    this.busy = true;
    this.error = '';
    this.cdr.markForCheck();
    this.drives.cancel(this.drive.id, this.claim.id).subscribe({
      next: () => {
        this.busy = false;
        this.toasts.success(this.i18n.t('drive.claimCancelled'));
        this.saved.emit(null);
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.busy = false;
        this.error = parseApiError(err, this.i18n, 'drive.claimFailed');
        this.cdr.markForCheck();
      },
    });
  }
}
