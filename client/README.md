# UniBooks — 前端（UniBooks/client）

台灣大專院校二手教科書搜尋與媒合平台之前端。位於單一 Worker repo 的 `UniBooks/client`，
後端是同一個 repo 的 `../server`。

## 技術棧

- Angular（最新穩定版，standalone components）
- Angular（standalone components，CSR）
- Node 24 + npm
- 單元測試：vitest（不採 karma）
- 部署目標：由 `UniBooks/server` 那支 Cloudflare Worker 以 Workers Static Assets 提供
  （靜態資產 + PWA service worker）。App、API（`/api/v1`）與聊天室（`/api/chat`）同一個 origin。

## 渲染策略

全站 CSR（Client-side rendering），搭配 PWA service worker 提供離線能力。所有路由均 lazy-loaded。

## 開發

```bash
npm install
npm start        # 開發伺服器（ng serve，:4200）
npm test         # vitest 單元測試
npm run build    # 正式 production 建置（讀 production.env）
```

`npm start`（以及單純的 `ng serve`，`angular.json` 的 serve 已指定 `proxyConfig`）透過
`proxy.conf.json` 把整個 `/api` 轉發到 `http://localhost:8787`，也就是 server 的 `wrangler dev`。
只有這一條規則：`ws: true` 讓聊天室的 WebSocket（`/api/chat/...`）也走同一條，
`changeOrigin: false` 讓 Worker 看到的 Host 仍是 `localhost:4200`——後端組出的上傳網址
與 Session cookie 才會落在開發伺服器的 origin 上。
另開一個終端機：

```bash
npm --prefix ../server run dev  # 只起 Worker（API、聊天室、/api/cover、/<region>/book）
```

或者不用 ng serve，直接讓 Worker 連同這份前端一起跑（先建置前端再 `wrangler dev`）：

```bash
cd ../server && npm start       # = npm run build:fe && npm run dev，於 :8787
```

`npm run smoke` 用 smoke 設定（無 service worker）建置後同樣交給 `../server` 的 `npm run dev`。

### 書籍封面與 `/api/cover`

書封不直接連到 Google Books／Open Library，而是走同源的 `/api/cover` 代理
（`server/src/routes/frontend.ts` → `server/src/services/frontend/cover.ts`：
負責過濾兩邊 API 都會回 200 的假封面、zoom 逐級降級、以及長效 CDN 快取）。
分享連結預覽用的 `/<region>/book` 也在同一支 Worker
（`server/src/services/frontend/bookMeta.ts`），書籍資料直接在 Worker 內查 `/api/v1`，
只對啟用中的地區生效，其餘路徑交回靜態資產。

#### Cloudflare 快取規則設定（建議）
`/api/cover` 每次都會喚醒 Worker（`run_worker_first` 含 `/api/*`）。建議在 Cloudflare 後台
設定 Cache Rules，讓外層 CDN 依 `Cache-Control` 接管：

1. 登入 Cloudflare 後台，進入網域設定
2. 左側選單：**Caching (快取)** → **Cache Rules (快取規則)**
3. 建立新規則：`Cache Cover Images`
4. 條件 (If)：`URI Path` `starts with` `/api/cover`
5. 快取資格 (Cache eligibility)：`Eligible for cache`
6. 邊緣 TTL (Edge TTL)：`Use cache-control header if present`

詳細架構見 `docs/frontend-ssd.md`（位於上層 UniBooks 工作根目錄）。

---

## 🌍 地區首頁社群預覽標籤（Region Meta Tags）

社群軟體（LINE、Facebook、Discord 等）分享連結時，爬蟲**不會執行 JavaScript**，
因此 Angular 在瀏覽器端動態寫入的 `<title>` 與 `og:*` 標籤爬蟲看不見。

解法：`npm run build` 在 `ng build` 完成後，會執行
`scripts/build-region-html.ts` 為每個地區產出靜態 HTML，
並自動在部署包（`dist/`）的 `_redirects` 裡注入對應的路由規則：

- 固定的公開頁面（`SITEMAP_PAGES`：首頁、`/search`、`/sell`）各有一份檔案
  （`tw/index.html`、`tw/search.html`…），寫好該頁的 `<title>`、`og:*`、
  指向自己的 canonical，以及各地區互相指向的 hreflang。
  靜態資產伺服器會讓 rewrite 規則蓋過 HTML 檔，所以每個頁面都有一條指向自己的規則，排在地區規則前面。
