import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, Input, NgZone, OnDestroy, inject } from '@angular/core';

/** The sticky app bar over the top of the page (ui-app-bar's min-height). */
const APP_BAR_HEIGHT = 52;

/**
 * A page's primary actions. On wide screens a plain row of buttons where the
 * page puts it; on phones pinned to the bottom of the screen, where the thumb
 * is, with an optional lead (the price) on the left and the buttons on the
 * right at the width of their labels — the product-screen layout of
 * marketplace apps.
 *
 * The route that shows one declares `data: { actionBar: true }`, and the
 * layout then drops the bottom tab bar and reserves this bar's height. That
 * is decided at navigation time rather than when this component renders, so
 * the tab bar is already gone while the page loads and during the page
 * transition, instead of vanishing when the data arrives. With no page to go
 * back to (a shared link), the layout keeps the tab bar and marks the page
 * .action-bar-over-tabs; this bar then sits on top of it.
 *
 *   <ui-action-bar [leadFor]="priceEl">
 *     <span actionBarLead>{{ price }}</span>
 *     <ui-button>…</ui-button>
 *   </ui-action-bar>
 *
 * `leadFor` names the element the lead repeats (the page's own large price):
 * the lead then shows only while that element is scrolled out of view, so the
 * price is on screen once, never twice.
 */
@Component({
  selector: 'ui-action-bar',
  standalone: true,
  template: `
    <span class="lead" [class.repeated]="leadRepeatsVisible"><ng-content select="[actionBarLead]"></ng-content></span>
    <ng-content></ng-content>
  `,
  styles: [`
    :host {
      display: flex;
      gap: 16px;
      margin-top: auto;
    }
    /* The lead repeats what the page shows larger beside its title; only the
       phone bar, where that is scrolled away, needs it. */
    .lead {
      display: none;
    }

    @media (max-width: 900px) {
      :host {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 100;
        align-items: center;
        gap: 8px;
        margin: 0;
        padding: 10px 16px calc(10px + env(safe-area-inset-bottom, 0px));
        background: var(--paper);
        border-top: 1px solid var(--line);
      }
      :host-context(.action-bar-over-tabs) {
        /* The tab bar: 56px of tabs and its 1px top border. */
        bottom: calc(57px + env(safe-area-inset-bottom, 0px));
        padding-bottom: 10px;
      }
      .lead {
        display: block;
        flex-shrink: 0;
        margin-right: auto;
        transition: opacity 0.15s ease;
        font-family: 'Noto Serif TC', serif;
        font-size: var(--text-lg);
        font-weight: 700;
        color: var(--accent);
        font-variant-numeric: tabular-nums;
      }
      /* Kept in the row (visibility, not display) so the buttons don't shift
         when it appears; hidden while the page shows the same price. */
      .lead.repeated {
        opacity: 0;
        visibility: hidden;
      }
      /* Label-width buttons, not the equal halves (flex-1) or full width
         (block) the pages ask for on desktop; the !important beats the
         inline padding and font size those pages set for that layout.
         They may still shrink: with a long price and two English labels
         the row is wider than a phone, and a label then wraps rather than
         pushing the last button off the screen. */
      :host ::ng-deep > ui-button {
        flex: 0 1 auto;
        min-width: 0;
        display: inline-block !important;
        width: auto !important;
        padding: 0 !important;
        font-size: var(--text-base) !important;
      }
      :host ::ng-deep > ui-button .ui-btn {
        white-space: normal;
        line-height: 1.2;
      }
    }
  `]
})
export class UiActionBar implements AfterViewInit, OnDestroy {
  /** Whether the element the lead repeats is fully on screen right now. */
  leadRepeatsVisible = false;
  private repeated?: HTMLElement;
  private observer?: IntersectionObserver;
  private zone = inject(NgZone);
  private cdr = inject(ChangeDetectorRef);
  private host: ElementRef<HTMLElement> = inject(ElementRef);

  @Input() set leadFor(element: HTMLElement | null | undefined) {
    this.repeated = element ?? undefined;
    this.observe();
  }

  ngAfterViewInit() {
    // Measured once laid out: where this bar sits decides what it covers.
    this.observe();
  }

  ngOnDestroy() {
    this.observer?.disconnect();
  }

  /**
   * Watches the repeated element within the part of the screen nothing
   * covers: below the app bar and above this bar (and the tab bar under it,
   * when both show). A price behind the fixed bar is in the viewport but not
   * readable, and counting it as visible hid the price in both places.
   */
  private observe() {
    this.observer?.disconnect();
    this.leadRepeatsVisible = false;
    if (!this.repeated || typeof IntersectionObserver === 'undefined') return;
    const barTop = this.host.nativeElement.getBoundingClientRect().top;
    const coveredBelow = barTop > 0 && barTop < window.innerHeight ? window.innerHeight - barTop : 0;
    // Back into the zone, and marked for check: observer callbacks aren't
    // guaranteed to run in the zone, and the pages using this are OnPush, so
    // a changed field alone would never reach the template.
    this.observer = new IntersectionObserver(([entry]) => {
      this.zone.run(() => {
        this.leadRepeatsVisible = entry.isIntersecting;
        this.cdr.markForCheck();
      });
    }, { rootMargin: `-${APP_BAR_HEIGHT}px 0px -${Math.round(coveredBelow)}px 0px`, threshold: 1 });
    this.observer.observe(this.repeated);
  }
}
