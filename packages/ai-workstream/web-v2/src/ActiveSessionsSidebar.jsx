import {
  useEffect, useMemo, useRef, useState,
} from 'react';

import {
  AssetIcon, ChevronIcon, GearIcon, MaskIcon, ProviderIcon, ShellIcon, Spinner,
} from './icons.jsx';
import { TERMINAL_FONTS, THEMES } from './constants.js';
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

const groupNavigationKey = (label) => `group:${label}`;
const sessionNavigationKey = (id) => `session:${id}`;

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
  items, loading, error, open, selectedId, onActivate, onOpenDetails, onToggle, onNewRepo, onNewScratchpad,
  theme, onThemeChange,
  terminalMode, onTerminalModeChange,
  terminalFont, onTerminalFontChange,
  onWorkspaceFocus,
  focusedPanel, onPanelFocus, keyboardEnabled, sidebarWidth, sidebarWidthPixels, sidebarResizing,
  onSidebarResizeStart, onSidebarResize, onSidebarResizeEnd,
}) {
  const groups = useMemo(() => groupActiveSessionsByRepo(items), [items]);
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const [view, setView] = useState('sessions');
  const [highlightedNavigationKey, setHighlightedNavigationKey] = useState(null);
  const navigationRows = useRef(new Map());
  const panelRef = useRef(null);
  const themeCredit = THEMES[theme];
  const currentPanel = `sidebar-${view}`;
  const navigationItems = useMemo(() => groups.flatMap((group) => [
    {
      kind: 'group', key: groupNavigationKey(group.label), groupLabel: group.label,
    },
    ...(collapsedGroups.has(group.label) ? [] : group.items.map((item) => ({
      kind: 'session', key: sessionNavigationKey(item.id), groupLabel: group.label, item,
    }))),
  ]), [collapsedGroups, groups]);

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
    if (focusedPanel === 'sidebar-sessions' && view !== 'sessions') setView('sessions');
  }, [focusedPanel, view]);

  useEffect(() => {
    if (!open || focusedPanel !== currentPanel) return undefined;
    const frame = requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [currentPanel, focusedPanel, open]);

  useEffect(() => {
    if (!open || view !== 'sessions' || focusedPanel !== 'sidebar-sessions' || !keyboardEnabled) return undefined;
    function shortcuts(event) {
      if (event.defaultPrevented || event.metaKey || event.altKey) return;
      if (event.ctrlKey) {
        if (!event.shiftKey && event.key.toLowerCase() === 'l') {
          event.preventDefault();
          onWorkspaceFocus();
        }
        return;
      }
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
        const groupKey = groupNavigationKey(current.groupLabel);
        setHighlightedNavigationKey(groupKey);
        setGroupCollapsed(current.groupLabel, true);
        requestAnimationFrame(() => navigationRows.current.get(groupKey)?.focus());
        return;
      }
      if (event.key === 'l') {
        if (current.kind !== 'group') return;
        event.preventDefault();
        setGroupCollapsed(current.groupLabel, false);
        return;
      }
      if (target?.closest('button')) return;
      event.preventDefault();
      if (current.kind === 'group') toggleGroup(current.groupLabel);
      else onActivate(current.item);
    }
    document.addEventListener('keydown', shortcuts);
    return () => document.removeEventListener('keydown', shortcuts);
  }, [focusedPanel, highlightedNavigationKey, keyboardEnabled, navigationItems, onActivate, onWorkspaceFocus, open, view]);

  function setGroupCollapsed(label, collapsed) {
    setCollapsedGroups((current) => {
      if (current.has(label) === collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.add(label); else next.delete(label);
      return next;
    });
  }

  function toggleGroup(label) {
    setGroupCollapsed(label, !collapsedGroups.has(label));
  }

  function chooseView(nextView) {
    if (open && view === nextView) {
      onToggle();
      onPanelFocus(null);
      return;
    }
    setView(nextView);
    onPanelFocus(`sidebar-${nextView}`);
    if (!open) onToggle();
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
            <h1 className="truncate text-3xl font-black tracking-tight">FritzWorks</h1>
            <div className="flex flex-wrap gap-2">
              <Button className="min-w-10 gap-1 px-2" aria-label="New repository session" title="New repository session" onClick={onNewRepo}>
                <span className="text-lg leading-none" aria-hidden="true">+</span><AssetIcon name="git-branch" />
              </Button>
              <Button className="min-w-10 gap-1 px-2" aria-label="New scratchpad session" title="New scratchpad session" onClick={onNewScratchpad}>
                <span className="text-lg leading-none" aria-hidden="true">+</span><AssetIcon name="folder" />
              </Button>
            </div>
          </div>
          {view === 'sessions' ? (
            <div id="sidebar-sessions-view" role="tabpanel" aria-labelledby="sidebar-sessions-tab" className="grid min-w-0 content-start gap-1">
              <div className="flex min-h-9 items-center justify-between gap-2 px-2">
                <h2 className="truncate text-sm font-bold text-primary">Active &amp; Paused</h2>
                {loading && <Spinner className="size-3.5" />}
              </div>
              {error && <p className="m-1 rounded border border-danger/40 bg-danger/10 p-2 text-xs text-danger">{error}</p>}
              {!loading && !error && groups.length === 0 && <p className="px-2 py-4 text-xs text-muted">No active or paused sessions.</p>}
              {groups.map((group) => {
                const collapsed = collapsedGroups.has(group.label);
                const navigationKey = groupNavigationKey(group.label);
                const highlighted = highlightedNavigationKey === navigationKey;
                return (
                  <section key={group.label} className="min-w-0">
                    <button
                      ref={(node) => {
                        if (node) navigationRows.current.set(navigationKey, node); else navigationRows.current.delete(navigationKey);
                      }}
                      type="button"
                      data-sidebar-group={group.label}
                      className={`flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-sm font-bold transition-colors focus-visible:outline-2 focus-visible:outline-accent ${highlighted ? 'bg-row-highlight text-on-row-highlight outline-2 -outline-offset-2 outline-accent' : 'text-primary hover:bg-soft hover:text-on-soft'}`}
                      aria-expanded={!collapsed}
                      onClick={() => toggleGroup(group.label)}
                      onFocus={() => setHighlightedNavigationKey(navigationKey)}
                    >
                      <ChevronIcon className={`size-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                      <span className="truncate">{group.label}</span>
                      <span className={`ml-auto text-[0.65rem] font-normal tabular-nums ${highlighted ? 'text-on-row-highlight/70' : 'text-muted'}`}>{group.items.length}</span>
                    </button>
                    <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}>
                      <div className="min-h-0 overflow-hidden">
                        <div className="grid gap-0.5 pb-1 pl-2">
                          {group.items.map((item) => (
                            <SessionRow
                              key={item.id}
                              item={item}
                              selected={String(selectedId) === String(item.id)}
                              navigationKey={sessionNavigationKey(item.id)}
                              highlighted={highlightedNavigationKey === sessionNavigationKey(item.id)}
                              onHighlight={setHighlightedNavigationKey}
                              onActivate={onActivate}
                              onOpenDetails={onOpenDetails}
                              rowRef={(node) => {
                                const key = sessionNavigationKey(item.id);
                                if (node) navigationRows.current.set(key, node); else navigationRows.current.delete(key);
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <div id="sidebar-settings-view" role="tabpanel" aria-labelledby="sidebar-settings-tab" className="grid content-start gap-5 px-2 py-3">
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
                  <option value="light">Light</option>
                </select>
                <label className="mt-1 text-sm font-bold text-primary" htmlFor="sidebar-terminal-font">Terminal font</label>
                <select id="sidebar-terminal-font" className={`${selectClass} w-full`} value={terminalFont} onChange={(event) => onTerminalFontChange(event.target.value)}>
                  {Object.entries(TERMINAL_FONTS).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
                </select>
                <p className="text-xs text-muted">Terminal colors are independent from the interface theme.</p>
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
          {['sessions', 'settings'].map((option) => {
            const selected = view === option;
            const expanded = open && selected;
            return (
              <button
                key={option}
                id={`sidebar-${option}-tab`}
                type="button"
                role="tab"
                className={`flex h-12 w-10 items-center justify-center rounded-r-lg border border-l-0 border-primary shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${selected ? 'bg-accent text-on-accent' : 'bg-page text-primary hover:bg-soft hover:text-on-soft'} ${focusedPanel === `sidebar-${option}` ? 'outline-2 outline-offset-1 outline-accent' : ''}`}
                aria-label={`${expanded ? 'Collapse' : 'Open'} ${option} sidebar view`}
                aria-controls={`sidebar-${option}-view`}
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