- 其餘路由共用 `app-shell.html`，不含 canonical 與 hreflang
  （同一份檔案要回應很多路徑，寫死哪一頁都會錯），由前端的 `SeoService` 寫入。
  規則的目標不加 `.html`，否則會被轉址到不含 `.html` 的路徑。

```
/tw/  /tw/  200
/tw/search  /tw/search  200
/tw/sell  /tw/sell  200
…（hk 同上）
/tw/*  /tw/app-shell  200
/hk/*  /hk/app-shell  200
```

這樣爬蟲拿到的就是已寫好中文 `<title>`、`og:*` 與 hreflang 的 HTML，
這些路徑不在 `run_worker_first` 裡，由靜態資產直接回應，不會喚醒 Worker。
其餘路徑由 `wrangler.jsonc` 的 `not_found_handling: "single-page-application"` 回 `index.html`
（`_redirects` 裡不能再寫 `/*  /index.html  200`：Workers 會判定為無限迴圈而忽略）。

> **注意**：`public/_redirects`（原始檔）不含地區規則。地區規則由腳本在
> Build 時動態注入到 `dist/` 的 `_redirects`，**不要手動編輯原始檔的地區路由**。

### 新增地區

新增地區只需在 `src/app/core/i18n/index.ts` 的 `REGION_TO_LANG` 加入一行；
靜態 HTML、`lang`、`og:locale` 與 `_redirects` 規則會**全部自動處理**：

```ts
// src/app/core/i18n/index.ts
export const REGION_TO_LANG: Record<string, Lang> = {
  tw: 'zh-TW',
  hk: 'zh-HK',
  sg: 'en', // ← 新增地區只需一行
};
```

若是全新語言，才需要另外新增語言型別、翻譯檔與 lazy-load 設定。

---

## Google Analytics 4

站上的行為分析（搜尋、瀏覽、流量來源、活躍使用者）走 GA4；交易結果與金額則以
後台統計為準（資料庫），兩者分工見 `core/services/google-analytics.service.ts`。

### 啟用

在 `.env` 填入 `NG_APP_GA_MEASUREMENT_ID`（格式 `G-XXXXXXXXXX`）。留空時完全
不會載入追蹤碼，所有事件也不會送出。

### Sentry 錯誤回報

在 `.env` 填入 `NG_APP_SENTRY_DSN`（公開的上報位址，非機密）。留空時 Sentry 不啟用。
初始化在 `src/main.ts`，未處理的錯誤與路由效能由 `app.config.ts` 的 ErrorHandler / TraceService 回報；
CSP 的 `connect-src` 已由 `scripts/set-env.js` 放行 `*.ingest.us.sentry.io`。

### 送出的事件

| 事件 | 觸發時機 | 主要參數 |
|---|---|---|
| `search` | 搜尋有結果回來時 | `search_term`、`total_results`、`school` |
| `view_item` | 開啟商品頁 | `items[]`、`value`、`currency` |
| `view_book` | 開啟書本頁 | `item_id`、`listing_count`（0 代表無人上架） |
| `request_book` | 登記求書 | `item_id`、`source`（`book` / `search`） |
| `contact_seller` | 聯絡賣家 | `item_id` |
| `send_message` | 送出訊息 | `conversation_id` |
| `begin_checkout` | 進入結帳頁 | `items[]`、`value`、`currency` |
| `place_order` | 送出訂單（尚未成交） | `order_id`、`value`、`currency` |
| `order_accepted`／`order_handed_over` | 賣家同意／完成面交 | `order_id` |
| `purchase` | **買家確認收到**（才算成交） | `transaction_id`、`value`、`currency` |
| `cancel_order` | 取消訂單 | `order_id`、`cancel_reason` |
| `publish_listing` | 上架商品 | `item_category`、`item_condition`、`price` |
| `sign_up`／`login`／`sign_up_verified`／`verify_edu_request` | 註冊、登入、完成學校驗證 | — |
| `submit_review`、`report_listing`、`isbn_lookup`、`upload_listing_photo`、`click_buy_now`、`checkout_to_chat`、`scroll`（商品頁捲動深度） | 其他互動 | — |

兩個容易誤解的地方：

