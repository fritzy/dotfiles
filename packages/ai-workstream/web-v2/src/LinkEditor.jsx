import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from 'react';

import { getLinkSuggestions } from './api.js';
import { AssetIcon, ChevronIcon, LinkIcon, XIcon } from './icons.jsx';
import { Button, inputClass } from './ui.jsx';
import { issueLink, linkFor, opticalPillPadding } from './utils.js';

const suggestionCache = new Map();

async function loadSuggestions(provider, query, signal) {
  const key = `${provider}:${query.toLowerCase()}`;
  if (!suggestionCache.has(key)) {
    const pending = getLinkSuggestions(provider, query, signal)
      .then((body) => body.items || [])
      .catch((error) => {
        suggestionCache.delete(key);
        throw error;
      });
    suggestionCache.set(key, pending);
  }
  return suggestionCache.get(key);
}

function Favicon({ src }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return <LinkIcon className="size-3.5" />;
  return (
    <span className="relative size-3.5 shrink-0">
      {!loaded && <LinkIcon className="absolute inset-0 size-3.5" />}
      <img
        className="favicon-image absolute inset-0 size-3.5 rounded-sm object-contain transition-opacity"
        data-loaded={loaded}
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </span>
  );
}

export function LinkPill({ entry, removable = false, disabled = false, onRemove }) {
  const ref = entry.ref;
  const issue = issueLink(ref);
  const href = linkFor(ref);
  const label = issue?.label || entry.label || ref;
  const iconName = issue?.icon || (entry.kind === 'github' || entry.kind === 'linear' ? entry.kind : null);
  const content = (
    <>
      {issue?.favicon
        ? <Favicon src={issue.favicon} />
        : iconName
          ? <AssetIcon name={iconName} className="size-3.5" />
          : <LinkIcon className="size-3.5" />}
      <span className="max-w-44 truncate">{label}</span>
    </>
  );
  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded-full border border-primary bg-accent pl-2.5 text-xs font-bold text-on-accent shadow-sm ${opticalPillPadding(label)} ${removable ? 'pr-1' : 'pr-2.5'}`} title={issue?.provider === 'custom' ? ref : entry.title || ref}>
      {href
        ? <a className="inline-flex min-w-0 items-center gap-1.5 hover:underline" href={href} target="_blank" rel="noreferrer" title={issue?.provider === 'custom' ? ref : undefined} onClick={(event) => event.stopPropagation()}>{content}</a>
        : <span className="inline-flex min-w-0 items-center gap-1.5">{content}</span>}
      {removable && (
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-primary hover:bg-danger hover:text-on-danger disabled:opacity-40"
          aria-label={`Remove ${label}`}
          title="Remove"
          disabled={disabled}
          onClick={() => onRemove(entry)}
        ><XIcon className="size-3" /></button>
      )}
    </span>
  );
}

const LinkInput = forwardRef(function LinkInput({ provider, label, placeholder, disabled, onCommit }, ref) {
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const wrapperRef = useRef(null);

  const search = useCallback(async (query, signal) => {
    if (!provider) return [];
    setLoading(true);
    setError('');
    try {
      const items = await loadSuggestions(provider, query, signal);
      setSuggestions(items);
      return items;
    } catch (cause) {
      if (cause.name !== 'AbortError') setError(cause.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    if (!provider || !open || selected) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => search(value.trim(), controller.signal), value.trim() ? 200 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, provider, search, selected, value]);

  useEffect(() => {
    function close(event) {
      if (!wrapperRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  const commit = useCallback(async () => {
    let item = selected;
    const typed = value.trim();
    if (!typed && !item) return true;
    if (provider && !item && !linkFor(typed)) {
      const items = await search(typed);
      item = items[0] || null;
    }
    if (provider === 'linear' && !item
      && !/^[A-Z]{2,}-\d+$/i.test(typed)
      && !/^https:\/\/linear\.app\//i.test(typed)) {
      setError('Choose a Linear suggestion or enter a Linear issue key or URL.');
      setOpen(true);
      return false;
    }
    const entry = {
      ref: item?.url || typed,
      label: item?.id || typed,
      title: item?.title || typed,
      kind: provider || 'link',
    };
    try {
      const accepted = await onCommit(entry);
      if (accepted === false) return false;
      setValue('');
      setSelected(null);
      setSuggestions([]);
      setOpen(false);
      setError('');
      return true;
    } catch (cause) {
      setError(cause.message);
      return false;
    }
  }, [onCommit, provider, search, selected, value]);

  useImperativeHandle(ref, () => ({ commit, hasValue: () => Boolean(value.trim() || selected) }), [commit, selected, value]);

  const grouped = suggestions.reduce((groups, item) => {
    const group = item.group || (provider === 'linear' ? 'Linear' : 'GitHub');
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
    return groups;
  }, new Map());

  return (
    <div className="grid gap-1.5 sm:grid-cols-[5rem_minmax(0,1fr)] sm:items-start">
      <span className="pt-2 text-sm font-semibold text-primary">{label}</span>
      <div ref={wrapperRef} className="relative grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <div className="relative">
          <input
            className={`${inputClass} ${provider ? 'pr-10' : ''}`}
            value={value}
            placeholder={placeholder}
            autoComplete="off"
            disabled={disabled}
            role={provider ? 'combobox' : undefined}
            aria-expanded={provider ? open : undefined}
            aria-autocomplete={provider ? 'list' : undefined}
            onFocus={() => { if (provider) setOpen(true); }}
            onChange={(event) => {
              setValue(event.target.value);
              setSelected(null);
              setError('');
              if (provider) setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              } else if (event.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
          {provider && (
            <button
              type="button"
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-primary hover:text-danger disabled:opacity-40"
              aria-label={`${open ? 'Hide' : 'Show'} ${label} suggestions`}
              disabled={disabled}
              onClick={() => setOpen((current) => !current)}
            ><ChevronIcon className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} /></button>
          )}
        </div>
        <Button onClick={commit} disabled={disabled}>Add</Button>
        {provider && open && (
          <div className="absolute left-0 right-[4.25rem] top-[calc(100%+.25rem)] z-30 max-h-72 overflow-y-auto rounded-lg border border-primary bg-page p-1 shadow-xl">
            {loading && <p className="px-3 py-2 text-sm text-muted">Searching…</p>}
            {!loading && error && <p className="px-3 py-2 text-sm text-danger">{error}</p>}
            {!loading && !error && suggestions.length === 0 && <p className="px-3 py-2 text-sm text-muted">No matching suggestions</p>}
            {!loading && !error && [...grouped].map(([group, items]) => (
              <div key={group}>
                <p className="px-3 pb-1 pt-2 text-xs font-bold uppercase tracking-wide text-primary">{group}</p>
                {items.map((item) => (
                  <button
                    type="button"
                    key={`${item.url}:${item.id}`}
                    className="grid w-full gap-0.5 rounded-md px-3 py-2 text-left text-sm hover:bg-accent hover:text-on-accent focus:bg-accent focus:text-on-accent focus:outline-none"
                    onClick={() => {
                      setValue(item.id);
                      setSelected(item);
                      setOpen(false);
                      setError('');
                    }}
                  >
                    <span className="truncate font-semibold">{item.id} — {item.title}</span>
                    <span className="truncate text-xs opacity-75">{[item.repository, item.meta].filter(Boolean).join(' · ')}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {!provider && error && <p className="col-span-2 text-sm text-danger">{error}</p>}
      </div>
    </div>
  );
});

const LinkEditor = forwardRef(function LinkEditor({
  entries: externalEntries = [], mode = 'staged', disabled = false, onAdd, onRemove,
}, ref) {
  const [stagedEntries, setStagedEntries] = useState([]);
  const stagedRef = useRef([]);
  const inputRefs = [useRef(null), useRef(null), useRef(null)];
  const entries = mode === 'staged' ? stagedEntries : externalEntries;

  const commitEntry = useCallback(async (entry) => {
    if (mode === 'immediate') return onAdd(entry);
    if (stagedRef.current.some((candidate) => candidate.ref === entry.ref)) return true;
    const next = [...stagedRef.current, entry];
    stagedRef.current = next;
    setStagedEntries(next);
    return true;
  }, [mode, onAdd]);

  useImperativeHandle(ref, () => ({
    async collect() {
      for (const input of inputRefs) {
        if (input.current?.hasValue() && !await input.current.commit()) return null;
      }
      return stagedRef.current.map((entry) => entry.ref);
    },
  }));

  function removeEntry(entry) {
    if (mode === 'immediate') {
      onRemove(entry);
      return;
    }
    const next = stagedRef.current.filter((candidate) => candidate.ref !== entry.ref);
    stagedRef.current = next;
    setStagedEntries(next);
  }

  return (
    <section className="grid gap-3" aria-label="Associated links">
      <h3 className="border-b-2 border-danger pb-1 text-base font-bold">Associated links</h3>
      <div className="grid gap-2">
        <LinkInput ref={inputRefs[0]} label="Link" placeholder="URL or reference" disabled={disabled} onCommit={commitEntry} />
        <LinkInput ref={inputRefs[1]} provider="linear" label="Linear" placeholder="Search the current ECO cycle" disabled={disabled} onCommit={commitEntry} />
        <LinkInput ref={inputRefs[2]} provider="github" label="GitHub" placeholder="Search escalations and PR reviews" disabled={disabled} onCommit={commitEntry} />
      </div>
      {entries.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-live="polite">
          {entries.map((entry) => (
            <LinkPill
              key={entry.ref}
              entry={entry}
              removable
              disabled={disabled}
              onRemove={removeEntry}
            />
          ))}
        </div>
      )}
      <p className="text-xs text-muted">{mode === 'immediate' ? 'Links are saved as soon as they are added or removed.' : 'Add one or more links before creating the session.'}</p>
    </section>
  );
});

export default LinkEditor;
