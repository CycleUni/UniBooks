# UniBooks

大學二手教科書交易平台（台灣 / 香港）。整個網站是 **一個 Cloudflare Worker**：
同一個網域同時提供前端（Angular 靜態檔）、REST API 與即時聊天。

```
瀏覽器 ──► unibooks.app
            ├─ /、/tw/...、/hk/...、*.js、*.css ……  Workers Static Assets（不經過 Worker，不計請求數）
            ├─ /<region>/book?isbn=…               Worker：在 app shell 注入 OG meta（連結預覽）
            ├─ /api/v1/*                           Worker：Hono REST API
            └─ /api/chat/*                         Worker：聊天 WebSocket / REST → Durable Objects
```

| 目錄 | 內容 |
|---|---|
| `client/` | Angular 22 CSR SPA（PWA）。建置輸出 `client/dist/unibooks/browser` 即 Worker 的靜態資產 |
| `server/` | Hono Worker：`src/routes`（API）、`src/durable-objects`（ChatRoom / UserHub / OrderLock / RateLimiter）、`src/queues`（Mailjet 信件、FCM 推播）、`src/jobs`（排程）、`src/db`（D1 schema 與 migration） |
| `docs/` | 設計紀錄、[舊資料遷移指南](docs/migrate-from-django.md) |

## 使用的 Cloudflare 服務

| 用途 | 服務 | 綁定 |
|---|---|---|
| 主要資料（帳號、書籍、刊登、訂單、對話） | D1 `unibooks` | `DB` |
| 廣告主與廣告 | D1 `unibooks-ads`（與主資料分開，日後可獨立搬遷） | `DB_ADS` |
| 廣告曝光 / 點擊統計 | Workers Analytics Engine `unibooks_ad_events`（只寫事件，不寫資料庫） | `AD_EVENTS` |
| 圖片（刊登照片、聊天圖片、頭像、廣告） | R2 `unibooks-assets`，公開網域 `assets.unibooks.app` | `R2` |
| 快取、站點網址、外部書目查詢結果 | KV | `KV` |
| 聊天室（每個對話一個 DO，訊息存在 DO 的 SQLite）| Durable Objects `ChatRoom` | `CHAT_ROOM` |
| 每位使用者的未讀數與通知連線 | Durable Objects `UserHub` | `USER_HUB` |
| 訂單狀態轉換的鎖、排程互斥鎖 | Durable Objects `OrderLock` | `ORDER_LOCK` |
| 限流（原子計數） | Durable Objects `RateLimiter` | `RATE_LIMITER` |
| 信件（Mailjet）、推播（FCM） | Queues `unibooks-email`、`unibooks-push` | `EMAIL_QUEUE`、`PUSH_QUEUE` |
| 國圖 ISBN 查詢 | 另一個 Worker `isbnnet-resolver`（Service Binding，同機房內呼叫） | `ISBNNET` |
| 排程（候補通知、面交提醒、清理） | Cron Triggers | — |

D1 / KV / R2 / Queues 不在設定檔寫死 ID：第一次 `wrangler deploy` 時依名稱自動建立並綁定。

## 本機開發

需求：Node.js 22+、npm。

```bash
npm --prefix server install
npm --prefix client install
cp server/.dev.vars.example server/.dev.vars   # 填入本機用的密鑰（見下方）
```

```bash
npm --prefix server run start    # 建置前端 + 套用本機 D1 migration + wrangler dev（http://localhost:8787）
```

改前端時想要熱重載：另開終端機在 `client/` 執行 `npm start`（`ng serve` :4200，`/api` 由 `proxy.conf.json` 轉到 :8787，聊天 WebSocket 一併轉送）。

初始資料（地區、幣別、學校、分類）：

```bash
npm --prefix server run db:seed
```

