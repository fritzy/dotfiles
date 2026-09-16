import assert from 'node:assert/strict';
import test from 'node:test';
import { firstChangedLine, scrollToMarkdownLine } from '../web-v2/src/markdown-follow.js';
import { setupJsdom, teardownJsdom } from './helpers/dom-react.js';

test('change locations cover edits, insertions, deletions, and empty documents', () => {
  assert.equal(firstChangedLine('same', 'same'), null);
  assert.equal(firstChangedLine('one\ntwo\nthree', 'one\nchanged\nthree'), 2);
  assert.equal(firstChangedLine('one\nthree', 'one\ntwo\nthree'), 2);
  assert.equal(firstChangedLine('one\ntwo\nthree', 'one\nthree'), 2);
  assert.equal(firstChangedLine('one\ntwo', 'one'), 1);
  assert.equal(firstChangedLine('one', ''), 1);
  assert.equal(firstChangedLine('', 'one'), 1);
  assert.equal(firstChangedLine('one\ntwo\nthree', 'first\ntwo\nlast'), 1);
});

test('scrolling selects the closest narrow block and preserves visible content', (t) => {
  const dom = setupJsdom();
  t.after(() => teardownJsdom(dom));
  const container = document.createElement('div');
  container.innerHTML = '<blockquote data-source-start="1" data-source-end="10"><p data-source-start="2" data-source-end="3">First</p><p data-source-start="7" data-source-end="8">Second</p></blockquote>';
  container.getBoundingClientRect = () => ({ top: 100, bottom: 500 });
  const [quote, first, second] = container.querySelectorAll('[data-source-start]');
  quote.getBoundingClientRect = () => ({ top: 50, bottom: 800 });
  first.getBoundingClientRect = () => ({ top: 200, bottom: 250 });
  second.getBoundingClientRect = () => ({ top: 700, bottom: 750 });
  container.scrollTop = 100;
  scrollToMarkdownLine(container, 2);
  assert.equal(container.scrollTop, 100, 'visible paragraph does not move');
  scrollToMarkdownLine(container, 7);
  assert.equal(container.scrollTop, 676, 'nested paragraph wins over its enclosing block');
  quote.removeAttribute('data-source-start');
  container.scrollTop = 100;
  scrollToMarkdownLine(container, 6);
  assert.equal(container.scrollTop, 676, 'blank/deleted lines use the nearest block');
  container.replaceChildren();
  scrollToMarkdownLine(container, 1);
  assert.equal(container.scrollTop, 676, 'empty documents have no scroll target');
});
