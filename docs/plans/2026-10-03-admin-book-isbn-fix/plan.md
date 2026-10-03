---
title: "管理後台修正書目 ISBN、重新抓取書目資料，並在存入書目時嚴格驗證 ISBN"
status: done
created: 2026-10-03
size: medium
---

## 要求

- 管理後台可以手動修改書目，也可以依 ISBN 重新抓取外部書目資料。`[confirmed: 使用者選「A + 驗證」]`
- 修正後的 ISBN 如果已被同地區另一本書使用，就把錯誤的書目合併到那本書。`[confirmed: 使用者選 A（含合併）]`
- 建立或修改書目時，ISBN 要通過檢查碼驗證；13 碼的還要以 978/979 開頭。`[confirmed: 使用者「+ 驗證」]`
- 這次不經過 brainstorming：範圍和做法已在對話中選定（A + 驗證）。

### 背景（調查結果）

- 正式環境 book id 6（TW）的 `isbn13=6770250629200`，書是 7天攻頂TOEIC 多益閱讀（不求人文化），正確 ISBN 是 `9789860629200`。前 6 碼被讀錯，檢查碼仍然成立。建立時間是 2026-09-25，在掃描前綴修正 `6f7a4ff`（09-27）之前。`[researched: api.unibooks.app/api/v1/books/?isbn=6770250629200；博客來 0010892846, n=1]`
- 會寫入 `Book.isbn13` 的路徑：
  - `ManualBookCreateView`（`catalog/views.py`）：**完全不驗證**。
  - 刊登 PATCH（`listings/views/listings.py`）：只驗格式。
  - 訂閱 POST（`subscriptions/views.py`）：用外部查詢建立。`[researched: grep Book.objects.create / BookSerializer(data)]`
- 和 Book 有 FK 的資料：
  - `Listing.book`（CASCADE）。
  - `Subscription.book`（CASCADE），而且 `unique_together=(user, book)`。
  - 訂單只經過 listing 連到書，完成的訂單另有快照。`[researched: */models.py]`
- 快取：
  - `book_detail`、`listing_list`、`listing:<pk>` 用 generation，靠 `bump_cache_version` 清。
  - `home_waitlist` 用 `safe_cache_delete` 清。
  - Listing 的 post_save 會自動 bump 前三者。`[researched: listings/models.py, subscriptions/models.py]`
- 後台已經有書籍統計頁 `/admin/stats/books/:id`（`book-stats.component.ts`）。書籍排行可以用 ISBN 搜尋到這一頁。`[researched: app.routes.ts, AdminStatsBookRankingView]`
- 權限：所有後台 view 都用 `IsAdminUser, IsRegionManager`。物件權限依 `_object_region(obj)` 判斷。`[researched: adminapi/permissions.py]`

### 自主權範圍

- 已有：UniBooks-BE、UniBooks-FE 的寫入權限；本地測試環境。
- 禁止：
  - 修改正式環境的資料（book id 6 等使用者部署後自己在後台修）。
  - 部署。
  - 在使用者確認前 push。

## 決定

- **P3 嚴格驗證：** 共用一個函式 `validate_book_isbn(s)`。
  - 先做格式清理，再驗檢查碼。
  - 13 碼必須以 978/979 開頭。
  - 10 碼照現狀原樣保存，不轉成 13 碼。
  - 回傳清理後的字串，或 `None`。
- **P1 套用範圍：**
  - 使用嚴格驗證的寫入點：ManualBookCreate、刊登 PATCH 的 `isbn`、後台書目 PATCH 和抓取。
  - 維持只驗格式的讀取路徑：書目頁 `?isbn=`、搜尋、訂閱的 ISBN 查詢。
  - 理由：讀取時查不到只是 404，不會留下錯誤資料。
- **P1 ManualBookCreate 遇到不合格的 ISBN：** 回 `400 {"error":{"code":"listing.errInvalidIsbn"}}`，沿用既有的 i18n key。
  - 前端賣書表單只在通過嚴格驗證時才帶入 ISBN，否則送空字串（書目不帶 ISBN）。正常使用不會碰到 400。
