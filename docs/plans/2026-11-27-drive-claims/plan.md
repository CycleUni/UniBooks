---
title: "收書贈書第 3 期：登記領取與公開顯示"
status: done
created: 2026-11-27
size: large
---

## 需求

設計依據：`docs/plans/2026-11-25-book-drive.md` §5.3、§5.4、§7 第 3 項（第 2 版，已確認）。
跳過 brainstorming：設計已確認，這裡只把它落成可實作的範圍。

### 範圍（這一期做）

1. 組織管理員在活動系統把活動從「收書中」切到「登記中」，設定登記截止時間；可調每人上限、會員優先。
2. 學生在主站：
   - 書目頁最上方看到置頂的「〈校名〉〈組織名〉・贈書・剩 N 本・M 人登記」，按「登記領取」。
   - 找書結果的書目卡片有「學生會贈書」標記。
   - 活動頁 `/<region>/drive?id=` 列出這次活動所有書目，每本附剩餘本數與登記按鈕。
   - 登記：學號（只採用該校已通過的學號驗證，唯讀）、科系、年級；可取消、可改資料。
   - 帳號頁新增「領書登記」分頁，列出自己的登記與狀態。
3. 活動系統的「收書贈書」頁對所有人列出登記中的活動卡片，連到主站活動頁。

### 不在這一期

配發、通知、領取、候補、會員判定（第 4、5 期）。這一期的登記狀態只有 `registered`、`cancelled`。

### 規則

| 項目 | 規則 | 出處 |
|---|---|---|
| 誰能登記 | 已登入，且可在活動所在地區交易（沿用 `assertMayTrade`，與刊登相同的學校驗證條件） | `[confirmed: 構想 §5.4]` |
| 何時能登記 | 活動狀態 `claiming`，且 `claim_opens_at ≤ 現在 < claim_closes_at` | `[confirmed: 構想 §5.4]`，邊界 `[P1 預設]` |
| 能登記哪些書 | 這次活動還有在架（`in_stock`）本數的書目 | `[P1 預設]` |
| 每人每本書 | 一次（`unique(drive_id, user_id, book_id)`）；取消後再登記沿用同一列 | `[confirmed: 構想 §5.4]` |
| 每人總數 | 有效登記（`registered`）不超過活動的 `max_claims_per_user`；檢查與寫入在同一個 SQL 敘述內，並發也不會超過 | `[confirmed]`，並發做法 `[P3]` |
| 學號 | 該使用者在**組織所屬學校**已通過（`approved`）的學號驗證；沒有就留空，照樣可登記 | `[confirmed: 構想 §5.4]` |
| 科系、年級 | 有學號且在名冊內：預先帶入名冊的科系、年級，可改；否則自選。科系存文字（同收書的正規化） | `[confirmed: 構想 §5.4]` |
| 登記人數 | 可超過剩餘本數，頁面顯示「N 人登記」 | `[confirmed: 構想 §5.4]` |
| 取消、修改 | 登記期間內可以；截止後不行 | `[confirmed: 構想 §5.4]` |
| 公開顯示 | 只有 `claiming` 的活動對外可見；`intake` 中的活動與書不出現在書目頁、找書、活動頁 | `[P1 預設]` |
| 截止後 | 活動仍是 `claiming` 直到第 4 期配發；置頂改寫「登記已截止」，按鈕停用 | `[P1 預設]` |
| 個資 | 公開 API 不回捐書人資料、不回別人的登記；只回本數與人數 | `[confirmed: 構想 §5.2]` |

### 狀態轉換（活動）

| 從 → 到 | 條件 | 出處 |
|---|---|---|
| `intake` → `claiming` | 組織管理員；截止時間在未來、在政策上限內；至少一本在架 | `[P1 預設]` |
| `claiming` → `intake` | 還沒有任何有效登記（改回去收書） | `[P1 預設]` |
| `claiming` → `closed`、`intake` → `closed` | 組織管理員 | 既有 |
| `closed` → `intake` | 組織管理員（既有的重新開放） | 既有 |

