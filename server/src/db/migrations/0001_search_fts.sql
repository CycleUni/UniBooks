-- Full-text index for the keyword search (docs/search.md). FTS5 with the
-- trigram tokenizer: any substring of 3 or more characters, CJK included,
-- case-insensitive. External content: the index holds no copy of the text,
-- which stays in books / listings, and the triggers below keep it in step.
-- Derived data: `INSERT INTO <t>(<t>) VALUES ('rebuild')` recreates it from
-- the source tables at any time.
--
-- D1 refuses `wrangler d1 export` while any virtual table exists: drop the
-- six triggers and the two tables before exporting (the triggers live on
-- books / listings and would fail every write without the tables), then run
-- this file again. See docs/search.md.
CREATE VIRTUAL TABLE IF NOT EXISTS `books_fts` USING fts5(
  title, authors, isbn13,
  content='books', content_rowid='rowid', tokenize='trigram'
);
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `listings_fts` USING fts5(
  course_name, professor_name,
  content='listings', content_rowid='rowid', tokenize='trigram'
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `books_fts_ai` AFTER INSERT ON `books` BEGIN
  INSERT INTO books_fts(rowid, title, authors, isbn13) VALUES (new.rowid, new.title, new.authors, new.isbn13);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `books_fts_ad` AFTER DELETE ON `books` BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, authors, isbn13) VALUES ('delete', old.rowid, old.title, old.authors, old.isbn13);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `books_fts_au` AFTER UPDATE OF title, authors, isbn13 ON `books` BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, authors, isbn13) VALUES ('delete', old.rowid, old.title, old.authors, old.isbn13);
  INSERT INTO books_fts(rowid, title, authors, isbn13) VALUES (new.rowid, new.title, new.authors, new.isbn13);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `listings_fts_ai` AFTER INSERT ON `listings` BEGIN
  INSERT INTO listings_fts(rowid, course_name, professor_name) VALUES (new.rowid, new.course_name, new.professor_name);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `listings_fts_ad` AFTER DELETE ON `listings` BEGIN
  INSERT INTO listings_fts(listings_fts, rowid, course_name, professor_name) VALUES ('delete', old.rowid, old.course_name, old.professor_name);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `listings_fts_au` AFTER UPDATE OF course_name, professor_name ON `listings` BEGIN
  INSERT INTO listings_fts(listings_fts, rowid, course_name, professor_name) VALUES ('delete', old.rowid, old.course_name, old.professor_name);
  INSERT INTO listings_fts(rowid, course_name, professor_name) VALUES (new.rowid, new.course_name, new.professor_name);
END;
--> statement-breakpoint
INSERT INTO books_fts(books_fts) VALUES ('rebuild');
--> statement-breakpoint
INSERT INTO listings_fts(listings_fts) VALUES ('rebuild');
