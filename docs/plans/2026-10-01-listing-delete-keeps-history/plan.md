---
title: "賣家可刪除刊登，訂單／對話／檢舉紀錄保留"
status: done
created: 2026-10-01
size: large
---

## 要求

- 賣家可以刪除自己的刊登。`[confirmed: 使用者「還是要讓賣家刪除吧」]`
- 刊登刪除後，訂單（含評價）、對話、刊登檢舉仍保留，畫面顯示「商品已刪除／不存在」。
  `[confirmed: 使用者勾選「對話紀錄」「檢舉紀錄」]`
- 有**進行中**訂單時不能刪除。`[confirmed: 使用者選「有進行中訂單就不能刪除」]`
- 參考蝦皮類平台：訂單保留下單當下的商品快照，商品刪除不影響訂單。
  `[researched: 一般電商公開可見行為，n=1（未查證蝦皮內部實作）]`
- 刪除仍是同步刪除，不做軟刪除、不新增排程。`[confirmed: 使用者「同步刪除比較好處理」「清理也用排程是非必要的架構」]`
- 刪除前維持現有的二次確認（`askDanger`）。`[confirmed: 使用者「改為雙重確認機制」；三處原本已有]`

### 自主權範圍（本地開發環境）

- 已有：三個倉庫的寫入權限、本地 SQLite／Django／CFEdgeChat／Angular 開發伺服器，以及本地建立測試帳號和刪除資料的權限。`[confirmed: 使用者「這只是本地環境 你可以任意刪除帳號 以及自行簽發超級管理員金鑰」]`
- 禁止：對正式環境的資料庫執行 migration、部署、在沒有確認前 push。

### 現況（調查結果）

- `Order.listing`、`Conversation.listing`、`Report.listing` 都是 `CASCADE`。刪除刊登會連帶刪除訂單、評價、對話、檢舉，以及以對話為基礎的聊天檢舉。`[researched: models.py, n=3]`
- `Conversation` 自己沒有 seller／region 欄位，賣家和地區都透過 `listing.seller`、`listing.region` 取得。對話找訂單也是靠 `listing.orders.filter(buyer=…)`。`[researched: messaging/models.py, serializers.py]`
- `Report` 的管理員範圍是靠 `listing__region` 篩選；`ChatReport` 則經由 `conversation__listing__region`。`[researched: moderation/views]`
- 刪除刊登時會刪掉 R2 上的照片和孤兒 Book，所以快照**不能存照片網址**。改存 ISBN，封面經由既有的 `/api/cover?isbn=` 取得。`[researched: listings/models.py, utils.py]`
- 大約有 130 處讀取 `*.listing`，分佈在 23 個後端檔案；前端有 14 個檔案用到 `listing_id`、`listing_title`、`listing_photo`。

## 決定

- **P0：刪除後怎麼關聯回原刊登。** 改成 `SET_NULL`，另外在 `Order`、`Conversation`、`Report` 新增 `listing_ref`（UUID，不是 FK）保存原刊登 id，讓「對話 ↔ 訂單」在刊登刪除後仍能用 `(listing_ref, buyer)` 對應。
  不採用 `db_constraint=False` 保留懸空 id 的做法：`select_related` 和 `listing__*` 篩選會用 INNER JOIN，資料列會悄悄消失。
