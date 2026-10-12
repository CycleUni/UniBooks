import { UiButton } from '../../shared/ui/button.component';
import { parseAdminError } from '../../core/admin-error.util';
import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { UiCheckbox } from '../../shared/ui/checkbox.component';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminAdvertiser, Paginated } from '../../core/services/admin.service';
import { MetadataService } from '../../core/services/metadata.service';
import { I18nService, TPipe } from '../../core/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { UiSearchBarComponent } from '../../shared/ui/search-bar.component';
import { AdminBulkBarComponent } from './bulk-bar.component';
import { AdminPickCellComponent } from './pick-cell.component';
import { BulkController } from './bulk';
import { keywordsMatch, schoolKeywords } from '../../core/school-search';

@Component({
  selector: 'app-admin-advertisers-list',
  standalone: true,
  imports: [CommonModule, UiSkeleton, UiErrorState, RouterModule, FormsModule, TPipe, UiSearchBarComponent, UiPagination, UiCheckbox, UiButton, AdminBulkBarComponent, AdminPickCellComponent],
  template: `
    <div class="section-head-row">
      <h2>{{ 'admin.navAdvertisers' | t }}</h2>
      <div class="section-head-actions">
        <ui-button variant="primary" (onClick)="openCreateModal()">{{ 'admin.addAdvertiser' | t }}</ui-button>
      </div>
    </div>

    <div class="admin-filters">
      <ui-search-bar [placeholder]="'admin.searchAdvertisers' | t" [value]="q" (search)="onSearch($event)"></ui-search-bar>
    </div>

    <ui-error-state *ngIf="!loading && loadError" [message]="loadError" (retry)="loadPage(currentPage)"></ui-error-state>
    <admin-bulk-bar *ngIf="!loading && !loadError && advertisersData?.results?.length" [count]="bulk.selection.size" [busy]="bulk.busy" (clear)="bulk.selection.clear()">
      <ui-button size="sm" variant="outline" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkActive(true)">{{ 'admin.bulk.enable' | t }}</ui-button>
      <ui-button size="sm" variant="outline" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkActive(false)">{{ 'admin.bulk.disable' | t }}</ui-button>
      <ui-button size="sm" variant="danger" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkDelete()">{{ 'common.delete' | t }}</ui-button>
    </admin-bulk-bar>

    <div class="table-container" *ngIf="!loading && !loadError && advertisersData">
      <table class="admin-table">
        <thead>
          <tr>
            <th adminPick
              [checked]="bulk.selection.allOf(pageIds)"
              [indeterminate]="bulk.selection.size > 0 && !bulk.selection.allOf(pageIds)"
              [disabled]="bulk.busy || !pageIds.length"
              [label]="'admin.bulk.selectAll' | t"
              (toggle)="bulk.selection.toggleAll(pageIds)"></th>
            <th>ID</th>
            <th>{{ 'admin.advertiserName' | t }}</th>
            <th>{{ 'admin.advertiserEmail' | t }}</th>
            <th>{{ 'admin.advertiserPhone' | t }}</th>
            <th>{{ 'admin.advertiserStatus' | t }}</th>
            <th>{{ 'admin.colActions' | t }}</th>
          </tr>
        </thead>
        <tbody>
          <tr *ngFor="let adv of advertisersData.results" [class.picked]="bulk.selection.has(adv.id)">
            <td adminPick
              [checked]="bulk.selection.has(adv.id)"
              [disabled]="bulk.busy"
              [label]="'admin.bulk.selectRow' | t: { name: adv.company_name }"
              (toggle)="bulk.selection.toggle(adv.id)"></td>
            <td>{{ adv.id }}</td>
            <td>{{ adv.company_name }}</td>
            <td>{{ adv.contact_email }}</td>
            <td>{{ adv.contact_phone }}</td>
            <td>
              <span class="admin-badge" [class.admin-badge-success]="adv.is_active" [class.admin-badge-error]="!adv.is_active">
                {{ adv.is_active ? ('admin.advertiserActive' | t) : ('admin.advertiserInactive' | t) }}
              </span>
            </td>
            <td>
              <ui-button size="sm" variant="outline" (onClick)="openEditModal(adv)">{{ 'common.edit' | t }}</ui-button>
              <ui-button size="sm" variant="outline" (onClick)="deleteAdvertiser(adv.id)"  style="margin-left: 4px; color: var(--danger); border-color: var(--danger);">{{ 'common.delete' | t }}</ui-button>
            </td>
          </tr>
        </tbody>
      </table>

      <ui-pagination [total]="total" [pageSize]="pageSize" [currentPage]="currentPage" (pageChange)="loadPage($event)"></ui-pagination>
    </div>
    
    <ui-skeleton *ngIf="loading" variant="table" [count]="5"></ui-skeleton>

    <div class="app-modal-overlay" *ngIf="showModal">
      <div class="app-modal">
        <h3 class="app-modal-title">{{ editingId ? ('admin.editAdvertiser' | t) : ('admin.addAdvertiser' | t) }}</h3>
        
        <div class="app-modal-body">
          <div class="form-group">
            <label>{{ 'admin.advertiserName' | t }}</label>
            <input type="text" class="admin-form-control" [(ngModel)]="formData.company_name">
          </div>
          <div class="form-group">
            <label>{{ 'admin.advertiserEmail' | t }}</label>
            <input type="email" class="admin-form-control" [(ngModel)]="formData.contact_email">
          </div>
          <div class="form-group">
            <label>{{ 'admin.advertiserPhone' | t }}</label>
            <input type="text" class="admin-form-control" [(ngModel)]="formData.contact_phone">
          </div>
          <div class="form-group">
            <ui-checkbox [(ngModel)]="formData.is_active" [label]="'admin.advertiserActive' | t"></ui-checkbox>
          </div>
          <div class="form-group">
            <ui-checkbox [(ngModel)]="formData.all_schools" [label]="'admin.allSchools' | t"></ui-checkbox>
          </div>
          <div class="form-group" *ngIf="!formData.all_schools">
            <label>{{ 'admin.selectSpecificSchool' | t }}</label>
            <input type="text" class="admin-form-control mb-2" [placeholder]="'admin.searchSchool' | t" [(ngModel)]="schoolSearchQuery" >
            <div class="school-list"  style="max-height: 200px; overflow-y: auto; border: 1px solid var(--line); border-radius: 4px; padding: 8px; display: flex; flex-direction: column; gap: 8px;">
              <div *ngFor="let school of filteredSchools"  style="display: flex; align-items: center; gap: 8px;">
                <ui-checkbox [checked]="formData.schools?.includes(school.id)" (change)="toggleSchool(school.id)" [label]="school.display_name || school.name"></ui-checkbox>
              </div>
              <div *ngIf="filteredSchools.length === 0"  style="color: var(--muted); text-align: center; padding: 12px;">找不到符合的學校</div>
            </div>
          </div>
        </div>
        
        <div class="app-modal-actions">
          <ui-button variant="outline" (onClick)="closeModal()">{{ 'common.cancel' | t }}</ui-button>
          <ui-button variant="primary" (onClick)="save()">{{ 'common.save' | t }}</ui-button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .app-modal { 
      width: 400px; max-width: 90%; 
    }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; margin-bottom: 8px; font-weight: 600; }
  `]
})
export class AdminAdvertisersListComponent implements OnInit {
  private adminService = inject(AdminService);
  private metadataService = inject(MetadataService);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private confirms = inject(ConfirmService);
  private cdr = inject(ChangeDetectorRef);
  
