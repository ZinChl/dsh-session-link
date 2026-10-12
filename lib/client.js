/**
 * Browser half of dsh-session-link: the plugin's settings page.
 *
 * The sidebar's **Plugins** page renders a bundle's own configuration through
 * the keyed `plugins.bundle.config` slot (key = this package name). The page
 * reads and writes the bundle entry's Config through the harness settings
 * Remote (`ctx.remote.settings`), whose namespace is the profile entry id and
 * whose writes apply live — the Host re-activates the entry, so a new 跳数上限
 * takes effect without restarting dsh.
 *
 * House rules followed here (docs: cordis-plugin-development):
 *  - no harness Client package is imported; React comes from the module table,
 *    every control is written here, and styling uses `--dsw-alias-*` tokens;
 *  - contributions go through `ctx.slots.inject(ownerKey, () => register(...))`,
 *    so they follow the slot's late declaration and teardown;
 *  - the component renders `null` instead of throwing when the Host cannot
 *    answer, so a broken page never blanks the whole slot.
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
        subtitle: '改动立即生效（宿主会重新激活这个插件条目），不需要重启 dsh。',
        maxHops: '跳数上限',
        maxHopsHint: '一条线程 A→B→A→B… 允许的最大跳数；超过后本插件拒绝继续转发',
        rateLimitPerMinute: '限流',
        rateLimitPerMinuteHint: '每对会话每分钟最多投递几条，0 = 不限流',
        dedupeWindowMs: '去重窗口',
        dedupeWindowMsHint: '相同内容在这个窗口内不会重复投递',
        maxTextChars: '正文上限',
        maxTextCharsHint: '单条消息的字符上限',
        verifyCapability: '能力守卫',
        verifyCapabilityHint: '投递前后校验目标的 preset/模型是否漂移',
        auditFile: '审计文件',
        auditFileHint: '回执与审计的 NDJSON 路径（支持 ~）',
        save: '保存',
        saving: '保存中…',
        reset: '恢复默认',
        saved: '已保存并生效',
        overridden: '已覆盖',
        defaultLabel: '默认',
        loading: '读取配置…',
        noRemote: '这个页面前面连不上宿主设置服务（ctx.remote.settings），只能改 profile 的 cordis.patch.yml。',
        noNamespace: '宿主没有暴露 dsh-session-link 的设置项：请确认 profile 的 patch 里有 ```id: dsh-session-link``` 这一行。',
        readOnly: 'profile 当前不接受写入，请直接改 cordis.patch.yml。',
        failed: '保存失败',
        summary: '跳数上限',
      },
      en: {
        title: 'Cross-session messaging settings',
        subtitle: 'Changes apply live: the Host re-activates this plugin entry, no dsh restart needed.',
        maxHops: 'Hop budget',
        maxHopsHint: 'Maximum hops a thread (A→B→A→B…) may take before further forwarding is refused',
        rateLimitPerMinute: 'Rate limit',
        rateLimitPerMinuteHint: 'Deliveries per sender→target pair per minute; 0 disables the limiter',
        dedupeWindowMs: 'Dedupe window',
        dedupeWindowMsHint: 'Identical content is not delivered twice inside this window',
        maxTextChars: 'Message cap',
        maxTextCharsHint: 'Character cap for one delivered message',
        verifyCapability: 'Capability guard',
        verifyCapabilityHint: 'Probe the target preset/model before and after delivery',
        auditFile: 'Audit file',
        auditFileHint: 'NDJSON path for receipts and audit (supports ~)',
        save: 'Save',
        saving: 'Saving…',
        reset: 'Reset to default',
        saved: 'Saved and applied',
        overridden: 'overridden',
        defaultLabel: 'default',
        loading: 'Reading configuration…',
        noRemote: 'This page cannot reach the Host settings service (ctx.remote.settings); edit the profile cordis.patch.yml instead.',
        noNamespace: 'The Host exposes no dsh-session-link settings entry; check the profile patch row id.',
        readOnly: 'The profile does not accept writes; edit cordis.patch.yml instead.',
        failed: 'Save failed',
        summary: 'Hop budget',
      },
    };

    /** Text table for the browser language. */
    function text() {
      const lang = typeof navigator === 'object' && navigator !== null ? String(navigator.language ?? '') : '';
      return lang.toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en;
    }

    /** Token-based, theme-following styles. */
    const S = {
      wrap: { display: 'grid', gap: '14px', padding: '4px 0 8px', color: 'var(--dsw-alias-label-primary, #e6e6e6)' },
      intro: { margin: 0, fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary, #9aa0a6)' },
      row: { display: 'grid', gap: '4px' },
      label: { display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '13px', fontWeight: '600' },
      hint: { margin: 0, fontSize: '12px', lineHeight: '1.5', color: 'var(--dsw-alias-label-secondary, #9aa0a6)' },
      control: {
        width: '140px',
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

    /** Read the current value of a field from one namespace view. */
    function valueOf(view, key) {
      const resolved = view?.value;
      if (resolved !== null && typeof resolved === 'object' && key in resolved) return resolved[key];
      const base = view?.base;
      if (base !== null && typeof base === 'object' && key in base) return base[key];
      return undefined;
    }

    /** Whether the user layer overrides this field. */
    function isOverridden(view, key) {
      const user = view?.user;
      return user !== null && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, key);
    }

    /** Render the settings page (both slot views are supported). */
    function SettingsPage(props) {
      const t = text();
      const remote = props?.settingsRemote;
      const [snapshot, setSnapshot] = React.useState({ status: 'loading' });
      const [draft, setDraft] = React.useState({});
      const [message, setMessage] = React.useState(undefined);
      const [error, setError] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(async () => {
        if (remote === undefined || typeof remote.describe !== 'function') {
          setSnapshot({ status: 'unavailable', reason: t.noRemote });
          return;
        }
        try {
          const described = await remote.describe();
          if (described?.ok !== true) {
            setSnapshot({ status: 'unavailable', reason: String(described?.error?.message ?? described?.error ?? 'describe') });
            return;
          }
          const namespaces = Array.isArray(described.value?.namespaces) ? described.value.namespaces : [];
          const view = namespaces.find((entry) => entry?.ns === NS || String(entry?.ns ?? '').endsWith(`:${NS}`));
          if (view === undefined) {
            setSnapshot({ status: 'unavailable', reason: t.noNamespace });
            return;
          }
          setSnapshot({ status: 'ready', view, writable: described.value?.writable !== false });
          const next = {};
          for (const field of FIELDS) next[field.key] = valueOf(view, field.key);
          setDraft(next);
        } catch (failure) {
          setSnapshot({ status: 'unavailable', reason: String(failure?.message ?? failure) });
        }
      }, [remote, t]);

      React.useEffect(() => {
        let alive = true;
        void (async () => {
          await load();
          if (alive !== true) return;
        })();
        const off = typeof props?.onSettingsChanged === 'function' ? props.onSettingsChanged(() => void load()) : undefined;
        return () => {
          alive = false;
          if (typeof off === 'function') off();
        };
      }, [load, props]);

      if (props?.view === 'summary') {
        const view = snapshot.view;
        const hops = valueOf(view, 'maxHops');
        return h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #9aa0a6)' } },
          `${t.summary} = ${hops === undefined ? '—' : hops}`);
      }

      const buildOps = () => {
        const view = snapshot.view;
        const ops = [];
        for (const field of FIELDS) {
          const current = draft[field.key];
          const original = valueOf(view, field.key);
          if (current === original || (current === '' && original === undefined)) continue;
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

      const save = async () => {
        const ops = buildOps();
        if (ops.length === 0) {
          setMessage(t.saved);
          return;
        }
        setBusy(true);
        setError(undefined);
        try {
          const result = await remote.mutate(snapshot.view.ns, ops, snapshot.view.revision);
          if (result?.ok !== true) {
            setError(`${t.failed}: ${String(result?.error?.message ?? result?.error ?? 'refused')}`);
            await load();
          } else {
            setMessage(t.saved);
            await load();
          }
        } catch (failure) {
          setError(`${t.failed}: ${String(failure?.message ?? failure)}`);
        } finally {
          setBusy(false);
        }
      };

      const reset = async (field) => {
        setBusy(true);
        setError(undefined);
        try {
          const result = await remote.mutate(snapshot.view.ns, [{ op: 'unset', path: [field.key] }], snapshot.view.revision);
          if (result?.ok !== true) setError(`${t.failed}: ${String(result?.error?.message ?? 'refused')}`);
          else setMessage(t.saved);
          await load();
        } catch (failure) {
          setError(`${t.failed}: ${String(failure?.message ?? failure)}`);
        } finally {
          setBusy(false);
        }
      };

      if (snapshot.status === 'loading') {
        return h('div', { style: S.wrap }, h('p', { style: S.intro }, t.loading));
      }
      if (snapshot.status === 'unavailable') {
        return h('div', { style: S.wrap },
          h('p', { style: S.intro }, snapshot.reason));
      }

      const view = snapshot.view;
      const rows = FIELDS.map((field) => {
        const value = draft[field.key];
        const overridden = isOverridden(view, field.key);
        const control = field.kind === 'boolean'
          ? h('input', {
              type: 'checkbox',
              checked: value === true,
              disabled: snapshot.writable !== true || busy,
              onChange: (event) => setDraft((prev) => ({ ...prev, [field.key]: event.target.checked })),
            })
          : h('input', {
              type: field.kind === 'number' ? 'number' : 'text',
              value: value === undefined || value === null ? '' : String(value),
              min: field.min,
              max: field.max,
              step: field.step,
              disabled: snapshot.writable !== true || busy,
              style: field.kind === 'number' ? S.control : { ...S.control, ...S.wide },
              onChange: (event) => setDraft((prev) => ({ ...prev, [field.key]: event.target.value })),
            });
        const defaultText = valueOf(view, field.key) === undefined ? undefined : view?.base?.[field.key];
        return h('div', { key: field.key, style: S.row },
          h('div', { style: S.label },
            h('span', null, t[field.key] ?? field.key),
            field.unit === undefined ? null : h('span', { style: S.hint }, field.unit),
            overridden ? h('span', { style: S.badge }, t.overridden) : null,
            defaultText === undefined ? null : h('span', { style: S.hint }, `${t.defaultLabel} ${String(defaultText)}`)),
          h('div', { style: S.inline }, control,
            h('button', {
              type: 'button',
              style: S.button,
              disabled: snapshot.writable !== true || busy || overridden !== true,
              onClick: () => void reset(field),
            }, t.reset)),
          h('p', { style: S.hint }, t[`${field.key}Hint`] ?? ''));
      });

      return h('div', { style: S.wrap },
        h('div', { style: S.row }, h('span', { style: { fontSize: '14px', fontWeight: '700' } }, t.title), h('p', { style: S.intro }, t.subtitle)),
        snapshot.writable === true ? null : h('p', { style: S.error }, t.readOnly),
        ...rows,
        h('div', { style: S.inline },
          h('button', { type: 'button', style: S.primary, disabled: snapshot.writable !== true || busy, onClick: () => void save() },
            busy ? t.saving : t.save)),
        message === undefined ? null : h('p', { style: S.note }, message),
        error === undefined ? null : h('p', { style: S.error }, error),
        h('p', { style: S.hint }, `ns=${view.ns} · revision=${String(view.revision)} · applies=live`));
    }

    return {
      inject: ['remote', 'slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: NS,
          order: 10,
          // `inject` is the registration-time prop source (the third register
          // argument is not part of the contract): the Host settings Remote plus
          // a subscription hook, so a change made elsewhere refreshes this form.
          inject: () => ({
            settingsRemote: ctx.remote?.settings,
            onSettingsChanged: (listener) => ctx.remote.$on('settings/document-updated', (ns) => {
              if (ns === NS || String(ns).endsWith(`:${NS}`)) listener();
            }),
          }),
        }, SettingsPage));
      },
    };
  },
});
