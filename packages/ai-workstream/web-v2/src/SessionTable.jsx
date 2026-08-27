import { useEffect, useRef } from 'react';

import { AssetIcon, CalendarIcon, MaskIcon, ProviderIcon, RefreshIcon, ShellIcon, Spinner, XIcon } from './icons.jsx';
import { LinkPill } from './LinkEditor.jsx';
import { IconButton } from './ui.jsx';
import {
  branchState, daysSince, githubBranchUrl, opticalPillPadding,
} from './utils.js';

function StatusPill({ item, pending, onCommand }) {
  const actionable = item.status === 'active' || item.status === 'paused';
  const classes = {
    active: 'border-primary bg-active text-on-active',
    paused: 'border-primary bg-paused text-on-paused',
    closed: 'border-danger bg-closed text-on-closed',
  }[item.status] || 'border-primary bg-page text-ink';
  const padding = opticalPillPadding(item.status);
  const content = pending ? <Spinner className="size-3" /> : item.status;
  if (!actionable) {
    return <span className={`inline-flex min-h-7 items-center rounded-full border px-2.5 text-xs font-bold lowercase ${padding} ${classes}`}>{content}</span>;
  }
  const command = item.status === 'active' ? 'pause' : 'resume';
  const label = item.status === 'active' ? 'Pause' : 'Open';
  return (
    <button
      type="button"
      className={`inline-flex min-h-7 items-center rounded-full border px-2.5 text-xs font-bold lowercase transition-transform hover:scale-105 disabled:opacity-50 ${padding} ${classes}`}
      aria-label={`${label} ${item.name || item.branch || item.id}`}
      title={`${label} this workstream`}
      disabled={pending}
      onClick={(event) => {
        event.stopPropagation();
        onCommand(item, command);
      }}
    >{content}</button>
  );
}

function ActivityButton({ item, panel, pending, onCommand }) {
  const isAgent = panel === 'agent';
  const working = (isAgent ? item.agentStatus : item.shellStatus) === 'working';
  const provider = item.agent === 'codex' ? 'codex' : 'claude';
  const label = isAgent ? `${provider === 'codex' ? 'Codex' : 'Claude'} agent` : 'Shell';
  const status = working ? 'working' : (isAgent ? item.agentStatus : item.shellStatus) === 'ready' ? 'waiting for input' : 'available';
  return (
    <IconButton
      compact
      label={item.status === 'active' ? `Focus ${label}, ${status}` : `${label} unavailable while session is not active`}
      title={item.status === 'active' ? `Focus ${label} terminal pane` : `${label} unavailable while session is not active`}
      disabled={item.status !== 'active' || pending}
      onClick={(event) => {
        event.stopPropagation();
        onCommand(item, `focus-${panel}`);
      }}
    >
      {working || pending
        ? <Spinner />
        : isAgent
          ? <ProviderIcon provider={provider} />
          : <ShellIcon />}
    </IconButton>
  );
}

function Branch({ item }) {
  const state = branchState(item);
  const href = githubBranchUrl(item);
  const text = item.type === 'scratchpad' ? item.name : item.branch;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <MaskIcon name={state.icon} className={`size-4 ${state.color}`} title={state.label} />
      {href
        ? <a className="truncate text-primary underline decoration-accent hover:text-danger" href={href} target="_blank" rel="noreferrer" title={`View ${item.branch} on GitHub`} onClick={(event) => event.stopPropagation()}>{text}</a>
        : <span className="truncate">{text}</span>}
    </div>
  );
}

function LastUsed({ value }) {
  const age = daysSince(value);
  if (!age) return <>—</>;
  return <span className="inline-flex items-center gap-1" title={`Last used ${age.exact}`} aria-label={`Last used ${age.days} days ago`}><CalendarIcon /><span>{age.days}d</span></span>;
}

