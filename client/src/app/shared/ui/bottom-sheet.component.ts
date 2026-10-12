import { Component, ElementRef, EventEmitter, Input, OnDestroy, OnInit, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UiFocusTrapDirective } from './focus-trap.directive';

let nextId = 0;
/** Open sheets, so the page scroll lock is released only by the last one. */
let openCount = 0;

/** Whether any ui-bottom-sheet is currently open in the DOM. */
export function isBottomSheetOpen(): boolean {
  return openCount > 0;
}

/**
 * A panel that slides up from the bottom of the screen: the phone
 * replacement for dropdowns, popovers and side panels (ui-dropdown uses it
 * below the mobile breakpoint; the search filters use it directly).
 *
 * Render it only while open (`@if`/`*ngIf`); it closes itself through
 * `closed` — backdrop tap, Escape, or dragging the handle down — and the
 * parent then removes it.
 *
 * It moves its own element to <body> so no ancestor's overflow, transform or
 * stacking context (the sticky header, a card) can clip it.
 *
 *   <ui-bottom-sheet *ngIf="open" [title]="..." (closed)="open = false">
 *     ...content...
 *     <div sheetFooter>...buttons...</div>
 *   </ui-bottom-sheet>
 */
@Component({
  selector: 'ui-bottom-sheet',
  standalone: true,
  imports: [CommonModule, UiFocusTrapDirective],
  template: `
    <div class="backdrop" (click)="closed.emit()"></div>
    <div
      class="sheet"
      [class.dragging]="dragging"
      [style.transform]="dragY > 0 ? 'translateY(' + dragY + 'px)' : null"
      [uiFocusTrap]="title ? titleId : undefined"
      [attr.aria-label]="title ? null : ariaLabel"
      (escape)="closed.emit()"
    >
      <div
        class="grab"
        (touchstart)="dragStart($event)"
        (touchmove)="dragMove($event)"
        (touchend)="dragEnd()"
        (touchcancel)="dragEnd()"
      >
        <span class="handle" aria-hidden="true"></span>
        <h2 *ngIf="title" class="title" [id]="titleId">{{ title }}</h2>
      </div>
      <div class="body">
        <ng-content></ng-content>
      </div>
      <div class="footer">
        <ng-content select="[sheetFooter]"></ng-content>
      </div>
    </div>
  `,
  styles: [`
    :host {
      position: fixed;
      inset: 0;
      z-index: 1100;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
    }
    .backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      animation: sheet-fade 0.2s ease;
    }
    .sheet {
      position: relative;
      display: flex;
      flex-direction: column;
      max-height: 85dvh;
      background: var(--surface-raised);
      border-radius: 16px 16px 0 0;
      box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.18);
      padding-bottom: env(safe-area-inset-bottom, 0px);
      animation: sheet-up 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
      transition: transform 0.2s ease;
      outline: none;
    }
    .sheet.dragging {
      transition: none;
    }
    .grab {
      flex-shrink: 0;
      padding: 8px 16px 4px;
      touch-action: none;
    }
    .handle {
      display: block;
      width: 36px;
      height: 4px;
      margin: 0 auto 8px;
      border-radius: 2px;
      background: var(--line-strong);
    }
    .title {
      margin: 0 0 4px;
      font-size: var(--text-base);
      font-weight: 600;
      text-align: center;
      color: var(--ink);
    }
    .body {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 4px 8px 8px;
    }
    .footer:empty {
      display: none;
    }
    .footer {
      flex-shrink: 0;
      display: flex;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid var(--line);
    }
    @keyframes sheet-up { from { transform: translateY(100%); } }
    @keyframes sheet-fade { from { opacity: 0; } }
  `]
})
export class UiBottomSheet implements OnInit, OnDestroy {
  /** Heading shown under the handle, and the sheet's accessible name. */
  @Input() title = '';
  /** Accessible name when there is no visible title. */
  @Input() ariaLabel = '';
  @Output() closed = new EventEmitter<void>();

  readonly titleId = `bottom-sheet-title-${nextId++}`;
  dragY = 0;
  dragging = false;

  private el = inject(ElementRef<HTMLElement>);
  private startY = 0;

  ngOnInit() {
    if (typeof document === 'undefined') return;
    document.body.appendChild(this.el.nativeElement);
    if (openCount++ === 0) document.documentElement.style.overflow = 'hidden';
  }

  ngOnDestroy() {
    if (typeof document === 'undefined') return;
    this.el.nativeElement.remove();
    if (--openCount === 0) document.documentElement.style.overflow = '';
  }

  // Drag the handle down to dismiss, as native sheets do; let go before the
  // threshold and it springs back.
  dragStart(event: TouchEvent) {
    this.startY = event.touches[0].clientY;
    this.dragging = true;
  }

  dragMove(event: TouchEvent) {
    if (!this.dragging) return;
    this.dragY = Math.max(0, event.touches[0].clientY - this.startY);
  }

  dragEnd() {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.dragY > 80) {
      this.closed.emit();
    } else {
      this.dragY = 0;
    }
  }
}
