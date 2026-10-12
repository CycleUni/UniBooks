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
});