function Actions({ item, isPending, onCommand }) {
  const name = item.name || item.branch || item.id;
  const lifecycle = item.status === 'closed' ? 'resume' : 'close';
  return (
    <div className="flex justify-end gap-1">
      <ActivityButton item={item} panel="shell" pending={isPending(`focus-shell:${item.id}`)} onCommand={onCommand} />
      <ActivityButton item={item} panel="agent" pending={isPending(`focus-agent:${item.id}`)} onCommand={onCommand} />
      <IconButton
        compact
        label={item.worktreePresent ? `Open directory for ${name}` : `Directory unavailable for ${name}`}
        title={item.worktreePresent ? 'Open directory' : 'Directory does not exist'}
        disabled={!item.worktreePresent || isPending(`open-path:${item.id}`)}
        onClick={(event) => { event.stopPropagation(); onCommand(item, 'open-path'); }}
      >{isPending(`open-path:${item.id}`) ? <Spinner /> : <AssetIcon name="folder" />}</IconButton>
      <IconButton
        compact
        label={item.notesPath ? `Open notes for ${name}` : `Notes directory unavailable for ${name}`}
        title={item.notesPath ? 'Open notes directory' : 'No notes directory'}
        disabled={!item.notesPath || isPending(`open-notes:${item.id}`)}
        onClick={(event) => { event.stopPropagation(); onCommand(item, 'open-notes'); }}
      >{isPending(`open-notes:${item.id}`) ? <Spinner /> : <AssetIcon name="notes" className="size-5" />}</IconButton>
      <IconButton
        compact
        variant={lifecycle === 'close' ? 'danger' : 'primary'}
        label={item.closeable === false ? `Close unavailable for ${name}` : `${lifecycle === 'close' ? 'Close' : 'Re-open'} ${name}`}
        title={item.closeable === false ? 'Configured locations cannot be closed' : lifecycle === 'close' ? 'Close' : 'Re-open'}
        disabled={item.closeable === false || isPending(`${lifecycle}:${item.id}`)}
        onClick={(event) => { event.stopPropagation(); onCommand(item, lifecycle); }}
      >{isPending(`${lifecycle}:${item.id}`) ? <Spinner /> : lifecycle === 'close' ? <XIcon /> : <RefreshIcon />}</IconButton>
    </div>
  );
}

export default function SessionTable({ items, highlightedId, onHighlight, onOpen, onCommand, isPending }) {
  const rows = useRef(new Map());

  useEffect(() => {
    if (highlightedId == null) return;
    rows.current.get(String(highlightedId))?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [highlightedId]);

  if (!items.length) {
    return <div className="rounded-xl border border-dashed border-primary/50 p-8 text-center text-muted">No workstreams match these filters.</div>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-primary/40 shadow-sm">
      <table className="w-full min-w-[58rem] table-auto font-mono text-base">
        <thead className="sr-only"><tr><th>Repository</th><th>Branch</th><th>Links</th><th>Status</th><th>Last used</th><th>Actions</th></tr></thead>
        <tbody className="divide-y divide-primary/25">
          {items.map((item) => {
            const highlighted = String(highlightedId) === String(item.id);
            return <tr
              key={item.id}
              ref={(node) => {
                const id = String(item.id);
                if (node) rows.current.set(id, node); else rows.current.delete(id);
              }}
              tabIndex={0}
              aria-current={highlighted ? 'true' : undefined}
              className={`cursor-pointer hover:bg-row-highlight hover:text-on-row-highlight focus:bg-row-highlight focus:text-on-row-highlight focus:outline-none ${highlighted ? 'bg-row-highlight text-on-row-highlight outline-2 -outline-offset-2 outline-accent' : 'odd:bg-page even:bg-soft/15'}`}
              aria-label={`Show details for ${item.name || item.branch || item.id}`}
              onClick={() => { onHighlight(item.id); onOpen(item.id); }}
              onFocus={() => onHighlight(item.id)}
              onKeyDown={(event) => {
                if (event.currentTarget === event.target && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  onOpen(item.id);
                }
              }}
            >
              <td className="max-w-44 px-1.5 py-1.5 text-right">{item.type === 'scratchpad' ? '' : item.repo}</td>
              <td className="max-w-60 px-1.5 py-1.5"><Branch item={item} /></td>
              <td className="max-w-80 px-1.5 py-1.5">
                {item.issues?.length
                  ? <div className="flex flex-wrap gap-1">{item.issues.map((issue) => <LinkPill key={issue.ref} entry={issue} />)}</div>
                  : <span className="text-muted">—</span>}
              </td>
              <td className="px-1.5 py-1.5"><StatusPill item={item} pending={isPending(`${item.status === 'active' ? 'pause' : 'resume'}:${item.id}`)} onCommand={onCommand} /></td>
              <td className="whitespace-nowrap px-1.5 py-1.5"><LastUsed value={item.lastJoined} /></td>
              <td className="w-44 px-1.5 py-1.5"><Actions item={item} isPending={isPending} onCommand={onCommand} /></td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}
