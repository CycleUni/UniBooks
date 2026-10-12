import { chatHubSocketUrl, chatRoomMessagesUrl, chatRoomReadUrl, chatRoomSocketUrl } from './chat-urls';

describe('chat URLs', () => {
  it('builds every endpoint under /api/chat on the returned edge_chat_url', () => {
    const base = 'https://unibooks.app';
    expect(chatHubSocketUrl(base)).toBe('wss://unibooks.app/api/chat/hub');
    expect(chatRoomSocketUrl(base, 'conv_1')).toBe('wss://unibooks.app/api/chat/rooms/conv_1');
    expect(chatRoomMessagesUrl(base, 'conv_1')).toBe('https://unibooks.app/api/chat/rooms/conv_1/messages');
    expect(chatRoomReadUrl(base, 'conv_1')).toBe('https://unibooks.app/api/chat/rooms/conv_1/read');
  });

  it('uses ws: for a local http origin (the dev proxy) and tolerates a trailing slash', () => {
    expect(chatHubSocketUrl('http://localhost:4200/')).toBe('ws://localhost:4200/api/chat/hub');
    expect(chatRoomSocketUrl('http://localhost:4200', 'r')).toBe('ws://localhost:4200/api/chat/rooms/r');
  });

  it('falls back to this page\'s origin when the backend sends none', () => {
    expect(chatRoomMessagesUrl('', 'r')).toBe(`${location.origin}/api/chat/rooms/r/messages`);
  });

  it('keeps a room id from escaping its path segment', () => {
    expect(chatRoomReadUrl('https://unibooks.app', '../hub')).toBe('https://unibooks.app/api/chat/rooms/..%2Fhub/read');
  });

  it('never uses the retired chat paths', () => {
    for (const url of [
      chatHubSocketUrl('https://x.example'),
      chatRoomSocketUrl('https://x.example', 'r'),
      chatRoomMessagesUrl('https://x.example', 'r'),
      chatRoomReadUrl('https://x.example', 'r'),
    ]) {
      expect(url).not.toMatch(/\/ws\/|\/api\/unibooks|\/api\/internal/);
    }
  });
});
