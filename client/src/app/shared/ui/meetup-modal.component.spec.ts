import { TestBed } from '@angular/core/testing';
import { MeetupModalComponent } from './meetup-modal.component';

describe('MeetupModalComponent', () => {
  let component: MeetupModalComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MeetupModalComponent] });
    component = TestBed.createComponent(MeetupModalComponent).componentInstance;
  });

  it('is empty until any of date, time or place is entered', () => {
    expect(component.isEmpty).toBe(true);

    component.location = '   ';
    expect(component.isEmpty).toBe(true);

    component.location = 'Library';
    expect(component.isEmpty).toBe(false);

    component.location = '';
    component.meetupTime = '15:00';
    expect(component.isEmpty).toBe(false);

    component.meetupTime = '';
    component.selectedDay = 12;
    expect(component.isEmpty).toBe(false);
  });

  it('skipping confirms with no time or place', () => {
    let emitted: unknown;
    component.onConfirmed.subscribe(v => (emitted = v));
    component.onConfirm();
    expect(emitted).toEqual({ time: '', location: '' });
  });

  it('starts an edit from the agreed details', () => {
    component.initial = { time: new Date(2030, 0, 2, 18, 30).toISOString(), location: 'Library' };
    component.ngOnInit();
    expect(component.location).toBe('Library');
    expect(component.meetupTime).toBe('18:30');
    expect(component.selectedDate).toBe('2030-01-02');

    let emitted: unknown;
    component.onConfirmed.subscribe(v => (emitted = v));
    component.onConfirm();
    expect(emitted).toEqual({ time: '2030-01-02T18:30', location: 'Library' });
  });

  it('uses the local date for today, not UTC', () => {
    vi.useFakeTimers();
    // 01:00 on 5 March local time; in UTC+8 that is still 4 March in UTC.
    vi.setSystemTime(new Date(2031, 2, 5, 1, 0));
    expect(component.todayStr()).toBe('2031-03-05');
    vi.useRealTimers();
  });

  it('a past day cannot be picked, and a past date is an error even without a time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2031, 2, 15, 10, 0));
    component.ngOnInit();
    expect(component.isPastDay(14)).toBe(true);
    expect(component.isPastDay(15)).toBe(false);

    component.selectDay(14);
    expect(component.selectedDay).toBeNull();

    // A past date typed into the native input.
    component.selectedDate = '2031-03-10';
    component.onNativeDateChange();
    expect(component.timeError).toBe('invalid');

    let emitted = false;
    component.onConfirmed.subscribe(() => (emitted = true));
    component.onConfirm();
    expect(emitted).toBe(false);
    vi.useRealTimers();
  });

  it('cannot be closed while the accept is on its way', () => {
    let closed = 0;
    component.onClosed.subscribe(() => closed++);
    component.isSubmitting = true;
    component.close();
    expect(closed).toBe(0);
    component.isSubmitting = false;
    component.close();
    expect(closed).toBe(1);
  });
});
