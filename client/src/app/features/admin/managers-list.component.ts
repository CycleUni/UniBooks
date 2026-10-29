import { Component, inject, ChangeDetectorRef, effect, untracked } from '@angular/core';
import { AdminEmailPipe, AdminEmailVisibility } from './admin-email.pipe';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { AdminService, AdminUser } from '../../core/services/admin.service';
import { AuthStore, hasStaffAccess, isAdminUser } from '../../core/auth.store';
import { parseAdminError } from '../../core/admin-error.util';
import { AccountService } from '../../core/services/account.service';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { UiSearchBarComponent } from '../../shared/ui/search-bar.component';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { AdminBulkBarComponent } from './bulk-bar.component';
import { AdminPickCellComponent } from './pick-cell.component';
import { BulkController } from './bulk';
import { UiButton } from '../../shared/ui/button.component';
import { UiCheckbox } from '../../shared/ui/checkbox.component';
import { UiInput } from '../../shared/ui/input.component';
import { RegionService } from '../../core/region.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The accounts that hold admin rights, and where a superuser hands them out.
 *
 * Rights are per region, and the region is the one the console is open in: a
 * superuser adding someone on /tw/admin/managers makes them a Taiwan manager
 * (another region is added from that region's console). Which regions an
 * account manages shows when its row is opened, where they can be taken away
 * one by one. Nothing here depends on where the account verified a school.
 */
@Component({
  selector: 'app-admin-managers-list',
  standalone: true,
  imports: [
    AdminEmailPipe,
    CommonModule,
    RouterModule,
    FormsModule,
    TPipe,
    UiSkeleton,
    UiErrorState,
    UiSearchBarComponent,
    UiDropdown,
    UiPagination,
    UiButton,
    UiCheckbox,
    UiInput,
    AdminBulkBarComponent,
    AdminPickCellComponent,
  ],
  template: `
    <div class="admin-filters">
      <ui-search-bar
        [placeholder]="
          (emailVisibility.revealed() ? 'admin.searchUsers' : 'admin.searchUsersNoEmail') | t
        "
        [value]="q"
        (search)="onSearch($event)"
      ></ui-search-bar>
      <ui-dropdown
        [label]="'admin.filterActive' | t"
        [options]="activeOptions"
        [(ngModel)]="isActiveFilter"
        (ngModelChange)="reload()"
        [searchable]="false"
      ></ui-dropdown>
      <ui-button *ngIf="isSuperuser && !adding" class="add-manager-btn" (onClick)="openAdd()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        {{ 'admin.addManager' | t }}
      </ui-button>
    </div>

    <ui-checkbox
      *ngIf="emailVisibility.canReveal()"
      class="email-toggle"
      [ngModel]="emailVisibility.revealed()"
      (ngModelChange)="onShowEmails($event)"
      [label]="'admin.showEmails' | t"
    ></ui-checkbox>

    <form *ngIf="adding" class="add-manager" (ngSubmit)="addManager()">
      <p class="add-manager-hint">
        {{ 'admin.addManagerHint' | t: { region: currentRegionName } }}
      </p>
      <div class="add-manager-row">
        <ui-input
          name="uuid"
          [(ngModel)]="newUuid"
          [placeholder]="'admin.uuidPlaceholder' | t"
          [ariaLabel]="'admin.uuidPlaceholder' | t"
          [error]="addError"
          autocomplete="off"
          enterkeyhint="done"
        ></ui-input>
        <ui-button type="submit" [disabled]="addBusy">{{
          (addBusy ? 'admin.addManagerBusy' : 'admin.addManagerSubmit') | t
        }}</ui-button>
        <ui-button variant="ghost" [disabled]="addBusy" (onClick)="closeAdd()">{{
          'common.cancel' | t
        }}</ui-button>
      </div>
    </form>

    <admin-bulk-bar
      *ngIf="!loadError && isSuperuser && users.length"
      [count]="bulk.selection.size"
      [busy]="bulk.busy"
      (clear)="bulk.selection.clear()"
    >
      <ui-button
        size="sm"
        variant="danger"
        [disabled]="bulk.busy || !bulk.selection.size"
        (onClick)="bulkRevoke()"
        >{{ 'admin.revokeAdmin' | t }}</ui-button
      >
    </admin-bulk-bar>

    <ui-skeleton *ngIf="loading && !loaded" variant="table" [count]="5"></ui-skeleton>

    <ui-error-state
      *ngIf="!loading && loadError"
      [message]="loadError"
      (retry)="reload()"
    ></ui-error-state>

    <div class="table-container">
      <table
        class="admin-table admin-table-clickable"
        *ngIf="loaded && !loadError"
        [class.stale]="loading"
      >
        <thead>
          <tr>
            <th
              adminPick
              [checked]="bulk.selection.allOf(pageIds)"
              [indeterminate]="bulk.selection.size > 0 && !bulk.selection.allOf(pageIds)"
              [disabled]="bulk.busy || !pageIds.length"
              [label]="'admin.bulk.selectAll' | t"
              (toggle)="bulk.selection.toggleAll(pageIds)"
            ></th>
            <th>{{ 'admin.colUuid' | t }}</th>
            <th *ngIf="emailVisibility.revealed()">{{ 'admin.colEmail' | t }}</th>
            <th>{{ 'admin.colName' | t }}</th>
            <th>{{ 'admin.colAdmin' | t }}</th>
            <th class="expand-col">
              <span class="sr-only">{{ 'admin.colManagedRegions' | t }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <ng-container *ngFor="let user of users">
            <tr
              [class.picked]="bulk.selection.has(user.id)"
              [class.open]="openId === user.id"
              (click)="toggleOpen(user)"
              [attr.aria-expanded]="openId === user.id"
            >
              <td
                adminPick
                (click)="$event.stopPropagation()"
                [checked]="bulk.selection.has(user.id)"
                [disabled]="bulk.busy || !canManage(user)"
                [label]="
                  'admin.bulk.selectRow'
                    | t: { name: user.display_name || (user.email | adminEmail) }
                "
                (toggle)="bulk.selection.toggle(user.id)"
              ></td>
              <td class="uuid-cell" [title]="user.id">{{ user.id }}</td>
              <td *ngIf="emailVisibility.revealed()">{{ user.email | adminEmail }}</td>
              <td>{{ user.display_name || user.first_name + ' ' + user.last_name }}</td>
              <td>
                <span
                  class="admin-status-badge superuser-badge"
                  *ngIf="user.role === 'admin'; else staffBadge"
                  >{{ 'admin.superuser' | t }}</span
                >
                <ng-template #staffBadge
                  ><span class="admin-status-badge ok">{{
                    'admin.colAdmin' | t
                  }}</span></ng-template
                >
              </td>
              <td class="expand-col">
                <button
                  type="button"
                  class="expand-btn"
                  (click)="$event.stopPropagation(); toggleOpen(user)"
                  [attr.aria-label]="'admin.colManagedRegions' | t"
                  [attr.aria-expanded]="openId === user.id"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.75"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </button>
              </td>
            </tr>
            <!-- Opened: the regions this account manages. -->
            <tr *ngIf="openId === user.id" class="detail-row">
              <td [attr.colspan]="columns">
                <div class="detail">
                  <span class="detail-label">{{ 'admin.colManagedRegions' | t }}</span>
                  <span *ngIf="user.role === 'admin'" class="text-muted">{{
                    'admin.allRegions' | t
                  }}</span>
                  <ng-container *ngIf="user.role === 'staff'">
                    <span *ngFor="let code of user.managed_regions ?? []" class="region-chip">
                      {{ regionName(code) }}
                      <button
                        *ngIf="canManage(user)"
                        type="button"
                        class="region-remove"
                        [disabled]="busyIds.has(user.id)"
                        [attr.aria-label]="'admin.removeRegion' | t: { region: regionName(code) }"
                        (click)="removeRegion(user, code)"
                      >
                        &times;
                      </button>
                    </span>
                    <span *ngIf="!user.managed_regions?.length" class="no-regions">{{
                      'admin.noManagedRegions' | t
                    }}</span>
                  </ng-container>
                  <ui-button
                    *ngIf="canManage(user)"
                    class="detail-revoke"
                    size="sm"
                    variant="danger"
                    [disabled]="busyIds.has(user.id)"
                    (onClick)="revoke(user)"
                    >{{ 'admin.revokeAdmin' | t }}</ui-button
                  >
                </div>
              </td>
            </tr>
          </ng-container>
          <tr *ngIf="users.length === 0">
            <td [attr.colspan]="columns" class="empty-note">
              {{ (hasFilters ? 'common.noMatches' : 'common.noData') | t }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ui-pagination
      [total]="total"
      [pageSize]="pageSize"
      [currentPage]="page"
      (pageChange)="onPageChange($event)"
    ></ui-pagination>
  `,
  styles: [
    `
      .email-toggle {
        display: block;
        margin-bottom: var(--space-2);
      }
      .uuid-cell {
        max-width: 120px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: monospace;
        font-size: var(--text-sm);
      }
      /* ui-button stretches to the row by default, which pinned the button to
         the top of a row the dropdown's label makes taller; sit it on the
         search field's baseline at the search field's height instead. */
      .add-manager-btn {
        align-self: flex-end;
      }
      .add-manager-btn ::ng-deep .ui-btn {
        min-height: 45px;
      }
      .superuser-badge {
        background: var(--special-bg);
        color: var(--special-ink);
      }
      .add-manager {
        margin-bottom: var(--space-4);
        padding: var(--space-4);
        border: 1px solid var(--line);
        border-radius: var(--radius-card);
        background: var(--paper-warm);
      }
      .add-manager-hint {
        margin: 0 0 var(--space-3);
        font-size: var(--text-sm);
        color: var(--ink-soft);
      }
      .add-manager-row {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        gap: var(--space-2);
      }
      .add-manager-row ui-input {
        flex: 1 1 320px;
        min-width: 0;
      }
      .expand-col {
        width: var(--tap-min);
        text-align: right;
      }
      .expand-btn {
        width: var(--tap-min);
        height: var(--tap-min);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: none;
        background: none;
        color: var(--muted);
        cursor: pointer;
        border-radius: var(--radius-control);
      }
      .expand-btn svg {
        transition: transform var(--motion-fast) ease;
      }
      tr.open .expand-btn svg {
        transform: rotate(180deg);
      }
      @media (prefers-reduced-motion: reduce) {
        .expand-btn svg {
          transition: none;
        }
      }
      .detail-row td {
        background: var(--paper-warm);
      }
      .detail {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
      }
      .detail-label {
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--muted);
        margin-right: var(--space-2);
      }
      .region-chip {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        padding: 2px 4px 2px 10px;
        border: 1px solid var(--line-strong);
        border-radius: 999px;
        font-size: var(--text-sm);
      }
      .region-remove {
        min-width: 28px;
        min-height: 28px;
        border: none;
        background: none;
        color: var(--muted);
        font-size: var(--text-md);
        line-height: 1;
        cursor: pointer;
        border-radius: 50%;
      }
      .region-remove:hover {
        color: var(--danger);
        background: var(--danger-light);
      }
      .detail-revoke {
        margin-left: auto;
      }
      /* A staff member with no region can do nothing in the admin console yet. */
      .no-regions {
        font-size: var(--text-sm);
        color: var(--warn-ink);
      }
      .text-muted {
        color: var(--muted);
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
export class AdminManagersListComponent {
  emailVisibility = inject(AdminEmailVisibility);
  private adminService = inject(AdminService);
  private accountService = inject(AccountService);
  private auth = inject(AuthStore);
  private regionService = inject(RegionService);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private confirms = inject(ConfirmService);
  private cdr = inject(ChangeDetectorRef);

  users: AdminUser[] = [];
  total = 0;
  page = 1;
  pageSize = 20;
  q = '';
  isActiveFilter = 'true';
  loading = true;
  /** Set by the first successful load; later reloads keep the table on screen, dimmed. */
  loaded = false;
  /** Why the last load failed; the table would otherwise read as empty. */
  loadError = '';
  bulk = new BulkController<string | number>(() => this.reload());

  /** The row whose regions are showing. */
  openId: string | number | null = null;
  /** Accounts with a change in flight: their buttons wait for the answer. */
  readonly busyIds = new Set<string | number>();

  adding = false;
  newUuid = '';
  addError = '';
  addBusy = false;

  isSuperuser = false;

  get pageIds(): (string | number)[] {
    return this.users.filter((u) => this.canManage(u)).map((u) => u.id);
  }

  get columns(): number {
    return this.emailVisibility.revealed() ? 6 : 5;
  }

  /** Whether the table the admin is looking at is narrowed by anything. An
   *  empty result then means "nothing matched", which is a different fact
   *  from "this table has no rows at all" — and only the second one should
   *  read as an empty-table message. */
  get hasFilters(): boolean {
    return !!(this.q || this.isActiveFilter);
  }

  /** The region this console is open in: the one an added manager gets. */
  get currentRegion(): string {
    return this.regionService.region().toUpperCase();
  }

  get currentRegionName(): string {
    return this.regionName(this.currentRegion);
  }

  constructor() {
    // AuthStore.user, not profileCache: a language switch clears the cache,
    // which took the superuser's controls away until the next reload.
    effect(() => {
      this.isSuperuser = isAdminUser(this.auth.user() ?? this.accountService.profileCache());
      this.cdr.markForCheck();
    });
    // Names and labels follow the language: load again when it changes (as the users page does).
    effect(() => {
      this.i18n.lang();
      untracked(() => this.reload());
    });
  }

  get activeOptions() {
    return [
      { value: '', label: this.i18n.t('admin.filterAll') },
      { value: 'true', label: this.i18n.t('admin.filterActiveOnly') },
      { value: 'false', label: this.i18n.t('admin.filterInactiveOnly') },
    ];
  }

  regionName(code: string): string {
    return this.regionService.regions().find((r) => r.code === code)?.localized_name || code;
  }

  onSearch(q: string) {
    this.q = q;
    this.page = 1;
    this.reload();
  }

  /** Email matches depend on the toggle, so the current search re-runs. */
  onShowEmails(value: boolean) {
    this.emailVisibility.set(value);
    if (this.q) this.onSearch(this.q);
  }

  onPageChange(page: number) {
    this.page = page;
    this.reload();
  }

  reload() {
    this.bulk.reset();
    this.loading = true;
    this.loadError = '';
    this.adminService
      .getUsers({
        page: this.page,
        q: this.q,
        role: 'managers',
        show_email: this.emailVisibility.revealed() ? 'true' : undefined,
        is_active: this.isActiveFilter,
      })
      .subscribe({
        next: (res) => {
          this.users = res.results;
          this.total = res.count;
          this.loading = false;
          this.loaded = true;
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
          this.loading = false;
          this.cdr.markForCheck();
        },
      });
  }

  /** Superusers manage staff; superuser accounts are not granted or taken here. */
  canManage(user: AdminUser): boolean {
    return this.isSuperuser && user.role === 'staff';
  }

  toggleOpen(user: AdminUser) {
    this.openId = this.openId === user.id ? null : user.id;
  }

  openAdd() {
    this.adding = true;
    this.newUuid = '';
    this.addError = '';
  }

  closeAdd() {
    this.adding = false;
    this.addError = '';
  }

  /**
   * Gives the account with this UUID admin rights in the region this console
   * is open in, keeping any regions it already manages.
   */
  async addManager() {
    if (this.addBusy) return;
    const id = this.newUuid.trim().toLowerCase();
    if (!UUID_RE.test(id)) {
      this.addError = this.i18n.t('admin.errInvalidUuid');
      return;
    }
    const region = this.currentRegion;
    this.addBusy = true;
    this.addError = '';
    this.cdr.markForCheck();
    try {
      let target: AdminUser;
      try {
        target = await firstValueFrom(this.adminService.getUser(id));
      } catch (err: any) {
        this.addError =
          err?.status === 404
            ? this.i18n.t('admin.errUserNotFound')
            : parseAdminError(err, this.i18n);
        return;
      }
      if (target.role === 'admin') {
        this.addError = this.i18n.t('admin.alreadySuperuser');
        return;
      }
      const regions = target.role === 'staff' ? (target.managed_regions ?? []) : [];
      if (regions.includes(region)) {
        this.addError = this.i18n.t('admin.alreadyManagesRegion', {
          region: this.regionName(region),
        });
        return;
      }
      const updated = await firstValueFrom(
        this.adminService.setManager(id, 'staff', [...regions, region]),
      );
      this.toast.success(
        this.i18n.t('admin.managerAdded', {
          name: updated.display_name || id,
          region: this.regionName(region),
        }),
      );
      this.adding = false;
      this.openId = updated.id;
      this.reload();
    } catch (err) {
      this.addError = parseAdminError(err, this.i18n);
    } finally {
      this.addBusy = false;
      this.cdr.markForCheck();
    }
  }

  /** Taking away the last region takes the admin rights too: a manager of nothing is not one. */
  async removeRegion(user: AdminUser, code: string) {
    if (!this.canManage(user) || this.busyIds.has(user.id)) return;
    const rest = (user.managed_regions ?? []).filter((c) => c !== code);
    const name = user.display_name || String(user.id);
    const confirmed = await this.confirms.askDanger(
      rest.length
        ? this.i18n.t('admin.confirmRemoveRegion', { name, region: this.regionName(code) })
        : this.i18n.t('admin.confirmRemoveLastRegion', { name, region: this.regionName(code) }),
      { confirmLabel: this.i18n.t('admin.removeRegion', { region: this.regionName(code) }) },
    );
    if (!confirmed) return;
    this.save(
      user,
      rest.length
        ? this.adminService.setManagedRegions(user.id, rest)
        : this.adminService.setManagerRole(user.id, 'user'),
    );
  }

  async revoke(user: AdminUser) {
    if (!this.canManage(user) || this.busyIds.has(user.id)) return;
    const action = this.i18n.t('admin.revokeAdmin');
    const confirmed = await this.confirms.askDanger(
      this.i18n.t('admin.confirmToggleAdmin', { action, email: user.display_name || String(user.id) }),
      { confirmLabel: action },
    );
    if (!confirmed) return;
    this.save(user, this.adminService.setManagerRole(user.id, 'user'));
  }

  private save(user: AdminUser, request: ReturnType<AdminService['setManagerRole']>) {
    this.busyIds.add(user.id);
    this.cdr.markForCheck();
    request.subscribe({
      next: (updated) => {
        this.busyIds.delete(user.id);
        if (!hasStaffAccess(updated)) {
          // No longer an admin: it leaves this list.
          this.openId = null;
          this.reload();
          return;
        }
        user.managed_regions = updated.managed_regions ?? [];
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.busyIds.delete(user.id);
        this.toast.error(parseAdminError(err, this.i18n));
        this.cdr.markForCheck();
      },
    });
  }

  /** Only admin rights can be taken in bulk; granting stays one at a time. */
  bulkRevoke() {
    this.bulk.run((id) => this.adminService.setManagerRole(id, 'user'), {
      confirm: this.i18n.t('admin.bulk.confirmRevokeAdmin', { n: this.bulk.selection.size }),
      danger: true,
      confirmLabel: this.i18n.t('admin.revokeAdmin'),
    });
  }
}