- **P1 後台書目 API：**
  - `GET /api/v1/admin/books/<pk>/lookup/?isbn=`
    - 用嚴格驗證，再依地區允許的引擎、`ISBN_FALLBACK_ORDER` 查詢。
    - 回傳 `{isbn13,title,authors,publisher,published_date,cover_url,source,existing_book}`。
    - `existing_book` 是同地區另一本使用這個 ISBN 的書（`{id,title}` 或 `null`）。
    - 查不到時回 `404 admin.errBookLookupNotFound`；ISBN 不合格時回 `400 listing.errInvalidIsbn`。
    - 只讀，不寫入任何資料。
  - `PATCH /api/v1/admin/books/<pk>/`
    - 可修改的欄位：`title`、`authors`、`publisher`、`published_date`、`cover_url`、`isbn13`、`source`、`merge`。
    - `source` 只接受 `SOURCE_CHOICES` 內的值，前端套用抓取結果時才會送。
    - `title` 不能是空的。`isbn13` 可以是空字串，代表沒有 ISBN。
  - 權限：`IsAdminUser, IsRegionManager`。只能操作自己管理的地區的書，其他地區回 404。
- **P1 ISBN 衝突：** `isbn13` 已被同地區的書 B 使用。
  - 沒有 `merge` 時：回 `409 {"error":{"code":"admin.errBookIsbnTaken","existing_book":{"id","title"}}}`。前端用 `askDanger` 確認後，帶 `merge: true` 重送。
  - 有 `merge: true` 時，把 A 併入 B：
    1. A 的 listings 全部改指向 B（逐筆 save，觸發快取清除）。
    2. A 的訂閱：同一使用者已訂閱 B 時，刪掉 A 的訂閱；否則改指向 B。
    3. 刪除 A。
    4. **B 的書目資料不變**，這次送出的其他欄位不套用到 B。
  - 回應 `{merged_into: B.id, book: <B>}`，前端導向 B 的統計頁。
- **P0 檢查（④ 失敗後回復）：** 合併和修改都包在 `transaction.atomic()` 裡。任何一步失敗，整筆都回復，不會留下一半搬過去的資料。
  - 快取清除只是讓快取失效，不需要回復。
- **P2 快取：**
  - 修改書目後，bump `book_detail`、`listing_list`，以及這本書每筆 listing 的 `listing:<pk>`，並刪除 `home_waitlist`。
  - 合併時，listing 的 save 會自動 bump；另外再刪除 `home_waitlist`。
- **P2 不在這次範圍內（記錄下來）：**
  - 同一本書可能同時有 10 碼和 13 碼兩筆書目。
  - 訂閱 POST 從外部查詢建立的書目不做嚴格驗證（ISBN 來自使用者要查的值，外部查到才會建立）。
  - 賣書時，輸入的數字沒有通過檢查碼的話，可以提示「ISBN 可能輸入錯誤」。

### 四個模糊點的檢查

- ① 狀態轉換：書目只有三種結果。
  - 修改成功。
  - 衝突 → 確認 → 合併後消失。
  - 驗證失敗不變。
  - 合併只能把 A 併入 B，不能反過來。要反過來，就到 B 的頁面操作。
- ② 規則同時成立：
  - 新的 ISBN 等於自己原本的 ISBN 時，不算衝突（`exclude(pk)`），可以用來只重新抓取資料。
  - 合併時，兩邊都有同一使用者的訂閱：留下 B 的那筆。
- ③ 邊界值：ISBN 長度只接受 10 和 13。只有 13 碼的 ISBN 要檢查前綴，必須是 978 或 979；10 碼不檢查前綴。
- ④ 失敗後回復：見上面的 P0 檢查。

## 實作計畫

### 第 1 階段：後端（UniBooks-BE）

