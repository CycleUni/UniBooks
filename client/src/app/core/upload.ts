import { HttpClient } from '@angular/common/http';
import { Observable, map, switchMap } from 'rxjs';

/**
 * Image uploads are two steps, the same for listing photos, chat images and
 * ad images:
 *   1. POST `<base>/uploads` with the type and size → `{upload_url, photo_url}`.
 *      `upload_url` is `<base>/uploads/file?token=…` on this origin; the
 *      token fixes the storage key, the type and the maximum size.
 *   2. PUT the bytes to `upload_url`. The server checks them against the
 *      token and their magic bytes, then `photo_url` is live.
 *
 * `content_length` must be the size of the body about to be PUT — the
 * compressed blob, not the file the user picked — or the PUT is refused.
 */
export interface UploadTicket {
  upload_url: string;
  photo_url: string;
}

export function uploadImage(
  http: HttpClient,
  ticketUrl: string,
  blob: Blob,
  extra: Record<string, unknown> = {},
): Observable<{ url: string }> {
  return http
    .post<UploadTicket>(ticketUrl, { ...extra, content_type: blob.type, content_length: blob.size })
    .pipe(
      switchMap((ticket) =>
        http
          .put(sameOriginUrl(ticket.upload_url), blob, { headers: { 'Content-Type': blob.type } })
          .pipe(map(() => ({ url: ticket.photo_url }))),
      ),
    );
}

/**
 * `upload_url` on the page's own origin. The server builds it from the host
 * it was asked on, which under `wrangler dev` is the production route's host,
 * not localhost: the PUT then left the page's origin and the CSP refused it.
 * Uploads are same-origin by design, so only the path and query are kept.
 */
export function sameOriginUrl(uploadUrl: string): string {
  try {
    const url = new URL(uploadUrl, window.location.origin);
    return `${window.location.origin}${url.pathname}${url.search}`;
  } catch {
    return uploadUrl;
  }
}
