/**
 * Response shapes the Angular client imports (`import type`). Keep this file
 * free of Worker bindings and runtime imports so the client build stays clean.
 */

/** GET/POST /api/v1/subscriptions item. */
export interface SubscriptionDto {
  id: string;
  book: string;
  bookTitle: string;
  isbn: string;
  bookCoverUrl: string;
  newListingsCount: number;
  created_at: string;
  /** When the request lapses (ISO); null = never. */
  expires_at: string | null;
}

/** GET /api/v1/courses item: one course at a school (spellings merged). */
export interface CourseDto {
  key: string;
  name: string;
  /** Active listings. */
  listingCount: number;
  bookCount: number;
  /** Students waiting for a book for this course. */
  wantCount: number;
  wanted: boolean;
}

export interface CourseBookDto {
  id: string;
  title: string;
  authors: string;
  isbn: string;
  coverUrl: string;
  /** Active listings now; 0 for a book only past students sold. */
  activeCount: number;
  minPrice: number | null;
}

/** GET /api/v1/courses/detail. */
export interface CourseDetailDto {
  key: string;
  name: string;
  wantCount: number;
  wanted: boolean;
  professors: string[];
  books: CourseBookDto[];
}

/** GET/POST /api/v1/courses/wants item. */
export interface CourseWantDto {
  id: string;
  name: string;
  /** School code. */
  school: string;
  created_at: string;
  /** When the request lapses (ISO); null = never. */
  expires_at: string | null;
}
