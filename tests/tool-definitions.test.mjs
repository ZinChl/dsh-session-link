import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createToolDefinitions, createToolOptions } from '../lib/tools.js';
import { createEngine, resolveConfig } from '../lib/engine.js';
import { createLinkStore } from '../lib/store.js';
import { createHost, fakeCreateUserMessage } from './helpers/host.mjs';

/**
 * Stand-in for the host's `defineTool`, which MUTATES the options it receives:
 * `parameters` is replaced in place by the compiled JSON Schema. A plugin that
 * compiles the same option object twice therefore fails with
 * `JsonSchemaError: unsupported JSON schema: parameters.type must be a value
 * schema object` — exactly what happened in the live web profile on
 * 2026-10-12 (see CHANGELOG). These tests pin the fix.
 */
function mutatingDefineTool(options) {
  assert.equal(typeof options.name, 'string');
  if (options.__compiled === true) {
    throw new Error(`tool ${options.name} was compiled twice`);
  }
  options.__compiled = true;
  if (options.parameters.properties === undefined) {
    options.parameters = { type: 'object', properties: options.parameters };
  }
  return options;
}

function deps() {
  const host = createHost();
  const config = resolveConfig({});
  const engine = createEngine({
    ctx: host.ctx,
    store: createLinkStore(),
    audit: { path: 'memory', append: async () => {}, load: async () => [], flush: async () => {} },
    config,
    createUserMessage: fakeCreateUserMessage,
  });
  return { ctx: host.ctx, engine, config, logger: host.ctx.logger };
}

describe('tool definition compilation', () => {
  it('compiles each tool exactly once with a mutating defineTool', () => {
    const calls = [];
    const definitions = createToolDefinitions({
      ...deps(),
      defineTool: (options) => {
        calls.push(options.name);
        return mutatingDefineTool(options);
      },
    });
    assert.deepEqual(calls, ['session_list', 'session_read', 'session_send', 'session_ask', 'check_delivery']);
    assert.equal(definitions.length, 5);
    assert.deepEqual(
      definitions.map((definition) => definition.name),
      calls,
    );
  });

  it('survives repeated compilation (fresh option objects every call)', () => {
    const first = createToolDefinitions({ ...deps(), defineTool: mutatingDefineTool });
    const second = createToolDefinitions({ ...deps(), defineTool: mutatingDefineTool });
    assert.equal(first.length, 5);
    assert.equal(second.length, 5);
    // The two passes must not share state: the first pass already replaced its
    // own `parameters` objects, and those mutations must not leak into pass two.
    assert.notEqual(first[0].parameters, second[0].parameters);
  });

  it('hands out pristine specs from createToolOptions, untouched by compilation', () => {
    const options = createToolOptions(deps());
    const snapshot = JSON.stringify(options.map((entry) => entry.parameters));
    createToolDefinitions({ ...deps(), defineTool: mutatingDefineTool });
    assert.equal(JSON.stringify(options.map((entry) => entry.parameters)), snapshot);
    for (const entry of options) {
      assert.equal(entry.parameters.type, undefined, `${entry.name} parameters must stay a property map`);
      assert.equal(entry.__compiled, undefined);
    }
    // And the raw specs are what the host's validateArgs consumes.
    assert.equal(typeof options[0].parameters.query, 'object');
  });

  it('gives every option a name, description, parameters, output schema and handler', () => {
    for (const option of createToolOptions(deps())) {
      assert.equal(typeof option.name, 'string');
      assert.ok(option.description.length > 40);
      assert.equal(typeof option.parameters, 'object');
      assert.equal(typeof option.output.schema, 'object');
      assert.equal(typeof option.output.render, 'function');
      assert.equal(typeof option.execute, 'function');
    }
  });
});
