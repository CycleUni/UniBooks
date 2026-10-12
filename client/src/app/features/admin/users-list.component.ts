import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, inject, ChangeDetectorRef, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminUser } from '../../core/services/admin.service';
import { parseAdminError } from '../../core/admin-error.util';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { ToastService } from '../../core/services/toast.service';
import { UiSearchBarComponent } from '../../shared/ui/search-bar.component';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { AuthStore } from '../../core/auth.store';
import { RegionService } from '../../core/region.service';
import { AdminBulkBarComponent } from './bulk-bar.component';
import { AdminPickCellComponent } from './pick-cell.component';
import { BulkController } from './bulk';
import { UiButton } from '../../shared/ui/button.component';

@Component({
  selector: 'app-admin-users-list',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, FormsModule, TPipe, UiSkeleton, UiErrorState, UiSearchBarComponent, UiDropdown, UiPagination, UiButton, AdminBulkBarComponent, AdminPickCellComponent],
  template: `
    <div class="admin-filters">
      <ui-search-bar [placeholder]="'admin.searchUsers' | t" [value]="q" (search)="onSearch($event)"></ui-search-bar>
      <ui-dropdown [label]="'admin.filterActive' | t" [options]="activeOptions" [(ngModel)]="isActiveFilter" (ngModelChange)="reload()" [searchable]="false"></ui-dropdown>
    </div>

    <admin-bulk-bar *ngIf="!loading && !loadError && users.length" [count]="bulk.selection.size" [busy]="bulk.busy" (clear)="bulk.selection.clear()">
      <ui-button size="sm" variant="danger" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkActive(false)">{{ 'admin.bulk.deactivate' | t }}</ui-button>
      <ui-button size="sm" variant="outline" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkActive(true)">{{ 'admin.bulk.activate' | t }}</ui-button>
    </admin-bulk-bar>

    <ui-skeleton *ngIf="loading" variant="table" [count]="5"></ui-skeleton>

    <ui-error-state *ngIf="!loading && loadError" [message]="loadError" (retry)="reload()"></ui-error-state>

    <div class="table-container">


      <table class="admin-table admin-table-clickable" *ngIf="!loading && !loadError">
      <thead>
        <tr>
          <th adminPick
            [checked]="bulk.selection.allOf(pageIds)"
            [indeterminate]="bulk.selection.size > 0 && !bulk.selection.allOf(pageIds)"
            [disabled]="bulk.busy || !pageIds.length"
            [label]="'admin.bulk.selectAll' | t"
            (toggle)="bulk.selection.toggleAll(pageIds)"></th>
          <th>{{ 'admin.colRegion' | t }}</th>
          <th>{{ 'admin.colEmail' | t }}</th>
          <th>{{ 'admin.colName' | t }}</th>
          <th>{{ 'admin.colSchool' | t }}</th>
          <th>{{ 'admin.colVerified' | t }}</th>
          <th>{{ 'admin.colActive' | t }}</th>
        </tr>
      </thead>
      <tbody>
        <tr *ngFor="let user of users" [regionLink]="[user.id]" [class.picked]="bulk.selection.has(user.id)">
          <td adminPick
            [checked]="bulk.selection.has(user.id)"
            [disabled]="bulk.busy"
            [label]="'admin.bulk.selectRow' | t: { name: user.email }"
            (toggle)="bulk.selection.toggle(user.id)"></td>
          <td>{{ formatRegions(user.regions) }}</td>
          <td>{{ user.email }}</td>
          <td>{{ user.display_name || (user.first_name + ' ' + user.last_name) }}</td>
          <td>{{ formatSchools(user) }}</td>
          <td>
            <span class="admin-status-badge" [class.ok]="user.is_verified">{{ (user.is_verified ? 'admin.yes' : 'admin.no') | t }}</span>
          </td>
          <td>
            <span class="admin-status-badge" [class.ok]="user.is_active">{{ (user.is_active ? 'admin.yes' : 'admin.no') | t }}</span>
          </td>
        </tr>
        <tr *ngIf="users.length === 0">
          <td colspan="7" class="empty-note">{{ (hasFilters ? 'common.noMatches' : 'common.noData') | t }}</td>
        </tr>
      </tbody>
    </table>


    </div>

    <ui-pagination [total]="total" [pageSize]="pageSize" [currentPage]="page" (pageChange)="onPageChange($event)"></ui-pagination>
  `,
  styles: [`
  `]
})
export class AdminUsersListComponent {
  private adminService = inject(AdminService);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);
  private authStore = inject(AuthStore);
  private regionService = inject(RegionService);

  users: AdminUser[] = [];
  total = 0;
  page = 1;
  pageSize = 20;
  q = '';
  isActiveFilter = '';
  loading = true;
  /** Why the last load failed; the table would otherwise read as empty. */
  loadError = '';
  bulk = new BulkController<string | number>(() => this.reload());

  get pageIds(): (string | number)[] {
    return this.users.map((u) => u.id);
  }

  /** Whether the table the admin is looking at is narrowed by anything. An
   *  empty result then means "nothing matched", which is a different fact
   *  from "this table has no rows at all" — and only the second one should
   *  read as an empty-table message. */
  get hasFilters(): boolean {
    return !!(this.q || this.isActiveFilter);
  }

  getRegionName(code?: string): string {
    if (!code) return '';
    const reg = this.regionService.regions().find(r => r.code === code);
    return reg ? reg.localized_name : code;
  }

  formatRegions(regions?: string[]): string {
    if (!regions || regions.length === 0) return this.i18n.t('admin.noRegion');
    return regions.map(r => this.getRegionName(r)).join(', ');
  }

  formatSchools(user: AdminUser): string {
    if (user.verifications && user.verifications.length > 0) {
      if (user.verifications.length > 1) {
        return user.verifications.map(v => `${this.getRegionName(v.region)}: ${v.school_name}`).join(', ');
      }
      return user.verifications[0].school_name;
    }
    return user.school_name || '';
  }


  get activeOptions() {
    return [
      { value: '', label: this.i18n.t('admin.filterAll') },
      { value: 'true', label: this.i18n.t('admin.filterActiveOnly') },
      { value: 'false', label: this.i18n.t('admin.filterInactiveOnly') },
    ];
  }

  constructor() {
    // school_name is localized server-side, and every filter/header label
    // here goes through the i18n `t` pipe — but none of that re-fetches the
    // already-loaded rows. Re-run the query on language change so the table
    // actually reflects the new language instead of staying stuck on
    // whatever was active when the page first loaded (same fix as the user
    // detail page's school dropdown).
    effect(() => {
      this.i18n.lang();
      untracked(() => this.reload());
    });
  }

  onSearch(q: string) {
    this.q = q;
    this.page = 1;
    this.reload();
  }

  onPageChange(page: number) {
    this.page = page;
    this.reload();
  }

  bulkActive(active: boolean) {
    const n = this.bulk.selection.size;
    this.bulk.run((id) => this.adminService.updateUser(id, { is_active: active }), {
      confirm: this.i18n.t(active ? 'admin.bulk.confirmActivate' : 'admin.bulk.confirmDeactivate', { n }),
      danger: !active,
      confirmLabel: this.i18n.t(active ? 'admin.bulk.activate' : 'admin.bulk.deactivate'),
    });
  }

  reload() {
    this.bulk.reset();
    this.loading = true;
    this.loadError = '';
    this.adminService.getUsers({ page: this.page, q: this.q, is_active: this.isActiveFilter, region: this.regionService.region().toUpperCase() }).subscribe({
      next: (res) => {
        this.users = res.results;
        this.total = res.count;
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
        this.loading = false;
        this.cdr.markForCheck();
      }
    });
  }
}