- **`purchase` 只在買家確認收到時送出**，送出訂單是 `place_order`。GA 的營收因此
  和後台的「成交金額」算同一件事，不會把待處理或後來取消的訂單算進去。
- **金額一律換算成該筆訂單幣別的「元」**（台幣無小數、港幣兩位小數），API 傳的是
  最小單位，服務層會自動換算。

每個事件都會帶 `region`（`TW` / `HK`），報表可分站查看。

### GA 後台需要自行建立的設定

事件送出後，還要在 GA4 後台建立對應的自訂定義，報表裡才看得到這些欄位：

1. **管理 → 自訂定義 → 自訂維度**（範圍皆為「事件」）

   | 維度名稱 | 事件參數 | 用途 |
   |---|---|---|
   | `region` | `region` | 分別查看台灣站與香港站 |
   | `listing_count` | `listing_count` | 找出有人看、卻沒人上架的書 |
   | `source` | `source` | 求書是從書本頁或搜尋頁登記 |
   | `school` | `school` | 搜尋時選擇的學校 |
   | `cancel_reason` | `cancel_reason` | 取消原因分布 |

2. **管理 → 自訂定義 → 自訂指標**

   | 指標名稱 | 事件參數 | 單位 |
   |---|---|---|
   | `total_results` | `total_results` | 標準（用來看搜尋零結果率） |

3. **探索 → 程序探索（漏斗）** 建議步驟：

   `search` → `view_item` → `contact_seller` → `place_order` → `order_accepted` → `order_handed_over` → `purchase`

自訂維度與指標只對**建立之後**送出的資料生效，先前的事件不會回溯。

## 📁 前端專案結構說明

### 1️⃣ Feature 資料夾 (Feature‑Folder Pattern)

```
src/app/
├─ features/                     # 每個「頁面」或功能一個子資料夾
│   ├─ home/                     # 首頁 – Hero、分類、最近上架、等候清單
│   │   ├─ home.component.ts
│   │   ├─ home.component.html
│   │   ├─ home.component.scss
│   │   └─ home.service.ts      # 只負責呼叫 ListingApi、MetadataApi、快取
│   ├─ search/                   # 搜尋結果與篩選
│   ├─ book/                     # 書本詳情頁面
│   ├─ account/                  # 註冊、登入、驗證、個人設定
│   ├─ sell/                     # 掛單表單、編輯、刪除
│   └─ messages/                 # 私訊列表與對話視窗
├─ shared/                       # 可重用 UI 元件
│   └─ ui/                       # button、badge、listing‑row、skeleton、layout …
├─ core/                         # 全局服務、拦截器、i18n、API 抽象層
│   ├─ api/                     # auth.api.ts、listing.api.ts、book.api.ts
│   ├─ auth.interceptor.ts
│   ├─ api‑url.interceptor.ts
│   └─ i18n.service.ts
├─ router/                       # 路由集中管理 (app.routes.ts, router.module.ts)
└─ app.config.ts                # providers、http client、PWA
```

- **Feature component** 均為 **standalone**，只在 `features/home/home.component.ts` 中 `import` 必要的 UI 元件與服務。
- 每個 feature 只保留 **UI 與簡易邏輯**，所有與後端交互都走 `src/app/core/api/` 包裝的 service，確保 UI 不直接依賴 HTTP。

### 2️⃣ 路由與懶載入

```ts
export const APP_ROUTES: Routes = [
  { path: '', component: HomeComponent },
  { path: 'search', loadComponent: () => import('../features/search/search.component').then(m => m.SearchComponent) },
  { path: 'book',   loadComponent: () => import('../features/book/book.component').then(m => m.BookComponent) },
  // …其他懶載入
];
```

- 所有路由在 `src/app/router/app.routes.ts` 統一定義。

### 3️⃣ API 抽象層與錯誤統一處理

- `src/app/core/api/*.api.ts` 僅負責 **HttpClient 請求 + 型別**，不處理 UI 邏輯。
- `src/app/core/api/http-error.interceptor.ts`（未在專案中但建議加入）會把所有 `HttpErrorResponse` 轉為全局 **Toast**，讓 UI 不必自行檢查錯誤。

### 4️⃣ UI 元件與可存取性

