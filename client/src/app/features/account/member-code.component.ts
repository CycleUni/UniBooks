import {
  Component,
  OnInit,
  OnDestroy,
  Input,
  Output,
  EventEmitter,
  HostListener,
  inject,
  ChangeDetectorRef,
  ElementRef,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { AccountService } from '../../core/services/account.service';
import { I18nService, TPipe } from '../../core/i18n.service';
import { AuthStore } from '../../core/auth.store';
import { ToastService } from '../../core/services/toast.service';
import { UiButton } from '../../shared/ui/button.component';
import QRCode from 'qrcode';

@Component({
  selector: 'app-member-code',
  standalone: true,
  imports: [CommonModule, TPipe, UiButton],
  template: `
    <div class="app-modal-overlay" (click)="onClose()">
      <div class="app-modal member-pass-modal" (click)="$event.stopPropagation()">
        <div class="member-pass-header">
          <h3 class="member-pass-title">{{ 'acct.memberCodeTitle' | t }}</h3>
          <button
            type="button"
            class="modal-close-btn"
            (click)="onClose()"
            [attr.aria-label]="'msg.close' | t"
          >&times;</button>
        </div>

        <div class="member-pass-body">
          <div class="member-info-strip">
            <div class="member-avatar-initial" *ngIf="!avatarUrl">{{ avatarInitial || 'U' }}</div>
            <img *ngIf="avatarUrl" [src]="avatarUrl" alt="" class="member-avatar-img" referrerpolicy="no-referrer">
            <div class="member-info-text">
              <div class="member-name">{{ displayName || ('acct.defaultUser' | t) }}</div>
              <div class="member-school">{{ schoolName || ('acct.noSchool' | t) }}</div>
            </div>
          </div>

          <div class="qr-canvas-container" [class.paused]="isPaused">
            <canvas #qrCanvas [style.opacity]="isPaused ? '0.15' : '1'"></canvas>

            <div *ngIf="isPaused" class="qr-paused-overlay">
              <div class="qr-paused-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="10" y1="15" x2="10" y2="9"></line>
                  <line x1="14" y1="15" x2="14" y2="9"></line>
                </svg>
              </div>
              <p class="qr-paused-text">{{ 'acct.memberCodePausedText' | t }}</p>
              <ui-button variant="primary" size="sm" (onClick)="onManualRefresh()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; vertical-align: -1px;" aria-hidden="true">
                  <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/>
                </svg>
                {{ 'acct.memberCodeRefreshBtn' | t }}
              </ui-button>
            </div>

            <div *ngIf="isLoading" class="qr-loading-overlay">
              <span>{{ 'common.loading' | t }}</span>
            </div>
          </div>

          <div class="member-id" *ngIf="memberId">
            <span class="member-id-value">{{ memberId }}</span>
            <button
              type="button"
              class="member-id-copy"
              (click)="copyMemberId()"
              [title]="'acct.memberIdCopy' | t"
              [attr.aria-label]="'acct.memberIdCopy' | t"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          </div>

          <div class="qr-footer" *ngIf="!isPaused">
            <div class="qr-timer-bar-bg">
              <div class="qr-timer-bar-fill" [style.width.%]="(secondsRemaining / stepSeconds) * 100"></div>
            </div>

            <div class="qr-meta">
              <span class="qr-countdown">
                {{ 'acct.memberCodeCountdown' | t:{s: secondsRemaining} }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .member-pass-modal {
      width: 90%;
      max-width: 360px;
      border-radius: var(--radius-card, 12px);
      background: var(--surface-raised, #FFFFFF);
      box-shadow: var(--shadow-card-lg);
      border: 1px solid var(--surface-raised-border, var(--line));
      overflow: hidden;
      animation: modalFadeIn 0.15s ease-out;
    }

    @keyframes modalFadeIn {
      from { opacity: 0; transform: scale(0.96); }
      to { opacity: 1; transform: scale(1); }
    }

    .member-pass-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-4) var(--space-5);
      border-bottom: 1px solid var(--line);
    }


    .member-pass-title {
      margin: 0;
      font-size: var(--text-lg);
      font-weight: 700;
      color: var(--ink);
      font-family: 'Fraunces', 'Noto Serif TC', serif;
    }


    .modal-close-btn {
      background: none;
      border: none;
      font-size: 24px;
      line-height: 1;
      color: var(--muted);
      cursor: pointer;
      padding: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-control);
      transition: color var(--motion-fast) ease;
    }

    .modal-close-btn:hover {
      color: var(--ink);
    }

    .member-pass-body {
      padding: var(--space-5);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-4);
    }

    .member-info-strip {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      width: 100%;
      background: var(--paper-warm);
      padding: var(--space-3);
      border-radius: var(--radius-control);
      border: 1px solid var(--line);
    }

    .member-avatar-initial {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: var(--btn-primary-bg);
      color: var(--btn-primary-ink);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: var(--text-md);
      flex-shrink: 0;
    }

    .member-avatar-img {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
    }

    .member-info-text {
      flex: 1;
      min-width: 0;
    }

    .member-name {
      font-size: var(--text-base);
      font-weight: 700;
      color: var(--ink);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .member-school {
      font-size: var(--text-xs);
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 2px;
    }

    .qr-canvas-container {
      position: relative;
      background: #FFFFFF;
      padding: var(--space-3);
      border-radius: var(--radius-control);
      border: 1px solid var(--line);
      box-shadow: var(--shadow-card);
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 214px;
      min-height: 214px;
      overflow: hidden;
    }

    /* The QR's white backing must not show past the overlay's edges. */
    .qr-canvas-container.paused {
      background: var(--paper-warm);
    }

    .qr-paused-overlay {
      position: absolute;
      inset: 0;
      background-color: color-mix(in srgb, var(--paper-warm) 94%, transparent);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-3);
      padding: var(--space-4);
      text-align: center;
      z-index: 10;
      animation: modalFadeIn 0.2s ease-out;
    }

    .qr-paused-icon {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: var(--warn-bg);
      color: var(--warn-ink);
      border: 1px solid color-mix(in srgb, var(--warn-ink) 25%, transparent);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .qr-paused-text {
      font-size: var(--text-base);
      color: var(--ink);
      font-weight: 600;
      margin: 0;
      line-height: 1.3;
    }

    .qr-loading-overlay {
      position: absolute;
      inset: 0;
      background-color: color-mix(in srgb, var(--paper-warm) 88%, transparent);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: var(--text-sm);
      color: var(--muted);
      font-weight: 500;
      border-radius: var(--radius-control);
    }

    .member-id {
      display: flex;
      align-items: center;
      justify-content: center;
      max-width: 100%;
      /* The copy button's 44px tap area should not push the QR and timer apart. */
      margin: calc(var(--space-2) * -1) 0;
    }

    .member-id-value {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: var(--text-xs);
      color: var(--muted);
      word-break: break-all;
      user-select: all;
    }

    .member-id-copy {
      flex-shrink: 0;
      width: var(--tap-min);
      height: var(--tap-min);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      background: none;
      border: none;
      color: var(--muted);
      cursor: pointer;
      border-radius: var(--radius-control);
      transition: color var(--motion-fast) ease;
    }

    .member-id-copy:hover {
      color: var(--ink);
    }

    .qr-footer {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .qr-timer-bar-bg {
      width: 100%;
      height: 4px;
      background: var(--paper-warm);
      border-radius: 2px;
      overflow: hidden;
    }

    .qr-timer-bar-fill {
      height: 100%;
      background: var(--accent);
      transition: width 0.5s linear;
    }

    .qr-meta {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
    }


    .qr-countdown {
      font-size: var(--text-xs);
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      font-weight: 500;
    }
  `],
})
export class MemberCodeComponent implements OnInit, OnDestroy {
  @Input() displayName = '';
  @Input() schoolName = '';
  @Input() avatarUrl = '';
  @Input() avatarInitial = '';

