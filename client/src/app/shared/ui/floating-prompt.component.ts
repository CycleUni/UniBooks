import {
  Component,
  EventEmitter,
  Injectable,
  Input,
  OnDestroy,
  OnInit,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import { UiButton } from './button.component';

/**
 * The one place a floating prompt may stand. Prompts that want to show at the
 * same time (a first visit to the inbox may want both the language offer and
 * the push offer) would stack on the same corner; instead the most urgent one
 * shows, and the next takes its place once it is answered.
 */
@Injectable({ providedIn: 'root' })
export class FloatingPromptSlot {
  private readonly waiting = signal<{ id: number; priority: number }[]>([]);
  private nextId = 0;

  /** The prompt showing now: the highest priority, the earliest among equals. */
  readonly holder = computed(() => {
    let best: { id: number; priority: number } | null = null;
    for (const entry of this.waiting()) {
      if (!best || entry.priority > best.priority) best = entry;
    }
    return best?.id ?? null;
  });

  claim(priority: number): number {
    const id = ++this.nextId;
    this.waiting.update((list) => [...list, { id, priority }]);
    return id;
  }

  release(id: number) {
    this.waiting.update((list) => list.filter((entry) => entry.id !== id));
  }
}

/**
 * A question floating over the page with two answers: the shared look of the
 * device-language offer (ui-lang-suggestion) and the push offer
 * (ui-push-prompt). Bottom-left, because toasts stack bottom-right
 * (toast-host); on phones full width, clear of the bottom tab bar.
 *
 * The owner decides whether to ask (render this or not) and what the answers
 * do; this only draws the card and keeps it to one at a time (FloatingPromptSlot).
 */
@Component({
  selector: 'ui-floating-prompt',
  standalone: true,
  imports: [UiButton],
  template: `
    @if (shown()) {
      <div
        class="floating-prompt"
        role="region"
        [attr.lang]="lang || null"
        [attr.aria-label]="title"
        [attr.data-testid]="testId || null"
      >
        <span class="floating-prompt-icon" aria-hidden="true">
          @switch (icon) {
            @case ('bell') {
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
                width="18"
                height="18"
              >
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            }
            @default {
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
                width="18"
                height="18"
              >
                <circle cx="12" cy="12" r="9" />
                <path
                  d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"
                />
              </svg>
            }
          }
        </span>
        <div class="floating-prompt-text">
          <p class="floating-prompt-title">{{ title }}</p>
          @if (description) {
            <p class="floating-prompt-desc">{{ description }}</p>
          }
        </div>
        <div class="floating-prompt-actions">
          <ui-button variant="primary" [disabled]="busy" (onClick)="accept.emit()">{{
            acceptLabel
          }}</ui-button>
          <ui-button variant="ghost" [disabled]="busy" (onClick)="dismiss.emit()">{{
            dismissLabel
          }}</ui-button>
        </div>
      </div>
    }
  `,
  styles: [
    `
      /* A rounded card floating over the page, as the hero and footer are,
         rather than a band pushing the page down. */
      .floating-prompt {
        position: fixed;
        left: var(--space-5);
        bottom: var(--space-5);
        z-index: 200;
        width: min(420px, calc(100vw - 2 * var(--space-4)));
        display: flex;
        align-items: flex-start;
        flex-wrap: wrap;
        gap: var(--space-3);
        padding: var(--space-4) var(--space-5);
        box-sizing: border-box;
        background-color: var(--paper-warm);
        border: 1px solid var(--line);
        border-radius: var(--radius-card);
        box-shadow: var(--shadow-card-lg);
        color: var(--ink);
        text-align: left;
      }
      .floating-prompt-icon {
        flex: none;
        display: flex;
        margin-top: 1px;
        color: var(--info-ink);
      }
      .floating-prompt-text {
        flex: 1 1 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .floating-prompt-title {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: 500;
      }
      .floating-prompt-desc {
        margin: 0;
        font-size: var(--text-sm);
        line-height: 1.4;
        color: var(--ink-soft);
      }
      /* The answers get their own row under the question and share it. */
      .floating-prompt-actions {
        display: flex;
        flex: 1 1 100%;
        gap: var(--space-2);
      }
      .floating-prompt-actions ui-button {
        flex: 1 1 0;
        min-width: 0;
      }
      /* Phones: full width inside the page gutter, clear of the bottom tab
         bar (56px plus the home-indicator inset, as the toasts do). */
      @media (max-width: 900px) {
        .floating-prompt {
          left: var(--space-4);
          right: var(--space-4);
          width: auto;
          bottom: calc(var(--space-3) + 56px + env(safe-area-inset-bottom, 0px));
        }
      }
    `,
  ],
})
export class UiFloatingPrompt implements OnInit, OnDestroy {
  private slot = inject(FloatingPromptSlot);
  private readonly id = signal<number | null>(null);

  @Input({ required: true }) title = '';
  @Input() description = '';
  @Input() icon: 'globe' | 'bell' = 'globe';
  /** The language the card is written in, when not the page's. */
  @Input() lang = '';
  @Input() acceptLabel = '';
  @Input() dismissLabel = '';
  /** Both answers wait while the accepted one is still in progress. */
  @Input() busy = false;
  /** Higher shows first when two prompts want the slot at once. */
  @Input() priority = 0;
  @Input() testId = '';

  @Output() accept = new EventEmitter<void>();
  @Output() dismiss = new EventEmitter<void>();

  readonly shown = computed(() => this.id() !== null && this.slot.holder() === this.id());

  ngOnInit() {
    this.id.set(this.slot.claim(this.priority));
  }

  ngOnDestroy() {
    const id = this.id();
    if (id !== null) this.slot.release(id);
  }
}
