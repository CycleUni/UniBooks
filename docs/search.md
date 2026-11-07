# 書籍關鍵字搜尋：全文索引設計與遷移注意事項

`GET /api/v1/search/books?q=…` 的本地比對（書名、作者、ISBN、刊登的課程與教授）
使用 SQLite FTS5 trigram 全文索引。本文記錄設計、維運方式，以及**日後匯出 D1 或
轉移到 Postgres 時必須處理的事**。

| 檔案 | 內容 |
|---|---|
| `server/src/db/migrations/0001_search_fts.sql` | 建立 `books_fts`、`listings_fts`、6 個同步 trigger，並從現有資料建立索引 |
| `server/src/services/search/text-match.ts` | **唯一**知道「文字怎麼比對」的地方；換資料庫時替換這個檔案 |
| `server/src/routes/search.ts` | 用 `textMatch()` 組出搜尋與 facet 查詢 |
| `server/test/catalog/search-index.spec.ts` | 比對語意、trigger 同步、重建的測試 |

## 設計

- **FTS5 + `tokenize='trigram'`**：任何 3 個字元以上的子字串都能查（中文、英文、
  ISBN 片段皆可），不分大小寫。語意等同舊的 `instr(upper(col), upper(?))`
  子字串比對，只是改為查索引。
- **External content**（`content='books'`、`content_rowid='rowid'`）：索引不另存
  一份文字，文字只在 `books` / `listings`。索引是**衍生資料**，隨時可由原表重建。
- **Trigger 同步**：`books` 的 `INSERT` / `DELETE` / `UPDATE OF title, authors, isbn13`，
  `listings` 的 `INSERT` / `DELETE` / `UPDATE OF course_name, professor_name`。
  應用程式的寫入程式碼不需要知道索引存在。刊登狀態（`status`）不在索引裡，
  由查詢時 join `listings` 篩選，所以改狀態不會寫索引。
- **少於 3 個字元**（以字元計，不是 byte）：trigram 沒有可查的詞，`textMatch()`
  退回舊的 `instr` 掃描，並維持「新到舊掃描、`LIMIT` 提早停止」的查詢形狀。
- **使用者輸入一律當成一個 phrase**（`ftsPhrase()`：外加雙引號、內部 `"` 變 `""`），
  `OR`、`NEAR(`、`*` 等 FTS 語法只會被當成一般字元。
- **查詢形狀**：先由索引得出候選集合（`UNION`），再 `CROSS JOIN` 到 `books`（facet 則是
  `listings`、`books`）。SQLite 會依 `CROSS JOIN` 的書寫順序執行，所以不論有沒有
  `ANALYZE` 統計資料，都會先讀候選集合，再用主鍵查表。實測若寫成 `b.id IN (候選)`，
  在沒有統計資料時，SQLite 會改為掃描全部書籍再比對集合（10 萬本：0.16 ms 變 14 ms）。

## 效能實測（2026-11-07，本機 SQLite 3.50，合成資料，不含 D1 網路往返）

10 萬本書、約 13 萬筆刊登：

| 查詢 | 舊 `instr` 掃描 | FTS5 trigram |
|---|---|---|
| 少見的長詞（「量子力學習題」） | 69 ms | 0.12–0.16 ms |
| 查無結果（「不存在的書名」） | 96 ms | 0.01 ms |
| 常見詞（「微積分」、「calculus」） | 3–4 ms | 2–4 ms |
| 2 字詞（「微積」，退回掃描） | 4 ms | 4 ms（相同） |
| 查無結果的 2 字詞（「鯨魚」） | 99 ms | 103 ms（相同，已知缺口） |

額外空間：原始資料的約 16%（10 萬本 +7.5 MB）。

### 曾評估、未採用：自建 bigram 索引表

一般資料表 `search_grams(gram, doc_type, doc_id)` 加 B-tree 索引。優點是 2 字中文
也能走索引（查無結果的 2 字詞 0.01 ms）、可正常 `d1 export`。未採用的原因是空間
約 +176%（10 萬本 +81 MB，每本書約多 16 列），D1 寫入列數也同比增加；3 字以上的
查詢比 FTS5 慢 2–30 倍；而且轉到 Postgres 時一樣會改用原生索引，可攜性優勢有限。

## 已知限制

1. **少於 3 個字元的查詢不走索引**，查無結果時會掃描全表（10 萬本約 100 ms）。
   轉到 Postgres 後可用 pg_bigm 補上（見下文）。
2. **整個 D1 資料庫無法用 `wrangler d1 export` 匯出**，見下一節。
3. **索引依賴 `books` / `listings` 的 rowid**。這兩張表的主鍵是 UUID 文字，rowid 是
   SQLite 隱含的整數；只有 `VACUUM` 或把資料匯出再匯入會改變它。D1 不允許執行
   `VACUUM`（會回 `cannot VACUUM from within a transaction`）。**資料匯入或還原之後，
   一定要重建索引**（見「維運」）。
4. **不要對 `books` / `listings` 使用 `INSERT OR REPLACE` / `REPLACE INTO`**：衝突時刪除
   舊列不會觸發 `DELETE` trigger（除非開啟 `recursive_triggers`），索引會留下錯誤的
   項目。請改用 `INSERT … ON CONFLICT DO UPDATE`，它會觸發 `UPDATE` trigger。
   目前程式碼裡沒有對這兩張表的 `REPLACE`。
5. 大小寫折疊比舊版廣：trigram 依 Unicode 折疊（例如 `É` / `é`），舊的 `upper()` 只處理 ASCII。

## 維運

