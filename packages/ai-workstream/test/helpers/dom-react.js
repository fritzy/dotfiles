// Minimal jsdom + React rendering harness for behavioral tests of the web-v2
// components. The rest of the suite only checks source text; the bottom-drawer
// keyboard navigation bugs this exists for (focus silently not moving) can only
// be caught by actually mounting the components and inspecting document.activeElement.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const fakeModules = new Map();
let hooksRegistered = false;

// Transforms .jsx sources with esbuild so real component files can be imported
// directly. `fakeModule` lets a test swap one URL's source (e.g. LocalTerminal,
// whose xterm/canvas use isn't meaningful under jsdom) for a lightweight stand-in.
export function registerJsxLoader() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerHooks({
    load(url, context, nextLoad) {
      const fake = fakeModules.get(url);
      if (fake !== undefined) return { format: 'module', source: fake, shortCircuit: true };
      if (!url.endsWith('.jsx')) return nextLoad(url, context);
      const source = readFileSync(fileURLToPath(url), 'utf8');
      const { code } = esbuild.transformSync(source, {
        loader: 'jsx', jsx: 'automatic', format: 'esm', sourcefile: fileURLToPath(url),
      });
      return { format: 'module', source: code, shortCircuit: true };
    },
  });
}

export function fakeModule(url, source) {
  fakeModules.set(url, source);
}

export function setupJsdom({ url = 'http://localhost/' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url, pretendToBeVisual: true });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  // App.jsx/DaemonPane reference the browser's bare `location`/`history` globals
  // (as real browsers expose them), not `window.location`/`window.history`.
  Object.defineProperty(globalThis, 'location', { value: window.location, configurable: true });
  Object.defineProperty(globalThis, 'history', { value: window.history, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  for (const key of [
    'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Element', 'Node',
    'KeyboardEvent', 'MouseEvent', 'Event', 'DOMException',
  ]) {
    globalThis[key] = window[key];
  }
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => window.clearTimeout(id);
  globalThis.localStorage = window.localStorage;
  // Collapses BottomTabs' tab-switch animation to 0ms so tests don't need to
  // wait out a real 300ms timer to observe the settled state.
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

export function teardownJsdom(dom) {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.history;
  dom.window.close();
}

export async function mountReact(element) {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await React.act(async () => { root.render(element); });
  return {
    container,
    async update(nextElement) { await React.act(async () => { root.render(nextElement); }); },
    async unmount() { await React.act(async () => { root.unmount(); }); container.remove(); },
  };
}

// Lets pending timers (BottomTabs' tab-switch animation) and effects settle,
// wrapped in act() so React doesn't warn about updates it didn't see.
export async function flush(ms = 0) {
  const React = await import('react');
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

// Runs a synchronous call (an imperative ref method, a DOM .click()) inside
// act() so the state updates it triggers are applied before this resolves.
export async function actCall(fn) {
  const React = await import('react');
  let result;
  await React.act(async () => { result = fn(); });
  return result;
}

// Dispatched through act() so the resulting state updates (and any effects
// they trigger, like a focus() call) are flushed before this returns.
export async function dispatchKey(target, key, { ctrlKey = true, shiftKey = false } = {}) {
  const React = await import('react');
  let event;
  await React.act(async () => {
    event = new window.KeyboardEvent('keydown', {
      key, ctrlKey, shiftKey, bubbles: true, cancelable: true,
    });
    target.dispatchEvent(event);
  });
  return event;
}
