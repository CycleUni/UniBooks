import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminEmailPipe } from './admin-email.pipe';
import { RegionLinkDirective } from '../../core/region-link.directive';
import {
  AdminService,
  AdminStudentIdVerification,
  StudentIdVerificationStatus,
} from '../../core/services/admin.service';
import { parseAdminError } from '../../core/admin-error.util';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { UiButton } from '../../shared/ui/button.component';
import { UiDropdown, DropdownOption } from '../../shared/ui/dropdown.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { UiFocusTrapDirective } from '../../shared/ui/focus-trap.directive';
import { RegionService } from '../../core/region.service';

@Component({
  selector: 'app-admin-student-id-verifications-list',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    FormsModule,
    AdminEmailPipe,
    RegionLinkDirective,
    TPipe,
    UiSkeleton,
    UiErrorState,
    UiButton,
    UiDropdown,
    UiPagination,
    UiFocusTrapDirective,
  ],
  template: `
    <div class="section-head-row">
      <h2>{{ 'admin.studentIdVerificationsTitle' | t }}</h2>
    </div>

    <div class="admin-filters">
      <ui-dropdown
        [label]="'admin.colStatus' | t"
        [options]="statusFilterOptions"
        [(ngModel)]="statusFilter"
        (ngModelChange)="reload()"
        [searchable]="false"
      ></ui-dropdown>
    </div>

    <ui-skeleton *ngIf="loading && !loaded" variant="spinner"></ui-skeleton>
    <ui-error-state *ngIf="!loading && loadError" [message]="loadError" (retry)="reload()"></ui-error-state>

    <div class="table-container" *ngIf="loaded && !loadError">
      <table class="admin-table admin-table-clickable" [class.stale]="loading">
        <thead>
          <tr>
            <th>{{ 'admin.colRegion' | t }}</th>
            <th>{{ 'admin.colSchool' | t }}</th>
            <th>{{ 'admin.studentNumber' | t }}</th>
            <th>{{ 'admin.colReporter' | t }}</th>
            <th>{{ 'admin.colSubmittedAt' | t }}</th>
            <th>{{ 'admin.colStatus' | t }}</th>
          </tr>
        </thead>
        <tbody>
          <ng-container *ngFor="let req of items">
            <tr class="verification-row" (click)="toggleExpand(req)" [class.expanded]="expandedId === req.id">
              <td>{{ req.region }}</td>
              <td><strong>{{ req.school.name }}</strong> ({{ req.school.code }})</td>
              <td><code>{{ req.student_number }}</code></td>
              <td>
                <a [regionLink]="['/admin/users', req.user.id]" (click)="$event.stopPropagation()">
                  {{ req.user.email | adminEmail }}
                </a>
              </td>
              <td>{{ req.created_at | date:'yyyy/MM/dd HH:mm' }}</td>
              <td>
                <span
                  class="admin-status-badge"
                  [class.warn]="req.status === 'pending'"
                  [class.ok]="req.status === 'approved'"
                  [class.danger]="req.status === 'rejected'"
                >
                  {{ ('admin.studentIdStatus.' + req.status) | t }}
                </span>
              </td>
            </tr>

            <!-- Expanded detail row -->
            <tr class="detail-row" *ngIf="expandedId === req.id">
              <td colspan="6">
                <div class="detail-content">
                  <div class="detail-columns">
                    <!-- Left: Metadata, checks, history -->
                    <div class="detail-info-col">
                      <div class="info-block">
                        <h4>{{ 'admin.colReporter' | t }}</h4>
                        <p>
                          <strong>{{ req.user.first_name }} {{ req.user.last_name }}</strong> &lt;{{ req.user.email }}&gt;
                        </p>
                        <p *ngIf="selectedDetail?.user?.declared_school">
                          <span class="text-muted">{{ 'admin.declaredSchool' | t }}: </span>
                          {{ selectedDetail?.user?.declared_school?.name }} ({{ selectedDetail?.user?.declared_school?.code }})
                        </p>
                      </div>

                      <div class="info-block">
                        <h4>{{ 'admin.studentNumber' | t }}</h4>
                        <p class="student-number-val"><code>{{ req.student_number }}</code></p>
                      </div>

                      <!-- Duplicate student number warning -->
                      <div class="alert-box danger mb-3" *ngIf="hasDuplicateApproved()">
                        <strong>⚠️ {{ 'admin.duplicateStudentNumberWarning' | t }}</strong>
                      </div>

                      <!-- Other accounts using this student number -->
                      <div class="info-block" *ngIf="selectedDetail?.other_accounts_same_student_number?.length">
                        <h4>{{ 'admin.otherAccountsWithSameStudentNumber' | t }}</h4>
                        <ul class="sub-list">
                          <li *ngFor="let other of selectedDetail?.other_accounts_same_student_number">
                            <a [regionLink]="['/admin/users', other.user_id]">{{ other.email | adminEmail }}</a>
                            ({{ other.first_name }} {{ other.last_name }}) —
                            <span class="status-chip" [class.ok]="other.status === 'approved'">{{ ('admin.studentIdStatus.' + other.status) | t }}</span>
                            <span class="text-muted text-xs"> {{ other.created_at | date:'yyyy/MM/dd' }}</span>
                          </li>
                        </ul>
                      </div>

                      <!-- Previous requests of this user -->
                      <div class="info-block" *ngIf="selectedDetail?.previous_requests?.length">
                        <h4>{{ 'admin.previousRequestsOfUser' | t }}</h4>
                        <ul class="sub-list">
                          <li *ngFor="let prev of selectedDetail?.previous_requests">
                            <span>{{ prev.school_name }}: <code>{{ prev.student_number }}</code></span> —
                            <span class="status-chip">{{ ('admin.studentIdStatus.' + prev.status) | t }}</span>
                            <span *ngIf="prev.reject_reason" class="text-danger text-xs"> ({{ prev.reject_reason }})</span>
                            <span class="text-muted text-xs"> {{ prev.created_at | date:'yyyy/MM/dd' }}</span>
                          </li>
                        </ul>
                      </div>

                      <div *ngIf="req.reject_reason" class="info-block reject-reason-box">
                        <h4>{{ 'admin.rejectReason' | t }}</h4>
                        <p>{{ req.reject_reason }}</p>
                      </div>

                      <!-- Actions -->
                      <div class="detail-actions" *ngIf="req.status === 'pending'">
                        <ui-button
                          variant="primary"
                          (onClick)="onApprove(req)"
                          [disabled]="actingId === req.id"
                        >
                          {{ 'admin.approve' | t }}
                        </ui-button>
                        <ui-button
                          variant="danger"
                          (onClick)="startReject(req)"
                          [disabled]="actingId === req.id"
                        >
                          {{ 'admin.reject' | t }}
                        </ui-button>
                      </div>
                    </div>

                    <!-- Right: Photo preview -->
                    <div class="detail-photo-col">
                      <h4>{{ 'acct.studentIdPhoto' | t }}</h4>
                      <div *ngIf="loadingImage" class="photo-loading">
                        <ui-skeleton variant="spinner"></ui-skeleton>
                      </div>
                      <div *ngIf="!loadingImage && currentImageUrl" class="photo-container">
                        <img
                          [src]="currentImageUrl"
                          [alt]="'acct.studentIdPhoto' | t"
                          class="id-card-img"
                          (click)="enlargeModal = true"
                          [title]="'admin.enlargeImage' | t"
                        />
                        <p class="photo-hint">{{ 'admin.enlargeImage' | t }}</p>
                      </div>
                      <div *ngIf="!loadingImage && !currentImageUrl && !req.has_image" class="photo-deleted">
                        <p class="text-muted">🔒 {{ 'admin.imageDeleted' | t }}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </td>
            </tr>
          </ng-container>

          <tr *ngIf="items.length === 0">
            <td colspan="6" class="empty-note">
              {{ 'common.noMatches' | t }}
            </td>
          </tr>
        </tbody>
      </table>

      <ui-pagination
        [total]="total"
        [pageSize]="pageSize"
        [currentPage]="page"
        (pageChange)="onPageChange($event)"
      ></ui-pagination>
    </div>

    <!-- Reject reason modal -->
    <div *ngIf="rejectingVerification" class="modal-overlay" (click)="cancelReject()"></div>
    <div
      *ngIf="rejectingVerification"
      class="modal-dialog reject-dialog"
      role="dialog"
      aria-modal="true"
      uiFocusTrap="reject-reason-title"
      (escape)="cancelReject()"
    >
      <h3 id="reject-reason-title">{{ 'admin.confirmRejectTitle' | t }}</h3>
      <div class="form-group">
        <label for="reject-reason-input">{{ 'admin.rejectReason' | t }}</label>
        <textarea
          id="reject-reason-input"
          class="admin-form-control"
          rows="4"
          maxlength="500"
          [(ngModel)]="rejectReason"
          [placeholder]="'admin.rejectReasonPlaceholder' | t"
        ></textarea>
        <small class="hint">{{ rejectReason.length }}/500</small>
      </div>
      <div class="modal-actions">
        <ui-button variant="ghost" (onClick)="cancelReject()" [disabled]="actingId !== null">
          {{ 'common.cancel' | t }}
        </ui-button>
        <ui-button
          variant="danger"
          (onClick)="confirmReject()"
          [disabled]="actingId !== null || !rejectReason.trim()"
        >
          {{ 'admin.reject' | t }}
        </ui-button>
      </div>
    </div>

    <!-- Enlarged image modal -->
    <div *ngIf="enlargeModal && currentImageUrl" class="modal-overlay" (click)="enlargeModal = false">
      <div class="image-modal-content" (click)="$event.stopPropagation()">
        <img [src]="currentImageUrl" [alt]="'acct.studentIdPhoto' | t" class="enlarged-img" />
        <button class="modal-close-btn" (click)="enlargeModal = false" [attr.aria-label]="'common.close' | t">×</button>
      </div>
    </div>
  `,
  styles: [`
    .section-head-row h2 {
      margin-bottom: 8px;
    }
    .admin-filters {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 16px;
    }
    .verification-row {
      cursor: pointer;
    }
    .verification-row.expanded {
      background: var(--surface-raised);
    }
    .detail-row td {
      padding: 0;
      background: var(--surface-raised);
    }
    .detail-content {
      padding: 20px;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .detail-columns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
    }
    @media (max-width: 768px) {
      .detail-columns {
        grid-template-columns: 1fr;
      }
    }
    .info-block {
      margin-bottom: 16px;
    }
    .info-block h4 {
      margin: 0 0 6px 0;
      font-size: var(--text-sm);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .student-number-val code {
      font-size: var(--text-base);
      font-weight: 700;
    }
    .sub-list {
      list-style: none;
      padding: 0;
      margin: 4px 0 0 0;
      font-size: var(--text-xs);
    }
    .sub-list li {
      padding: 4px 0;
      border-bottom: 1px dashed var(--line);
    }
    .status-chip {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 11px;
      background: var(--surface);
      border: 1px solid var(--line);
    }
    .status-chip.ok {
      background: var(--success-light);
      color: var(--success);
      border-color: var(--success);
    }
    .reject-reason-box {
      background: var(--danger-light);
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--danger);
    }
    .detail-actions {
      display: flex;
      gap: 12px;
      margin-top: 20px;
    }
    .photo-container {
      cursor: pointer;
    }
    .id-card-img {
      max-width: 100%;
      max-height: 320px;
      object-fit: contain;
      border-radius: 8px;
      border: 1px solid var(--line);
      box-shadow: var(--shadow-card);
      transition: transform var(--motion-fast) ease;
    }
    .id-card-img:hover {
      transform: scale(1.02);
    }
    .photo-hint {
      margin-top: 6px;
      font-size: var(--text-xs);
      color: var(--muted);
    }
    .photo-deleted {
      padding: 24px;
      background: var(--surface);
      border: 1px dashed var(--line);
      border-radius: 8px;
      text-align: center;
    }
    .photo-loading {
      padding: 32px;
      text-align: center;
    }
    .empty-note {
      text-align: center;
      padding: 24px;
      color: var(--muted);
    }
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      z-index: 1050;
    }
    .modal-dialog {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: var(--surface-card);
      padding: 24px;
      border-radius: 8px;
      border: 1px solid var(--line);
      box-shadow: var(--shadow-card-lg);
      z-index: 1060;
      width: 480px;
      max-width: 90vw;
    }
    .modal-dialog h3 {
      margin-top: 0;
      margin-bottom: 16px;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      margin-top: 16px;
    }
    .image-modal-content {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 1060;
      max-width: 90vw;
      max-height: 90vh;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .enlarged-img {
      max-width: 90vw;
      max-height: 90vh;
      object-fit: contain;
      border-radius: 8px;
      box-shadow: var(--shadow-card-lg);
    }
    .modal-close-btn {
      position: absolute;
      top: -16px;
      right: -16px;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: var(--surface-card);
      border: 1px solid var(--line);
      color: var(--ink);
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .admin-status-badge.danger {
      background: var(--danger-light);
      color: var(--danger);
    }
    .text-danger {
      color: var(--danger);
    }
    .text-muted {
      color: var(--muted);
    }
    .text-xs {
      font-size: var(--text-xs);
    }
    .mb-3 {
      margin-bottom: var(--space-3, 12px);
    }
    .hint {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: var(--text-xs);
      text-align: right;
    }
  `],
})
export class AdminStudentIdVerificationsListComponent implements OnInit, OnDestroy {
  private adminService = inject(AdminService);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private confirms = inject(ConfirmService);
  private cdr = inject(ChangeDetectorRef);
  readonly regionService = inject(RegionService);

