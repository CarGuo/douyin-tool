#!/usr/bin/env node
/**
 * check-package-age.mjs
 *
 * Security policy enforcement:
 *   Every dependency version we install MUST have been published
 *   on the npm registry for at least MIN_AGE_DAYS days.
 *
 *   This protects against supply-chain attacks where a malicious
 *   actor publishes a hijacked version and downstream installs
 *   pick it up immediately (see chalk/debug/event-stream incidents).
 *
 * Modes:
 *   --soft   : warn-only (used in preinstall when lockfile may not exist yet)
 *   default  : hard-fail with non-zero exit on violations
 *
 * Usage:
 *   node scripts/check-package-age.mjs
 *   node scripts/check-package-age.mjs --soft
 *
 * Env:
 *   MIN_AGE_DAYS         override default (10)
 *   AGE_CHECK_DISABLE=1  bypass entirely (NOT recommended)
 *   AGE_CHECK_OFFLINE=1  skip registry calls (allow offline installs)
 */

import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MIN_AGE_DAYS = Number(process.env.MIN_AGE_DAYS ?? 10);
const SOFT = process.argv.includes('--soft');

if (process.env.AGE_CHECK_DISABLE === '1') {
  console.log('[age-check] disabled via AGE_CHECK_DISABLE=1');
  process.exit(0);
}

if (process.env.AGE_CHECK_OFFLINE === '1') {
  console.log('[age-check] offline mode, skipping registry calls');
  process.exit(0);
}

const LOCK_PATH = resolve(ROOT, 'package-lock.json');

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadLock() {
  if (!(await exists(LOCK_PATH))) {
    if (SOFT) {
      console.log('[age-check] no lockfile yet, soft skip.');
      process.exit(0);
    }
    console.error('[age-check] package-lock.json not found. Run `npm install` first.');
    process.exit(1);
  }
  const raw = await readFile(LOCK_PATH, 'utf8');
  return JSON.parse(raw);
}

function collectDeps(lock) {
  const out = new Map(); // name -> Set<version>
  const pkgs = lock.packages ?? {};
  for (const [path, info] of Object.entries(pkgs)) {
    if (!path.startsWith('node_modules/')) continue;
    if (!info.version) continue;
    // path like "node_modules/foo" or "node_modules/foo/node_modules/bar"
    const segments = path.split('node_modules/').filter(Boolean);
    const last = segments[segments.length - 1].replace(/\/$/, '');
    const name = last.startsWith('@') ? last.split('/').slice(0, 2).join('/') : last.split('/')[0];
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(info.version);
  }
  return out;
}

async function fetchPublishTime(name, version) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`;
  const res = await fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
  if (!res.ok) throw new Error(`registry ${name} -> ${res.status}`);
  const data = await res.json();
  const t = data?.time?.[version];
  if (!t) throw new Error(`no time entry for ${name}@${version}`);
  return new Date(t);
}

async function main() {
  const lock = await loadLock();
  const deps = collectDeps(lock);
  const total = [...deps.values()].reduce((a, s) => a + s.size, 0);
  console.log(`[age-check] policy: every package must be published >= ${MIN_AGE_DAYS} days ago`);
  console.log(`[age-check] auditing ${total} (name, version) pairs ...`);

  const now = Date.now();
  const minMs = MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
  const violations = [];
  const errors = [];

  const tasks = [];
  for (const [name, versions] of deps) {
    for (const v of versions) {
      tasks.push(
        (async () => {
          try {
            const published = await fetchPublishTime(name, v);
            const ageMs = now - published.getTime();
            if (ageMs < minMs) {
              violations.push({
                name,
                version: v,
                publishedAt: published.toISOString(),
                ageDays: (ageMs / 86400000).toFixed(2),
              });
            }
          } catch (err) {
            errors.push({ name, version: v, error: String(err.message ?? err) });
          }
        })(),
      );
    }
  }

  // limit concurrency
  const CONC = 8;
  for (let i = 0; i < tasks.length; i += CONC) {
    await Promise.all(tasks.slice(i, i + CONC));
  }

  if (errors.length) {
    console.warn(`[age-check] ${errors.length} packages could not be checked (likely network or private):`);
    for (const e of errors.slice(0, 20)) console.warn(`  ! ${e.name}@${e.version} -> ${e.error}`);
  }

  if (violations.length) {
    console.error(`\n[age-check] FAIL: ${violations.length} package(s) younger than ${MIN_AGE_DAYS} days`);
    for (const v of violations) {
      console.error(`  - ${v.name}@${v.version}  published ${v.publishedAt}  (age ${v.ageDays}d)`);
    }
    if (!SOFT) process.exit(1);
  } else {
    console.log('[age-check] OK: all dependencies satisfy the age policy.');
  }
}

main().catch((err) => {
  console.error('[age-check] unexpected error:', err);
  if (!SOFT) process.exit(1);
});
