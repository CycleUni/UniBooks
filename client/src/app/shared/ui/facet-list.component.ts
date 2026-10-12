import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface FacetOption {
  label: string;
  value: string;
  count?: number;
  selected: boolean;
}

let nextId = 0;

/**
 * `facet-list`: a plain-text filter/facet list — a lighter "editorial"
 * alternative to boxed dropdowns/checkboxes. Each option renders as a row
 * with a small indicator, label, and optional trailing count.
 *
 * Selection state still lives with the parent (it listens to `optionToggle`
 * and mutates `options`), but `selectionMode` is now declared rather than
 * merely implied: every group used to draw the same round dot, so nothing on
 * screen told the user whether clicking an option *adds* a condition or
 * *replaces* the current one. The mode drives both the marker shape and the
 * ARIA roles, so the two can never drift apart.
 */
@Component({
  selector: 'ui-facet-list',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="facet-group">
      <h4 class="facet-title" *ngIf="title" [id]="titleId">{{ title }}</h4>
      <ul
        class="facet-list"
        [class.single]="selectionMode === 'single'"
        [attr.role]="selectionMode === 'single' ? 'radiogroup' : 'group'"
        [attr.aria-labelledby]="title ? titleId : null"
      >
        <!-- role/tabindex rather than a bare <li (click)>: the options are the
             only way to filter, and a plain list item is unreachable by
             keyboard and announced as static text. The <ul>'s own role
             overrides its list semantics, which is why the items carry
             radio/checkbox roles instead of listitem. -->
        <li
          class="facet-option"
          *ngFor="let option of options"
          [class.selected]="option.selected"
          [attr.role]="selectionMode === 'single' ? 'radio' : 'checkbox'"
          [attr.aria-checked]="option.selected"
          tabindex="0"
          (click)="select(option.value)"
          (keydown.enter)="select(option.value, $event)"
          (keydown.space)="select(option.value, $event)"
        >
          <span class="facet-marker"></span>
          <span class="facet-label">{{ option.label }}</span>
          <span class="facet-count" *ngIf="option.count !== undefined">{{ option.count }}</span>
        </li>
      </ul>
    </div>
  `,
  styles: [`
    .facet-group {
      /* No external margin here on purpose: this component is embedded in
         varying layouts (e.g. search.ts's .filter-group already provides
         divider + spacing between groups) — imposing our own margin here
         double-stacked with the parent's, producing an oversized gap. */
    }
    .facet-title {
      margin: 0 0 12px;
      font-size: var(--text-base);
      font-weight: 500;
      color: var(--ink);
    }
    .facet-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .facet-option {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-size: var(--text-base);
      color: var(--ink);
      /* Not --tap-min: a sidebar of 20 courses at 44px a row would scroll off
         the screen. 24px is the WCAG 2.5.8 minimum target and keeps the list
         as dense as the editorial treatment intends. */
      min-height: 24px;
    }
    /* Square = checkbox = "adds a condition"; round = radio = "replaces the
       current one". Same recipe as ui-checkbox / ui-radio-group so the two
       vocabularies read identically wherever they appear. */
    .facet-marker {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      border: 1.5px solid var(--line-strong);
      border-radius: var(--radius-xs);
      background-color: var(--paper);
      box-sizing: border-box;
      display: grid;
      place-content: center;
    }
    .facet-list.single .facet-marker {
      border-radius: 50%;
    }
    .facet-marker::before {
      content: "";
      width: 10px;
      height: 10px;
      background-color: var(--btn-primary-ink);
      clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%);
      transform: scale(0);
      transition: transform var(--motion-fast) ease-in-out;
    }
    .facet-list.single .facet-marker::before {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      clip-path: none;
    }
    .facet-option.selected .facet-marker {
      background-color: var(--accent);
      border-color: var(--accent);
    }
    .facet-option.selected .facet-marker::before {
      transform: scale(1);
    }
    .facet-option:hover .facet-marker {
      border-color: var(--accent);
    }
    .facet-option.selected .facet-label {
      font-weight: 500;
    }
    .facet-label {
      flex: 1;
    }
    .facet-count {
      color: var(--muted);
      font-size: var(--text-sm);
      font-variant-numeric: tabular-nums;
    }
  `]
})
export class UiFacetList {
  @Input() title: string = '';
  @Input() options: FacetOption[] = [];
  /**
   * Defaults to 'single' because that is what the list already looked like —
   * one round dot — so an existing call site that says nothing keeps
   * rendering exactly as before instead of silently turning into checkboxes.
   */
  @Input() selectionMode: 'single' | 'multiple' = 'single';

  @Output() optionToggle = new EventEmitter<string>();

  titleId = `ui-facet-list-title-${nextId++}`;

  select(value: string, event?: Event) {
    // Space scrolls the page on any focusable element; the user pressing it
    // here means "tick this", not "page down".
    event?.preventDefault();
    this.optionToggle.emit(value);
  }
}
