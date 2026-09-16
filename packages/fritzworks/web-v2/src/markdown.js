const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s*(.*)$/;

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
