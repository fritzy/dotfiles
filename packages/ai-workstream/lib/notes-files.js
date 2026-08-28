// Filesystem access for the browser markdown editor. Everything here is scoped to
// the configured notes root (see [locations.notes] in config.ini) and follows the
// notes skill's layout: <root>/{work,journal}/<YYYY>/<YYYY-MM-DD>-week.md keyed to
// the week's Monday, with one "## <Weekday>, <Month> <Day><ord>, <Year>" heading
// per weekday that the day's entries accrete under.

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { dayHeading, weekMonday } from './core.js';

export const NOTE_KINDS = ['work', 'journal'];
const MAX_LISTED_FILES = 400;
const MAX_LIST_DEPTH = 5;
const MAX_NOTE_BYTES = 1024 * 1024;
const MAX_OPEN_TABS = 24;
// `workstream` holds the per-session notes `ws note` writes; those are not what the
// editor is for, so they stay out of the picker.
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '__pycache__', '.obsidian', 'workstream']);
const pad2 = (value) => String(value).padStart(2, '0');

// An opaque revision for optimistic concurrency. Content-derived rather than
// mtime-derived, because two saves inside the same millisecond share an mtime.
export const fileVersion = (content) => createHash('sha1').update(content).digest('hex').slice(0, 16);

export class NotesFileError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The realpath of the deepest existing ancestor, so a symlinked directory inside
// the notes root cannot be used to write outside of it.
function existingRealPath(path) {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  try { return realpathSync(current); } catch { return null; }
}

const contains = (root, path) => path === root || path.startsWith(root + sep);

// Resolve a client-supplied path (relative to the notes root, or absolute inside
// it) to an absolute markdown path, or null when it escapes the root.
export function resolveNotesFile(root, requested) {
  if (typeof requested !== 'string' || requested.trim() === '' || requested.includes('\0')) return null;
  const base = resolve(root);
  const target = isAbsolute(requested) ? resolve(requested) : resolve(base, requested);
  if (!contains(base, target) || !target.toLowerCase().endsWith('.md')) return null;
  const realBase = existingRealPath(base);
  const realTarget = existingRealPath(target);
  if (!realBase || !realTarget) return null;
  return contains(realBase, realTarget) ? target : null;
}

export const notesRelativePath = (root, path) => relative(resolve(root), path) || basename(path);

// The Monday-keyed weekly file for `date`, honoring an older compact
// <YYYYMMDD>-week.md name when one already exists so we never create a duplicate.
export function weeklyNotePath(root, kind, date = new Date()) {
  if (!NOTE_KINDS.includes(kind)) throw new NotesFileError(400, `note kind must be one of: ${NOTE_KINDS.join(', ')}`);
  const monday = weekMonday(date);
  const year = monday.getFullYear();
  const iso = `${year}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`;
  const dir = join(resolve(root), kind, String(year));
  const dashed = join(dir, `${iso}-week.md`);
  const compact = join(dir, `${year}${pad2(monday.getMonth() + 1)}${pad2(monday.getDate())}-week.md`);
  const path = existsSync(dashed) || !existsSync(compact) ? dashed : compact;
  return { path, dir, monday, iso };
}

// The scaffold a new weekly file starts from: one heading per weekday, in order.
export function weekTemplate(monday) {
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + index);
    return dayHeading(day);
  }).join('\n\n') + '\n';
}

// Insert `date`'s weekday heading if it is missing, keeping the file's headings in
// weekday order. Returns the (possibly unchanged) text.
export function ensureDayHeading(text, date = new Date()) {
  const heading = dayHeading(date);
  const lines = text.split('\n');
  if (lines.some((line) => line.trim() === heading)) return text;
  const monday = weekMonday(date);
  const week = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + index);
    return dayHeading(day);
  });
  const position = week.indexOf(heading);
  const later = week.slice(position + 1);
  const at = lines.findIndex((line) => later.includes(line.trim()));
  if (at === -1) {
    const trimmed = [...lines];
    while (trimmed.length && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
    return [...trimmed, ...(trimmed.length ? [''] : []), heading, ''].join('\n');
  }
  lines.splice(at, 0, heading, '');
  return lines.join('\n');
}

// 1-based line of `date`'s weekday heading, or 0 when the file has no such heading.
export function dayHeadingLine(text, date = new Date()) {
  const heading = dayHeading(date);
  return text.split('\n').findIndex((line) => line.trim() === heading) + 1;
}

function fileEntry(root, path) {
  const stats = statSync(path);
  return {
    path: notesRelativePath(root, path),
    name: basename(path),
    size: stats.size,
    mtime: Math.round(stats.mtimeMs),
  };
}

// Markdown files under the notes root (optionally confined to one subtree, e.g.
// "work"), most recently modified first.
export function listNotesFiles(root, { limit = MAX_LISTED_FILES, subtree = null } = {}) {
  const base = resolve(root);
  const start = subtree ? join(base, subtree) : base;
  if (!existsSync(start)) return [];
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_LIST_DEPTH || found.length >= limit * 4) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        try { found.push(fileEntry(base, path)); } catch { /* raced with a delete */ }
      }
    }
  };
  walk(start, 0);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

