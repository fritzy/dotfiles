// A small markdown parser for the notes editor's preview. It covers what the notes
// skill's files actually use — headings, task lists, nested bullets, links, code —
// and returns plain data so the renderer never needs innerHTML.

const INLINE_PATTERN = /(`[^`\n]+`)|(!\[[^\]\n]*\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(\[[^\]\n]*\]\([^)\s]+\))|(<https?:\/\/[^>\s]+>)|(https?:\/\/[^\s<>)\]]+)/g;

// Split a line into text / code / image / strong / em / link spans.
export function parseInline(text) {
  const spans = [];
  let index = 0;
  for (const match of String(text).matchAll(INLINE_PATTERN)) {
    if (match.index > index) spans.push({ type: 'text', text: text.slice(index, match.index) });
    const token = match[0];
    if (token.startsWith('`')) spans.push({ type: 'code', text: token.slice(1, -1) });
    else if (token.startsWith('![')) {
      // Checked before the link branch: an image match starts one character earlier,
      // so `![alt](src)` must not fall through and render as a link to the source.
      const split = token.indexOf('](');
      spans.push({ type: 'image', text: token.slice(2, split), href: token.slice(split + 2, -1) });
    } else if (token.startsWith('**') || token.startsWith('__')) spans.push({ type: 'strong', text: token.slice(2, -2) });
    else if (token.startsWith('*') || token.startsWith('_')) spans.push({ type: 'em', text: token.slice(1, -1) });
    else if (token.startsWith('[')) {
      const split = token.indexOf('](');
      spans.push({ type: 'link', text: token.slice(1, split), href: token.slice(split + 2, -1) });
    } else if (token.startsWith('<')) {
      const href = token.slice(1, -1);
      spans.push({ type: 'link', text: href, href });
    } else spans.push({ type: 'link', text: token, href: token });
    index = match.index + token.length;
  }
  if (index < text.length) spans.push({ type: 'text', text: text.slice(index) });
  return spans.length ? spans : [{ type: 'text', text: '' }];
}

const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s*(.*)$/;

function listItem(indent, marker, rest) {
  const task = TASK.exec(rest);
  return {
    depth: Math.floor(indent.replace(/\t/g, '    ').length / 2),
    ordered: !/^[-*+]$/.test(marker),
    checked: task ? task[1].toLowerCase() === 'x' : null,
    spans: parseInline(task ? task[2] : rest),
    children: [],
  };
}

// Fold a flat run of indented items into a tree of nested lists.
function nest(items) {
  const roots = [];
  const stack = [];
  for (const item of items) {
    while (stack.length && stack[stack.length - 1].depth >= item.depth) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(item);
    else roots.push(item);
    stack.push(item);
  }
  return roots;
}

export function parseMarkdown(text) {
  const lines = String(text ?? '').split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') { index += 1; continue; }

    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) { code.push(lines[index]); index += 1; }
      index += 1;
      blocks.push({ type: 'code', lang: fence[1].trim(), code: code.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, spans: parseInline(heading[2].trim()) });
      index += 1;
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', blocks: parseMarkdown(quoted.join('\n')) });
      continue;
    }

    if (BULLET.test(line)) {
      const items = [];
      let ordered = false;
      while (index < lines.length) {
        const bullet = BULLET.exec(lines[index]);
        if (!bullet) {
          // A blank line only ends the list when the next line is not a bullet.
          if (lines[index].trim() === '' && BULLET.test(lines[index + 1] || '')) { index += 1; continue; }
          break;
        }
        const item = listItem(bullet[1], bullet[2], bullet[3]);
        if (items.length === 0) ordered = item.ordered;
        items.push(item);
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items: nest(items) });
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() !== ''
        && !BULLET.test(lines[index]) && !/^(#{1,6})\s+/.test(lines[index])
        && !/^\s*>\s?/.test(lines[index]) && !/^\s*```/.test(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', spans: parseInline(paragraph.join(' ')) });
  }
  return blocks;
}

// ---------------------------------------------------------------- editing helpers

// Continue the current list when Enter is pressed: repeat the bullet (unchecking a
// task) or, on an empty item, end the list. Returns null when the line is not a
// list item and the default newline should be inserted.
export function continueList(value, caret) {
  const start = value.lastIndexOf('\n', caret - 1) + 1;
  const line = value.slice(start, caret);
  const bullet = BULLET.exec(line);
  if (!bullet) return null;
  const [, indent, marker, rest] = bullet;
  const task = TASK.exec(rest);
  const body = task ? task[2] : rest;
  if (body.trim() === '') {
    return { value: `${value.slice(0, start)}${value.slice(caret)}`, caret: start };
  }
  const next = /^\d+[.)]$/.test(marker)
    ? `${Number.parseInt(marker, 10) + 1}${marker.slice(-1)}`
    : marker;
  const prefix = `\n${indent}${next} ${task ? '[ ] ' : ''}`;
  return {
    value: `${value.slice(0, caret)}${prefix}${value.slice(caret)}`,
    caret: caret + prefix.length,
  };
}

// Indent or outdent every line the selection touches by two spaces.
export function shiftIndent(value, start, end, outdent = false) {
  const from = value.lastIndexOf('\n', start - 1) + 1;
  const to = value.indexOf('\n', end) === -1 ? value.length : value.indexOf('\n', end);
  const shifted = value.slice(from, to).split('\n').map((line) => (outdent
    ? line.replace(/^ {1,2}|^\t/, '')
    : `  ${line}`));
  const replaced = shifted.join('\n');
  const delta = replaced.length - (to - from);
  return {
    value: `${value.slice(0, from)}${replaced}${value.slice(to)}`,
    start: Math.max(from, start + (outdent ? -2 : 2)),
    end: end + delta,
  };
}

// Insert a `- [x] ` entry at the end of `heading`'s section, which is how the notes
// skill records a day's work. Returns the new text and where to put the caret.
export function appendUnderHeading(text, heading, entry = '- [x] ') {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end += 1;
  let at = end;
  while (at - 1 > start && lines[at - 1].trim() === '') at -= 1;
  lines.splice(at, 0, entry);
  const value = lines.join('\n');
  const caret = lines.slice(0, at).reduce((total, line) => total + line.length + 1, 0) + entry.length;
  return { value, caret };
}
