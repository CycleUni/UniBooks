import { describe, it, expect } from 'vitest';
import { isEventPath } from './event-path';

describe('isEventPath', () => {
  it('accepts the event site and paths under it', () => {
    expect(isEventPath('/event')).toBe(true);
    expect(isEventPath('/event/admin')).toBe(true);
    expect(isEventPath('/event?x=1')).toBe(true);
    expect(isEventPath('/event#top')).toBe(true);
  });

  it('refuses paths a browser would read as another origin', () => {
    for (const url of ['//evil.example/event', '/\\evil.example', 'javascript:alert(1)']) {
      expect(isEventPath(url)).toBe(false);
    }
  });

  it('refuses app paths that only start with the same letters', () => {
    expect(isEventPath('/events')).toBe(false);
    expect(isEventPath('/tw/event')).toBe(false);
  });
});