本機觸發排程（`npm run dev` 已帶 `--test-scheduled`）：

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/30+*+*+*+*"   # 面交提醒；另有 0+*/6+*+*+*（候補通知）、0+3+*+*+*（清理）
```

測試：

```bash
npm --prefix server test          # Vitest（Workers runtime，D1/DO/KV 皆為本機模擬）
npm --prefix server run typecheck
npm --prefix client test -- --watch=false   # 含前後端錯誤碼 i18n 契約檢查（讀 ../server/src）
```

## 部署

```bash
npx --prefix server wrangler login
# 一次性設定密鑰（每個各輸入一次）
cd server
npx wrangler secret put SECRET_KEY               # 主金鑰：至少 32 字元的隨機字串，各用途的簽章金鑰由它推導
npx wrangler secret put MAILJET_API_KEY
npx wrangler secret put MAILJET_SECRET_KEY
npx wrangler secret put GOOGLE_BOOKS_API_KEY
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON   # 推播（可選）
npx wrangler secret put CF_ANALYTICS_TOKEN       # 廣告統計：Account Analytics Read 權限的 API token（可選）
npx wrangler secret put TURNSTILE_SECRET_KEY     # 登入人機驗證（可選；site key 填在 wrangler.jsonc vars 的 TURNSTILE_SITE_KEY）
npm run deploy    # 建置前端 → wrangler deploy（首次自動建立資源）→ 套用遠端 D1 migration
npm run db:seed:remote         # 首次部署後一次：地區、學校、分類
```

非機密設定（R2 公開網址、寄件者、Google Client ID、預設地區）在 `server/wrangler.jsonc` 的 `vars`，
這也是前後端共用值的唯一來源：前端建置（`client/scripts/set-env.js`）直接讀這裡的 `R2_PUBLIC_URL`、
`GOOGLE_CLIENT_ID`；本地開發則以 `server/.dev.vars` 覆蓋。只有前端用的值（GA、Sentry、CSP 是否強制）在
`client/production.env`。
`CF_ACCOUNT_ID`（廣告統計查詢用）可放在 `vars` 或 secret。
自訂網域：在 Cloudflare 後台把 `unibooks.app` 綁到 Worker `unibooks`。

### 超級使用者

權限只看 `users.role`：`user`（一般）、`staff`（區域管理員，只管 `staff_managed_regions` 指定的區域）、
`admin`（超級使用者：所有區域，以及地區、幣別、管理員設定）。後台 API 刻意不接受把人升為 `admin`，
避免後台帳號被盜時被拿來提權，所以超級使用者只能直接改 D1：

```bash
cd server
# 1. 先在網站上正常註冊並啟用該帳號（Email 或 Google 登入皆可）
# 2. 設為超級使用者（本機開發把 --remote 換成 --local）
npx wrangler d1 execute unibooks --remote --command "UPDATE users SET role = 'admin', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE email = 'you@example.com'"
# 3. 確認
npx wrangler d1 execute unibooks --remote --command "SELECT email, role FROM users WHERE role IN ('staff','admin')"
```

角色每次請求都從資料庫讀取，改完重新整理頁面即可，不必重新登入。之後的區域管理員（`staff`）可由超級使用者在
後台使用者頁面設定；新增或降級超級使用者仍用上面的 SQL（降級時把 `'admin'` 改成 `'staff'` 或 `'user'`）。
從舊 Postgres 匯入資料時，`is_superuser` / `is_staff` 會自動轉成 `admin` / `staff`（見 `docs/migrate-from-django.md`）。

## 安全設計摘要

- 登入狀態只存在 HttpOnly Cookie：`__Host-ub_at`（存取權杖，15 分鐘）、`__Secure-ub_rt`（更新權杖，14 天，只送往 `/api/v1/auth/`）。頁面上的 JavaScript 讀不到任何權杖。
- 所有改變狀態的請求必須同源（檢查 `Sec-Fetch-Site` / `Origin`），不需要 CORS。
- 只有一把主金鑰 `SECRET_KEY`：各種 JWT（存取、更新、上傳、聊天、hub）的 HMAC 金鑰都由它以 HKDF-SHA256 依用途分別推導，再加上 `token_type` 檢查，彼此互不通用；缺少或過短的主金鑰直接拒絕。輪替主金鑰會讓所有人登出（同 Django 的 `SECRET_KEY`）。
- 每個請求都從 D1 重新讀取帳號狀態（停權、降級立即生效）。
- 上傳一律兩段式且同源：`POST <base>/uploads/` 簽出短效上傳權杖，`PUT <base>/uploads/file/?token=` 由 Worker 寫入 R2；伺服器決定 R2 key、檢查檔案魔數與大小，刊登照片只接受本人上傳的 key。
- 限流以 Durable Object 原子計數（登入、註冊、驗證、搜尋、上傳、下單等）。
- 前端 CSP 由建置時產生（`client/scripts/set-env.js`），正式環境為強制模式。

## 擴充性備註

- D1 單一資料庫上限 10 GB。廣告已拆到獨立 D1、事件改用 Analytics Engine，主資料庫只剩交易資料。
- 主資料接近 6–7 GB 時，建議改用 Hyperdrive + Postgres（例如 Neon），而不是把關聯資料分片到 Durable Objects（搜尋、篩選、跨表查詢都需要關聯式資料庫）。
- 聊天訊息本來就分散在每個對話自己的 Durable Object，不佔 D1 空間。