收書（`POST copies`）維持只在 `intake` 時可用；登記中可以下架或改書本資料（既有行為），下架到 0 本的書目不再接受新登記，已登記的保留。

### 政策值（只寫在這裡與程式常數）

| 名稱 | 值 | 出處 |
|---|---|---|
| 登記期間上限 | 90 天 | `[P2 預設]` |
| 每人上限預設 / 範圍 | 3 / 1–20 | 既有 |
| 登記速率限制 | 每帳號 60 次/小時 | `[P2 預設]` |

## 決定

沒有 P0：誰能登記、學號來源、會員優先只看已驗證學號都已在構想第 2 版確認。
以下 P1 採預設值實作。使用者答：「照這五個預設開始做」（2026-11-27）。

1. 登記中不能再收書；要收書就改回「收書中」（只在還沒人登記時可以）。
2. 登記一開放就生效（不做排程開放），組織管理員只設截止時間。
3. 收書中（`intake`）的活動完全不公開，到「登記中」才出現在主站與活動系統的公開列表。
4. 組織管理員與活動人員也可以登記自己活動的書（配發是排序加隨機，不是搶快）。
5. 登記條件沿用刊登的學校驗證（`assertMayTrade`），不限定和組織同一所學校。

## 實作計畫

### 伺服器（`UniBooks/server`）

1. `db/migrations/0013_drive_claims.sql` + `schema.ts`：`drive_claims`（欄位依構想 §4；本期用到
   `id, drive_id, book_id, user_id, student_number, department, grade, status, created_at, updated_at`，
   其餘配發欄位一併建好避免第 4 期改表）；索引 `(drive_id, book_id, status)`、`(user_id, created_at)`；
   `unique(drive_id, user_id, book_id)`。只加表。
2. `services/drives/claims.ts`：登記規則唯一實作（開放判斷、在架檢查、上限的條件式 INSERT、
   學號來源、名冊預填）；`services/drives/public.ts`：公開摘要（某書目的置頂資料、某活動的書目清單）。
3. `routes/drives.ts`：
   - `PATCH /:id` 狀態加入 `claiming`（附 `claim_closes_at`）與 `claiming → intake` 的條件。
   - 公開（不需要權限，`optionalAuth`）：`GET /api/v1/drives/open?region=`（登記中的活動）、
     `GET /api/v1/drives/:id/public`（活動、書目、剩餘本數、登記人數、我的登記）。
     路由放在 `authMiddleware('*')` 之前，或拆成 `routes/driveClaims.ts`。
   - 登記：`GET /:id/claim-defaults`、`POST /:id/claims`、`PATCH /:id/claims/:claimId`、
     `DELETE /:id/claims/:claimId`（改成 `cancelled`）、`GET /api/v1/drives/claims/mine`。
4. `routes/books.ts` 書目 `GET`：加 `drives: [...]`（此書在登記中活動的置頂資料，含我的登記）。
5. `routes/search.ts`：`annotated` 讀取加一欄 `dv`（此書在登記中活動的在架本數），結果加 `driveCopies`。
6. `/auth/me` 不變。稽核：登記的建立/取消寫 `audit_events`（比照既有 `drive.*`）。
7. 測試 `test/orgs/claims.spec.ts`：狀態轉換、開放邊界（等於截止時間即關閉）、上限（含並發兩筆）、
   重複登記、取消後再登記、學號只取組織學校的 approved、名冊預填、公開 API 不洩漏捐書人與他人登記、
   書目頁與找書的欄位、未驗證者被擋。

### 主站（`UniBooks/client`）

