# UniBooks client 開發守則（給 AI Agent 與人類協作者）

本檔是寫給 AI coding agent 的常駐守則，人類協作者同樣適用。以下規則都是專案**已經在遵守**的慣例，
原本散落在程式碼註解裡，這裡集中寫下，讓新產生的程式碼一開始就符合。每條規則後面標註對應的
尼爾森可用性原則（NS01～NS10）。

## 0. 協作方式

- 使用臺灣繁體中文與標準軟體工程用語（程式碼、錯誤碼，而非「代碼」）。
- 跨多個檔案或多個 feature 的改動，先列出受影響的檔案與做法，確認後再動手。
- 完成的定義是指令輸出，不是判斷：改完要跑 `npm test`（vitest）；會影響建置的改動再跑 `npm run build`。
- 不要大範圍重新排版既有檔案。diff 只放這次真正要改的內容。

## 1. 使用者回饋與系統狀態（NS01）

- 非同步操作的按鈕在請求期間必須 `[disabled]`，並把文字換成進行中的狀態（參考 `sell.html` 的
  `isSubmitting` → `'sell.submitting'`），避免重複送出，也讓使用者知道系統正在處理。
- 列表或頁面載入中用 `ui-skeleton`，沒有資料用 `ui-empty`，載入失敗用 `ui-error-state`（可重試）。
  不要出現空白畫面，也不要只放一個沒有任何說明的 spinner。
- Angular 22 的元件預設就是 `OnPush`。非同步結果或錯誤回來後要呼叫 `cdr.markForCheck()`
  （或改用 signal），也要記得把 `isLoading` / `isSubmitting` 等狀態重設回來；
  就地修改陣列或物件內容不會觸發重新渲染，要換成新的參考。
  漏掉的話，按鈕會一直卡在「送出中」，錯誤訊息也不會出現。

## 2. 說使用者的話（NS02）

- 所有 UI 文字都走 i18n：模板用 `| t` pipe，程式碼用 `i18n.t(key)`。
  新增 key 時必須**同時**加進 `core/i18n/en.ts`、`zh-TW.ts`、`zh-HK.ts`，
  `i18n-keys.spec.ts` 會檢查三個語系的 key 完全一致。
- zh-HK 使用粵語口語，不是把 zh-TW 直接複製過去（參考既有的 `msg.*` 條目）。
- 不要寫死英文字串當 fallback（例如 `|| 'Failed to …'`）。

## 3. 使用者控制權與錯誤預防（NS03、NS05）

- 禁止使用 `window.alert()` / `window.confirm()`。
  - 提示訊息用 `ToastService`（`success` / `error` / `info`）。
  - 需要確認的操作用 `ConfirmService`：`await this.confirms.ask(...)`；
    刪除、取消訂單、解除綁定等**無法復原**的操作一律用 `askDanger(...)`（紅色按鈕），
    並把 `confirmLabel` 設成具體的動作名稱（例如 `common.delete`），不要用籠統的「確定」。
- 只修改一般設定（暱稱、深色模式等）**不要**跳確認視窗，二次確認只留給破壞性操作。
- 有未存檔內容的頁面要在路由加上 `canDeactivate: [unsavedChangesGuard]`。
- 表單在前端就先限制輸入（`type`、`min` / `max`、`required`、`accept`），錯誤就近顯示在欄位旁。

## 4. 一致性與設計系統（NS04、NS08）

- 顏色、陰影、圓角、字級一律使用 `src/styles.css` 的 CSS 變數
  （`--ink`、`--muted`、`--line` / `--line-strong`、`--danger` / `--danger-light`、`--success`、
  `--shadow-card`、`--radius-*`、`--text-*` 等）。**不要**在元件裡寫死 hex 或 `rgba(...)` 色碼。
  - 需要半透明的顏色時用 `color-mix(in srgb, var(--token) N%, transparent)`。
    黑色的 `rgba(0,0,0,.05)` 疊在深色主題上看不出來。
  - 唯一的例外是 data URI、Chart.js 這類讀不到 CSS 變數的地方：先用 `getComputedStyle` 讀 token，
    hex 只能當 fallback（參考 `messages.ts` 的 `expiredImageSrc`、`admin/chart-theme.ts`）。
  - 遮罩層（modal scrim）用黑色半透明沒有問題，兩種主題下都正確。
- 可以互動的邊框（輸入框、按鈕、可點的卡片）用 `--line-strong`；`--line` 只用在裝飾性的分隔線。
- 優先使用 `shared/ui` 既有的元件（`ui-button`、`ui-input`、`ui-dropdown`、`ui-bottom-sheet`、
  `ui-confirm-dialog`…），不要另外做一顆樣式不同的按鈕或彈窗。
- 可點擊區域至少要有 `var(--tap-min)`（44px）。
- 動畫尊重 `prefers-reduced-motion`，時間長度用 `--motion-fast` / `--motion-base`。

## 5. 降低記憶負擔與效率（NS06、NS07）

- 搜尋相關功能沿用 `core/search-suggestions.ts` 的 `RecentSearches`，不要另外存一份。
- 表單支援用鍵盤完成：Enter 送出。對話框套用 `focus-trap` 指令，焦點會留在對話框內，
  並接上它的 `(escape)` 輸出，讓使用者按 `Esc` 就能關閉。

## 6. 錯誤訊息（NS09）

後端所有錯誤只有一種格式（`server/src/lib/http.ts`）：`{"error": {"code": "<i18n key>", ...附加欄位}}`；
欄位驗證錯誤是 `{"error": {"code": "common.errValidation", "fields": {"<欄位>": ["<i18n key>"]}}}`。
錯誤碼一律是 i18n key，後端不回傳英文句子。

