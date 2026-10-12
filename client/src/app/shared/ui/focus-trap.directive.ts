import { Directive, ElementRef, EventEmitter, Input, OnDestroy, Output, AfterViewInit, HostListener } from '@angular/core';

/** Everything that can hold focus inside the dialog, in document order.
 *  Selector alone is not enough — see focusableElements(). */
const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Traps focus within the host element, restoring it to the previous active
 * element when destroyed. Handles Esc to close and Tab/Shift+Tab to cycle.
 * 
 * Provides `role="dialog"` and `aria-modal="true"` to the host element.
 * The selector `[uiFocusTrap]` expects the ID of the title element for
 * `aria-labelledby`.
 */
@Directive({
  selector: '[uiFocusTrap]',
  standalone: true,
  host: {
    'tabindex': '-1',
    'role': 'dialog',
    'aria-modal': 'true',
    '[attr.aria-labelledby]': 'ariaLabelledBy || null',
  }
})
export class UiFocusTrapDirective implements AfterViewInit, OnDestroy {
  @Input('uiFocusTrap') ariaLabelledBy?: string;
  @Output() escape = new EventEmitter<void>();

  private returnFocusTo: HTMLElement | null = null;

  constructor(private el: ElementRef<HTMLElement>) {}

  ngAfterViewInit() {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    this.returnFocusTo = active instanceof HTMLElement ? active : null;

    // Focus after view init to allow contents to render
    setTimeout(() => this.focusInitial());
  }

  ngOnDestroy() {
    const target = this.returnFocusTo;
    this.returnFocusTo = null;
    // The trigger might have been removed from the DOM; focusing a detached
    // node silently sends focus to <body>.
    if (target && target.isConnected) target.focus();
  }

  @HostListener('keydown', ['$event'])
  onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.escape.emit();
      return;
    }
    
    if (event.key !== 'Tab') return;

    const focusable = this.focusableElements();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    // Only the two edges need intercepting; everything between them is the
    // browser's own Tab order and should stay that way.
    if (event.shiftKey && (active === first || !this.el.nativeElement.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !this.el.nativeElement.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  private focusInitial(): void {
    const autofocus = this.el.nativeElement.querySelector<HTMLElement>('[autofocus]');
    (autofocus ?? this.focusableElements()[0] ?? this.el.nativeElement)?.focus();
  }

  /**
   * Rendered, focusable children only.
   *
   * The selector cannot see CSS: the meetup dialog carries a native date input
   * inside `.mobile-date { display: none }` for narrow screens, and on a
   * desktop that hidden input still matched. If it sorted first, focusInitial()
   * called focus() on an unrendered element — a no-op — and focus stayed on
   * <body>, i.e. outside the very dialog this is meant to trap it in.
   *
   * getClientRects() is the reliable test in a browser — it is empty for a
   * detached node, for display:none, and for anything under a display:none
   * ancestor, which the element's own computed display does not report.
   *
   * jsdom has no layout engine, so there every element reports zero rects and
   * that test would discard the whole dialog. When the host itself reports no
   * rects we are in that environment and fall back to what it can answer:
   * computed display, which does reflect the element's own style.
   */
  private focusableElements(): HTMLElement[] {
    const laidOut = this.el.nativeElement.getClientRects().length > 0;
    return Array.from(this.el.nativeElement.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(el => {
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        return laidOut ? el.getClientRects().length > 0 : true;
      });
  }
}
