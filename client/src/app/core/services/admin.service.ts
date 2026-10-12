import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { switchMap, map } from 'rxjs/operators';

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}


export interface AdminCurrency {
  code: string;
  symbol: string;
  decimal_places: number;
  symbol_position: 'prefix' | 'suffix';
  is_active: boolean;
}

export interface AdminRegion {
  code: string;
  name: string;
  display_name: string;
  translations: any;
  currency: string;
  default_language: string;
  languages: string[];
  timezone: string;
  search_engines: string[];
  edu_email_suffix: string[];
  is_active: boolean;
  sort_order: number;
}

export interface AdminUser {
  id: string | number;
  email: string;
  first_name: string;
  last_name: string;
  display_name: string;
  school: string | number | null;
  school_name: string;
  edu_email: string;
  is_active: boolean;
  is_verified?: boolean;
  verifications?: any[];
  regions?: string[];
  verified_at: string | null;
  created_at: string;
  is_staff: boolean;
  is_superuser: boolean;
}

export interface AdminListing {
  id: string;
  book: { id: string; title: string };
  seller: { id: string | number; email: string };
  /** display_name is in the page's language; name is the canonical English one. */
  school: { id: string | number; code?: string; name: string; display_name?: string } | null;
  price: number;
  /** ISO 4217 code for this row, so a merged multi-region list formats each
   *  price in its own currency instead of the viewer's region default. */
  currency?: string;
  condition: string;
  status: string;
  region?: string;
  created_at: string;
  admin_locked?: boolean;
  admin_lock_reason?: string;
  locked_by?: string | number | null;
  locked_at?: string | null;
}

export interface AdminOrder {
  id: string;
  buyer: { id: string | number; email: string };
  seller: { id: string | number; email: string };
  /** `deleted`: the seller deleted the listing; the order keeps its title. */
  listing: { id: string; book_title: string; deleted?: boolean };
  status: string;
  total_amount: number;
  currency?: string;
  region?: string;
  created_at: string;
  updated_at: string;
}


export interface AdminAdvertiser {
  id: number;
  user: number | null;
  company_name: string;
  contact_email: string;
  contact_phone: string;
  all_schools: boolean;
  schools: number[];
  all_regions?: boolean;
  regions?: string[];
  is_active: boolean;
  created_at: string;
}

export interface AdminAd {
  id: number;
  advertiser: number;
  advertiser_name?: string;
  title: string;
  image_url: string;
  target_url: string;
  position: string;
  headline?: string;
  subheadline?: string;
  slot_index: number;
  start_date: string;
  end_date: string;
  is_active: boolean;
  show_in_hero?: boolean;
  is_internal_image?: boolean;
  clicks_count: number;
  views_count: number;
  all_regions?: boolean;
  regions?: string[];
  created_at: string;
  labels?: string[];
}

export interface AdminReport {
  id: string;
  reporter: { id: string | number; email: string };
  listing: { id: string; title?: string; deleted?: boolean };
  reason: string;
  detail?: string;
  status: 'open' | 'actioned' | 'dismissed';
  created_at: string;
  region?: string;
}

export interface AdminSchool {
  id: number;
  /** Short code ("NTU"), unique within the school's region only. Sent blank
   *  or left out on create, the backend derives one from the email domain. */
  code: string;
  name: string;
  display_name: string;
  email_domain: string;
  translations: any;
  region?: string;
  /** Code of the school's city in its region; null when none is set. */
  city?: string | null;
  /** Number of accounts attached to this school; a school with any cannot be deleted. */
  user_count?: number;
}

export interface AdminCategory {
  id: number;
  slug: string;
  title: string;
  description: string;
  sort_order: number;
  is_active: boolean;
  region?: string;
  translations: any;
}

export interface AdminChatReport {
  id: string;
  conversation_id: string;
  listing_title: string;
  reporter_email: string;
  reported_party_email: string;
  reason: string;
  detail?: string;
  status: 'open' | 'actioned' | 'dismissed';
  created_at: string;
  region?: string;
}

export type SchoolRequestStatus = 'pending' | 'added' | 'rejected';

export interface AdminSchoolRequest {
  id: number;
  user: { id: number; email: string };
  region: string;
  school_name: string;
  school_website: string;
  edu_email: string;
  status: SchoolRequestStatus;
  admin_note: string;
  created_at: string;
  updated_at: string;
}

function buildParams(query: Record<string, string | number | undefined | null>): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && (value !== '' || key === 'region')) {
      params = params.set(key, String(value));
    }
  }
  return params;
}