- 所有 UI 元件（button、badge、listing‑row、skeleton、layout）皆採用 **CSS 變數**（`var(--accent)`, `var(--muted)`）
- `ui-listing-row` 已改為 `alt="{{ title }}"`，提供螢幕閱讀器資訊。
- 互動元素（搜尋標籤、按鈕）使用 `<button>` 並加上 `aria-label`，避免 `javascript:void(0)`。
- `trackBy`、`tabindex`、鍵盤 `Enter` 事件已在元件中加入，提高列表渲染效能與可鍵入操作。

### 5️⃣ 狀態管理

- **登入狀態走 HttpOnly cookie**（`server/src/lib/session.ts`）：`__Host-ub_at`（access，15 分鐘）、
  `__Secure-ub_rt`（refresh，只送往 `/api/v1/auth/`），以及一個可讀、不是憑證的提示 cookie `ub_session=1`。
  頁面上的 JavaScript **完全拿不到 token**，localStorage／sessionStorage／記憶體都不存；
  舊版留在 localStorage 的 `access_token`／`refresh_token` 會在啟動時刪掉。
- **AuthStore**（signals）：有 `ub_session` 就先視為已登入並呼叫 `/auth/me/`，成功才有 `user()`。
  登入（`/auth/token/`、`/auth/google/`、`/auth/verify-registration/`）只看回應的
  `code: 'auth.loginSuccess'`，cookie 由瀏覽器自己收下。登出 `POST /auth/logout/` 由伺服器撤銷並清掉 cookie。
- **AuthInterceptor** 不附加任何 token。`/api/v1` 回 401（登入端點本身除外）時，送出**一次**
  共用的 `POST /auth/refresh/`（無 body，靠 refresh cookie），成功後重送原請求一次；
  refresh 被拒（401/403）就在本機登出，依 `signed-out-redirect.ts` 決定要不要離開目前頁面。
- **跨分頁同步**：`BroadcastChannel('ub-auth')` 廣播 `login`／`logout`（不支援時改用 localStorage 的
  `ub_auth_event` ping），訊息裡沒有任何 token。
- **聊天室**（`core/chat-urls.ts`）：以本頁 origin 組出 `/api/chat/hub`（WebSocket）、
  `/api/chat/rooms/<roomId>`（WebSocket）、`/api/chat/rooms/<roomId>/messages`、`/api/chat/rooms/<roomId>/read`；
  token 由 `/messaging/chat-token/`、`/messaging/hub-token/` 取得。房間／hub token 仍交給 JS
  （短效、只限該房間），HTTP 放 `Authorization: Bearer`，WebSocket 放在 subprotocol，不放進網址。
- **圖片上傳**（`core/upload.ts`）：刊登照片、聊天圖片、廣告圖都是兩段式——`POST <base>/uploads/` 取得
  `{upload_url, photo_url}`，再把（壓縮後的）檔案 PUT 到 `upload_url`（`<base>/uploads/file/?token=…`，同源）。
- 語系切換使用 **I18nService** + **TPipe**，所有文字皆走 `{{ 'key' | t }}`，語言變更時 `TPipe` 自動重新渲染。

### 6️⃣ 測試策略

| 種類 | 框架 | 目標 |
|------|------|------|
| 單元測試 | Vitest + Testing Library | 每個 UI 元件、Pipe、Service 的渲染與行為 |
| 整合測試 | Vitest (HttpTestingController) | API service 與 interceptor 的互動 |
| E2E 測試 | Playwright | 首頁 → 搜尋 → 書本 → 私訊 → 登入 → 登出 完整流程 |

執行測試：
```bash
npm test               # Vitest
npm run e2e           # Playwright
```

### 7️⃣ 部署流程

前端不單獨部署，是建置進 server Worker 一起上線：

1. **部署**：`cd ../server && npm run deploy`（先跑 `npm run build:fe` = 本專案的
   `npm run build`，產生 `dist/unibooks/browser/`，再套用 D1 migration 並 `wrangler deploy`；
   `wrangler.jsonc` 的 `assets.directory` 指向這個資料夾）。
