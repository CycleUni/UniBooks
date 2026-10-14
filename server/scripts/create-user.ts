/**
 * Create (or reset) an activated account directly in D1, skipping the
 * activation email. For local development, and for a deployment's first
 * superuser.
 *
 *   npm run user:create -- you@example.com [--first Ken] [--last Chou] [--role user|staff|admin] [--remote]
 *
 * The password is asked for without echoing it (or read from the
 * CREATE_USER_PASSWORD environment variable for scripts), so it never lands
 * in an argument list or the shell history. It is hashed with the server's
 * own lib/crypto.ts, so the stored hash is exactly what sign-in checks.
 *
 * An existing address gets the new password and is activated; --role,
 * when given, replaces its role. Without --remote it writes the local D1
 * that `npm run dev` uses.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/lib/crypto.ts';

const ROLES = ['user', 'staff', 'admin'] as const;
type Role = (typeof ROLES)[number];

/** Same floor as sign-up (services/accounts/passwords.ts); the rest of its checks are for the public form. */
const MIN_PASSWORD_LENGTH = 8;

function fail(message: string): never {
  console.error(`create-user: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const out: { email?: string; first: string; last: string; role?: Role; remote: boolean } = { first: '', last: '', remote: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? fail(`${arg} needs a value`);
    if (arg === '--first') out.first = value();
    else if (arg === '--last') out.last = value();
    else if (arg === '--role') {
      const role = value();
      if (!(ROLES as readonly string[]).includes(role)) fail(`--role must be one of ${ROLES.join(', ')}`);
      out.role = role as Role;
    } else if (arg === '--remote') out.remote = true;
    else if (arg.startsWith('--')) fail(`unknown option ${arg}`);
    else if (!out.email) out.email = arg;
    else fail(`unexpected argument ${arg}`);
  }
  if (!out.email) fail('usage: npm run user:create -- <email> [--first F] [--last L] [--role user|staff|admin] [--remote]');
  out.email = out.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) fail(`not an email address: ${out.email}`);
  return out as Required<Pick<typeof out, 'email'>> & typeof out;
}

/** Read a line from the terminal without echoing it. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) fail('no terminal to ask for the password; set CREATE_USER_PASSWORD instead');
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        input = input.slice(0, -1);
      } else {
        input += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.CREATE_USER_PASSWORD;
  if (fromEnv) return fromEnv;
  const first = await askHidden('Password: ');
  const again = await askHidden('Password (again): ');
  if (first !== again) fail('the two passwords differ');
  return first;
}

const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;

const args = parseArgs(process.argv.slice(2));
const password = await readPassword();
if (password.length < MIN_PASSWORD_LENGTH) fail(`the password needs at least ${MIN_PASSWORD_LENGTH} characters`);

const hash = await hashPassword(password);
const now = new Date().toISOString();
const name = [args.first, args.last].filter(Boolean).join(' ');
const role = args.role ?? 'user';
const statement = `INSERT INTO users (id, email, name, first_name, last_name, password_hash, role, is_active, is_banned, created_at, updated_at)
VALUES (${sql(randomUUID())}, ${sql(args.email)}, ${sql(name)}, ${sql(args.first)}, ${sql(args.last)}, ${sql(hash)}, ${sql(role)}, 1, 0, ${sql(now)}, ${sql(now)})
ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, is_active = 1, deleted_at = NULL,${args.role ? ' role = excluded.role,' : ''} updated_at = excluded.updated_at;`;

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('npx', ['wrangler', 'd1', 'execute', 'unibooks', args.remote ? '--remote' : '--local', '--command', statement], {
  cwd: serverDir,
  stdio: ['ignore', 'pipe', 'inherit'],
  encoding: 'utf8',
});
if (result.status !== 0) fail(`wrangler d1 execute failed (exit ${result.status})`);
console.log(
  `${args.email}: active, role ${args.role ?? 'user (an existing account keeps its role)'}, ${args.remote ? 'remote' : 'local'} D1. Sign in with the password you entered.`,
);