- 顯示 API 錯誤一律用 `core/api-error.util.ts`：
  - `parseApiError(err, this.i18n, 'fallback.key')`：直接得到可以顯示的句子。
  - `translateApiError(err, this.i18n)`：翻不出來時回傳 `null`，讓呼叫端決定要顯示什麼。
- **禁止**把 `err.error`、`err.message` 直接顯示給使用者。
  那是原始 JSON 或 Angular 的 `Http failure response for …`，使用者看不懂也無從處理。
- 查詢後端傳來的錯誤碼時，用 `i18n.tOrNull(code)` 而不是 `i18n.t(code)`；
  後者在找不到 key 時會把原始 key 直接顯示在畫面上。
- 錯誤訊息要說明發生了什麼事、下一步可以怎麼做（例如「請再試一次」），不要責怪使用者。
- 會擋住操作的錯誤顯示在表單上；Toast 只用來顯示不會擋住操作的結果。

## 7. 安全

- 不要把 API key、token 或任何機敏憑證寫進前端程式碼；環境值由 `scripts/set-env.js` 注入。
- `[innerHTML]` 只能用在我們自己的翻譯字串上。使用者產生的內容（刊登描述、聊天訊息）
  不要用 `[innerHTML]` 或 `bypassSecurityTrust*` 渲染。

## 8. 部署與執行環境

- 這個前端位於單一 Worker repo 的 `UniBooks/client`，後端是 `../server`。
  它不單獨部署：由那支 Cloudflare Worker 以 Workers Static Assets 提供，
  App、API（`/api/v1`）、聊天室（`/api/chat`）、`/api/cover` 與 `/<region>/book` 全在同一個 origin。
  部署是 `cd ../server && npm run deploy`；本地整套跑是 `cd ../server && npm start`（:8787），
  或 `npm --prefix ../server run dev` 搭配這裡的 `npm start`
  （`proxy.conf.json` 只有一條 `/api` → :8787，`ws: true`、`changeOrigin: false`，聊天室 WebSocket 也走這條）。
- 不要在 `src/app` 寫死任何 API 或聊天室的絕對網址；API 一律走 `environment.backendUrl`
  （預設 `/api/v1`），聊天室網址一律用 `core/chat-urls.ts` 以本頁 origin 組出。
- 圖片上傳（刊登照片、聊天圖片、廣告圖）一律走 `core/upload.ts` 的兩段式：`POST <base>/uploads` 拿 `{upload_url, photo_url}`，再 PUT 檔案到 `upload_url`。
- 與後端共用的公開值（`R2_PUBLIC_URL`、`GOOGLE_CLIENT_ID`、`SENTRY_DSN`）只有一個來源：`../server/wrangler.jsonc`
  的 `vars`（本地再疊 `../server/.dev.vars`），由 `scripts/set-env.js` 讀取，不要在前端另寫一份。
  只有前端用的值放 `production.env`（只放會進到公開 bundle 或 header 的值，不放機密）；
  CSP 由 `scripts/set-env.js --production --headers` 寫進 `dist` 裡的 `_headers`。
- 書籍封面一律經 `/api/cover` 代理（`BookCoverPipe`），**不要改成讓瀏覽器直連來源**。試過「先直連、失敗才走代理」，退回了，原因：
  1. 判斷封面有沒有效只有伺服器做得到：Google 沒有封面時會回一張「image not available」圖，載入成功、不會觸發 `error`；
     伺服器靠回應標頭 `cache-control: max-age`（低於 3600 秒即佔位圖）和 3000 位元組下限判斷（`server/src/services/frontend/cover.ts`）。
     Google 圖片沒有 CORS 標頭，跨來源 `<img>` 讀不到標頭和位元組大小，前端只能看到解碼後的尺寸，靠猜（128×170、575×750、細條），會誤判。
  2. 只有代理能依序降 zoom（3→2→1），找不到才回真正的 404；直連做不到。
  3. 圖片在 edge 快取一年，網址唯一，首頁大圖和縮圖共用同一次下載；直連與代理混用會讓同一本書下載兩次。
  4. 直連要把每個來源（含轉址目標，如 Open Library → archive.org）列進 CSP 的 `img-src`，正式環境 `img-src` 只放 R2，漏一個就被擋；
     代理則只需 `'self'`。
  5. 直連會把使用者的 IP 與 Referer 送給第三方。
  省 Worker 請求數不足以抵銷這些成本。
- 這個資料夾只有前端；伺服器端邏輯（API、聊天室、`/<region>/book`、`/api/cover`）都在 `../server`，部署設定是 `../server/wrangler.jsonc`。

## 9. 登入狀態（Session）

- Session 是伺服器設定的 HttpOnly cookie，前端**拿不到也不該存** token：不要把 access／refresh token
  寫進 localStorage、sessionStorage、signal 或任何欄位，也不要自己加 `Authorization` 到 `/api/v1` 請求。
- 「已登入」＝有 `ub_session=1` 提示 cookie，且 `/auth/me` 成功（`AuthStore.isAuthenticated()`／`user()`）。
- 401 的處理只在 `AuthInterceptor`：單一共用的 `POST /auth/refresh`，成功後重送一次，失敗就
  `AuthStore.endSession()`。元件不要自己重試或導去登入頁。
- 跨分頁的登入／登出走 `BroadcastChannel('ub-auth')`，訊息只有事件名稱。
- 聊天室的 chat／hub token 例外：它們是短效、限定房間的 token，仍由 JS 帶在 `Authorization: Bearer`
  或 WebSocket subprotocol，`decodeJwtPayload` 只拿來讀 `user_id`／`exp`。
