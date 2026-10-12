import { UiMeetupCard } from './meetup-card.component';

describe('UiMeetupCard cardType', () => {
  let component: UiMeetupCard;

  beforeEach(() => {
    component = new UiMeetupCard();
  });

  it('maps [SYSTEM:order.notify.cancelled_by_seller] to CANCEL', () => {
    component.body = '[SYSTEM:order.notify.cancelled_by_seller]';
    expect(component.cardType).toBe('CANCEL');
    expect(component.typeClass).toBe('card-cancel');
    expect(component.showActions).toBe(false);
  });

  it('maps [SYSTEM:order.notify.cancelled_by_buyer] to CANCEL', () => {
    component.body = '[SYSTEM:order.notify.cancelled_by_buyer]';
    expect(component.cardType).toBe('CANCEL');
  });

  it('maps [SYSTEM:order.notify.delivered] to COMPLETE', () => {
    component.body = '[SYSTEM:order.notify.delivered]';
    expect(component.cardType).toBe('COMPLETE');
    expect(component.typeClass).toBe('card-complete');
    expect(component.icon).toBe('📦');
    expect(component.headerTitleKey).toBe('msg.meetupCompleteTitle');
    expect(component.bodyTextKey).toBe('msg.meetupCompleteBody');
    expect(component.statusBadgeKey).toBe('msg.statusCompleted');
    expect(component.showActions).toBe(false);
  });

  it('falls back to REQUEST styling for unrecognized message bodies', () => {
    component.body = '[SYSTEM:order.notify.unknown_key]';
    expect(component.cardType).toBe('NONE');
    expect(component.typeClass).toBe('card-request');
  });

  it('maps [SYSTEM:order.notify.meetup_updated] to UPDATE', () => {
    component.body = '[SYSTEM:order.notify.meetup_updated] System Notification';
    expect(component.cardType).toBe('UPDATE');
    expect(component.headerTitleKey).toBe('msg.meetupUpdateTitle');
    expect(component.showActions).toBe(false);
  });

  it('introduces the details on an accept card that shows them', () => {
    component.body = '[SYSTEM:order.notify.seller_approved]';
    expect(component.bodyTextKey).toBe('msg.meetupAcceptBody');
    component.showDetails = true;
    expect(component.bodyTextKey).toBe('msg.meetupAcceptBodyDetails');
  });
});
