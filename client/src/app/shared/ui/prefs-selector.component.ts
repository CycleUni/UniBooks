import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiDropdown } from './dropdown.component';
import { RegionService } from '../../core/region.service';
import { I18nService, TPipe } from '../../core/i18n.service';
import { LANG_LABELS, Lang } from '../../core/i18n';

@Component({
  selector: 'ui-prefs-selector',
  standalone: true,
  imports: [CommonModule, FormsModule, UiDropdown, TPipe],
  template: `
    @if (variant === 'rows') {
      <!-- The phone account menu's rows: each names its setting and shows the
         current choice, and opens the same options as a bottom sheet. -->
      <div class="prefs-rows">
        <ui-dropdown
          class="prefs-row"
          [options]="regionOptions"
          [ngModel]="regionService.region()"
          (ngModelChange)="onRegionChange($event)"
          [searchable]="false"
          [compact]="true"
          [inlineLabel]="true"
          [label]="'acct.prefRegion' | t"
          [sheetTitle]="'nav.regionSwitcher' | t"
        ></ui-dropdown>
        <ui-dropdown
          class="prefs-row"
          [options]="langOptions"
          [ngModel]="i18n.lang()"
          (ngModelChange)="onLangChange($event)"
          [searchable]="false"
          [compact]="true"
          [inlineLabel]="true"
          [label]="'acct.prefLanguage' | t"
          [sheetTitle]="'nav.languageSwitcher' | t"
        ></ui-dropdown>
      </div>
    } @else {
      <div
        class="prefs-selector-container"
        role="group"
        [attr.aria-label]="'nav.languageSwitcher' | t"
      >
        <ui-dropdown
          class="footer-lang-dropdown mr-3"
          [options]="regionOptions"
          [ngModel]="regionService.region()"
          (ngModelChange)="onRegionChange($event)"
          [searchable]="false"
          [compact]="true"
          [align]="'right'"
          [appendToBody]="true"
          [triggerAriaLabel]="'nav.regionSwitcher' | t"
        >
          <svg
            dropdownTrigger
            class="footer-lang-globe"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="16"
            height="16"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path
              d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
            />
          </svg>
        </ui-dropdown>
        <ui-dropdown
          [options]="langOptions"
          [ngModel]="i18n.lang()"
          (ngModelChange)="onLangChange($event)"
          [searchable]="false"
          [compact]="true"
          [align]="'right'"
          [appendToBody]="true"
          [triggerAriaLabel]="'nav.languageSwitcher' | t"
        >
          <span dropdownTrigger class="footer-lang-globe lang-icon-wrap" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <text
                x="1"
                y="15"
                font-family="inherit"
                font-size="13"
                font-weight="500"
                fill="var(--ink)"
              >
                文
              </text>
              <text
                x="11"
                y="19"
                font-family="inherit"
                font-size="10"
                font-weight="700"
                fill="var(--accent)"
              >
                A
              </text>
            </svg>
          </span>
        </ui-dropdown>
      </div>
    }
  `,
  styles: [
    `
      .prefs-selector-container {
        display: inline-flex;
        align-items: center;
      }
      .footer-lang-globe {
        color: var(--muted);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .footer-lang-globe:hover {
        color: var(--ink);
      }
      .lang-icon-wrap {
        width: 20px;
        height: 20px;
      }
      /* Rows of the account menu's card (account.css): the setting's name on
       the left, the current choice and a chevron on the right. */
      .prefs-rows {
        display: flex;
        flex-direction: column;
      }
      .prefs-row ::ng-deep .dropdown-trigger {
        width: 100%;
        min-height: 52px;
        padding: 0 var(--space-4);
        border: none;
        border-bottom: 1px solid var(--line);
        border-radius: 0;
        background: none;
        gap: var(--space-2);
        /* The menu's own type, not the dropdown field's smaller size. */
        font: inherit;
        font-weight: 500;
      }
      /* A row is not a field: no accent border while its sheet is open. */
      .prefs-row ::ng-deep .dropdown-trigger[aria-expanded='true'] {
        border-color: var(--line);
      }
      .prefs-row:last-child ::ng-deep .dropdown-trigger {
        border-bottom: none;
      }
      /* Pressed like the menu's other rows, which are links: a tint, without
         the global button shrink (styles.css). */
      .prefs-row ::ng-deep .dropdown-trigger:active {
        background-color: var(--paper-warm);
        transform: none;
      }
      .prefs-row ::ng-deep .dropdown-inline-label {
        color: var(--ink);
      }
      .prefs-row ::ng-deep .dropdown-trigger-label {
        text-align: right;
        color: var(--muted);
        font-weight: 400;
      }
      /* Each row opens a list, like the menu's page rows open a page. */
      .prefs-row ::ng-deep .dropdown-caret {
        flex-shrink: 0;
        color: var(--muted);
        transform: rotate(-90deg);
      }
    `,
  ],
})
export class UiPrefsSelector {
  /** 'icons': the two icon triggers under a page. 'rows': labelled rows for
   *  the phone account menu. */
  @Input() variant: 'icons' | 'rows' = 'icons';

  readonly i18n = inject(I18nService);
  readonly regionService = inject(RegionService);

  get langOptions() {
    const codes: string[] =
      this.regionService.currentRegionObj()?.languages ?? Object.keys(LANG_LABELS);
    return codes
      .filter((c): c is Lang => c in LANG_LABELS)
      .map((c) => ({ value: c, label: LANG_LABELS[c] }));
  }

  get regionOptions() {
    return this.regionService.regions().map((r) => ({
      value: r.code.toLowerCase(),
      label: r.localized_name || r.name,
    }));
  }

  onRegionChange(regionCode: string) {
    this.regionService.setRegion(regionCode);
  }

  onLangChange(lang: string) {
    // A language picked by hand answers the device-language suggestion too.
    this.i18n.settleSuggestion();
    this.i18n.setLang(lang as Lang);
  }
}
