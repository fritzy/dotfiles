import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';

import { readNotesFile, writeNotesFile } from './api.js';
import {
  CalendarIcon, CollapseIcon, ExpandIcon, Spinner,
} from './icons.jsx';
import {
  appendUnderHeading, continueList, parseMarkdown, shiftIndent,
} from './markdown.js';
import { Button } from './ui.jsx';

const AUTOSAVE_MS = 1200;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;

function Spans({ spans }) {
  return spans.map((span, index) => {
    if (span.type === 'code') return <code key={index} className="rounded bg-primary/10 px-1 py-0.5 text-[0.9em]">{span.text}</code>;
    if (span.type === 'strong') return <strong key={index} className="font-bold">{span.text}</strong>;
    if (span.type === 'em') return <em key={index} className="italic">{span.text}</em>;
    if (span.type === 'image') {
      return (
        <img
          key={index}
          src={span.href}
          alt={span.text}
          title={span.text || span.href}
          loading="lazy"
          className="my-2 block max-h-96 max-w-full rounded-md border border-primary/30"
        />
      );
    }
    if (span.type === 'link') {
      return <a key={index} href={span.href} target="_blank" rel="noreferrer noopener" className="text-primary underline decoration-primary/40 underline-offset-2 hover:text-accent">{span.text}</a>;
    }
    return <span key={index}>{span.text}</span>;
  });
}

function Items({ items, ordered }) {
  const ListTag = ordered ? 'ol' : 'ul';
  return (
    <ListTag className={`ml-5 space-y-1 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-primary/60`}>
      {items.map((item, index) => (
        <li key={index} className={item.checked === null ? '' : 'list-none -ml-5'}>
          {item.checked !== null && (
            <input
              type="checkbox"
              checked={item.checked}
              readOnly
              tabIndex={-1}
              className="mr-2 align-middle accent-accent"
              aria-hidden="true"
            />
          )}
          <span className={item.checked ? 'text-muted line-through decoration-muted/60' : ''}><Spans spans={item.spans} /></span>
          {item.children.length > 0 && <Items items={item.children} ordered={item.children[0].ordered} />}
        </li>
      ))}
    </ListTag>
  );
}

const HEADING_CLASS = [
  'text-2xl font-bold', 'text-xl font-bold', 'text-lg font-bold',
  'text-base font-bold', 'text-sm font-bold', 'text-sm font-semibold uppercase tracking-wide',
];

function Blocks({ blocks }) {
  return blocks.map((block, index) => {
    if (block.type === 'heading') {
      const Tag = `h${Math.min(block.level + 1, 6)}`;
      return <Tag key={index} className={`mt-4 first:mt-0 text-primary ${HEADING_CLASS[block.level - 1]}`}><Spans spans={block.spans} /></Tag>;
    }
    if (block.type === 'list') return <Items key={index} items={block.items} ordered={block.ordered} />;
    if (block.type === 'code') return <pre key={index} className="overflow-x-auto rounded-md border border-primary/30 bg-primary/5 p-3 text-xs"><code>{block.code}</code></pre>;
    if (block.type === 'quote') return <blockquote key={index} className="space-y-2 border-l-4 border-primary/40 pl-3 text-muted"><Blocks blocks={block.blocks} /></blockquote>;
    if (block.type === 'hr') return <hr key={index} className="border-primary/30" />;
    return <p key={index}><Spans spans={block.spans} /></p>;
  });
}

