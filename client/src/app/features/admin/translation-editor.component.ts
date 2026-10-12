import { UiButton } from '../../shared/ui/button.component';
import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TPipe } from '../../core/i18n.service';
import { UiInput } from '../../shared/ui/input.component';
import { UiTextarea } from '../../shared/ui/textarea.component';

export interface TranslationField {
  key: string;
  placeholder: string;
  type: 'text' | 'textarea';
}

@Component({
  selector: 'app-translation-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, UiTextarea, UiInput, TPipe, UiButton],
  template: `
    <div class="translation-item" *ngFor="let t of translationsList; let i = index">
      <div class="translation-header">
        <ui-input class="lang-input" [noMargin]="true" [(ngModel)]="t.lang" (ngModelChange)="onChange()" [placeholder]="'admin.translationLangPlaceholder' | t"></ui-input>
        <ui-button size="sm" variant="danger" (onClick)="removeTranslation(i)">{{ 'common.delete' | t }}</ui-button>
      </div>
      <div class="translation-row" *ngFor="let field of fields">
        <ui-input *ngIf="field.type === 'text'" [noMargin]="true" [(ngModel)]="t.data[field.key]" (ngModelChange)="onChange()" [placeholder]="field.placeholder | t"></ui-input>
        <ui-textarea *ngIf="field.type === 'textarea'" [(ngModel)]="t.data[field.key]" (ngModelChange)="onChange()" [placeholder]="field.placeholder | t"></ui-textarea>
      </div>
    </div>
    <ui-button size="sm" variant="outline" (onClick)="addTranslation()">{{ 'admin.addTranslationLang' | t }}</ui-button>
  `,
  styles: [`
    .translation-item { background: var(--paper-warm); padding: 12px; border-radius: 6px; border: 1px solid var(--line); margin-bottom: 8px; }
    .translation-header { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; }
    .translation-row { margin-bottom: 8px; }
    .translation-row:last-child { margin-bottom: 0; }
    /* The removed .input rule set border, padding and radius but never a
       background or colour, so these fields fell through to the user agent's
       white-on-black default. That reads as correct in light mode and as a
       white box in dark mode — the failure only shows up in one theme, which
       is why it survived. ui-input carries the whole set. */
    .lang-input { width: 150px; font-weight: 600; }
    .mt-2 { margin-top: 8px; }
  `]
})
export class TranslationEditorComponent {
  @Input() fields: TranslationField[] = [];
  
  /** The exact object reference we last emitted. The parent assigns it straight
      back into the [translations] binding, and rebuilding from that echo would
      discard the row the user is still filling in. */
  private lastEmitted: any = null;

  _translations: any = {};
  @Input() set translations(val: any) {
    if (val !== null && val === this.lastEmitted) return;
    this._translations = val || {};
    this.translationsList = Object.keys(this._translations).map(lang => ({
      lang,
      data: { ...this._translations[lang] }
    }));
    this.addMissingLanguages();
  }

  /**
   * Languages that always get a row, filled or not — the region's own, so an
   * admin in Hong Kong is offered zh-HK rather than having to know to type
   * it. An empty row is left out of what is emitted, like any other.
   */
  private _languages: string[] = [];
  @Input() set languages(val: string[] | null | undefined) {
    this._languages = val || [];
    this.addMissingLanguages();
  }

  private addMissingLanguages() {
    for (const lang of this._languages) {
      if (!this.translationsList.some(t => t.lang.trim() === lang)) {
        this.translationsList.push({ lang, data: {} });
      }
    }
  }
  @Output() translationsChange = new EventEmitter<any>();

  translationsList: { lang: string, data: any }[] = [];

  addTranslation() {
    this.translationsList.push({ lang: '', data: {} });
    this.onChange();
  }

  removeTranslation(index: number) {
    this.translationsList.splice(index, 1);
    this.onChange();
  }

  onChange() {
    const newTrans: any = {};
    for (const t of this.translationsList) {
      if (t.lang.trim()) {
        const langData: any = {};
        for (const f of this.fields) {
          if (t.data[f.key] && t.data[f.key].trim()) {
            langData[f.key] = t.data[f.key].trim();
          }
        }
        if (Object.keys(langData).length > 0) {
          newTrans[t.lang.trim()] = langData;
        }
      }
    }
    this.lastEmitted = newTrans;
    this.translationsChange.emit(newTrans);
  }
}
