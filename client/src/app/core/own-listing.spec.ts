import { isOwnListing } from './own-listing';

describe('isOwnListing', () => {
  it('matches a numeric seller id against a string user id', () => {
    expect(isOwnListing(7, '7')).toBe(true);
  });

  it('is false for someone else, and while signed out', () => {
    expect(isOwnListing(7, 8)).toBe(false);
    expect(isOwnListing(7, null)).toBe(false);
    expect(isOwnListing(undefined, undefined)).toBe(false);
  });
});