- **P0：進行中訂單。** 只要有 `pending`、`accepted`、`handed_over` 狀態的訂單就拒絕刪除，回傳 `409 listing.errHasActiveOrders`。只有 `completed`、`cancelled` 的話允許刪除。（使用者答：「有進行中訂單就不能刪除」）
- **P1：刊登已刪除的對話。** 雙方仍可閱讀過去的對話，但不能傳送新訊息；聊天 token 只發 observer 權限，或前端停用輸入框。預設採用**前端停用輸入框，後端拒絕發 participant token**。
- **P0：管理員刪除。** 管理員處理違規商品時，**不受任何訂單限制**，隨時都能刪除。
  （使用者答：「應該要保有讓管理員能擋任何訂單 如果發現商品違規才能處理」）
  - 如果有進行中的訂單，刪除時一併強制取消，沿用既有的 `force_cancel` 規則：必填理由，至少 3 個字（`admin.errInvalidReason`）；`cancel_reason = admin_override: <理由>`；寄送 `order.notify.admin_cancelled` 通知；寫入 `admin.order_force_cancelled` 稽核紀錄。
  - 不再回傳 `admin.errListingHasOrders`；已完成、已取消的訂單照樣以快照保留。
- **P1：未合併的 `listing-delete-keeps-orders` 分支**丟棄，只把 `closeEdit()` 的 `markForCheck` 修正重新套用。
- **P3：快照欄位。** 只存顯示需要的欄位（書名、ISBN）。價格已經在 `Order.total_amount`。

### 政策值（唯一位置）

| 名稱 | 值 | 出處 |
|---|---|---|
| `ACTIVE_ORDER_STATUSES`（擋刪除） | `pending`, `accepted`, `handed_over` | `[confirmed: 使用者]` → `orders/models.py` 常數 |

### 四個模糊點的檢查

- ① 狀態轉換：刊登刪除後，進行中的訂單不可能存在（已被擋下）。已完成／已取消的訂單不再有任何狀態轉換。對話在刊登刪除後只能閱讀。
- ② 規則同時成立：刊登有 `admin_locked` 又沒有進行中訂單時，維持現有的 `listing.errAdminLocked`，優先權最高。
- ③ 邊界值：`handed_over` 算進行中（尚未完成）。`[confirmed: 使用者選項說明中列出]`
- ④ 失敗後回復：在同一個 transaction 裡依序檢查、寫入快照、刪除刊登；中途失敗就整個 rollback，照片刪除失敗沿用現有的記錄 log 後繼續。

## 實作計畫

### 第 0 階段：使用者看到的「管理員」字樣改為「平台」

`[confirmed: 使用者「管理員字樣 改為被平台取消 其他有用到管理員字樣的一併修改」]`
只改一般使用者會看到的文字；管理後台本身的介面文字（`admin.*`、`nav.admin`、`acct.navGroupAdmin`）維持不變。

| key | zh-TW 新文字 | en 新文字 |
|---|---|---|
| `order.notify.admin_cancelled` | 此訂單已被平台取消。 | This order has been cancelled by UniBooks. |
| `row.adminLocked` | 已被平台下架，無法編輯 | Taken down by UniBooks · editing is disabled |
| `listing.errAdminLocked` | 此商品已被平台鎖定，無法修改。 | This listing has been locked by UniBooks and cannot be modified. |

- zh-HK 同步修改，使用粵語用字。
- 後端 `listings/views/listings.py` 回應裡附帶的英文 `message` 一起修改。
- `auth.errStaffCannotRemovePassword`（「管理員帳號不得移除密碼」）不改：這句只有管理員本人會看到，說的是他自己的帳號。
- 這一階段和其他階段互相獨立，先單獨 commit。

### 第 1 階段：後端資料模型（UniBooks-BE）

1. `orders/models.py`：`listing` 改成 `SET_NULL, null=True`；新增 `listing_ref`（UUID, db_index）、`book_title`、`book_isbn`。新增常數 `ACTIVE_ORDER_STATUSES`。
2. `messaging/models.py`：`Conversation.listing` 改成 `SET_NULL`；新增 `listing_ref`、`seller`（FK）、`region`（FK）、`book_title`、`book_isbn`。`mark_deleted_by` 改用 `seller_id`。`unique_together` 改成 `(listing_ref, buyer)`。
3. `moderation/models.py`：`Report.listing` 改成 `SET_NULL`；新增 `listing_ref`、`seller`、`region`、`book_title`。
4. Migration：先加欄位，再用 data migration 從現有刊登回填，最後修改 FK 和唯一鍵。
5. 建立時寫入快照：下訂單（`OrderSerializer.create`）、開啟對話（`conversations` view）、建立檢舉（`ReportCreateSerializer`）。

