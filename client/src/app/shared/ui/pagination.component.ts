import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'ui-pagination',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="pagination" *ngIf="totalPages > 1">
      <button class="page-btn" [disabled]="currentPage === 1" (click)="onPageChange(currentPage - 1)">&lt;</button>
      
      <ng-container *ngFor="let page of pages">
        <button 
          *ngIf="page !== -1"
          class="page-btn" 
          [class.active]="currentPage === page" 
          (click)="onPageChange(page)"
        >{{ page }}</button>
        <span *ngIf="page === -1" class="ellipsis">...</span>
      </ng-container>

      <button class="page-btn" [disabled]="currentPage === totalPages" (click)="onPageChange(currentPage + 1)">&gt;</button>
    </div>
  `,
  styles: [`
    .pagination {
      display: flex;
      justify-content: center;
      gap: 8px;
      margin: 32px 0;
      align-items: center;
    }
    .page-btn {
      min-width: 36px;
      height: 36px;
      padding: 0 8px;
      border: 1px solid var(--line);
      background: var(--paper-warm);
      border-radius: 4px;
      cursor: pointer;
      font-size: var(--text-base);
      color: var(--ink);
      /* Enumerated, not 'all': the button's min-width tracks the digit count,
         so 'all' animated its width every time the page number changed. */
      transition: background-color var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast);
    }
    .page-btn:hover:not(:disabled) {
      border-color: var(--accent);
      color: var(--accent);
    }
    .page-btn.active {
      background: var(--accent);
      color: var(--on-accent);
      border-color: var(--accent);
    }
    .page-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .ellipsis {
      color: var(--muted);
      padding: 0 4px;
    }
  `]
})
export class UiPagination {
  @Input() total = 0;
  @Input() pageSize = 20;
  @Input() currentPage = 1;
  @Output() pageChange = new EventEmitter<number>();

  get totalPages(): number {
    return Math.ceil(this.total / this.pageSize);
  }

  get pages(): number[] {
    const total = this.totalPages;
    const current = this.currentPage;
    if (total <= 7) {
      return Array.from({length: total}, (_, i) => i + 1);
    }
    
    if (current <= 3) {
      return [1, 2, 3, 4, -1, total];
    }
    
    if (current >= total - 2) {
      return [1, -1, total - 3, total - 2, total - 1, total];
    }
    
    return [1, -1, current - 1, current, current + 1, -1, total];
  }

  onPageChange(page: number) {
    if (page >= 1 && page <= this.totalPages && page !== this.currentPage) {
      this.pageChange.emit(page);
    }
  }
}
