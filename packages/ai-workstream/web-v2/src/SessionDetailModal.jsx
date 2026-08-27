import { useEffect, useMemo, useState } from 'react';

import { RefreshIcon, Spinner, XIcon } from './icons.jsx';
import LinkEditor from './LinkEditor.jsx';
import {
  AgentToggle, Button, Definition, DefinitionList, ErrorMessage, IconButton, inputClass, Modal, PanelToggles,
} from './ui.jsx';
import {
  branchState, githubBranchUrl, opticalPillPadding, stackDescription, timestamp,
} from './utils.js';
import { MaskIcon } from './icons.jsx';

function Status({ status }) {
  const classes = {
    active: 'border-primary bg-active text-on-active',
    paused: 'border-primary bg-paused text-on-paused',
    closed: 'border-danger bg-closed text-on-closed',
  }[status] || 'border-primary bg-page text-ink';
  return <span className={`inline-flex min-h-8 items-center rounded-full border px-3 text-xs font-bold lowercase ${opticalPillPadding(status)} ${classes}`}>{status}</span>;
}

export default function SessionDetailModal({ sessionId, item, loading, loadError, onClose, mutate }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    setName(item?.type === 'scratchpad' ? item.name : '');
    setError('');
  }, [item?.id, item?.name, item?.type]);

  const selectedPanels = useMemo(() => (
    ['shell', 'editor', 'agent'].filter((panel) => item?.panels?.[panel])
  ), [item?.panels]);

  async function run(command, body = {}) {
    if (!item || busy) return null;
    setBusy(true);
    setError('');
    try {
      return await mutate(item, command, body);
    } catch (cause) {
      setError(cause.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    const next = name.trim();
    if (!item || item.type !== 'scratchpad' || !next || next === item.name) {
      setName(item?.name || '');
      return;
    }
    const result = await run('rename', { name: next });
    if (!result) setName(item.name);
  }

  const title = item ? `${item.id}: ${item.name || item.branch}` : `Session ${sessionId}`;
  const branch = item ? branchState(item) : null;
  const branchHref = item ? githubBranchUrl(item) : null;
  const linksAvailable = item?.type !== 'misc';

  return (
    <Modal open onClose={onClose} busy={busy} title={title}>
      {loading && !item ? (
        <div className="flex min-h-48 items-center justify-center gap-3 text-primary"><Spinner className="size-6" /> Loading session…</div>
      ) : loadError && !item ? (
        <ErrorMessage>{loadError}</ErrorMessage>
      ) : item ? (
        <div className="grid gap-5">
          <div className="flex flex-wrap items-center gap-2 border-b-2 border-accent pb-3">
            <Status status={item.status} />
            <AgentToggle
              value={item.agent}
              disabled={busy}
              onChange={(agent) => { if (agent !== item.agent) run('agent-set', { agent }); }}
            />
            <PanelToggles
              panels={selectedPanels}
              available={Boolean(item.panels?.tabOpen)}
              disabled={busy}
              onToggle={(panel) => run('panel-toggle', { panel })}
            />
            <div className="ml-auto flex flex-wrap gap-2">
              <IconButton
                variant="danger"
                label="Close workstream"
                disabled={busy || item.closeable === false || item.status === 'closed'}
                onClick={() => run('close')}
              ><XIcon /></IconButton>
              <Button variant="soft" disabled={busy || item.status !== 'active'} onClick={() => run('pause')}>Pause</Button>
              <IconButton
                label="Open or resume workstream"
                disabled={busy || item.status === 'active'}
                onClick={() => run('resume')}
              ><RefreshIcon /></IconButton>
            </div>
          </div>

          {item.panelError && <p className="text-sm text-danger">Panel state unavailable: {item.panelError}</p>}
          {!item.panelError && !item.panels?.tabOpen && <p className="text-sm text-muted">Open or resume this workstream before changing its panels.</p>}

          <DefinitionList>
            <Definition term="Repository / Branch">
              <span className="inline-flex min-w-0 items-center gap-2 font-mono">
                {item.repoUrl
                  ? <a className="truncate text-primary underline decoration-accent hover:text-danger" href={item.repoUrl} target="_blank" rel="noreferrer">{item.repo}</a>
                  : null}
                <MaskIcon name={branch.icon} className={`size-4 ${branch.color}`} title={branch.label} />
                {branchHref
                  ? <a className="truncate text-primary underline decoration-accent hover:text-danger" href={branchHref} target="_blank" rel="noreferrer">{item.type === 'scratchpad' ? item.name : item.branch}</a>
                  : <span className="truncate">{item.type === 'scratchpad' ? item.name : item.branch}</span>}
              </span>
            </Definition>
            {item.type === 'scratchpad' && (
              <Definition term="Name">
                <input
                  className={`${inputClass} max-w-md`}
                  value={name}
                  disabled={busy}
                  autoComplete="off"
                  onChange={(event) => setName(event.target.value)}
                  onBlur={rename}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    if (event.key === 'Escape') { setName(item.name); event.currentTarget.blur(); }
                  }}
                />
              </Definition>
            )}
          </DefinitionList>

          {linksAvailable ? (
            <LinkEditor
              mode="immediate"
              entries={item.issues || []}
              disabled={busy}
              onAdd={async (entry) => Boolean(await run('issue-add', { refs: [entry.ref] }))}
              onRemove={(entry) => run('issue-remove', { ref: entry.ref })}
            />
          ) : (
            <section className="grid gap-2">
              <h3 className="border-b-2 border-danger pb-1 text-base font-bold">Associated links</h3>
              <p className="text-sm text-muted">Associated links are unavailable for configured locations.</p>
            </section>
          )}

          <DefinitionList>
            <Definition term="Path">
              <span className="inline-flex items-start gap-2 font-mono">
                <span className={`text-lg font-black ${item.worktreePresent ? 'text-success' : 'text-danger'}`} title={item.worktreePresent ? 'Directory exists' : 'Directory missing'}>{item.worktreePresent ? '✓' : '✕'}</span>
                <button className="break-all rounded bg-soft/30 px-1.5 py-0.5 text-left hover:bg-soft hover:text-on-soft disabled:opacity-50" type="button" disabled={busy} onClick={() => run('open-path')}>{item.path}</button>
              </span>
            </Definition>
            <Definition term="Created">{timestamp(item.createdAt)}</Definition>
            <Definition term="Last joined">{timestamp(item.lastJoined)}</Definition>
            <Definition term="Stack">{stackDescription(item)}</Definition>
          </DefinitionList>

          <ErrorMessage>{error || loadError}</ErrorMessage>
        </div>
      ) : null}
    </Modal>
  );
}