  items: AdminStudentIdVerification[] = [];
  total = 0;
  page = 1;
  pageSize = 20;
  loading = false;
  loaded = false;
  loadError = '';

  statusFilter = 'pending';
  statusFilterOptions: DropdownOption[] = [];

  expandedId: string | null = null;
  selectedDetail: AdminStudentIdVerification | null = null;
  currentImageUrl: string | null = null;
  loadingImage = false;
  enlargeModal = false;

  actingId: string | null = null;
  rejectingVerification: AdminStudentIdVerification | null = null;
  rejectReason = '';

  ngOnInit() {
    this.statusFilterOptions = [
      { value: 'pending', label: this.i18n.t('admin.studentIdStatus.pending') },
      { value: 'approved', label: this.i18n.t('admin.studentIdStatus.approved') },
      { value: 'rejected', label: this.i18n.t('admin.studentIdStatus.rejected') },
      { value: 'cancelled', label: this.i18n.t('admin.studentIdStatus.cancelled') },
      { value: '', label: this.i18n.t('common.all') },
    ];
    this.reload();
  }

  ngOnDestroy() {
    this.revokeCurrentImage();
  }

  private revokeCurrentImage() {
    if (this.currentImageUrl) {
      URL.revokeObjectURL(this.currentImageUrl);
      this.currentImageUrl = null;
    }
  }

