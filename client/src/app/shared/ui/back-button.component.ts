import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { TPipe } from '../../core/i18n.service';
import { NavigationHistoryService } from '../../core/services/navigation-history.service';
import { RegionLinkService } from '../../core/region-link.service';

@Component({
  selector: 'ui-back-button',
  standalone: true,
  imports: [CommonModule, TPipe],
  template: `
    <button *ngIf="navHistory.canGoBack" type="button" class="go-back-btn" (click)="goBack()">
      ← {{ 'common.back' | t }}
    </button>
    <!-- Arriving straight from a shared link, a search engine or a social post
         leaves no in-app history to go back to, and the control used to vanish
         entirely — the page became a dead end. Degrade to search instead of
         disappearing. -->
    <button *ngIf="!navHistory.canGoBack" type="button" class="go-back-btn" (click)="goToSearch()">
      ← {{ 'common.backToSearch' | t }}
    </button>
  `,
  styles: [`
    /* Phones show the layout's app bar (back + page title) on the pages that
       use this back link, so it would only repeat it. Same breakpoint as the
       app bar in layout.component.css. */
    @media (max-width: 900px) {
      :host { display: none; }
    }
    .go-back-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: none;
      border: none;
      color: var(--muted);
      font-size: var(--text-base);
      font-weight: 500;
      cursor: pointer;
      padding: 6px 12px;
      margin-bottom: 16px;
      border-radius: 6px;
      transition: color var(--motion-fast) ease, background-color var(--motion-fast) ease;
    }
    .go-back-btn:hover {
      color: var(--ink);
      background-color: var(--paper-warm, rgba(0, 0, 0, 0.04));
    }
  `]
})
export class UiBackButton {
  readonly navHistory = inject(NavigationHistoryService);
  private router = inject(Router);
  private regionLink = inject(RegionLinkService);

  goBack() {
    this.navHistory.goBack();
  }

  goToSearch() {
    this.router.navigate(this.regionLink.path(['/search']));
  }
}
