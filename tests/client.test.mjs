import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Headless coverage for the browser half.
 *
 * The settings page cannot be rendered in Node for real, but its *branch logic*
 * can: a minimal React double drives `createElement`, and the plugin's own
 * `apply` is run against a stub slot registry to capture the component. That is
 * enough to pin the three data-source branches (owner form → `ctx.configForms`
 * → explanation), the summary view, and the reset/save wiring.
 */
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/**
 * Minimal React double.
 *
 * It keeps hook slots across renders and re-renders while a render-phase
 * `setState` (the "adjust state during render" pattern the component uses to
 * seed its draft) reports a change — the same convergence React performs. That
 * is what makes the rendered input values observable here.
 */
function createDouble() {
  const slots = { state: [], refs: [], effects: [], cleanups: [], cursor: 0 };
  let dirty = false;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const index = slots.cursor++;
      if (slots.state[index] === undefined) slots.state[index] = typeof initial === 'function' ? initial() : initial;
      const set = (value) => {
        const next = typeof value === 'function' ? value(slots.state[index]) : value;
        if (next !== slots.state[index]) {
          slots.state[index] = next;
          dirty = true;
        }
      };
      return [slots.state[index], set];
    },
    useRef(initial) {
      const index = slots.cursor++;
      if (slots.refs[index] === undefined) slots.refs[index] = { current: initial };
      return slots.refs[index];
    },
    useReducer(_reducer, initial) {
      const index = slots.cursor++;
      if (slots.state[index] === undefined) slots.state[index] = initial;
      return [slots.state[index], () => {}];
    },
    useEffect(fn) {
      // Run once per hook slot: enough for this page, whose effects only
      // subscribe and trigger one async `ensure()`.
      const index = slots.cursor++;
      if (slots.effects[index] === true) return;
      slots.effects[index] = true;
      const cleanup = fn();
      if (typeof cleanup === 'function') slots.cleanups.push(cleanup);
    },
    useCallback: (fn) => fn,
  };
  return {
    React,
    /** Render once, resolving render-phase updates like React does. */
    render(Page, props) {
      for (let pass = 0; pass < 10; pass += 1) {
        slots.cursor = 0;
        dirty = false;
        const tree = Page(props);
        if (dirty !== true) return tree;
      }
      throw new Error('component did not converge');
    },
  };
}

/** One shared double: the page keeps hook state across the cases below. */
const double = createDouble();

/** The page component is loaded once: a `data:` URL module evaluates once. */
let cachedPage;

/** Load the client module and capture the settings page component. */
async function loadPage() {
  if (cachedPage !== undefined) return cachedPage;
  let captured;
  globalThis.window = { __ModuleLoader__: { load: (module) => { captured = module; } } };
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const plugin = captured.factory((name) => {
    if (name === 'react') return double.React;
    throw new Error(`unexpected require(${JSON.stringify(name)}) from the client half`);
  });
  let Page;
  double.Page = undefined;
  plugin.apply({
    slots: {
      inject: (_key, factory) => factory(),
      register: (_options, component) => {
        Page = component;
      },
    },
    get: () => undefined,
    on: () => () => {},
  });
  assert.equal(typeof Page, 'function', 'the client half must register a settings component');
  cachedPage = Page;
  return Page;
}

/** Flatten every rendered text node. */
function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  if (node.props?.children !== undefined) {
    for (const child of Array.isArray(node.props.children) ? node.props.children : [node.props.children]) {
      textOf(child, out);
    }
  }
  for (const child of node.children ?? []) textOf(child, out);
  return out;
}

/** Count rendered `<input>` elements of one type. */
function inputs(node, type, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) inputs(child, type, out);
    return out;
  }
  if (node.type === 'input' && node.props?.type === type) out.push(node.props);
  for (const child of node.props?.children ?? []) inputs(child, type, out);
  for (const child of node.children ?? []) inputs(child, type, out);
  return out;
}

/** A `configForms` service stub with a ready namespace. */
function configFormsStub({ status = 'ready', value = { maxHops: 6 }, base = { maxHops: 6 }, user = {}, revision = 3, namespaces } = {}) {
  const writes = [];
  const subscribes = [];
  return {
    writes,
    subscribes,
    service: {
      describe: () => ({
        getSnapshot: () => ({
          status: status === 'loading' ? 'loading' : 'ready',
          value: { namespaces: namespaces ?? [{ ns: 'dsh-session-link' }], writable: true },
        }),
        subscribe: () => () => {},
        ensure: async () => {},
      }),
      get: () => ({
        getSnapshot: () => ({ status, value, base, user, revision, writable: true }),
        subscribe: (listener) => {
          subscribes.push(listener);
          return () => {};
        },
        mutate: async (ops, expectedRevision) => {
          writes.push({ ops, expectedRevision });
          return true;
        },
      }),
    },
  };
}

