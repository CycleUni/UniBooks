import { Component, EventEmitter, Input, Output, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TPipe } from '../../core/i18n.service';
import { UiButton } from './button.component';
import { UiInput } from './input.component';
import { UiFocusTrapDirective } from './focus-trap.directive';

@Component({
  selector: 'app-meetup-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, TPipe, UiButton, UiInput, UiFocusTrapDirective],
  template: `
    <div class="app-modal-overlay" (click)="close()">
      <div class="app-modal w-full"  style="max-width: 420px;" (click)="$event.stopPropagation()" uiFocusTrap="meetup-modal-title" (escape)="close()">
        <h3 id="meetup-modal-title" class="app-modal-title">{{ 'order.meetupModalTitle' | t }}</h3>

        <div class="app-modal-body">
          <p *ngIf="bookTitle" class="book-info">{{ bookTitle }}</p>

          <div class="field-group">
            <label>{{ 'order.meetupDateLabel' | t }}</label>

            <!-- Desktop calendar -->
            <div class="desktop-calendar">
              <div class="calendar-nav">
                <button class="nav-btn" (click)="prevMonth()" [disabled]="isCurrentMonth()">&lsaquo;</button>
                <span class="month-label">{{ monthLabel() }}</span>
                <button class="nav-btn" (click)="nextMonth()">&rsaquo;</button>
              </div>
              <div class="calendar-grid">
                <div class="day-header" *ngFor="let d of weekDays">{{ d }}</div>
                <ng-container *ngFor="let week of calendarWeeks()">
                  <div
                    *ngFor="let day of week"
                    class="day-cell"
                    [class.empty]="day === null"
                    [class.today]="day !== null && isToday(day)"
                    [class.selected]="day !== null && isSelectedDay(day)"
                    (click)="day !== null && selectDay(day)">
                    {{ day !== null ? day : '' }}
                  </div>
                </ng-container>
              </div>
            </div>

            <!-- Mobile date input -->
            <div class="mobile-date">
              <input type="date" [(ngModel)]="selectedDate" (change)="onNativeDateChange()"
                     [min]="todayStr()" class="native-date-input" />
            </div>
          </div>

          <div class="form-group">
            <ui-input [label]="'order.meetupTimeLabel' | t"
                       type="time"
                       [(ngModel)]="meetupTime"
                       (ngModelChange)="onTimeChange()">
            </ui-input>
            <div class="error-msg" *ngIf="timeError">{{ 'order.meetupTimeError' | t }}</div>
          </div>

          <div class="form-group">
            <ui-input [label]="'order.meetupLocationLabel' | t"
                       [(ngModel)]="location"
                       [placeholder]="'order.meetupLocationPlaceholder' | t">
            </ui-input>
          </div>

          <div *ngIf="errorMsg" class="error-msg submit-error">{{ errorMsg }}</div>
        </div>

        <div class="app-modal-actions">
          <ui-button variant="ghost" (onClick)="close()" [disabled]="isSubmitting">
            {{ 'common.cancel' | t }}
          </ui-button>
          <ui-button (onClick)="onConfirm()" [disabled]="isSubmitting">
            {{ (isEmpty && !initial ? 'order.meetupSkip' : 'order.meetupConfirm') | t }}
          </ui-button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    h3 {
      margin-bottom: 12px;
    }
    .book-info {
      color: var(--muted);
      font-size: var(--text-sm);
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--line);
    }
    .form-group {
      margin-bottom: 16px;
    }
    .field-group {
      margin-bottom: 16px;
    }
    .field-group label {
      font-size: var(--text-base);
      font-weight: 500;
      color: var(--ink);
      display: block;
      margin-bottom: 8px;
    }

    /* Calendar */
    .calendar-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .nav-btn {
      background: none;
      border: 1px solid var(--line);
      border-radius: 4px;
      width: 28px;
      height: 28px;
      font-size: var(--text-md);
      cursor: pointer;
      color: var(--ink);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .nav-btn:hover:not(:disabled) {
      background: var(--paper-warm);
    }
    .nav-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }
    .month-label {
      font-size: var(--text-base);
      font-weight: 500;
      color: var(--ink);
    }
    .calendar-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 2px;
      text-align: center;
    }
    .day-header {
      font-size: var(--text-xs);
      font-weight: 500;
      color: var(--muted);
      padding: 4px 0;
    }
    .day-cell {
      padding: 6px 0;
      font-size: var(--text-sm);
      border-radius: 4px;
      cursor: pointer;
      color: var(--ink);
      transition: background-color var(--motion-fast);
    }
    .day-cell:hover {
      background: var(--paper-warm);
    }
    .day-cell.empty {
      cursor: default;
    }
    .day-cell.today {
      outline: 1.5px solid var(--accent);
      font-weight: 600;
    }
    .day-cell.selected {
      background: var(--accent);
      color: var(--paper);
      font-weight: 600;
    }

    /* Mobile date input - hidden on desktop */
    .mobile-date {
      display: none;
    }
    .native-date-input {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 12px;
      border: 1px solid var(--line);
      border-radius: 4px;
      font-size: var(--text-base);
      font-family: inherit;
      color: var(--ink);
      background: var(--paper);
    }
    /* No outline reset: the global :focus-visible ring is the indicator;
       the border colour change is only a secondary cue. */
    .native-date-input:focus-visible {
      border-color: var(--accent);
    }

    @media (pointer: coarse) {
      .desktop-calendar {
        display: none;
      }
      .mobile-date {
        display: block;
      }
    }

    .error-msg {
      color: var(--flag);
      font-size: var(--text-xs);
      margin-top: 4px;
    }
    .submit-error {
      margin-bottom: 16px;
      font-size: var(--text-sm);
    }

  `]
})
export class MeetupModalComponent implements OnInit {
  @Input() bookTitle: string = '';
  /** Details already agreed, when the seller is editing them. */
  @Input() initial: { time: string; location: string } | null = null;
  @Output() onConfirmed = new EventEmitter<{ time: string; location: string }>();
  @Output() onClosed = new EventEmitter<void>();

