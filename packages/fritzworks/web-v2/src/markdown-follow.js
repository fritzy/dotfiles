// Source positions are one-based, matching the Markdown parser. A deletion at
// EOF points at the last surviving line; unchanged content has no target.
export function firstChangedLine(before, after) {
  if (before === after) return null;
  const previous = before.split('\n');
  const next = after.split('\n');
  let index = 0;
  while (index < previous.length && index < next.length && previous[index] === next[index]) index += 1;
  return Math.min(index + 1, next.length);
}

const BLOCKS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'pre', 'table', 'tr', 'hr']);

// Rehype plugin: preserve source ranges on rendered blocks without introducing
// wrappers that would interfere with lists, tables, or code formatting.
export function markdownSourceLines() {
  return function visit(node) {
    if (node.type === 'element' && BLOCKS.has(node.tagName) && node.position) {
      node.properties ||= {};
      node.properties['data-source-start'] = node.position.start.line;
      node.properties['data-source-end'] = node.position.end.line;
    }
    node.children?.forEach(visit);
  };
}

export function scrollToMarkdownLine(container, line) {
  let target = null;
  let bestDistance = Infinity;
  let bestSpan = Infinity;
  for (const element of container.querySelectorAll('[data-source-start]')) {
    const start = Number(element.dataset.sourceStart);
    const end = Number(element.dataset.sourceEnd);
    const distance = Math.max(start - line, line - end, 0);
    const span = end - start;
    if (distance < bestDistance || (distance === bestDistance && span < bestSpan)) {
      target = element;
      bestDistance = distance;
      bestSpan = span;
    }
  }
  if (!target) return;
  const viewport = container.getBoundingClientRect();
  const block = target.getBoundingClientRect();
  if (block.top >= viewport.top && block.bottom <= viewport.bottom) return;
  // Scroll only this preview, leaving the workspace and keyboard focus alone.
  container.scrollTop += block.top - viewport.top - 24;
}
