import { of } from 'rxjs';
import { uploadImage } from './upload';

describe('uploadImage', () => {
  it("asks for a ticket with the blob's own type and size, PUTs the bytes, and returns photo_url", () => {
    const ticket = {
      upload_url: '/api/v1/listings/uploads/file/?token=t',
      photo_url: 'https://cdn.example/tmp/a.webp',
    };
    const http = { post: vi.fn(() => of(ticket)), put: vi.fn(() => of(null)) };
    const blob = new Blob(['abcd'], { type: 'image/webp' });
    let result: { url: string } | undefined;

    uploadImage(http as any, '/listings/uploads/', blob, { conversation_id: 'c1' }).subscribe(
      (r) => (result = r),
    );

    expect(http.post).toHaveBeenCalledWith('/listings/uploads/', {
      conversation_id: 'c1',
      content_type: 'image/webp',
      content_length: 4,
    });
    expect(http.put).toHaveBeenCalledWith(ticket.upload_url, blob, {
      headers: { 'Content-Type': 'image/webp' },
    });
    expect(result).toEqual({ url: ticket.photo_url });
  });
});
