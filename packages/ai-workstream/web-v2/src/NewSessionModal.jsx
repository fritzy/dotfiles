import { useEffect, useMemo, useRef, useState } from 'react';

import { createRepoSession, createScratchpadSession, getNewSessionDefaults } from './api.js';
import { DEFAULT_WORKSPACE_ROLES } from './constants.js';
import { ChevronIcon, Spinner } from './icons.jsx';
import LinkEditor from './LinkEditor.jsx';
import {
  AgentToggle, Button, Definition, DefinitionList, ErrorMessage, Field, inputClass, Modal,
} from './ui.jsx';
import { repoSelectorPreview, scratchpadSlug } from './utils.js';

function RepoCombobox({ value, onChange, repositories, disabled }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const matches = [...new Set(repositories || [])]
    .filter((repo) => repo.toLowerCase().includes(value.trim().toLowerCase()));

  useEffect(() => {
    function close(event) {
      if (!wrapperRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  return (
    <div ref={wrapperRef} className="relative">
      <input
        className={`${inputClass} pr-10`}
        value={value}
        placeholder="owner/repository"
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        disabled={disabled}
        required
        onFocus={() => setOpen(true)}
        onChange={(event) => { onChange(event.target.value); setOpen(true); }}
        onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}
      />
      <button
        type="button"
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-primary hover:text-danger disabled:opacity-40"
        aria-label={`${open ? 'Hide' : 'Show'} recent repositories`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      ><ChevronIcon className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} /></button>
      {open && (
        <div className="absolute inset-x-0 top-[calc(100%+.25rem)] z-20 max-h-56 overflow-y-auto rounded-lg border border-primary bg-page p-1 shadow-xl">
          {matches.length ? matches.map((repo) => (
            <button
              key={repo}
              type="button"
              className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent hover:text-on-accent focus:bg-accent focus:text-on-accent focus:outline-none"
              aria-selected={repo === value.trim()}
              onClick={() => { onChange(repo); setOpen(false); }}
            >{repo}</button>
          )) : (
            <p className="px-3 py-2 text-sm text-muted">{repositories?.length ? 'No matching recent repositories' : 'No repositories used in the last three months'}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function NewSessionModal({ kind, onClose, onCreated }) {
  const repoMode = kind === 'repo';
  const [defaults, setDefaults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [agent, setAgent] = useState('claude');
  const [repository, setRepository] = useState('');
  const [selector, setSelector] = useState('');
  const [name, setName] = useState('');
  const linkEditorRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    getNewSessionDefaults(controller.signal)
      .then((body) => {
        setDefaults(body);
        setAgent(body.agent === 'codex' ? 'codex' : 'claude');
        setError('');
      })
      .catch((cause) => { if (cause.name !== 'AbortError') setError(cause.message); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [kind]);

  const repoPreview = useMemo(() => repoSelectorPreview(selector.trim()), [selector]);
  const preview = useMemo(() => {
    if (!defaults) return { source: '—', path: '—' };
    if (!repoMode) {
      const root = defaults.scratchpadRoot?.replace(/\/+$/, '');
      const leaf = scratchpadSlug(name) || '(random name)';
      return { source: 'scratch', path: root ? `${root}/${leaf}` : '—' };
    }
    const parts = repository.trim().split('/');
    const validRepo = parts.length === 2 && parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part));
    const root = defaults.repositoryRoot?.replace(/\/+$/, '');
    if (!validRepo || !selector.trim() || !root) return { source: repoPreview.source || '—', path: '—' };
    const leaf = repoPreview.branch ? repoPreview.branch.replaceAll('/', '-') : '(resolved PR branch)';
    return { source: repoPreview.source || '—', path: `${root}/${parts[0]}/${parts[1]}/${leaf}` };
  }, [defaults, name, repoMode, repoPreview, repository, selector]);

  async function submit(event) {
    event.preventDefault();
    const links = await linkEditorRef.current.collect();
    if (!links) {
      setError('Choose a suggestion or enter a valid link reference.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = repoMode
        ? await createRepoSession({ repository: repository.trim(), selector: selector.trim(), agent, panels: [...DEFAULT_WORKSPACE_ROLES], links })
        : await createScratchpadSession({ name: name.trim(), agent, panels: [...DEFAULT_WORKSPACE_ROLES], links });
      if (body.workstream?.id === undefined || body.workstream?.id === null) {
        throw new Error('The server did not return the new session.');
      }
      onCreated(body.workstream);
    } catch (cause) {
      setError(cause.message);
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} busy={busy} title={repoMode ? 'New repository session' : 'New scratchpad'}>
      {loading ? (
        <div className="flex min-h-48 items-center justify-center gap-3 text-primary"><Spinner className="size-6" /> Loading defaults…</div>
      ) : (
        <form className="relative grid gap-5" aria-busy={busy} onSubmit={submit}>
          <div className="flex flex-wrap items-center gap-2 border-b-2 border-accent pb-3">
            <AgentToggle value={agent} onChange={setAgent} disabled={busy} />
          </div>

          {repoMode ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Repository">
                <RepoCombobox value={repository} onChange={setRepository} repositories={defaults?.recentRepositories} disabled={busy} />
              </Field>
              <Field label="Branch / ref">
                <input className={inputClass} value={selector} placeholder="feature-branch, #123, or owner:branch" autoComplete="off" required disabled={busy} onChange={(event) => setSelector(event.target.value)} />
              </Field>
            </div>
          ) : (
            <Field label="Name">
              <input className={inputClass} value={name} placeholder="Optional; a random name is generated" autoComplete="off" disabled={busy} onChange={(event) => setName(event.target.value)} />
            </Field>
          )}

          <LinkEditor ref={linkEditorRef} disabled={busy} />

          <DefinitionList>
            <Definition term="Source"><span className="font-mono">{preview.source}</span></Definition>
            <Definition term="Path"><span className="font-mono">{preview.path}</span></Definition>
          </DefinitionList>

          <ErrorMessage>{error}</ErrorMessage>

          <div className="flex justify-end gap-2 border-t border-primary/25 pt-4">
            <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? <><Spinner /> Creating and opening…</> : 'Create & Open'}</Button>
          </div>

          {busy && (
            <div className="absolute -inset-5 z-40 flex items-center justify-center rounded-lg bg-ink/25 backdrop-blur-[1px]" role="status" aria-label="Creating and opening session">
              <div className="flex items-center gap-3 rounded-lg bg-page px-5 py-4 font-semibold text-primary shadow-xl"><Spinner className="size-8" /> Creating and opening…</div>
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}