8. `core/services/drive.service.ts`：上述 API。
9. `shared/ui/drive-claim-sheet.component.ts`：登記／修改表單（`ui-bottom-sheet`；學號唯讀或提示去學號驗證；
   科系用 `ui-dropdown` searchable＋「其他」自填，比對沿用 `core/department-match.ts`；年級）。
   未驗證時顯示 `ui-verification-prompt`。書目頁與活動頁共用。
10. `features/book/book.ts`：listings 上方的置頂區塊（每個組織一筆）。
11. `features/drive/drive.ts`＋路由 `:region/drive`：活動頁（說明、截止時間、我已登記 x / 上限、書目卡）。
12. `features/search/search.ts`（與 `shared/ui/book-tile`）：「學生會贈書」標記。
13. `features/account/claims.ts`＋路由 `account/claims`＋帳號頁導覽「領書登記」。
14. i18n：`en.ts`、`zh-TW.ts`、`zh-HK.ts`（zh-HK 用粵語口語）。測試：新元件與 service 的 spec。

### 活動系統（`CycleUniProject/UniBooks-Event`）

15. 活動頁「設定」：開放登記（截止日期時間）、每人上限、會員優先；改回收書；顯示登記人數。
16. `[region]/drives/index.astro`：對所有人列出登記中的活動卡片（`GET /api/v1/drives/open`），連到主站
    `/<region>/drive?id=`。
17. i18n 三語。

### 順序

1 → 2 → 3–7（伺服器測試綠）→ 8–14 → 15–17 → 瀏覽器端到端 → 兩個 repo 各一個 commit。

## 完成條件

- `cd server && npx vitest run test/orgs/claims.spec.ts` (exit 0)
- `cd server && npm test` (exit 0)
- `cd server && npx tsc --noEmit` (exit 0)
- `cd server && npx prettier --check src/routes/drives.ts src/services/drives test/orgs/claims.spec.ts` (exit 0)
- `cd client && npm test -- --no-watch` (exit 0)
- `cd client && npm run build` (exit 0)
- `cd ../CycleUniProject/UniBooks-Event && npx tsc --noEmit -p . && npx astro build` (exit 0)
- 手動 attest（本機瀏覽器）：組織管理員開放登記 → 學生在書目頁看到置頂並登記 → 活動頁、帳號頁顯示 →
  修改、取消、超過上限被擋 → 截止後按鈕停用 → 收書中的活動不公開 → 公開回應不含捐書人學號。

## 驗證結果

2026-11-28，本機（主站 :8788、活動系統 :4322）。

- `cd server && npx vitest run`：69 個檔案、611 個測試通過（含 `test/orgs/claims.spec.ts` 6 個）。
- `cd server && npx tsc --noEmit`、`npx prettier --check`（改動的伺服器檔案）：通過。
- `cd client && npm test -- --no-watch`：166 個檔案、1477 個測試通過；`npm run build` 通過
  （初始 bundle 超出 600 kB 預算 19.04 kB 的警告在這次改動前就有，改動前是 18.80 kB）。
- `cd UniBooks-Event && npx tsc --noEmit -p . && npx astro build`：通過。
- 瀏覽器端到端（測試帳號）：
  - 組織管理員在活動系統設定截止時間並開放登記；收書按鈕消失，頁首顯示「登記中，至…・N 人共登記 N 本」。
  - 未登入看書目頁：置頂「學生會贈書・〈組織〉・剩 2 本・0 人登記」；按「登記領取」導向登入再回來。
  - 學生登記（科系打「資管」找到資訊管理學系、2 年級）→ 置頂變「1 人登記・你已登記」。
  - 活動頁列出在架書目；帳號頁「領書登記」可修改年級；取消登記走紅色確認，計數歸零；再登記沿用同一筆。
  - 找書結果該書顯示「學生會贈書」標記；活動系統「收書贈書」頁對學生顯示開放登記中的活動卡片，點下去到主站活動頁。
  - 已有人登記時「改回收書」被擋（`drive.errHasClaims`）。