### 第 2 階段：後端讀取路徑

6. 把 `order.listing.*`、`conversation.listing.*`、`report.listing.*` 改為讀快照或新欄位：`seller`、`region`、`book_title`。範圍包含：
   - `orders/views/orders.py`、`orders/serializers.py`
   - `messaging/serializers.py`、`messaging/views/conversations.py`、`messaging/views/chat_tokens.py`、`messaging/views/uploads.py`
   - `moderation/views/*.py`、`moderation/serializers.py`
   - `adminapi/views/{orders,chat_reports,stats,growth,listings}.py`、`adminapi/serializers.py`
   - `core/permissions.py`、`cron/views.py`、各 `admin.py`
7. 序列化器輸出 `listing_deleted: bool`。`listing_title` 一律使用快照，`listing_photo` 在刊登刪除後回傳空字串，由前端用 ISBN 顯示封面。
8. `listings/views/listings.py`，賣家 DELETE：有進行中訂單時回 `409 listing.errHasActiveOrders`，否則照常刪除。
8b. `adminapi/views/listings.py`，管理員 DELETE：一律允許。有進行中訂單時，理由（`reason`）必填，並在同一個 transaction 裡依 `force_cancel` 的規則取消這些訂單、寄送通知、寫入稽核紀錄，然後才刪除。把 `AdminOrderForceCancelView` 的取消邏輯抽成共用函式，兩邊一起使用。
9. 聊天 token：刊登已刪除的對話不再發 participant token（回傳既有的 observer 或明確錯誤碼 `msg.errListingDeleted`）。

### 第 3 階段：前端（UniBooks-FE）

10. i18n 三個語系：`listing.errHasActiveOrders`、`msg.errListingDeleted`、`common.listingDeleted`（「商品已刪除」）、`listing.notFoundTitle`／`listing.notFoundBody`（「商品不存在」頁）。
11. 訂單列表／詳情（`account/orders.ts`）、收件匣與聊天標頭（`messages`、`inbox-list`）、我的檢舉（`account/reports.ts`）、管理員檢舉列表：`listing_deleted` 時顯示「商品已刪除」標記，停用指向刊登的連結，封面改用 ISBN。
12. 聊天室：`listing_deleted` 時停用輸入框和面交按鈕，並顯示說明。
13. `listing-detail`：API 回 404 時改顯示「商品不存在」狀態，提供回首頁／搜尋的按鈕，取代通用的 404 頁。
13b. 管理員刊登詳情的刪除（`listing-detail-admin.component.ts`）：有進行中訂單時，確認視窗改用 `force-cancel-modal` 的理由輸入，提示「將一併取消 N 筆進行中的訂單並通知買家」。
14. `account/listings.ts`：收到 `listing.errHasActiveOrders` 時以 Toast 顯示翻譯後的錯誤（走 `parseApiError`）；重新套用 `closeEdit()` 的 `markForCheck` 修正。

### 第 4 階段：驗證與收尾

15. 後端新增測試：刪除後訂單、評價、對話、檢舉都保留，快照正確；賣家刪除時進行中訂單會被擋；管理員刪除時進行中訂單會被強制取消、沒填理由會被拒絕；對話能找回訂單；管理員的地區範圍篩選在刊登刪除後仍正確；聊天 token 被拒絕。
16. 前端新增 spec：`listing_deleted` 的顯示；刪除失敗時顯示錯誤；`closeEdit` 修正。
17. 瀏覽器實測：建立已完成訂單 → 賣家刪除刊登 → 買家看訂單、聊天，賣家看訂單，管理員看檢舉；以及打開已刪除刊登的網址。