export function readNotesFile(root, requested, { date = new Date() } = {}) {
  const path = resolveNotesFile(root, requested);
  if (!path) throw new NotesFileError(400, 'path must be a markdown file inside the notes root');
  if (!existsSync(path)) throw new NotesFileError(404, `no such notes file: ${notesRelativePath(root, path)}`);
  const stats = statSync(path);
  if (!stats.isFile()) throw new NotesFileError(400, 'path is not a file');
  if (stats.size > MAX_NOTE_BYTES) throw new NotesFileError(413, 'notes file exceeds 1 MiB');
  const content = readFileSync(path, 'utf8');
  return {
    path: notesRelativePath(root, path),
    name: basename(path),
    content,
    version: fileVersion(content),
    mtime: Math.round(stats.mtimeMs),
    todayHeading: dayHeading(date),
    todayLine: dayHeadingLine(content, date),
  };
}

// Write `content`, refusing when the file changed underneath the editor since it
// was read (the client passes the version it loaded; null forces the write).
export function writeNotesFile(root, requested, content, { version = null } = {}) {
  const path = resolveNotesFile(root, requested);
  if (!path) throw new NotesFileError(400, 'path must be a markdown file inside the notes root');
  if (typeof content !== 'string') throw new NotesFileError(400, 'content must be a string');
  if (Buffer.byteLength(content) > MAX_NOTE_BYTES) throw new NotesFileError(413, 'notes file exceeds 1 MiB');
  if (existsSync(path)) {
    if (version && fileVersion(readFileSync(path, 'utf8')) !== version) {
      throw new NotesFileError(409, 'notes file changed on disk since it was opened');
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  const written = content.endsWith('\n') ? content : `${content}\n`;
  writeFileSync(path, written);
  return {
    path: notesRelativePath(root, path),
    version: fileVersion(written),
    mtime: Math.round(statSync(path).mtimeMs),
  };
}

// Open (creating and scaffolding when needed) the weekly note for `kind`, making
// sure today's weekday heading is present so the day can be filled in.
export function openWeeklyNote(root, kind, { date = new Date() } = {}) {
  const { path, dir, monday } = weeklyNotePath(root, kind, date);
  let created = false;
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, weekTemplate(monday));
    created = true;
  }
  const current = readFileSync(path, 'utf8');
  const filled = ensureDayHeading(current, date);
  if (filled !== current) writeFileSync(path, filled);
  return { ...readNotesFile(root, path, { date }), kind, created };
}

// ---------------------------------------------------------------- open tabs

// Which files the editor had open, kept server-side so the tab strip survives a
// reload or a different browser. Scoped by a caller-chosen key ("global" for the
// workspace-independent bottom drawer).
const tabStatePath = (dataDir) => join(dataDir, 'editor-tabs.json');

function readTabStore(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(tabStatePath(dataDir), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readEditorTabs(dataDir, scope = 'global') {
  const entry = readTabStore(dataDir)[scope];
  const tabs = Array.isArray(entry?.tabs) ? entry.tabs : [];
  const activePath = typeof entry?.activePath === 'string' ? entry.activePath : null;
  return {
    scope,
    tabs,
    activePath: tabs.some((tab) => tab.path === activePath) ? activePath : null,
  };
}

export function writeEditorTabs(dataDir, scope, { tabs = [], activePath = null } = {}, { root } = {}) {
  if (typeof scope !== 'string' || scope.trim() === '') throw new NotesFileError(400, 'scope must be a non-empty string');
  if (!Array.isArray(tabs)) throw new NotesFileError(400, 'tabs must be an array');
  if (tabs.length > MAX_OPEN_TABS) throw new NotesFileError(400, `at most ${MAX_OPEN_TABS} tabs can be remembered`);
  const seen = new Set();
  const cleaned = [];
  for (const tab of tabs) {
    const requested = typeof tab === 'string' ? tab : tab?.path;
    const resolved = root ? resolveNotesFile(root, requested) : requested;
    if (!resolved) throw new NotesFileError(400, `tab path is outside the notes root: ${requested}`);
    const path = root ? notesRelativePath(root, resolved) : String(requested);
    if (seen.has(path)) continue;
    seen.add(path);
    cleaned.push({ path, name: basename(path) });
  }
  const active = typeof activePath === 'string' && root ? resolveNotesFile(root, activePath) : null;
  const activeRelative = active ? notesRelativePath(root, active) : null;
  const state = {
    tabs: cleaned,
    activePath: cleaned.some((tab) => tab.path === activeRelative) ? activeRelative : null,
    updatedAt: new Date().toISOString(),
  };
  const store = readTabStore(dataDir);
  store[scope] = state;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(tabStatePath(dataDir), `${JSON.stringify(store, null, 2)}\n`);
  return { scope, ...state };
}