/** A book's catalogue record as the admin edits it. */
export interface AdminBookRecord {
  isbn13: string;
  title: string;
  authors: string;
  publisher: string;
  published_date: string;
  cover_url: string;
}

/** What the external catalogues hold for an ISBN; `existing_book` is the
 *  region's other book already under it, which saving would merge into. */
export interface AdminBookLookup extends AdminBookRecord {
  source: string;
  existing_book: { id: number; title: string } | null;
}

/** A book as the admin's book list and page show it. */
export interface AdminBook {
  id: number;
  region: string;
  isbn13: string | null;
  title: string;
  authors: string;
  publisher: string;
  published_date: string;
  cover_url: string;
  source: string;
  created_at: string;
  active_listings: number;
  request_count: number;
  /** When an admin confirmed no catalogue has this manual book. */
  reviewed_at: string | null;
  /** A manual book no admin has checked against the catalogues yet. */
  pending_review: boolean;
}

/** The book list's `review` filter, over manually added books only. */
export type AdminBookReviewFilter = 'pending' | 'confirmed';

export interface AdminBookUpdate {
  /** Set when the book was folded into another one and no longer exists. */
  merged_into: number | null;
  book: AdminBookRecord & { id: number; source: string };
}

@Injectable({
  providedIn: 'root'
})
export class AdminService {
  private http = inject(HttpClient);

  // Regions
  getRegions(): Observable<Paginated<AdminRegion>> {
    return this.http.get<Paginated<AdminRegion>>('/admin/regions/');
  }
  
  getRegion(code: string): Observable<AdminRegion> {
    return this.http.get<AdminRegion>(`/admin/regions/${code}/`);
  }
  
  createRegion(data: Partial<AdminRegion>): Observable<AdminRegion> {
    return this.http.post<AdminRegion>('/admin/regions/', data);
  }
  
  updateRegion(code: string, data: Partial<AdminRegion>): Observable<AdminRegion> {
    return this.http.patch<AdminRegion>(`/admin/regions/${code}/`, data);
  }

  // Currencies
  getCurrencies(): Observable<Paginated<AdminCurrency>> {
    return this.http.get<Paginated<AdminCurrency>>('/admin/currencies/');
  }
  
  getCurrency(code: string): Observable<AdminCurrency> {
    return this.http.get<AdminCurrency>(`/admin/currencies/${code}/`);
  }
  
  createCurrency(data: Partial<AdminCurrency>): Observable<AdminCurrency> {
    return this.http.post<AdminCurrency>('/admin/currencies/', data);
  }
  
  updateCurrency(code: string, data: Partial<AdminCurrency>): Observable<AdminCurrency> {
    return this.http.patch<AdminCurrency>(`/admin/currencies/${code}/`, data);
  }


  getUsers(opts: { page?: number; q?: string; is_active?: string; school?: string; region?: string } = {}): Observable<Paginated<AdminUser>> {
    return this.http.get<Paginated<AdminUser>>('/admin/users/', { params: buildParams(opts) });
  }

  getUser(id: string | number): Observable<AdminUser> {
    return this.http.get<AdminUser>(`/admin/users/${id}/`);
  }

  updateUser(id: string | number, changes: { is_active?: boolean; school?: string | number | null; verified?: boolean; region?: string }): Observable<AdminUser> {
    return this.http.patch<AdminUser>(`/admin/users/${id}/`, changes);
  }

  toggleManager(id: string | number, is_staff: boolean): Observable<AdminUser> {
    return this.http.post<AdminUser>(`/admin/managers/${id}/toggle/`, { is_staff });
  }

  getListings(opts: { page?: number; q?: string; status?: string; condition?: string; school?: string; region?: string } = {}): Observable<Paginated<AdminListing>> {
    return this.http.get<Paginated<AdminListing>>('/admin/listings/', { params: buildParams(opts) });
  }

  getListing(id: string): Observable<AdminListing> {
    return this.http.get<AdminListing>(`/admin/listings/${id}/`);
  }

  updateListingStatus(id: string, data: { status?: string; admin_locked?: boolean; admin_lock_reason?: string }): Observable<AdminListing> {
    return this.http.patch<AdminListing>(`/admin/listings/${id}/`, data);
  }

  /** `reason` is required when the listing still has open orders: the
   *  server cancels them on the platform's behalf before deleting it. */
  deleteListing(id: string, reason?: string): Observable<void> {
    return this.http.delete<void>(`/admin/listings/${id}/`, reason ? { body: { reason } } : {});
  }

