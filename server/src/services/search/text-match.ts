/**
 * Keyword matching for search: the one place that knows how text is matched
 * in SQL. Moving off SQLite means replacing this file (docs/search.md).
 *
 * SQLite / D1: the FTS5 trigram indexes `books_fts` and `listings_fts`
 * (migration 0001_search_fts) answer any substring of INDEX_MIN_CHARS or more
 * characters; a shorter text has no trigram to look up, so it is matched by
 * scanning, as before the index existed.
 */
import { frag, join, type Frag } from '../../lib/sql-frag';

/** Shortest text (in characters) the trigram index can answer. */
export const INDEX_MIN_CHARS = 3;

export interface TextMatch {
  /** Whether the index answers this text. When false, the fragments scan: put them where a LIMIT can stop the scan early. */
  indexed: boolean;
  /** A book (by table alias) whose title, authors or ISBN contains the text. */
  book(alias: string): Frag;
  /** A listing (by table alias) whose course or professor name contains the text. */
  listing(alias: string): Frag;
}

const contains = (col: string, text: string) => frag(`instr(upper(${col}), upper(?)) > 0`, text);
const anyOf = (parts: Frag[]): Frag => {
  const j = join(parts, ' OR ');
  return frag(`(${j.sql})`, ...j.args);
};

/** The text as one FTS5 phrase: matched as a literal substring, never parsed as query syntax. */
export const ftsPhrase = (text: string) => `"${text.replaceAll('"', '""')}"`;

export function textMatch(text: string): TextMatch {
  if ([...text].length >= INDEX_MIN_CHARS) {
    const phrase = ftsPhrase(text);
    return {
      indexed: true,
      book: (a) => frag(`${a}.rowid IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)`, phrase),
      listing: (a) => frag(`${a}.rowid IN (SELECT rowid FROM listings_fts WHERE listings_fts MATCH ?)`, phrase),
    };
  }
  return {
    indexed: false,
    book: (a) => anyOf([contains(`${a}.title`, text), contains(`${a}.authors`, text), contains(`coalesce(${a}.isbn13, '')`, text)]),
    listing: (a) => anyOf([contains(`${a}.course_name`, text), contains(`${a}.professor_name`, text)]),
  };
}