  // Native date input (mobile) - bound to string
  selectedDate: string = '';

  // Custom calendar state (desktop)
  currentMonth: Date = new Date();
  selectedDay: number | null = null;
  selectedMonth: number = new Date().getMonth();
  selectedYear: number = new Date().getFullYear();

  meetupTime: string = '';
  location: string = '';
  timeError: string = '';
  errorMsg: string = '';
  isSubmitting: boolean = false;

  weekDays: string[] = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  ngOnInit(): void {
    this.currentMonth = new Date();
    if (this.initial) this.prefill(this.initial);
  }

  /** Starts the form from the agreed details (an ISO time, read locally). */
  private prefill(initial: { time: string; location: string }): void {
    this.location = initial.location || '';
    const at = initial.time ? new Date(initial.time) : null;
    if (!at || isNaN(at.getTime())) return;
    this.selectedDay = at.getDate();
    this.selectedMonth = at.getMonth();
    this.selectedYear = at.getFullYear();
    this.currentMonth = new Date(this.selectedYear, this.selectedMonth, 1);
    this.syncNativeDate();
    this.meetupTime = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  }

  get today(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  todayStr(): string {
    const d = new Date();
    return d.toISOString().split('T')[0];
  }

  // --- Calendar helpers ---

  calendarWeeks(): (number | null)[][] {
    const year = this.currentMonth.getFullYear();
    const month = this.currentMonth.getMonth();

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();

    // Day of week: 0=Sun, 1=Mon ... adjust to Monday-start
    let startDay = firstDay.getDay() - 1;
    if (startDay < 0) startDay = 6;

    const weeks: (number | null)[][] = [];
    let currentWeek: (number | null)[] = [];

    // Leading blanks
    for (let i = 0; i < startDay; i++) {
      currentWeek.push(null);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      currentWeek.push(day);
      if (currentWeek.length === 7) {
        weeks.push([...currentWeek]);
        currentWeek = [];
      }
    }

    // Trailing blanks
    if (currentWeek.length > 0) {
      while (currentWeek.length < 7) {
        currentWeek.push(null);
      }
      weeks.push(currentWeek);
    }

    return weeks;
  }

  monthLabel(): string {
    const d = this.currentMonth;
    return d.getFullYear() + ' / ' + (d.getMonth() + 1);
  }

  prevMonth(): void {
    if (this.isCurrentMonth()) return;
    this.currentMonth = new Date(this.currentMonth.getFullYear(), this.currentMonth.getMonth() - 1, 1);
  }

  nextMonth(): void {
    this.currentMonth = new Date(this.currentMonth.getFullYear(), this.currentMonth.getMonth() + 1, 1);
  }

  isCurrentMonth(): boolean {
    const now = new Date();
    return (
      this.currentMonth.getFullYear() === now.getFullYear() &&
      this.currentMonth.getMonth() === now.getMonth()
    );
  }

  isToday(day: number): boolean {
    const today = new Date();
    return (
      day === today.getDate() &&
      this.currentMonth.getMonth() === today.getMonth() &&
      this.currentMonth.getFullYear() === today.getFullYear()
    );
  }

  isSelectedDay(day: number): boolean {
    return (
      this.selectedDay === day &&
      this.currentMonth.getMonth() === this.selectedMonth &&
      this.currentMonth.getFullYear() === this.selectedYear
    );
  }

  selectDay(day: number): void {
    this.selectedDay = day;
    this.selectedMonth = this.currentMonth.getMonth();
    this.selectedYear = this.currentMonth.getFullYear();
    this.syncNativeDate();
    this.validateTime();
  }

  syncNativeDate(): void {
    if (this.selectedDay !== null) {
      const m = String(this.selectedMonth + 1).padStart(2, '0');
      const d = String(this.selectedDay).padStart(2, '0');
      this.selectedDate = `${this.selectedYear}-${m}-${d}`;
    }
  }

  onNativeDateChange(): void {
    if (this.selectedDate) {
      const parts = this.selectedDate.split('-');
      const y = parseInt(parts[0]);
      const m = parseInt(parts[1]) - 1;
      const d = parseInt(parts[2]);
      this.selectedDay = d;
      this.selectedMonth = m;
      this.selectedYear = y;
      this.currentMonth = new Date(y, m, 1);
    }
    this.validateTime();
  }

  onTimeChange(): void {
    this.validateTime();
  }

  // --- Validation ---

  getSelectedDate(): Date | null {
    if (this.selectedDay === null) return null;
    const d = new Date(this.selectedYear, this.selectedMonth, this.selectedDay);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  validateTime(): void {
    const selDate = this.getSelectedDate();
    if (!selDate) { this.timeError = ''; return; }
    if (!this.meetupTime) { this.timeError = ''; return; }

    const [h, m] = this.meetupTime.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) { this.timeError = ''; return; }

    const dt = new Date(selDate);
    dt.setHours(h, m, 0, 0);

    if (dt <= new Date()) {
      this.timeError = 'invalid';
    } else {
      this.timeError = '';
    }
  }

  /** Nothing entered: the button then reads "Skip", since pressing it accepts
   *  the meetup without a time or place rather than confirming any. */
  get isEmpty(): boolean {
    return this.selectedDay === null && !this.selectedDate && !this.meetupTime && !(this.location || '').trim();
  }

  // --- Actions ---

  close(): void {
    this.onClosed.emit();
  }

  onConfirm(): void {
    // Validate
    if (this.timeError) {
      return;
    }

    this.errorMsg = '';

    let timeString = '';
    if (this.selectedDay !== null) {
      const m = String(this.selectedMonth + 1).padStart(2, '0');
      const d = String(this.selectedDay).padStart(2, '0');
      const datePart = `${this.selectedYear}-${m}-${d}`;
      if (this.meetupTime) {
        timeString = datePart + 'T' + this.meetupTime;
      } else {
        timeString = datePart;
      }
    }

    this.onConfirmed.emit({
      time: timeString,
      location: (this.location || '').trim()
    });
  }
}