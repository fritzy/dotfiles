import {
  lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState,
} from 'react';

import {
  associateResource, changePanel, changePanelGroup, closePanel, createGroupPanel, disassociateResource,
  openPanelResource, resourcePreviewUrl, savePanelOrder, syncWorkstream,
} from './api.js';
import {
  AssetIcon, ChevronIcon, EditorIcon, LinkIcon, RefreshIcon, RobotIcon, ShellIcon, Spinner, TargetIcon, XIcon,
} from './icons.jsx';
import TerminalPanel from './TerminalPanel.jsx';
import TerminalSplitLayout, { defaultSplitBoundaries } from './TerminalSplitLayout.jsx';
import { AgentToggle, Button, ErrorMessage, Field, IconButton, inputClass, Modal } from './ui.jsx';
import { panelCapacity, panelsToMinimize } from './panel-layout.js';
import { canArchiveSession, issueLink } from './utils.js';
import { githubPullRequestUrl } from '../../lib/github-pr-url.js';

const MarkdownEditor = lazy(() => import('./MarkdownEditor.jsx'));
const PullRequestPanel = lazy(() => import('./PullRequestPanel.jsx'));

function boundariesFromPanels(panels) {
  const total = panels.reduce((sum, panel) => sum + (Number(panel.width) || 1), 0) || 1;
  let used = 0;
  return panels.slice(0, -1).map((panel) => {
    used += Number(panel.width) || 1;
    return (used / total) * 100;
  });
}

function widthsFromBoundaries(boundaries) {
  const edges = [0, ...boundaries, 100];
  return edges.slice(1).map((edge, index) => Math.max(0.01, edge - edges[index]));
}

function PanelAction({ label, title = label, onClick, children }) {
  return (
    <button
      type="button"
      className="flex size-6 items-center justify-center rounded border border-primary bg-page text-primary transition-colors hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent"
      aria-label={label}
      title={title}
      onClick={onClick}
    >{children}</button>
  );
}

function AddPanelButton({ label, disabled = false, onClick, children }) {
  return (
    <button
      type="button"
      className="inline-flex min-h-8 min-w-10 items-center justify-center gap-0.5 rounded border border-primary px-2 text-primary transition-colors hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="text-base font-bold leading-none" aria-hidden="true">+</span>
      {children}
    </button>
  );
}

function DisassociateButton({ resource, onDisassociate }) {
  if (!resource.disassociate) return null;
  return (
    <button
      type="button"
      className="flex size-6 shrink-0 items-center justify-center rounded-full text-danger hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-accent"
      aria-label={`Disassociate ${resource.label}`}
      title={`Disassociate ${resource.label}`}
      onClick={() => onDisassociate(resource)}
    ><XIcon className="size-3.5" /></button>
  );
}

