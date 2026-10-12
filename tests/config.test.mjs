import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConfigSchema } from '../lib/config.js';
import { DEFAULT_CONFIG, resolveConfig, unwrapVolatile } from '../lib/engine.js';

const schema = await createConfigSchema();

describe('Config schema', () => {
  it('is available (schemastery installed)', () => {
    assert.notEqual(schema, undefined, 'schemastery must resolve for the settings page to exist');
    assert.equal(typeof schema.toJSON, 'function');
  });

  it('defaults every field to the engine defaults', () => {
    const resolved = schema({});
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      if (key in resolved) {
        // Volatile fields resolve to a `{get()}` wrapper; unwrap before comparing.
        assert.deepEqual(unwrapVolatile(resolved[key]), value, `${key} schema default must equal DEFAULT_CONFIG`);
      }
    }
    assert.equal(unwrapVolatile(resolved.maxHops), 6);
    assert.equal(unwrapVolatile(resolved.verifyCapability), true);
  });

  it('marks exactly the settings-page fields volatile', () => {
    // The harness only gives an entry a settings namespace when its Config has
    // volatile fields (`dsh-settings`' volatileForm projection), so this set is
    // what the Web UI can edit live.
    const json = schema.toJSON();
    const root = json.refs[json.uid] ?? Object.values(json.refs).find((node) => node.dict !== undefined);
    const volatile = Object.entries(root.dict)
      .filter(([, reference]) => json.refs[reference]?.meta?.volatile === true)
      .map(([key]) => key)
      .sort();
    assert.deepEqual(volatile, ['auditFile', 'dedupeWindowMs', 'maxHops', 'maxTextChars', 'rateLimitPerMinute', 'verifyCapability']);
  });

  it('validates maxHops bounds instead of silently accepting garbage', () => {
    assert.equal(unwrapVolatile(schema({ maxHops: 1 }).maxHops), 1);
    assert.equal(unwrapVolatile(schema({ maxHops: 64 }).maxHops), 64);
    assert.throws(() => schema({ maxHops: 0 }), /maxHops/);
    assert.throws(() => schema({ maxHops: 65 }), /maxHops/);
    assert.throws(() => schema({ maxHops: 'many' }), /maxHops/);
  });

  it('rejects out-of-range and wrong-typed values for the other fields', () => {
    assert.throws(() => schema({ rateLimitPerMinute: -1 }), /rateLimitPerMinute/);
    assert.throws(() => schema({ maxTextChars: 10 }), /maxTextChars/);
    assert.throws(() => schema({ verifyCapability: 'yes' }), /verifyCapability/);
    assert.throws(() => schema({ awaitMaxMs: 100 }), /awaitMaxMs/);
  });

  it('exposes descriptions for the settings page fields', () => {
    for (const key of ['maxHops', 'rateLimitPerMinute', 'dedupeWindowMs', 'verifyCapability', 'maxTextChars', 'auditFile']) {
      const description = schema.dict?.[key]?.meta?.description ?? schema.dict?.[key]?.description;
      assert.equal(typeof description, 'string', `${key} needs a description`);
      assert.ok(description.length > 4);
    }
  });

  it('serializes to JSON (the page rehydrates this schema)', () => {
    const json = schema.toJSON();
    const text = JSON.stringify(json);
    assert.ok(text.includes('maxHops'));
    assert.ok(text.length > 100);
  });

  it('feeds resolveConfig plain values even though volatile fields wrap them', () => {
    const effective = resolveConfig(schema({ maxHops: 3, verifyCapability: false }));
    assert.equal(typeof effective.maxHops, 'number');
    assert.equal(effective.maxHops, 3);
    assert.equal(effective.verifyCapability, false);
    // untouched keys keep engine defaults
    assert.equal(effective.rateLimitPerMinute, DEFAULT_CONFIG.rateLimitPerMinute);
    // and every value the engine will use is plain data
    for (const [key, value] of Object.entries(effective)) {
      const expected = DEFAULT_CONFIG[key];
      assert.equal(typeof value, typeof expected, `${key} must be a plain ${typeof expected}`);
    }
  });

  it('unwraps volatile wrappers defensively', () => {
    const wrapped = schema({ maxHops: 9 }).maxHops;
    assert.equal(typeof wrapped, 'object');
    assert.equal(unwrapVolatile(wrapped), 9);
    assert.equal(unwrapVolatile(9), 9);
    assert.equal(unwrapVolatile(undefined), undefined);
    // An object that merely has a `get` method is NOT a volatile wrapper: the
    // marker symbol is what identifies one, so it must pass through untouched.
    const lookalike = { get: () => 1 };
    assert.equal(unwrapVolatile(lookalike), lookalike);
  });

  it('keeps resolveConfig usable without a schema (defensive host path)', () => {
    const effective = resolveConfig(undefined);
    assert.equal(effective.maxHops, DEFAULT_CONFIG.maxHops);
    assert.equal(effective.auditFile, DEFAULT_CONFIG.auditFile);
  });
});
