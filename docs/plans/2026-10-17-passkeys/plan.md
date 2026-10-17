---
status: done
---
# Passkeys (WebAuthn) with @simplewebauthn/server

## Goal
Let a signed-in user register passkeys, and let anyone sign in with one
(discoverable credential, no email typed). Passkeys are a third sign-in method
beside password and Google; they issue the same cookie session
(`setSession(c, await issueTokens(c.env, user.id))`).

## Decisions
- **Library**: `@simplewebauthn/server` (server, latest major) and
  `@simplewebauthn/browser` (client, same major). Both run on Workers
  (WebCrypto, no Node-only APIs). Pin to latest; adapt code to its API, no downgrades.
- **RP**: `rpID` = hostname of the request origin, `expectedOrigin` = request
  origin (`new URL(c.req.url).origin`), `rpName` = "UniBooks". Same origin as the
  app and API, so no config var. Local dev (`localhost`) works as-is.
- **Challenges**: KV, key `webauthn:chal:<id>`, JSON `{ challenge, type: 'reg'|'auth', userId? }`,
  TTL 120 s. `<id>` = `crypto.randomUUID()`, returned to the client as `challenge_id`
  and echoed on verify. Verify does `get` then `delete`; a missing/mismatched
  type/user → 400 `auth.errPasskeyChallenge`. (Replay is also bounded by the
  signature covering the challenge and the counter check.)
- **Registration**: `residentKey: 'required'`, `userVerification: 'required'`,
  `attestationType: 'none'`, `excludeCredentials` = the user's existing ones.
  WebAuthn user handle = the user's id bytes.
- **Authentication**: discoverable (`allowCredentials` empty), `userVerification: 'required'`.
  Look up the credential by id → user; then the same gate as password login:
  `accountDisabled(user)` → 403 `auth.errAccountDisabled`. Update counter and
  `last_used_at`; `touchLastLogin`.
- **Last-method guard**: deleting a passkey is refused (409 `acct.errLastSignInMethod`)
  when the user has no password, no `googleId`, and it is their last passkey.
- **Abuse**: `rateLimit('passkey-login', '10/min')` on login options+verify,
  `rateLimit('passkey-register', '10/hour')` on registration, the existing
  `sameOriginGuard` covers CSRF.

## Data (D1 `unibooks`)
New migration `0004_passkeys.sql` (generate with `npm run db:generate` after editing
`server/src/db/schema.ts`) adding:

```
passkeys(
  id            text primary key,      -- credential id, base64url
  user_id       text not null references users(id) on delete cascade,
  public_key    text not null,         -- COSE key, base64url
  counter       integer not null default 0,
  transports    text,                  -- JSON array or null
  device_type   text not null,         -- 'singleDevice' | 'multiDevice'
  backed_up     integer not null default 0,
  name          text not null,         -- user label, default from UA/"Passkey"
  created_at    text not null,
  last_used_at  text
)
index passkeys_user_idx on (user_id)
```
Account deletion must also remove the user's passkeys (cascade covers hard delete;
check the soft-delete/anonymize path in `services/accounts/users.ts` and delete rows there).

## API (`server/src/routes/accounts.ts`, mounted at `/api/v1/auth/`; logic in new `server/src/services/accounts/passkeys.ts`)
| Method / path | Auth | Purpose |
|---|---|---|
| POST `/passkeys/register/options/` | yes | `generateRegistrationOptions` → `{ challenge_id, options }` |
| POST `/passkeys/register/verify/` | yes | body `{ challenge_id, response, name? }` → `verifyRegistrationResponse`, insert row → 201 `{ id, name }` |
| POST `/passkeys/login/options/` | no | `generateAuthenticationOptions` → `{ challenge_id, options }` |
| POST `/passkeys/login/verify/` | no | body `{ challenge_id, response }` → `verifyAuthenticationResponse`, `setSession` → `{ code:'auth.loginSuccess', user_id }` |
| GET `/passkeys/` | yes | list `{ id, name, created_at, last_used_at, device_type, backed_up }` |
| PATCH `/passkeys/:id/` | yes | rename (own only) |
| DELETE `/passkeys/:id/` | yes | delete (own only, last-method guard) |

Errors use `apiError(status, 'auth.errPasskey…')` keys; add to all locale files.
Registration verify failures → 400 `auth.errPasskeyRegistration`; authentication
unknown credential or failed verify → 401 `auth.errPasskeyLogin` (never reveal which).

## Client (`client/`)
- `npm i @simplewebauthn/browser` in `client/`.
- `AuthStore`/an `auth` service: `passkeyLogin()` (options → `startAuthentication` → verify),
  `passkeyRegister(name?)`, list/rename/delete. Feature-detect with `browserSupportsWebAuthn()`;
  hide the UI when unsupported. User-cancel (`NotAllowedError`) is silent.
