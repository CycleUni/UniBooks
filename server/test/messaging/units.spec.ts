import { describe, it, expect } from 'vitest';
import { isChatImageUrl } from '../../src/services/messaging/images';
import { languageFor, orderEventIn, pushT, ORDER_PUSH_EVENTS, PUSH_LANGUAGES } from '../../src/services/messaging/pushText';
import { displayNameOf } from '../../src/services/messaging/people';

describe('chat image checks', () => {
  it('only accepts chat/ uploads on the media host', () => {
    const base = 'https://media.example.com';
    expect(isChatImageUrl(`${base}/chat/u1/a.png`, base)).toBe(true);
    expect(isChatImageUrl(`${base}/listings/u1/a.png`, base)).toBe(false);
    expect(isChatImageUrl(`${base}/chat/../avatars/a.png`, base)).toBe(false);
    expect(isChatImageUrl(`https://evil.example/chat/a.png`, base)).toBe(false);
    expect(isChatImageUrl(`${base}/chat/u1/a.png?x=1`, base)).toBe(false);
  });
});

describe('push wording', () => {
  it('has wording for every order event in every language', () => {
    for (const lang of PUSH_LANGUAGES) {
      for (const e of ORDER_PUSH_EVENTS) expect(pushT(lang, `push.orderNotify.${e}`)).not.toBe(`push.orderNotify.${e}`);
    }
  });

  it('reads the order event out of a system preview', () => {
    expect(orderEventIn('[SYSTEM:order.notify.seller_approved] System Notification')).toBe('seller_approved');
    expect(orderEventIn('[SYSTEM:order.notify.unknown] x')).toBeNull();
    expect(orderEventIn('hello')).toBeNull();
  });

  it('picks email language, then site language, then region default', () => {
    expect(languageFor({ emailLanguage: 'zh-HK', siteLanguage: 'en' })).toBe('zh-HK');
    expect(languageFor({ emailLanguage: 'auto', siteLanguage: 'en' }, 'zh-TW')).toBe('en');
    expect(languageFor({ emailLanguage: 'auto', siteLanguage: '' }, 'zh-TW')).toBe('zh-TW');
    expect(languageFor({ emailLanguage: 'auto', siteLanguage: '' })).toBe('en');
  });

  it('builds display names', () => {
    expect(displayNameOf({ first_name: '小明', last_name: '王' })).toBe('王小明');
    expect(displayNameOf({ first_name: 'Ada', last_name: 'Lovelace' })).toBe('Ada Lovelace');
  });
});