  getOrders(opts: { page?: number; q?: string; status?: string; region?: string } = {}): Observable<Paginated<AdminOrder>> {
    return this.http.get<Paginated<AdminOrder>>('/admin/orders/', { params: buildParams(opts) });
  }

  getOrder(id: string): Observable<AdminOrder> {
    return this.http.get<AdminOrder>(`/admin/orders/${id}/`);
  }

  forceCancelOrder(id: string, reason: string): Observable<{ status: string }> {
    return this.http.post<{ status: string }>(`/admin/orders/${id}/force_cancel/`, { reason });
  }

  getReports(status?: string, page?: number, region?: string): Observable<Paginated<AdminReport>> {
    return this.http.get<Paginated<AdminReport>>('/moderation/all/', { params: buildParams({ status, page, region }) });
  }

  actionReport(id: string, status: 'actioned' | 'dismissed'): Observable<AdminReport> {
    return this.http.patch<AdminReport>(`/moderation/${id}/`, { status });
  }

  getSchools(opts: { page?: number; page_size?: number; q?: string; region?: string } = {}): Observable<Paginated<AdminSchool>> {
    return this.http.get<Paginated<AdminSchool>>('/admin/schools/', { params: buildParams(opts) });
  }

  getSchool(id: string | number): Observable<AdminSchool> {
    return this.http.get<AdminSchool>(`/admin/schools/${id}/`);
  }

  createSchool(data: Partial<AdminSchool>): Observable<AdminSchool> {
    return this.http.post<AdminSchool>('/admin/schools/', data);
  }

  updateSchool(id: string | number, data: Partial<AdminSchool>): Observable<AdminSchool> {
    return this.http.patch<AdminSchool>(`/admin/schools/${id}/`, data);
  }

  getBooks(opts: { page?: number; q?: string; region?: string; review?: AdminBookReviewFilter | '' } = {}): Observable<Paginated<AdminBook>> {
    return this.http.get<Paginated<AdminBook>>('/admin/books/', { params: buildParams(opts) });
  }

  getBook(id: number): Observable<AdminBook> {
    return this.http.get<AdminBook>(`/admin/books/${id}/`);
  }

  /** Records that no catalogue has this manual book, taking it out of review. */
  confirmManualBook(id: number): Observable<AdminBook> {
    return this.http.post<AdminBook>(`/admin/books/${id}/confirm-manual/`, {});
  }

  /** The same for several books; `confirmed` lists those this call confirmed
   *  (others were not pending manual books, or not this admin's). */
  confirmManualBooks(ids: number[]): Observable<{ confirmed: number[] }> {
    return this.http.post<{ confirmed: number[] }>('/admin/books/confirm-manual/', { ids });
  }

  /** Puts confirmed manual books back in review; `reopened` lists those it did. */
  reopenBookReviews(ids: number[]): Observable<{ reopened: number[] }> {
    return this.http.post<{ reopened: number[] }>('/admin/books/reopen-review/', { ids });
  }

  lookupBook(id: number, isbn: string): Observable<AdminBookLookup> {
    return this.http.get<AdminBookLookup>(`/admin/books/${id}/lookup/`, { params: buildParams({ isbn }) });
  }

  /** 409 `admin.errBookIsbnTaken` when another book has the ISBN, unless `merge`. */
  updateBook(id: number, changes: Partial<AdminBookRecord> & { source?: string; merge?: boolean }): Observable<AdminBookUpdate> {
    return this.http.patch<AdminBookUpdate>(`/admin/books/${id}/`, changes);
  }

  deleteSchool(id: string | number): Observable<void> {
    return this.http.delete<void>(`/admin/schools/${id}/`);
  }

  getCategories(opts: { page?: number; region?: string } = {}): Observable<Paginated<AdminCategory>> {
    return this.http.get<Paginated<AdminCategory>>('/admin/categories/', { params: buildParams(opts) });
  }

  createCategory(data: Partial<AdminCategory>): Observable<AdminCategory> {
    return this.http.post<AdminCategory>('/admin/categories/', data);
  }

  updateCategory(id: string | number, data: Partial<AdminCategory>): Observable<AdminCategory> {
    return this.http.patch<AdminCategory>(`/admin/categories/${id}/`, data);
  }

  deleteCategory(id: string | number): Observable<void> {
    return this.http.delete<void>(`/admin/categories/${id}/`);
  }

