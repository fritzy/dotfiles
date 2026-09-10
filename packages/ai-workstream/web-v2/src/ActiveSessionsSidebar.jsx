import {
  useEffect, useMemo, useRef, useState,
} from 'react';

import {
  AssetIcon, ChevronIcon, EditorIcon, GearIcon, MaskIcon, ProviderIcon, ShellIcon, Spinner, XIcon,
} from './icons.jsx';
import BrandLogo from './BrandLogo.jsx';
import { TERMINAL_FONTS, THEMES } from './constants.js';
import { useTarget } from './target-context.js';
import {
  Button, selectClass,
} from './ui.jsx';
import {
  branchState, groupActiveSessionsByRepo, timestamp,
} from './utils.js';

function SessionStatus({ status }) {
  const classes = status === 'active'
    ? 'bg-active ring-on-active'
    : 'bg-paused ring-on-paused';
  return (
    <span
      className={`size-2.5 shrink-0 rounded-full ring-1 ${classes}`}
      role="img"
      aria-label={`${status} session`}
      title={status}
    />
  );
}

function SessionActivity({ item }) {
  const active = item.status === 'active';
  const agentWorking = active && item.agentStatus === 'working';
  const shellWorking = active && item.shellStatus === 'working';
  const provider = item.agent === 'codex' ? 'codex' : 'claude';
  if (!agentWorking && !shellWorking) return <SessionStatus status={item.status} />;
  const classes = item.status === 'active'
    ? 'bg-active text-on-active ring-on-active'
    : 'bg-paused text-on-paused ring-on-paused';
  const working = [
    agentWorking ? `${provider === 'codex' ? 'Codex' : 'Claude'} agent` : null,
    shellWorking ? 'terminal' : null,
  ].filter(Boolean).join(' and ');
  return (
    <span
      className={`inline-flex min-h-5 shrink-0 items-center gap-1 rounded-full px-1.5 ring-1 ${classes}`}
      role="img"
      aria-label={`${item.status} session; ${working} working`}
      title={`${working} working`}
    >
      {agentWorking && (
        <span className="inline-flex size-4 items-center justify-center">
          <ProviderIcon provider={provider} className="size-3.5" />
        </span>
      )}
      {shellWorking && (
        <span className="inline-flex size-4 items-center justify-center">
          <ShellIcon className="size-3.5" />
        </span>
      )}
      <Spinner className="size-3" />
    </span>
  );
}

const CONNECTION_DOT_CLASS = {
  open: 'bg-accent',
  connecting: 'bg-soft',
  closed: 'bg-danger',
};

const targetNavigationKey = (targetId) => `target:${targetId}`;
const groupNavigationKey = (targetId, kind, label) => `group:${targetId}:${kind}:${label}`;
const sessionNavigationKey = (targetId, id) => `session:${targetId}:${id}`;
const standaloneNavigationKey = (targetId, id) => `standalone:${targetId}:${id}`;
const SIDEBAR_VIEWS = ['sessions', 'settings'];

