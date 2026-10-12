import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createAuditLog, expandHome } from '../lib/audit.js';

async function tempFile(name) {
  const dir = await mkdtemp(join(tmpdir(), 'dsl-audit-'));
  return join(dir, name);
}

describe('expandHome', () => {
  it('expands only a leading tilde', () => {
    assert.equal(expandHome('~'), homedir());
    assert.equal(expandHome('~/a/b'), join(homedir(), 'a/b'));
    assert.equal(expandHome('/abs/~/x'), '/abs/~/x');
    assert.equal(expandHome('relative/~'), 'relative/~');
  });
});

describe('audit log', () => {
  it('appends one JSON object per line and reads them back in order', async () => {
    const file = await tempFile('audit.ndjson');
    const audit = createAuditLog({ file });
    await audit.append({ kind: 'delivery', requestId: 'req_1', ts: 1 });
    await audit.append({ kind: 'status', requestId: 'req_1', status: 'claimed', ts: 2 });
    await audit.flush();
    const raw = await readFile(file, 'utf8');
    assert.equal(raw.endsWith('\n'), true);
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { kind: 'delivery', requestId: 'req_1', ts: 1 });
    const records = await audit.load();
    assert.equal(records.length, 2);
    assert.equal(records[1].status, 'claimed');
  });

  it('serializes concurrent appends so line order equals call order', async () => {
    const file = await tempFile('ordered.ndjson');
    const audit = createAuditLog({ file });
    await Promise.all(
      Array.from({ length: 50 }, (_, index) => audit.append({ kind: 'delivery', requestId: `req_${index}` })),
    );
    await audit.flush();
    const records = await audit.load();
    assert.equal(records.length, 50);
    records.forEach((record, index) => assert.equal(record.requestId, `req_${index}`));
  });

  it('returns an empty list for a missing file', async () => {
    const audit = createAuditLog({ file: await tempFile('nope.ndjson') });
    assert.deepEqual(await audit.load(), []);
  });

  it('skips a torn final line instead of throwing', async () => {
    const file = await tempFile('torn.ndjson');
    await writeFile(file, '{"kind":"delivery","requestId":"req_1"}\n{"kind":"deli', 'utf8');
    const audit = createAuditLog({ file });
    const records = await audit.load();
    assert.equal(records.length, 1);
    assert.equal(records[0].requestId, 'req_1');
  });

  it('rotates past the size budget, keeping one previous generation', async () => {
    const file = await tempFile('rotate.ndjson');
    const audit = createAuditLog({ file, maxBytes: 120 });
    for (let index = 0; index < 6; index += 1) {
      await audit.append({ kind: 'delivery', requestId: `req_${index}`, padding: 'x'.repeat(50) });
    }
    await audit.flush();
    // One rotate slot, by design: `.1` holds the most recently retired batch.
    const rotated = await readFile(`${file}.1`, 'utf8');
    assert.ok(rotated.trim().split('\n').length >= 1);
    const current = await audit.load();
    assert.ok(current.length >= 1);
    assert.equal(current[current.length - 1].requestId, 'req_5');
    assert.ok(!current.some((record) => record.requestId === 'req_0'));
  });

  it('never rejects: an unwritable path is reported through the logger', async () => {
    const warnings = [];
    const dir = await mkdtemp(join(tmpdir(), 'dsl-audit-'));
    const audit = createAuditLog({
      file: join(dir, 'as-directory', 'audit.ndjson'),
      logger: { warn: (message) => warnings.push(message), debug() {} },
    });
    // A file where a directory is expected makes appendFile fail.
    await writeFile(join(dir, 'as-directory'), 'not a directory', 'utf8');
    await audit.append({ kind: 'delivery', requestId: 'req_x' });
    await audit.flush();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /audit append failed/);
  });
});
