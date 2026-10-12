import { Injectable, signal, computed, inject, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { I18nService } from './i18n.service';
import { SchoolStateService } from './services/school-state.service';
import { tap, catchError, map } from 'rxjs/operators';
import { firstValueFrom, of } from 'rxjs';
import { environment } from '../../environments/environment';
import { regionSwitchUrl } from './region-path';
import { detectRegion, fetchTrace, regionFromTimezone } from './geo-region';

export interface Currency {
  code: string;
  symbol: string;
  decimal_places: number;
  symbol_position: 'prefix' | 'suffix';
}

export interface Region {
  code: string;
  name: string;
  localized_name: string;
  currency: Currency;
  languages: string[];
  default_language: string;
  timezone: string;
  search_engines: string[];
  edu_email_suffix: string[];
}

const STORAGE_KEY = 'region';

/** How long a first visit waits on IP detection before the timezone guess stands. */
const GEO_TIMEOUT_MS = 800;

function browserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function translationLanguagesOf(region: Region | null): string[] {
  if (!region) return [];
  const langs = [region.default_language, ...(region.languages || [])]
    .filter((lang): lang is string => !!lang && lang !== 'en');
  return [...new Set(langs)];
}

@Injectable({ providedIn: 'root' })
export class RegionService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private i18n = inject(I18nService);
  private schoolState = inject(SchoolStateService);

  /** Whether a region was saved by an earlier visit (or picked by hand). */
  private hasStoredRegion = false;
  private detection: Promise<void> | null = null;

  readonly region = signal<string>(this.initialRegion());
  readonly regions = signal<Region[]>([]);
  
  readonly currentRegionObj = computed(() => {
    const regs = this.regions();
    const code = this.region().toUpperCase();
    return regs.find(r => r.code === code) || null;
  });

  /**
   * The languages content in this region is translated into, default first:
   * every language the region offers except English, which is what canonical
   * fields (a school's `name`, a category's `title`) are written in. The
   * admin editors offer these instead of assuming zh-TW, which put Hong Kong
   * schools' Chinese names under the Taiwanese key.
   */
  readonly translationLanguages = computed(() => translationLanguagesOf(this.currentRegionObj()));

  /** translationLanguages for a given region, e.g. the one a school belongs to. */
  translationLanguagesFor(code: string | null | undefined): string[] {
    const upper = (code || '').toUpperCase();
    return translationLanguagesOf(this.regions().find(r => r.code === upper) || null);
  }

  readonly currency = computed(() => {
    return this.currentRegionObj()?.currency || { code: 'TWD', symbol: 'NT$', decimal_places: 0, symbol_position: 'prefix' };
  });

  constructor() {
    this.schoolState.setRegion(this.region());
    // Deferred by a microtask, not called inline. fetchRegions() issues an
    // HTTP request, which runs ApiUrlInterceptor, which resolves this very
    // service — from inside its own constructor. DI hands back the
    // half-built instance and the request never leaves, so regions() stayed
    // empty and currency() silently fell back to TWD, printing NT$ prices in
    // Hong Kong. By the time the microtask runs, construction is finished.
    effect(() => {
      const currentLang = this.i18n.lang();
      queueMicrotask(() => this.fetchRegions(currentLang));
    });
  }

  private initialRegion(): string {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        this.hasStoredRegion = true;
        return stored.toLowerCase();
      }
    }
    // A Taipei or Hong Kong timezone settles it (see regionFromTimezone);
    // otherwise this is only the offline guess, and detectInitialRegion()
    // replaces it with the IP's answer when there is one.
    return regionFromTimezone(browserTimezone()) ?? 'tw';
  }

  /**
   * On a first visit, move the region to the one the visitor's IP places
   * them in. Resolves once that is settled either way — never rejects — so
   * the entry redirect can wait on it. A saved region is left alone: it is
   * either what IP detection found last time or what the visitor picked.
   */
  detectInitialRegion(): Promise<void> {
    if (this.hasStoredRegion || regionFromTimezone(browserTimezone())) return Promise.resolve();
    if (!this.detection) {
      this.detection = detectRegion(
        {
          backend: () => firstValueFrom(
            this.http.get<{ region: string | null }>('/core/geo/')
              .pipe(map(res => res?.region ?? null)),
          ),
          trace: () => fetchTrace(),
        },
        code => this.isKnownRegion(code),
        GEO_TIMEOUT_MS,
      ).then(code => {
        if (code && code !== this.region()) this.setRegion(code, true);
      }).catch(() => undefined);
    }
    return this.detection;
  }

  /** Same test as regionGuard: the loaded list, or the two built-in regions before it arrives. */
  private isKnownRegion(code: string): boolean {
    const regs = this.regions();
    return regs.length > 0
      ? regs.some(r => r.code.toLowerCase() === code)
      : code === 'tw' || code === 'hk';
  }

  private lastFetchedLang: string | null = null;

  private fetchRegions(lang: string) {
    if (this.lastFetchedLang === lang && this.regions().length > 0) return;
    
    // Relative path only. ApiUrlInterceptor prepends environment.backendUrl,
    // which already ends in /api/v1 — spelling it again here produced
    // /api/v1/api/v1/core/regions/, a silent 404 that left regions() empty
    // and the region picker with nothing to show.
    this.http.get<Region[]>('/core/regions/').pipe(
      tap(regs => {
        const isFirst = this.regions().length === 0;
        this.regions.set(regs);
        if (isFirst) {
          this.setRegion(this.region(), true);
        }
        this.lastFetchedLang = lang;
      }),
      // Swallowing this silently is what made the earlier failures so hard to
      // place: the only visible symptom was prices rendering in the wrong
      // currency, several layers away from the request that actually failed.
      catchError(err => {
        console.error('Failed to load regions — falling back to defaults', err);
        return of([]);
      })
    ).subscribe();
  }

  setRegion(code: string, isInit = false) {
    code = code.toLowerCase();
    const regs = this.regions();
    if (regs.length > 0 && !regs.some(r => r.code.toLowerCase() === code)) {
        code = regs[0].code.toLowerCase();
    }
    
    const oldRegion = this.region();
    this.region.set(code);
    this.schoolState.setRegion(code);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, code);
    }

    if (oldRegion !== code || isInit) {
      if (!isInit) {
        // The hand-picked school is not cleared: it is saved per region, so
        // the other region's choice can never be read here, and coming back
        // to this region finds its own choice where it was left.
        this.schoolState.setSchool('');
      }
      
      const newRegionObj = regs.find(r => r.code.toLowerCase() === code);
      if (newRegionObj) {
        const currentLang = this.i18n.lang();
        if (!newRegionObj.languages.includes(currentLang)) {
           this.i18n.setLang(newRegionObj.default_language as any);
        }
      }
      
      if (!isInit && typeof window !== 'undefined') {
        // `code` is about to be interpolated into a URL that is then
        // navigated to. It has usually already been checked against the
        // loaded region list above — but that check is skipped entirely when
        // the list is empty, which is a real state: the regions request has a
        // catchError that yields []. A code of `/evil.example` would make
        // `/${code}` a protocol-relative URL, i.e. a full navigation off this
        // origin. Nothing reaches here with a hostile value today (the route
        // guard validates first, and passes isInit=true, which skips this
        // branch), so this is the second lock rather than the first.
        if (!/^[a-z0-9-]{1,16}$/.test(code)) return;

        const target = regionSwitchUrl(this.router.url, code);
        // A full document load, not router.navigateByUrl. Every route lives
        // under the `:region` segment, so switching TW→HK only changes a
        // parameter: Angular reuses the component, ngOnInit never re-runs and
        // the page keeps showing the previous region's data even though the
        // URL and the picker both say otherwise.
        //
        // Reloading is also the honest thing here rather than a workaround —
        // a region switch invalidates every list on screen, the selected
        // school, and possibly the display language. Re-entering the app is
        // cheaper to reason about than teaching each feature to re-fetch.
        window.location.assign(target);
      }
    }
  }
}