- Login page (`features/auth/login.ts`): "Sign in with a passkey" button under the Google button.
- Account settings: a "Passkeys" section (list, add, rename, remove). Reuse existing account-settings layout and i18n mechanism; every user-facing string gets keys in every locale file.

## Tests (`server/test/accounts/`, vitest; client specs next to the code)
- Options endpoints: auth required for register, public for login; challenge stored with TTL.
- Verify: unknown/consumed/wrong-type `challenge_id` → 400; consumed challenge cannot be reused.
- Library verify calls are mocked (`vi.mock('@simplewebauthn/server')` partial) to exercise
  our logic: row inserted/counter updated, session cookies set, disabled/banned user → 403.
- List/rename/delete are scoped to the owner; last-method guard.
- Client: store/service spec with `@simplewebauthn/browser` mocked.

## Done when (run, read output)
- `cd server && npm run typecheck && npm test && npm run format:check` all pass.
- `cd client` its type-check/test/lint scripts (see `package.json`, `client/CLAUDE.md`) pass.
- Migration `0004_passkeys.sql` + `meta` snapshot present and applies via `npm run predev` locally.

## Out of scope
Passkey-gated sensitive actions, conditional UI (autofill), attestation verification, backup-eligibility policy.

## Addendum A: automatic passkey name and icon (2026-10-17)
Source: community AAGUID list, `combined_aaguid.json` from
https://github.com/passkeydeveloper/passkey-authenticator-aaguids (`{ <aaguid>: { name, icon_light, icon_dark } }`,
icons are base64 data URIs, 7 MB total).
- **Build-time fetch, nothing committed**: `client/scripts/fetch-passkey-icons.js`, wired in front of every
  client build script that produces `dist` (see `client/package.json`; `build:local` too). It downloads the JSON
  from a URL pinned to a commit SHA (constant at the top of the script), decodes every icon into
  `client/public/passkey-icons/<aaguid>.light.<ext>` / `.dark.<ext>` (ext from the data-URI mime: svg/png),
  and writes `client/public/passkey-icons/names.json` = `{ <aaguid>: { name, light, dark } }` (file names, no data).
  The folder is in `.gitignore`. A failed download never fails the build: log a warning, write an empty
  `names.json` (`{}`), continue. Reuse the downloaded copy if it is less than a day old (cache in `client/.cache/`, gitignored).
- **D1**: add nullable `aaguid text` to `passkeys` (migration `0005_passkey_aaguid.sql` via `npm run db:generate`);
  store `registrationInfo.aaguid` on register.
- **Server lookup** (`services/accounts/passkeys.ts`): `loadCatalogue(env)` fetches `/passkey-icons/names.json`
  through the `ASSETS` binding (`env.ASSETS.fetch(new URL('/passkey-icons/names.json', origin))`), caches the parsed
  result in a module variable for the isolate, returns `{}` on any failure. Tests mock `ASSETS`.
- **Default name** when the user gave none: catalogue name for the aaguid; else by `deviceType`/transports:
  multiDevice → "Passkey (synced)", `usb`/`nfc` → "Security key", else "Passkey". Renaming still works.
- **List API** items gain `aaguid`, `provider` (catalogue name or null), `icon_light`, `icon_dark` (site-relative paths
  like `/passkey-icons/<aaguid>.light.svg`, or null). Same-origin images, so no CSP change.
- **Client**: each row shows the icon in a 28 px `<picture>` (dark source with `prefers-color-scheme: dark`, then light);
  generic key SVG when null or on `error`. `provider` as a secondary line when it differs from the label.
- iCloud Keychain reports an all-zero AAGUID under `attestation: 'none'`: it falls back to "Passkey (synced)". Accepted.

## Addendum B: passkey button hidden by default, browser autofill (2026-10-17)
Browsers do not reveal whether a site has a passkey, so:
- **Login button** shown only when `localStorage['ub_passkey'] === '1'` (try/catch around storage). The flag is set after a
  successful passkey login or registration on this browser. Keep supportsPasskeys() as an additional condition.
- **Conditional UI**: login email input gets `autocomplete="username webauthn"`. On the login view, if
  `PublicKeyCredential.isConditionalMediationAvailable()` is true, call
  `startAuthentication({ optionsJSON, useBrowserAutofill: true })` with options from `/auth/passkeys/login/options`
  once when the view opens. When it resolves, post to `/auth/passkeys/login/verify` like the button does and set the flag.
  Abort it (AbortController; simplewebauthn's own abort handling) when the view is destroyed, when the register tab is
  shown, and before a manual passkey click. `NotAllowedError`/abort is silent.
- Specs for: button hidden without the flag, shown with it; flag set after login; conditional flow started only when available.

## Done when (Addenda A and B)
Server `typecheck`, `test`, `format:check` pass; client tests and `npx tsc --noEmit -p tsconfig.app.json` pass;
`npm run predev` applies 0005 locally; `cd server && npm run build:fe:local` succeeds and
`client/dist/unibooks/browser/passkey-icons/names.json` exists.