1. `catalog/services/isbn.py`：新增 `isbn_checksum_ok`、`validate_book_isbn`，並從 `catalog/services/__init__.py` 匯出。
2. `catalog/views.py` `ManualBookCreateView`：`isbn13` 不是空的時，先用 `validate_book_isbn` 驗證，不合格就回 400；之後用清理後的值查重和建立。
3. `listings/views/listings.py`：刊登 PATCH 的 `isbn` 改用 `validate_book_isbn`。
4. 新增 `adminapi/views/books.py`：
   - `AdminBookLookupView`、`AdminBookDetailView`（PATCH）。
   - 合併邏輯放在 `catalog/merge.py` 的 `merge_book_into(src, dst)`。
5. `adminapi/urls.py`：加入路由 `books/<int:pk>/`、`books/<int:pk>/lookup/`。
6. 新增 `tests/test_admin_book_fix.py`，涵蓋：
   - 驗證函式：真實 ISBN 合格；6770250629200 不合格；檢查碼錯誤；ISBN-10 含 X。
   - ManualBookCreate 遇到不合格 ISBN 時回 400。
   - 刊登 PATCH 遇到不合格 ISBN 時回 400。
   - lookup 以 mock 外部查詢回傳資料。
   - lookup 對其他地區的書回 404。
   - 一般使用者呼叫 lookup 回 403。
   - PATCH 修改欄位。
   - 衝突時回 409。
   - 合併時搬移 listings、訂閱，重複的訂閱只留一筆，並刪除原本的書。
   - 書目頁快取失效。

### 第 2 階段：前端（UniBooks-FE）

1. `core/isbn.ts`：
   - 新增 `bookIsbn(s)`（嚴格驗證）。
   - `isbnFromScan` 改成呼叫它。
   - 更新註解：存入書目也要嚴格驗證。
2. `sell.ts`：手動建立書目時，ISBN 只在 `bookIsbn` 通過時才帶入。
3. `core/services/admin-stats.service.ts`，或新增 `admin-books.service.ts`：`lookupBook`、`updateBook`。
4. `book-stats.component.ts`：新增「編輯書目」區塊，預設收合。
   - 表單：ISBN、書名、作者、出版社、出版日期、封面網址。
   - 「依 ISBN 抓取」把抓到的資料填入表單作為預覽，並記下 `source`；抓到的 ISBN 已被另一本書使用時，提示會合併。
   - 「儲存」送出 PATCH；遇到 409 時，用 `askDanger` 確認合併後再重送，成功後導向合併後的那本書。
   - 按鈕在請求期間停用。
5. i18n：en、zh-TW、zh-HK 同時新增 `admin.book.*`、`admin.errBookIsbnTaken`、`admin.errBookLookupNotFound`，zh-HK 用粵語。
6. spec：
   - `isbn.spec.ts` 的 `bookIsbn`。
   - `sell.spec.ts`：不合格的 ISBN 不帶入。
   - `book-stats` 編輯：抓取後填入表單；409 時要求確認，確認後帶 `merge` 重送。

## 完成條件

- `cd UniBooks-BE && .venv/bin/python -m pytest tests -q` (exit 0)
- `cd UniBooks-BE && .venv/bin/python manage.py makemigrations --check --dry-run` (exit 0；這次不應該有 migration)
- `cd UniBooks-FE && npx ng test --watch=false` (exit 0)
- `cd UniBooks-FE && npm run build` (exit 0)
- 手動確認：在本地開發伺服器建立一本 ISBN 錯誤的書目，在後台抓取並合併，並附截圖。

## 驗證結果

2026-10-03，每項都是重新執行的結果（`checklist.py verify` exit 0）。

| 項目 | 指令 | 結果 |
|---|---|---|
| C1 | `pytest tests -q`（UniBooks-BE） | 824 passed，exit 0 |
| C2 | `manage.py makemigrations --check --dry-run` | exit 0（沒有 migration） |
| C3 | `ng test --watch=false` | 105 個檔案、889 個測試全過，exit 0 |
| C4 | `npm run build` | exit 0 |

