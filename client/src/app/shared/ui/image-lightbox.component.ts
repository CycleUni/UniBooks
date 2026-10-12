import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TPipe } from '../../core/i18n.service';
import { UiFocusTrapDirective } from './focus-trap.directive';

/**
 * Full-screen image viewer. Purely presentational: the host owns which image
 * (if any) is open, this owns nothing but the overlay chrome.
 *
 * Extracted from the Messages page, which had grown past the
 * `anyComponentStyle` build budget — see also UiReportModal and
 * MessagesInboxList.
 */
@Component({
  selector: 'ui-image-lightbox',
  standalone: true,
  imports: [CommonModule, TPipe, UiFocusTrapDirective],
  template: `
    <div class="image-modal-overlay" *ngIf="src" (click)="close.emit()">
      <div class="image-modal" (click)="$event.stopPropagation()" uiFocusTrap (escape)="close.emit()">
        <button class="image-modal-close" type="button" (click)="close.emit()" [title]="'msg.close' | t" [attr.aria-label]="'msg.close' | t">×</button>
        <img [src]="src" [alt]="'msg.imagePreview' | t" class="image-modal-img">
      </div>
    </div>
  `,
  styles: [`
    .image-modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.9);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
      padding: 20px;
    }
    .image-modal {
      position: relative;
      max-width: 90vw;
      max-height: 90vh;
    }
    .image-modal-img {
      max-width: 100%;
      max-height: 90vh;
      border-radius: 8px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
    }
    .image-modal-close {
      position: absolute;
      top: -44px;
      right: 0;
      width: 36px;
      height: 36px;
      border: none;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.2);
      color: white;
      font-size: var(--text-2xl);
      line-height: 36px;
      cursor: pointer;
      transition: background-color var(--motion-base);
    }
    .image-modal-close:hover {
      background: rgba(255, 255, 255, 0.4);
    }
  `]
})
export class UiImageLightbox {
  /** URL of the image to show; falsy closes the lightbox. */
  @Input() src = '';
  @Output() close = new EventEmitter<void>();
}
