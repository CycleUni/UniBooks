import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TPipe } from '../../core/i18n.service';

@Component({
  selector: 'ui-search-bar',
  standalone: true,
  imports: [CommonModule, TPipe],
  template: `
    <div class="search-wrapper">
      <input 
        type="text" 
        [placeholder]="placeholder" 
        [attr.aria-label]="placeholder"
        [value]="value" 
        enterkeyhint="search"
        (input)="onInput($event)" 
        (keyup.enter)="onSearchClick()"
        class="search-input"
      >
      <button class="search-btn" (click)="onSearchClick()" [attr.aria-label]="'common.search' | t">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
      </button>
    </div>
  `,
  styles: [`
    .search-wrapper {
      position: relative;
      width: 100%;
      display: flex;
    }
    .search-input {
      width: 100%;
      padding: 12px 48px 12px 16px;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-control);
      font-size: var(--text-md);
      background: var(--paper-warm);
      color: var(--ink);
      box-sizing: border-box;
      transition: border-color var(--motion-base);
    }
    .search-input::placeholder {
      color: var(--muted);
    }
    .search-input:focus-visible {
      border-color: var(--accent);
      outline: 2px solid transparent;
    }
    .search-btn {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      color: var(--muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-1);
      border-radius: var(--radius-control);
    }
    /* Expand touch target using pseudo-element instead of margin/padding
       so the button itself doesn't move and overlap the input. */
    @media (pointer: coarse) {
      .search-btn::after {
        content: '';
        position: absolute;
        inset: -12px;
      }
    }
    .search-btn:hover {
      color: var(--accent);
      /* Not rgba(0,0,0,.05): a black wash over the dark palette's near-black
         ground is invisible. */
      background-color: var(--accent-soft);
    }
  `]
})
export class UiSearchBarComponent {
  @Input() placeholder: string = '';
  @Input() value: string = '';
  @Output() search = new EventEmitter<string>();

  onInput(event: Event) {
    const val = (event.target as HTMLInputElement).value;
    this.value = val;
  }

  onSearchClick() {
    this.search.emit(this.value);
  }
}