```sql
-- 從原表整個重建（資料匯入／還原後、懷疑索引不一致時）
INSERT INTO books_fts(books_fts) VALUES ('rebuild');
INSERT INTO listings_fts(listings_fts) VALUES ('rebuild');

-- 檢查索引是否與原表一致（不一致會回錯誤）
INSERT INTO books_fts(books_fts, rank) VALUES ('integrity-check', 1);
INSERT INTO listings_fts(listings_fts, rank) VALUES ('integrity-check', 1);
```

正式環境執行方式：`npx wrangler d1 execute unibooks --remote --command "<上面的 SQL>"`。

日常備份用 D1 Time Travel，不受 FTS5 影響（Cloudflare 文件的說法，未實測）。

## 匯出 D1（`wrangler d1 export`）

只要資料庫裡有任何虛擬表，D1 就拒絕匯出**整個**資料庫
（[D1 文件](https://developers.cloudflare.com/d1/best-practices/import-export-data/)、
[workers-sdk#6305](https://github.com/cloudflare/workers-sdk/issues/6305)）。社群回報指
`--table` 篩選在這個檢查之後才套用，無法繞過，以下流程不依賴它。
以下刪除與重建步驟已在本機 D1 實測（2026-11-07）。

**必須連 trigger 一起刪除**：trigger 掛在 `books` / `listings` 上，只刪 FTS 表會讓之後
每一筆書籍或刊登的寫入都失敗（`no such table: books_fts`）。

1. 進入維護時段（期間關鍵字搜尋會出錯；寫入正常，但不會進索引，最後重建時補上）。
2. 刪除 trigger 與 FTS 表：
   ```sql
   DROP TRIGGER IF EXISTS books_fts_ai;
   DROP TRIGGER IF EXISTS books_fts_ad;
   DROP TRIGGER IF EXISTS books_fts_au;
   DROP TRIGGER IF EXISTS listings_fts_ai;
   DROP TRIGGER IF EXISTS listings_fts_ad;
   DROP TRIGGER IF EXISTS listings_fts_au;
   DROP TABLE IF EXISTS books_fts;
   DROP TABLE IF EXISTS listings_fts;
   ```
3. `npx wrangler d1 export unibooks --remote --output unibooks.sql`
4. 如果還要繼續用 D1：重新執行 migration 檔（它會建表、建 trigger，並 `rebuild`）。
   這份 migration 已記錄在 `d1_migrations`，`migrations apply` 不會再跑，要直接執行檔案：
   ```bash
   npx wrangler d1 execute unibooks --remote --file server/src/db/migrations/0001_search_fts.sql
   ```

匯出的 `.sql` 不含 FTS 表；匯入到新的 D1 後，同樣執行一次上面的 migration 檔來建立索引。

## 轉移到 Postgres

FTS5 表**不需要也不應該**搬過去：只搬 `books`、`listings` 等原始資料表，丟棄
`books_fts`、`listings_fts` 與 6 個 trigger，在 Postgres 端由資料直接建立索引。

1. 依上一節刪除 FTS 表與 trigger，再匯出資料。
2. 在 Postgres 建立原生的子字串索引，二擇一：
   - **pg_trgm**（多數託管平台內建）：語意與目前相同，3 字以上走索引。
     ```sql
     CREATE EXTENSION IF NOT EXISTS pg_trgm;
     CREATE INDEX books_title_trgm ON books USING gin (title gin_trgm_ops);
     CREATE INDEX books_authors_trgm ON books USING gin (authors gin_trgm_ops);
     CREATE INDEX books_isbn13_trgm ON books USING gin (isbn13 gin_trgm_ops);
     CREATE INDEX listings_course_trgm ON listings USING gin (course_name gin_trgm_ops);
     CREATE INDEX listings_professor_trgm ON listings USING gin (professor_name gin_trgm_ops);
     ```
   - **pg_bigm**：以 2 字元為單位，**2 字中文也走索引**，可補上限制 1。
     要先確認託管平台是否提供這個擴充（尚未確認）。
3. 只改寫 `server/src/services/search/text-match.ts`，`search.ts` 的查詢結構不用動：

   | `textMatch()` 產生的片段 | SQLite / D1（現在） | Postgres |
   |---|---|---|
   | `book(a)` | `a.rowid IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)` | `(a.title ILIKE ? OR a.authors ILIKE ? OR a.isbn13 ILIKE ?)` |
   | `listing(a)` | `a.rowid IN (SELECT rowid FROM listings_fts WHERE listings_fts MATCH ?)` | `(a.course_name ILIKE ? OR a.professor_name ILIKE ?)` |
   | 綁定值 | `ftsPhrase(text)` | `'%' + 跳脫 % _ \ 後的 text + '%'` |
   | `INDEX_MIN_CHARS` | 3 | pg_trgm：3；pg_bigm：2 |
   | 短字串退回 | `instr(upper(col), upper(?)) > 0` | 同上面的 `ILIKE`（會掃描） |

   Postgres 沒有 rowid；上表的寫法直接比對欄位，GIN 索引會被 `ILIKE '%…%'` 使用。
4. `search.ts` 裡其他 SQLite 寫法也要一併改寫：`json_each(?)` 改成 `= ANY(?)`，`?` 佔位符
   改成 `$n`。`CROSS JOIN … WHERE` 在 Postgres 是合法語法（不可寫成 `CROSS JOIN … ON`），
   但 Postgres 不把它當成 join 順序的提示，執行順序由 planner 依統計資料決定。
5. 用 `server/test/catalog/search-index.spec.ts` 的案例驗證語意一致。
