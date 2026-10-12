import { MeetupDetailsService } from './meetup-details.service';

describe('MeetupDetailsService', () => {
  let service: MeetupDetailsService;

  beforeEach(() => {
    service = new MeetupDetailsService();
  });

  it('resolves with what the seller entered', async () => {
    const answer = service.ask('Calculus');
    const request = service.current()!;
    expect(request.bookTitle).toBe('Calculus');

    service.settle(request.id, { time: '2026-10-01 15:00', location: 'Library' });

    await expect(answer).resolves.toEqual({ time: '2026-10-01 15:00', location: 'Library' });
    expect(service.current()).toBeNull();
  });

  it('resolves null when the form is closed', async () => {
    const answer = service.ask('Calculus');
    service.settle(service.current()!.id, null);
    await expect(answer).resolves.toBeNull();
  });

  it('answers an open form as closed when a second one is asked for', async () => {
    const first = service.ask('Calculus');
    const second = service.ask('Physics');
    await expect(first).resolves.toBeNull();
    expect(service.current()!.bookTitle).toBe('Physics');
    service.settle(service.current()!.id, { time: 't', location: 'l' });
    await expect(second).resolves.toEqual({ time: 't', location: 'l' });
  });

  it('ignores a settle for a request that is no longer on screen', async () => {
    const first = service.ask('Calculus');
    const staleId = service.current()!.id;
    service.ask('Physics');
    await first;
    service.settle(staleId, { time: 't', location: 'l' });
    expect(service.current()!.bookTitle).toBe('Physics');
  });
});
