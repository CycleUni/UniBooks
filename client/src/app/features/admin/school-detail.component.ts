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

    <ui-skeleton *ngIf="!school && !loadError" variant="spinner"></ui-skeleton>
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
          <input type="text" class="admin-form-control" [(ngModel)]="editData.email_domain" (ngModelChange)="updateAcceptedDomains()">
        </div>

        <div class="form-group">
          <label>{{ 'admin.schoolEmailDomains' | t }}</label>
          <textarea
            class="admin-form-control"
            rows="3"
            [(ngModel)]="emailDomainsText"
            (ngModelChange)="onEmailDomainsChange($event)"
            [placeholder]="'admin.schoolEmailDomainsDesc' | t"
          ></textarea>
          <small class="hint">{{ 'admin.schoolEmailDomainsDesc' | t }}</small>
        </div>

        <div class="form-group">
          <label>{{ 'admin.studentEmailDomain' | t }}</label>
          <select class="admin-form-control" [(ngModel)]="editData.student_email_domain">
            <option value="">{{ 'admin.studentEmailDomainDefault' | t }} ({{ editData.email_domain }})</option>
            <option *ngFor="let d of acceptedDomainOptions" [value]="d">{{ d }}</option>
          </select>
          <small class="hint">{{ 'admin.studentEmailDomainDesc' | t }}</small>
        </div>

        <div class="form-group" *ngIf="acceptedDomainOptions.length > 0">
          <label>{{ 'admin.googleDomains' | t }}</label>
          <div class="domain-checkboxes">
            <label *ngFor="let d of acceptedDomainOptions" class="checkbox-label">
              <input type="checkbox" [checked]="isGoogleDomain(d)" (change)="toggleGoogleDomain(d, $event)">
              <span>{{ d }} ({{ 'admin.googleDomainLabel' | t }})</span>
            </label>
          </div>
          <small class="hint">{{ 'admin.googleDomainsDesc' | t }}</small>
        </div>

        <div class="form-group">
          <label for="school-code">{{ 'admin.schoolCode' | t }}</label>
          <input id="school-code" type="text" class="admin-form-control code-input" maxlength="20" [(ngModel)]="editData.code">
          <small class="hint">{{ 'admin.schoolCodeDesc' | t }}</small>
        </div>

        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" [(ngModel)]="editData.requires_verification">
            <span>{{ 'admin.requiresVerification' | t }}</span>
          </label>
          <small class="hint">{{ 'admin.requiresVerificationDesc' | t }}</small>
        </div>

        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" [(ngModel)]="editData.allows_student_id_verification">
            <span>{{ 'admin.allowsStudentIdVerification' | t }}</span>
          </label>
          <small class="hint">{{ 'admin.allowsStudentIdVerificationDesc' | t }}</small>
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

        <ui-button variant="primary" [disabled]="saving" (onClick)="saveSchool()">{{ (saving ? 'admin.saving' : 'admin.save') | t }}</ui-button>
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
    .domain-checkboxes { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
    .checkbox-label { display: flex; align-items: center; gap: 8px; font-weight: normal; font-size: var(--text-sm); cursor: pointer; }
    .checkbox-label input { width: auto; }
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
  emailDomainsText = '';
  acceptedDomainOptions: string[] = [];
  
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

  onEmailDomainsChange(text: string) {
    this.emailDomainsText = text;
    const lines = text
      .split(/[\n,]/)
      .map((d) => d.trim().toLowerCase().replace(/^@+/, ''))
      .filter(Boolean);
    this.editData.email_domains = [...new Set(lines)];
    this.updateAcceptedDomains();
  }

  updateAcceptedDomains() {
    const primary = (this.editData.email_domain || '').trim().toLowerCase().replace(/^@+/, '');
    const extras = this.editData.email_domains || [];
    const all = Array.from(new Set([primary, ...extras].filter(Boolean)));
    this.acceptedDomainOptions = all;

    const student = this.editData.student_email_domain || '';
    if (student && !all.includes(student) && !student.endsWith(`.${primary}`)) {
      this.editData.student_email_domain = '';
    }

    const currentGoogle = this.editData.google_domains || [];
    this.editData.google_domains = currentGoogle.filter((g) => all.includes(g) || (primary && g.endsWith(`.${primary}`)));
  }

  isGoogleDomain(domain: string): boolean {
    return (this.editData.google_domains || []).includes(domain);
  }

  toggleGoogleDomain(domain: string, event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    const current = new Set(this.editData.google_domains || []);
    if (checked) current.add(domain);
    else current.delete(domain);
    this.editData.google_domains = Array.from(current);
  }

  loadSchool() {
    this.loadError = '';
    this.adminService.getSchool(this.schoolId).subscribe({
      next: data => {
        this.school = data;
        this.editData = {
          name: data.name,
          email_domain: data.email_domain,
          code: data.code,
          translations: data.translations || {},
          email_domains: data.email_domains || [],
          student_email_domain: data.student_email_domain || '',
          google_domains: data.google_domains || [],
          requires_verification: !!data.requires_verification,
          allows_student_id_verification: !!data.allows_student_id_verification,
        };
        this.emailDomainsText = (data.email_domains || []).join('\n');
        this.updateAcceptedDomains();
        this.editCity = data.city || '';
        this.cdr.markForCheck();
      },
      error: err => {
        this.loadError = parseAdminError(err, this.i18n, 'admin.errLoadFailed');
        this.cdr.markForCheck();
      },
    });
  }

  saving = false;

  saveSchool() {
    if (this.saving) return;
    const payload = {
      ...this.editData,
      code: (this.editData.code || '').trim().toUpperCase(),
      city: this.editCity || null,
      email_domains: this.editData.email_domains || [],
      student_email_domain: this.editData.student_email_domain || '',
      google_domains: this.editData.google_domains || [],
      requires_verification: !!this.editData.requires_verification,
      allows_student_id_verification: !!this.editData.allows_student_id_verification,
    };
    this.saving = true;
    this.adminService.updateSchool(this.schoolId, payload).subscribe({
      next: data => {
        this.saving = false;
        this.school = data;
        this.editData = {
          name: data.name,
          email_domain: data.email_domain,
          code: data.code,
          translations: data.translations || {},
          email_domains: data.email_domains || [],
          student_email_domain: data.student_email_domain || '',
          google_domains: data.google_domains || [],
          requires_verification: !!data.requires_verification,
          allows_student_id_verification: !!data.allows_student_id_verification,
        };
        this.emailDomainsText = (data.email_domains || []).join('\n');
        this.updateAcceptedDomains();
        this.editCity = data.city || '';
        this.cdr.markForCheck();
      },
      // Silently doing nothing left the old code on the page looking saved;
      // a code already used in this region is the likely reason, and says so.
      error: err => {
        this.saving = false;
        this.toast.error(parseAdminError(err, this.i18n));
        this.cdr.markForCheck();
      }
    });
  }
}