2. **建置設定**：前後端共用的公開值（`R2_PUBLIC_URL`、`GOOGLE_CLIENT_ID`）只寫在
   `../server/wrangler.jsonc` 的 `vars`，`scripts/set-env.js` 直接讀取（本地 `npm start`／`npm test`
   再疊上 `../server/.dev.vars`），兩邊不會不一致。只有前端用的值（GA、Sentry、CSP 是否強制）
   在 `production.env`；正式建置不讀 `.env`。不需要 `NG_APP_BACKEND_URL`：預設就是同源的 `/api/v1`。
   `public/_headers`、`public/_redirects` 由 Workers Static Assets 照舊套用。
3. **安全設定**：`angular.json` production 中 `security.allowedHosts` 必須空白，避免跨域 400 錯誤。
4. **資源路徑**：`angular.json` 的 `deployUrl: "/"`，加上 `src/index.html` 內手寫的
   `/theme-init.js`、`/favicon.ico`、`/manifest.webmanifest`，讓 `index.html` 一律用絕對
   路徑引用資源。瀏覽器的預先載入掃描器會在套用 `<base href="/">` 之前，就用目前網址
   解析相對路徑；在 `/tw/search` 這種深層網址上，它會去抓 `/tw/chunk-*.js`，被 SPA
   導向規則回一份 `index.html`，於是 console 出現「MIME type text/html」錯誤，也白下載
   了一輪。改絕對路徑後就不會發生。

---

## 🌐 PWA 支援 (Progressive Web App)

UniBooks 前端支援 PWA，提供離線使用、安裝到桌面、推播通知等原生 App 體驗。

### PWA 架構

| 檔案 | 說明 |
|------|------|
| `ngsw-config.json` | Service Worker 快取策略設定 |
| `public/manifest.webmanifest` | PWA Manifest（名稱、圖示、顏色、捷徑） |
| `public/icons/` | 多尺寸圖示 (72x72 ~ 512x512)，支援 maskable |
| `src/index.html` | PWA meta tags、manifest link、iOS 支援 |
| `src/app/app.config.ts` | Service Worker 註冊策略 |

### 快取策略 (ngsw-config.json)

```json
{
  "navigationRequestStrategy": "freshness",
  "assetGroups": [
    { "name": "app", "installMode": "prefetch", "resources": { "files": ["/favicon.ico", "/index.html", "/manifest.webmanifest", "/*.css", "/*.js"] }},
    { "name": "assets", "installMode": "lazy", "updateMode": "prefetch", "resources": { "files": ["/**/*.(svg|png|jpg|webp|woff2)"] }},
    { "name": "icons", "installMode": "prefetch", "resources": { "files": ["/icons/*.png"] }}
  ],
}
```

- **navigationRequestStrategy: 'freshness'** — 確保頁面導覽時優先從網路獲取最新 HTML
- **app group (prefetch)** — 關鍵資源建置時預快取
- **assets group (lazy)** — 圖片、字體按需快取
- **API 不經 service worker 快取** — 沒有 dataGroups，`/api/**` 也排除在 navigationUrls 之外，
  每個 API 請求都帶 `ngsw-bypass`（`ApiUrlInterceptor`）

### Service Worker 註冊策略

```typescript
provideServiceWorker('ngsw-worker.js', {
  enabled: !isDevMode(),
  registrationStrategy: 'registerWhenStable:30000'
})
```

- `enabled: !isDevMode()` — 開發環境不啟用 SW，避免干擾熱重載
- `registerWhenStable:30000` — 等待 Angular 應用穩定後再註冊，最多等 30 秒，確保 PWA 不干擾初始載入

### 建置與驗證

```bash
npm run build          # 正式建置，產出 dist/unibooks/browser/ngsw-worker.js 等
# 部署後用 Lighthouse PWA audit 驗證
```

### PWA Checklist ✅

- [x] **可安裝** — manifest.webmanifest + icons + HTTPS
- [x] **離線可用** — Service Worker 快取 app shell + API network-first
- [x] **快速載入** — Prefetch 關鍵資源、lazy-load 非關鍵資源
- [x] **CSR + PWA 相容** — navigationRequestStrategy: freshness + registerWhenStable
- [x] **iOS 支援** — apple-mobile-web-app-* meta tags + maskable icons
- [x] **App Shortcuts** — "發布商品"、`/listings/new`、"我的訊息"、`/messages`

---

以上說明提供了 **功能分層、路由、API、UI、測試、部署與 PWA** 的完整藍圖，協助新進開發者快速掌握 UniBooks‑FE 的架構與開發流程。
