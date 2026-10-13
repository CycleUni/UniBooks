import {
  chatHubSocketUrl,
  chatRoomMessagesUrl,
  chatRoomReadUrl,
  chatRoomSocketUrl,
} from './chat-urls';

describe('chat URLs', () => {
  const origin = location.origin;
  const ws = origin.replace(/^http/, 'ws');

  it("builds every endpoint under /api/chat on this page's origin", () => {
    expect(chatHubSocketUrl()).toBe(`${ws}/api/chat/hub`);
    expect(chatRoomSocketUrl('conv_1')).toBe(`${ws}/api/chat/rooms/conv_1`);
    expect(chatRoomMessagesUrl('conv_1')).toBe(`${origin}/api/chat/rooms/conv_1/messages`);
    expect(chatRoomReadUrl('conv_1')).toBe(`${origin}/api/chat/rooms/conv_1/read`);
  });

  it('keeps a room id from escaping its path segment', () => {
    expect(chatRoomReadUrl('../hub')).toBe(`${origin}/api/chat/rooms/..%2Fhub/read`);
  });

  it('never uses the retired chat paths', () => {
    for (const url of [
      chatHubSocketUrl(),
      chatRoomSocketUrl('r'),
      chatRoomMessagesUrl('r'),
      chatRoomReadUrl('r'),
    ]) {
      expect(url).not.toMatch(/\/ws\/|\/api\/unibooks|\/api\/internal/);
    }
  });
});
