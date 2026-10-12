---
status: done
owner: claude (unattended run, 2026-10-13)
---

# UniBooks → single Cloudflare Worker (Hono) — plan & progress

**RESUME HERE after an interruption:** read this file top to bottom, then continue
with the first unchecked item in "Work queue". Update the checkboxes and the
"Log" section as each item lands. Old reference code (read-only):
`/Users/kenchou2006/Documents/GitHub/UniBooks-Old` (Django BE, CFEdgeChat, ISBNnet).

## Requirements (from the user, 2026-10-13)
1. Finish interrupted work (security-review fixes).
2. Full feature parity: frontend, backend, chat. Mailjet email. Search identical to
   Django (external APIs + DB queries, every search field). Region settings etc.
   List every site feature, then browser-test each (admin included).
3. Env vars: copied by user into `server/.dev.vars`; fill gaps from UniBooks-Old.
4. Move the frontend into `client/` after testing; remove the submodule reference
   (FE git history stays separate: back up its `.git`, don't import it).
5. One Worker project. Pages → Workers Static Assets (done). Same origin →
   **auth in HttpOnly cookies** (no tokens in JS storage).
6. Architecture choices (Angular CSR SPA? FE↔BE wiring): consult `agy`
   (gemini-3.8-flash) via CLI, then decide (industry best practice).
7. Remove `server/legacy`; backend should read as a clean Hono project, not a port.
8. wrangler.jsonc: no hard-coded D1/KV ids (let wrangler provision by name).
9. Chat paths: `/api/chat/...` instead of `/ws/...` (after the move to client/).
10. Drop FRONTEND_URL; APP_ORIGINS only if really needed.
11. Keep requests that don't need the Worker off it (run_worker_first minimal).
12. Chat keeps DO sharding (room DO + per-user hub DO). Split D1 into main + ads.
    Ad view/click analytics → Workers Analytics Engine (no per-hit DB writes).
13. Well-designed KV caching.
14. ISBNnet via service binding instead of cross-site HTTP (fallback to URL).
15. Commit when done — **no Co-Authored-By trailer**. Don't push.
16. Final: best practice / security / stability / scalability review; write the
    Django Postgres → D1 data migration guide (keep users + books/listings; drop
    passwords and chat messages).
17. Budget: few subagents at a time; small tasks → sonnet subagent or `agy`.

## Decisions
- API contract = Django's (paths with trailing slash, `{error:{code}}`), so the
  Angular app needs only the auth/chat changes listed here.
- Auth cookies: `ub_at` (access, HttpOnly, Secure, SameSite=Lax, Path=/api),
  `ub_rt` (refresh, HttpOnly, Secure, SameSite=Strict, Path=/api/v1/auth),
  plus a non-HttpOnly `ub_session=1` hint so the SPA knows it is signed in.
  CSRF: unsafe methods require same-origin `Origin` (or `Sec-Fetch-Site: same-origin`).
- No CORS middleware at all (single origin; dev uses the Angular proxy).
- Email/cron links: origin from the request; queue/cron use the canonical origin
  recorded in KV by `lib/origin.ts` (no FRONTEND_URL var).

## Work queue
- [x] Phase A foundation, Phase B module ports, Phase C first integration (186 tests).
- [x] Security review 1 fixes: M-1 pre-registration hijack, M-2 no-show abuse,
      M-3 order spam, L-1 per-account login limit, L-4 Google sub check,
      L-5 lookup/cover rate limits, L-6 review length.
- [x] Security review 2 fixes (non-ads): H-2 cron IN-list (lib/sql inList + json_each
      everywhere), M-1 school domain normalisation, M-2 subscription rate limit + cap +
      checksum, M-3 search q cap, L-1/L-2 serializer, L-3 text caps, L-4 cover URLs, L-8 healthz.
- [x] Ads → DB_ADS + Analytics Engine + H-1 + M-4 + KV cache for active ads (204 tests green).
- [x] Consult agy on architecture; decisions recorded below.
- [x] server/legacy removed; utils→lib, cron→src/jobs, queues renamed, dead code removed, noUnusedLocals, Sentry wired.
- [x] Migration-trace comments rewritten (73 files); prettier config + format scripts.
- [x] wrangler.jsonc: no ids; DB_ADS; AD_EVENTS; ISBNNET service binding (+URL fallback);
      FRONTEND_URL/APP_ORIGINS/CORS removed (lib/origin.ts); run_worker_first = /api/*, /*/book.
- [x] Cookie auth server side (lib/session.ts, sameOriginGuard, tests) — client side pending.
- [x] KV cache layer lib/cache.ts (versioned namespaces): regions, metadata, courses, sitemap pages; admin ref writes invalidate.
- [x] UniBooks-FE → client/ (git history backed up at ../UniBooks-FE-git-backup), submodule removed; server chat → /api/chat/*.
- [x] Client: cookie auth + /api/chat paths + proxy (1052 client tests green; i18n contract checks now read ../server/src).
- [x] Feature inventory + browser/API test pass (see features.md). Bugs found & fixed: ISBNnet 5xx fallback, datetime offset label, queue names, entry-module export crash, 16 missing i18n codes.
- [x] Data migration guide docs/migrate-from-django.md + server/scripts/import-django.ts (8 tests, applied to local D1).
- [x] Final review: M-1 origin KV fail-open, M-2 validated cache keys + rate limits, M-3 hub socket expiry, L-1 cookie clear on refused refresh, L-2 best-effort logout, L-4 per-request pagination links, L-5 origin flip-flop, L-6 resolver URL/redirects, L-7 chat header allowlist + 16 KB cap, L-8 Vary, L-10 docs. Left by design: L-3 (grace pair in D1 ≤60 s, purged by cleanup), L-9 (15-min access tokens).
- [x] Verified: server tsc 0 / 211 tests / prettier / audit 0; client 1052 tests; dry-run bundle OK. Committed.
- [x] Root CI (.github/workflows/ci.yml): server typecheck/format/test/import self-test, client test/build, wrangler dry-run bundle.

## Architecture decisions (after agy consult, 2026-10-13)
- Stay Angular CSR SPA + prerendered region shells + edge meta injection (agy agrees).
- Keep REST contract (Hono RPC would rewrite every Angular service; not worth it now).
- Cookies: __Host-ub_at (access, Lax, Path=/), __Secure-ub_rt (refresh, Strict,
  Path=/api/v1/auth/), ub_session hint. CSRF = Sec-Fetch-Site/Origin guard.
  Chat keeps room-scoped tokens over the WS subprotocol (minted via cookie auth).
- Main data stays in one D1; ads in DB_ADS; Hyperdrive+Postgres when main D1 nears
  6–7 GB; no DO sharding for relational data. Ad events → Analytics Engine, uniques
  counted at query time from a hashed client id (no dedupe writes).
- ISBNnet: fetch service binding (resolver unchanged), HTTPS fallback.
- IDs omitted per user (agy preferred explicit ids — mention trade-off in report).
- Chat under /api/chat/* so only /api/* and /*/book run the Worker.
- Move FE to client/ BEFORE the cookie/chat FE refactor (it already passed build,
  1016 unit tests and a browser smoke run); full browser test happens on client/.

## Notes for the final report
- Mailjet: test with SandboxMode (MAILJET_SANDBOX=1) to avoid real sends to fake addresses.
- .dev.vars: appended local R2_PUBLIC_URL override; retired APP_ORIGINS/FRONTEND_URL/CRON_SECRET.
- Deploy order: `wrangler deploy` (provisions D1/KV/R2/Queues by name) then remote migrations.

## Log
- 2026-10-13: final verification green; MAILJET_SANDBOX removed from .dev.vars; committed.
- 2026-10-13: tests: 41 accounts green after cookie auth; frontend route tests fail until client/ is built.
- 2026-10-13: dev vars filled from UniBooks-Old (GOOGLE_BOOKS_API_KEY,
  ISBNNET_RESOLVER_URL, EDGE_CHAT_JWT_SECRET). Accounts 39/39, orders 15/15 green.
