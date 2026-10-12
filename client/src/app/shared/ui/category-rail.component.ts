import { RegionLinkDirective } from '../../core/region-link.directive';
import { Component, Input, ViewChild, ElementRef, HostListener, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { TPipe } from '../../core/i18n.service';
import { scrollBehavior } from '../../core/reduced-motion';

@Component({
  selector: 'ui-category-rail',
  standalone: true,
  imports: [RegionLinkDirective, CommonModule, RouterModule, TPipe],
  template: `
    <div class="categories-wrapper" *ngIf="categories?.length" [class.has-left]="canScrollLeft" [class.has-right]="canScrollRight">
      <button class="scroll-btn left" *ngIf="canScrollLeft" (click)="scrollCategories(-1)" [attr.aria-label]="'common.previous' | t">&#8249;</button>
      <div class="categories-grid" #categoriesGrid (scroll)="checkScroll()">
        <a [regionLink]="['/search']" [queryParams]="{ category: cat.slug }" class="category-card" *ngFor="let cat of categories; trackBy: trackBySlug">
          <h3>{{ cat.title }}</h3>
          <p>{{ cat.desc }}</p>
        </a>
      </div>
      <button class="scroll-btn right" *ngIf="canScrollRight" (click)="scrollCategories(1)" [attr.aria-label]="'common.next' | t">&#8250;</button>
    </div>
  `,
  styles: [`
    /* ---- categories --------------------------------------------------- */
    .categories-wrapper { position: relative; padding-inline: 48px; }
    .categories-wrapper::before, .categories-wrapper::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      width: 56px;
      z-index: 1;
      pointer-events: none;
      opacity: 0;
      transition: opacity var(--motion-base);
    }
    .categories-wrapper::before { left: 48px; background: linear-gradient(to right, var(--paper) 0%, transparent 100%); }
    .categories-wrapper::after { right: 48px; background: linear-gradient(to left, var(--paper) 0%, transparent 100%); }
    .categories-wrapper.has-left::before { opacity: 1; }
    .categories-wrapper.has-right::after { opacity: 1; }
    .scroll-btn {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      width: var(--tap-min);
      height: var(--tap-min);
      background-color: var(--surface-raised);
      border: 1px solid var(--surface-raised-border);
      border-radius: 50%;
      font-size: var(--text-2xl);
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 2;
      color: var(--ink);
      box-shadow: var(--shadow-card);
      transition: background-color var(--motion-base), color var(--motion-base), border-color var(--motion-base);
    }
    .scroll-btn:hover, .tag-btn:hover { color: var(--accent); border-color: var(--accent); }
    .scroll-btn:hover { background-color: var(--paper-warm); }
    .scroll-btn.left { left: 0; }
    .scroll-btn.right { right: 0; }
    .categories-grid {
      display: flex;
      overflow-x: auto;
      gap: var(--space-4);
      scrollbar-width: none;
      -ms-overflow-style: none;
      -webkit-overflow-scrolling: touch;
    }
    .categories-grid::-webkit-scrollbar { display: none; }
    .category-card {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-xs);
      background-color: var(--surface-card);
      padding: var(--space-5);
      text-decoration: none;
      color: var(--ink);
      transition: background-color var(--motion-base), border-color var(--motion-base), box-shadow var(--motion-base);
      flex: 0 0 240px;
    }
    .category-card:hover {
      background-color: var(--paper-warm);
      border-color: var(--accent);
      box-shadow: var(--shadow-card);
    }
    .category-card:focus-visible {
      border-color: var(--accent);
    }
    .category-card h3 { margin: 0 0 var(--space-2); font-size: var(--text-lg); }
    .category-card p { margin: 0; color: var(--muted); font-size: var(--text-sm); line-height: 1.5; }

    @media (max-width: 768px) {
      .categories-wrapper { padding-inline: 0; }
      .categories-wrapper::before { left: 0; }
      .categories-wrapper::after { right: 0; }
      .scroll-btn { display: none; }
    }
    @media (max-width: 420px) {
      .category-card { flex: 0 0 calc(100% - 32px); }
    }
  `]
})
export class UiCategoryRail {
  @Input() categories: any[] = [];
  @ViewChild('categoriesGrid') categoriesGrid?: ElementRef<HTMLDivElement>;
  
  canScrollLeft = false;
  canScrollRight = false;

  constructor(private cdr: ChangeDetectorRef) {}

  ngOnChanges() {
    setTimeout(() => this.checkScroll(), 0);
  }

  @HostListener('window:resize')
  onResize() { this.checkScroll(); }

  checkScroll() {
    if (!this.categoriesGrid) return;
    const el = this.categoriesGrid.nativeElement;
    this.canScrollLeft = el.scrollLeft > 0;
    this.canScrollRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    this.cdr.detectChanges();
  }

  scrollCategories(direction: number) {
    if (!this.categoriesGrid) return;
    const el = this.categoriesGrid.nativeElement;
    el.scrollBy({ left: el.clientWidth * 0.8 * direction, behavior: scrollBehavior() });
  }

  trackBySlug(idx: number, cat: any): string { return cat.slug; }
}