  @Output() close = new EventEmitter<void>();

  @ViewChild('qrCanvas') qrCanvasRef!: ElementRef<HTMLCanvasElement>;

  private accountService = inject(AccountService);
  private cdr = inject(ChangeDetectorRef);
  private auth = inject(AuthStore);
  private toast = inject(ToastService);
  private i18n = inject(I18nService);

  /** The account id: the same one /seller/:id shows and the QR code carries. */
  get memberId(): string {
    const id = this.auth.user()?.id;
    return id == null ? '' : String(id);
  }

  token = '';
  secondsRemaining = 30;
  refreshCount = 1;
  readonly maxRefreshes = 5;
  isPaused = false;
  isLoading = false;

  stepSeconds = 30;
  /** When the shown code's step ends, on this device's clock. Counted from the
   *  server's expires_in_ms, so a device whose clock is off still renews on time. */
  private deadline = 0;
  private timerInterval: ReturnType<typeof setInterval> | null = null;

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.onClose();
  }

  ngOnInit(): void {
    this.fetchTokenAndStart();
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  onClose(): void {
    this.clearTimer();
    this.close.emit();
  }

  fetchTokenAndStart(): void {
    this.clearTimer();
    this.isLoading = true;
    this.cdr.markForCheck();

    this.accountService.getMemberToken().subscribe({
      next: (res) => {
        this.token = res.token;
        this.stepSeconds = res.step_seconds;
        this.deadline = Date.now() + res.expires_in_ms;
        this.updateRemainingSeconds();
        this.isLoading = false;
        this.renderQrCode();
        this.startTimer();
        this.cdr.markForCheck();
      },
      error: () => {
        // Paused shows the refresh button, so a failed fetch can be retried.
        this.isLoading = false;
        this.isPaused = true;
        this.cdr.markForCheck();
      },
    });
  }

  private updateRemainingSeconds(): void {
    const ms = this.deadline - Date.now();
    this.secondsRemaining = Math.max(1, Math.min(this.stepSeconds, Math.ceil(ms / 1000)));
  }

  private startTimer(): void {
    this.clearTimer();
    this.timerInterval = setInterval(() => {
      if (Date.now() >= this.deadline) {
        if (this.refreshCount < this.maxRefreshes) {
          this.refreshCount++;
          this.fetchTokenAndStart();
        } else {
          this.isPaused = true;
          this.clearTimer();
          this.cdr.markForCheck();
        }
      } else {
        this.updateRemainingSeconds();
        this.cdr.markForCheck();
      }
    }, 500);
  }

  private clearTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  async copyMemberId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.memberId);
      this.toast.success(this.i18n.t('acct.memberIdCopied'));
    } catch {
      // Clipboard access can be refused (permissions, insecure context).
      this.toast.info(this.memberId);
    }
  }

  onManualRefresh(): void {
    if (this.isLoading) return;
    this.clearTimer();
    this.isPaused = false;
    this.refreshCount = 1;
    this.fetchTokenAndStart();
  }

  private renderQrCode(): void {
    setTimeout(() => {
      if (this.qrCanvasRef?.nativeElement && this.token) {
        QRCode.toCanvas(
          this.qrCanvasRef.nativeElement,
          this.token,
          {
            width: 190,
            margin: 1,
            color: {
              dark: '#1F2933',
              light: '#FFFFFF',
            },
          },
          (err) => {
            if (err) console.error('Error generating QR canvas', err);
          },
        );
      }
    }, 0);
  }
}