describe('client settings page', () => {
  it('renders the editable fields from ctx.configForms', async () => {
    const Page = await loadPage();
    const stub = configFormsStub();
    const rendered = double.render(Page, { view: 'page', clientContext: { get: (name) => (name === 'configForms' ? stub.service : undefined) } });
    const text = textOf(rendered).join(' | ');
    assert.match(text, /跳数上限/);
    assert.match(text, /默认 6/);
    assert.match(text, /数据源：configForms 服务/);
    const numbers = inputs(rendered, 'number');
    assert.ok(numbers.length >= 4, 'the numeric fields must render as number inputs');
    assert.equal(numbers[0].value, '6');
    assert.equal(numbers[0].min, 1);
    assert.equal(numbers[0].max, 64);
    assert.ok(stub.subscribes.length >= 1, 'the page must subscribe to the entry form');
  });

  it('prefers the owner-supplied form and marks overridden fields', async () => {
    const Page = await loadPage();
    const rendered = double.render(Page, {
      view: 'page',
      form: {
        state: { status: 'ready', value: { maxHops: 8 }, base: { maxHops: 6 }, user: { maxHops: 8 }, revision: 5, writable: true },
        mutate: async () => true,
      },
    });
    const text = textOf(rendered).join(' | ');
    assert.match(text, /已覆盖/);
    assert.match(text, /数据源：宿主表单/);
    assert.equal(inputs(rendered, 'number')[0].value, '8');
  });

  it('shows a loading line while the mirror has no answer yet', async () => {
    const Page = await loadPage();
    const text = textOf(double.render(Page, { view: 'page', clientContext: { get: () => ({ describe: () => ({ getSnapshot: () => ({ status: 'loading' }), subscribe: () => () => {}, ensure: async () => {} }), get: () => undefined }) } })).join(' | ');
    assert.match(text, /读取配置…/);
  });

  it('explains itself instead of blanking when no channel exists', async () => {
    const Page = await loadPage();
    const text = textOf(double.render(Page, { view: 'page', clientContext: { get: () => undefined } })).join(' | ');
    assert.match(text, /拿不到宿主的设置通道/);
    assert.match(text, /cordis\.patch\.yml/);
  });

  it('names the missing namespace explicitly', async () => {
    const Page = await loadPage();
    const stub = configFormsStub({ namespaces: [{ ns: 'someone-else' }] });
    const text = textOf(double.render(Page, { view: 'page', clientContext: { get: () => stub.service } })).join(' | ');
    assert.match(text, /没有暴露 dsh-session-link 的设置条目/);
  });

  it('renders the summary view as one line', async () => {
    const Page = await loadPage();
    const stub = configFormsStub({ value: { maxHops: 9 } });
    const text = textOf(double.render(Page, { view: 'summary', clientContext: { get: () => stub.service } })).join(' | ');
    assert.equal(text.trim(), '跳数上限 = 9');
  });

  it('offers a save control and only enables reset for overridden fields', async () => {
    const Page = await loadPage();
    const buttons = [];
    const walk = (node) => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.type === 'button') buttons.push(node);
      for (const child of node.props?.children ?? []) walk(child);
      for (const child of node.children ?? []) walk(child);
    };
    const clean = configFormsStub();
    walk(double.render(Page, { view: 'page', clientContext: { get: () => clean.service } }));
    const labelOf = (button) => (button.children ?? []).join('');
    const save = buttons.find((button) => labelOf(button) === '保存');
    assert.ok(save !== undefined, 'the page must render a save control');
    assert.equal(typeof save.props.onClick, 'function');
    assert.notEqual(save.props.disabled, true, 'save stays enabled while the profile is writable');
    assert.equal(buttons.filter((button) => button.props.disabled === true).length, 6, 'all six resets stay disabled until a field is overridden');

    const dirty = configFormsStub({ user: { maxHops: 9 }, value: { maxHops: 9 } });
    const overriddenButtons = [];
    const walkDirty = (node) => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walkDirty);
      if (node.type === 'button') overriddenButtons.push(node);
      for (const child of node.props?.children ?? []) walkDirty(child);
      for (const child of node.children ?? []) walkDirty(child);
    };
    walkDirty(double.render(Page, { view: 'page', clientContext: { get: () => dirty.service } }));
    const enabled = overriddenButtons.filter((button) => button.props.disabled !== true);
    assert.equal(enabled.length, 2, 'one overridden field enables exactly its own reset plus save');
    assert.ok(enabled.some((button) => labelOf(button) === '保存'), 'save stays enabled');
  });
});
