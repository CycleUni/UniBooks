import { Component, ElementRef, Input, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * The frame Google's button is drawn into, with its loading states: a
 * placeholder until Google has drawn it, a note when Google's script cannot
 * load, and a veil with a spinner while something is in flight. Sign-in and
 * campus verification both use it, so the two buttons wait and fail alike.
 *
 * Google draws into `host` (reach it by `buttonId` or through the ViewChild);
 * the caller decides what each state means and passes it in.
 */
@Component({
  selector: 'ui-google-button-frame',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="google-wrap" [class.start]="align === 'start'" [attr.aria-busy]="busy">
      <div #host class="google-btn" [attr.id]="buttonId || null"></div>
      <div *ngIf="!ready && !failed" class="google-placeholder" aria-hidden="true"></div>
      <p *ngIf="failed" class="google-failed" role="status">{{ failedLabel }}</p>
      <div *ngIf="busy && !failed" class="google-veil" [class.blocking]="blocking">
        <span class="spinner" aria-hidden="true"></span>
        <span *ngIf="busyLabel">{{ busyLabel }}</span>
      </div>
      <span class="sr-only" role="status">{{ busy ? busyLabel : '' }}</span>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      /* Its height matches GIS's "large" button (40px), so the placeholder takes
       the space the button will, and the veil can sit over the iframe Google
       draws without knowing its size. */
      .google-wrap {
        position: relative;
        min-height: 40px;
      }
      .google-btn {
        display: flex;
        justify-content: center;
        /* Google's button iframe is a light-scheme document. Embedded in a page
         whose color-scheme is dark, the browser paints an opaque white backing
         behind it — the white box around the dark button. The iframe inherits
         this, so both sides are 'light' and the backing stays transparent. The
         button draws its own dark variant (theme: filled_black). */
        color-scheme: light;
      }
      .start .google-btn {
        justify-content: flex-start;
      }
      .google-placeholder,
      .google-veil,
      .google-failed {
        margin: 0 auto;
        max-width: 400px;
      }
      .start .google-placeholder,
      .start .google-veil,
      .start .google-failed {
        margin-left: 0;
      }
      .google-placeholder {
        position: absolute;
        inset: 0;
        height: 40px;
        border-radius: var(--radius-control);
        background-color: var(--line-strong);
        animation: google-pulse 1.5s infinite ease-in-out;
      }
      .google-failed {
        font-size: var(--text-sm);
        color: var(--muted);
        text-align: center;
      }
      .start .google-failed {
        text-align: left;
      }
      /* A non-blocking veil only shows the spinner and lets clicks through (the
       account chooser may have been dismissed); a blocking one stops a second
       press while the server works. */
      .google-veil {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
        color: var(--ink);
        /* Opaque, and outlined like the button: a see-through veil left
         Google's own label showing under the spinner's. */
        background-color: var(--surface-card);
        border: 1px solid var(--line-strong);
        border-radius: var(--radius-control);
        pointer-events: none;
      }
      .google-veil.blocking {
        pointer-events: auto;
        cursor: progress;
      }
      .spinner {
        width: 18px;
        height: 18px;
        border: 2px solid var(--line-strong);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: google-spin 0.8s linear infinite;
      }
      @keyframes google-spin {
        to {
          transform: rotate(360deg);
        }
      }
      @keyframes google-pulse {
        0%,
        100% {
          opacity: 0.75;
        }
        50% {
          opacity: 0.5;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .spinner {
          animation-duration: 2.4s;
        }
        .google-placeholder {
          animation: none;
          opacity: 0.6;
        }
      }
      /* Announces the busy state for a screen reader; there is no global one. */
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    `,
  ],
})
export class UiGoogleButtonFrame {
  /** id for the element Google draws into, for callers that look it up by id. */
  @Input() buttonId = '';
  /** Google has drawn its button: the placeholder goes. */
  @Input() ready = false;
  /** Google's script cannot load: no button is coming. */
  @Input() failed = false;
  /** Something is in flight (the chooser opening, the server checking). */
  @Input() busy = false;
  /** While busy, also stop clicks reaching the button. */
  @Input() blocking = false;
  /** Shown beside the spinner and announced while busy; empty shows the spinner alone. */
  @Input() busyLabel = '';
  /** The note shown when failed. */
  @Input() failedLabel = '';
  /** 'center' on the sign-in card, 'start' inside a left-aligned form. */
  @Input() align: 'center' | 'start' = 'center';

  @ViewChild('host', { static: true }) host!: ElementRef<HTMLElement>;
}
