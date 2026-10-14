import { hashPassword, needsRehash, verifyPassword } from '../../lib/crypto';

/**
 * Password rules and their messages: the frontend shows `error.fields` as given (it looks each one up
 * as an i18n key first, then falls back to the text).
 *
 *   UserAttributeSimilarityValidator  (only when a user is given)
 *   MinimumLengthValidator(8)
 *   CommonPasswordValidator           (a short list)
 *   NumericPasswordValidator
 */

const MIN_LENGTH = 8;
const MAX_SIMILARITY = 0.7;

// Common passwords (lower-case).
const COMMON = new Set(
  `123456 password 12345678 qwerty 123456789 12345 1234 111111 1234567 dragon 123123 baseball abc123 football
monkey letmein 696969 shadow master 666666 qwertyuiop 123321 mustang 1234567890 michael 654321 pussy superman
1qaz2wsx 7777777 fuckyou 121212 000000 qazwsx 123qwe killer trustno1 jordan jennifer zxcvbnm asdfgh hunter buster
soccer harley batman andrew tigger sunshine iloveyou fuckme 2000 charlie robert thomas hockey ranger daniel starwars
klaster 112233 george asshole computer michelle jessica pepper 1111 zxcvbn 555555 11111111 131313 freedom 777777 pass
fuck maggie 159753 aaaaaa ginger princess joshua cheese amanda summer love ashley 6969 nicole chelsea biteme matthew
access yankees 987654321 dallas austin thunder taylor matrix minecraft william corvette hello martin heather secret
merlin diamond 1234qwer gfhjkm hammer silver 222222 88888888 anthony justin test bailey q1w2e3r4t5 patrick internet
scooter orange 11111 golfer cookie richard samantha bigdog guitar jackson whatever mickey chicken sparky snoopy maverick
phoenix camaro sexy peanut morgan welcome falcon cowboy ferrari samsung andrea smokey steelers joseph mercedes dakota
arsenal eagles melissa boomer booboo spider nascar monster tigers yellow xxxxxx 123123123 gateway marina diablo bulldog
qwer1234 compaq purple hardcore banana junior hannah 123654 porsche lakers iceman money cowboys 987654 london tennis
999999 ncc1701 coffee scooby 0000 miller boston q1w2e3r4 fuckoff brandon yamaha chester mother forever johnny edward
333333 oliver redsox player nikita knight fender barney midnight please brandy chicago badboy iwantu slayer rangers
charles angel flower bigdaddy rabbit wizard bigdick jasper enter rachel chris steven winner adidas victoria natasha
1q2w3e4r jasmine winter prince panties marine ghbdtn fishing cocacola casper james 232323 raiders 888888 marlboro
gandalf asdfasdf crystal 87654321 12344321 sexsex golden blowme bigtits 8675309 panther lauren angela bitch spanky
thx1138 angels madison winston shannon mike toyota blowjob jordan23 canada sophie apples dick tiger razz 123abc
pokemon qazxsw 55555 qwaszx muffin johnson murphy cooper jonathan liverpoo david danielle 159357 jackie 1990 123456a
789456 turtle horny abcd1234 scorpion qazwsxedc 101010 butter carlos password1 dennis slipknot qwerty123 booger asdf
1991 black startrek 12341234 cameron newyork rainbow nathan john 1992 rocket viking redskins butthead asdfghjkl 1212
sierra peaches gemini doctor wilson sandra helpme qwertyui victor florida dolphin pookie captain tucker blue liverpool
theman bandit dolphins maddog packers jaguar lovers nicholas united tiffany maxwell zzzzzz nirvana jeremy suckit
stupid porn monica elephant giants jackass hotdog rosebud success debbie mountain 444444 xxxxxxxx warrior 1q2w3e4r5t
q1w2e3 123456q albert metallic lucky azerty 7777 shithead alex bond007 alexis 1111111 samson 5150 willie scorpio
bonnie gators benjamin voodoo driver dexter 2112 jason calvin freddy 212121 creative 12345a sydney rush2112 1989
asdfghjk red123 bubba 4815162342 passw0rd trouble gunner happy fucking gordon legend jessie stella qwert eminem
arthur apple nissan bullshit bear america 1qazxsw2 nothing parker 4444 rebecca qweqwe garfield 01012011 beavis
69696969 jack asdasd december 2222 102030 252525 11223344 magic apollo skippy 315475 girls kitten golf copper braves
shelby godzilla beaver fred tomcat august buddy airborne 1993 1988 lifehack qqqqqq brooklyn animal platinum phantom
online xavier darkness blink182 power fish green 789456123 voyager police travis 12qwaszx heaven snowball lover
abcdef 00000 pakistan 007007 walter playboy blazer cricket sniper hooters donkey willow loveme saturn therock redwings
bigboy pumpkin trinity williams tits nintendo digital destiny topgun runner marvin guinness chance bubbles testing
fire november minnie 2011 college letmein1 tester password123 qwerty1 iloveyou1 abc12345 welcome1 admin admin123
unibooks unibooks123 changeme`
    .split(/\s+/)
    .filter(Boolean),
);

