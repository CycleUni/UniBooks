const fs = require('fs');
const path = require('path');

const COMMIT_SHA = '12285f5642ba7f470d4964dfdbe007994db059dc';
const AAGUID_URL = `https://raw.githubusercontent.com/passkeydeveloper/passkey-authenticator-aaguids/${COMMIT_SHA}/combined_aaguid.json`;

const CACHE_DIR = path.join(__dirname, '../.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'combined_aaguid.json');
const OUTPUT_DIR = path.join(__dirname, '../public/passkey-icons');
const NAMES_JSON_FILE = path.join(OUTPUT_DIR, 'names.json');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function parseDataUri(dataUri) {
  if (!dataUri || typeof dataUri !== 'string') return null;
  const match = dataUri.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) return null;
  const mimeSubtype = match[1].toLowerCase();
  let ext = mimeSubtype;
  if (mimeSubtype === 'svg+xml') ext = 'svg';
  else if (mimeSubtype === 'jpeg') ext = 'jpg';
  try {
    const buffer = Buffer.from(match[2], 'base64');
    return { ext, buffer };
  } catch {
    return null;
  }
}

async function fetchOrReadAaguids() {
  // Check cache: reuse if less than 1 day old
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const stats = fs.statSync(CACHE_FILE);
      if (Date.now() - stats.mtimeMs < ONE_DAY_MS) {
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        return JSON.parse(raw);
      }
    } catch {
      // If cache read fails, fall through to download
    }
  }

  // Attempt download
  try {
    const res = await fetch(AAGUID_URL);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const raw = await res.text();
    const json = JSON.parse(raw);
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, raw, 'utf8');
    } catch (cacheErr) {
      console.warn(`[fetch-passkey-icons] Warning: could not write cache: ${cacheErr.message}`);
    }
    return json;
  } catch (err) {
    // If download failed but an older cache exists, reuse it
    if (fs.existsSync(CACHE_FILE)) {
      try {
        console.warn(`[fetch-passkey-icons] Download failed (${err.message}), falling back to older cache`);
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        return JSON.parse(raw);
      } catch {}
    }
    throw err;
  }
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let data;
  try {
    data = await fetchOrReadAaguids();
  } catch (err) {
    console.warn(`[fetch-passkey-icons] Warning: failed to fetch passkey icons: ${err.message}`);
    fs.writeFileSync(NAMES_JSON_FILE, '{}', 'utf8');
    return;
  }

  const names = {};
  for (const [aaguid, item] of Object.entries(data)) {
    if (!item) continue;
    const name = item.name || '';
    let light = null;
    let dark = null;

    if (item.icon_light) {
      const parsed = parseDataUri(item.icon_light);
      if (parsed) {
        const fileName = `${aaguid}.light.${parsed.ext}`;
        try {
          fs.writeFileSync(path.join(OUTPUT_DIR, fileName), parsed.buffer);
          light = fileName;
        } catch (writeErr) {
          console.warn(`[fetch-passkey-icons] Could not write ${fileName}: ${writeErr.message}`);
        }
      }
    }

    if (item.icon_dark) {
      const parsed = parseDataUri(item.icon_dark);
      if (parsed) {
        const fileName = `${aaguid}.dark.${parsed.ext}`;
        try {
          fs.writeFileSync(path.join(OUTPUT_DIR, fileName), parsed.buffer);
          dark = fileName;
        } catch (writeErr) {
          console.warn(`[fetch-passkey-icons] Could not write ${fileName}: ${writeErr.message}`);
        }
      }
    }

    names[aaguid] = { name, light, dark };
  }

  fs.writeFileSync(NAMES_JSON_FILE, JSON.stringify(names, null, 2), 'utf8');
  console.log(`[fetch-passkey-icons] Wrote ${Object.keys(names).length} authenticators to ${NAMES_JSON_FILE}`);
}

main().catch((err) => {
  console.warn(`[fetch-passkey-icons] Warning: unexpected error: ${err.message}`);
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    if (!fs.existsSync(NAMES_JSON_FILE)) {
      fs.writeFileSync(NAMES_JSON_FILE, '{}', 'utf8');
    }
  } catch {}
});
