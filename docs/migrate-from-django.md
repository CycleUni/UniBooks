# 從舊 Django/Postgres 後端搬遷資料到 Cloudflare D1

一次性搬遷：只保留**使用者帳號**與其**刊登（書籍、刊登、學校驗證）**，其餘捨棄。
工具是 `server/scripts/import-django.ts`（只用 Node 內建模組，Node >= 22），它讀取 Django 的 `dumpdata` JSON，輸出可直接給 `wrangler d1 execute` 的 SQL。

## 搬什麼、不搬什麼

保留：

| 類別 | 說明 |
| --- | --- |
| 參考資料 | 幣別、語言、地區（含 `languages` 多對多，轉成 JSON 文字欄）、城市、學校、分類 |
| `users` | 帳號資料、角色（superuser -> `admin`、staff -> `staff`、其餘 `user`）、通知與語言偏好、`deleted_at`；`managed_regions` 轉為 `staff_managed_regions` |
| `region_verifications` | 學校信箱驗證（`edu_email` 一律轉小寫） |
| `books` | 書籍目錄，含 `reviewed_by` |
| `listings` | 刊登，沿用 Django 的 UUID `id`；`photos` 的網址原樣保留 |

刻意不搬，以及原因：

- **密碼**：新站與 Django 同樣用 PBKDF2-SHA256、同一種雜湊格式，但 Workers 原生 PBKDF2 最多只接受 10 萬次迭代，舊站 Django 6.1 的雜湊遠超過這個次數，無法在 Worker 中驗證，所以不匯入。`password_hash` 一律為 `NULL`。使用者需用「忘記密碼」重設，或改用 Google 登入。
- **Google 綁定**：`google_id` 為 `NULL`；使用者下次用 Google 登入時，會依 email 自動重新綁定。
- **聊天訊息、訂單、評價、token（refresh / 一次性 / 推播裝置）、檢舉、訂閱、審計紀錄、廣告**：依產品決定不保留。這些 token 搬過來也無法使用。
- `is_banned` 舊系統沒有此欄位，一律為 0；舊的 `is_active=false` 會保留。
- **R2 物件原地不動**：刊登照片的網址仍指向同一個 R2 公開網域，不需要複製檔案，也不要刪除舊 bucket。

## 步驟

### 1. 在舊 Django 專案匯出

在舊專案目錄（`UniBooks-BE-Django`）內，載入原本連 Postgres 的環境變數（`DATABASE_URL` 或 `POSTGRES_*`，與正式環境相同），然後執行：

```bash
python manage.py dumpdata \
  core.Currency core.Language core.Region core.City \
  accounts.School core.Category \
  accounts.User accounts.RegionVerification \
  catalog.Book listings.Listing \
  --indent 0 > dump.json
```

`dump.json` 含有 email 等個資（以及舊密碼雜湊，但腳本不會讀取它），請勿提交到 git，用完即刪。

### 2. 產生 SQL

在新專案的 `server/` 目錄：

```bash
node --experimental-strip-types scripts/import-django.ts /path/to/dump.json > import.sql
# 或：npx tsx scripts/import-django.ts /path/to/dump.json > import.sql
```

stderr 會印出各表的「輸入 -> 輸出」筆數與略過原因，例如：

```
listings    1200 ->   1187   skipped: 13 missing seller
```

外鍵缺失（例如賣家不存在、書不存在）的列會被略過，請確認略過數量符合預期。`import.sql` 同樣含個資，請勿提交。

### 3. 先套用到本機 D1

```bash
npm --prefix server run predev        # 套用 migrations（也會建立 ads 資料庫）
cd server
npx wrangler d1 execute unibooks-apac --local --file src/db/seed.sql   # 可選：先灌 seed
npx wrangler d1 execute unibooks-apac --local --file import.sql
```

參考資料可在 seed 之後執行：腳本以自然鍵（地區+代碼等）upsert，不會與 seed 衝突。

### 4. 驗證筆數

與腳本 stderr 的「輸出」數字、以及舊資料庫比對：

```bash
npx wrangler d1 execute unibooks-apac --local --command "
SELECT 'users' t, count(*) n FROM users
UNION ALL SELECT 'staff_managed_regions', count(*) FROM staff_managed_regions
UNION ALL SELECT 'region_verifications', count(*) FROM region_verifications
UNION ALL SELECT 'books', count(*) FROM books
UNION ALL SELECT 'listings', count(*) FROM listings
UNION ALL SELECT 'users_with_password', count(*) FROM users WHERE password_hash IS NOT NULL
UNION ALL SELECT 'orphan_listings', count(*) FROM listings WHERE seller_id NOT IN (SELECT id FROM users) OR book_id NOT IN (SELECT id FROM books)"
```

預期 `users_with_password` 為 0（新站已有自行註冊者時例外）、`orphan_listings` 為 0。也可抽查：`SELECT role, count(*) FROM users GROUP BY role;`、`SELECT status, count(*) FROM listings GROUP BY status;`，並開本機站台用一個舊帳號走「忘記密碼」流程。

### 5. 套用到遠端

確認本機無誤後：

```bash
npx wrangler d1 execute unibooks-apac --remote --file import.sql
```

腳本不含 `BEGIN/COMMIT`（D1 不接受），每條陳述式佔一行，並依外鍵順序排列。檔案很大時可用 `split -l 5000 import.sql part_` 切檔後依序執行（切檔後要保持順序：`part_aa`、`part_ab`...）。建議先對遠端做 `wrangler d1 export unibooks --remote --output backup.sql` 備份。

最後通知使用者：請用「忘記密碼」重設，或直接使用 Google 登入。

## 重複執行是否安全

可以。腳本是為了重跑設計的：

- 使用者 ID 是舊整數主鍵的 UUIDv5（固定 namespace，寫在腳本的 `NAMESPACE`，**不可更改**）；書籍亦同；刊登沿用原 UUID。重跑得到相同 ID。
- 參考資料用 `ON CONFLICT ... DO UPDATE` 更新；使用者、書、刊登、驗證用 `INSERT OR IGNORE`，**已存在的列不會被覆蓋**，所以不會洗掉使用者在新站已設定的密碼、Google 綁定，或新站上的編輯。
- 學校、分類、城市、使用者、書的外鍵以自然鍵子查詢解析（地區+學校代碼、地區+分類 slug、email、地區+ISBN），因此即使 `seed.sql` 先建立了不同自增 ID 的列，關聯仍然正確。

若要整批重來，先清掉匯入的列（`DELETE FROM listings; DELETE FROM books; ...`，注意外鍵順序）再重新執行即可。

## 已知限制

- 若新站已有相同 email 的帳號（例如已先用 Google 註冊），該舊帳號不會新增，其刊登會歸到新站那個帳號。
- Django 的 email 在轉小寫後若重複，後者整筆略過（含其刊登）。
- 學校的 `created_at`、地區的 `created_at` 舊系統沒有，使用執行腳本當下的時間；`users.updated_at` 沿用 `created_at`。
- 驗證的 `verified_at` 在 D1 為必填；舊資料為空時改用 `created_at`。`expires_at` 一律為 `NULL`（與新系統的驗證流程一致）。
- 腳本自測：`cd server && node --experimental-strip-types --test scripts/import-django.test.ts`。