- 手動確認，在本地 dev server 上：
  - 建立 ISBN 為 6770250629200 的書目並附一筆刊登。
  - 在後台按「抓取」：誤讀的號碼在前端就被擋下。正確的 ISBN 在本地查不到，因為本地只有 Open Library 有回應；正式環境的 ISBNnet 查得到這本書（`source: isbnnet_api`）。改用 K&R 的 ISBN 9780131103627 測試，抓到的資料有填入表單。
  - 輸入 9789860629200 後儲存：跳出合併確認，確認後導向合併後的書目，刊登也一起搬過去。
  - 公開書目頁：舊 ISBN 回 404，新 ISBN 顯示 1 筆刊登。
  - 手機寬度（375px）沒有橫向捲動。
  - 測試資料已刪除。
- 手動確認時找到並修正的問題：
  - 編輯卡片沒有吃到統計頁的 `.card` 樣式（view encapsulation），已共用 `STATS_PAGE_STYLES`。
  - Chrome 把 `title`、`authors` 等欄位當成個人資料自動填入，深色模式下顯示成白底，已加上 `autocomplete="off"`。
- 合併時，如果錯誤的書目沒有任何刊登，就不會觸發快取清除。已在合併後明確清除。
- 審查：這次是**作者自我審查**，沒有獨立審查。使用者沒有要求使用 subagent，所以沒有派 review-code／security-scan。
  - 新的輸入只有後台的兩個端點，只限 staff 使用，並依地區限制範圍。
  - `cover_url` 只接受 http(s)。
- 正式環境沒有動。book id 6 要部署後在後台修正。

### 獨立審查後的修正（2026-10-03）

使用者要求用 agent 審查。結果：
- review-code 判定 ACCEPT（MEDIUM 2、LOW 4）。
- security-scan 判定 PASS（MEDIUM 2、LOW 4）。

依使用者核可的清單修正 1–8：
1. ISBN 只接受 ASCII 數字。改在 `clean_and_validate_isbn`，和前端的 `/^\d+$/` 一致。原本 `²` 會造成 500，全形和阿拉伯-印度數字會被原樣存入。
2. 合併和修改都依 id 順序 `select_for_update` 鎖住相關書目，取得鎖之後重新檢查衝突。
   - 這段期間另一本書搶先使用同一個 ISBN：回 409，不會合併到沒有鎖住的書。
   - unique constraint 拋出的 `IntegrityError` 改回 409。
3. 抓取結果中的 `null` 欄位，後端和前端都轉成空字串。
4. 編輯 ISBN 或關閉表單時，取消進行中的抓取，並丟掉過期的回應。改了 ISBN 之後，不再送出抓取時記下的 `source`。
5. 只在 ISBN 有改動時才送出，原本就不合格的 ISBN 不會擋住其他欄位的修正；另外顯示提示 `admin.book.storedIsbnInvalid`。
6. `cover_url` 改用 `URLValidator(schemes=['http','https'])`，並限制長度 1024；非物件的 body 回 400。
7. 合併的稽核紀錄改為記下原書目的完整資料、搬過去的刊登 id、搬過去的求書 id，以及被刪掉的重複求書。
8. 書本統計詳細頁只顯示目前地區的書。原本的測試（其他地區的書回 200、數字全為 0）改成預期 404。

重新執行的結果：

| 項目 | 結果 |
|---|---|
| `checklist.py verify` | exit 0 |
| pytest | 835 passed |
| `ng test` | 105 個檔案、893 個測試全過 |

手動確認，在本地 dev server 上：
- 舊的錯誤 ISBN 會顯示提示；只改書名可以儲存，ISBN 保留原值。
- TW 頁面打開 HK 的書目會顯示載入失敗。
- 測試資料已刪除。

不在這次範圍內（記錄下來）：
- 抓取端點沒有頻率限制（L-4）。
- 合併後沒有通知求書者（ATK-004）。
- 舊版前端碰到 ManualBookCreate 的 400（ATK-005，屬於部署過渡期）。
- 手動建立書目時 `cover_url` 沒有驗證（既有問題）。
