#!/usr/bin/env node
/**
 * Host smoke test: compile this plugin's tool definitions with the **real**
 * `defineTool` from the installed DSH packages, and validate sample arguments
 * with its **real** `validateArgs`.
 *
 * This is the closest offline check to what happens when the loader registers
 * the plugin (short of booting a profile), and it is what backs the claim
 * "the schemas the host compiles are exactly the schemas in lib/tools.js".
 *
 * Usage:
 *   node scripts/smoke-host.mjs [--dsh-root /path/to/node_modules/@deepseek-ai/dsh]
 *
 * Exits non-zero when a definition is rejected or a sample does not validate.
 *
 * @module dsh-session-link/scripts/smoke-host
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createToolDefinitions, createToolOptions } from '../lib/tools.js';
import { createEngine, resolveConfig } from '../lib/engine.js';
import { createLinkStore } from '../lib/store.js';

const args = process.argv.slice(2);
const flagIndex = args.indexOf('--dsh-root');
const candidates = [
  flagIndex === -1 ? undefined : args[flagIndex + 1],
  process.env.DSH_PACKAGE_ROOT,
  '/home/dwad/.local/lib/node_modules/@deepseek-ai/dsh',
  join(process.env.HOME ?? '', '.local/lib/node_modules/@deepseek-ai/dsh'),
].filter((value) => typeof value === 'string' && value !== '');

const dshRoot = candidates.find((candidate) => existsSync(join(candidate, 'package.json')));
if (dshRoot === undefined) {
  console.error('could not locate the DSH installation; pass --dsh-root <.../@deepseek-ai/dsh>');
  process.exitCode = 2;
  process.exit();
}

const require = createRequire(join(dshRoot, 'package.json'));
const load = async (specifier) => {
  const resolved = require.resolve(specifier);
  return await import(pathToFileURL(resolved).href);
};

const { defineTool, validateArgs } = await load('@deepseek-ai/dsh-tools');
const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
console.log(`host packages: ${dshRoot}`);
console.log(`  defineTool=${typeof defineTool}  validateArgs=${typeof validateArgs}  createUserMessage=${typeof createUserMessage}`);

/** Minimal context: the smoke test only compiles schemas, it never delivers. */
const ctx = {
  logger: { info() {}, warn() {}, debug() {} },
  get: () => undefined,
  on: () => () => {},
  tools: { register: () => () => {} },
};
const config = resolveConfig({});
const engine = createEngine({
  ctx,
  store: createLinkStore(),
  audit: { path: 'smoke', append: async () => {}, load: async () => [], flush: async () => {} },
  config,
  createUserMessage,
});

// `createToolOptions` needs the same dependencies; it returns the raw specs so
// the host's own `validateArgs` (which takes a spec, not a JSON Schema) can run.
const options = createToolOptions({ ctx, engine, config });

/**
 * Compile one option object defensively so a rejection names its tool.
 *
 * This is the SAME path the loader takes (`createToolDefinitions` →
 * `defineTool` per option), which matters: the host's `defineTool` mutates the
 * options it is given, so compiling an already-compiled object throws
 * `parameters.type must be a value schema object`. Regression test:
 * tests/tool-definitions.test.mjs.
 */
function compile(entry) {
  try {
    return { definition: defineTool(entry) };
  } catch (error) {
    return { error, name: entry.name };
  }
}

const compiled = options.map(compile);
const failuresToCompile = compiled.filter((entry) => entry.error !== undefined);
for (const failed of failuresToCompile) {
  console.error(`FAIL ${failed.name}: ${failed.error.message}`);
  for (const violation of failed.error.violations ?? []) console.error(`     ! ${violation}`);
}
const definitions = compiled.filter((entry) => entry.definition !== undefined).map((entry) => entry.definition);
if (failuresToCompile.length > 0) process.exitCode = 1;

/** Sample arguments that must pass the host's own argument validator. */
const samples = {
  session_list: { query: 'FPGA', limit: 5, includeArchived: true },
  session_read: { sessionId: 'session-1', limit: 10 },
  session_send: { sessionId: 'session-1', text: 'hi', mode: 'followup', requestId: 'req_1' },
  session_ask: { sessionId: 'session-1', text: 'hi', waitMs: 5000 },
  check_delivery: { requestId: 'req_1' },
};

/**
 * Wrong-typed samples that must be rejected by the same compiler. The host's
 * parameter root is an *implicit open object* (documented in dsh-tools), so an
 * unexpected property is accepted by design — a type violation is the honest
 * negative case.
 */
const negatives = {
  session_list: { limit: 'not-a-number' },
  session_read: { sessionId: 5 },
  session_send: { text: 42 },
  session_ask: { text: 42 },
  check_delivery: { requestId: 5 },
};

let failures = 0;
for (const [index, definition] of definitions.entries()) {
  const spec = options[index]?.parameters ?? definition.parameters;
  const problems = validateArgs(spec, samples[definition.name] ?? {});
  const ok = problems.length === 0;
  if (ok !== true) failures += 1;
  console.log(
    `\n${ok ? 'ok  ' : 'FAIL'} ${definition.name}  (${Object.keys(spec).length} params, output schema ${definition.output.schema.type})`,
  );
  console.log(`     ${definition.description.split('\n')[0].slice(0, 110)}…`);
  for (const problem of problems) console.log(`     ! ${problem}`);
  // A wrong type must be rejected by the same compiler, or the sample above proves nothing.
  const negative = validateArgs(spec, negatives[definition.name] ?? {});
  if (negative.length === 0) {
    console.log('     ! compiler accepted a wrong-typed sample (schema is too permissive)');
    failures += 1;
  } else {
    console.log(`     wrong-typed sample rejected: ${negative[0]}`);
  }
  if (typeof definition.output.render === 'function') {
    const rendered = definition.output.render(samples[definition.name], { ok: false, code: 'SMOKE', message: 'smoke', messages: [], degraded: [], sessions: [], total: 0, truncated: false, found: false });
    if (Array.isArray(rendered) !== true || rendered[0]?.type !== 'text') {
      console.log('     ! render() did not return a text content block');
      failures += 1;
    }
  }
}

console.log(`\n${definitions.length} tool definition(s) compiled, ${failures} failure(s)`);
process.exitCode = failures === 0 ? 0 : 1;
