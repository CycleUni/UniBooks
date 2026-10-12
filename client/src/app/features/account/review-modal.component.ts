import { Component, EventEmitter, Input, Output, inject, ChangeDetectorRef } from '@angular/core';
import { UiCheckbox } from '../../shared/ui/checkbox.component';
import { I18nService, TPipe } from '../../core/i18n.service';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiButton } from '../../shared/ui/button.component';
import { UiInput } from '../../shared/ui/input.component';
import { UiFocusTrapDirective } from '../../shared/ui/focus-trap.directive';
import { OrderService } from '../../core/services/order.service';
import { parseApiError } from '../../core/api-error.util';

@Component({
  selector: 'app-review-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, UiButton, UiInput, TPipe, UiCheckbox, UiFocusTrapDirective],
  template: `
    <div class="app-modal-overlay" (click)="close()">
      <div class="app-modal w-full"  style="max-width: 400px;" (click)="$event.stopPropagation()" uiFocusTrap="review-modal-title" (escape)="close()">
        <h3 id="review-modal-title" class="app-modal-title">{{ 'order.reviewTitle' | t }}</h3>
        
        <div class="app-modal-body">
          <p  class="mb-4" class="muted">
            {{ 'order.reviewDesc' | t }}
          </p>

          <div class="checkbox-group mb-5" >
            <ui-checkbox [(ngModel)]="isNoShow" (change)="onNoShowChange()" [label]="'order.noShowReport' | t" class="no-show-checkbox"></ui-checkbox>
          </div>

          <div *ngIf="!isNoShow"  class="mb-4">
            <label  class="mb-2" style="display: block; font-weight: 500;">{{ 'order.rating' | t }}</label>
            <div class="stars">
              <span *ngFor="let star of [1,2,3,4,5]" 
                    (click)="rating = star"
                    [class.active]="star <= rating"
                    class="star">★</span>
            </div>
          </div>

          <ui-input [label]="'order.comment' | t" [(ngModel)]="comment" [placeholder]="'order.optional' | t"></ui-input>

          <div *ngIf="errorMsg" class="inline-msg error">
            {{ errorMsg }}
          </div>
        </div>

        <div class="app-modal-actions">
          <ui-button variant="ghost" (onClick)="close()" [disabled]="isSubmitting">{{ 'common.cancel' | t }}</ui-button>
          <ui-button (onClick)="submit()" [disabled]="isSubmitting || (!isNoShow && rating === 0)">
            {{ isSubmitting ? ('order.processing' | t) : ('order.submit' | t) }}
          </ui-button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    h3 { margin-bottom: 12px; }
    .stars {
      display: flex;
      gap: 8px;
      font-size: var(--text-2xl);
      cursor: pointer;
    }
    .star {
      color: var(--line);
      transition: color var(--motion-base);
    }
    .star:hover, .star.active {
      color: var(--star);
    }
  `]
})
export class ReviewModalComponent {
  @Input() orderId!: string;
  @Output() onClosed = new EventEmitter<boolean>();

  rating = 0;
  comment = '';
  isNoShow = false;
  isSubmitting = false;
  errorMsg = '';

  private orderService = inject(OrderService);
  private cdr = inject(ChangeDetectorRef);
  private i18n = inject(I18nService);

  onNoShowChange() {
    if (this.isNoShow) {
      this.rating = 0;
    }
  }

  close() {
    this.onClosed.emit(false);
  }

  submit() {
    this.isSubmitting = true;
    this.errorMsg = '';
    
    this.orderService.submitReview(this.orderId, this.isNoShow ? null : this.rating, this.comment, this.isNoShow).subscribe({
      next: () => {
        this.isSubmitting = false;
        this.cdr.markForCheck();
        this.onClosed.emit(true);
      },
      error: (err) => {
        this.isSubmitting = false;
        this.errorMsg = parseApiError(err, this.i18n, 'order.errReviewFailed');
        this.cdr.markForCheck();
      }
    });
  }
}
