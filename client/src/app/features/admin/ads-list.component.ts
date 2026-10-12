import { UiButton } from '../../shared/ui/button.component';

import { parseAdminError } from '../../core/admin-error.util';
import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiPagination } from '../../shared/ui/pagination.component';
import { UiCheckbox } from '../../shared/ui/checkbox.component';
import { UiDropdown } from '../../shared/ui/dropdown.component';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminAd, AdminAdvertiser, Paginated } from '../../core/services/admin.service';
import { ListingService } from '../../core/services/listing.service';
import { TPipe, I18nService } from '../../core/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { UiSearchBarComponent } from '../../shared/ui/search-bar.component';
import { firstValueFrom } from 'rxjs';
import { AuthStore } from '../../core/auth.store';
import { RegionService } from '../../core/region.service';
import { AdminBulkBarComponent } from './bulk-bar.component';
import { AdminPickCellComponent } from './pick-cell.component';
import { BulkController } from './bulk';

@Component({
  selector: 'app-admin-ads-list',
  standalone: true,
  imports: [CommonModule, UiSkeleton, UiErrorState, RouterModule, FormsModule, TPipe, UiSearchBarComponent, UiPagination, UiCheckbox, UiDropdown, UiButton, AdminBulkBarComponent, AdminPickCellComponent],
  template: `
    <div class="section-head-row">
      <h2>{{ 'admin.navAds' | t }}</h2>
      <div class="section-head-actions">
        <ui-button variant="primary" (onClick)="openCreateModal()">{{ 'admin.addAd' | t }}</ui-button>
      </div>
    </div>

    <div class="admin-filters">
      <ui-search-bar [placeholder]="'admin.searchAds' | t" [value]="q" (search)="onSearch($event)"></ui-search-bar>
    </div>

    <ui-error-state *ngIf="!loading && loadError" [message]="loadError" (retry)="loadPage(currentPage)"></ui-error-state>
    <admin-bulk-bar *ngIf="!loading && !loadError && adsData?.results?.length" [count]="bulk.selection.size" [busy]="bulk.busy" (clear)="bulk.selection.clear()">
      <ui-button size="sm" variant="outline" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkActive(true)">{{ 'admin.bulk.enable' | t }}</ui-button>
      <ui-button size="sm" variant="outline" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkActive(false)">{{ 'admin.bulk.disable' | t }}</ui-button>
      <ui-button size="sm" variant="danger" [disabled]="bulk.busy || !bulk.selection.size" (onClick)="bulkDelete()">{{ 'common.delete' | t }}</ui-button>
    </admin-bulk-bar>

    <div class="table-container" *ngIf="!loading && !loadError && adsData">
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
            <th>{{ 'admin.colRegion' | t }}</th>
            <th>{{ 'admin.adTitle' | t }}</th>
            <th>{{ 'admin.adAdvertiser' | t }}</th>
            <th>{{ 'admin.adPosition' | t }}</th>
            <th>{{ 'admin.adClicksViews' | t }}</th>
            <th>{{ 'admin.adStatus' | t }}</th>
            <th>{{ 'admin.adPeriod' | t }}</th>
            <th>{{ 'admin.colActions' | t }}</th>
          </tr>
        </thead>
        <tbody>
          <tr *ngFor="let ad of adsData.results" [class.picked]="bulk.selection.has(ad.id)">
            <td adminPick
              [checked]="bulk.selection.has(ad.id)"
              [disabled]="bulk.busy"
              [label]="'admin.bulk.selectRow' | t: { name: ad.title }"
              (toggle)="bulk.selection.toggle(ad.id)"></td>
            <td>{{ ad.id }}</td>
            <td>{{ ad.all_regions ? ('admin.allRegions' | t) : formatRegions(ad.regions) }}</td>
            <td>
              {{ ad.title }}
              <a *ngIf="ad.target_url" [href]="ad.target_url" target="_blank" title="跳轉連結">🔗</a>
            </td>
            <td>{{ ad.advertiser_name }}</td>
            <td>{{ ad.position }}</td>
            <td>{{ ad.clicks_count }} / {{ ad.views_count }}</td>
            <td>
              <span class="admin-badge" [class.admin-badge-success]="ad.is_active" [class.admin-badge-error]="!ad.is_active">
                {{ ad.is_active ? ('admin.advertiserActive' | t) : ('admin.advertiserInactive' | t) }}
              </span>
            </td>
            <td  style="font-size: 0.85em; color: var(--muted);">
              {{ ad.start_date | date:'yyyy/MM/dd HH:mm' }} -<br>
              {{ ad.end_date | date:'yyyy/MM/dd HH:mm' }}
            </td>
            <td>
              <ui-button size="sm" variant="outline" (onClick)="openEditModal(ad)">{{ 'common.edit' | t }}</ui-button>
              <ui-button size="sm" variant="outline" (onClick)="deleteAd(ad.id)"  style="margin-left: 4px; color: var(--danger); border-color: var(--danger);">{{ 'common.delete' | t }}</ui-button>
            </td>
          </tr>
        </tbody>
      </table>

      <ui-pagination [total]="total" [pageSize]="pageSize" [currentPage]="currentPage" (pageChange)="loadPage($event)"></ui-pagination>
    </div>

    <ui-skeleton *ngIf="loading" variant="table" [count]="5"></ui-skeleton>

    <div class="app-modal-overlay" *ngIf="showModal">
      <div class="app-modal">
        <h3 class="app-modal-title">{{ editingId ? ('admin.editAd' | t) : ('admin.addAd' | t) }}</h3>
        
        <div class="app-modal-body">
          <div class="form-group">
            <label>{{ 'admin.adAdvertiser' | t }} *</label>
            <ui-dropdown [(ngModel)]="formData.advertiser" [disabled]="!!editingId" [options]="advertiserOptions"></ui-dropdown>
          </div>

          <div class="form-group">
            <label>{{ 'admin.adTitle' | t }} *</label>
            <input type="text" class="admin-form-control" [(ngModel)]="formData.title">
          </div>
          
          <div class="form-group">
            <label>{{ 'admin.adImage' | t }} *</label>
            <div  class="mb-2" style="display: flex; gap: 8px; align-items: center;" *ngIf="formData.image_url">
              <img [src]="formData.image_url"  style="height: 60px; object-fit: contain; border: 1px solid var(--line); border-radius: 4px;">
            </div>
            <div  style="display: flex; gap: 8px;">
              <input *ngIf="!formData.is_internal_image" type="text" class="admin-form-control flex-1" [(ngModel)]="formData.image_url" placeholder="https://..." >
              <div *ngIf="formData.is_internal_image"  class="flex-1" style="display: flex; align-items: center; font-size: var(--text-base); color: var(--success); background: var(--paper-warm); padding: 0 12px; border-radius: 4px; border: 1px solid var(--line);">{{ 'admin.uploadedViaFile' | t }}</div>
              <input type="file" accept="image/*"  style="display: none;" #fileInput (change)="onImageUpload($event)">
              <ui-button variant="outline" (onClick)="fileInput.click()" [disabled]="uploadingImage" [title]="'admin.uploadNewImageHint' | t">
                {{ uploadingImage ? ('admin.uploading' | t) : (formData.is_internal_image ? ('admin.reselectFile' | t) : ('admin.selectFile' | t)) }}
              </ui-button>
              <ui-button variant="outline" *ngIf="formData.is_internal_image" (onClick)="useExternalUrl()" [title]="'admin.useExternalUrlHint' | t">
                {{ 'admin.useExternalUrl' | t }}
              </ui-button>
            </div>
          </div>
          
          <p  style="font-size: var(--text-xs); color: var(--muted); margin-top: 4px; margin-bottom: 12px;">{{ 'admin.adImageSpec' | t }}</p>

          <div class="form-group">
            <label>{{ 'admin.adTargetUrl' | t }} *</label>
            <input type="text" class="admin-form-control" [(ngModel)]="formData.target_url" placeholder="https://...">
          </div>
          
          <div class="form-group">
            <label>{{ 'admin.adHeadline' | t }}</label>
            <input type="text" class="admin-form-control" [(ngModel)]="formData.headline">
          </div>
          <div class="form-group">
            <label>{{ 'admin.adSubheadline' | t }}</label>
            <input type="text" class="admin-form-control" [(ngModel)]="formData.subheadline">
          </div>
          <div class="form-group">
            <label>{{ 'admin.adSlotIndex' | t }} *</label>
            <input type="number" min="1" max="200" class="admin-form-control" [(ngModel)]="formData.slot_index">
          </div>

          <div class="form-group">
            <label>{{ 'admin.adStartDate' | t }} *</label>
            <input type="datetime-local" class="admin-form-control" [(ngModel)]="formData.start_date">
          </div>
          
          <div class="form-group">
            <label>{{ 'admin.adEndDate' | t }} *</label>
            <input type="datetime-local" class="admin-form-control" [(ngModel)]="formData.end_date">
          </div>
          
          <div class="form-group">
            <label>{{ 'admin.adLabels' | t }}</label>
            <input type="text" class="admin-form-control" [(ngModel)]="labelsInput" placeholder="New, Sale">
          </div>
          
          <div class="form-group">
            <ui-checkbox [(ngModel)]="formData.is_active" [label]="'admin.advertiserActive' | t"></ui-checkbox>
          </div>

          <div class="form-group">
            <ui-checkbox [(ngModel)]="formData.show_in_hero" [label]="'admin.adShowInHero' | t"></ui-checkbox>
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
export class AdminAdsListComponent implements OnInit {
  private adminService = inject(AdminService);
  private listingService = inject(ListingService);
  private cdr = inject(ChangeDetectorRef);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private confirms = inject(ConfirmService);
  private authStore = inject(AuthStore);
  private regionService = inject(RegionService);
  
  adsData: Paginated<AdminAd> | null = null;
  currentPage = 1;
  total = 0;
  pageSize = 20;
  loading = true;
  /** Why the last load failed; the table would otherwise read as empty. */
  loadError = '';
  bulk = new BulkController<string | number>(() => this.loadPage(this.currentPage));

  get pageIds(): (string | number)[] {
    return (this.adsData?.results ?? []).map((a) => a.id);
  }
  saving = false;
  advertisers: AdminAdvertiser[] = [];
  uploadingImage = false;
  
  showModal = false;
  editingId: number | null = null;
  q = '';
  formData: Partial<AdminAd> = {
    title: '',
    image_url: '',
    target_url: '',
    position: 'home_banner',
    headline: '',
    subheadline: '',
    slot_index: 1,
    is_active: true,
    show_in_hero: false
  };
  labelsInput = '';

  get advertiserOptions() {
    return this.advertisers.map(a => ({ value: a.id.toString(), label: a.company_name }));
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

  ngOnInit() {
    this.loadPage(1);
    this.loadAdvertisers();
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
    this.adminService.getAds({ page, q: this.q, region: this.regionService.region().toUpperCase() }).subscribe({
      next: (data) => {
        this.adsData = data;
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

  loadAdvertisers() {
    this.adminService.getAdvertisers({ page: 1, page_size: 100 }).subscribe(data => {
      this.advertisers = data.results;
      this.cdr.markForCheck();
    });
  }

  formatDateForInput(dateStr: string): string {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const tzOffset = date.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
    return localISOTime;
  }

  openCreateModal() {
    this.editingId = null;
    this.labelsInput = '';
    this.formData = {
      title: '',
      image_url: '',
      target_url: '',
      position: 'home_banner',
      headline: '',
      subheadline: '',
      slot_index: 1,
      is_active: true,
      show_in_hero: false,
      start_date: this.formatDateForInput(new Date().toISOString()),
      end_date: this.formatDateForInput(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString())
    };
    if (this.advertisers.length > 0) {
      this.formData.advertiser = this.advertisers[0].id;
    }
    this.showModal = true;
  }

  openEditModal(ad: AdminAd) {
    this.editingId = ad.id;
    this.formData = { ...ad, show_in_hero: !!ad.show_in_hero };
    this.labelsInput = ad.labels ? ad.labels.join(', ') : '';
    if (this.formData.start_date) {
      this.formData.start_date = this.formatDateForInput(this.formData.start_date);
    }
    if (this.formData.end_date) {
      this.formData.end_date = this.formatDateForInput(this.formData.end_date);
    }
    this.showModal = true;
  }

  async onImageUpload(event: any) {
    const file = event.target.files[0];
    if (!file) return;
    
    this.uploadingImage = true;
    try {
      const res = await firstValueFrom(this.adminService.uploadAdPhoto(file));
      this.formData.image_url = res.url;
      this.formData.is_internal_image = true;
    } catch (e) {
      this.toast.error(this.i18n.t('admin.errUploadFailed'));
    } finally {
      this.uploadingImage = false;
      event.target.value = '';
    }
  }

  useExternalUrl() {
    this.formData.is_internal_image = false;
    this.formData.image_url = '';
  }

  closeModal() {
    this.showModal = false;
  }

  save() {
    if (!this.formData.advertiser || !this.formData.title || !this.formData.image_url || !this.formData.start_date || !this.formData.end_date || !this.formData.slot_index) {
      this.toast.error(this.i18n.t('admin.errFillRequired'));
      return;
    }

    if (this.formData.target_url && !this.formData.target_url.startsWith('http://') && !this.formData.target_url.startsWith('https://')) {
      this.toast.error(this.i18n.t('admin.errUrlScheme'));
      return;
    }

    const payload = { ...this.formData };
    
    const parsedLabels = this.labelsInput.split(',').map(s => s.trim()).filter(s => s);
    if (parsedLabels.length > 3) {
      this.toast.error(this.i18n.t('admin.errTooManyLabels', { max: 3 }));
      return;
    }
    for (let l of parsedLabels) {
      if (l.length > 15) {
        this.toast.error(this.i18n.t('admin.errLabelTooLong', { max: 15 }));
        return;
      }
    }
    payload.labels = parsedLabels;

    if (payload.start_date) payload.start_date = new Date(payload.start_date).toISOString();
    if (payload.end_date) payload.end_date = new Date(payload.end_date).toISOString();

    if (new Date(payload.start_date!).getTime() >= new Date(payload.end_date!).getTime()) {
      this.toast.error(this.i18n.t('admin.errEndDateBeforeStart'));
      return;
    }

    const obs = this.editingId
      ? this.adminService.updateAd(this.editingId, payload)
      : this.adminService.createAd(payload);

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
    this.bulk.run((id) => this.adminService.updateAd(id, { is_active: active }), {
      confirm: this.i18n.t(active ? 'admin.bulk.confirmEnable' : 'admin.bulk.confirmDisable', { n }),
      confirmLabel: this.i18n.t(active ? 'admin.bulk.enable' : 'admin.bulk.disable'),
    });
  }

  bulkDelete() {
    this.bulk.run((id) => this.adminService.deleteAd(id), {
      confirm: this.i18n.t('admin.bulk.confirmDelete', { n: this.bulk.selection.size }),
      danger: true,
      confirmLabel: this.i18n.t('common.delete'),
    });
  }

  async deleteAd(id: string | number) {
    const confirmed = await this.confirms.askDanger(this.i18n.t('admin.confirmDelete'), {
      confirmLabel: this.i18n.t('common.delete'),
    });
    if (confirmed) {
      this.adminService.deleteAd(id).subscribe({
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
