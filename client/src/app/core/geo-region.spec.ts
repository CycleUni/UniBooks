import { detectRegion, parseTraceCountry, regionFromTimezone } from './geo-region';

const known = (code: string) => code === 'tw' || code === 'hk';
const never = () => new Promise<never>(() => {});
const TRACE_HK = 'fl=123\nh=unibooks.app\nip=203.0.113.9\nts=1\nvisit_scheme=https\ncolo=HKG\nloc=HK\ntls=TLSv1.3\n';

describe('parseTraceCountry', () => {
  it('reads the loc line', () => {
    expect(parseTraceCountry(TRACE_HK)).toBe('HK');
    expect(parseTraceCountry('loc=tw')).toBe('TW');
  });

  it('is null for anything that is not a trace body', () => {
    expect(parseTraceCountry(null)).toBeNull();
    expect(parseTraceCountry('<!doctype html><html></html>')).toBeNull();
    expect(parseTraceCountry('colo=HKG\nloc=\n')).toBeNull();
    expect(parseTraceCountry('xloc=HK')).toBeNull();
  });
});

describe('detectRegion', () => {
  it('takes the backend answer first', async () => {
    const code = await detectRegion(
      { backend: async () => 'HK', trace: async () => 'loc=TW' }, known, 1000);
    expect(code).toBe('hk');
  });

  it('falls back to the trace when the backend has no answer', async () => {
    const code = await detectRegion(
      { backend: async () => null, trace: async () => TRACE_HK }, known, 1000);
    expect(code).toBe('hk');
  });

  it('falls back to the trace when the backend request fails', async () => {
    const code = await detectRegion(
      { backend: () => Promise.reject(new Error('down')), trace: async () => TRACE_HK }, known, 1000);
    expect(code).toBe('hk');
  });

  it('ignores a trace country that is not a region here', async () => {
    const code = await detectRegion(
      { backend: async () => null, trace: async () => 'loc=US' }, known, 1000);
    expect(code).toBeNull();
  });

  it('trusts the backend for a region the frontend has not loaded yet', async () => {
    // The backend already checked the active regions; the frontend's
    // pre-load fallback only knows tw and hk.
    const code = await detectRegion(
      { backend: async () => 'SG', trace: async () => 'loc=SG' }, known, 1000);
    expect(code).toBe('sg');
  });

  it('rejects a malformed backend answer and falls back to the trace', async () => {
    const code = await detectRegion(
      { backend: async () => '/evil.example' as any, trace: async () => TRACE_HK }, known, 1000);
    expect(code).toBe('hk');
  });

  it('gives up at the deadline', async () => {
    vi.useFakeTimers();
    try {
      const pending = detectRegion({ backend: never, trace: never }, known, 800);
      await vi.advanceTimersByTimeAsync(800);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('regionFromTimezone', () => {
  it('settles the two timezones that name one region', () => {
    expect(regionFromTimezone('Asia/Taipei')).toBe('tw');
    expect(regionFromTimezone('Asia/Hong_Kong')).toBe('hk');
  });

  it('leaves every other timezone to the IP lookup', () => {
    for (const tz of ['Asia/Macau', 'Asia/Shanghai', 'Asia/Tokyo', 'America/Los_Angeles', 'UTC', '', null, undefined]) {
      expect(regionFromTimezone(tz)).toBeNull();
    }
  });
});