  schools: any[] = [];
  
  advertisersData: Paginated<AdminAdvertiser> | null = null;
  currentPage = 1;
  total = 0;
  pageSize = 20;
  loading = true;
  /** Why the last load failed; the table would otherwise read as empty. */
  loadError = '';
  bulk = new BulkController<string | number>(() => this.loadPage(this.currentPage));

  get pageIds(): (string | number)[] {
    return (this.advertisersData?.results ?? []).map((a) => a.id);
  }
  schoolSearchQuery = '';
  q = '';
  
  showModal = false;
  editingId: number | null = null;
  formData: Partial<AdminAdvertiser> = {
    company_name: '',
    contact_email: '',
    contact_phone: '',
    is_active: true,
    all_schools: true,
    schools: []
  };

  constructor() {}

  get filteredSchools() {
    if (!this.schoolSearchQuery) return this.schools;
    const q = this.schoolSearchQuery.trim().toLowerCase();
    return this.schools.filter(s => keywordsMatch(schoolKeywords(s), q));
  }

  ngOnInit() {
    this.loadPage(1);
    this.metadataService.getMetadata().subscribe({
      next: (meta: any) => { this.schools = meta?.schools || []; this.cdr.markForCheck(); },
      error: (err) => {}
    });
  }

  onSearch(q: string) {
    this.q = q;
    this.loadPage(1);
  }