  bulkImport(endpoint: 'schools' | 'categories', action: 'preview' | 'apply', items: any[]): Observable<any> {
    return this.http.post<any>(`/admin/${endpoint}/bulk/`, { action, items });
  }

  getChatReports(status?: string, page?: number, region?: string): Observable<Paginated<AdminChatReport>> {
    return this.http.get<Paginated<AdminChatReport>>('/admin/chat-reports/', { params: buildParams({ status, page, region }) });
  }

  actionChatReport(id: string, status: 'actioned' | 'dismissed'): Observable<AdminChatReport> {
    return this.http.patch<AdminChatReport>(`/admin/chat-reports/${id}/`, { status });
  }

  getChatReportToken(id: string): Observable<{ token: string; edge_chat_url: string; room_id: string }> {
    return this.http.get<{ token: string; edge_chat_url: string; room_id: string }>(`/admin/chat-reports/${id}/chat-token/`);
  }

  getSchoolRequests(opts: { page?: number; q?: string; status?: string; region?: string } = {}): Observable<Paginated<AdminSchoolRequest>> {
    return this.http.get<Paginated<AdminSchoolRequest>>('/admin/school-requests/', { params: buildParams(opts) });
  }

  updateSchoolRequest(id: number, changes: { status?: SchoolRequestStatus; admin_note?: string }): Observable<AdminSchoolRequest> {
    return this.http.patch<AdminSchoolRequest>(`/admin/school-requests/${id}/`, changes);
  }

  // API endpoints below renamed from 'advertisers' and 'ads' to 'sponsors' and 'promotions' to evade adblockers
  getAdvertisers(opts: { page?: number; q?: string; page_size?: number; region?: string } = {}): Observable<Paginated<AdminAdvertiser>> {
    return this.http.get<Paginated<AdminAdvertiser>>('/admin/sponsors/', { params: buildParams(opts) });
  }

  getAdvertiser(id: string | number): Observable<AdminAdvertiser> {
    return this.http.get<AdminAdvertiser>(`/admin/sponsors/${id}/`);
  }

  createAdvertiser(data: Partial<AdminAdvertiser>): Observable<AdminAdvertiser> {
    return this.http.post<AdminAdvertiser>('/admin/sponsors/', data);
  }

  updateAdvertiser(id: string | number, data: Partial<AdminAdvertiser>): Observable<AdminAdvertiser> {
    return this.http.patch<AdminAdvertiser>(`/admin/sponsors/${id}/`, data);
  }

  deleteAdvertiser(id: string | number): Observable<void> {
    return this.http.delete<void>(`/admin/sponsors/${id}/`);
  }

  getAds(opts: { page?: number; advertiser_id?: number; q?: string; region?: string } = {}): Observable<Paginated<AdminAd>> {
    return this.http.get<Paginated<AdminAd>>('/admin/promotions/', { params: buildParams(opts) });
  }

  getAd(id: string | number): Observable<AdminAd> {
    return this.http.get<AdminAd>(`/admin/promotions/${id}/`);
  }

  createAd(data: Partial<AdminAd>): Observable<AdminAd> {
    return this.http.post<AdminAd>('/admin/promotions/', data);
  }

  updateAd(id: string | number, data: Partial<AdminAd>): Observable<AdminAd> {
    return this.http.patch<AdminAd>(`/admin/promotions/${id}/`, data);
  }

  deleteAd(id: string | number): Observable<void> {
    return this.http.delete<void>(`/admin/promotions/${id}/`);
  }

  uploadAdPhoto(file: File): Observable<{ url: string }> {
    return this.http.post<any>('/admin/promotions/uploads/presign/', {
      content_type: file.type,
      // Signed into the presigned URL by the backend; ad images are PUT
      // uncompressed, so this is the file's own size.
      content_length: file.size
    }).pipe(
      switchMap((presign: any) => {
        if (presign.mode === 'direct') {
          const formData = new FormData();
          formData.append('file', file);
          // BE now returns { mode: 'direct', photo_url: '...' } for consistency
          return this.http.post<{ photo_url: string }>('/admin/promotions/uploads/direct/', formData).pipe(
            map((resp) => ({ url: resp.photo_url }))
          );
        }

        if (presign.mode === 'presigned_put') {
          return this.http.put(presign.upload_url, file, {
            headers: { 'Content-Type': file.type }
          }).pipe(
            map(() => ({ url: presign.photo_url }))
          );
        }

        throw new Error('Unknown upload mode');
      })
    );
  }
}
