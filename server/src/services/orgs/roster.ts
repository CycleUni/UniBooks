/**
 * An organization's member roster: one row per student number. Rows come in
 * one by one or as an import; both go through validateMember and writeMembers,
 * so a row is checked and stored the same way whichever way it came.
 */
import type { Env } from '../../env';
import type { Organization, OrganizationMember } from '../../db';
import { normalizeStudentNumber } from '../../lib/studentNumber';
import { canonicalDepartment, regionCategories } from '../listings/places';

export const MAX_NAME = 50;
export const MAX_DEPARTMENT = 50;
export const MAX_GRADE = 7;
/** Rows one import may carry, and the body size that allows. */
export const MAX_IMPORT_ROWS = 10000;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
/** Problem rows an import answer lists; the counts still cover every row. */
const MAX_ISSUES = 200;
/** Rows per INSERT: one json_each statement each, all in one batch. */
const WRITE_CHUNK = 500;

export const IMPORT_MODES = ['merge', 'replace'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

/** The region's categories, as canonicalDepartment reads them. */
export type RegionCategories = Array<{ row: Record<string, unknown> }>;

/** A row as stored, ready to write. */
export interface MemberInput {
  studentNumber: string;
  name: string;
  department: string;
  grade: number | null;
  validUntil: string;
}

export interface MemberCheck {
  member: MemberInput | null;
  /** i18n keys; the row is not written while there are any. */
  errors: string[];
  /** i18n keys; the row is written anyway. */
  warnings: string[];
}

/** Today as YYYY-MM-DD (UTC): a member counts through their valid_until day. */
export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The last day of the academic year `now` falls in: 31 July, as the year
 * runs August to July. The default end of a membership.
 */
export function academicYearEnd(now = new Date()): string {
  const y = now.getUTCMonth() >= 7 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  return `${y}-07-31`;
}

/** A date as a spreadsheet writes it (2027-07-31, 2027/7/31, 2027.7.31) as YYYY-MM-DD; null when it is none. */
export function parseDate(v: string): string | null {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(v);
  if (!m) return null;
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

const NUMERALS = '一二三四五六七';

/** A year as a roster writes it (2, 大二, 二年級, 碩一 is not one) as 1-7; NaN when it is none. */
export function parseGrade(v: string): number {
  const m = /^(?:大|高)?([1-7一二三四五六七])(?:年級|年级)?$/.exec(v.replace(/\s+/g, ''));
  if (!m) return NaN;
  const i = NUMERALS.indexOf(m[1]);
  return i >= 0 ? i + 1 : Number(m[1]);
}

function text(v: unknown): string | null {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' ? v.trim() : null;
}

/**
 * A department as typed (roster, intake): filed under the region's canonical
 * name when it is one of its spellings, else kept as typed with a warning.
 * Null when it is not text or too long.
 */
export function departmentField(cats: RegionCategories, raw: unknown): { value: string; unlisted: boolean } | null {
  const typed = text(raw);
  if (typed === null || typed.length > MAX_DEPARTMENT) return null;
  if (!typed) return { value: '', unlisted: false };
  const canonical = canonicalDepartment(cats, typed);
  return canonical ? { value: canonical, unlisted: false } : { value: typed, unlisted: true };
}

/** A year 1-7 as a roster or a form writes it (2, 大二, 二年級), null for none given; undefined when it is not one. */
export function gradeField(raw: unknown): number | null | undefined {
  const g = text(raw);
  if (g === null) return undefined;
  if (g === '') return null;
  const n = parseGrade(g);
  return n >= 1 && n <= MAX_GRADE ? n : undefined;
}

/** One roster row, as a client sends it ({student_number, name, department, grade, valid_until}). */
export function validateMember(raw: unknown, cats: RegionCategories, now = new Date()): MemberCheck {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const errors: string[] = [];
  const warnings: string[] = [];

  const studentNumber = normalizeStudentNumber(r.student_number);
  if (!studentNumber) errors.push('org.errStudentNumber');

  const name = text(r.name);
  if (name === null || name.length > MAX_NAME) errors.push('org.errName');

  const dept = departmentField(cats, r.department);
  if (!dept) errors.push('org.errDepartment');
  else if (dept.unlisted) warnings.push('org.warnDepartmentUnlisted');
  const department = dept?.value ?? '';

  const grade = gradeField(r.grade);
  if (grade === undefined) errors.push('org.errGrade');

  const v = text(r.valid_until);
  const validUntil = v === '' ? academicYearEnd(now) : v === null ? null : parseDate(v);
  if (validUntil === null || validUntil < today(now)) errors.push('org.errValidUntil');

  return {
    member: errors.length
      ? null
      : { studentNumber: studentNumber!, name: name!, department, grade: grade ?? null, validUntil: validUntil! },
    errors,
    warnings,
  };
}

function sameMember(a: MemberInput, b: OrganizationMember): boolean {
  return a.name === b.name && a.department === b.department && a.grade === b.grade && a.validUntil === b.validUntil;
}

/** Insert or update these rows, in chunks, as statements for one D1 batch. */
export function writeMembers(env: Env, orgId: string, members: MemberInput[], now: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < members.length; i += WRITE_CHUNK) {
    const chunk = members
      .slice(i, i + WRITE_CHUNK)
      .map((m) => ({ n: m.studentNumber, name: m.name, d: m.department, g: m.grade, v: m.validUntil }));
    out.push(
      env.DB.prepare(
        `INSERT INTO organization_members (organization_id, student_number, name, department, grade, valid_until, created_at, updated_at)
         SELECT ?1, json_extract(j.value, '$.n'), json_extract(j.value, '$.name'), json_extract(j.value, '$.d'),
                json_extract(j.value, '$.g'), json_extract(j.value, '$.v'), ?2, ?2
           FROM json_each(?3) j WHERE true
         ON CONFLICT (organization_id, student_number) DO UPDATE SET
           name = excluded.name, department = excluded.department, grade = excluded.grade,
           valid_until = excluded.valid_until, updated_at = excluded.updated_at`,
      ).bind(orgId, now, JSON.stringify(chunk)),
    );
  }
  return out;
}

export interface ImportIssue {
  /** 1-based position in the rows sent. */
  line: number;
  student_number: string;
  errors: string[];
  warnings: string[];
}

export interface ImportResult {
  committed: boolean;
  summary: { rows: number; added: number; updated: number; unchanged: number; removed: number; errors: number; warnings: number };
  issues: ImportIssue[];
}

/**
 * Check an import against the current roster and, when `commit` and no row
 * has an error, apply it in one transaction. "merge" adds and updates;
 * "replace" also removes every member the rows do not name (a new term's list).
 * A commit with errors writes nothing: the preview shows the same answer.
 */
export async function importRoster(
  env: Env,
  org: Organization,
  rows: unknown[],
  mode: ImportMode,
  commit: boolean,
  existing: OrganizationMember[],
): Promise<ImportResult> {
  const cats = await regionCategories(env, org.regionCode);
  const current = new Map(existing.map((m) => [m.studentNumber, m]));
  const seen = new Set<string>();
  const toWrite: MemberInput[] = [];
  const issues: ImportIssue[] = [];
  const summary = { rows: rows.length, added: 0, updated: 0, unchanged: 0, removed: 0, errors: 0, warnings: 0 };

  rows.forEach((raw, i) => {
    const check = validateMember(raw, cats);
    const number = check.member?.studentNumber ?? normalizeStudentNumber((raw as Record<string, unknown> | null)?.student_number) ?? '';
    if (check.member) {
      if (seen.has(number)) check.errors.push('org.errDuplicateInFile');
      seen.add(number);
    }
    if (check.errors.length) summary.errors++;
    if (check.warnings.length) summary.warnings++;
    if (check.errors.length || check.warnings.length) {
      if (issues.length < MAX_ISSUES) issues.push({ line: i + 1, student_number: number, errors: check.errors, warnings: check.warnings });
    }
    if (check.errors.length || !check.member) return;
    const before = current.get(number);
    if (!before) summary.added++;
    else if (sameMember(check.member, before)) {
      summary.unchanged++;
      return;
    } else summary.updated++;
    toWrite.push(check.member);
  });
  if (mode === 'replace') summary.removed = existing.filter((m) => !seen.has(m.studentNumber)).length;

  if (!commit || summary.errors) return { committed: false, summary, issues };

  const now = new Date().toISOString();
  const statements = writeMembers(env, org.id, toWrite, now);
  if (mode === 'replace') {
    statements.push(
      env.DB.prepare(
        `DELETE FROM organization_members
          WHERE organization_id = ?1 AND student_number NOT IN (SELECT value FROM json_each(?2))`,
      ).bind(org.id, JSON.stringify([...seen])),
    );
  }
  if (statements.length) await env.DB.batch(statements);
  return { committed: true, summary, issues };
}

export function memberJson(m: OrganizationMember) {
  return {
    student_number: m.studentNumber,
    name: m.name,
    department: m.department,
    grade: m.grade,
    valid_until: m.validUntil,
    updated_at: m.updatedAt,
  };
}
