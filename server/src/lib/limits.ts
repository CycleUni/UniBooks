/**
 * Central system-wide upper limits on user text and numeric fields.
 * Keep in sync with client/src/app/core/limits.ts (enforced by client/src/app/core/limits.spec.ts).
 */

export const LIMITS = {
  // Money / price
  price: 999999,

  // Course & professor
  courseName: 100,
  professorName: 100,

  // Books
  bookTitle: 255,
  bookAuthors: 512,
  bookPublisher: 255,
  bookPublishedDate: 50,

  // Listings
  listingDescription: 2000,
  listingPrivateNote: 1000,

  // Orders & Meetup
  meetupLocation: 200,
  cancelReason: 500,
  reviewComment: 1000,

  // Moderation / reports
  reportDetail: 2000,
  bookReportDetail: 1000,

  // Schools & requests
  schoolRequestName: 100,
  schoolRequestWebsite: 500,
  schoolName: 255,
  schoolCode: 20,

  // Admin
  adminNote: 2000,
  lockReason: 255,

  // User profile
  personName: 150,
  passkeyName: 150,
  pushToken: 512,

  // Categories & Departments
  categoryTitle: 100,
  categorySlug: 50,
  categoryDescription: 255,
  departmentName: 100,
  departmentAlias: 50,

  // Regions
  regionName: 100,
  regionCode: 2,

  // Chat
  chatMessage: 4000,

  // Ads
  adCompanyName: 255,
  adContactPhone: 50,
  adTitle: 255,
  adHeadline: 255,
  adSubheadline: 255,
  adTargetUrl: 500,
  adImageUrl: 500,
  adLabel: 15,
  adSlotIndex: 200,
} as const;

export type Limits = typeof LIMITS;

export const PRICE_MIN = 0;
export const PRICE_MAX = LIMITS.price;
export const COURSE_NAME_MAX_LENGTH = LIMITS.courseName;
export const PROFESSOR_NAME_MAX_LENGTH = LIMITS.professorName;
export const BOOK_TITLE_MAX_LENGTH = LIMITS.bookTitle;
export const BOOK_AUTHORS_MAX_LENGTH = LIMITS.bookAuthors;
export const BOOK_PUBLISHER_MAX_LENGTH = LIMITS.bookPublisher;
export const BOOK_PUBLISHED_DATE_MAX_LENGTH = LIMITS.bookPublishedDate;
export const LISTING_DESCRIPTION_MAX_LENGTH = LIMITS.listingDescription;
export const LISTING_PRIVATE_NOTE_MAX_LENGTH = LIMITS.listingPrivateNote;
export const MEETUP_LOCATION_MAX_LENGTH = LIMITS.meetupLocation;
export const CANCEL_REASON_MAX_LENGTH = LIMITS.cancelReason;
export const REVIEW_COMMENT_MAX_LENGTH = LIMITS.reviewComment;
export const REPORT_DETAIL_MAX_LENGTH = LIMITS.reportDetail;
export const SCHOOL_REQUEST_NAME_MAX_LENGTH = LIMITS.schoolRequestName;
export const SCHOOL_REQUEST_WEBSITE_MAX_LENGTH = LIMITS.schoolRequestWebsite;
export const SCHOOL_NAME_MAX_LENGTH = LIMITS.schoolName;
export const SCHOOL_CODE_MAX_LENGTH = LIMITS.schoolCode;
export const ADMIN_NOTE_MAX_LENGTH = LIMITS.adminNote;
export const LOCK_REASON_MAX_LENGTH = LIMITS.lockReason;
export const PERSON_NAME_MAX_LENGTH = LIMITS.personName;
export const PASSKEY_NAME_MAX_LENGTH = LIMITS.passkeyName;
export const PUSH_TOKEN_MAX_LENGTH = LIMITS.pushToken;
export const CATEGORY_TITLE_MAX_LENGTH = LIMITS.categoryTitle;
export const CATEGORY_SLUG_MAX_LENGTH = LIMITS.categorySlug;
export const CATEGORY_DESCRIPTION_MAX_LENGTH = LIMITS.categoryDescription;
export const DEPARTMENT_NAME_MAX_LENGTH = LIMITS.departmentName;
export const DEPARTMENT_ALIAS_MAX_LENGTH = LIMITS.departmentAlias;
export const REGION_NAME_MAX_LENGTH = LIMITS.regionName;
export const REGION_CODE_MAX_LENGTH = LIMITS.regionCode;
export const CHAT_MESSAGE_MAX_LENGTH = LIMITS.chatMessage;
export const AD_COMPANY_NAME_MAX_LENGTH = LIMITS.adCompanyName;
export const AD_CONTACT_PHONE_MAX_LENGTH = LIMITS.adContactPhone;
export const AD_TITLE_MAX_LENGTH = LIMITS.adTitle;
export const AD_HEADLINE_MAX_LENGTH = LIMITS.adHeadline;
export const AD_SUBHEADLINE_MAX_LENGTH = LIMITS.adSubheadline;
export const AD_TARGET_URL_MAX_LENGTH = LIMITS.adTargetUrl;
export const AD_IMAGE_URL_MAX_LENGTH = LIMITS.adImageUrl;
export const AD_LABEL_MAX_LENGTH = LIMITS.adLabel;
export const AD_SLOT_INDEX_MAX = LIMITS.adSlotIndex;