export default function MarkdownEditor({
  path, name, focused, fontFamily, fontSize = 14, fullscreen = false,
  onDirtyChange, onFocusRequest, onFontSizeChange,
  onPanelNavigate, onNavigateUp, onToggleFullscreen, onToggleSidebar,
}) {
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [version, setVersion] = useState(null);
  const [todayHeading, setTodayHeading] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const textareaRef = useRef(null);
  const stateRef = useRef({ content: '', version: null });
  const dirty = content !== saved;
  const blocks = useMemo(() => (preview ? parseMarkdown(content) : []), [content, preview]);

  stateRef.current = { content, version };

  useEffect(() => { onDirtyChange?.(path, dirty); }, [dirty, onDirtyChange, path]);

  const load = useCallback(async (signal) => {
    setLoading(true);
    try {
      const file = await readNotesFile(path, signal);
      if (signal?.aborted) return;
      setContent(file.content);
      setSaved(file.content);
      setVersion(file.version);
      setTodayHeading(file.todayHeading || '');
      setError('');
      setConflict(false);
    } catch (cause) {
      if (!signal?.aborted) setError(cause.message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const save = useCallback(async ({ force = false } = {}) => {
    const { content: current, version: known } = stateRef.current;
    if (saving) return false;
    setSaving(true);
    try {
      const result = await writeNotesFile({ path, content: current, version: force ? null : known });
      setVersion(result.version);
      setSaved(current);
      setError('');
      setConflict(false);
      return true;
    } catch (cause) {
      setError(cause.message);
      if (/changed on disk/.test(cause.message)) setConflict(true);
      return false;
    } finally {
      setSaving(false);
    }
  }, [path, saving]);

  // Autosave once typing settles; explicit Ctrl/Cmd+S and blur still save eagerly.
  useEffect(() => {
    if (!dirty || loading || conflict) return undefined;
    const timer = setTimeout(() => { void save(); }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [conflict, content, dirty, loading, save]);

  // The textarea does not exist while the file is loading, so this has to run again
  // once the content lands — otherwise focus stays wherever it was (usually a
  // workspace terminal) and the note swallows none of the navigation keys.
  useEffect(() => {
    if (!focused || preview || loading) return;
    textareaRef.current?.focus();
  }, [focused, loading, preview]);

  // A dirty tab warns on unload even while it is hidden behind another tab.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function applyEdit({ value, caret, start, end }) {
    setContent(value);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.selectionStart = caret ?? start;
      textarea.selectionEnd = caret ?? end;
    });
  }

  // The same control bindings LocalTerminal exposes, so panel navigation, the
  // sidebar, and fullscreen work identically from a note.
  function navigationKey(event) {
    if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false;
    const key = event.key.toLowerCase();
    const handlers = {
      f: onToggleFullscreen,
      p: onToggleSidebar,
      k: onNavigateUp,
      h: () => onPanelNavigate?.(-1),
      l: () => onPanelNavigate?.(1),
    };
    if (key === 'j') {
      // There is nothing below the drawer; swallow it so the browser stays put.
      event.preventDefault();
      return true;
    }
    const handler = handlers[key];
    if (!handler) return false;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) handler();
    return true;
  }

  function keyDown(event) {
    const textarea = event.currentTarget;
    if (navigationKey(event)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      applyEdit(shiftIndent(textarea.value, textarea.selectionStart, textarea.selectionEnd, event.shiftKey));
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey
        && textarea.selectionStart === textarea.selectionEnd) {
      const continued = continueList(textarea.value, textarea.selectionStart);
      if (continued) {
        event.preventDefault();
        applyEdit(continued);
      }
    }
  }

  function addTodayEntry() {
    const appended = appendUnderHeading(content, todayHeading);
    if (!appended) {
      setError(`this file has no "${todayHeading}" heading`);
      return;
    }
    setPreview(false);
    applyEdit(appended);
    onFocusRequest?.();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function jumpToToday() {
    const textarea = textareaRef.current;
    if (!textarea || !todayHeading) return;
    const at = content.indexOf(todayHeading);
    if (at === -1) return;
    setPreview(false);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.selectionStart = at;
      textarea.selectionEnd = at + todayHeading.length;
      const ratio = at / Math.max(content.length, 1);
      textarea.scrollTop = ratio * textarea.scrollHeight;
    });
  }

  const status = loading ? 'loading…'
    : saving ? 'saving…'
      : conflict ? 'changed on disk'
        : dirty ? 'unsaved' : 'saved';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-primary/30 px-2 py-1.5">
        <span className="min-w-0 truncate font-mono text-xs font-bold text-primary" title={path}>{name}</span>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide ${conflict ? 'border-danger text-danger' : dirty ? 'border-soft text-primary' : 'border-primary/40 text-muted'}`}>{status}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {todayHeading && (
            <>
              <Button variant="secondary" className="min-h-7 px-2 py-1 text-xs" title={`Jump to ${todayHeading.replace(/^##\s*/, '')}`} onClick={jumpToToday}><CalendarIcon className="size-3.5" />Today</Button>
              <Button variant="secondary" className="min-h-7 px-2 py-1 text-xs" title={`Add a "- [x]" entry under ${todayHeading.replace(/^##\s*/, '')}`} onClick={addTodayEntry}>+ Entry</Button>
            </>
          )}
          <div className="inline-grid grid-cols-2 rounded-md border border-primary bg-page p-0.5" role="group" aria-label="Editor view">
            {[['Edit', false], ['Preview', true]].map(([label, value]) => (
              <button
                key={label}
                type="button"
                className={`rounded px-2 py-0.5 text-xs font-semibold transition-colors ${preview === value ? 'bg-accent text-on-accent' : 'text-primary hover:bg-soft hover:text-on-soft'}`}
                aria-pressed={preview === value}
                onClick={() => setPreview(value)}
              >{label}</button>
            ))}
          </div>
          <Button variant="secondary" className="min-h-7 px-2 py-1 text-xs" disabled={saving || loading || !dirty} onClick={() => save()}>Save</Button>
          <div className="inline-flex items-center rounded-md border border-primary bg-page" aria-label={`${name} font size`}>
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-l-md text-base font-bold text-primary transition-colors hover:bg-soft hover:text-on-soft disabled:opacity-40"
              aria-label="Decrease font size"
              title={`Decrease font size (${fontSize}px)`}
              disabled={fontSize <= MIN_FONT_SIZE}
              onClick={() => onFontSizeChange?.(-1)}
            >−</button>
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-r-md text-base font-bold text-primary transition-colors hover:bg-soft hover:text-on-soft disabled:opacity-40"
              aria-label="Increase font size"
              title={`Increase font size (${fontSize}px)`}
              disabled={fontSize >= MAX_FONT_SIZE}
              onClick={() => onFontSizeChange?.(1)}
            >+</button>
          </div>
          <button
            type="button"
            className="flex size-6 items-center justify-center rounded-md border border-primary bg-page text-primary transition-colors hover:bg-soft hover:text-on-soft"
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            title={`${fullscreen ? 'Exit fullscreen' : 'Fullscreen'} (Ctrl-F)`}
            aria-pressed={fullscreen}
            onClick={() => onToggleFullscreen?.()}
          >{fullscreen ? <CollapseIcon className="size-3.5" /> : <ExpandIcon className="size-3.5" />}</button>
        </div>
      </div>

      {error && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-danger/40 bg-danger/10 px-2 py-1.5 text-xs font-semibold text-danger" role="alert">
          <span className="min-w-0 flex-1 truncate" title={error}>{error}</span>
          {conflict && <>
            <Button variant="secondary" className="min-h-7 px-2 py-1 text-xs" onClick={() => load()}>Discard mine &amp; reload</Button>
            <Button variant="danger" className="min-h-7 px-2 py-1 text-xs" onClick={() => save({ force: true })}>Overwrite</Button>
          </>}
        </div>
      )}

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-primary"><Spinner className="size-4" /> Loading {name}…</div>
      ) : preview ? (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm text-ink" style={{ fontFamily }}>
          <Blocks blocks={blocks} />
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          className="min-h-0 flex-1 resize-none bg-page px-4 py-3 text-ink outline-none"
          style={{ fontFamily, fontSize: `${fontSize}px`, lineHeight: 1.55, tabSize: 2 }}
          spellCheck="true"
          aria-label={`${name} markdown source`}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={keyDown}
          onBlur={() => { if (dirty && !conflict) void save(); }}
        />
      )}
    </div>
  );
}
