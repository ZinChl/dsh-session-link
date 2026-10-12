/**
 * Overlay plugin used by `scripts/probe-settings.mjs`.
 *
 * It is dropped into a **fresh** dsh process with `dsh --patch <overlay>` and
 * asks the harness's own settings service (`ctx.settings`, the object behind
 * the Web UI's `ctx.configForms`) what it makes of this plugin's `Config`:
 *
 *   - is `dsh-session-link` a settings namespace at all (the `.volatile()` gate), and
 *   - if asked to, does a write go through and land in the profile patch?
 *
 * It never imports anything from this repository, so it answers the same
 * question a user's browser would — from the host side, without a browser.
 *
 * Environment:
 *   DSH_PROBE_OUT   - file to write the JSON report to (required).
 *   DSH_PROBE_NS    - settings namespace to look for (default dsh-session-link).
 *   DSH_PROBE_WRITE - "1" to also exercise one write + revert.
 *   DSH_PROBE_PATCH - profile patch file to quote after a write.
 *
 * @module dsh-session-link/scripts/probe-settings-plugin
 */
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = process.env.DSH_PROBE_OUT;
const NS = process.env.DSH_PROBE_NS ?? 'dsh-session-link';
const WRITE = process.env.DSH_PROBE_WRITE === '1';
const PATCH = process.env.DSH_PROBE_PATCH;

/** Persist one report (and echo a short line for humans watching the boot log). */
function report(payload) {
  const body = JSON.stringify(payload, null, 2);
  try {
    if (OUT !== undefined) writeFileSync(OUT, body);
  } catch {
    /* the caller will notice the missing file */
  }
  console.log(`PROBE ${body.slice(0, 4000)}`);
}

export const name = 'sessionlink-probe';
export const inject = ['settings'];

export const apply = (ctx) => {
  const settle = (error) => report({ phase: 'loader', error: String(error?.stack ?? error) });
  ctx.root.loader.await().then(async () => {
    const steps = [];
    try {
      const forms = ctx.get('settings');
      if (forms === undefined) {
        report({ phase: 'ready', error: 'ctx.settings is unreachable from this plugin context' });
        return;
      }
      const describe = () => forms.describe();
      const row = () => describe().find((entry) => entry.ns === NS);

      const listing = describe();
      steps.push({ step: 'namespaces', namespaces: listing.map((entry) => entry.ns) });

      const found = row();
      steps.push({
        step: 'entry',
        found: found !== undefined,
        applies: found?.applies,
        revision: found?.revision,
        editable: found === undefined ? [] : Object.keys(found.value ?? {}),
        value: found?.value,
      });

      if (found !== undefined && WRITE) {
        const before = found.value ?? {};
        const key = Object.keys(before)[0];
        const probeValue = typeof before[key] === 'number' ? before[key] + 1 : before[key];
        await forms.mutate(NS, [{ op: 'set', path: [key], value: probeValue }], found.revision);
        const written = row();
        steps.push({ step: 'write', key, wrote: written?.value?.[key], revision: written?.revision });
        steps.push({
          step: 'patch-file',
          tail: PATCH === undefined ? [] : readFileSync(PATCH, 'utf8').trim().split('\n').slice(-5),
        });

        const nonEditable = 'readDefaultLimit';
        if (!(nonEditable in before)) {
          let refused;
          try {
            await forms.mutate(NS, [{ op: 'set', path: [nonEditable], value: 1 }], row()?.revision);
          } catch (error) {
            refused = String(error?.message ?? error);
          }
          steps.push({ step: 'non-editable-write', field: nonEditable, refused });
        }

        await forms.mutate(NS, [{ op: 'set', path: [key], value: before[key] }], row()?.revision);
        steps.push({ step: 'revert', value: row()?.value?.[key] });
      }

      report({ phase: 'ready', namespace: NS, steps });
    } catch (error) {
      report({ phase: 'ready', error: String(error?.stack ?? error), steps });
    }
  }, settle);
};
