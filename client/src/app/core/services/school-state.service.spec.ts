import { MANUAL_SCHOOL_KEY, SchoolOption, SchoolStateService } from './school-state.service';

/**
 * The selected school is identified by its short code, and a code is only
 * unique inside one region: Taiwan's Hung Kuang and the University of Hong
 * Kong are both "HKU". These fixtures use that pair so any lookup or saved
 * choice that ignores the region shows up as the wrong school.
 */
const TW_SCHOOLS: SchoolOption[] = [
  { id: 1, code: 'NTU', name: 'National Taiwan University', display_name: '國立臺灣大學' },
  { id: 2, code: 'HKU', name: 'Hung Kuang University', display_name: '弘光科技大學' },
];
const HK_SCHOOLS: SchoolOption[] = [
  { id: 9, code: 'HKU', name: 'The University of Hong Kong', display_name: '香港大學' },
];

describe('SchoolStateService', () => {
  let service: SchoolStateService;

  beforeEach(() => {
    sessionStorage.clear();
    service = new SchoolStateService();
    service.setRegion('tw');
  });

  afterEach(() => sessionStorage.clear());

  describe('lookups by code', () => {
    beforeEach(() => service.setSchools(TW_SCHOOLS));

    it('labels a code with the display name, case-insensitively', () => {
      expect(service.getSchoolLabel('HKU')).toBe('弘光科技大學');
      expect(service.getSchoolLabel('ntu')).toBe('國立臺灣大學');
    });

    it('falls back to the raw value for an unknown code', () => {
      expect(service.getSchoolLabel('CUHK')).toBe('CUHK');
    });

    it('finds the id by code, not by name', () => {
      expect(service.getSchoolId('HKU')).toBe(2);
      expect(service.getSchoolId('Hung Kuang University')).toBeNull();
      expect(service.getSchoolId('')).toBeNull();
    });

    it('resolves a code or a pre-code full name to the code', () => {
      expect(service.resolveSchoolCode('ntu')).toBe('NTU');
      expect(service.resolveSchoolCode('National Taiwan University')).toBe('NTU');
      expect(service.resolveSchoolCode('The University of Hong Kong')).toBeNull();
    });
  });

  describe('manual selection', () => {
    it('saves the code under the current region only', () => {
      service.setSchools(TW_SCHOOLS);
      service.setManualSchool('HKU');

      expect(service.currentSchool).toBe('HKU');
      expect(sessionStorage.getItem(`${MANUAL_SCHOOL_KEY}_tw`)).toBe('HKU');
      expect(sessionStorage.getItem(`${MANUAL_SCHOOL_KEY}_hk`)).toBeNull();
    });

    it('does not carry a choice made on /tw over to /hk', () => {
      service.setSchools(TW_SCHOOLS);
      service.setManualSchool('HKU');

      // The region switch reloads the app: a fresh service, the other region.
      const hk = new SchoolStateService();
      hk.setRegion('hk');
      hk.setSchools(HK_SCHOOLS);
      expect(hk.getManualSchool()).toBeNull();

      hk.setManualSchool('HKU');
      // Back on /tw, Taiwan's own choice is still there.
      const tw = new SchoolStateService();
      tw.setRegion('TW');
      tw.setSchools(TW_SCHOOLS);
      expect(tw.getManualSchool()).toBe('HKU');
      expect(sessionStorage.getItem(`${MANUAL_SCHOOL_KEY}_hk`)).toBe('HKU');
    });

    it('keeps a deliberate "all schools" choice', () => {
      service.setSchools(TW_SCHOOLS);
      service.setManualSchool('');
      expect(service.getManualSchool()).toBe('');
    });

    it('returns the stored value unchecked before the school list has loaded', () => {
      sessionStorage.setItem(`${MANUAL_SCHOOL_KEY}_tw`, 'NTU');
      expect(service.getManualSchool()).toBe('NTU');
    });

    it('drops a stored code this region no longer has', () => {
      sessionStorage.setItem(`${MANUAL_SCHOOL_KEY}_tw`, 'GONE');
      service.setSchools(TW_SCHOOLS);
      expect(service.getManualSchool()).toBeNull();
      expect(sessionStorage.getItem(`${MANUAL_SCHOOL_KEY}_tw`)).toBeNull();
    });
  });

  describe('values saved before codes existed', () => {
    it('turns a legacy full name into its code and moves it to the region key', () => {
      sessionStorage.setItem(MANUAL_SCHOOL_KEY, 'National Taiwan University');
      service.setSchools(TW_SCHOOLS);

      expect(service.getManualSchool()).toBe('NTU');
      expect(sessionStorage.getItem(`${MANUAL_SCHOOL_KEY}_tw`)).toBe('NTU');
      expect(sessionStorage.getItem(MANUAL_SCHOOL_KEY)).toBeNull();
    });

    it('clears a legacy name that names no school in this region', () => {
      sessionStorage.setItem(MANUAL_SCHOOL_KEY, 'The University of Hong Kong');
      service.setSchools(TW_SCHOOLS);

      expect(service.getManualSchool()).toBeNull();
      expect(sessionStorage.getItem(MANUAL_SCHOOL_KEY)).toBeNull();
      expect(sessionStorage.getItem(`${MANUAL_SCHOOL_KEY}_tw`)).toBeNull();
    });

    it('prefers the region key over a leftover legacy value', () => {
      sessionStorage.setItem(MANUAL_SCHOOL_KEY, 'National Taiwan University');
      sessionStorage.setItem(`${MANUAL_SCHOOL_KEY}_tw`, 'HKU');
      service.setSchools(TW_SCHOOLS);
      expect(service.getManualSchool()).toBe('HKU');
    });
  });

  it('does not judge a saved code against the previous region\'s list', () => {
    sessionStorage.setItem(`${MANUAL_SCHOOL_KEY}_hk`, 'CUHK');
    service.setSchools(TW_SCHOOLS);
    service.setRegion('hk');

    // Until Hong Kong's list arrives the value is kept, not dropped as
    // unknown for failing to appear among Taiwan's schools.
    expect(service.getManualSchool()).toBe('CUHK');
    expect(sessionStorage.getItem(`${MANUAL_SCHOOL_KEY}_hk`)).toBe('CUHK');
  });

  it('clears every region\'s choice (and the legacy key) on logout', () => {
    sessionStorage.setItem(MANUAL_SCHOOL_KEY, 'National Taiwan University');
    sessionStorage.setItem(`${MANUAL_SCHOOL_KEY}_tw`, 'NTU');
    sessionStorage.setItem(`${MANUAL_SCHOOL_KEY}_hk`, 'HKU');
    sessionStorage.setItem('unrelated', 'kept');

    service.clearManualSchool();

    expect(sessionStorage.getItem(MANUAL_SCHOOL_KEY)).toBeNull();
    expect(sessionStorage.getItem(`${MANUAL_SCHOOL_KEY}_tw`)).toBeNull();
    expect(sessionStorage.getItem(`${MANUAL_SCHOOL_KEY}_hk`)).toBeNull();
    expect(sessionStorage.getItem('unrelated')).toBe('kept');
  });
  describe('hasManualPick', () => {
    it('is false with nothing picked, or only "all schools"', () => {
      expect(service.hasManualPick()).toBe(false);
      sessionStorage.setItem(`${MANUAL_SCHOOL_KEY}_tw`, '');
      expect(service.hasManualPick()).toBe(false);
    });

    it('sees a pick made in another region than the current one', () => {
      // At start-up the region is the remembered one; the URL may be /hk.
      sessionStorage.setItem(`${MANUAL_SCHOOL_KEY}_hk`, 'HKU');
      expect(service.hasManualPick()).toBe(true);
    });

    it('sees a full name saved before codes existed', () => {
      sessionStorage.setItem(MANUAL_SCHOOL_KEY, 'National Taiwan University');
      expect(service.hasManualPick()).toBe(true);
    });
  });

  describe('resolvedSchool$', () => {
    it('holds back the provisional school until the opening school is settled', () => {
      // Consumers used to load for the provisional '' and then again for the
      // real school a moment later.
      const seen: string[] = [];
      const sub = service.resolvedSchool$.subscribe(school => seen.push(school));
      service.setSchool('NTU');
      expect(seen).toEqual([]);

      service.markReady();
      expect(seen).toEqual(['NTU']);

      service.setSchool('NCCU');
      service.markReady();
      expect(seen).toEqual(['NTU', 'NCCU']);
      sub.unsubscribe();
    });
  });
});
