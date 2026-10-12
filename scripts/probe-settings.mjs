#!/usr/bin/env node
/**
 * Self-check: does a **fresh** dsh process expose a settings page for this
 * plugin? (`npm run probe:settings`)
 *
 * The Web UI renders a configuration form only when the harness's settings
 * service (`dsh-settings`) can project a form out of this plugin's `Config` —
 * and that service exists only for fields carrying `meta.volatile`. When the
 * page stays empty, this script answers *why* from the host side, without a
 * browser and without touching the profile you are running:
 *
 *   1. writes a throwaway overlay plugin (scripts/probe-settings-plugin.mjs),
 *   2. boots `dsh --profile <profile> --patch <overlay>`, which mounts the real
 *      loader + the real settings service (no prompt, no model call: the app
 *      exits with "a task is required" right after the probe reports),
 *   3. reads back what `ctx.settings.describe()` said about this entry
 *      (namespace present? which fields are editable? does a write land in the
 *      profile patch? is a non-editable field refused?),
 *   4. reverts the write and deletes the temporary files.
 *
 * Usage:
 *   node scripts/probe-settings.mjs [--profile headless] [--write] [--timeout 180]
 *
 * `--write` also exercises one real save + revert (it leaves a `config:` block
 * for the entry in that profile's `cordis.patch.yml`, exactly like a Web UI
 * save does); without it the probe is read-only. Exit code 1 means a fresh
 * process gives the entry no settings namespace — the case the Web UI reports
 * as an empty page. A **stale `dsh web` process** is the usual reason a user
 * sees nothing: the loader caches imported modules, so changes under `lib/`
 * need a dsh restart (`dsh plugin …` reload only re-runs `apply`).
 *
 * @module dsh-session-link/scripts/probe-settings
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Parse `--flag value` pairs out of argv. */
function options(argv) {
  const flags = { profile: 'headless', write: false, timeout: 180, namespace: 'dsh-session-link', prompt: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--write') flags.write = true;
    else if (token === '--profile') flags.profile = argv[++index];
    else if (token === '--timeout') flags.timeout = Number(argv[++index]);
    else if (token === '--ns') flags.namespace = argv[++index];
    else if (token === '--prompt') flags.prompt = argv[++index];
  }
  return flags;
}

const flags = options(process.argv.slice(2));
const workdir = mkdtempSync(join(tmpdir(), 'dsh-settings-probe-'));
const outFile = join(workdir, 'out.json');
const overlay = join(workdir, 'overlay.yml');
const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh');
const profilePatch = join(home, 'profiles', flags.profile, 'cordis.patch.yml');

writeFileSync(overlay, `- insert:\n    - id: sessionlink-probe\n      name: ${join(HERE, 'probe-settings-plugin.mjs')}\n`);

const bin = process.env.DSH_BIN ?? 'dsh';
const args = ['--profile', flags.profile, '--patch', overlay];
if (flags.prompt !== '') args.push(flags.prompt);
console.log(`probe: ${bin} --profile ${flags.profile} --patch <temp overlay>${flags.write ? '  (write test on)' : ''}`);

const result = spawnSync(bin, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: flags.timeout * 1000,
  env: {
    ...process.env,
    DSH_PROBE_OUT: outFile,
    DSH_PROBE_NS: flags.namespace,
    DSH_PROBE_WRITE: flags.write ? '1' : '0',
    DSH_PROBE_PATCH: profilePatch,
  },
  encoding: 'utf8',
});

const report = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : undefined;
rmSync(workdir, { recursive: true, force: true });

if (report === undefined) {
  console.error('probe: no report — the process never reached the settings service.');
  console.error(`probe: stderr tail:\n${String(result.stderr ?? '').split('\n').slice(-10).join('\n')}`);
  process.exit(2);
}

const steps = new Map((report.steps ?? []).map((step) => [step.step, step]));
const namespaces = steps.get('namespaces')?.namespaces ?? [];
const entry = steps.get('entry');
const write = steps.get('write');
const refused = steps.get('non-editable-write');

console.log(`probe: namespaces        ${namespaces.length === 0 ? '(none)' : namespaces.join(', ')}`);
if (entry === undefined) {
  console.error(`probe: no entry step — ${String(report.error ?? 'unknown error')}`);
  process.exit(2);
}
console.log(`probe: ${flags.namespace}   ${entry.found ? 'PRESENT' : 'MISSING'}`);
if (entry.found) console.log(`probe: editable fields   ${entry.editable.join(', ')}`);
if (entry.found) console.log(`probe: resolved values   ${JSON.stringify(entry.value)}`);
if (write !== undefined) console.log(`probe: write test        ${write.key} → ${JSON.stringify(write.wrote)} (revision ${String(write.revision)})`);
if (write !== undefined) console.log(`probe: reverted to       ${JSON.stringify(steps.get('revert')?.value)}`);
if (refused !== undefined) console.log(`probe: non-editable field ${refused.refused === undefined ? '(accepted — unexpected!)' : `refused: ${refused.refused}`}`);

if (!entry.found) {
  console.error(
    'probe: FAIL — a fresh dsh process gives this entry no settings namespace.\n' +
      '       Config fields must be marked with markEditable()/`.volatile()` (lib/config.js).',
  );
  process.exit(1);
}
console.log('probe: OK — a fresh dsh process exposes the settings page for this plugin.');
