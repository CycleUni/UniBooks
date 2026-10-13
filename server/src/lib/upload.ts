import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { apiError } from './http';
import { declaredType, readCapped } from './body';
import { InvalidTokenError, signToken, verifyToken, type UploadTokenPayload } from './jwt';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, newObjectName, publicUrl, sniffImage, validatedContentLength, type ImageExt } from './media';

/**
 * Image uploads, the same two steps for every feature (listing photos, chat
 * images, ad images):
 *
 *   1. POST <base>/uploads/ {content_type, content_length}: the route checks
 *      the caller may upload, then `issueUpload` signs an upload token that
 *      fixes the storage key, the type and the maximum size, and answers
 *      {upload_url: <base>/uploads/file/?token=…, photo_url}.
 *   2. PUT <base>/uploads/file/?token=…: `storeUpload` checks the bytes
 *      against the token and their magic bytes and writes them, once.
 *
 * The token is the PUT's whole authority: it names one key under the
 * uploader's own prefix, so it can neither overwrite nor reach anything else.
 */

type Action = UploadTokenPayload['action'];

/** Uploads are named by the server, so every stored object is immutable. */
const STORED_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const origin = (c: Context<AppEnv>) => new URL(c.req.url).origin;

/**
 * Store `bytes` at `key` only if nothing is stored there yet, in one
 * conditional write (If-None-Match: *), so two racing PUTs with the same
 * upload token cannot both succeed. False when the key already existed.
 */
export async function putOnce(r2: R2Bucket, key: string, bytes: Uint8Array, httpMetadata: R2HTTPMetadata): Promise<boolean> {
  const stored = await r2.put(key, bytes, { httpMetadata, onlyIf: new Headers({ 'If-None-Match': '*' }) });
  return stored !== null;
}

/**
 * Step one, after the route's own checks: validate the declared type and
 * size and answer with where to PUT the bytes. `keyPrefix` is the
 * uploader's own folder (ending in '/'), e.g. `tmp/listings/<userId>/`.
 */
export async function issueUpload(
  c: Context<AppEnv>,
  opts: { action: Action; userId: string; keyPrefix: string; base: string },
  body: Record<string, unknown>,
): Promise<Response> {
  const contentType = typeof body.content_type === 'string' ? body.content_type : '';
  const ext = IMAGE_TYPES[contentType];
  if (!ext) apiError(400, 'upload.errUnsupportedType');
  const size = validatedContentLength(body.content_length);
  if (size === null) apiError(400, 'upload.errTooLarge');

  const key = `${opts.keyPrefix}${newObjectName(ext)}`;
  const token = await signToken(
    'upload',
    { user_id: opts.userId, action: opts.action, target_key: key, content_type: contentType, max_bytes: size },
    c.env.JWT_SIGNING_KEY,
  );
  const uploadUrl = new URL(`${opts.base}uploads/file/`, c.req.url);
  uploadUrl.searchParams.set('token', token);
  return c.json({ upload_url: uploadUrl.toString(), photo_url: publicUrl(c.env, origin(c), key) });
}

/**
 * Step two. `keyPrefix(userId)` must match the prefix step one used.
 * `caller`, when given, must be the token's user (routes that are also
 * session-authenticated bind the token to the signed-in user).
 */
export async function storeUpload(
  c: Context<AppEnv>,
  opts: { action: Action; keyPrefix: (userId: string) => string; caller?: string },
): Promise<Response> {
  let claims: UploadTokenPayload;
  try {
    claims = await verifyToken('upload', c.req.query('token') ?? '', c.env.JWT_SIGNING_KEY);
  } catch (e) {
    if (e instanceof InvalidTokenError) apiError(403, 'upload.errTokenInvalid');
    throw e;
  }
  const ext: ImageExt | undefined = IMAGE_TYPES[claims.content_type];
  if (
    claims.action !== opts.action ||
    !claims.target_key.startsWith(opts.keyPrefix(claims.user_id)) ||
    (opts.caller !== undefined && claims.user_id !== opts.caller) ||
    !ext
  ) {
    apiError(403, 'upload.errTokenInvalid');
  }
  if (declaredType(c.req.raw) !== claims.content_type) apiError(400, 'upload.errUnsupportedType');

  const bytes = await readCapped(c.req.raw, Math.min(Number(claims.max_bytes) || 0, MAX_IMAGE_BYTES));
  if (bytes === null) apiError(400, 'upload.errTooLarge');
  if (bytes.byteLength === 0) apiError(400, 'upload.errEmpty');
  if (sniffImage(bytes) !== ext) apiError(400, 'upload.errUnsupportedType');

  // One upload per token: a replay must never swap the image behind a URL
  // that is already in use (a sent chat image, a saved listing photo).
  const stored = await putOnce(c.env.R2, claims.target_key, bytes, {
    contentType: claims.content_type,
    cacheControl: STORED_CACHE_CONTROL,
  });
  if (!stored) apiError(409, 'upload.errTokenUsed');
  return c.json({ photo_url: publicUrl(c.env, origin(c), claims.target_key) });
}

/** Rate limit for asking to upload a file. */
export const UPLOAD_RATE = '100/hour';
