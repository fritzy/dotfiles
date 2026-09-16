import { useEffect, useRef, useState } from 'react';

import {
  completeMarkdownPath, listNotesFiles, openWeeklyNote, readMarkdownFile,
} from './api.js';
import { CalendarIcon, EditorIcon, Spinner, XIcon } from './icons.jsx';
import { useTarget } from './target-context.js';
import { inputClass } from './ui.jsx';

const KIND_LABELS = { work: "Create this week's work note" };

export default function NotePicker({ open, onClose, onOpenFile, openPaths, leftOffset = '0rem' }) {
  const target = useTarget();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');
  const [markdownPath, setMarkdownPath] = useState('');
  const [pathMatches, setPathMatches] = useState([]);
  const [selectedPathMatch, setSelectedPathMatch] = useState(-1);
  const [completionStatus, setCompletionStatus] = useState('');
  const [completingPath, setCompletingPath] = useState(false);
  const pathRef = useRef(null);
  const completionRequest = useRef(0);

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setError('');
    listNotesFiles(controller.signal, target)
      .then((body) => { if (!controller.signal.aborted) setData(body); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause.message); });
    pathRef.current?.focus();
    return () => controller.abort();
  }, [open, target]);

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
      const file = await openWeeklyNote(kind, target);
      onOpenFile({ source: 'notes', path: file.path, name: file.name });
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy('');
    }
  }

  async function chooseMarkdown(event) {
    event.preventDefault();
    const requested = markdownPath.trim();
    if (!requested) {
      setError('Enter a Markdown file path.');
      pathRef.current?.focus();
      return;
    }
    setBusy('file');
    setError('');
    try {
      // Reading once validates and normalizes the server-side path. The editor
      // then owns subsequent loads, saves, and conflict handling.
      const file = await readMarkdownFile(requested, undefined, target);
      onOpenFile({ source: 'file', path: file.path, name: file.name });
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy('');
    }
  }

  function clearPathMatches() {
    completionRequest.current += 1;
    setPathMatches([]);
    setSelectedPathMatch(-1);
    setCompletionStatus('');
    setCompletingPath(false);
  }

  function usePathMatch(match) {
    setMarkdownPath(match.path);
    setPathMatches([]);
    setSelectedPathMatch(-1);
    setCompletionStatus(match.type === 'directory'
      ? 'Directory completed. Press Tab again to continue.'
      : 'File completed. Press Enter to open it.');
    requestAnimationFrame(() => pathRef.current?.focus());
  }

  async function completePath() {
    const request = completionRequest.current + 1;
    completionRequest.current = request;
    setCompletingPath(true);
    setCompletionStatus('');
    try {
      const result = await completeMarkdownPath(markdownPath, undefined, target);
      if (request !== completionRequest.current) return;
      const matches = result.matches || [];
      setMarkdownPath(result.completion);
      setSelectedPathMatch(-1);
      if (matches.length <= 1) {
        setPathMatches([]);
        setCompletionStatus(matches.length === 0
          ? 'No matching directories or Markdown files.'
          : matches[0].type === 'directory'
            ? 'Directory completed. Press Tab again to continue.'
            : 'File completed. Press Enter to open it.');
      } else {
        setPathMatches(matches);
        setCompletionStatus(`${matches.length} matches. Use ↑/↓ and Enter to choose.`);
      }
    } catch (cause) {
      if (request === completionRequest.current) setCompletionStatus(cause.message);
    } finally {
      if (request === completionRequest.current) setCompletingPath(false);
    }
  }

  function pathKeyDown(event) {
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      void completePath();
      return;
    }
    if (pathMatches.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setSelectedPathMatch((current) => {
        if (current === -1) return direction === 1 ? 0 : pathMatches.length - 1;
        return (current + direction + pathMatches.length) % pathMatches.length;
      });
      return;
    }
    if (event.key === 'Enter' && selectedPathMatch >= 0) {
      event.preventDefault();
      usePathMatch(pathMatches[selectedPathMatch]);
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
        aria-label="Open Markdown"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-primary/30 px-3 py-2">
          <h2 className="text-sm font-bold text-primary">Open Markdown</h2>
          <button type="button" aria-label="Close" title="Close" className="ml-auto flex size-6 items-center justify-center rounded text-primary transition-colors hover:bg-soft hover:text-on-soft" onClick={onClose}><XIcon className="size-3.5" /></button>
        </div>

        <form className="shrink-0 space-y-1.5 border-b border-primary/30 p-2" onSubmit={chooseMarkdown}>
          <label htmlFor="markdown-file-path" className="block text-xs font-bold text-primary">Any Markdown file</label>
          <div className="flex gap-2">
            <input
              id="markdown-file-path"
              ref={pathRef}
              type="text"
              className={inputClass}
              placeholder="/path/to/file.md or ~/file.md"
              value={markdownPath}
              aria-label="Markdown file path"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={pathMatches.length > 0}
              aria-controls="markdown-path-matches"
              aria-activedescendant={selectedPathMatch >= 0 ? `markdown-path-match-${selectedPathMatch}` : undefined}
              onChange={(event) => {
                setMarkdownPath(event.target.value);
                clearPathMatches();
              }}
              onKeyDown={pathKeyDown}
            />
            <button
              type="submit"
              className="inline-flex min-w-16 items-center justify-center gap-1.5 rounded-md border border-primary bg-accent px-3 text-xs font-bold text-on-accent transition-colors hover:bg-soft hover:text-on-soft disabled:opacity-50"
              disabled={busy === 'file'}
            >{busy === 'file' ? <Spinner className="size-3.5" /> : 'Open'}</button>
          </div>
          {pathMatches.length > 0 && (
            <ul id="markdown-path-matches" role="listbox" className="max-h-44 overflow-y-auto rounded-md border border-primary/40 bg-page p-1 shadow-lg">
              {pathMatches.map((match, index) => (
                <li key={match.path}>
                  <button
                    id={`markdown-path-match-${index}`}
                    type="button"
                    role="option"
                    aria-selected={selectedPathMatch === index}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-xs ${selectedPathMatch === index ? 'bg-soft text-on-soft' : 'text-ink hover:bg-soft hover:text-on-soft'}`}
                    onMouseEnter={() => setSelectedPathMatch(index)}
                    onClick={() => usePathMatch(match)}
                  >
                    <span className="w-3 shrink-0 text-primary" aria-hidden="true">{match.type === 'directory' ? '›' : '·'}</span>
                    <span className="min-w-0 flex-1 truncate" title={match.path}>{match.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="flex min-h-4 items-center gap-1 text-[0.68rem] text-muted" aria-live="polite">
            {completingPath && <Spinner className="size-3" />}
            {completionStatus || 'Press Tab to complete paths on the selected FritzWorks machine.'}
          </p>
        </form>

        <div className="shrink-0 px-3 pt-2 text-xs font-bold text-primary">Work notes</div>

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
                onClick={() => onOpenFile({ source: 'notes', path: file.path, name: file.name })}
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
