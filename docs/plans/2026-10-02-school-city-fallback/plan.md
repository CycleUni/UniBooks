---
title: "學校加入城市分類，所選學校沒有書時改顯示同城市的書"
status: done
created: 2026-10-02
size: large
---

## 要求

- 每間學校屬於一個城市（縣市）。`[confirmed: 使用者「替學校加入城市分類」]`
- 首頁或搜尋結果裡，所選學校沒有書時，改顯示同城市其他學校的書。`[confirmed: 使用者]`
- 臺灣用 22 個縣市，以學校主校區所在地為準。香港分成港島、九龍、新界三區。
  `[confirmed: 使用者選「港島／九龍／新界」]`
- 自動換成同城市的書，上方加一行說明（「{學校} 目前沒有書，以下是{城市}其他學校的」），並附「看全部學校」的連結。不改動使用者選的學校。
  `[confirmed: 使用者選「自動改顯示同城市 + 說明」]`
- 學校選單依城市分組。`[confirmed: 使用者選「依城市分組」]`
- 這次不經過 brainstorming：設計上的分歧已用上面三個問題問完。

### 自主權範圍

- 已有：UniBooks-BE、UniBooks-FE、CycleUniProject/SchoolList 的寫入權限；本地 Django、Postgres、Angular 開發環境。
- 禁止：對正式環境資料庫執行 migration、部署、在使用者確認前 push。

### 現況（調查結果）

- `School` 有 `region`、`code`、`translations`，沒有任何地理欄位。`Region` 的翻譯欄位是 `translations` JSON。`[researched: accounts/models.py, core/models.py]`
- 首頁「最近上架」用 `recent_books/?school=`（`RecentBooksView`）；搜尋用 `BookSearchView`。兩者都用 `school_filter_id` 把 `?school=` 轉成 id。`[researched: listings/views/listings.py, search/views.py]`
- 搜尋有兩條路徑。
  - 瀏覽模式（分類、課程、只有篩選條件）：直接以學校過濾，沒書就是空的。
  - 關鍵字模式：本來就回傳全部學校的書，每本附 `localActiveListings`，再加上 `local_count`。前端在 `local_count === 0` 時顯示「此校沒有」。
- 學校選單資料來自 `/core/metadata/` 的 `schools`，有 24 小時快取。後台修改時呼叫 `invalidate_home_static_cache()` 清除。`[researched: accounts/views/home.py]`
- `ui-dropdown` 的選項只有 `{value,label}`，不支援分組。

## 決定

- **P3 資料模型：** 在 `core` 新增 `City`，欄位有 `region` FK、`code`、`name`、`translations`、`sort_order`，`(region, code)` 唯一。`School` 新增 `city`，是可為 null 的 FK，`on_delete=SET_NULL`。
  不用純字串欄位，因為城市名稱要能翻譯，也要排序。
- **P3 城市代碼：** 臺灣用 ISO 3166-2:TW 的縣市代碼（`TPE`、`NWT`…）；香港用 `HKI`、`KLN`、`NT`。用 data migration 建立，只在 region 已存在時建立。
- **P1 fallback 範圍：** 同城市的所有學校，不擴大到全區。同城市也沒有書時，維持原本的空狀態。
  - 已有的「看全部學校」入口可以讓使用者自己放寬範圍。
- **P1 觸發條件：** 只看所選學校在**整個查詢**裡的結果數，不是只看某一頁。
  - 首頁：學校的總數是 0。
  - 搜尋瀏覽模式：學校的書是 0 本。
  - 搜尋關鍵字模式：`local_count` 是 0，而且同城市有書。這時只換說明文字、加上「{城市}有」的標籤，不重新排序。
- **P1 由後端判斷 fallback：** 由後端判斷，同一個請求就回傳 fallback 結果。回應附 `scope: 'school' | 'city'` 和 `city`（代碼）。
  這樣前端不必多打一次請求，快取鍵也不變，因為輸入相同，輸出就相同。
