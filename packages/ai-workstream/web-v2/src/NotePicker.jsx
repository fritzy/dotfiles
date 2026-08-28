import { useEffect, useRef, useState } from 'react';

import { listNotesFiles, openWeeklyNote } from './api.js';
import { CalendarIcon, EditorIcon, Spinner, XIcon } from './icons.jsx';
import { inputClass } from './ui.jsx';

const KIND_LABELS = { work: "Create this week's work note" };

export default function NotePicker({ open, onClose, onOpenFile, openPaths, leftOffset = '0rem' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setError('');
    listNotesFiles(controller.signal)
      .then((body) => { if (!controller.signal.aborted) setData(body); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause.message); });
    searchRef.current?.focus();
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event) {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, open]);

  if (!open) return null;

  // Weekly notes are created (and scaffolded with the week's weekday headings) on
  // demand, so "this week" is always openable even before the file exists.
  async function chooseWeekly(kind) {
    setBusy(kind);
    setError('');
    try {
      const file = await openWeeklyNote(kind);
      onOpenFile({ path: file.path, name: file.name });
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy('');
    }
  }

  const term = query.trim().toLowerCase();
  const files = (data?.files || []).filter((file) => !term || file.path.toLowerCase().includes(term));
  // Once the week's file exists it is just another entry in the list below, so the
  // scaffold action is only offered while it is still missing.
  const missingWeekly = (data?.weekly || []).filter((entry) => !entry.exists);

  return (
    <>
      <button type="button" tabIndex={-1} aria-label="Close note picker" className="fixed inset-0 z-[55] cursor-default bg-transparent" onClick={onClose} />
      <div
        className="fixed bottom-12 z-[60] ml-2 flex max-h-[60vh] w-[min(28rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-primary bg-page text-ink shadow-2xl"
        style={{ left: leftOffset }}
        role="dialog"
        aria-label="Open a note"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-primary/30 px-3 py-2">
          <h2 className="text-sm font-bold text-primary">Open a work note</h2>
          <button type="button" aria-label="Close" title="Close" className="ml-auto flex size-6 items-center justify-center rounded text-primary transition-colors hover:bg-soft hover:text-on-soft" onClick={onClose}><XIcon className="size-3.5" /></button>
        </div>

        {missingWeekly.length > 0 && (
          <div className="shrink-0 space-y-1 border-b border-primary/30 p-2">
            {missingWeekly.map(({ kind, week }) => (
              <button
                key={kind}
                type="button"
                className="flex w-full items-center gap-2 rounded-md border border-primary bg-page px-2 py-1.5 text-left text-sm font-semibold text-primary transition-colors hover:bg-soft hover:text-on-soft disabled:opacity-50"
                disabled={busy === kind}
                onClick={() => chooseWeekly(kind)}
              >
                {busy === kind ? <Spinner className="size-4" /> : <CalendarIcon />}
                <span className="min-w-0 flex-1 truncate">{KIND_LABELS[kind]}</span>
                <span className="shrink-0 font-mono text-xs text-muted">{week}</span>
              </button>
            ))}
          </div>
        )}

        <div className="shrink-0 p-2">
          <input
            ref={searchRef}
            type="search"
            className={inputClass}
            placeholder="Filter work notes by path…"
            value={query}
            aria-label="Filter work notes by path"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {error && <p className="px-3 pb-2 text-xs font-semibold text-danger" role="alert">{error}</p>}

        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {!data && !error && <li className="flex items-center gap-2 px-2 py-3 text-sm text-primary"><Spinner className="size-4" /> Loading notes…</li>}
          {data && files.length === 0 && <li className="px-2 py-3 text-sm text-muted">No work notes matched.</li>}
          {files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-soft hover:text-on-soft ${openPaths.has(file.path) ? 'text-muted' : 'text-ink'}`}
                onClick={() => onOpenFile({ path: file.path, name: file.name })}
              >
                <EditorIcon className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>{file.path}</span>
                {openPaths.has(file.path) && <span className="shrink-0 text-[0.65rem] font-bold uppercase tracking-wide text-muted">open</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
