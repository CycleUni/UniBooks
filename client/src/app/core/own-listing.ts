/** Whether the signed-in user is the listing's seller. `seller` is the
 *  seller's user id as ListingSerializer sends it; ids are compared as
 *  strings because the profile and the listing do not agree on the type. */
export function isOwnListing(seller: string | number | null | undefined, userId: string | number | null | undefined): boolean {
  return userId != null && seller != null && String(seller) === String(userId);
}