  reload() {
    this.page = 1;
    this.loadPage(this.page);
  }

  onPageChange(p: number) {
    this.page = p;
    this.loadPage(p);
  }

  loadPage(page: number) {
    this.loading = true;
    this.loadError = '';
    const opts: { page: number; page_size: number; status?: string } = {
      page,
      page_size: this.pageSize,
    };
    if (this.statusFilter) {
      opts.status = this.statusFilter;
    }

    this.adminService.getStudentIdVerifications(opts).subscribe({
      next: (res) => {
        this.items = res.results || [];
        this.total = res.count || 0;
        this.loading = false;
        this.loaded = true;
        // If the expanded item is no longer in items, collapse it
        if (this.expandedId && !this.items.some((i) => i.id === this.expandedId)) {
          this.collapse();
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loading = false;
        this.loadError = parseAdminError(err, this.i18n);
        this.cdr.markForCheck();
      },
    });
  }

  toggleExpand(req: AdminStudentIdVerification) {
    if (this.expandedId === req.id) {
      this.collapse();
      return;
    }
    this.expandedId = req.id;
    this.selectedDetail = null;
    this.revokeCurrentImage();
    this.loadDetail(req.id);
  }

  collapse() {
    this.expandedId = null;
    this.selectedDetail = null;
    this.revokeCurrentImage();
    this.cdr.markForCheck();
  }

  private loadDetail(id: string) {
    this.adminService.getStudentIdVerification(id).subscribe({
      next: (detail) => {
        if (this.expandedId !== id) return;
        this.selectedDetail = detail;
        if (detail.has_image) {
          this.loadImage(id);
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.toast.error(parseAdminError(err, this.i18n));
        this.cdr.markForCheck();
      },
    });
  }

  private loadImage(id: string) {
    this.loadingImage = true;
    this.adminService.getStudentIdVerificationImageBlob(id).subscribe({
      next: (blob) => {
        if (this.expandedId !== id) return;
        this.revokeCurrentImage();
        this.currentImageUrl = URL.createObjectURL(blob);
        this.loadingImage = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.loadingImage = false;
        this.cdr.markForCheck();
      },
    });
  }

  hasDuplicateApproved(): boolean {
    if (!this.selectedDetail?.other_accounts_same_student_number) return false;
    return this.selectedDetail.other_accounts_same_student_number.some(
      (o) => o.status === 'approved',
    );
  }

  async onApprove(req: AdminStudentIdVerification) {
    if (this.actingId) return;
    const confirmed = await this.confirms.ask({
      title: this.i18n.t('admin.confirmApproveTitle'),
      message: this.i18n.t('admin.confirmApproveStudentId', {
        school: req.school.name,
        student_number: req.student_number,
      }),
      confirmLabel: this.i18n.t('admin.approve'),
      variant: 'primary',
    });
    if (!confirmed) return;

    this.actingId = req.id;
    this.cdr.markForCheck();

    this.adminService.approveStudentIdVerification(req.id).subscribe({
      next: () => {
        this.actingId = null;
        this.toast.success(this.i18n.t('common.save'));
        this.collapse();
        this.loadPage(this.page);
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.actingId = null;
        this.toast.error(parseAdminError(err, this.i18n));
        this.cdr.markForCheck();
      },
    });
  }

  startReject(req: AdminStudentIdVerification) {
    if (this.actingId) return;
    this.rejectingVerification = req;
    this.rejectReason = '';
  }

  cancelReject() {
    this.rejectingVerification = null;
    this.rejectReason = '';
  }

  confirmReject() {
    if (!this.rejectingVerification || !this.rejectReason.trim() || this.actingId) return;
    const req = this.rejectingVerification;
    const reason = this.rejectReason.trim();

    this.actingId = req.id;
    this.cdr.markForCheck();

    this.adminService.rejectStudentIdVerification(req.id, reason).subscribe({
      next: () => {
        this.actingId = null;
        this.rejectingVerification = null;
        this.rejectReason = '';
        this.toast.success(this.i18n.t('common.save'));
        this.collapse();
        this.loadPage(this.page);
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.actingId = null;
        this.toast.error(parseAdminError(err, this.i18n));
        this.cdr.markForCheck();
      },
    });
  }
}