/** Whether `value` is so much shorter than `password` that comparing the two is skipped. */
function exceedsMaximumLengthRatio(password: string, maxSimilarity: number, value: string): boolean {
  const pwdLen = password.length;
  const lengthBoundSimilarity = (maxSimilarity / 2) * pwdLen;
  const valueLen = value.length;
  return pwdLen >= 10 * valueLen && valueLen < lengthBoundSimilarity;
}

/** Multiset overlap of two strings: 2*M/T. */
function quickRatio(a: string, b: string): number {
  const total = a.length + b.length;
  if (!total) return 1;
  const counts = new Map<string, number>();
  for (const ch of b) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let matches = 0;
  for (const ch of a) {
    const n = counts.get(ch) ?? 0;
    if (n > 0) {
      matches++;
      counts.set(ch, n - 1);
    }
  }
  return (2 * matches) / total;
}

export interface PasswordUser {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/** Every validator's message for `password`, [] when it passes. */
export function passwordProblems(password: string, user?: PasswordUser): string[] {
  const errors: string[] = [];

  if (user) {
    const pwd = password.toLowerCase();
    const attributes: [string | null | undefined, string][] = [
      [user.firstName, 'first name'],
      [user.lastName, 'last name'],
      [user.email, 'email address'],
    ];
    outer: for (const [value, verboseName] of attributes) {
      if (!value) continue;
      const lower = value.toLowerCase();
      const parts = [...lower.split(/\W+/), lower];
      for (const part of parts) {
        if (exceedsMaximumLengthRatio(pwd, MAX_SIMILARITY, part)) continue;
        if (quickRatio(pwd, part) >= MAX_SIMILARITY) {
          errors.push(`The password is too similar to the ${verboseName}.`);
          break outer;
        }
      }
    }
  }

  if (password.length < MIN_LENGTH) {
    errors.push(`This password is too short. It must contain at least ${MIN_LENGTH} characters.`);
  }
  if (COMMON.has(password.toLowerCase().trim())) {
    errors.push('This password is too common.');
  }
  if (/^\d+$/.test(password)) {
    errors.push('This password is entirely numeric.');
  }
  return errors;
}

/** Hashed once per isolate: a password nobody knows, under the current parameters. */
let dummyHash: Promise<string> | null = null;
const dummy = () => (dummyHash ??= hashPassword(crypto.randomUUID()));

/**
 * Check a password against its hash. A NULL hash (an unusable password)
 * never matches but still costs one hash, so a sign-in for an unknown
 * address or a Google-only account takes as long as one for a real account.
 */
export async function checkPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) {
    await verifyPassword(password, await dummy());
    return false;
  }
  try {
    return await verifyPassword(password, hash);
  } catch {
    return false;
  }
}

/** Spend one hash comparison (unknown account). */
export async function dummyPasswordCheck(password: string): Promise<void> {
  await verifyPassword(password, await dummy());
}

export { hashPassword, needsRehash };
