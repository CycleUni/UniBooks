import * as fs from 'fs';
import * as path from 'path';
import { en } from './en';
import { zhTW } from './zh-TW';
import { zhHK } from './zh-HK';
import { IMAGE_PREVIEW_TOKEN } from '../../features/messages/message-formatting.util';

const I18N_DIR = path.join(process.cwd(), 'src/app/core/i18n');
const SRC_DIR = path.join(process.cwd(), 'src/app');
// The server's source, next to this app in the same repository. If the path
// ever stops resolving, the backend checks below skip instead of passing on
// zero files, and the orphan check would see the backend-only keys as unused.
const BE_DIR = path.join(process.cwd(), '..', 'server', 'src');
const BE_SKIP = ['migrations', 'ads-migrations', 'node_modules'];

/** i18n keys the server can send: error codes and system-notice keys. */
const BACKEND_CODE_PATTERNS = [
  /apiError\(\s*\d{3}\s*,\s*'([a-z][A-Za-z]*\.[A-Za-z0-9_.]+)'/g,
  /'([a-z][A-Za-z]*\.err[A-Za-z0-9_]*)'/g,
  /\[SYSTEM:([a-z]+\.[A-Za-z0-9_.]+)\]/g,
];

function walk(dir: string, exts: string[], skipDirs: string[] = []): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full, exts, skipDirs));
    } else if (exts.some(ext => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

function extractDeclaredKeys(filePath: string): string[] {
  const source = fs.readFileSync(filePath, 'utf-8');
  const pattern = /^\s*'([a-zA-Z0-9_.]+)':/gm;
  const keys: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    keys.push(match[1]);
  }
  return keys;
}

describe('i18n translation keys (en.ts / zh-TW.ts / zh-HK.ts)', () => {
  it('should have the exact same set of keys in all languages (no missing keys)', () => {
    const enKeys = new Set(Object.keys(en));
    const zhTwKeys = new Set(Object.keys(zhTW));
    const zhHkKeys = new Set(Object.keys(zhHK));

    const missingInZhTw = [...enKeys].filter(k => !zhTwKeys.has(k)).sort();
    const missingInEn = [...zhTwKeys].filter(k => !enKeys.has(k)).sort();
    const missingInZhHk = [...enKeys].filter(k => !zhHkKeys.has(k)).sort();

    expect(missingInZhTw).toEqual([]);
    expect(missingInEn).toEqual([]);
    expect(missingInZhHk).toEqual([]);
  });

  it('should not declare the same key twice within one language file', () => {
    const findDuplicates = (filePath: string): string[] => {
      const keys = extractDeclaredKeys(filePath);
      const seen = new Map<string, number>();
      for (const key of keys) seen.set(key, (seen.get(key) ?? 0) + 1);
      return [...seen.entries()]
        .filter(([, count]) => count > 1)
        .map(([key]) => key)
        .sort();
    };

    expect(findDuplicates(path.join(I18N_DIR, 'en.ts'))).toEqual([]);
    expect(findDuplicates(path.join(I18N_DIR, 'zh-TW.ts'))).toEqual([]);
    expect(findDuplicates(path.join(I18N_DIR, 'zh-HK.ts'))).toEqual([]);
  });

  it('should not declare keys that nothing in the app references', (ctx) => {
    // Around fifty of these keys are referenced only from the backend, so
    // without it this cannot tell an orphan from a key it simply cannot see —
    // it would report all fifty as unused. Skipped rather than answered
    // wrongly; CI checks out the sibling repository so it does run there.
    if (!fs.existsSync(BE_DIR)) {
      ctx.skip();
      return;
    }

    const feFiles = walk(SRC_DIR, ['.ts', '.html'], ['i18n']).filter(f => !f.endsWith('.spec.ts'));
    let combinedSource = '';
    const dynamicPrefixes = new Set<string>();
    const dynamicPrefixPattern = /['"]([a-zA-Z0-9_.]+[._])['"]\s*\+/g;
    const dynamicTemplatePattern = /`([a-zA-Z0-9_.]+[._])\$\{/g;

    for (const file of feFiles) {
      const source = fs.readFileSync(file, 'utf-8');
      combinedSource += source;
      let match: RegExpExecArray | null;
      dynamicPrefixPattern.lastIndex = 0;
      while ((match = dynamicPrefixPattern.exec(source)) !== null) dynamicPrefixes.add(match[1]);
      dynamicTemplatePattern.lastIndex = 0;
      while ((match = dynamicTemplatePattern.exec(source)) !== null) dynamicPrefixes.add(match[1]);
    }

    let backendSource = '';
    if (fs.existsSync(BE_DIR)) {
      const beFiles = walk(BE_DIR, ['.ts'], BE_SKIP);
      for (const file of beFiles) backendSource += fs.readFileSync(file, 'utf-8');
    }

    const allKeys = new Set([...Object.keys(en), ...Object.keys(zhTW)]);
    const prefixes = [...dynamicPrefixes];

    const unused = [...allKeys]
      .filter(key => {
        if (prefixes.some(prefix => key.startsWith(prefix))) return false;
        if (
          combinedSource.includes(`'${key}'`) ||
          combinedSource.includes(`"${key}"`) ||
          combinedSource.includes('`' + key)
        ) {
          return false;
        }
        if (backendSource && (backendSource.includes(`'${key}'`) || backendSource.includes(`"${key}"`))) {
          return false;
        }
        return true;
      })
      .sort();

    expect(unused).toEqual([]);
  });

  it('should declare every key the app actually renders', () => {
    // The orphan check above looks the other way: declared but unreferenced.
    // Nothing caught a key that is *rendered but never declared*, so
    // `admin.editRegion` shipped and the admin page displayed the raw key
    // string as its heading. Unit tests cannot see that; only a browser or
    // this check can.
    const feFiles = walk(SRC_DIR, ['.ts', '.html'], ['i18n']).filter(f => !f.endsWith('.spec.ts'));

    // A key built at runtime ('order.status.' + s) is declared under its
    // concrete forms, so only the literal call sites can be checked.
    const dynamicPrefixes = new Set<string>();
    const dynamicPrefixPattern = /['"]([a-zA-Z0-9_.]+[._])['"]\s*\+/g;
    const dynamicTemplatePattern = /`([a-zA-Z0-9_.]+[._])\$\{/g;

    const rendered = new Map<string, string>();
    // Only forms that reach the translator: the `| t` pipe in a template and
    // i18n.t('...') in TypeScript. A bare string that merely looks like a key
    // — a backend error code being compared, say — is not a render.
    const pipePattern = /['"]([a-zA-Z0-9_]+\.[a-zA-Z0-9._]+)['"]\s*\|\s*t\b/g;
    const callPattern = /\.t\(\s*['"]([a-zA-Z0-9_]+\.[a-zA-Z0-9._]+)['"]/g;

    for (const file of feFiles) {
      const source = fs.readFileSync(file, 'utf-8');
      let match: RegExpExecArray | null;
      for (const pattern of [dynamicPrefixPattern, dynamicTemplatePattern]) {
        pattern.lastIndex = 0;
        while ((match = pattern.exec(source)) !== null) dynamicPrefixes.add(match[1]);
      }
      for (const pattern of [pipePattern, callPattern]) {
        pattern.lastIndex = 0;
        while ((match = pattern.exec(source)) !== null) {
          if (!rendered.has(match[1])) rendered.set(match[1], path.relative(SRC_DIR, file));
        }
      }
    }

    const prefixes = [...dynamicPrefixes];
    const undeclared = [...rendered.entries()]
      .filter(([key]) => !prefixes.some(prefix => key.startsWith(prefix)))
      .filter(([key]) => !(key in en))
      .map(([key, file]) => `${key} (${file})`)
      .sort();

    expect(undeclared).toEqual([]);
  });

  it('should declare every error code the backend can return', (ctx) => {
    // The two checks above cover declared-but-unused and rendered-but-undeclared,
    // both of which only look at this repo. The third direction is the one that
    // actually reached users: the backend answers with {"error": {"code": "..."}}
    // and the frontend feeds that code straight to t(), which echoes an unknown
    // key back — so a code no locale declared was rendered as
    // `listing.errFileTooLarge` where a sentence belonged. 21 of the backend's
    // codes were in that state at once.
    // Passing here would be worse than skipping: it would report that the
    // frontend declares every code the backend emits, having read no backend.
    if (!fs.existsSync(BE_DIR)) {
      ctx.skip();
      return;
    }

    const emitted = new Map<string, string>();
    for (const file of walk(BE_DIR, ['.ts'], BE_SKIP)) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const pattern of BACKEND_CODE_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(source)) !== null) {
          if (!emitted.has(match[1])) emitted.set(match[1], path.relative(BE_DIR, file));
        }
      }
    }

    const undeclared = [...emitted.entries()]
      .filter(([code]) => !(code in en))
      .map(([code, file]) => `${code} (${file})`)
      .sort();

    expect(undeclared).toEqual([]);
  });

  it('should resolve the image-preview token the chat server writes', () => {
    const key = IMAGE_PREVIEW_TOKEN.replace(/^\[SYSTEM:/, '').replace(/\]$/, '');

    expect(en[key]).toBeTruthy();
    expect(zhTW[key]).toBeTruthy();
    expect(zhHK[key]).toBeTruthy();
    expect(en[key]).not.toEqual(zhTW[key]);

    // The server writes this exact token as the inbox preview of an image message.
    if (fs.existsSync(BE_DIR)) {
      const server = walk(BE_DIR, ['.ts'], BE_SKIP).map((f) => fs.readFileSync(f, 'utf-8')).join('\n');
      expect(server).toContain(IMAGE_PREVIEW_TOKEN);
    }
  });
});