- **P2 沒有城市的學校：** 不做 fallback。在選單裡歸到「其他」分組，排在最後。
- **P2 修改城市後的快取：** `recent_books` 的快取依 TTL（`HOME_RECENT_TTL`）自然過期；學校選單呼叫 `invalidate_home_static_cache()`。
- **P2 後台：** 學校編輯頁可以選城市；批次匯入接受 `city`（城市代碼）。
  - 代碼不存在時，整批回 `400 admin.errSchoolCityUnknown`，什麼都不寫入。這和 `errSchoolCodeInvalid` 的處理一致。
  - 城市本身先只放在 Django admin 管理，不做後台頁面。
- **P2 不確定位置的學校：** `ksit.edu.tw`、`thmu.edu.tw` 查不到可信的所在地，先不給城市（`null`）。
  - 另外 `mcu.edu.tw` 在 fixture 裡的名稱是「明志科技大學」，但這個網域屬於銘傳大學。這不在這次範圍內，只記錄下來；城市照網域歸到臺北市。

### 政策值（唯一位置）

| 名稱 | 值 | 位置 |
|---|---|---|
| 臺灣城市清單 | 22 縣市，ISO 3166-2:TW | `core/migrations/00xx_cities.py` |
| 香港城市清單 | `HKI` 港島、`KLN` 九龍、`NT` 新界 | 同上 |
| 學校 → 城市 | 依網域對應 | `SchoolList/4_build_schools.py` `CITY_BY_DOMAIN` |

### 四個模糊點的檢查

- ① 狀態轉換：顯示範圍只有三種，學校 → 同城市 → 空。不會再往外擴大到全區，因為「全部學校」是使用者自己的選擇。
- ② 規則同時成立：學校有一部分書，但同城市更多時，不做 fallback；只要有書就只顯示學校的書。關鍵字搜尋本來就顯示全區結果，只換文字和標籤。
- ③ 邊界值：觸發條件是 `== 0`，1 本就不觸發。這是使用者說的「沒有書」。
- ④ 失敗後回復：批次匯入先驗證整批的城市代碼，再寫入；fallback 是唯讀查詢，沒有需要回復的狀態。

## 實作計畫

### 第 1 階段：後端（UniBooks-BE）

1. `core/models.py`：新增 `City` 和 `localized_name`；在 `core/admin.py` 註冊。
2. `core/migrations`：新增 schema migration，再用 data migration 建立 25 個城市（含中文、英文、zh-HK 翻譯）。
3. `accounts/models.py` 加上 `School.city` 和 migration。
4. `accounts/views/home.py` 的 metadata：
   - `schools[].city` 回傳城市代碼或 `null`。
   - 新增 `cities`，格式是 `[{code, name, display_name}]`，依 `sort_order` 排序。
   - `select_related('city')`。
   - 快取裡如果是舊格式（沒有 `cities`），當成快取未命中。
5. `accounts/school_codes.py` 新增 `resolve_school` 的取用方式，讓 view 拿到 school 物件和 `city_id`。
6. `RecentBooksView` 在學校結果為 0、而且學校有城市時，改用 `listings__school__city_id` 重查。回應加上 `scope`、`city`。
7. `BookSearchView`：
   - 瀏覽模式：結果為 0 時，以城市重查，並設 `scope: 'city'`。
   - 關鍵字模式：加上 `city_active_listings_count` → `cityActiveListings`，以及 `city_count` 和 `city`。
8. `AdminSchoolSerializer` 加入 `city`。這是代碼的讀寫欄位：必須屬於學校所在的 region，否則回 `admin.errSchoolCityUnknown`。
9. 批次匯入接受 `city`：
   - 先驗證整批。
   - preview 時，有修改的項目也要比對 `city`。
10. 新增 `tests/test_school_city.py`，涵蓋：
    - metadata 的欄位。
    - recent_books 的三種情況：有書、fallback、同城市也沒有。
    - 搜尋瀏覽模式的 fallback、關鍵字模式的 `city_count`。
    - 後台 PATCH `city`，以及錯誤 region 的城市。
    - 批次匯入 `city`，以及未知代碼。
    - 跨 region 不混入。

### 第 2 階段：學校資料（CycleUniProject/SchoolList）

1. `4_build_schools.py` 新增 `CITY_BY_DOMAIN` 和 `--cities-only`，依網域填入 `city`；表上沒有的學校不帶 `city`，匯入時保留後台設定。
2. 用 `--cities-only` 重新產生三個 JSON，並更新 README。

