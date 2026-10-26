# Feature inventory and test checklist

Derived from the old backend's URL map, CFEdgeChat, the
ISBNnet resolver and the Angular routes (`client/src/app/app.routes.ts`). Every row
is tested in the browser against `wrangler dev` (launch config `unibooks`, port
8787) unless marked API. Mark `[x]` when verified; note the evidence.

Legend: B = browser test, A = API/curl test, U = covered by vitest.

Found & fixed during testing: ISBNnet binding 5xx fallback; datetime pipe offset label (+00:00 → local); queue dispatch names (emails were dropped); non-handler export from the entry module crashed the runtime.

## Site shell / region / i18n
- [x] B Home `/tw/`, `/hk/`: hero, recently added, categories, popular searches, ads banner
- [ ] B Region switch TW ↔ HK (prefix, currency, content changes); `/core/geo/` default
- [ ] B Language switch zh-TW / zh-HK / en (UI strings, `?lang=` on API calls)
- [ ] B Theme toggle, PWA manifest / service worker registers, offline page
- [ ] B 404 page; deep link reload on SPA routes (served from assets, no Worker)
- [ ] A `/robots.txt`, `/api/v1/sitemap.xml` + section pages, `/<region>/book?isbn=` OG meta
- [ ] A Security headers + CSP on HTML; `/api/cover?src=` proxy

## Accounts (`/api/v1/auth/*`)
- [x] B Register (UI) → activation email accepted by Mailjet sandbox (superseding a pending signup works)
- [x] B Login (cookies HttpOnly; JS sees only ub_session; no tokens in localStorage) — logout pending
- [ ] B Session refresh after access cookie expiry (single refresh, request retried)
- [ ] B Google sign-in button renders (real Google flow needs a browser login — A-test the endpoint)
- [x] A Forgot password → reset email accepted by Mailjet sandbox (zh-TW subject)
- [ ] B Account settings: names, avatar visibility, site language/region, email change (+cancel)
- [ ] B Password change; remove password (Google-linked only); delete account
- [x] A Campus email verification request → email accepted by Mailjet sandbox
- [ ] B School request form (unsupported school)
- [ ] B Notification settings; push device register (needs FCM config — A-test)
- [x] B Public seller profile shows ★5 (1)

## Catalogue / search / listings
- [x] B Search by keyword (5 external hits), by ISBN via ISBNnet service binding (TW book) and Open Library
- [ ] B Search filters: category, course, school, city fallback, condition, price, sort; facets; pagination
- [ ] B Course suggestions (`/search/courses/`), search suggestions
- [ ] B Book page `/tw/book?isbn=`: listings, price stats, waiting count, subscribe/unsubscribe
- [x] B Sell flow: ISBN lookup → condition/course/desc → photo upload (webp, own tmp prefix) → price → published
- [ ] B Listing page: photos, seller info, chat/checkout buttons; edit; mark sold; delete (blocked with open order)
- [x] B My listings with per-status counts
- [x] B Waitlist page renders; waitlist cron email (A)

## Messaging / chat
- [x] B Start conversation; inbox preview + listing photo + unread badge
- [x] B Real-time messages both ways (UI seller ↔ WS buyer) — image/delete pending
- [x] A Offline chat email when recipient's hub is closed (Mailjet sandbox)
- [x] B Meetup request card (live), accept with date/time picker, accepted card
- [ ] B Delete conversation; chat on removed listing is read-only

## Orders / reviews
- [x] B Order → accept → handover (UI) → complete (buyer) → listing sold, rating 5/1, sales 1
- [ ] B Cancel paths (buyer/seller, pending/accepted); listing reservation released
- [ ] B Review after completion; no-show report only when allowed; ratings on seller page
- [x] B My orders (sales tab shows completed order)
- [x] A Meetup reminder cron; cleanup cron

## Moderation
- [x] A Report a listing (reason validation), my reports page renders
- [x] A Report a chat; admin reads it with observer token (7 msgs), write refused 403 READ_ONLY_TOKEN

## Admin (`/admin/*`, staff; superuser where marked)
- [x] B Stats dashboard with real figures; all stats sub-pages 200
- [x] B Regions/currencies pages 200 (superuser); manager gets 403
- [x] B/A Users list/detail, deactivate (login 403) + reactivate, manager toggle with explicit is_staff
- [x] B/A Schools/school-requests pages; bulk import normalises domain, refuses gmail.com
- [x] A Category edit → public metadata updated immediately (KV ref cache invalidation)
- [x] B/A Admin listings/books pages; lock hides reason/staff id from public
- [x] B Admin orders list/detail 200 (force-cancel covered by tests)
- [x] A Reports + chat reports dismissed via admin
- [x] A Sponsor + promotion with image upload (tmp→ads promotion), live in public list immediately, view/click 204 → Analytics Engine, javascript: URL refused
- [x] A HK-only manager: 0 TW listings/orders, TW detail 404, TW stats 403, superuser routes 403

## Platform
- [x] A Email queue → Mailjet sandbox: activation, reset, campus verify, offline chat, waitlist, meetup reminder (per-recipient language)
- [ ] A Push queue (FCM) — skipped without service account; code path unit-tested
- [ ] A Rate limits (login, register, verify, search, upload, orders) return 429
- [x] A Cron: waitlist (1 user), meetup reminder (2 users), cleanup — via /cdn-cgi/handler/scheduled
