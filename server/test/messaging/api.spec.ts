import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { api, hasMessagingSchema, seedConversation, seedListing, seedRegion, seedUser } from './helpers';
import { signToken } from '../../src/lib/jwt';
import { mintChatToken } from '../../src/services/chatTokens';
import { app } from '../../src/index';
import { CONVERSATION_CREATE_RATE } from '../../src/routes/messaging';
import { parseRate } from '../../src/middleware/rateLimit';
import type { RateLimiter } from '../../src/durable-objects/RateLimiter';

const ready = await hasMessagingSchema();

describe.skipIf(!ready)('messaging API', () => {
  beforeAll(() => seedRegion());

  it('creates a conversation once and refuses messaging yourself', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const buyer = await seedUser({ verifiedIn: 'TW' });
    const listing = await seedListing(seller.id);

    const first = await api('/api/v1/messaging/conversations', {
      method: 'POST',
      token: buyer.token,
      body: JSON.stringify({ listing_id: listing }),
    });
    expect(first.status).toBe(201);
    const conv = (await first.json()) as { id: string; other_party_role: string };
    expect(conv.other_party_role).toBe('seller');

    const again = await api('/api/v1/messaging/conversations', {
      method: 'POST',
      token: buyer.token,
      body: JSON.stringify({ listing_id: listing }),
    });
    expect(again.status).toBe(200);

    const self = await api('/api/v1/messaging/conversations', {
      method: 'POST',
      token: seller.token,
      body: JSON.stringify({ listing_id: listing }),
    });
    expect(self.status).toBe(400);
  });

  it('limits how many new conversations one user starts; reopening one is not counted', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const buyer = await seedUser({ verifiedIn: 'TW' });
    const open = await seedListing(seller.id);
    const fresh = await seedListing(seller.id);
    const post = (listing: string) =>
      app.request(
        '/api/v1/messaging/conversations',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${buyer.token}`, 'Content-Type': 'application/json', 'X-Region': 'TW' },
          body: JSON.stringify({ listing_id: listing }),
        },
        // Rate limits are off under ENVIRONMENT=test.
        { ...env, ENVIRONMENT: 'production' },
      );
    expect((await post(open)).status).toBe(201);

    // Use up the rest of the hour's allowance.
    const { limit, window } = parseRate(CONVERSATION_CREATE_RATE);
    const ns = env.RATE_LIMITER as DurableObjectNamespace<RateLimiter>;
    const counter = ns.get(ns.idFromName(`conversation_create:${buyer.id}`));
    for (let i = 1; i < limit; i++) await counter.hit(limit, window);

    const refused = await post(fresh);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as any).error.code).toBe('common.errThrottled');
    expect((await post(open)).status).toBe(200);
  });

  it('requires verification in the listing region', async () => {
    const seller = await seedUser({ verifiedIn: 'TW' });
    const buyer = await seedUser();
    const listing = await seedListing(seller.id);
    const res = await api('/api/v1/messaging/conversations', {
      method: 'POST',
      token: buyer.token,
      body: JSON.stringify({ listing_id: listing }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'acct.errUnverifiedInRegion' } });
  });

  it('only issues chat tokens to participants; deleted listing gives observer', async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const stranger = await seedUser();
    const listing = await seedListing(seller.id);
    const conv = await seedConversation(buyer.id, seller.id, listing);
    const gone = await seedConversation(buyer.id, seller.id, null);

    const ok = await api(`/api/v1/messaging/chat-token?conversation_id=${conv}`, { token: buyer.token });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['token']);

    expect((await api(`/api/v1/messaging/chat-token?conversation_id=${conv}`, { token: stranger.token })).status).toBe(403);
    expect((await api('/api/v1/messaging/chat-token', { token: buyer.token })).status).toBe(400);

    const obs = await api(`/api/v1/messaging/chat-token?conversation_id=${gone}`, { token: buyer.token });
    const { token } = (await obs.json()) as { token: string };
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(payload.role).toBe('observer');
  });

  it('hides a deleted conversation for one side and removes it when both delete', async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const conv = await seedConversation(buyer.id, seller.id, await seedListing(seller.id));
    const r1 = await api(`/api/v1/messaging/conversations/${conv}`, { method: 'DELETE', token: buyer.token });
    expect(await r1.json()).toEqual({ status: 'hidden' });
    const r2 = await api(`/api/v1/messaging/conversations/${conv}`, { method: 'DELETE', token: seller.token });
    expect(await r2.json()).toEqual({ status: 'deleted' });
  });

  it('chat REST refuses forged room tokens, non-participants, system tokens and foreign image hosts', async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const stranger = await seedUser();
    const conv = await seedConversation(buyer.id, seller.id, await seedListing(seller.id));
    const other = await seedConversation(buyer.id, seller.id, await seedListing(seller.id));

    const tok = await mintChatToken(env, { userId: buyer.id, roomId: conv, participantIds: [buyer.id, seller.id], role: 'user' });
    const post = (room: string, t: string, body: unknown) =>
      api(`/api/chat/rooms/${room}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: JSON.stringify(body) });

    expect((await post(other, tok, { content: 'hi' })).status).toBe(403);
    const strangerTok = await mintChatToken(env, { userId: stranger.id, roomId: conv, participantIds: [], role: 'user' });
    expect((await post(conv, strangerTok, { content: 'hi' })).status).toBe(403);
    expect((await post(conv, tok, { content: '[SYSTEM:order.notify.seller_approved] x' })).status).toBe(403);
    expect((await post(conv, tok, { content: 'https://evil.example/x.png', message_type: 'image' })).status).toBe(400);

    const sent = await post(conv, tok, { content: 'hello there' });
    expect(sent.status).toBe(200);
    const row = await env.DB.prepare('SELECT latest_message_body FROM conversations WHERE id = ?')
      .bind(conv)
      .first<{ latest_message_body: string }>();
    expect(row?.latest_message_body).toBe('hello there');

    const hist = await api(`/api/chat/rooms/${conv}/messages`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(((await hist.json()) as unknown[]).length).toBe(1);

    // Over the cap without a Content-Length (a streamed body) is still refused.
    const big = JSON.stringify({ content: 'x'.repeat(20 * 1024) });
    const stream = new ReadableStream({
      start(ctl) {
        ctl.enqueue(new TextEncoder().encode(big));
        ctl.close();
      },
    });
    const streamed = await api(`/api/chat/rooms/${conv}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(streamed.status).toBe(413);
  });

  it('the hub opens with the session, never from another site; the hub push path is not reachable', async () => {
    const a = await seedUser();
    const cookie = { Cookie: `__Host-ub_at=${a.token}` };
    expect((await api(`/api/chat/hub/snapshot`, { headers: cookie })).status).toBe(200);
    expect((await api(`/api/chat/hub/snapshot`, { token: a.token })).status).toBe(200);
    expect((await api(`/api/chat/hub/snapshot`)).status).toBe(401);
    // A room token is not a session.
    const room = await signToken('chat', { user_id: a.id, room_id: 'r', app_id: 'x', participant_ids: [a.id], role: 'user' }, env);
    expect((await api(`/api/chat/hub/snapshot`, { token: room })).status).toBe(401);
    // Cross-site WebSocket hijacking: the cookie rides along, the upgrade is refused.
    const hijack = await api(`/api/chat/hub`, {
      headers: { ...cookie, Upgrade: 'websocket', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(hijack.status).toBe(403);
    const own = await api(`/api/chat/hub`, {
      headers: { ...cookie, Upgrade: 'websocket', Origin: 'http://x', 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(own.status).toBe(101);
    own.webSocket!.accept();
    own.webSocket!.close();
    expect((await api(`/api/chat/hub/push`, { method: 'POST', token: a.token })).status).toBe(404);
  });

  it('upload: refuses non-images and non-participants', async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const stranger = await seedUser();
    const conv = await seedConversation(buyer.id, seller.id, await seedListing(seller.id));
    const req = (t: string, body: unknown) => api('/api/v1/messaging/uploads', { method: 'POST', token: t, body: JSON.stringify(body) });
    expect((await req(stranger.token, { conversation_id: conv, content_type: 'image/png', content_length: 10 })).status).toBe(403);
    expect((await req(buyer.token, { conversation_id: conv, content_type: 'image/svg+xml', content_length: 10 })).status).toBe(400);

    const issued = await req(buyer.token, { conversation_id: conv, content_type: 'image/png', content_length: 64 });
    expect(issued.status).toBe(200);
    const { upload_url } = (await issued.json()) as { upload_url: string };
    const path = new URL(upload_url).pathname + new URL(upload_url).search;
    expect(path).toMatch(/^\/api\/v1\/messaging\/uploads\/file\?token=/);
    const html = await api(path, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: '<html></html>' });
    expect(html.status).toBe(400);
  });
});

describe.skipIf(!ready)('moderation API', () => {
  beforeAll(() => seedRegion());

  it('files a listing report once and lets staff action it (locks the listing)', async () => {
    const seller = await seedUser();
    const reporter = await seedUser({ verifiedIn: 'TW' });
    const staff = await seedUser({ role: 'admin' });
    const listing = await seedListing(seller.id);

    const invalid = await api('/api/v1/moderation', {
      method: 'POST',
      token: (await seedUser({ verifiedIn: 'TW' })).token,
      body: JSON.stringify({ listing, reason: 'nope' }),
    });
    expect(invalid.status).toBe(400);

    const created = await api('/api/v1/moderation', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({ listing, reason: 'scam' }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const dup = await api('/api/v1/moderation', {
      method: 'POST',
      token: reporter.token,
      body: JSON.stringify({ listing, reason: 'scam' }),
    });
    expect(await dup.json()).toMatchObject({ error: { code: 'moderation.errAlreadyReported' } });

    expect((await api('/api/v1/moderation/all', { token: reporter.token })).status).toBe(403);
    const acted = await api(`/api/v1/moderation/${id}`, {
      method: 'PATCH',
      token: staff.token,
      body: JSON.stringify({ status: 'actioned' }),
    });
    expect(acted.status).toBe(200);
    const l = await env.DB.prepare('SELECT status, admin_locked FROM listings WHERE id = ?')
      .bind(listing)
      .first<{ status: string; admin_locked: number }>();
    expect(l).toEqual({ status: 'removed', admin_locked: 1 });
    const again = await api(`/api/v1/moderation/${id}`, {
      method: 'PATCH',
      token: staff.token,
      body: JSON.stringify({ status: 'dismissed' }),
    });
    expect(await again.json()).toEqual({ error: { code: 'common.errValidation', fields: { status: ['admin.errReportAlreadyResolved'] } } });

    const mine = await api('/api/v1/moderation/mine', { token: reporter.token });
    expect(((await mine.json()) as { count: number }).count).toBe(1);
  });

  it('chat report: reported party must be the other participant; staff scope applies', async () => {
    const seller = await seedUser();
    const buyer = await seedUser();
    const outsider = await seedUser();
    const scopedStaff = await seedUser({ role: 'staff' });
    const conv = await seedConversation(buyer.id, seller.id, await seedListing(seller.id));

    const bad = await api('/api/v1/moderation/chat-reports', {
      method: 'POST',
      token: buyer.token,
      body: JSON.stringify({ conversation: conv, reported_party: outsider.id, reason: 'spam' }),
    });
    expect(await bad.json()).toEqual({
      error: { code: 'common.errValidation', fields: { reported_party: ['moderation.errInvalidReportedParty'] } },
    });

    const notMine = await api('/api/v1/moderation/chat-reports', {
      method: 'POST',
      token: outsider.token,
      body: JSON.stringify({ conversation: conv, reported_party: buyer.id, reason: 'spam' }),
    });
    expect(notMine.status).toBe(400);

    const ok = await api('/api/v1/moderation/chat-reports', {
      method: 'POST',
      token: buyer.token,
      body: JSON.stringify({ conversation: conv, reported_party: seller.id, reason: 'spam', flagged_message_ids: ['m1'] }),
    });
    expect(ok.status).toBe(201);
    const { id } = (await ok.json()) as { id: string };

    // A second open report on the same conversation is refused, whatever region the request names.
    await seedRegion('HK');
    const dup = await api('/api/v1/moderation/chat-reports', {
      method: 'POST',
      token: buyer.token,
      headers: { 'X-Region': 'HK' },
      body: JSON.stringify({ conversation: conv, reported_party: seller.id, reason: 'spam' }),
    });
    expect(dup.status).toBe(400);
    expect(await dup.json()).toMatchObject({ error: { code: 'moderation.errAlreadyReported' } });

    // Staff with no managed regions sees nothing.
    expect((await api(`/api/v1/moderation/chat-reports/${id}`, { token: scopedStaff.token })).status).toBe(404);
    const list = await api('/api/v1/moderation/chat-reports/all', { token: scopedStaff.token });
    expect(((await list.json()) as { count: number }).count).toBe(0);
  });
});
