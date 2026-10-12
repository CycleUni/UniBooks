import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, combineLatest } from 'rxjs';
import { distinctUntilChanged, filter, map } from 'rxjs/operators';

/**
 * Prefix of the sessionStorage key holding the school picked by hand. The
 * region code is appended (`unibooks_manual_school_tw`): a school code is only
 * unique inside one region — Taiwan and Hong Kong each have an "HKU" — so a
 * choice made on /tw must never be carried over to /hk, or vice versa. The
 * bare prefix is the key used before codes existed, holding a full name.
 */
export const MANUAL_SCHOOL_KEY = 'unibooks_manual_school';

/** A school as listed by /core/metadata/. */
export interface SchoolOption {
  id: number;
  /** Short code, unique within the region; what is selected and sent as `?school=`. */
  code: string;
  /** Canonical English name. Only used to recognize values saved before codes. */
  name: string;
  display_name?: string;
  /** Every name the school goes by, in every language, for searching. */
  names?: string[];
  email_domain?: string;
  /** Code of the city the school is in; null when it has none. */
  city?: string | null;
}

/** A city as listed by /core/metadata/, in display order. */
export interface CityOption {
  code: string;
  name: string;
  display_name?: string;
}

@Injectable({
  providedIn: 'root'
})
export class SchoolStateService {
  /** The selected school's code; '' means all schools. */
  private selectedSchoolSubject = new BehaviorSubject<string>('');
  private rawSchools: SchoolOption[] = [];
  private schoolsSubject = new BehaviorSubject<SchoolOption[]>([]);
  private cities: CityOption[] = [];
  /** Region the manual choice is stored under; set by RegionService. */
  private region = '';

  hasInitialized = false;
  selectedSchool$ = this.selectedSchoolSubject.asObservable();

  /**
   * True once the page's opening school is settled: the layout has loaded
   * the school list and applied the saved or verified choice (or given up
   * waiting for it). Before that, selectedSchool$ holds a provisional '' —
   * and the home page used to load its metadata, ads and recent books for
   * "all schools" on that, then load all of them again a moment later for
   * the school that was actually selected.
   */
  private readySubject = new BehaviorSubject<boolean>(false);

  /** The selected school, from the moment it is settled; see markReady(). */
  readonly resolvedSchool$: Observable<string> = combineLatest([
    this.readySubject.pipe(filter(Boolean)),
    this.selectedSchool$,
  ]).pipe(map(([, school]) => school), distinctUntilChanged());

  get ready(): boolean {
    return this.readySubject.value;
  }

  markReady() {
    if (!this.readySubject.value) this.readySubject.next(true);
  }
  schools$ = this.schoolsSubject.asObservable();

  /**
   * Which region's saved choice getManualSchool/setManualSchool touch.
   * Pushed in by RegionService rather than read from it: RegionService
   * already injects this service, and injecting it back would be circular.
   */
  setRegion(region: string) {
    const next = (region || '').toLowerCase();
    if (next !== this.region && this.rawSchools.length > 0) {
      // The loaded list is the old region's. Checked against it, a code
      // saved for the new region could be judged unknown and dropped.
      this.setSchools([]);
    }
    this.region = next;
  }

  setSchools(schools: SchoolOption[], cities: CityOption[] = []) {
    this.rawSchools = schools;
    this.cities = cities;
    this.schoolsSubject.next(schools);
  }

  /** This region's cities, in display order. */
  getCities(): CityOption[] {
    return this.cities;
  }

  /** A city's name in the current language; the code itself if unknown. */
  getCityLabel(code: string | null | undefined): string {
    if (!code) return '';
    const c = this.cities.find(x => x.code === code);
    return c ? (c.display_name || c.name) : code;
  }

  private findByCode(code: string): SchoolOption | undefined {
    if (!code) return undefined;
    const wanted = code.toUpperCase();
    return this.rawSchools.find(x => (x.code || '').toUpperCase() === wanted);
  }

  /**
   * The code for a stored or linked value, which may be a code or — from
   * before codes existed — the English full name. Null when it names no
   * school in the loaded list (the list only ever holds this region's).
   */
  resolveSchoolCode(value: string): string | null {
    if (!value) return null;
    const s = this.findByCode(value) ?? this.rawSchools.find(x => x.name === value);
    return s ? s.code : null;
  }

  getSchoolLabel(code: string): string {
    const s = this.findByCode(code);
    if (!s) return code;
    return s.display_name || s.name;
  }

  getSchoolId(code: string): number | null {
    const s = this.findByCode(code);
    return s ? s.id : null;
  }

  setSchool(code: string) {
    if (code !== this.selectedSchoolSubject.value) {
      this.selectedSchoolSubject.next(code);
    }
  }

  setManualSchool(code: string) {
    this.setSchool(code);
    this.write(code);
  }

  /**
   * This region's hand-picked school: a code, '' for a deliberate "all
   * schools", or null when nothing was picked.
   *
   * Once the school list is loaded the stored value is checked against it.
   * A full name saved before codes existed — under the old, region-less
   * key — is turned into its code and moved to this region's key; one that
   * no longer names a school here is dropped, so the caller falls back to
   * the user's own school instead of filtering by nothing.
   */
  getManualSchool(): string | null {
    let stored = this.read(this.storageKey());
    const legacy = stored === null ? this.read(MANUAL_SCHOOL_KEY) : null;
    if (stored === null) stored = legacy;
    if (stored === null) return null;
    // Before the list arrives there is nothing to check against; the value
    // is only needed for its null-ness then.
    if (this.rawSchools.length === 0) return stored;

    if (legacy !== null) this.remove(MANUAL_SCHOOL_KEY);
    const code = stored === '' ? '' : this.resolveSchoolCode(stored);
    if (code === null) {
      this.remove(this.storageKey());
      return null;
    }
    if (code !== stored || legacy !== null) this.write(code);
    return code;
  }

  /**
   * Whether a school other than "all schools" was picked by hand in any
   * region. Asked before the region is settled — at start-up it is still the
   * one remembered from last time, not necessarily the one in the URL — so
   * it looks at every region's choice rather than the current one's.
   */
  hasManualPick(): boolean {
    return this.manualSchoolKeys().some(key => !!this.read(key));
  }

  /** Forget the hand-picked school in every region (on logout). */
  clearManualSchool() {
    this.manualSchoolKeys().forEach(key => this.remove(key));
  }

  /** The storage keys of every region's hand-picked school, legacy one included. */
  private manualSchoolKeys(): string[] {
    if (typeof sessionStorage === 'undefined') return [];
    const keys: string[] = [];
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key !== null && (key === MANUAL_SCHOOL_KEY || key.startsWith(`${MANUAL_SCHOOL_KEY}_`))) {
          keys.push(key);
        }
      }
    } catch (err) {
      console.error('Failed to read manual school selection', err);
    }
    return keys;
  }

  get currentSchool(): string {
    return this.selectedSchoolSubject.value;
  }

  private storageKey(): string {
    return this.region ? `${MANUAL_SCHOOL_KEY}_${this.region}` : MANUAL_SCHOOL_KEY;
  }

  private read(key: string): string | null {
    if (typeof sessionStorage === 'undefined') return null;
    try {
      return sessionStorage.getItem(key);
    } catch (err) {
      console.error('Failed to read manual school selection', err);
      return null;
    }
  }

  private write(code: string) {
    if (typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.setItem(this.storageKey(), code);
    } catch (err) {
      console.error('Failed to save manual school selection', err);
    }
  }

  private remove(key: string) {
    if (typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.removeItem(key);
    } catch (err) {
      console.error('Failed to clear manual school selection', err);
    }
  }
}