function SessionRow({
  item, selected, highlighted, navigationKey, onHighlight, onActivate, onOpenDetails, rowRef,
}) {
  const name = item.name || item.branch || String(item.id);
  const displayName = item.type !== 'scratchpad' && name === item.branch
    ? name.replace(/^fritzy\//u, '…')
    : name;
  const state = branchState(item);
  return (
    <button
      ref={rowRef}
      type="button"
      data-sidebar-session={item.id}
      className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md px-2 py-1.5 text-left font-mono text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${selected ? 'bg-row-highlight text-on-row-highlight' : highlighted ? 'outline-2 -outline-offset-2 outline-accent' : 'hover:bg-soft hover:text-on-soft'}`}
      title={`${name}\nLast used: ${timestamp(item.lastJoined)}\nDouble-click for details`}
      aria-label={`Activate ${name}; double-click for details`}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onActivate(item)}
      onDoubleClick={() => onOpenDetails(item.id)}
      onFocus={() => onHighlight(navigationKey)}
    >
      <MaskIcon name={state.icon} className={`size-3.5 ${state.color}`} title={state.label} />
      <span className="truncate">{displayName}</span>
      <SessionActivity item={item} />
    </button>
  );
}

function StandaloneSessionRow({
  item, selected, highlighted, navigationKey, onHighlight, onActivate, onClose, rowRef,
}) {
  const Icon = item.kind === 'editor' ? EditorIcon : ShellIcon;
  const type = item.kind === 'editor' ? 'Markdown' : 'terminal';
  return (
    <div
      className={`group/standalone grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center rounded-md transition-colors ${selected ? 'bg-row-highlight text-on-row-highlight' : highlighted ? 'outline-2 -outline-offset-2 outline-accent' : 'hover:bg-soft hover:text-on-soft'}`}
      data-sidebar-standalone={item.id}
    >
      <button
        ref={rowRef}
        type="button"
        className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        title={item.path || item.label}
        aria-label={`Open ${item.label} ${type} session`}
        aria-current={selected ? 'true' : undefined}
        onClick={onActivate}
        onFocus={() => onHighlight(navigationKey)}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{item.label}</span>
        {item.dirty && <span className="size-1.5 shrink-0 rounded-full bg-current" title="Unsaved changes" aria-label="Unsaved changes" />}
      </button>
      <button
        type="button"
        className="mr-1 flex size-6 items-center justify-center rounded text-current opacity-60 transition-opacity hover:bg-page/30 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={`Close ${item.label}`}
        title={`Close ${item.label}`}
        onClick={onClose}
      ><XIcon className="size-3.5" /></button>
    </div>
  );
}

function SidebarResizeHandle({
  open, left, width, resizing, onFocus, onResizeStart, onResize, onResizeEnd,
}) {
  const drag = useRef(null);
  const [dragging, setDragging] = useState(false);

  function restoreDocument() {
    if (!drag.current) return;
    document.documentElement.style.cursor = drag.current.cursor;
    document.body.style.userSelect = drag.current.userSelect;
    drag.current = null;
  }

  useEffect(() => () => restoreDocument(), []);

  function begin(event) {
    if (!open || event.button !== 0) return;
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      cursor: document.documentElement.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setDragging(true);
    onFocus();
    onResizeStart();
  }

  function move(event) {
    if (drag.current?.pointerId !== event.pointerId) return;
    onResize(event.clientX);
  }

  function finish(event, cancelled = false) {
    if (drag.current?.pointerId !== event.pointerId) return;
    const finalWidth = cancelled ? width : event.clientX;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    restoreDocument();
    setDragging(false);
    onResizeEnd(finalWidth);
  }

  function keyDown(event) {
    if (!open || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    onFocus();
    onResizeEnd(width + direction * (event.shiftKey ? 32 : 8));
  }

  return (
    <div
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin="208"
      aria-valuemax="640"
      aria-valuenow={width}
      aria-hidden={!open}
      tabIndex={open ? 0 : -1}
      className={`group fixed top-0 bottom-0 z-[54] flex w-2 -translate-x-1/2 touch-none cursor-col-resize justify-center outline-none ${resizing || dragging ? '' : 'transition-[left,opacity] duration-300 ease-in-out'} ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      style={{ left }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={(event) => finish(event)}
      onPointerCancel={(event) => finish(event, true)}
      onKeyDown={keyDown}
    >
      <span className={`h-full transition-[width,background-color] ${dragging ? 'w-1 bg-accent' : 'w-px bg-primary/35 group-hover:w-1 group-hover:bg-accent group-focus-visible:w-1 group-focus-visible:bg-accent'}`} aria-hidden="true" />
    </div>
  );
}

export default function ActiveSessionsSidebar({
  sections, open, onActivate, onOpenDetails,
  onActivateStandalone, onCloseStandalone, onCreateTerminal, onOpenMarkdown,
  onToggle, onNewRepo, onNewScratchpad,
  currentTargetId, onTargetChange,
  theme, onThemeChange,
  terminalMode, onTerminalModeChange,
  terminalFont, onTerminalFontChange,
  onResetTerminals,
  syncWindowFullscreen, onSyncWindowFullscreenChange,
  onContentFocus,
  focusedPanel, onPanelFocus, keyboardEnabled, sidebarWidth, sidebarWidthPixels, sidebarResizing,
  onSidebarResizeStart, onSidebarResize, onSidebarResizeEnd,
}) {
  const target = useTarget();
  const targetId = target?.id || 'local';
  const targetSections = useMemo(() => sections.map((section) => {
    const workstreamGroups = groupActiveSessionsByRepo(section.items)
      .map((group) => ({ ...group, kind: 'workstream' }));
    const terminals = section.standaloneSessions.filter((item) => item.kind === 'terminal');
    const markdown = section.standaloneSessions.filter((item) => item.kind === 'editor');
    const standaloneGroups = [
      terminals.length ? { label: 'Terminals', kind: 'standalone', items: terminals } : null,
      markdown.length ? { label: 'Markdown', kind: 'standalone', items: markdown } : null,
    ].filter(Boolean);
    return {
      ...section,
      workstreamGroups,
      groups: [...workstreamGroups, ...standaloneGroups],
    };
  }), [sections]);
  const [collapsedTargets, setCollapsedTargets] = useState(() => new Set());
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const seenTargets = useRef(new Set());
  const [view, setView] = useState('sessions');
  const [terminalsResetting, setTerminalsResetting] = useState(false);
  const [terminalResetError, setTerminalResetError] = useState('');
  const [highlightedNavigationKey, setHighlightedNavigationKey] = useState(null);
  const navigationRows = useRef(new Map());
  const panelRef = useRef(null);
  const themeCredit = THEMES[theme];
  const panelName = (forView) => `sidebar-${targetId}-${forView}`;
  const currentPanel = panelName(view);
  const sessionsPanel = panelName('sessions');
  const navigationItems = useMemo(() => targetSections.flatMap((section) => {
    const sectionId = section.target.id;
    const targetItem = {
      kind: 'target', key: targetNavigationKey(sectionId), targetId: sectionId,
    };
    if (collapsedTargets.has(sectionId)) return [targetItem];
    return [targetItem, ...section.groups.flatMap((group) => {
      const groupItem = {
        kind: 'group', key: groupNavigationKey(sectionId, group.kind, group.label),
        targetId: sectionId, groupKind: group.kind, groupLabel: group.label,
      };
      if (collapsedGroups.has(groupItem.key)) return [groupItem];
      return [groupItem, ...group.items.map((item) => (group.kind === 'standalone' ? {
        kind: 'standalone', key: standaloneNavigationKey(sectionId, item.id),
        targetId: sectionId, groupKind: group.kind, groupLabel: group.label, item,
      } : {
        kind: 'session', key: sessionNavigationKey(sectionId, item.id),
        targetId: sectionId, groupKind: group.kind, groupLabel: group.label, item,
      }))];
    })];
  }), [collapsedGroups, collapsedTargets, targetSections]);

  useEffect(() => {
    setCollapsedTargets((current) => {
      const next = new Set(current);
      let changed = false;
      for (const section of targetSections) {
        const id = section.target.id;
        if (seenTargets.current.has(id)) continue;
        seenTargets.current.add(id);
        if (id !== currentTargetId) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [currentTargetId, targetSections]);

  useEffect(() => {
    setHighlightedNavigationKey((current) => (
      navigationItems.some((item) => item.key === current) ? current : null
    ));
  }, [navigationItems]);

  useEffect(() => {
    if (highlightedNavigationKey == null) return;
    navigationRows.current.get(highlightedNavigationKey)?.scrollIntoView({ block: 'nearest' });
  }, [highlightedNavigationKey]);

  useEffect(() => {
    if (focusedPanel === sessionsPanel && view !== 'sessions') setView('sessions');
  }, [focusedPanel, sessionsPanel, view]);

  useEffect(() => {
    if (focusedPanel !== sessionsPanel) return;
    const section = targetSections.find((item) => item.target.id === currentTargetId);
    if (!section) return;
    const selectedKey = section.activeStandaloneId
      ? standaloneNavigationKey(currentTargetId, section.activeStandaloneId)
      : section.selectedId != null ? sessionNavigationKey(currentTargetId, section.selectedId) : null;
    if (selectedKey && navigationItems.some((item) => item.key === selectedKey)) {
      setHighlightedNavigationKey(selectedKey);
    }
  }, [currentTargetId, focusedPanel, navigationItems, sessionsPanel, targetSections]);

  useEffect(() => {
    if (!open || focusedPanel !== currentPanel) return undefined;
    const frame = requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [currentPanel, focusedPanel, open]);

  useEffect(() => {
    if (!open || focusedPanel !== currentPanel || !keyboardEnabled) return undefined;
    function controlNavigation(event) {
      const key = event.key.toLowerCase();
      if (event.defaultPrevented || !event.ctrlKey || event.altKey || event.metaKey
          || event.shiftKey || !['f', 'h', 'j', 'k', 'l'].includes(key)) return;
      event.preventDefault();
      event.stopPropagation();
      if ((key === 'j' || key === 'k') && !event.repeat) navigateView(key === 'j' ? 1 : -1);
      if (key === 'l' && !event.repeat) focusContent();
    }
    document.addEventListener('keydown', controlNavigation);
    return () => document.removeEventListener('keydown', controlNavigation);
  }, [currentPanel, focusedPanel, highlightedNavigationKey, keyboardEnabled,
    navigationItems, onActivate, onActivateStandalone, onContentFocus, open]);

  useEffect(() => {
    if (!open || view !== 'sessions' || focusedPanel !== sessionsPanel || !keyboardEnabled) return undefined;
    function shortcuts(event) {
      if (event.defaultPrevented || event.metaKey || event.altKey) return;
      if (event.ctrlKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, a, [contenteditable="true"]')) return;
      if (!['j', 'k', 'h', 'l', 'Enter'].includes(event.key) || !navigationItems.length) return;
      const currentIndex = navigationItems.findIndex((item) => item.key === highlightedNavigationKey);
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault();
        const nextIndex = currentIndex < 0
          ? event.key === 'j' ? 0 : navigationItems.length - 1
          : Math.max(0, Math.min(navigationItems.length - 1, currentIndex + (event.key === 'j' ? 1 : -1)));
        const nextKey = navigationItems[nextIndex].key;
        setHighlightedNavigationKey(nextKey);
        requestAnimationFrame(() => navigationRows.current.get(nextKey)?.focus());
        return;
      }
      if (currentIndex < 0) return;
      const current = navigationItems[currentIndex];
      if (event.key === 'h') {
        event.preventDefault();
        if (current.kind === 'session' || current.kind === 'standalone') {
          const groupKey = groupNavigationKey(current.targetId, current.groupKind, current.groupLabel);
          setHighlightedNavigationKey(groupKey);
          setGroupCollapsed(current.targetId, current.groupKind, current.groupLabel, true);
          requestAnimationFrame(() => navigationRows.current.get(groupKey)?.focus());
        } else {
          const machineKey = targetNavigationKey(current.targetId);
          setHighlightedNavigationKey(machineKey);
          setTargetCollapsed(current.targetId, true);
          requestAnimationFrame(() => navigationRows.current.get(machineKey)?.focus());
        }
        return;
      }
      if (event.key === 'l') {
        if (current.kind === 'session' || current.kind === 'standalone') return;
        event.preventDefault();
        if (current.kind === 'target') setTargetCollapsed(current.targetId, false);
        else setGroupCollapsed(current.targetId, current.groupKind, current.groupLabel, false);
        return;
      }
      if (target?.closest('button')) return;
      event.preventDefault();
      if (current.kind === 'target') chooseTargetSection(current.targetId);
      else if (current.kind === 'group') toggleGroup(current.targetId, current.groupKind, current.groupLabel);
      else if (current.kind === 'standalone') onActivateStandalone(current.targetId, current.item.id);
      else onActivate(current.targetId, current.item);
    }
    document.addEventListener('keydown', shortcuts);
    return () => document.removeEventListener('keydown', shortcuts);
  }, [currentTargetId, focusedPanel, highlightedNavigationKey, keyboardEnabled, navigationItems,
    onActivate, onActivateStandalone, onTargetChange, open, sessionsPanel, view]);

  function focusContent() {
    const highlighted = navigationItems.find((item) => item.key === highlightedNavigationKey);
    if (highlighted?.kind === 'standalone') {
      onActivateStandalone(highlighted.targetId, highlighted.item.id);
      return;
    }
    if (highlighted?.kind === 'session') {
      onActivate(highlighted.targetId, highlighted.item);
      return;
    }
    onContentFocus();
  }

  function setTargetCollapsed(id, collapsed) {
    setCollapsedTargets((current) => {
      if (current.has(id) === collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.add(id); else next.delete(id);
      return next;
    });
  }

  function chooseTargetSection(id) {
    const collapsed = collapsedTargets.has(id);
    onTargetChange(id);
    if (collapsed) setTargetCollapsed(id, false);
    else if (id === currentTargetId) setTargetCollapsed(id, true);
  }

  function setGroupCollapsed(sectionId, kind, label, collapsed) {
    const key = groupNavigationKey(sectionId, kind, label);
    setCollapsedGroups((current) => {
      if (current.has(key) === collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.add(key); else next.delete(key);
      return next;
    });
  }

  function toggleGroup(sectionId, kind, label) {
    const key = groupNavigationKey(sectionId, kind, label);
    setGroupCollapsed(sectionId, kind, label, !collapsedGroups.has(key));
  }

  function chooseView(nextView) {
    if (open && view === nextView) {
      onToggle();
      onPanelFocus(null);
      return;
    }
    setView(nextView);
    onPanelFocus(panelName(nextView));
    if (!open) onToggle();
  }

  function navigateView(direction) {
    if (SIDEBAR_VIEWS.length < 2) return;
    const currentIndex = Math.max(0, SIDEBAR_VIEWS.indexOf(view));
    const nextIndex = (currentIndex + direction + SIDEBAR_VIEWS.length) % SIDEBAR_VIEWS.length;
    const nextView = SIDEBAR_VIEWS[nextIndex];
    setView(nextView);
    onPanelFocus(panelName(nextView));
  }

  async function resetTerminals() {
    if (terminalsResetting) return;
    const daemonName = target?.name || target?.id || 'this machine';
    if (!window.confirm(`Reset every FritzWorks terminal on ${daemonName}? All running shell, editor, and agent processes on this daemon will be stopped; open views will reconnect fresh.`)) return;
    setTerminalsResetting(true);
    setTerminalResetError('');
    try {
      await onResetTerminals();
    } catch (cause) {
      setTerminalResetError(cause.message);
    } finally {
      setTerminalsResetting(false);
    }
  }

  return (
    <aside className="relative min-h-screen min-w-0 self-stretch" aria-label="FritzWorks sidebar">
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`h-full min-w-0 overflow-hidden border-r border-primary/35 bg-page ring-inset transition-opacity duration-200 ${focusedPanel === currentPanel ? 'ring-2 ring-accent/50' : ''} ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        aria-hidden={!open}
        inert={!open}
        data-panel={currentPanel}
        data-panel-focused={focusedPanel === currentPanel}
        onPointerEnter={() => onPanelFocus(currentPanel)}
        onPointerDownCapture={() => onPanelFocus(currentPanel)}
        onFocusCapture={() => onPanelFocus(currentPanel)}
      >
        <div className="sticky top-0 grid h-screen min-w-60 content-start gap-1 overflow-y-auto pr-1.5">
          <div className="grid gap-2 border-b-4 border-accent px-2 pt-2 pb-2">
            <div className="flex min-w-0 items-center gap-2">
              <BrandLogo className="size-11 shrink-0 drop-shadow-sm" />
              <h1 className="truncate text-2xl font-black tracking-tight">FritzWorks</h1>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button className="min-w-10 gap-1 px-2" aria-label={`New repository session on ${target?.name || 'Local'}`} title={`New repository session on ${target?.name || 'Local'}`} onClick={onNewRepo}>
                <span className="text-lg leading-none" aria-hidden="true">+</span><AssetIcon name="git-branch" />
              </Button>
              <Button className="min-w-10 gap-1 px-2" aria-label={`New scratchpad session on ${target?.name || 'Local'}`} title={`New scratchpad session on ${target?.name || 'Local'}`} onClick={onNewScratchpad}>
                <span className="text-lg leading-none" aria-hidden="true">+</span><AssetIcon name="folder" />
              </Button>
            </div>
          </div>
          {view === 'sessions' ? (
            <div id={`${sessionsPanel}-view`} role="tabpanel" aria-labelledby={`${sessionsPanel}-tab`} className="grid min-w-0 content-start gap-1">
              <div className="flex min-h-9 items-center justify-between gap-2 px-2">
                <h2 className="truncate text-sm font-bold text-primary">Sessions</h2>
              </div>
              {targetSections.map((section) => {
                const sectionId = section.target.id;
                const collapsed = collapsedTargets.has(sectionId);
                const navigationKey = targetNavigationKey(sectionId);
                const highlighted = highlightedNavigationKey === navigationKey;
                const selected = sectionId === currentTargetId;
                const connectionLabel = section.connection === 'open'
                  ? 'connected' : section.connection === 'connecting' ? 'connecting' : 'reconnecting';
                return (
                  <section key={sectionId} className="min-w-0" data-sidebar-target={sectionId}>
                    <button
                      ref={(node) => {
                        if (node) navigationRows.current.set(navigationKey, node); else navigationRows.current.delete(navigationKey);
                      }}
                      type="button"
                      className={`flex min-h-9 w-full items-center gap-1.5 border-y border-primary/30 px-2 py-1.5 text-left text-sm font-black transition-colors focus-visible:outline-2 focus-visible:outline-accent ${highlighted ? 'bg-row-highlight text-on-row-highlight outline-2 -outline-offset-2 outline-accent' : selected ? 'bg-soft text-on-soft' : 'text-primary hover:bg-soft hover:text-on-soft'}`}
                      aria-expanded={!collapsed}
                      aria-label={`${section.target.name}; ${connectionLabel}; ${section.items.length + section.standaloneSessions.length} sessions`}
                      onClick={() => chooseTargetSection(sectionId)}
                      onFocus={() => setHighlightedNavigationKey(navigationKey)}
                    >
                      <ChevronIcon className={`size-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                      <span className={`size-2 shrink-0 rounded-full ${CONNECTION_DOT_CLASS[section.connection] || CONNECTION_DOT_CLASS.connecting}`} aria-hidden="true" />
                      <span className="truncate">{section.target.name}</span>
                      {section.loading
                        ? <Spinner className="ml-auto size-3.5" />
                        : <span className={`ml-auto text-[0.65rem] font-normal tabular-nums ${highlighted ? 'text-on-row-highlight/70' : 'text-muted'}`}>{section.items.length + section.standaloneSessions.length}</span>}
                    </button>
                    <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}>
                      <div className="min-h-0 overflow-hidden">
                        <div className="flex items-center gap-1.5 px-2 py-1.5" data-sidebar-session-actions={sectionId}>
                          <button
                            type="button"
                            className="inline-flex min-h-7 flex-1 items-center justify-center gap-1 rounded-md border border-primary/60 px-2 text-xs font-semibold text-primary transition-colors hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent"
                            aria-label={`New ${section.target.name} terminal`}
                            title={`New ${section.target.name} terminal`}
                            onClick={() => onCreateTerminal(sectionId)}
                          ><span className="text-sm font-bold" aria-hidden="true">+</span><ShellIcon className="size-3.5" /> Terminal</button>
                          <button
                            type="button"
                            className="inline-flex min-h-7 flex-1 items-center justify-center gap-1 rounded-md border border-primary/60 px-2 text-xs font-semibold text-primary transition-colors hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent"
                            aria-label={`Open ${section.target.name} Markdown`}
                            title={`Open ${section.target.name} Markdown`}
                            onClick={() => onOpenMarkdown(sectionId)}
                          ><span className="text-sm font-bold" aria-hidden="true">+</span><EditorIcon className="size-3.5" /> Markdown</button>
                        </div>
                        {section.error && <p className="m-1 rounded border border-danger/40 bg-danger/10 p-2 text-xs text-danger">{section.error}</p>}
                        {!section.loading && !section.error && section.workstreamGroups.length === 0 && <p className="px-3 py-2 text-xs text-muted">No active or paused workstreams.</p>}
                        {section.groups.map((group) => {
                          const groupKey = groupNavigationKey(sectionId, group.kind, group.label);
                          const groupCollapsed = collapsedGroups.has(groupKey);
                          const groupHighlighted = highlightedNavigationKey === groupKey;
                          return (
                            <section key={`${group.kind}:${group.label}`} className="min-w-0 pl-2">
                              <button
                                ref={(node) => {
                                  if (node) navigationRows.current.set(groupKey, node); else navigationRows.current.delete(groupKey);
                                }}
                                type="button"
                                data-sidebar-group={group.label}
                                className={`flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-sm font-bold transition-colors focus-visible:outline-2 focus-visible:outline-accent ${groupHighlighted ? 'bg-row-highlight text-on-row-highlight outline-2 -outline-offset-2 outline-accent' : 'text-primary hover:bg-soft hover:text-on-soft'}`}
                                aria-expanded={!groupCollapsed}
                                onClick={() => toggleGroup(sectionId, group.kind, group.label)}
                                onFocus={() => setHighlightedNavigationKey(groupKey)}
                              >
                                <ChevronIcon className={`size-3.5 transition-transform ${groupCollapsed ? '-rotate-90' : ''}`} />
                                <span className="truncate">{group.label}</span>
                                <span className={`ml-auto text-[0.65rem] font-normal tabular-nums ${groupHighlighted ? 'text-on-row-highlight/70' : 'text-muted'}`}>{group.items.length}</span>
                              </button>
                              <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${groupCollapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}>
                                <div className="min-h-0 overflow-hidden">
                                  <div className="grid gap-0.5 pb-1 pl-2">
                                    {group.items.map((item) => {
                                      if (group.kind === 'standalone') {
                                        const itemKey = standaloneNavigationKey(sectionId, item.id);
                                        return (
                                          <StandaloneSessionRow
                                            key={item.id}
                                            item={item}
                                            selected={String(section.activeStandaloneId) === String(item.id)}
                                            navigationKey={itemKey}
                                            highlighted={highlightedNavigationKey === itemKey}
                                            onHighlight={setHighlightedNavigationKey}
                                            onActivate={() => onActivateStandalone(sectionId, item.id)}
                                            onClose={() => onCloseStandalone(sectionId, item.id)}
                                            rowRef={(node) => {
                                              if (node) navigationRows.current.set(itemKey, node); else navigationRows.current.delete(itemKey);
                                            }}
                                          />
                                        );
                                      }
                                      const itemKey = sessionNavigationKey(sectionId, item.id);
                                      return (
                                        <SessionRow
                                          key={item.id}
                                          item={item}
                                          selected={String(section.selectedId) === String(item.id)}
                                          navigationKey={itemKey}
                                          highlighted={highlightedNavigationKey === itemKey}
                                          onHighlight={setHighlightedNavigationKey}
                                          onActivate={() => onActivate(sectionId, item)}
                                          onOpenDetails={() => onOpenDetails(sectionId, item.id)}
                                          rowRef={(node) => {
                                            if (node) navigationRows.current.set(itemKey, node); else navigationRows.current.delete(itemKey);
                                          }}
                                        />
                                      );
                                    })}
                                  </div>
                                </div>
                              </div>
                            </section>
                          );
                        })}
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <div id={`${panelName('settings')}-view`} role="tabpanel" aria-labelledby={`${panelName('settings')}-tab`} className="grid content-start gap-5 px-2 py-3">
              <section className="grid gap-2">
                <label className="grid gap-1 text-sm font-bold text-primary" htmlFor="sidebar-theme">Theme</label>
                <select id="sidebar-theme" className={`${selectClass} w-full`} value={theme} onChange={(event) => onThemeChange(event.target.value)}>
                  {Object.entries(THEMES).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
                </select>
                <a className="text-xs text-primary underline decoration-accent hover:text-danger" href={themeCredit.href} target="_blank" rel="noreferrer">{themeCredit.credit}</a>
              </section>
              <section className="grid gap-2">
                <label className="text-sm font-bold text-primary" htmlFor="sidebar-terminal-mode">Terminal colors</label>
                <select id="sidebar-terminal-mode" className={`${selectClass} w-full`} value={terminalMode} onChange={(event) => onTerminalModeChange(event.target.value)}>
                  <option value="dark">Dark</option>
                  <option value="black">Black</option>
                  <option value="light">Light</option>
                </select>
                <label className="mt-1 text-sm font-bold text-primary" htmlFor="sidebar-terminal-font">Terminal font</label>
                <select id="sidebar-terminal-font" className={`${selectClass} w-full`} value={terminalFont} onChange={(event) => onTerminalFontChange(event.target.value)}>
                  {Object.entries(TERMINAL_FONTS).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
                </select>
                <p className="text-xs text-muted">Terminal colors are independent from the interface theme.</p>
                <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-md border border-primary/50 p-2 text-primary transition-colors hover:bg-soft hover:text-on-soft">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-accent"
                    checked={syncWindowFullscreen}
                    onChange={(event) => onSyncWindowFullscreenChange(event.target.checked)}
                  />
                  <span className="grid gap-0.5">
                    <span className="text-sm font-bold">Syncing Window Fullscreen</span>
                    <span className="text-xs opacity-75">Fullscreen the browser window with the focused terminal.</span>
                  </span>
                </label>
              </section>
              <section className="grid gap-2 border-t border-primary/30 pt-4">
                <h2 className="text-sm font-bold text-primary">Terminal recovery</h2>
                <p className="text-xs text-muted">Delete every FritzWorks Zellij session on this daemon and recreate open terminal views from their configured layouts.</p>
                <Button variant="danger" disabled={terminalsResetting} onClick={resetTerminals}>
                  {terminalsResetting ? <><Spinner /> Resetting…</> : 'Reset all terminal sessions'}
                </Button>
                {terminalResetError && <p className="text-xs text-danger" role="alert">{terminalResetError}</p>}
              </section>
            </div>
          )}
        </div>
      </div>
      <div
        className={`fixed top-2 z-[55] grid w-10 gap-1 motion-reduce:transition-none ${sidebarResizing ? 'transition-opacity duration-200' : 'transition-[left,opacity] duration-300 ease-in-out'} ${focusedPanel?.startsWith('sidebar-') ? 'opacity-100' : 'opacity-20 hover:opacity-100 focus-within:opacity-100'}`}
        style={{ left: sidebarWidth }}
        role="tablist"
        aria-label="Sidebar views"
      >
          {SIDEBAR_VIEWS.map((option) => {
            const selected = view === option;
            const expanded = open && selected;
            return (
              <button
                key={option}
                id={`${panelName(option)}-tab`}
                type="button"
                role="tab"
                className={`flex h-12 w-10 items-center justify-center rounded-r-lg border border-l-0 border-primary shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${selected ? 'bg-accent text-on-accent' : 'bg-page text-primary hover:bg-soft hover:text-on-soft'} ${focusedPanel === panelName(option) ? 'outline-2 outline-offset-1 outline-accent' : ''}`}
                aria-label={`${expanded ? 'Collapse' : 'Open'} ${option} sidebar view`}
                aria-controls={`${panelName(option)}-view`}
                aria-selected={selected}
                aria-expanded={expanded}
                title={`${expanded ? 'Collapse' : 'Open'} ${option} view`}
                onClick={() => chooseView(option)}
              >
                {option === 'sessions'
                  ? <AssetIcon name="folder" className="size-5" />
                  : <GearIcon className="size-5" />}
              </button>
            );
          })}
      </div>
      <SidebarResizeHandle
        open={open}
        left={sidebarWidth}
        width={sidebarWidthPixels}
        resizing={sidebarResizing}
        onFocus={() => onPanelFocus(currentPanel)}
        onResizeStart={onSidebarResizeStart}
        onResize={onSidebarResize}
        onResizeEnd={onSidebarResizeEnd}
      />
    </aside>
  );
}
