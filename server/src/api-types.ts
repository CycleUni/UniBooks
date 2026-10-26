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
}
