import { Injectable } from '@angular/core';

/** What a phone's search page had loaded when the visitor left it. */
export interface SearchSnapshotState {
  /** The search it answered (the page's fetch key: school, query, filters). */
  fetchKey: string;
  results: any[];
  totalCount: number;
  localCount: number | null;
  searchScope: any;
  searchCity: any;
  cityCount: number;
  googleUnavailable: boolean;
  resultsTruncated: boolean;
  /** Pages the infinite scroll had loaded. */
  loadedPage: number;
  scrollY: number;
  at: number;
}

/** A snapshot older than this is refetched: listings sell and appear. */
const MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The phone search page's results across a visit to a book and Back. The
 * page is destroyed on navigation and its infinite scroll starts again at
 * page 1, so Back used to land near the top of a short list, the pages
 * scrolled through gone (and fetched again). One snapshot, for the search
 * the visitor last left; a fresh link or a new search always fetches.
 */
@Injectable({ providedIn: 'root' })
export class SearchSnapshot {
  private snapshot: SearchSnapshotState | null = null;

  save(state: SearchSnapshotState): void {
    this.snapshot = state;
  }

  /** The snapshot for `fetchKey`, if recent; consumed either way. */
  take(fetchKey: string, now = Date.now()): SearchSnapshotState | null {
    const s = this.snapshot;
    this.snapshot = null;
    return s && s.fetchKey === fetchKey && now - s.at < MAX_AGE_MS ? s : null;
  }
}
