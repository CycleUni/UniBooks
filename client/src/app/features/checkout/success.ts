import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { UiButton } from '../../shared/ui/button.component';
import { TPipe } from '../../core/i18n.service';

@Component({
  selector: 'app-checkout-success',
  standalone: true,
  imports: [CommonModule, RouterModule, UiButton, TPipe],
  template: `
      <main class="success-page">
        <div class="success-box">
          <div class="icon">
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="32" cy="32" r="30" stroke="var(--success)" stroke-width="4"/>
              <path d="M20 32 L28 40 L44 24" stroke="var(--success)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
            </svg>
          </div>
          <h2>{{ 'checkout.successTitle' | t }}</h2>
          <p>{{ 'checkout.successDesc' | t }}</p>
          <div class="actions">
            <ui-button [link]="['/account/orders']">{{ 'checkout.viewOrders' | t }}</ui-button>
            <ui-button variant="ghost" [link]="['/']">{{ 'checkout.backHome' | t }}</ui-button>
          </div>
        </div>
      </main>
  `,
  styles: [`
    /* Not .container: a full-height centring wrapper, not a content column. */
    .success-page {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 60vh;
      padding-inline: var(--space-4);
    }
    .success-box {
      background: var(--surface-card);
      padding: 48px;
      border: 1px solid var(--line);
      border-radius: 8px;
      text-align: center;
      max-width: 500px;
    }
    .icon {
      margin-bottom: 24px;
    }
    h2 {
      margin: 0 0 16px;
    }
    p {
      color: var(--muted);
      margin-bottom: 32px;
    }
    .actions {
      display: flex;
      gap: 16px;
      justify-content: center;
    }
  `]
})
export class OrderSuccessComponent {}
