-- Reference rows every deploy needs: without a region nearly every API answers
-- sys.errUnknownRegion. Taiwan only for now; other regions come from seed.sql or the
-- admin pages. INSERT OR IGNORE keeps rows an admin has since edited.
INSERT OR IGNORE INTO currencies (code, symbol, decimal_places, symbol_position, is_active) VALUES ('TWD', 'NT$', 0, 'prefix', 1);
--> statement-breakpoint
INSERT OR IGNORE INTO languages (code, name, native_name, is_active, sort_order) VALUES ('en', 'English', 'English', 1, 10), ('zh-TW', 'Traditional Chinese (Taiwan)', '繁體中文（台灣）', 1, 20);
--> statement-breakpoint
INSERT OR IGNORE INTO regions (code, name, default_currency, default_language, timezone, translations, languages, search_engines, edu_email_suffix, sort_order, is_active, created_at) VALUES ('TW', 'Taiwan', 'TWD', 'zh-TW', 'Asia/Taipei', '{"zh-TW":{"name":"台灣"},"zh-HK":{"name":"台灣"},"en":{"name":"Taiwan"}}', '["zh-TW","en"]', '["googlebooks","openlibrary","isbnnet"]', '[".edu.tw"]', 10, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