function FilesDropdown({ resources, panels, onOpen, onDisassociate }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const triggerRef = useRef(null);
  const listId = useId();
  const files = resources.filter((resource) => resource.kind === 'markdown' || resource.kind === 'html');
  const panelsByResource = new Map(panels.map((panel) => [panel.resourceId, panel]));

  useEffect(() => {
    if (!open) return;
    const dismiss = (event) => {
      if (!wrapperRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  if (!files.length) return null;
  return (
    <div
      ref={wrapperRef}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex items-center gap-1.5 rounded border border-primary px-2 py-1 text-xs hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
      >
        <EditorIcon className="size-3.5" />
        Files ({files.length})
        <ChevronIcon className={`size-3.5 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul id={listId} aria-label="Associated files" className="absolute right-0 top-full z-30 mt-1 max-h-[min(24rem,60vh)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-primary bg-page p-1 shadow-xl">
          {files.map((resource) => {
            const panel = panelsByResource.get(resource.id);
            return (
              <li key={resource.id} className="flex items-center gap-1 rounded hover:bg-soft hover:text-on-soft">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-accent"
                  title={resource.value}
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                    onOpen(resource);
                  }}
                >
                  <span className="w-8 shrink-0 text-[0.65rem] text-muted">{resource.kind === 'markdown' ? 'MD' : 'HTML'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{resource.label}</span>
                    <span className="block truncate text-muted">{resource.value}</span>
                  </span>
                  {panel && <span className={`shrink-0 rounded px-1.5 py-0.5 ${panel.minimized ? 'text-muted' : 'bg-soft font-semibold text-on-soft'}`}>{panel.minimized ? 'Minimized' : 'Open'}</span>}
                </button>
                <DisassociateButton resource={resource} onDisassociate={onDisassociate} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function EditableGroupTitle({ group, onRename }) {
  const inputRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.label);

  useEffect(() => {
    if (!editing) setDraft(group.label);
  }, [editing, group.label]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  function commit() {
    const label = draft.trim();
    setEditing(false);
    if (label && label !== group.label) onRename(label);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="w-full min-w-0 rounded border border-accent bg-page px-1 py-0.5 font-mono text-sm font-bold text-primary outline-none ring-1 ring-accent"
        aria-label={`Rename ${group.label}`}
        value={draft}
        maxLength={160}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(group.label);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="block w-full min-w-0 truncate rounded px-1 py-0.5 text-left font-mono text-sm font-bold text-primary hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent"
      aria-label={`Rename ${group.label}`}
      title={`${group.label}\nClick to rename terminal group`}
      onClick={() => setEditing(true)}
    >{group.label}</button>
  );
}

function EditablePanelTitle({ panel, title, onRename }) {
  const inputRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(panel.label);

  useEffect(() => {
    if (!editing) setDraft(panel.label);
  }, [editing, panel.label]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  function commit() {
    const label = draft.trim();
    setEditing(false);
    if (label && label !== panel.label) onRename(label);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="min-w-0 flex-1 rounded border border-accent bg-page px-1 py-0.5 font-mono text-xs font-bold text-primary outline-none ring-1 ring-accent"
        aria-label={`Rename ${panel.label}`}
        value={draft}
        data-no-panel-drag
        draggable={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(panel.label);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left font-mono text-xs font-bold text-primary hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent"
      title={`${title || panel.label}\nClick to rename`}
      data-no-panel-drag
      draggable={false}
      onClick={() => setEditing(true)}
    >{panel.label}</button>
  );
}

function PanelDropIndicator({ panelId, indicator }) {
  if (indicator?.id !== panelId) return null;
  return (
    <span
      className={`pointer-events-none absolute inset-y-0 z-40 w-1 bg-accent shadow-[0_0_0_1px_var(--page)] ${indicator.side === 'after' ? 'right-0' : 'left-0'}`}
      aria-hidden="true"
    />
  );
}

function IframePanel({
  panel, panelName, resource, target, focused, onFocus, headerActions, headerProps, titleContent,
}) {
  const [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const url = resourcePreviewUrl(resource, target);
  const html = resource?.kind === 'html';
  return (
    <section
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden ring-inset ${focused ? 'ring-2 ring-accent/60' : ''}`}
      data-panel={panelName}
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
    >
      <header
        {...headerProps}
        className={`flex h-8 shrink-0 items-center gap-2 border-b border-primary/30 px-2 font-mono text-xs font-bold text-primary ${headerProps?.className || ''}`}
      >
        <LinkIcon className="size-3.5" />
        {titleContent || <span className="min-w-0 flex-1 truncate" title={resource?.value}>{panel.label}</span>}
        <a className="rounded border border-primary px-2 py-0.5 hover:bg-soft hover:text-on-soft" href={url} target="_blank" rel="noreferrer">Open externally</a>
        {html && <button type="button" className="rounded border border-primary px-2 py-0.5" onClick={() => { setLoaded(false); setReload((value) => value + 1); }}>Reload</button>}
        {headerActions}
      </header>
      <div className="relative min-h-0 flex-1 bg-page">
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted">
            {html ? 'Loading HTML preview…' : 'Loading embedded page… If the site refuses embedding, open it externally.'}
          </div>
        )}
        <iframe
          className="relative h-full w-full border-0 bg-white"
          title={panel.label}
          key={`${url}:${reload}`}
          src={url}
          onLoad={() => setLoaded(true)}
          sandbox={html ? "allow-scripts" : "allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"}
        />
      </div>
      {!html && <p className="shrink-0 border-t border-primary/30 px-2 py-1 text-[0.65rem] text-muted">
        Blank or refused? This site may prohibit embedding; use Open externally.
      </p>}
    </section>
  );
}

export default function GroupWorkspace({
  group, revision, target, session, visible = true, active = visible, focusedPanel, onPanelFocus, onRefresh,
  terminalMode, fontFamily, onToggleSidebar, onSidebarFocus,
  onAgentChange, onDetails, onArchive, onReset, onResourceDirtyChange,
}) {
  const hostRef = useRef(null);
  const autoMinimizingRef = useRef(false);
  const boundariesRef = useRef([]);
  const dirtyResourcesRef = useRef(new Set());
  const dragOrderRef = useRef(null);
  const draggingPanelRef = useRef(null);
  const dropCommittedRef = useRef(false);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [message, setMessage] = useState('');
  const [fileAssociation, setFileAssociation] = useState(null);
  const [associatingFile, setAssociatingFile] = useState(false);
  const [associationError, setAssociationError] = useState('');
  const [boundaries, setBoundaries] = useState([]);
  const [dirtyResources, setDirtyResources] = useState(() => new Set());
  const [dragOrder, setDragOrder] = useState(null);
  const [draggingPanelId, setDraggingPanelId] = useState(null);
  const [dropIndicator, setDropIndicator] = useState(null);
  const targetId = target?.id || 'local';
  const panelNameFor = (panelId) => `group-panel-${targetId}-${panelId}`;
  const orderedPanels = useMemo(() => {
    if (!dragOrder) return group.panels;
    const byId = new Map(group.panels.map((panel) => [panel.id, panel]));
    const ordered = dragOrder.map((id) => byId.get(id)).filter(Boolean);
    return ordered.length === group.panels.length ? ordered : group.panels;
  }, [dragOrder, group.panels]);
  const visiblePanels = useMemo(() => orderedPanels.filter((panel) => !panel.minimized), [orderedPanels]);
  const resourcesById = useMemo(() => new Map(group.resources.map((resource) => [resource.id, resource])), [group.resources]);
  const capacity = panelCapacity(availableWidth);

  useEffect(() => {
    const next = boundariesFromPanels(visiblePanels);
    boundariesRef.current = next;
    setBoundaries(next);
  }, [group.id, visiblePanels]);

  useEffect(() => {
    dragOrderRef.current = null;
    draggingPanelRef.current = null;
    dropCommittedRef.current = false;
    setDragOrder(null);
    setDraggingPanelId(null);
    setDropIndicator(null);
  }, [group.id]);

  useEffect(() => {
    if (!dragOrder || draggingPanelId) return;
    const persisted = group.panels.map((panel) => panel.id);
    if (persisted.length === dragOrder.length && persisted.every((id, index) => id === dragOrder[index])) {
      dragOrderRef.current = null;
      setDragOrder(null);
    }
  }, [dragOrder, draggingPanelId, group.panels]);

  useEffect(() => () => {
    for (const resourceId of dirtyResourcesRef.current) onResourceDirtyChange?.(resourceId, false);
  }, [group.id, onResourceDirtyChange]);

  useEffect(() => {
    const associated = new Set(group.resources.map((resource) => resource.id));
    const removed = [...dirtyResourcesRef.current].filter((resourceId) => !associated.has(resourceId));
    if (!removed.length) return;
    const next = new Set(dirtyResourcesRef.current);
    for (const resourceId of removed) {
      next.delete(resourceId);
      onResourceDirtyChange?.(resourceId, false);
    }
    dirtyResourcesRef.current = next;
    setDirtyResources(next);
  }, [group.resources, onResourceDirtyChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const measure = () => setAvailableWidth(host.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [group.id]);

  const refreshAfter = useCallback(async (operation) => {
    setMessage('');
    try {
      const result = await operation();
      await onRefresh?.();
      return result;
    } catch (error) {
      setMessage(error.message);
      if (/another client/i.test(error.message)) await onRefresh?.();
      return null;
    }
  }, [onRefresh]);

  useEffect(() => {
    if (availableWidth <= 0) return;
    const ids = panelsToMinimize(group.panels, availableWidth);
    if (!ids.length || autoMinimizingRef.current) return;
    autoMinimizingRef.current = true;
    setMessage('Panels were minimized to fit the available width.');
    void (async () => {
      let nextRevision = revision;
      try {
        for (const id of ids) {
          const result = await changePanel(id, { minimized: true }, nextRevision, target);
          nextRevision = result.revision;
        }
      } catch (error) {
        setMessage(error.message);
      } finally {
        autoMinimizingRef.current = false;
        await onRefresh?.();
      }
    })();
  }, [availableWidth, group.panels, onRefresh, revision, target]);

  const canOpen = useCallback(() => {
    if (visiblePanels.length < capacity) return true;
    setMessage('Minimize another panel to open this.');
    return false;
  }, [capacity, visiblePanels.length]);

  const minimize = (panel) => refreshAfter(() => changePanel(
    panel.id, { minimized: true }, revision, target,
  ));

  const rename = (panel, label) => {
    void refreshAfter(() => changePanel(panel.id, { label }, revision, target));
  };

  const renameGroup = (label) => {
    void refreshAfter(() => changePanelGroup(group.id, { label }, revision, target));
  };

  const restore = (panel) => {
    if (!canOpen()) return;
    void refreshAfter(() => changePanel(panel.id, { minimized: false }, revision, target));
  };

  const addKind = (kind) => {
    if (!canOpen()) return;
    void refreshAfter(() => createGroupPanel(group.id, kind, revision, target));
  };

  const closeTerminal = (panel) => {
    if (!window.confirm(`Close and kill ${panel.label}?`)) return;
    void refreshAfter(() => closePanel(panel.id, revision, target));
  };

  const resetTerminals = () => {
    if (!session || !onReset || !window.confirm(`Reset every terminal for ${displayName}? Running terminal and AI processes will be stopped and recreated.`)) return;
    void refreshAfter(() => onReset(session));
  };

  const archive = () => {
    if (!canArchiveSession(session) || !onArchive) return;
    void refreshAfter(() => onArchive(session));
  };

  const openResource = (resource) => {
    const existing = group.panels.find((panel) => panel.resourceId === resource.id);
    if (existing && !existing.minimized) return onPanelFocus?.(panelNameFor(existing.id));
    if (!canOpen()) return;
    void refreshAfter(() => openPanelResource(resource.id, revision, target));
  };

  const associate = (kind) => {
    if (kind === 'markdown' || kind === 'html') {
      setFileAssociation({ kind, value: '', open: false });
      setAssociationError('');
      return;
    }
    const value = window.prompt('HTTP(S) link:');
    if (!value) return;
    void refreshAfter(() => associateResource(group.id, { kind, value }, revision, target));
  };

  const submitFileAssociation = async (event) => {
    event.preventDefault();
    const value = fileAssociation.value.trim();
    if (!value || associatingFile) return;
    if (fileAssociation.open && availableWidth > 0 && visiblePanels.length >= capacity) {
      setAssociationError('Minimize another panel to open this, or uncheck Open after associating.');
      return;
    }
    setAssociatingFile(true);
    setAssociationError('');
    try {
      await associateResource(group.id, { kind: fileAssociation.kind, value, open: fileAssociation.open }, revision, target);
      await onRefresh?.();
      setFileAssociation(null);
    } catch (error) {
      setAssociationError(error.message);
    } finally {
      setAssociatingFile(false);
    }
  };

  const disassociate = (resource) => {
    const dirty = dirtyResources.has(resource.id);
    if (dirty && !window.confirm(`${resource.label} has unsaved changes. Disassociate it anyway?`)) return;
    void refreshAfter(() => disassociateResource(
      resource.id, { dirty, force: dirty }, revision, target,
    ));
  };

  const markDirty = useCallback((resourceId, dirty) => {
    if (dirtyResourcesRef.current.has(resourceId) === dirty) return;
    const next = new Set(dirtyResourcesRef.current);
    if (dirty) next.add(resourceId); else next.delete(resourceId);
    dirtyResourcesRef.current = next;
    setDirtyResources(next);
    onResourceDirtyChange?.(resourceId, dirty);
  }, [onResourceDirtyChange]);

  function navigate(index, direction) {
    const next = visiblePanels[index + direction];
    if (next) onPanelFocus?.(panelNameFor(next.id));
    else if (direction < 0) onSidebarFocus?.();
  }

  function persistBoundaries(nextBoundaries) {
    const visibleWidths = widthsFromBoundaries(nextBoundaries);
    const widthById = new Map(visiblePanels.map((panel, index) => [panel.id, visibleWidths[index]]));
    const widths = orderedPanels.map((panel) => widthById.get(panel.id) || panel.width || 1);
    void refreshAfter(() => savePanelOrder(
      group.id, orderedPanels.map((panel) => panel.id), widths, revision, target,
    ));
  }

  function changeBoundary(index, value) {
    const next = boundariesRef.current.map((boundary, currentIndex) => (
      currentIndex === index ? value : boundary
    ));
    boundariesRef.current = next;
    setBoundaries(next);
  }

  function commitBoundaries() {
    persistBoundaries(boundariesRef.current);
  }

  function resetBoundaries() {
    const next = defaultSplitBoundaries(visiblePanels.length);
    boundariesRef.current = next;
    setBoundaries(next);
    persistBoundaries(next);
  }

  function setPreviewOrder(ids) {
    dragOrderRef.current = ids;
    setDragOrder(ids);
  }

  function beginPanelDrag(event, panel) {
    const element = event.target instanceof Element ? event.target : null;
    if (element?.closest('button, input, a, select, textarea, [data-no-panel-drag]')) {
      event.preventDefault();
      return;
    }
    const ids = orderedPanels.map((item) => item.id);
    dropCommittedRef.current = false;
    setPreviewOrder(ids);
    draggingPanelRef.current = panel.id;
    setDraggingPanelId(panel.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-fritzworks-panel', panel.id);
  }

  function previewPanel(event, destinationId) {
    const sourceId = draggingPanelRef.current;
    if (!sourceId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    // Live reordering can move the dragged panel underneath the pointer. That
    // panel must remain a valid drop target or the browser cancels the drop and
    // drag-end restores the pre-drag order.
    if (sourceId === destinationId) {
      setDropIndicator(null);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const side = event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
    const current = dragOrderRef.current || orderedPanels.map((panel) => panel.id);
    const ids = current.filter((id) => id !== sourceId);
    const destinationIndex = ids.indexOf(destinationId);
    if (destinationIndex < 0) return;
    ids.splice(destinationIndex + (side === 'after' ? 1 : 0), 0, sourceId);
    if (!current.every((id, index) => id === ids[index])) setPreviewOrder(ids);
    setDropIndicator({ id: destinationId, side });
  }

  function finishPanelDrag() {
    draggingPanelRef.current = null;
    setDraggingPanelId(null);
    setDropIndicator(null);
    if (!dropCommittedRef.current) setPreviewOrder(null);
    dropCommittedRef.current = false;
  }

  function dropPanel(event, destinationId) {
    previewPanel(event, destinationId);
    event.preventDefault();
    event.stopPropagation();
    const ids = dragOrderRef.current;
    if (!draggingPanelRef.current || !ids) return;
    dropCommittedRef.current = true;
    draggingPanelRef.current = null;
    setDraggingPanelId(null);
    setDropIndicator(null);
    const persisted = group.panels.map((panel) => panel.id);
    if (persisted.every((id, index) => id === ids[index])) {
      setPreviewOrder(null);
      return;
    }
    const byId = new Map(group.panels.map((panel) => [panel.id, panel]));
    void (async () => {
      const result = await refreshAfter(() => savePanelOrder(
        group.id, ids, ids.map((id) => byId.get(id)?.width || 1), revision, target,
      ));
      if (!result) setPreviewOrder(null);
    })();
  }

  function panelHeaderProps(panel) {
    return {
      draggable: true,
      className: `select-none cursor-grab active:cursor-grabbing ${draggingPanelId === panel.id ? 'opacity-60' : ''}`,
      title: `Drag ${panel.label} to reorder`,
      onDragStart: (event) => beginPanelDrag(event, panel),
      onDragEnd: finishPanelDrag,
    };
  }

  const displayName = session?.name || session?.branch || group.label;
  const aiExists = group.panels.some((panel) => panel.kind === 'ai');

  return (
    <main
      className={`${visible ? 'flex' : 'hidden'} absolute inset-0 h-screen min-h-0 min-w-0 flex-col overflow-hidden bg-page`}
      aria-label={`${displayName} panel workspace`}
      aria-hidden={!visible}
      inert={!visible}
      data-panel-group={group.id}
    >
      <header className="relative z-20 flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-primary/40 px-3 py-1.5">
        <TargetIcon target={target} className="size-5" />
        <div className="min-w-24 flex-1">
          {group.type === 'terminal'
            ? <EditableGroupTitle group={group} onRename={renameGroup} />
            : <h2 className="truncate font-mono text-sm font-bold text-primary">{displayName}</h2>}
          {group.path && <p className="truncate font-mono text-xs text-muted" title={group.path}>{group.path}</p>}
        </div>
        <div className="flex max-w-[55%] flex-wrap items-center justify-end gap-1" aria-label="Panel and resource shelf">
          {group.panels.filter((panel) => panel.minimized && (panel.kind === 'terminal' || panel.kind === 'ai')).map((panel) => (
            <button key={panel.id} type="button" className="rounded-full border border-primary bg-soft px-2 py-1 text-xs font-semibold text-on-soft" onClick={() => restore(panel)}>
              ^ {panel.label}
            </button>
          ))}
          {group.resources.filter((resource) => resource.kind === 'link').map((resource) => {
            const issue = issueLink(resource.value);
            const github = issue?.provider === 'GitHub' ? issue : null;
            return (
              <span key={resource.id} className={`inline-flex items-center rounded-full border px-1 text-xs ${resource.discovered ? 'border-primary/40 border-dashed' : 'border-primary'}`} title={resource.value}>
                <button type="button" className="inline-flex max-w-40 items-center gap-1.5 px-1 py-1" onClick={() => openResource(resource)}>
                  {github ? <AssetIcon name="github" className="size-3.5" /> : <span>↗</span>}
                  <span className="truncate">{github?.label || resource.label}</span>
                </button>
                <DisassociateButton resource={resource} onDisassociate={disassociate} />
              </span>
            );
          })}
          <FilesDropdown key={group.id} resources={group.resources} panels={group.panels} onOpen={openResource} onDisassociate={disassociate} />
        </div>
        <div className="flex items-center gap-1" aria-label="Add panel">
          <AddPanelButton label="Add terminal panel" onClick={() => addKind('terminal')}><ShellIcon className="size-3.5" /></AddPanelButton>
          {group.type !== 'terminal' && <AddPanelButton label="Add AI panel" disabled={aiExists} onClick={() => addKind('ai')}><RobotIcon className="size-3.5" /></AddPanelButton>}
          {group.type !== 'terminal' && <AddPanelButton label="Associate Markdown panel" onClick={() => associate('markdown')}><EditorIcon className="size-3.5" /></AddPanelButton>}
          {group.type !== 'terminal' && <AddPanelButton label="Associate HTML panel" onClick={() => associate('html')}><span className="text-[0.65rem]">HTML</span></AddPanelButton>}
          {group.type !== 'terminal' && <AddPanelButton label="Associate link panel" onClick={() => associate('link')}><LinkIcon className="size-3.5" /></AddPanelButton>}
        </div>
        {session && (group.type === 'repository' || group.type === 'scratchpad') && (
          <IconButton
            compact
            label="Refresh session"
            title={group.type === 'repository'
              ? 'Sync session Markdown and current-branch pull request'
              : 'Sync session Markdown'}
            onClick={() => { void syncWorkstream(session.id, target).catch(() => {}); }}
          ><RefreshIcon /></IconButton>
        )}
        {session && <Button variant="secondary" className="min-h-8 px-2 py-1 text-xs" onClick={() => onDetails?.(session.id)}>Details</Button>}
        {session && onReset && <Button variant="secondary" className="min-h-8 px-2 py-1 text-xs" onClick={resetTerminals}>Reset</Button>}
        {canArchiveSession(session) && onArchive && <Button variant="secondary" className="min-h-8 px-2 py-1 text-xs" onClick={archive}>Archive</Button>}
      </header>
      {message && <div className="flex min-h-7 shrink-0 items-center gap-2 border-b border-primary/30 px-3 text-xs text-primary" role="status">{message}</div>}
      <div ref={hostRef} className="relative z-0 flex min-h-0 flex-1">
        {visiblePanels.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-muted">Choose a panel, link, or file to open it.</div>
        )}
        <TerminalSplitLayout
          count={visiblePanels.length}
          boundaries={boundaries.length === visiblePanels.length - 1 ? boundaries : defaultSplitBoundaries(visiblePanels.length)}
          onBoundaryChange={changeBoundary}
          onBoundaryCommit={commitBoundaries}
          onBoundaryFocus={(index) => {
            const panel = visiblePanels[index];
            if (panel) onPanelFocus?.(panelNameFor(panel.id));
          }}
          onResetBoundaries={resetBoundaries}
        >
            {orderedPanels.map((panel) => {
              const index = visiblePanels.findIndex((candidate) => candidate.id === panel.id);
              const isTerminalPanel = panel.kind === 'terminal' || panel.kind === 'ai';
              if (panel.minimized && !isTerminalPanel) return null;
              const panelName = panelNameFor(panel.id);
              const resource = resourcesById.get(panel.resourceId);
              const titleContent = (
                <EditablePanelTitle
                  panel={panel}
                  title={resource?.value}
                  onRename={(label) => rename(panel, label)}
                />
              );
              const actions = (
                <>
                  <PanelAction label={`Minimize ${panel.label}`} title="Minimize panel; process keeps running" onClick={() => minimize(panel)}>^</PanelAction>
                  {(panel.kind === 'terminal' || panel.kind === 'ai') && (
                    <PanelAction label={`Close ${panel.label}`} title="Close and kill process" onClick={() => closeTerminal(panel)}><XIcon className="size-3.5" /></PanelAction>
                  )}
                </>
              );
              if (isTerminalPanel) {
                const Icon = panel.kind === 'ai' ? RobotIcon : panel.terminalRole === 'editor' ? EditorIcon : ShellIcon;
                return (
                  <div
                    key={panel.id}
                    className={`${panel.minimized ? 'hidden' : 'flex'} relative min-h-0 min-w-0 [&>section]:flex-1`}
                    onDragOver={(event) => previewPanel(event, panel.id)}
                    onDrop={(event) => dropPanel(event, panel.id)}
                  >
                    <PanelDropIndicator panelId={panel.id} indicator={dropIndicator} />
                    <TerminalPanel
                      panelName={panelName}
                      label={panel.label}
                      Icon={Icon}
                      shown={!panel.minimized}
                      visible={visible}
                      active={active && !panel.minimized}
                      focused={focusedPanel === panelName}
                      onPanelFocus={onPanelFocus}
                      titleContent={titleContent}
                      headerProps={panelHeaderProps(panel)}
                      onFontSizeChange={(amount) => refreshAfter(() => changePanel(panel.id, { fontSize: panel.fontSize + amount }, revision, target))}
                      headerActions={<>{panel.kind === 'ai' && session && <AgentToggle compact value={session.agent === 'codex' ? 'codex' : 'claude'} onChange={(agent) => refreshAfter(() => onAgentChange?.(session, agent))} />}{actions}</>}
                      target={target}
                      sessionId={group.ownerId}
                      role={panel.terminalRole}
                      terminalId={panel.id}
                      persistentPanelId={panel.id}
                      fontSize={panel.fontSize}
                      fontFamily={fontFamily}
                      themeMode={terminalMode}
                      autoFocus={active && index === 0}
                      onPanelNavigate={(direction) => navigate(index, direction)}
                      onToggleSidebar={onToggleSidebar}
                      onNewTerminal={() => addKind('terminal')}
                      terminalLabel={`${panel.label} for ${displayName}`}
                    />
                  </div>
                );
              }
              if (panel.kind === 'iframe') {
                const LinkPanel = resource?.kind === 'link' && githubPullRequestUrl(resource.value)
                  ? PullRequestPanel : IframePanel;
                return (
                  <div key={panel.id} className={`${panel.minimized ? 'hidden' : 'flex'} relative min-h-0 min-w-0 [&>section]:flex-1`} onDragOver={(event) => previewPanel(event, panel.id)} onDrop={(event) => dropPanel(event, panel.id)}>
                    <PanelDropIndicator panelId={panel.id} indicator={dropIndicator} />
                    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner /> Loading panel…</div>}>
                      <LinkPanel
                        panel={panel}
                        panelName={panelName}
                        resource={resource}
                        target={target}
                        focused={focusedPanel === panelName}
                        visible={active && !panel.minimized}
                        onPanelNavigate={(direction) => navigate(index, direction)}
                        onFocus={() => onPanelFocus?.(panelName)}
                        titleContent={titleContent}
                        headerProps={panelHeaderProps(panel)}
                        headerActions={actions}
                      />
                    </Suspense>
                  </div>
                );
              }
              return (
                <section key={panel.id} className={`${panel.minimized ? 'hidden' : 'flex'} relative min-h-0 min-w-0 overflow-hidden ring-inset ${focusedPanel === panelName ? 'ring-2 ring-accent/60' : ''}`} data-panel={panelName} onDragOver={(event) => previewPanel(event, panel.id)} onDrop={(event) => dropPanel(event, panel.id)} onPointerDownCapture={() => onPanelFocus?.(panelName)} onFocusCapture={() => onPanelFocus?.(panelName)}>
                  <PanelDropIndicator panelId={panel.id} indicator={dropIndicator} />
                  <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner /> Loading Markdown…</div>}>
                    <MarkdownEditor
                      path={resource?.value}
                      name={panel.label}
                      source="file"
                      focused={focusedPanel === panelName}
                      visible={active && !panel.minimized}
                      fontFamily={fontFamily}
                      fontSize={panel.fontSize}
                      initialMode={panel.markdownMode}
                      modeRevision={revision}
                      onModeChange={(markdownMode) => refreshAfter(() => changePanel(panel.id, { markdownMode }, revision, target))}
                      onFontSizeChange={(amount) => refreshAfter(() => changePanel(panel.id, { fontSize: panel.fontSize + amount }, revision, target))}
                      dirtyKey={resource.id}
                      onDirtyChange={markDirty}
                      onFocusRequest={() => onPanelFocus?.(panelName)}
                      onPanelNavigate={(direction) => navigate(index, direction)}
                      onToggleSidebar={onToggleSidebar}
                      onNewTerminal={() => addKind('terminal')}
                      titleContent={titleContent}
                      headerProps={panelHeaderProps(panel)}
                      headerActions={actions}
                    />
                  </Suspense>
                </section>
              );
            })}
        </TerminalSplitLayout>
      </div>
      <Modal open={fileAssociation !== null} onClose={() => setFileAssociation(null)} title={`Associate ${fileAssociation?.kind === 'html' ? 'HTML' : 'Markdown'}`} busy={associatingFile}>
        {fileAssociation && (
          <form className="grid gap-4" onSubmit={submitFileAssociation}>
            <Field label={`${fileAssociation.kind === 'html' ? 'HTML' : 'Markdown'} path (relative to this session, absolute, or ~/)`}>
              <input className={inputClass} autoFocus required value={fileAssociation.value} disabled={associatingFile} onChange={(event) => setFileAssociation({ ...fileAssociation, value: event.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-sm text-primary">
              <input type="checkbox" checked={fileAssociation.open} disabled={associatingFile} onChange={(event) => setFileAssociation({ ...fileAssociation, open: event.target.checked })} />
              Open after associating
            </label>
            <ErrorMessage>{associationError}</ErrorMessage>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" disabled={associatingFile} onClick={() => setFileAssociation(null)}>Cancel</Button>
              <Button type="submit" disabled={associatingFile || !fileAssociation.value.trim()}>{associatingFile ? 'Associating…' : 'Associate'}</Button>
            </div>
          </form>
        )}
      </Modal>
    </main>
  );
}
