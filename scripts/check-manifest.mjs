#!/usr/bin/env node
/**
 * Static manifest checks for CI and local `npm run check:manifest`.
 *
 * The load-bearing one is the compatibility gate: DSH's `evaluatePluginCompatibility`
 * only looks at peers named `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`, and an
 * upper bound that the running version falls outside of blocks the install.
 * This script fails when such a bound appears, so the trap cannot come back.
 *
 * @module dsh-session-link/scripts/check-manifest
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];
const notes = [];

const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const pkg = readJson('package.json');
const manifest = readJson('dsh.plugin.json');

// ---- package.json basics ---------------------------------------------------
if (pkg.type !== 'module') problems.push('package.json: type must be "module"');
if (pkg.main === undefined || existsSync(join(root, pkg.main)) !== true) problems.push(`package.json: main "${pkg.main}" does not exist`);
if (pkg.license === undefined) problems.push('package.json: license is missing');
if (pkg.dsh?.bundle?.patch === undefined) problems.push('package.json: dsh.bundle.patch is missing');
else if (existsSync(join(root, pkg.dsh.bundle.patch)) !== true) problems.push(`package.json: patch file ${pkg.dsh.bundle.patch} does not exist`);

// ---- compatibility gate ----------------------------------------------------
const GUARDED = /^@deepseek-ai\/dsh(-|$)/;
let guarded = 0;
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  if (GUARDED.test(name) !== true) {
    notes.push(`peer ${name}@${range} is outside the DSH compatibility gate (fine, it is skipped by design)`);
    continue;
  }
  guarded += 1;
  if (/<|<=/.test(range)) {
    problems.push(`peer ${name}@${range}: DSH peers must not declare an upper bound (>=0.1.0-rc.5 style)`);
  }
  if (/^\D*0\.0\./.test(range)) problems.push(`peer ${name}@${range}: suspiciously low floor`);
}
if (guarded === 0) problems.push('no @deepseek-ai/dsh* peer dependency found');

// ---- engines ---------------------------------------------------------------
if (typeof pkg.engines?.node === 'string' && /[<>]=?\s*24/.test(pkg.engines.node) === true) {
  const exclusive = pkg.engines.node.includes('<');
  if (exclusive) problems.push(`engines.node "${pkg.engines.node}" excludes Node 24 / future majors; keep it permissive`);
}

// ---- plugin manifest -------------------------------------------------------
if (manifest.id !== pkg.name) problems.push(`dsh.plugin.json id "${manifest.id}" must equal the package name "${pkg.name}"`);
if (manifest.version !== pkg.version) problems.push('dsh.plugin.json version must equal package.json version');
if (manifest.main !== pkg.main) problems.push('dsh.plugin.json main must equal package.json main');
const declared = manifest.contributes?.tools ?? [];
const expected = ['session_list', 'session_read', 'session_send', 'session_ask', 'check_delivery'];
if (JSON.stringify(declared) !== JSON.stringify(expected)) {
  problems.push(`dsh.plugin.json tools must be exactly ${expected.join(', ')} (got ${declared.join(', ')})`);
}

// ---- bundle patch ----------------------------------------------------------
const patch = readFileSync(join(root, pkg.dsh.bundle.patch), 'utf8');
if (patch.includes(`id: ${pkg.name}`) !== true) problems.push(`cordis.patch.yml must insert a row with id: ${pkg.name}`);
if (patch.includes(`name: '${pkg.name}'`) !== true && patch.includes(`name: ${pkg.name}`) !== true) {
  problems.push(`cordis.patch.yml must reference the plugin by name: ${pkg.name}`);
}
if (/^\s*- insert:/m.test(patch) !== true) problems.push('cordis.patch.yml must contain an insert list');

// ---- entry module exports --------------------------------------------------
const entry = readFileSync(join(root, pkg.main), 'utf8');
if (entry.includes('export const name') !== true) problems.push(`${pkg.main} must export const name`);
if (entry.includes('export const inject') !== true) problems.push(`${pkg.main} must export const inject`);
if (/export (async )?function apply/.test(entry) !== true) problems.push(`${pkg.main} must export apply()`);
for (const tool of expected) {
  if (entry.includes(`'${tool}'`) !== true && readFileSync(join(root, 'lib/tools.js'), 'utf8').includes(`name: '${tool}'`) !== true) {
    problems.push(`tool ${tool} is declared in dsh.plugin.json but not defined in lib/tools.js`);
  }
}

// ---- report ----------------------------------------------------------------
for (const note of notes) console.log(`note: ${note}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  console.error(`\n${problems.length} manifest problem(s)`);
  process.exitCode = 1;
} else {
  console.log(`manifest ok: ${pkg.name}@${pkg.version}, ${guarded} guarded peer(s), patch ${pkg.dsh.bundle.patch}`);
}
