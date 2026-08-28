import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  NotesFileError,
  dayHeadingLine,
  ensureDayHeading,
  listNotesFiles,
  openWeeklyNote,
  readEditorTabs,
  readNotesFile,
  resolveNotesFile,
  weekTemplate,
  weeklyNotePath,
  writeEditorTabs,
  writeNotesFile,
} from '../lib/notes-files.js';

// A Thursday, so the week's Monday is 2026-06-22.
const THURSDAY = new Date(2026, 5, 25, 9, 30);

function roots(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-workstream-notes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { notes: join(dir, 'notes'), data: join(dir, 'data'), dir };
}

test('weekly notes are keyed to the week Monday and scaffolded per weekday', (t) => {
  const { notes } = roots(t);
  const { path, iso } = weeklyNotePath(notes, 'work', THURSDAY);
  assert.equal(iso, '2026-06-22');
  assert.equal(path, join(notes, 'work', '2026', '2026-06-22-week.md'));

  const opened = openWeeklyNote(notes, 'work', { date: THURSDAY });
  assert.equal(opened.created, true);
  assert.equal(opened.path, join('work', '2026', '2026-06-22-week.md'));
  assert.equal(opened.todayHeading, '## Thursday, June 25th, 2026');
  assert.equal(opened.todayLine, 7);
  assert.match(opened.content, /^## Monday, June 22nd, 2026\n/);
  assert.match(opened.content, /## Sunday, June 28th, 2026/);

  // Reopening honors the existing file rather than rewriting it.
  writeFileSync(join(notes, 'work', '2026', '2026-06-22-week.md'), `${opened.content}- [x] shipped it\n`);
  const again = openWeeklyNote(notes, 'work', { date: THURSDAY });
  assert.equal(again.created, false);
  assert.match(again.content, /- \[x\] shipped it/);
});

test('an older compact weekly filename is reused instead of duplicated', (t) => {
  const { notes } = roots(t);
  const dir = join(notes, 'journal', '2026');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '20260622-week.md'), '## Monday, June 22nd, 2026\n');
  assert.equal(weeklyNotePath(notes, 'journal', THURSDAY).path, join(dir, '20260622-week.md'));

  const opened = openWeeklyNote(notes, 'journal', { date: THURSDAY });
  assert.equal(opened.path, join('journal', '2026', '20260622-week.md'));
  assert.equal(existsSync(join(dir, '2026-06-22-week.md')), false);
  // Today's heading is added so the day can be filled in.
  assert.match(opened.content, /## Thursday, June 25th, 2026/);
});

test('a missing weekday heading is inserted in weekday order', () => {
  const monday = new Date(2026, 5, 22);
  const partial = '## Monday, June 22nd, 2026\n\n- [x] kickoff\n\n## Friday, June 26th, 2026\n';
  const filled = ensureDayHeading(partial, THURSDAY);
  const headings = filled.split('\n').filter((line) => line.startsWith('## '));
  assert.deepEqual(headings, [
    '## Monday, June 22nd, 2026',
    '## Thursday, June 25th, 2026',
    '## Friday, June 26th, 2026',
  ]);
  assert.equal(dayHeadingLine(filled, THURSDAY), 5);
  assert.equal(ensureDayHeading(filled, THURSDAY), filled);
  // A file with no later heading gets the day appended.
  assert.match(ensureDayHeading('## Monday, June 22nd, 2026\n', THURSDAY), /Thursday, June 25th, 2026\n$/);
  assert.equal(weekTemplate(monday).split('\n\n').length, 7);
});

test('note kinds and paths outside the notes root are refused', (t) => {
  const { notes, dir } = roots(t);
  mkdirSync(join(notes, 'work'), { recursive: true });
  writeFileSync(join(dir, 'secret.md'), 'nope');
  writeFileSync(join(notes, 'work', 'ok.md'), '# ok');

  assert.equal(resolveNotesFile(notes, 'work/ok.md'), join(notes, 'work', 'ok.md'));
  assert.equal(resolveNotesFile(notes, join(notes, 'work', 'ok.md')), join(notes, 'work', 'ok.md'));
  for (const bad of ['../secret.md', '/etc/passwd', 'work/ok.txt', '', null, 'work/../../secret.md']) {
    assert.equal(resolveNotesFile(notes, bad), null, `expected ${bad} to be refused`);
  }
  symlinkSync(dir, join(notes, 'escape'));
  assert.equal(resolveNotesFile(notes, 'escape/secret.md'), null);
  assert.throws(() => weeklyNotePath(notes, 'archive'), NotesFileError);
  assert.throws(() => readNotesFile(notes, 'work/missing.md'), (error) => error.status === 404);
});

test('writes detect a file that changed on disk since it was opened', (t) => {
  const { notes } = roots(t);
  openWeeklyNote(notes, 'work', { date: THURSDAY });
  const file = readNotesFile(notes, 'work/2026/2026-06-22-week.md', { date: THURSDAY });

  const saved = writeNotesFile(notes, file.path, `${file.content}- [x] logged`, { version: file.version });
  assert.equal(saved.path, file.path);
  assert.equal(saved.version !== file.version, true);
  assert.match(readFileSync(join(notes, file.path), 'utf8'), /- \[x\] logged\n$/);

  // Versions are content-derived, so a same-millisecond edit is still caught.
  assert.throws(
    () => writeNotesFile(notes, file.path, 'stale', { version: file.version }),
    (error) => error.status === 409,
  );
  // A forced write (version omitted) still goes through, and new files are created.
  assert.equal(writeNotesFile(notes, file.path, 'forced').path, file.path);
  writeNotesFile(notes, 'work/2026/fresh.md', '# fresh');
  assert.equal(readNotesFile(notes, 'work/2026/fresh.md').content, '# fresh\n');
  assert.throws(() => writeNotesFile(notes, 'work/2026/fresh.md', 42), (error) => error.status === 400);
});

test('markdown files are listed newest first, skipping dot and vendor directories', (t) => {
  const { notes } = roots(t);
  mkdirSync(join(notes, 'work', '2026'), { recursive: true });
  mkdirSync(join(notes, '.git'), { recursive: true });
  mkdirSync(join(notes, 'work', '__pycache__'), { recursive: true });
  mkdirSync(join(notes, 'work', '2026', 'workstream', '7-example'), { recursive: true });
  mkdirSync(join(notes, 'journal', '2026'), { recursive: true });
  writeFileSync(join(notes, 'work', '2026', 'older.md'), 'a');
  writeFileSync(join(notes, 'work', '2026', 'newer.md'), 'b');
  writeFileSync(join(notes, 'work', 'notes.txt'), 'ignored');
  writeFileSync(join(notes, '.git', 'hidden.md'), 'ignored');
  writeFileSync(join(notes, 'work', '__pycache__', 'cached.md'), 'ignored');
  // Per-session `ws note` files are not what the editor is for.
  writeFileSync(join(notes, 'work', '2026', 'workstream', '7-example', 'session.md'), 'ignored');
  writeFileSync(join(notes, 'journal', '2026', 'private.md'), 'journal');

  const expected = [join('work', '2026', 'newer.md'), join('work', '2026', 'older.md')];
  const listed = listNotesFiles(notes);
  assert.deepEqual(listed.map((file) => file.path).sort(), [...expected, join('journal', '2026', 'private.md')].sort());
  assert.equal(listed.every((file) => file.mtime > 0), true);
  // The work subtree alone is what the picker asks for.
  assert.deepEqual(listNotesFiles(notes, { subtree: 'work' }).map((file) => file.path).sort(), expected);
  assert.deepEqual(listNotesFiles(notes, { subtree: 'absent' }), []);
  assert.deepEqual(listNotesFiles(join(notes, 'absent')), []);
});

test('open editor tabs round-trip through the data directory', (t) => {
  const { notes, data } = roots(t);
  mkdirSync(join(notes, 'work'), { recursive: true });
  writeFileSync(join(notes, 'work', 'one.md'), '1');
  writeFileSync(join(notes, 'work', 'two.md'), '2');

  assert.deepEqual(readEditorTabs(data), { scope: 'global', tabs: [], activePath: null });
  const written = writeEditorTabs(data, 'global', {
    tabs: [{ path: 'work/one.md' }, { path: 'work/two.md' }, { path: 'work/one.md' }],
    activePath: 'work/two.md',
  }, { root: notes });
  assert.deepEqual(written.tabs.map((tab) => tab.path), [join('work', 'one.md'), join('work', 'two.md')]);
  assert.equal(written.activePath, join('work', 'two.md'));

  const restored = readEditorTabs(data);
  assert.deepEqual(restored.tabs.map((tab) => tab.name), ['one.md', 'two.md']);
  assert.equal(restored.activePath, join('work', 'two.md'));

  // An active path that is not open is dropped rather than trusted.
  writeEditorTabs(data, 'global', { tabs: [{ path: 'work/one.md' }], activePath: 'work/two.md' }, { root: notes });
  assert.equal(readEditorTabs(data).activePath, null);
  assert.throws(() => writeEditorTabs(data, 'global', { tabs: [{ path: '../escape.md' }] }, { root: notes }), NotesFileError);
  assert.throws(() => writeEditorTabs(data, '', { tabs: [] }, { root: notes }), NotesFileError);
});
