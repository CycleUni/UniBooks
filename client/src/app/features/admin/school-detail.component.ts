import { UiButton } from '../../shared/ui/button.component';
import { RegionLinkDirective } from '../../core/region-link.directive';
import { RegionService } from '../../core/region.service';
import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AdminService, AdminSchool, Paginated } from '../../core/services/admin.service';
import { TPipe, I18nService } from '../../core/i18n.service';
import { UiSkeleton } from '../../shared/ui/skeleton.component';
import { UiErrorState } from '../../shared/ui/error-state.component';
import { ToastService } from '../../core/services/toast.service';
import { parseAdminError } from '../../core/admin-error.util';
import { TranslationEditorComponent, TranslationField } from './translation-editor.component';
import { UiDropdown, DropdownOption } from '../../shared/ui/dropdown.component';
import { MetadataService } from '../../core/services/metadata.service';
import { CityOption } from '../../core/services/school-state.service';

@Component({
  selector: 'app-admin-school-detail',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, FormsModule, TPipe, UiErrorState, UiSkeleton, TranslationEditorComponent, UiButton, UiDropdown],
  template: `
    <div class="section-head-row">
      <div>
        <h2>{{ 'common.edit' | t }}: {{ school?.name }} <code *ngIf="school?.code">{{ school?.code }}</code></h2>
        <ui-button size="sm" variant="outline" [regionLink]="['/admin', 'schools']">‹ {{ 'admin.backToList' | t }}</ui-button>
      </div>
    </div>

    <ui-skeleton *ngIf="!school && !loadError" variant="form" [count]="4"></ui-skeleton>
    <ui-error-state *ngIf="!school && loadError" [message]="loadError" (retry)="loadSchool()"></ui-error-state>

    <div class="detail-grid" *ngIf="school">
      <div class="panel">
        <h3>{{ 'admin.schoolName' | t }}</h3>
        
        <div class="form-group">
          <label>{{ 'admin.schoolName' | t }}</label>
          <input type="text" class="admin-form-control" [(ngModel)]="editData.name">
        </div>
        
        <div class="form-group">
          <label>{{ 'admin.colDomain' | t }}</label>
          <input type="text" class="admin-form-control" [(ngModel)]="editData.email_domain">
        </div>

        <div class="form-group">
          <label for="school-code">{{ 'admin.schoolCode' | t }}</label>
          <input id="school-code" type="text" class="admin-form-control code-input" maxlength="20" [(ngModel)]="editData.code">
          <small class="hint">{{ 'admin.schoolCodeDesc' | t }}</small>
        </div>

        <div class="form-group">
          <ui-dropdown
            [label]="'admin.schoolCity' | t"
            [options]="cityOptions"
            [(ngModel)]="editCity"
          ></ui-dropdown>
        </div>

        <div class="form-group">
          <label>{{ 'admin.translationsSection' | t }}</label>
          <app-translation-editor 
            [fields]="translationFields"
            [translations]="editData.translations"
            [languages]="regionService.translationLanguagesFor(school.region || regionService.region())"
            (translationsChange)="editData.translations = $event">
          </app-translation-editor>
        </div>

        <ui-button variant="primary" (onClick)="saveSchool()">{{ 'admin.save' | t }}</ui-button>
      </div>
    </div>
  `,
  styles: [`
    .section-head-row h2 { margin-bottom: 8px; }
    .section-head-row a { text-decoration: none; }
    .detail-grid { max-width: 600px; }
    .panel { background: var(--surface-card); padding: 24px; border-radius: 8px; border: 1px solid var(--line); box-shadow: var(--shadow-card-lg); }
    .panel h3 { margin-top: 0; margin-bottom: 24px; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; margin-bottom: 8px; font-weight: 600; }
    .code-input { text-transform: uppercase; }
    .hint { display: block; margin-top: 4px; color: var(--muted); font-size: var(--text-xs); }
  `]
})
export class AdminSchoolDetailComponent implements OnInit {
  private adminService = inject(AdminService);
  readonly regionService = inject(RegionService);
  private route = inject(ActivatedRoute);
  private cdr = inject(ChangeDetectorRef);
  private i18n = inject(I18nService);
  private toast = inject(ToastService);
  private metadataService = inject(MetadataService);

  schoolId!: string;
  school?: AdminSchool;
  editData: Partial<AdminSchool> = { name: '', email_domain: '', code: '' };
  
  /** City code being edited; '' clears the school's city. */
  editCity = '';
  cityOptions: DropdownOption[] = [];

  translationFields: TranslationField[] = [
    { key: 'name', placeholder: 'admin.schoolName', type: 'text' }
  ];

  ngOnInit() {
    // This region's cities, as the public school picker lists them.
    this.metadataService.getMetadata().subscribe({
      next: data => {
        this.cityOptions = [
          { value: '', label: this.i18n.t('admin.schoolCityNone') },
          ...(data.cities || []).map((c: CityOption) => ({ value: c.code, label: c.display_name || c.name })),
        ];
        this.cdr.markForCheck();
      },
      error: () => {},
    });
    this.route.paramMap.subscribe(params => {
      this.schoolId = params.get('id')!;
      this.loadSchool();
    });
  }

  /** Why the last load failed; the page had no error branch at all. */
  loadError = '';

  loadSchool() {
    this.loadError = '';
    this.adminService.getSchool(this.schoolId).subscribe({
      next: data => {
        this.school = data;
        this.editData = { name: data.name, email_domain: data.email_domain, code: data.code, translations: data.translations || {} };
        this.editCity = data.city || '';
        this.cdr.markForCheck();
      },
      error: err => {
        this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
        this.cdr.markForCheck();
      },
    });
  }

  saveSchool() {
    const payload = { ...this.editData, code: (this.editData.code || '').trim().toUpperCase(), city: this.editCity || null };
    this.adminService.updateSchool(this.schoolId, payload).subscribe({
      next: data => {
        this.school = data;
        this.editData = { name: data.name, email_domain: data.email_domain, code: data.code, translations: data.translations || {} };
        this.editCity = data.city || '';
        this.cdr.markForCheck();
      },
      // Silently doing nothing left the old code on the page looking saved;
      // a code already used in this region is the likely reason, and says so.
      error: err => {
        this.toast.error(parseAdminError(err, this.i18n));
        this.cdr.markForCheck();
      }
    });
  }
}
