import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { eq, and } from 'drizzle-orm';
import { createDb, books, bookReports, auditEvents, staffManagedRegions } from '../../src/db';
import { LIMITS } from '../../src/lib/limits';
import { api, seedRegion, seedUser } from '../messaging/helpers';

describe('Book Reports API and Moderation', () => {
  beforeAll(async () => {
    await seedRegion('TW');
    await seedRegion('HK');
  });

  async function seedBook(region = 'TW', title = 'Test Book', isbn13?: string) {
    const db = createDb(env.DB);
    const id = crypto.randomUUID();
    await db.insert(books).values({
      id,
      regionCode: region,
      title,
      isbn13: isbn13 ?? null,
      authors: 'Author Name',
      publisher: 'Publisher Name',
      publishedDate: '2023-01-01',
      coverUrl: 'https://example.com/cover.jpg',
      source: 'manual',
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  it('creates a report successfully with suggested values and fields', async () => {
    const reporter = await seedUser({ verifiedIn: 'TW' });
    const bookId = await seedBook('TW', 'Calculus Volume 1');

    const res = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: bookId,
        fields: ['title', 'authors'],
        detail: 'The author is Stewart, not Newton',
        suggested: {
          title: 'Calculus: Early Transcendentals',
          authors: 'James Stewart',
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.id).toBeTruthy();
    expect(body.region).toBe('TW');
    expect(body.book.id).toBe(bookId);
    expect(body.book.title).toBe('Calculus Volume 1');
    // The reporter's own view names neither themselves nor the staff who resolve it.
    expect(body.reporter).toBeUndefined();
    expect(body.resolved_by).toBeUndefined();
    expect(body.fields).toEqual(['title', 'authors']);
    expect(body.detail).toBe('The author is Stewart, not Newton');
    expect(body.suggested).toEqual({
      title: 'Calculus: Early Transcendentals',
      authors: 'James Stewart',
    });
    expect(body.status).toBe('open');
  });

  it('rejects duplicate open report by the same user on the same book', async () => {
    const reporter = await seedUser({ verifiedIn: 'TW' });
    const bookId = await seedBook('TW', 'Linear Algebra');

    const first = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: bookId,
        fields: ['title'],
        detail: 'First report',
      }),
    });
    expect(first.status).toBe(201);

    const dup = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: bookId,
        fields: ['isbn'],
        detail: 'Second report while first is open',
      }),
    });
    expect(dup.status).toBe(400);
    expect(await dup.json()).toMatchObject({ error: { code: 'moderation.errAlreadyReported' } });
  });

  it('enforces field and length limits', async () => {
    const reporter = await seedUser({ verifiedIn: 'TW' });
    const bookId = await seedBook('TW', 'Physics');

    // Empty fields array
    const emptyFields = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: bookId,
        fields: [],
        detail: 'no fields',
      }),
    });
    expect(emptyFields.status).toBe(400);

    // Detail exceeds LIMITS.bookReportDetail (1000)
    const tooLongDetail = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: bookId,
        fields: ['title'],
        detail: 'x'.repeat(LIMITS.bookReportDetail + 1),
      }),
    });
    expect(tooLongDetail.status).toBe(400);

    // Detail exactly at limit is accepted
    const okDetail = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: bookId,
        fields: ['title'],
        detail: 'x'.repeat(LIMITS.bookReportDetail),
      }),
    });
    expect(okDetail.status).toBe(201);

    // Suggested value exceeding field limit (e.g. title > LIMITS.bookTitle)
    const anotherReporter = await seedUser({ verifiedIn: 'TW' });
    const badSuggested = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: anotherReporter.token,
      body: JSON.stringify({
        book: bookId,
        fields: ['title'],
        suggested: {
          title: 'x'.repeat(LIMITS.bookTitle + 1),
        },
      }),
    });
    expect(badSuggested.status).toBe(400);
  });

  it('"other" field requires non-empty detail', async () => {
    const reporter = await seedUser({ verifiedIn: 'TW' });
    const bookId = await seedBook('TW', 'Chemistry');

    // "other" with empty detail
    const missingDetail = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: bookId,
        fields: ['other'],
        detail: '   ',
      }),
    });
    expect(missingDetail.status).toBe(400);
    expect(await missingDetail.json()).toEqual({
      error: { code: 'common.errValidation', fields: { detail: ['bookReport.detailRequired'] } },
    });

    // "other" with valid detail
    const okDetail = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: bookId,
        fields: ['other'],
        detail: 'The edition is obsolete',
      }),
    });
    expect(okDetail.status).toBe(201);
  });

  it('returns 404 for unknown or uncatalogued book', async () => {
    const reporter = await seedUser({ verifiedIn: 'TW' });

    const notFound = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: crypto.randomUUID(),
        fields: ['title'],
        detail: 'Ghost book',
      }),
    });
    expect(notFound.status).toBe(404);
  });

  it('lists user own reports via /book-reports/mine', async () => {
    const reporter = await seedUser({ verifiedIn: 'TW' });
    const otherUser = await seedUser({ verifiedIn: 'TW' });
    const bookId = await seedBook('TW', 'Economics');

    await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: bookId,
        fields: ['title'],
        detail: 'My report',
      }),
    });

    await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: otherUser.token,
      body: JSON.stringify({
        book: bookId,
        fields: ['publisher'],
        detail: 'Other user report',
      }),
    });

    const mineRes = await api('/api/v1/moderation/book-reports/mine', {
      token: reporter.token,
      headers: { 'X-Region': 'TW' },
    });
    expect(mineRes.status).toBe(200);
    const mineData = (await mineRes.json()) as any;
    expect(mineData.results.length).toBe(1);
    expect(mineData.results[0].detail).toBe('My report');
  });

  it('supports admin list filtering by status, region, and field', async () => {
    const admin = await seedUser({ role: 'admin' });
    const reporter = await seedUser({ verifiedIn: 'TW' });
    const bookId1 = await seedBook('TW', 'Biology');
    const bookId2 = await seedBook('TW', 'History');

    const rep1 = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: bookId1,
        fields: ['title'],
        detail: 'Wrong title on biology',
      }),
    });
    const rep1Data = (await rep1.json()) as any;

    const rep2 = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: (await seedUser({ verifiedIn: 'TW' })).token,
      body: JSON.stringify({
        book: bookId2,
        fields: ['publisher', 'cover'],
        detail: 'Cover is blurry',
      }),
    });
    const rep2Data = (await rep2.json()) as any;

    // Resolve rep1 so we have one fixed and one open
    await api(`/api/v1/moderation/book-reports/${rep1Data.id}`, {
      method: 'PATCH',
      token: admin.token,
      body: JSON.stringify({ status: 'fixed', admin_note: 'Fixed title' }),
    });

    // Filter status=open
    const openRes = await api('/api/v1/moderation/book-reports/all?status=open', { token: admin.token });
    const openData = (await openRes.json()) as any;
    expect(openData.results.some((r: any) => r.id === rep2Data.id)).toBe(true);
    expect(openData.results.some((r: any) => r.id === rep1Data.id)).toBe(false);

    // Filter status=fixed
    const fixedRes = await api('/api/v1/moderation/book-reports/all?status=fixed', { token: admin.token });
    const fixedData = (await fixedRes.json()) as any;
    expect(fixedData.results.some((r: any) => r.id === rep1Data.id)).toBe(true);
    expect(fixedData.results.some((r: any) => r.id === rep2Data.id)).toBe(false);

    // Filter field=cover
    const coverRes = await api('/api/v1/moderation/book-reports/all?field=cover', { token: admin.token });
    const coverData = (await coverRes.json()) as any;
    expect(coverData.results.some((r: any) => r.id === rep2Data.id)).toBe(true);
    expect(coverData.results.some((r: any) => r.id === rep1Data.id)).toBe(false);

    // Filter region=HK vs TW
    const hkRes = await api('/api/v1/moderation/book-reports/all?region=HK', { token: admin.token });
    const hkData = (await hkRes.json()) as any;
    expect(hkData.results.some((r: any) => r.id === rep1Data.id || r.id === rep2Data.id)).toBe(false);
  });

  it('enforces staff region scope for viewing and resolving book reports', async () => {
    const reporter = await seedUser({ verifiedIn: 'TW' });
    const bookId = await seedBook('TW', 'Geography');
    const repRes = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: bookId,
        fields: ['isbn'],
        detail: 'Wrong ISBN',
      }),
    });
    const { id: reportId } = (await repRes.json()) as any;

    const unscopedStaff = await seedUser({ role: 'staff' });
    const hkStaff = await seedUser({ role: 'staff' });
    const twStaff = await seedUser({ role: 'staff' });

    const db = createDb(env.DB);
    await db.insert(staffManagedRegions).values({ userId: hkStaff.id, regionCode: 'HK' });
    await db.insert(staffManagedRegions).values({ userId: twStaff.id, regionCode: 'TW' });

    // Staff without TW region cannot see it in list or detail
    const unscopedList = await api('/api/v1/moderation/book-reports/all', { token: unscopedStaff.token });
    expect(((await unscopedList.json()) as any).count).toBe(0);

    const hkList = await api('/api/v1/moderation/book-reports/all', { token: hkStaff.token });
    expect(((await hkList.json()) as any).count).toBe(0);

    expect((await api(`/api/v1/moderation/book-reports/${reportId}`, { token: unscopedStaff.token })).status).toBe(404);
    expect((await api(`/api/v1/moderation/book-reports/${reportId}`, { token: hkStaff.token })).status).toBe(404);

    // HK staff cannot resolve TW report
    const badResolve = await api(`/api/v1/moderation/book-reports/${reportId}`, {
      method: 'PATCH',
      token: hkStaff.token,
      body: JSON.stringify({ status: 'fixed' }),
    });
    expect(badResolve.status).toBe(404);

    // TW staff can view and resolve
    const twGet = await api(`/api/v1/moderation/book-reports/${reportId}`, { token: twStaff.token });
    expect(twGet.status).toBe(200);

    const twResolve = await api(`/api/v1/moderation/book-reports/${reportId}`, {
      method: 'PATCH',
      token: twStaff.token,
      body: JSON.stringify({ status: 'fixed', admin_note: 'ISBN verified' }),
    });
    expect(twResolve.status).toBe(200);
    const resolvedBody = (await twResolve.json()) as any;
    expect(resolvedBody.status).toBe('fixed');
    expect(resolvedBody.admin_note).toBe('ISBN verified');
    expect(resolvedBody.resolved_by.id).toBe(twStaff.id);
  });

  it('resolves as fixed or dismissed with note and records audit event', async () => {
    const admin = await seedUser({ role: 'admin' });
    const reporter = await seedUser({ verifiedIn: 'TW' });
    const bookId = await seedBook('TW', 'Music');

    const repRes = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: bookId,
        fields: ['other'],
        detail: 'Duplicate artist info',
      }),
    });
    const { id: reportId } = (await repRes.json()) as any;

    const dismissRes = await api(`/api/v1/moderation/book-reports/${reportId}`, {
      method: 'PATCH',
      token: admin.token,
      body: JSON.stringify({
        status: 'dismissed',
        admin_note: 'Not an error',
      }),
    });
    expect(dismissRes.status).toBe(200);
    const dismissedBody = (await dismissRes.json()) as any;
    expect(dismissedBody.status).toBe('dismissed');
    expect(dismissedBody.admin_note).toBe('Not an error');

    // Audit event check
    const db = createDb(env.DB);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetType, 'book_report'), eq(auditEvents.targetId, reportId)))
      .limit(1);
    expect(audit).toBeTruthy();
    expect(audit.actorId).toBe(admin.id);
    expect(audit.action).toBe('admin.book_report_resolved');
    expect(JSON.parse(audit.details || '{}')).toMatchObject({
      action: 'dismissed',
      book_id: bookId,
      admin_note: 'Not an error',
    });

    // Trying to resolve already resolved report returns 400
    const reResolve = await api(`/api/v1/moderation/book-reports/${reportId}`, {
      method: 'PATCH',
      token: admin.token,
      body: JSON.stringify({ status: 'fixed' }),
    });
    expect(reResolve.status).toBe(400);
    expect(await reResolve.json()).toMatchObject({
      error: { code: 'common.errValidation', fields: { status: ['admin.errReportAlreadyResolved'] } },
    });
  });

  it('closes open reports when saving book with resolve_reports=true or resolve_report_id', async () => {
    const admin = await seedUser({ role: 'admin' });
    const reporter1 = await seedUser({ verifiedIn: 'TW' });
    const reporter2 = await seedUser({ verifiedIn: 'TW' });
    const bookId = await seedBook('TW', 'Philosophy');

    const rep1 = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter1.token,
      body: JSON.stringify({ book: bookId, fields: ['title'], detail: 'Title typo' }),
    });
    const { id: rep1Id } = (await rep1.json()) as any;

    const rep2 = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter2.token,
      body: JSON.stringify({ book: bookId, fields: ['authors'], detail: 'Author typo' }),
    });
    const { id: rep2Id } = (await rep2.json()) as any;

    // Check open_reports count on book
    const getBookBefore = await api(`/api/v1/admin/books/${bookId}`, { token: admin.token });
    expect(((await getBookBefore.json()) as any).open_reports).toBe(2);

    // Save book with resolve_reports: true
    const saveRes = await api(`/api/v1/admin/books/${bookId}`, {
      method: 'PATCH',
      token: admin.token,
      body: JSON.stringify({
        title: 'Philosophy: Revised Edition',
        resolve_reports: true,
        admin_note: 'Fixed via editor update',
      }),
    });
    expect(saveRes.status).toBe(200);

    const db = createDb(env.DB);
    const updatedReports = await db.select().from(bookReports).where(eq(bookReports.bookId, bookId));
    expect(updatedReports.every((r) => r.status === 'fixed')).toBe(true);
    expect(updatedReports.every((r) => r.adminNote === 'Fixed via editor update')).toBe(true);
    expect(updatedReports.every((r) => r.resolvedById === admin.id)).toBe(true);

    // Verify audit logs created
    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetType, 'book_report'), eq(auditEvents.action, 'admin.book_report_resolved')));
    const auditedIds = audits.map((a) => a.targetId);
    expect(auditedIds).toContain(rep1Id);
    expect(auditedIds).toContain(rep2Id);

    // Check open_reports count drops to 0
    const getBookAfter = await api(`/api/v1/admin/books/${bookId}`, { token: admin.token });
    expect(((await getBookAfter.json()) as any).open_reports).toBe(0);
  });

  it('handles book merge: closes open reports on source book as fixed and moves them to target book', async () => {
    const admin = await seedUser({ role: 'admin' });
    const reporter = await seedUser({ verifiedIn: 'TW' });
    const targetIsbn = '9780132350884';
    const sourceBookId = await seedBook('TW', 'Clean Code Draft');
    const targetBookId = await seedBook('TW', 'Clean Code Final', targetIsbn);

    const repRes = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: sourceBookId,
        fields: ['isbn'],
        detail: 'This is actually Clean Code',
      }),
    });
    const { id: reportId } = (await repRes.json()) as any;

    // Merge source book into target book via ISBN collision + merge: true
    const mergeRes = await api(`/api/v1/admin/books/${sourceBookId}`, {
      method: 'PATCH',
      token: admin.token,
      body: JSON.stringify({
        isbn13: targetIsbn,
        merge: true,
      }),
    });
    expect(mergeRes.status).toBe(200);

    const db = createDb(env.DB);
    // Source book is deleted
    const [sourceBook] = await db.select().from(books).where(eq(books.id, sourceBookId));
    expect(sourceBook).toBeUndefined();

    // Report is now marked fixed, moved to target book
    const [reportAfter] = await db.select().from(bookReports).where(eq(bookReports.id, reportId));
    expect(reportAfter).toBeTruthy();
    expect(reportAfter.status).toBe('fixed');
    expect(reportAfter.bookId).toBe(targetBookId);
    expect(reportAfter.adminNote).toContain(`Merged into book ${targetBookId}`);

    // Audit logged
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetType, 'book_report'), eq(auditEvents.targetId, reportId)))
      .limit(1);
    expect(audit).toBeTruthy();
    expect(audit.action).toBe('admin.book_report_resolved');
  });

  it('cascades deletion of reports when book is deleted', async () => {
    const reporter = await seedUser({ verifiedIn: 'TW' });
    const bookId = await seedBook('TW', 'Doomed Book');

    const repRes = await api('/api/v1/moderation/book-reports', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({
        book: bookId,
        fields: ['title'],
        detail: 'Will be deleted',
      }),
    });
    const { id: reportId } = (await repRes.json()) as any;

    const db = createDb(env.DB);
    // Directly delete the book
    await db.delete(books).where(eq(books.id, bookId)).run();

    // Cascade foreign key should remove the report
    const [remaining] = await db.select().from(bookReports).where(eq(bookReports.id, reportId));
    expect(remaining).toBeUndefined();
  });
});