## 完成條件

- `cd UniBooks-BE && .venv/bin/python manage.py makemigrations --check --dry-run` (exit 0)
- `cd UniBooks-BE && .venv/bin/python manage.py migrate` (exit 0，本地 SQLite)
- `cd UniBooks-BE && .venv/bin/python -m pytest -q` (exit 0)
- `cd UniBooks-BE && ! grep -rnE "(order|conversation|report|conv|obj)\.listing\.(seller|region|book)" --include='*.py' orders messaging moderation adminapi core cron | grep -v tests` (exit 0：沒有殘留透過刊登讀取賣家／地區／書的程式碼)
- `cd UniBooks-FE && npx ng test --watch=false` (exit 0)
- `cd UniBooks-FE && npx ng build --configuration development` (exit 0)
- 瀏覽器實測第 17 項的每個情境都通過（逐項人工確認，結果記錄在「驗證結果」）

## 驗證結果

### 完成條件（checklist.json，`verify` 全部重新執行，rc 0）

| ID | 指令 | rc |
|---|---|---|
| C0 | 使用者文字不再出現「管理員」的 grep | 0 |
| C1 | `manage.py makemigrations --check --dry-run` | 0 |
| C2 | `manage.py migrate --noinput`（本地 SQLite） | 0 |
| C3 | `pytest -q` — 777 passed, 3 skipped | 0 |
| C4 | 沒有經由刊登讀賣家／地區／書的 grep | 0 |
| C5 | `ng test --watch=false` — 845 passed | 0 |
| C6 | `ng build --configuration development` | 0 |

### 瀏覽器實測（第 17 項，本地帳號，結束後已刪除）

- 賣家刪除有已完成訂單的刊登 → 成功；刪除有待確認訂單的刊登 → 「此刊登還有進行中的訂單…」。
- 賣家／買家聊天：收件匣標示「商品已刪除」、橫幅停用、輸入框改為唯讀說明、仍找到訂單；chat token 為 `observer`。
- 買家訂單：標示「商品已刪除」、連結改為文字、仍可開啟對話。
- 已刪除刊登網址 → 「商品不存在」頁。
- 我的檢舉、管理員檢舉列表 → 標示「商品已刪除」；動作按鈕改為「標記已處理」。
- 管理員刪除有待確認訂單的刊登 → 要求填寫原因 → 刪除；訂單 `admin_override: <原因>`、兩筆稽核紀錄、對話保留；買家看到「已取消 (平台取消)」與原因、聊天顯示「此訂單已被平台取消。」。

### 與計畫的差異

- `Conversation.unique_together` 維持 `(listing, buyer)`：刊登刪除後 `listing` 為 NULL，不會衝突，而新對話只能建立在存在的刊登上，結果等價、改動較小。
- 封面「用 ISBN 經 `/api/cover` 取得」不成立：該代理只接受 `src`。刊登刪除後改顯示既有的佔位縮圖。
- 額外修正（實測中發現、與本次流程直接相關）：平台取消的訂單原本顯示原始 i18n key；聊天中的平台取消通知原本顯示 `[SYSTEM:…]` 原文；刪除對話時編輯視窗不關閉；唯讀說明文字改為中性用語（賣家本人也會看到）。

### 審查

- 規格符合度：已逐項對照實作計畫 0–17 項，皆已實作（含上述差異）。
- 獨立程式碼審查與安全掃描：**未執行**（本次未使用獨立審查代理），僅自我審查；不視為已通過獨立審查。

### 已知限制

- 管理後台統計中依刊登學校／書籍分組的排行，不含刊登已刪除的訂單。
- 管理員刪除時，聊天通知在 transaction 內送出；若之後刪除失敗回滾，通知已送出。
- 前端 `auth.interceptor.spec.ts` 偶發 NG0205 unhandled error（未修改的檔案；重跑 3 次皆通過）。

