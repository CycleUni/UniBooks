
import { onLanguageChange } from '../../core/on-language-change';
import { parseAdminError } from '../../core/admin-error.util';
import { forkJoin, Observable } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, OnInit, inject, ChangeDetectorRef, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminUser } from '../../core/services/admin.service';
import { MetadataService } from '../../core/services/metadata.service';
import { AuthStore } from '../../core/auth.store';
import { RegionService } from '../../core/region.service';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { UiButton } from '../../shared/ui/button.component';
import { UiCheckbox } from '../../shared/ui/checkbox.component';
import { DropdownOption, UiDropdown } from '../../shared/ui/dropdown.component';
import { schoolKeywords } from '../../core/school-search';

@Component({
  selector: 'app-admin-user-detail',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, FormsModule, TPipe, UiSkeleton, UiErrorState, UiButton, UiDropdown, UiCheckbox],
  template: `
    <a [regionLink]="['/admin', 'users']" class="back-link">&larr; {{ 'admin.backToList' | t }}</a>

    <ui-skeleton *ngIf="loading" variant="form" [count]="4"></ui-skeleton>
    <!-- The form's own error line is inside the card, which needs a user. -->
    <ui-error-state *ngIf="!loading && loadError" [message]="loadError" (retry)="load()"></ui-error-state>

    <div class="detail-card" *ngIf="!loading && user">
      <h2>{{ user.display_name || user.email }}</h2>

      <div class="field-grid">
        <div class="field"><label>{{ 'admin.colEmail' | t }}</label><span>{{ user.email }}</span></div>
        <div class="field"><label>{{ 'admin.colName' | t }}</label><span>{{ user.first_name }} {{ user.last_name }}</span></div>
        <div class="field"><label>{{ 'admin.staffBadge' | t }}</label><span class="admin-status-badge" [class.ok]="user.is_staff">{{ (user.is_staff ? 'admin.yes' : 'admin.no') | t }}</span></div>
      </div>

      <div class="toggle-row">
        <ui-checkbox [(ngModel)]="isActive" [label]="'admin.colActive' | t"></ui-checkbox>
      </div>

      <div class="field-grid mt-4"  style="grid-template-columns: 1fr;">
        <label>{{ 'admin.colVerified' | t }}</label>
        <div *ngIf="user.verifications?.length; else noVerifications">
          <div *ngFor="let v of user.verifications"  class="mb-2" style="padding: 8px; border: 1px solid var(--line); border-radius: 4px;">
            <div  class="mb-2">
              <span  style="font-weight: bold;">{{ v.region }}</span>: {{ v.edu_email || '-' }}
              <span  style="color: var(--muted); font-size: var(--text-xs); margin-left: 8px;" *ngIf="v.verified_at">({{ v.verified_at | date:'yyyy/MM/dd HH:mm' }})</span>
            </div>
            <div  class="mb-2">
              <ui-checkbox [(ngModel)]="verificationStates[v.region].verified" [label]="'admin.colVerified' | t"></ui-checkbox>
            </div>
            <ui-dropdown [label]="'admin.colSchool' | t" [options]="getSchoolOptionsForRegion(v.region)" [(ngModel)]="verificationStates[v.region].school"></ui-dropdown>
          </div>
        </div>
        <ng-template #noVerifications>
          <span class="muted">{{ 'admin.no' | t }}</span>
        </ng-template>

        <div *ngIf="newRegionOptions.length > 1" style="margin-top: 16px; padding-top: 16px; border-top: 1px dashed var(--line);">
          <div  class="mb-2" style="font-weight: bold;">{{ 'admin.addVerificationRegion' | t }}</div>
          <div  style="display: flex; gap: 8px; align-items: flex-end;">
            <div  class="flex-1">
              <ui-dropdown [label]="'admin.colRegion' | t" [options]="newRegionOptions" [(ngModel)]="newRegion" (ngModelChange)="onNewRegionChange()"></ui-dropdown>
            </div>
            <div  style="flex: 2;" *ngIf="newRegion">
              <ui-dropdown [label]="'admin.colSchool' | t" [options]="getSchoolOptionsForRegion(newRegion)" [(ngModel)]="newRegionSchool"></ui-dropdown>
            </div>
            <ui-button *ngIf="newRegion" [disabled]="!newRegionSchool" (onClick)="addNewRegion()">{{ 'common.create' | t }}</ui-button>
          </div>
        </div>
      </div>

      <div *ngIf="errorMsg" class="inline-msg error">{{ errorMsg }}</div>
      <div *ngIf="savedMsg" class="inline-msg ok">{{ savedMsg }}</div>

      <ui-button (onClick)="save()" [disabled]="saving">{{ (saving ? 'admin.saving' : 'admin.save') | t }}</ui-button>
    </div>
  `,
  styles: [`
    .admin-status-badge { width: fit-content; }

    .detail-card {
      background: var(--surface-card);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 24px;
      max-width: 520px;
      box-shadow: var(--shadow-card-lg);
    }
    .detail-card h2 { margin-top: 0; }
    .field-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 16px;
    }
    .field { display: flex; flex-direction: column; gap: 2px; }
    .field label { font-size: var(--text-xs); color: var(--muted); }
    .field span { font-size: var(--text-base); color: var(--ink); }
    .toggle-row {
      display: flex;
      gap: 24px;
      margin: 16px 0;
    }
    .toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: var(--text-base);
      cursor: pointer;
    }
  `]
})
export class AdminUserDetailComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private adminService = inject(AdminService);
  private metadataService = inject(MetadataService);
  private i18n = inject(I18nService);
  private cdr = inject(ChangeDetectorRef);
  private authStore = inject(AuthStore);
  private regionService = inject(RegionService);

  user: AdminUser | null = null;
  loading = true;
  /** Why the last load failed. */
  loadError = '';
  saving = false;
  errorMsg = '';
  savedMsg = '';

  isActive = false;
  schoolsByRegion: Record<string, DropdownOption[]> = {};
  verificationStates: Record<string, { school: string | number | ''; verified: boolean }> = {};

  newRegion = '';
  newRegionSchool: string | number | '' = '';

  get availableRegions() {
    const user = this.authStore.user() as any;
    const allRegions = this.regionService.regions();
    if (user?.is_superuser) return allRegions;
    if (Array.isArray(user?.managed_regions)) {
      return allRegions.filter((r: any) => user.managed_regions.includes(r.code));
    }
    return allRegions;
  }

  get newRegionOptions() {
    const existingRegions = this.user?.verifications?.map(v => v.region) || [];
    return [
      { value: '', label: '---' },
      ...this.availableRegions
        .filter((r: any) => !existingRegions.includes(r.code))
        .map((r: any) => ({ value: r.code, label: r.localized_name }))
    ];
  }

  onNewRegionChange() {
    this.newRegionSchool = '';
    if (this.newRegion) {
      this.loadSchoolsForRegion(this.newRegion);
    }
  }

  addNewRegion() {
    if (!this.newRegion || !this.newRegionSchool || !this.user) return;
    this.saving = true;
    this.errorMsg = '';
    this.savedMsg = '';

    this.adminService.updateUser(this.user.id, {
      region: this.newRegion,
      school: this.newRegionSchool,
      verified: true
    }).pipe(
      // eslint-disable-next-line rxjs/no-nested-subscribe
      switchMap(() => this.adminService.getUser(this.user!.id))
    ).subscribe({
      next: (updatedUser) => {
        this.user = updatedUser;
        this.isActive = updatedUser.is_active;
        if (this.user?.verifications) {
           this.user.verifications.forEach(v => {
             this.verificationStates[v.region] = { 
               school: v.school != null ? String(v.school) : '',
               verified: !!v.verified_at
             };
             this.loadSchoolsForRegion(v.region);
           });
        }
        this.newRegion = '';
        this.newRegionSchool = '';
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

  constructor() {
    onLanguageChange(this.i18n, () => {
      if (this.user?.verifications) {
        this.user.verifications.forEach(v => {
          this.loadSchoolsForRegion(v.region, true);
        });
      }
    });
  }

  ngOnInit() {
    this.load();
  }

  load() {
    const id = this.route.snapshot.paramMap.get('id')!;
    this.loading = true;
    this.loadError = '';
    this.adminService.getUser(id).subscribe({
      next: (user) => {
        this.user = user;
        this.isActive = user.is_active;
        if (user.verifications) {
          user.verifications.forEach(v => {
            this.verificationStates[v.region] = { 
              school: v.school != null ? String(v.school) : '',
              verified: !!v.verified_at
            };
            this.loadSchoolsForRegion(v.region);
          });
        }
        
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

  loadSchoolsForRegion(region: string, force = false) {
    if (!force && this.schoolsByRegion[region]) return;
    this.fetchSchoolPage(region, 1, []);
  }

  private fetchSchoolPage(
    region: string,
    page: number,
    accumulated: DropdownOption[],
  ) {
    this.adminService.getSchools({ region, page, page_size: 100 }).subscribe({
      next: (res) => {
        const merged = [
          ...accumulated,
          ...res.results.map(s => ({ value: String(s.id), label: s.display_name, keywords: schoolKeywords(s) })),
        ];

        if (res.next && res.results.length > 0) {
          this.fetchSchoolPage(region, page + 1, merged);
          return;
        }

        this.schoolsByRegion[region] = [
          { value: '', label: this.i18n.t('admin.noSchool') },
          ...merged,
        ];
        this.cdr.markForCheck();
      },
      // Deliberately swallows the error and leaves `schoolsByRegion[region]`
      // unset. `undefined` and `[]` are not interchangeable here: the getter
      // below falls back to the "no school" option only when the key is
      // absent, and the save guard skips the school-update branch entirely
      // when `options` is falsy. An empty array instead renders a blank
      // dropdown that reads as "cleared" — that is how a user's school was
      // once wiped to null on save.
      error: () => {},
    });
  }

  getSchoolOptionsForRegion(region: string) {
    return this.schoolsByRegion[region] || [{ value: '', label: this.i18n.t('admin.noSchool') }];
  }

  save() {
    const user = this.user;
    if (!user) return;
    this.saving = true;
    this.errorMsg = '';
    this.savedMsg = '';

    const reqs: Observable<any>[] = [];
    
    reqs.push(this.adminService.updateUser(user.id, { is_active: this.isActive }));

    if (user.verifications) {
      user.verifications.forEach(v => {
        const newState = this.verificationStates[v.region];
        if (!newState) return;
        
        let shouldUpdateSchool = false;
        if (String(newState.school) !== String(v.school || '')) {
            const options = this.schoolsByRegion[v.region];
            if (options) {
                if (newState.school === '') {
                    if (v.school != null && !options.some(opt => opt.value === String(v.school))) {
                         shouldUpdateSchool = false;
                    } else {
                         shouldUpdateSchool = true;
                    }
                } else if (options.some(opt => opt.value === String(newState.school))) {
                    shouldUpdateSchool = true;
                }
            }
        }
        
        const shouldUpdateVerified = newState.verified !== !!v.verified_at;
        
        if (shouldUpdateSchool || shouldUpdateVerified) {
          const payload: any = { region: v.region };
          if (shouldUpdateSchool) {
             payload.school = newState.school === '' ? null : newState.school;
          }
          if (shouldUpdateVerified) {
             payload.verified = newState.verified;
          }
          reqs.push(this.adminService.updateUser(user.id, payload));
        }
      });
    }

    forkJoin(reqs).pipe(
      switchMap(() => this.adminService.getUser(user.id))
    ).subscribe({
      next: (updatedUser) => {
        this.user = updatedUser;
        this.isActive = updatedUser.is_active;
        if (this.user?.verifications) {
           this.user.verifications.forEach(v => {
             this.verificationStates[v.region] = { 
                 school: v.school != null ? String(v.school) : '',
                 verified: !!v.verified_at
             };
           });
        }
        
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
}