### 第 3 階段：前端（UniBooks-FE）

1. `school-state.service.ts`：
   - `SchoolOption.city`、`CityOption`、`setCities`。
   - `getCityLabel(code)`、`getSchoolCity(schoolCode)`。
2. `dropdown.component.ts`：
   - `DropdownOption.group?`。
   - 分組標題是 `role="presentation"`，不能點。
   - 搜尋也比對分組名稱，例如輸入「臺北」會列出臺北市所有學校。
3. `layout.component.ts`：
   - 依城市的 `sort_order` 排序。
   - 沒有城市的學校歸到 `layout.otherCity` 分組。
   - 「全部大學」不分組，固定在最上面。
4. `recent-listings.component.ts`：
   - `scope === 'city'` 時，標題改成 `home.recentTitleCity`，上方顯示 `home.cityFallbackNote`。
   - 附「看全部學校」按鈕，呼叫 `setManualSchool('')`。
5. `search.ts`：
   - 關鍵字模式：`local_count === 0 && city_count > 0` 時，用 `search.foundCountNoneAtSchoolCity`。書的標籤改成 `search.inCity`。
   - 瀏覽模式的 `scope === 'city'`：顯示說明列。
6. 後台 `school-detail.component.ts`：加入城市下拉選單，選項取自目前地區的 `/core/metadata/` `cities`。後台頁面不一定載入過 layout 的學校清單，所以不從 `SchoolStateService` 拿。
7. i18n：en、zh-TW、zh-HK 同時新增 key，zh-HK 用粵語。
8. spec：
   - dropdown 的分組和以分組名稱搜尋。
   - recent-listings 的 fallback 說明。
   - search 的城市文字。

## 完成條件

- `cd UniBooks-BE && .venv/bin/python -m pytest tests -q` (exit 0)
- `cd UniBooks-BE && .venv/bin/python manage.py makemigrations --check --dry-run` (exit 0)
- `cd CycleUniProject/SchoolList && python3 4_build_schools.py --cities-only`：連跑兩次輸出相同、仍是 101 筆、只有 ksit／thmu 沒有 city（checklist C3，exit 0）
  - 原本的完整重建不能當完成條件：`tw_universities.json` 和已提交的 fixture 本來就不同步，重跑會多出 `pccu.edu.tw`、`english.web.ncku.edu.tw` 兩筆。這是既有問題，不在這次範圍內。
- `cd UniBooks-FE && npx ng test --watch=false` (exit 0)
- `cd UniBooks-FE && npm run build` (exit 0)
- 手動確認：本地開發伺服器的首頁，選一間沒有書的臺北學校，畫面顯示臺北市的書和說明，並附截圖。

## 驗證結果

2026-10-02，每項都是重新執行的結果。

| 項目 | 指令 | 結果 |
|---|---|---|
| C1 | `manage.py makemigrations --check --dry-run` | exit 0 |
| C2 | `pytest -q`（UniBooks-BE） | 795 passed，exit 0 |
| C3 | `4_build_schools.py --cities-only`（連跑兩次比對） | exit 0；101 筆，只有 ksit、thmu 沒有 city |
| C4 | `ng test --watch=false` | 104 個檔案、878 個測試全過，exit 0 |
| C5 | `npm run build` | exit 0 |

- 手動確認，在本地 dev server 上：
  - 首頁選國立臺北科技大學（沒有書），標題變成「Recently added in Taipei City」，上方有說明，並附「See all universities」。按下去以後，標題回到全部大學，header 的選單也一起改成 All Universities。
  - 學校選單有「Taipei City」分組標題。
  - `search/books/?q=Clean Code&school=NTUT` 回傳 `city_count: 1`、`cityActiveListings: 5`。
- 審查：這次是**作者自我審查**，沒有獨立審查。使用者沒有要求使用 subagent，所以沒有派 review-code／security-scan。自我審查沒有發現缺陷。
  - 新的輸入只有後台的 `city`：只限 staff 使用，並以 region 範圍驗證。`?school=` 的解析方式沒有改變。
- 本地資料庫已執行 migrate，並依 fixture 為 99 間學校填入城市。正式環境沒有動。

