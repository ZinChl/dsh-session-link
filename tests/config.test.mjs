import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConfigSchema } from '../lib/config.js';
import { DEFAULT_CONFIG, resolveConfig } from '../lib/engine.js';

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
        assert.deepEqual(resolved[key], value, `${key} schema default must equal DEFAULT_CONFIG`);
      }
    }
    assert.equal(resolved.maxHops, 6);
    assert.equal(resolved.verifyCapability, true);
  });

  it('validates maxHops bounds instead of silently accepting garbage', () => {
    assert.equal(schema({ maxHops: 1 }).maxHops, 1);
    assert.equal(schema({ maxHops: 64 }).maxHops, 64);
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

  it('feeds resolveConfig with a complete, clamped configuration', () => {
    const effective = resolveConfig(schema({ maxHops: 3, verifyCapability: false }));
    assert.equal(effective.maxHops, 3);
    assert.equal(effective.verifyCapability, false);
    // untouched keys keep engine defaults
    assert.equal(effective.rateLimitPerMinute, DEFAULT_CONFIG.rateLimitPerMinute);
  });

  it('keeps resolveConfig usable without a schema (defensive host path)', () => {
    const effective = resolveConfig(undefined);
    assert.equal(effective.maxHops, DEFAULT_CONFIG.maxHops);
    assert.equal(effective.auditFile, DEFAULT_CONFIG.auditFile);
  });
});
