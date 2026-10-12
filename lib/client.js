/**
 * Browser half of dsh-session-link: the plugin's settings page.
 *
 * The sidebar's **Plugins** page renders a bundle's own configuration through
 * the keyed `plugins.bundle.config` slot (key = this package name). Data sources
 * are tried in order:
 *
 *  1. **`props.form`** — a Host-owned, revision-fenced form the page owner hands
 *     to an entry that exposes editable Config fields.
 *  2. **`ctx.configForms`** — the settings domain's own client service:
 *     `describe()` for the shared mirror and `get(ns)` for one entry's form
 *     (subscribe-able snapshot + revision-fenced `mutate`). This is the
 *     canonical route; it is resolved lazily with `ctx.get`, so a deployment
 *     without it still mounts the page and explains itself.
 *
 * Either way the write lands in the profile entry's user layer and applies live,
 * so a new 跳数上限 takes effect without restarting dsh.
 *
 * House rules followed here (docs: cordis-plugin-development):
 *  - no harness Client package is imported; React comes from the module table,
 *    every control is written here, and styling uses `--dsw-alias-*` tokens;
 *  - contributions go through `ctx.slots.inject(ownerKey, () => register(...))`,
 *    so they follow the slot's late declaration and teardown;
 *  - the component renders an explanation instead of throwing when neither
 *    source answers, so a broken page never blanks the whole slot.
 *
 * @module dsh-session-link/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-link',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Settings namespace = the profile entry id written by the bundle patch. */
    const NS = 'dsh-session-link';

    /** Fields the page edits. Everything else keeps its schema default. */
    const FIELDS = [
      { key: 'maxHops', kind: 'number', min: 1, max: 64, step: 1, unit: '跳' },
      { key: 'rateLimitPerMinute', kind: 'number', min: 0, max: 600, step: 1, unit: '条/分' },
      { key: 'dedupeWindowMs', kind: 'number', min: 0, max: 3600000, step: 1000, unit: '毫秒' },
      { key: 'maxTextChars', kind: 'number', min: 100, max: 100000, step: 100, unit: '字符' },
      { key: 'verifyCapability', kind: 'boolean' },
      { key: 'auditFile', kind: 'text' },
    ];

    const TEXT = {
      zh: {
        title: '跨会话通信设置',
        subtitle: '改动立即生效：保存后宿主会重新激活这个插件条目，不需要重启 dsh。',
        maxHops: '跳数上限',
        maxHopsHint: '一条线程 A→B→A→B… 允许的最大跳数；超过后本插件拒绝继续转发。默认 6。',
        rateLimitPerMinute: '限流',
        rateLimitPerMinuteHint: '每对「发送方→接收方」每分钟最多投递几条，0 = 不限流。',
        dedupeWindowMs: '去重窗口',
        dedupeWindowMsHint: '相同内容在这个窗口内不会重复投递。',
        maxTextChars: '正文上限',
        maxTextCharsHint: '单条消息的字符上限。',
        verifyCapability: '能力守卫',
        verifyCapabilityHint: '投递前后校验目标的 preset / 模型是否漂移，漂移就回滚拒绝。',
        auditFile: '审计文件',
        auditFileHint: '回执与审计的 NDJSON 路径（支持 ~）。',
        save: '保存',
        saving: '保存中…',
        reset: '恢复默认',
        saved: '已保存并生效',
        overridden: '已覆盖',
        defaultLabel: '默认',
        loading: '读取配置…',
        unavailable: '这个页面拿不到宿主的设置通道（宿主表单与 ctx.configForms 都不可用）。可以临时改 profile 的 cordis.patch.yml。',
        noNamespace:
          '宿主没暴露 dsh-session-link 的设置条目。按概率排序的三个原因：① dsh 进程启动早于插件更新（改过 lib/ 就必须重启 dsh，刷新页面不够）；② 插件 Config 没有可编辑字段（宿主只为带 meta.volatile 的字段建设置项）；③ profile 的 patch 里缺 id: dsh-session-link 或它被 disabled。',
        readOnly: 'profile 当前不接受写入，请直接改 cordis.patch.yml。',
        failed: '保存失败',
        sourceForm: '数据源：宿主表单',
        sourceConfigForms: '数据源：configForms 服务',
      },
      en: {
        title: 'Cross-session messaging settings',
        subtitle: 'Changes apply live: saving re-activates this plugin entry, no dsh restart needed.',
        maxHops: 'Hop budget',
        maxHopsHint: 'Maximum hops a thread (A→B→A→B…) may take before further forwarding is refused. Default 6.',
        rateLimitPerMinute: 'Rate limit',
        rateLimitPerMinuteHint: 'Deliveries per sender→target pair per minute; 0 disables the limiter.',
        dedupeWindowMs: 'Dedupe window',
        dedupeWindowMsHint: 'Identical content is not delivered twice inside this window.',
        maxTextChars: 'Message cap',
        maxTextCharsHint: 'Character cap for one delivered message.',
        verifyCapability: 'Capability guard',
        verifyCapabilityHint: 'Probe the target preset/model before and after delivery and refuse on drift.',
        auditFile: 'Audit file',
        auditFileHint: 'NDJSON path for receipts and audit (supports ~).',
        save: 'Save',
        saving: 'Saving…',
        reset: 'Reset to default',
        saved: 'Saved and applied',
        overridden: 'overridden',
        defaultLabel: 'default',
        loading: 'Reading configuration…',
        unavailable: 'This page has no Host settings channel: neither a host form nor ctx.configForms is available. Edit the profile cordis.patch.yml instead.',
        noNamespace:
          'The Host exposes no dsh-session-link settings entry. Most likely causes, in order: (1) the dsh process started before the plugin was updated — changing lib/ needs a dsh restart, a page refresh is not enough; (2) the Config schema declares no editable field (the Host only creates entries for fields carrying meta.volatile); (3) the profile patch is missing id: dsh-session-link or has it disabled.',
        readOnly: 'The profile does not accept writes; edit cordis.patch.yml instead.',
        failed: 'Save failed',
        sourceForm: 'source: host form',
        sourceConfigForms: 'source: configForms service',
      },
    };

    /** Text table for the browser language. */
    function text() {
      const lang = typeof navigator === 'object' && navigator !== null ? String(navigator.language ?? '') : '';
      return lang.toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en;
    }

    /** Token-based, theme-following styles. */
    const S = {
      wrap: { display: 'grid', gap: '14px', padding: '4px 0 10px', color: 'var(--dsw-alias-label-primary, #e6e6e6)' },
      intro: { margin: 0, fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary, #9aa0a6)' },
      row: { display: 'grid', gap: '4px' },
      label: { display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '13px', fontWeight: '600' },
      hint: { margin: 0, fontSize: '12px', lineHeight: '1.5', color: 'var(--dsw-alias-label-secondary, #9aa0a6)' },
      control: {
        width: '150px',
        padding: '5px 8px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
        background: 'var(--dsw-alias-bg-layer-2, #1b1b1f)',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a40)',
        borderRadius: '6px',
        outline: 'none',
      },
      wide: { width: '100%', maxWidth: '520px' },
      inline: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      badge: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '10px',
        color: 'var(--dsw-alias-brand-primary, #7aa2f7)',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a40)',
      },
      button: {
        padding: '6px 14px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
        background: 'var(--dsw-alias-bg-layer-2, #1b1b1f)',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a40)',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      primary: {
        padding: '6px 14px',
        fontSize: '13px',
        color: '#fff',
        background: 'var(--dsw-alias-brand-primary, #3b6fd4)',
        border: '1px solid var(--dsw-alias-brand-primary, #3b6fd4)',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      note: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, #4caf7d)' },
      error: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #e5534b)' },
    };

    /** Read one key from a plain object, when it is present. */
    function pick(container, key) {
      if (container === null || typeof container !== 'object') return undefined;
      return Object.prototype.hasOwnProperty.call(container, key) ? container[key] : undefined;
    }

    /**
     * Normalize either data source into the shape the form renders.
     *
     * @param {object|undefined} form - owner-supplied `ConfigPageForm`.
     * @param {object|undefined} namespace - `SettingsNamespaceView` from the Remote.
     * @returns {object|undefined} normalized source.
     */
    function normalize(form, resolved) {
      if (form !== undefined && form !== null && form.state !== undefined && typeof form.mutate === 'function') {
        const state = form.state;
        if (state.status === 'unavailable') return { status: 'unavailable', source: 'form' };
        if (state.status !== 'ready' || state.value === undefined) return { status: 'loading', source: 'form' };
        return {
          status: 'ready',
          source: 'form',
          ns: NS,
          value: state.value,
          base: state.base,
          user: state.user,
          revision: state.revision,
          writable: state.writable !== false,
          mutate: (ops, revision) => form.mutate(ops, revision),
        };
      }
      if (resolved?.source !== undefined) return resolved.source;
      if (resolved?.reason === 'loading' || resolved?.reason === undefined) return { status: 'loading', source: 'configForms' };
      return { status: 'unavailable', source: 'configForms', reason: resolved.reason };
    }

    /**
     * Resolve the entry's form from the settings domain service.
     *
     * @param {object|undefined} ctx - client plugin context.
     * @returns {{ source?: object, form?: object, face?: object, reason?: string }} resolution.
     */
    function fromConfigForms(ctx) {
      const forms = ctx?.get?.('configForms');
      if (forms === undefined || typeof forms.get !== 'function' || typeof forms.describe !== 'function') {
        return { reason: 'no-service' };
      }
      try {
        const face = forms.describe();
        const snapshot = face.getSnapshot();
        const status = snapshot?.status;
        // The mirror carries its answer on `view` (a SettingsDescribeView with
        // `namespaces`/`writable`), and `idle` means "no answer held yet" — not
        // "no namespace". Reading the wrong field is what made the live page
        // claim the entry was missing.
        if (status === 'unavailable') return { reason: 'unavailable' };
        if (status === 'idle' || status === 'loading') return { reason: 'loading', face };
        const described = snapshot?.view ?? snapshot?.value;
        const namespaces = Array.isArray(described?.namespaces) ? described.namespaces : [];
        const view = namespaces.find((entry) => entry?.ns === NS || String(entry?.ns ?? '').endsWith(`:${NS}`));
        if (view === undefined) {
          if (typeof face.ensure === 'function') void face.ensure();
          // Report what IS there: a wrong key is then one glance away instead of
          // another round trip.
          return { reason: 'no-namespace', face, available: namespaces.slice(0, 8).map((entry) => String(entry?.ns ?? '?')) };
        }
        const form = forms.get(view.ns);
        const state = form.getSnapshot();
        if (state?.status === 'unavailable') return { reason: 'unavailable', face, form };
        if (state?.status !== 'ready' || state.value === undefined) return { reason: 'loading', face, form };
        return {
          face,
          form,
          source: {
            status: 'ready',
            source: 'configForms',
            ns: view.ns,
            value: state.value,
            base: state.base,
            user: state.user,
            revision: state.revision,
            writable: state.writable !== false,
            mutate: (ops, revision) => form.mutate(ops, revision),
          },
        };
      } catch (failure) {
        return { reason: String(failure?.message ?? failure) };
      }
    }

    /** Render the settings page (both slot views are supported). */
    function SettingsPage(props) {
      const t = text();
      const ctx = props?.clientContext;
      const [, forceRender] = React.useReducer((count) => count + 1, 0);
      const [draft, setDraft] = React.useState({});
      const [message, setMessage] = React.useState(undefined);
      const [error, setError] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);

      // Subscribe to whatever can change the values: the owner-supplied form is
      // pushed through props, the settings mirror and its per-entry form are
      // observed directly, and the Host emits settings/document-updated.
      React.useEffect(() => {
        const disposers = [];
        const add = (value) => {
          if (typeof value === 'function') disposers.push(value);
        };
        const ownerForm = props?.form;
        if (ownerForm?.state !== undefined && typeof ownerForm.subscribe === 'function') add(ownerForm.subscribe(forceRender));
        const resolved = fromConfigForms(ctx);
        if (resolved.form !== undefined && typeof resolved.form.subscribe === 'function') add(resolved.form.subscribe(forceRender));
        else if (resolved.face !== undefined && typeof resolved.face.subscribe === 'function') add(resolved.face.subscribe(forceRender));
        if (resolved.face !== undefined && typeof resolved.face.ensure === 'function') void resolved.face.ensure();
        add(props?.onSettingsChanged?.(forceRender));
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* already gone */
            }
          }
        };
      }, [props, ctx]);

      const configFormsResult = fromConfigForms(ctx);
      const source = normalize(props?.form, configFormsResult);
      const remoteError = configFormsResult.reason;
      const valueOf = (key) => pick(source?.value, key) ?? pick(source?.base, key);
      const overridden = (key) => pick(source?.user, key) !== undefined;

      // Seed the draft once per revision, so an external write refreshes the
      // fields without fighting an edit in progress. This is React's
      // "adjust state during render" pattern: the ref guard makes it converge,
      // and the first paint already shows the real values (no flash of empty
      // inputs).
      const seedKey = `${source?.source ?? 'none'}:${String(source?.revision)}`;
      const lastSeed = React.useRef(undefined);
      if (source?.status === 'ready' && lastSeed.current !== seedKey) {
        lastSeed.current = seedKey;
        const fields = {};
        for (const field of FIELDS) fields[field.key] = pick(source.value, field.key) ?? pick(source.base, field.key);
        setDraft(fields);
        setMessage(undefined);
        setError(undefined);
      }

      if (props?.view === 'summary') {
        return h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #9aa0a6)' } },
          `${t.maxHops} = ${String(valueOf('maxHops') ?? '—')}`);
      }

      const buildOps = () => {
        const ops = [];
        for (const field of FIELDS) {
          const current = draft[field.key];
          const original = valueOf(field.key);
          const same = field.kind === 'number'
            ? Number(current) === Number(original)
            : current === original;
          if (same) continue;
          if (field.kind === 'number') {
            const parsed = Number(current);
            if (!Number.isFinite(parsed)) continue;
            ops.push({ op: 'set', path: [field.key], value: parsed });
          } else if (field.kind === 'boolean') {
            ops.push({ op: 'set', path: [field.key], value: current === true });
          } else if (current === '' || current === undefined) {
            ops.push({ op: 'unset', path: [field.key] });
          } else {
            ops.push({ op: 'set', path: [field.key], value: String(current) });
          }
        }
        return ops;
      };

      const write = async (ops) => {
        if (typeof source.mutate !== 'function') return { error: 'no write channel' };
        const accepted = await source.mutate(ops, source.revision);
        return accepted === true ? true : { error: { message: 'host refused the write' } };
      };

      const save = async () => {
        const ops = buildOps();
        if (ops.length === 0) {
          setMessage(t.saved);
          return;
        }
        setBusy(true);
        setError(undefined);
        try {
          const outcome = await write(ops);
          if (outcome !== true) {
            setError(`${t.failed}: ${String(outcome?.error?.message ?? outcome?.error ?? 'refused')}`);
          } else {
            setMessage(t.saved);
          }
          await load();
        } catch (failure) {
          setError(`${t.failed}: ${String(failure?.message ?? failure)}`);
        } finally {
          setBusy(false);
        }
      };

      const resetField = async (field) => {
        setBusy(true);
        setError(undefined);
        try {
          const outcome = await write([{ op: 'unset', path: [field.key] }]);
          if (outcome !== true) setError(`${t.failed}: ${String(outcome?.error?.message ?? 'refused')}`);
          else setMessage(t.saved);
          await load();
        } catch (failure) {
          setError(`${t.failed}: ${String(failure?.message ?? failure)}`);
        } finally {
          setBusy(false);
        }
      };

      const header = h('div', { style: S.row },
        h('span', { style: { fontSize: '14px', fontWeight: '700' } }, t.title),
        h('p', { style: S.intro }, source === undefined || source.status === 'loading' ? t.loading : t.subtitle));

      if (source === undefined || source.status === 'loading') {
        return h('div', { style: S.wrap }, header);
      }

      if (source.status === 'unavailable') {
        const known = configFormsResult.available ?? [];
        const reason = remoteError === 'no-namespace'
          ? `${t.noNamespace}${known.length === 0 ? '' : ` 宿主当前已注册：${known.join('、')}`}`
          : source.source === 'form'
            ? t.readOnly
            : t.unavailable;
        return h('div', { style: S.wrap }, header, h('p', { style: S.error }, reason));
      }

      const rows = FIELDS.map((field) => {
        const value = draft[field.key];
        const isOverridden = overridden(field.key);
        const base = pick(source.base, field.key);
        const control = field.kind === 'boolean'
          ? h('input', {
              type: 'checkbox',
              checked: value === true,
              disabled: source.writable !== true || busy,
              onChange: (event) => setDraft((prev) => ({ ...prev, [field.key]: event.target.checked })),
            })
          : h('input', {
              type: field.kind === 'number' ? 'number' : 'text',
              value: value === undefined || value === null ? '' : String(value),
              min: field.min,
              max: field.max,
              step: field.step,
              disabled: source.writable !== true || busy,
              style: field.kind === 'number' ? S.control : { ...S.control, ...S.wide },
              onChange: (event) => setDraft((prev) => ({ ...prev, [field.key]: event.target.value })),
            });
        return h('div', { key: field.key, style: S.row },
          h('div', { style: S.label },
            h('span', null, t[field.key] ?? field.key),
            field.unit === undefined ? null : h('span', { style: S.hint }, field.unit),
            isOverridden ? h('span', { style: S.badge }, t.overridden) : null,
            base === undefined ? null : h('span', { style: S.hint }, `${t.defaultLabel} ${String(base)}`)),
          h('div', { style: S.inline }, control,
            h('button', {
              type: 'button',
              style: S.button,
              disabled: source.writable !== true || busy || isOverridden !== true,
              onClick: () => void resetField(field),
            }, t.reset)),
          h('p', { style: S.hint }, t[`${field.key}Hint`] ?? ''));
      });

      return h('div', { style: S.wrap },
        header,
        source.writable === true ? null : h('p', { style: S.error }, t.readOnly),
        ...rows,
        h('div', { style: S.inline },
          h('button', { type: 'button', style: S.primary, disabled: source.writable !== true || busy, onClick: () => void save() },
            busy ? t.saving : t.save)),
        message === undefined ? null : h('p', { style: S.note }, message),
        error === undefined ? null : h('p', { style: S.error }, error),
        h('p', { style: S.hint },
          `${source.source === 'form' ? t.sourceForm : t.sourceConfigForms} · ns=${String(source.ns)} · revision=${String(source.revision)}`));
    }

    return {
      // Only `slots` is a hard dependency: `ctx.get('configForms')` resolves the
      // settings service lazily, so a deployment without it still renders this
      // page (with an explanation) instead of dropping the plugin entirely.
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: NS,
          order: 10,
          inject: () => ({
            clientContext: ctx,
            onSettingsChanged: (listener) => ctx.on('settings/document-updated', (ns) => {
              if (ns === NS || String(ns).endsWith(`:${NS}`)) listener();
            }),
          }),
        }, SettingsPage));
      },
    };
  },
});
