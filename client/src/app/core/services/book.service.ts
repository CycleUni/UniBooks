import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { SKIP_LANG_PARAM } from '../api-url.interceptor';
import { SKIP_AUTH } from '../auth.interceptor';

/** A course the search facet can offer. `count` is absent on a backend that
 *  still returns the old plain-string list. */
export interface CourseFacet {
  value: string;
  count?: number;
}

/** An external catalogue the backend can look a book up in. */
export type SearchEngine = 'googlebooks' | 'openlibrary' | 'isbnnet';

export function parseSearchEngine(value: unknown): SearchEngine | null {
  return value === 'googlebooks' || value === 'openlibrary' || value === 'isbnnet' ? value : null;
}

/**
 * The engine a search result actually came from, read off its `source`.
 * With no engine in the request the backend tries Google, then the ISBN
 * registry, then Open Library, so the page's own engine no longer says where
 * a given result was found. A book already in our catalogue (any other
 * source) needs none: the book page finds it in the database first.
 */
export function engineForSource(source: unknown): SearchEngine | null {
  switch (source) {
    case 'google_api': return 'googlebooks';
    case 'openlibrary_api': return 'openlibrary';
    case 'isbnnet_api': return 'isbnnet';
    default: return null;
  }
}

const PUBLIC_NO_LANG = new HttpContext().set(SKIP_LANG_PARAM, true).set(SKIP_AUTH, true);
const OPTIONAL_AUTH_NO_LANG = new HttpContext().set(SKIP_LANG_PARAM, true);

@Injectable({
  providedIn: 'root'
})
export class BookService {
  private http = inject(HttpClient);

  /**
   * Leave `engine` out unless the user asked for a specific catalogue. Only
   * a request without it gets the backend's fallback chain (Google, then the
   * ISBN registry, then Open Library); `engine=googlebooks` means Google
   * alone, falling back only when Google rate-limits.
   */
  /**
   * `filters` are the listing filters (condition, price_min, price_max,
   * in_stock) as the search page writes them in its URL. The backend applies
   * them before paging, so every page is filtered, and they alone are enough
   * to list books with no keyword.
   */
  searchBooks(query: string, category?: string, course?: string, school?: string, page: number = 1, engine?: SearchEngine | null, filters: Record<string, string> = {}): Observable<any> {
    let url = `/search/books/?q=${encodeURIComponent(query)}&page=${page}`;
    if (category) {
      url += `&category=${encodeURIComponent(category)}`;
    }
    if (course) {
      url += `&course=${encodeURIComponent(course)}`;
    }
    if (school) {
      url += `&school=${encodeURIComponent(school)}`;
    }
    if (engine) {
      url += `&engine=${encodeURIComponent(engine)}`;
    }
    for (const [key, value] of Object.entries(filters)) {
      url += `&${key}=${encodeURIComponent(value)}`;
    }
    return this.http.get<any[]>(url, { context: OPTIONAL_AUTH_NO_LANG });
  }

  getBook(idOrIsbn: string, page: number = 1, school?: string, engine?: string): Observable<any> {
    const isIsbn = /^\d{10,13}$/.test(idOrIsbn);
    let param = isIsbn ? `?isbn=${idOrIsbn}&page=${page}` : `?id=${idOrIsbn}&page=${page}`;
    if (school) {
      param += `&school=${encodeURIComponent(school)}`;
    }
    if (engine) {
      param += `&engine=${encodeURIComponent(engine)}`;
    }
    return this.http.get<any>(`/books/${param}`);
  }

  createManualBook(bookData: any): Observable<any> {
    return this.http.post<any>('/books/manual/', bookData);
  }

  /**
   * The endpoint used to return `string[]` and now returns `{value, count}[]`
   * — it always counted, it just threw the number away. Both shapes are
   * accepted here on purpose: frontend and backend deploy separately, so
   * whichever ships first must not break the course filter in the other.
   */
  getTopCourses(school?: string, category?: string): Observable<CourseFacet[]> {
    let url = `/search/courses/?`;
    const params = new URLSearchParams();
    if (school) params.set('school', school);
    if (category) params.set('category', category);
    return this.http.get<Array<string | CourseFacet>>(url + params.toString(), { context: PUBLIC_NO_LANG }).pipe(
      map(rows => (rows ?? []).map(row =>
        typeof row === 'string' ? { value: row } : row
      ))
    );
  }

  subscribe(bookId: string): Observable<any> {
    return this.http.post<any>('/subscriptions/', { book_id: bookId });
  }

  unsubscribe(subscriptionId: string | number): Observable<any> {
    return this.http.delete<any>(`/subscriptions/${subscriptionId}/`);
  }
}