活動結束（`closed`）後，學生帳號頁的登記改顯示「學生會已結束這個活動」。配發、通知、領取在第 4、5 期處理。

### 2026-11-28 追加：學校首頁提示與設計風格

使用者要求：新元件要符合網站設計風格；學生會有贈書活動時，對應學校的首頁要顯示提示並提供可選的清單。

- 首頁（`features/home/home-drives.component.ts`）：頁首選定學校時，該校每個登記中的活動一個區塊——
  `section-heading`「〈組織〉・贈書登記中」、一行說明（截止時間、幾種幾本、每人上限）、最多 8 本書的書卡，
  每張可直接登記或修改；「查看全部」到活動頁。沒選學校、或該校沒有登記中的活動時不顯示。
  資料：`GET /api/v1/drives/open?school=&titles=`（未知學校回空清單；預覽依剩餘本數排序）。
- 設計：書目頁置頂改用該頁「等待通知」橫幅的樣式（`--paper-warm`、`--radius-panel`、白色按鈕）；
  標記改用書況的 `cond-chip`；登記視窗比照 `ui-confirm-dialog`；活動頁比照課程頁（`page-title`、
  狀態框、`section-heading`＋`discover-grid` 書卡）；帳號「領書登記」比照「我的求書」的書卡格；
  `ui-book-tile` 新增 `plain` 模式（無價格與等待戳記）。
- 驗證：伺服器 611/611、主站 1477/1477、build 通過；瀏覽器檢查首頁（深色桌機、淺色手機）、書目頁、
  登記視窗、活動頁、帳號頁、找書結果；政大首頁不顯示（臺大的活動）。

### 2026-11-28 追加：首頁只放一排、100 本實測

- 首頁每個活動只放一排書卡：向伺服器拿最多 12 本（`MAX_PREVIEW_TITLES`），依當下 `discover-grid` 實際排出的欄數
  顯示（桌機 1024px 4 本、手機 375px 2 本，視窗改變時重算），其餘按「查看全部 N 種」到活動頁。
- 100 本實測（本機活動 101 種、173 本）抓到一個錯誤：活動頁與首頁預覽 500，D1 單一敘述最多綁 100 個參數，
  `inArray(books.id, …)` 超過就失敗。改用既有的 `lib/sql.ts` `inList`（json_each 綁成一個參數）；
  活動人員書本清單（`page_size` 最大 200）同一個潛在問題一併修正。新增測試：123 種書的活動頁、首頁預覽、
  200 筆的書本清單都回 200。
- 活動頁分頁（使用者決定比照找書）：每頁 20 本，桌機用 `ui-pagination`、手機用 `PhonePager`＋`ui-infinite-scroll`，
  和賣家頁、書目頁同一套元件。API 已一次回傳全部書目，所以一頁是清單的切片，不另發請求、不改 API。
  實測 101 本：桌機 6 頁（第 6 頁 1 本），頁面高度由約 13,200px 降到約 3,100px；手機捲動 20 → 40 → 60。
- `reports.spec.ts` 偶發失敗（徽章文字語言隨測試順序變成中文），與本次改動無關，原本就有。

### 2026-11-28 追加：校園贈書

使用者要求：「學生會贈書」改為「校園贈書」，贈書單位是學校組織、不一定是學生會，其他說明文字一併改。
標記不用強調是哪個組織（使用者：「右邊文字有寫就夠了」），所以一律「校園贈書」，不做自訂
（曾短暫加過每個活動自訂標記，依此說明移除）。

- 顯示處：書目頁置頂、活動頁、找書結果的標記，都是 `drive.giveaway`「校園贈書」。
- 文字：「由學生會配發」「學生會已結束這個活動」改為「主辦單位」；`search.driveGiveaway` 與 `drive.giveaway` 文字相同，合併為 `drive.giveaway`。
  上面驗證紀錄裡的「學生會贈書」是當時畫面的文字，保留不改。