  loadPage(page: number) {
    this.bulk.reset();
    this.currentPage = page;
    this.loading = true;
    this.loadError = '';
    this.cdr.markForCheck();
    this.adminService.getAdvertisers({ page, q: this.q }).subscribe({
      next: (data) => {
        this.advertisersData = data;
        this.total = data.count;
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

  openCreateModal() {
    this.editingId = null;
    this.formData = {
      company_name: '',
      contact_email: '',
      contact_phone: '',
      is_active: true,
      all_schools: true,
      schools: []
    };
    this.schoolSearchQuery = '';
    this.showModal = true;
  }

  openEditModal(adv: AdminAdvertiser) {
    this.editingId = adv.id;
    this.formData = { ...adv, schools: adv.schools ? [...adv.schools] : [] };
    this.schoolSearchQuery = '';
    this.showModal = true;
  }

  toggleSchool(schoolId: number) {
    if (!this.formData.schools) this.formData.schools = [];
    const idx = this.formData.schools.indexOf(schoolId);
    if (idx > -1) {
      this.formData.schools.splice(idx, 1);
    } else {
      this.formData.schools.push(schoolId);
    }
  }

  closeModal() {
    this.showModal = false;
  }

  save() {
    if (!this.formData.company_name || !this.formData.contact_email) {
      this.toast.error(this.i18n.t('admin.errFillRequired'));
      return;
    }

    const payload = { ...this.formData };
    if (payload.schools) {
      payload.schools = payload.schools.map(id => Number(id));
    }

    const obs = this.editingId
      ? this.adminService.updateAdvertiser(this.editingId, payload)
      : this.adminService.createAdvertiser(payload);

    obs.subscribe({
      next: () => {
        this.closeModal();
        this.loadPage(this.currentPage);
      },
      error: (err) => this.toast.error(parseAdminError(err, this.i18n, 'admin.errSaveFailed'))
    });
  }

  bulkActive(active: boolean) {
    const n = this.bulk.selection.size;
    this.bulk.run((id) => this.adminService.updateAdvertiser(id, { is_active: active }), {
      confirm: this.i18n.t(active ? 'admin.bulk.confirmEnable' : 'admin.bulk.confirmDisable', { n }),
      confirmLabel: this.i18n.t(active ? 'admin.bulk.enable' : 'admin.bulk.disable'),
    });
  }

  bulkDelete() {
    this.bulk.run((id) => this.adminService.deleteAdvertiser(id), {
      confirm: this.i18n.t('admin.bulk.confirmDelete', { n: this.bulk.selection.size }),
      danger: true,
      confirmLabel: this.i18n.t('common.delete'),
    });
  }

  async deleteAdvertiser(id: string | number) {
    const confirmed = await this.confirms.askDanger(this.i18n.t('admin.confirmDeleteAdvertiser'), {
      confirmLabel: this.i18n.t('common.delete'),
    });
    if (confirmed) {
      this.adminService.deleteAdvertiser(id).subscribe({
        next: () => {
          this.loadPage(this.currentPage);
        },
        error: (err) => {
        this.toast.error(parseAdminError(err, this.i18n, 'admin.errDeleteFailed'));
        }
      });
    }
  }
}
