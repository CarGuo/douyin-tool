#!/usr/bin/env node
/**
 * run-regression.mjs
 *
 * Runs every test suite in the repo and writes a regression report to
 * harness/regression/last-run.json. CI / pre-release should call this.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPORT_DIR = resolve(ROOT, 'harness/regression');

const SUITES = [
  { name: 'server-unit', cmd: 'npm', args: ['run', 'test', '-w', '@douyin-tool/server'] },
  { name: 'web-unit', cmd: 'npm', args: ['run', 'test', '-w', '@douyin-tool/web'] },
];

function run(cmd, args) {
  return new Promise((resolveP) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', (code) => {
      resolveP({ code, durationMs: Date.now() - t0 });
    });
  });
}

async function main() {
  await mkdir(REPORT_DIR, { recursive: true });
  const results = [];
  let failed = 0;
  for (const s of SUITES) {
    console.log(`\n==== regression: ${s.name} ====`);
    const r = await run(s.cmd, s.args);
    results.push({ ...s, ...r, ok: r.code === 0 });
    if (r.code !== 0) failed++;
  }
  const report = {
    startedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    results,
    summary: { total: SUITES.length, failed, passed: SUITES.length - failed },
  };
  await writeFile(resolve(REPORT_DIR, 'last-run.json'), JSON.stringify(report, null, 2));
  console.log(`\nRegression report -> harness/regression/last-run.json`);
  console.log(`Summary: ${report.summary.passed}/${report.summary.total} passed`);
  process.exit(failed ? 1 : 0);
}
main();
