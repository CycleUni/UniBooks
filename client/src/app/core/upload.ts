import { HttpClient } from '@angular/common/http';
import { Observable, map, switchMap } from 'rxjs';

/**
 * Image uploads are two steps, the same for listing photos, chat images and
 * ad images:
 *   1. POST `<base>/uploads/` with the type and size → `{upload_url, photo_url}`.
 *      `upload_url` is `<base>/uploads/file/?token=…` on this origin; the
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
          .put(ticket.upload_url, blob, { headers: { 'Content-Type': blob.type } })
          .pipe(map(() => ({ url: ticket.photo_url }))),
      ),
    );
}
