import {
  useEffect, useMemo, useRef, useState,
} from 'react';

import {
  ArrowLeftIcon, AssetIcon, ChevronIcon, EditorIcon, GearIcon, GripIcon, LinkIcon, MaskIcon, MinimizeIcon, ProviderIcon, ShellIcon, Spinner, XIcon,
} from './icons.jsx';
import BrandLogo from './BrandLogo.jsx';
import {
  SIDEBAR_TREE_STORAGE_KEY, STANDALONE_TERMINAL_DRAG_TYPE, TERMINAL_FONTS, THEMES,
} from './constants.js';
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
      className={`inline-block size-3.5 shrink-0 rounded-full ring-1 ${classes}`}
      role="img"
      aria-label={`${status} session`}
      title={status}
    />
  );
}

function SessionActivity({ item }) {
  const agentWorking = item.agentStatus === 'working';
  const shellWorking = item.shellStatus === 'working';
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
const panelGroupNavigationKey = (targetId, id) => `panel-group:${targetId}:${id}`;
const resourceNavigationKey = (targetId, id) => `resource:${targetId}:${id}`;
const SIDEBAR_VIEWS = ['sessions', 'settings'];

function storedExpandedKeys(name) {
  try {
    const stored = JSON.parse(localStorage.getItem(SIDEBAR_TREE_STORAGE_KEY));
    if (!Array.isArray(stored?.[name])) return new Set();
    return new Set(stored[name].filter((key) => typeof key === 'string').slice(0, 2000));
  } catch {
    return new Set();
  }
}

function terminalDragPayload(dataTransfer) {
  try {
    return JSON.parse(dataTransfer.getData(STANDALONE_TERMINAL_DRAG_TYPE));
  } catch {
    return null;
  }
}

export function orderStandaloneTerminals(items) {
  const groups = new Map();
  for (const item of items) {
    if (!item.splitGroupId) continue;
    if (!groups.has(item.splitGroupId)) groups.set(item.splitGroupId, []);
    groups.get(item.splitGroupId).push(item);
  }
  for (const members of groups.values()) {
    members.sort((left, right) => (
      (Number.isInteger(left.splitGroupIndex) ? left.splitGroupIndex : Number.MAX_SAFE_INTEGER)
      - (Number.isInteger(right.splitGroupIndex) ? right.splitGroupIndex : Number.MAX_SAFE_INTEGER)
    ));
  }
  const emittedGroups = new Set();
  return items.flatMap((item) => {
    if (!item.splitGroupId) return [item];
    if (emittedGroups.has(item.splitGroupId)) return [];
    emittedGroups.add(item.splitGroupId);
    return groups.get(item.splitGroupId) || [item];
  });
}

export function organizePanelGroups(groups) {
  const collections = new Map();
  for (const group of groups) {
    const kind = group.type;
    const label = kind === 'repository' ? group.session?.repo || 'Repositories'
      : kind === 'scratchpad' ? 'Scratchpads'
        : kind === 'configured' ? 'Directories' : 'Terminals';
    const key = `${kind}:${label}`;
    if (!collections.has(key)) collections.set(key, { key, kind, label, groups: [] });
    collections.get(key).groups.push(group);
  }
  const priority = new Map([
    ['repository', 0], ['scratchpad', 1], ['configured', 2], ['terminal', 3],
  ]);
  return [...collections.values()].sort((left, right) => (
    (priority.get(left.kind) ?? 4) - (priority.get(right.kind) ?? 4)
  ));
}

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
  item, targetId, selected, highlighted, navigationKey,
  onHighlight, onActivate, onClose, onGroup, onMinimize, rowRef,
}) {
  const Icon = item.kind === 'editor' ? EditorIcon : ShellIcon;
  const type = item.kind === 'editor' ? 'Markdown' : 'terminal';
  const [dropTarget, setDropTarget] = useState(false);
  useEffect(() => {
    if (!dropTarget) return undefined;
    const clearDropTarget = () => setDropTarget(false);
    document.addEventListener('dragend', clearDropTarget, { once: true });
    return () => document.removeEventListener('dragend', clearDropTarget);
  }, [dropTarget]);
  const groupPosition = item.splitGroupId && (
    item.splitGroupIndex === 0
      ? 'start'
      : item.splitGroupIndex === item.splitGroupSize - 1 ? 'end' : 'middle'
  );
  return (
    <div
      className={`group/standalone grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center rounded-md transition-colors ${dropTarget ? 'bg-accent/20 outline-2 -outline-offset-2 outline-accent' : selected ? 'bg-row-highlight text-on-row-highlight' : highlighted ? 'outline-2 -outline-offset-2 outline-accent' : 'hover:bg-soft hover:text-on-soft'}`}
      data-sidebar-standalone={item.id}
      data-standalone-split-group={item.splitGroupId || undefined}
      data-terminal-group-position={groupPosition || undefined}
      onDragOver={(event) => {
        if (item.kind !== 'terminal'
            || !Array.from(event.dataTransfer.types || []).includes(STANDALONE_TERMINAL_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropTarget(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget(false);
      }}
      onDrop={(event) => {
        if (item.kind !== 'terminal') return;
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(false);
        const payload = terminalDragPayload(event.dataTransfer);
        if (payload?.targetId !== targetId || typeof payload.terminalId !== 'string') return;
        onGroup?.(payload.terminalId, item.id);
      }}
    >
      {item.kind === 'terminal' ? (
        <span
          draggable
          className={`relative ml-0.5 flex size-6 cursor-grab items-center justify-center rounded hover:bg-page/30 hover:opacity-100 active:cursor-grabbing ${groupPosition ? 'opacity-100' : 'opacity-60'}`}
          aria-label={`Drag ${item.label} into a terminal split`}
          title="Drag into the terminal view to split"
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(STANDALONE_TERMINAL_DRAG_TYPE, JSON.stringify({
              targetId, terminalId: item.id,
            }));
          }}
        >
          {groupPosition && (
            <>
              <span
                className={`pointer-events-none absolute left-1/2 z-0 w-0.5 -translate-x-1/2 bg-current ${groupPosition === 'start' ? 'top-1/2 -bottom-1' : groupPosition === 'end' ? '-top-1 bottom-1/2' : '-top-1 -bottom-1'}`}
                aria-hidden="true"
              />
              <span className="pointer-events-none absolute left-1/2 right-0 top-1/2 z-0 h-0.5 bg-current" aria-hidden="true" />
            </>
          )}
          <GripIcon className={`relative z-10 size-4 ${groupPosition ? 'rounded bg-page text-current' : ''}`} />
        </span>
      ) : <span className="w-1" aria-hidden="true" />}
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
      <div className="mr-1 flex shrink-0 items-center gap-0.5">
        {item.kind === 'terminal' && item.splitGroupId && (
          <button
            type="button"
            className="flex size-6 items-center justify-center rounded text-current opacity-60 transition-opacity hover:bg-page/30 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-accent"
            aria-label={`Minimize ${item.label} from split group`}
            title="Remove from split group; terminal keeps running"
            onClick={onMinimize}
          ><MinimizeIcon className="size-3.5" /></button>
        )}
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded text-current opacity-60 transition-opacity hover:bg-page/30 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-accent"
          aria-label={`Close ${item.label}`}
          title={`Close ${item.label}`}
          onClick={onClose}
        ><XIcon className="size-3.5" /></button>
      </div>
    </div>
  );
}

function PanelGroupNode({
  group, session, targetId, selected, highlighted, collapsed, navigationKey,
  onHighlight, onActivate, onToggle, onOpenResource, onMergeTerminalGroup,
  rowRef, resourceRowRef,
}) {
  const fallbackIcon = group.type === 'repository' ? 'git-branch'
    : group.type === 'scratchpad' ? 'folder' : group.type === 'configured' ? 'local' : null;
  const iconState = group.type === 'repository' && session ? branchState(session) : null;
  const hasChildren = group.resources.length > 0;
  const [dropTarget, setDropTarget] = useState(false);
  useEffect(() => {
    if (!dropTarget) return undefined;
    const clearDropTarget = () => setDropTarget(false);
    document.addEventListener('dragend', clearDropTarget, { once: true });
    return () => document.removeEventListener('dragend', clearDropTarget);
  }, [dropTarget]);
  return (
    <section className="min-w-0 pl-2" data-sidebar-panel-group={group.id}>
      <div
        className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center rounded-md ${dropTarget ? 'bg-accent/20 outline-2 -outline-offset-2 outline-accent' : selected ? 'bg-row-highlight text-on-row-highlight' : highlighted ? 'outline-2 -outline-offset-2 outline-accent' : 'hover:bg-soft hover:text-on-soft'}`}
        onDragOver={(event) => {
          if (group.type !== 'terminal'
              || !Array.from(event.dataTransfer.types || []).includes(STANDALONE_TERMINAL_DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTarget(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget(false);
        }}
        onDrop={(event) => {
          if (group.type !== 'terminal') return;
          event.preventDefault();
          event.stopPropagation();
          setDropTarget(false);
          const payload = terminalDragPayload(event.dataTransfer);
          if (payload?.targetId !== targetId || typeof payload.terminalGroupId !== 'string'
              || payload.terminalGroupId === group.id) return;
          onMergeTerminalGroup?.(payload.terminalGroupId, group.id);
        }}
      >
        {group.type === 'terminal' ? (
          <span
            draggable
            className="ml-0.5 flex size-6 cursor-grab items-center justify-center rounded opacity-65 hover:bg-page/30 hover:opacity-100 active:cursor-grabbing"
            aria-label={`Drag ${group.label} into another terminal group`}
            title="Drag into another terminal group"
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData(STANDALONE_TERMINAL_DRAG_TYPE, JSON.stringify({
                targetId, terminalGroupId: group.id,
              }));
            }}
          ><GripIcon className="size-4" /></span>
        ) : hasChildren ? (
          <button type="button" className="flex size-7 items-center justify-center" aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${group.label}`} aria-expanded={!collapsed} onClick={onToggle}>
            <ChevronIcon className={`size-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
          </button>
        ) : <span className="size-7" aria-hidden="true" />}
        <button
          ref={rowRef}
          type="button"
          className="flex min-w-0 items-center gap-1.5 px-1 py-1.5 text-left font-mono text-sm focus-visible:outline-2 focus-visible:outline-accent"
          aria-current={selected ? 'true' : undefined}
          onClick={onActivate}
          onFocus={() => onHighlight(navigationKey)}
        >
          {fallbackIcon
            ? <AssetIcon name={iconState?.icon || fallbackIcon} className={`size-3.5 shrink-0 ${iconState?.color || ''}`} title={iconState?.label} />
            : <ShellIcon className="size-3.5 shrink-0" />}
          <span className="truncate">{group.label}</span>
        </button>
        <span className="mr-2">{session ? <SessionActivity item={session} /> : <span className="text-[0.65rem] text-muted">{group.panels.length}</span>}</span>
      </div>
      {hasChildren && <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}>
        <div className="min-h-0 overflow-hidden">
          <div className="grid gap-0.5 pb-1 pl-7">
            {group.resources.map((resource) => {
              const key = resourceNavigationKey(targetId, resource.id);
              return (
                <button
                  key={resource.id}
                  ref={(node) => resourceRowRef(key, node)}
                  type="button"
                  data-sidebar-resource={resource.id}
                  className={`flex min-w-0 items-center gap-1.5 rounded px-2 py-1 text-left font-mono text-xs hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent ${resource.discovered ? 'opacity-80' : ''}`}
                  title={`${resource.value}${resource.discovered ? '\nAutomatically discovered session note' : ''}`}
                  onClick={() => onOpenResource(resource.id)}
                  onFocus={() => onHighlight(key)}
                >
                  {resource.kind === 'markdown' ? <EditorIcon className="size-3.5 shrink-0" /> : <LinkIcon className="size-3.5 shrink-0" />}
                  <span className="truncate">{resource.label}</span>
                  {resource.dirty && <span className="size-1.5 shrink-0 rounded-full bg-current" title="Unsaved changes" aria-label="Unsaved changes" />}
                  {resource.discovered && <span className="ml-auto text-[0.6rem] uppercase">auto</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>}
    </section>
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
  onActivateStandalone, onCloseStandalone, onGroupStandalone, onMinimizeStandalone,
  onCreateTerminal, onOpenMarkdown, onOpenResource,
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
    if (Array.isArray(section.panelGroups)) {
      const activeItems = new Map(section.items.map((item) => [String(item.id), item]));
      const panelGroups = section.panelGroups
        .filter((group) => group.type === 'terminal' || activeItems.has(String(group.ownerId)))
        .map((group) => ({ ...group, session: activeItems.get(String(group.ownerId)) || null }));
      return {
        ...section,
        panelGroups,
        panelGroupCollections: organizePanelGroups(panelGroups),
        workstreamGroups: [],
        groups: [],
      };
    }
    const workstreamGroups = groupActiveSessionsByRepo(section.items)
      .map((group) => ({ ...group, kind: 'workstream' }));
    const terminals = orderStandaloneTerminals(
      section.standaloneSessions.filter((item) => item.kind === 'terminal'),
    );
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
  // Unknown nodes remain collapsed, while nodes this browser has seen retain
  // their last explicit state across client refreshes.
  const [expandedTargets, setExpandedTargets] = useState(() => storedExpandedKeys('targets'));
  const [expandedGroups, setExpandedGroups] = useState(() => storedExpandedKeys('groups'));
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
    if (!expandedTargets.has(sectionId)) return [targetItem];
    if (section.panelGroups) {
      return [targetItem, ...section.panelGroupCollections.flatMap((collection) => {
        const collectionItem = {
          kind: 'panel-collection',
          key: groupNavigationKey(sectionId, 'panel-collection', collection.key),
          targetId: sectionId,
          groupKind: 'panel-collection',
          groupLabel: collection.key,
          collection,
        };
        if (!expandedGroups.has(collectionItem.key)) return [collectionItem];
        return [collectionItem, ...collection.groups.flatMap((group) => {
          const groupItem = {
            kind: 'panel-group', key: panelGroupNavigationKey(sectionId, group.id),
            targetId: sectionId, group, collection,
          };
          if (!expandedGroups.has(groupItem.key)) return [groupItem];
          return [groupItem, ...group.resources.map((resource) => ({
            kind: 'resource', key: resourceNavigationKey(sectionId, resource.id),
            targetId: sectionId, group, collection, resource,
          }))];
        })];
      })];
    }
    return [targetItem, ...section.groups.flatMap((group) => {
      const groupItem = {
        kind: 'group', key: groupNavigationKey(sectionId, group.kind, group.label),
        targetId: sectionId, groupKind: group.kind, groupLabel: group.label,
      };
      if (!expandedGroups.has(groupItem.key)) return [groupItem];
      return [groupItem, ...group.items.map((item) => (group.kind === 'standalone' ? {
        kind: 'standalone', key: standaloneNavigationKey(sectionId, item.id),
        targetId: sectionId, groupKind: group.kind, groupLabel: group.label, item,
      } : {
        kind: 'session', key: sessionNavigationKey(sectionId, item.id),
        targetId: sectionId, groupKind: group.kind, groupLabel: group.label, item,
      }))];
    })];
  }), [expandedGroups, expandedTargets, targetSections]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_TREE_STORAGE_KEY, JSON.stringify({
        targets: [...expandedTargets],
        groups: [...expandedGroups],
      }));
    } catch { /* browser storage is optional */ }
  }, [expandedGroups, expandedTargets]);

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
    const selectedKey = section.activePanelGroupId
      ? panelGroupNavigationKey(currentTargetId, section.activePanelGroupId)
      : section.activeStandaloneId
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
        if (current.kind === 'resource') {
          const groupKey = panelGroupNavigationKey(current.targetId, current.group.id);
          setHighlightedNavigationKey(groupKey);
          setPanelGroupCollapsed(current.targetId, current.group.id, true);
          requestAnimationFrame(() => navigationRows.current.get(groupKey)?.focus());
        } else if (current.kind === 'panel-group') {
          const collectionKey = groupNavigationKey(
            current.targetId, 'panel-collection', current.collection.key,
          );
          setHighlightedNavigationKey(collectionKey);
          setPanelGroupCollapsed(current.targetId, current.group.id, true);
          requestAnimationFrame(() => navigationRows.current.get(collectionKey)?.focus());
        } else if (current.kind === 'session' || current.kind === 'standalone') {
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
        if (current.kind === 'session' || current.kind === 'standalone' || current.kind === 'resource') return;
        event.preventDefault();
        if (current.kind === 'target') setTargetCollapsed(current.targetId, false);
        else if (current.kind === 'panel-group' && current.group.resources.length > 0) {
          setPanelGroupCollapsed(current.targetId, current.group.id, false);
        }
        else setGroupCollapsed(current.targetId, current.groupKind, current.groupLabel, false);
        return;
      }
      if (target?.closest('button')) return;
      event.preventDefault();
      if (current.kind === 'target') chooseTargetSection(current.targetId);
      else if (current.kind === 'group') toggleGroup(current.targetId, current.groupKind, current.groupLabel);
      else if (current.kind === 'panel-collection') toggleGroup(current.targetId, current.groupKind, current.groupLabel);
      else if (current.kind === 'panel-group') {
        if (current.group.type === 'terminal') onActivateStandalone(current.targetId, current.group.id);
        else if (current.group.session) onActivate(current.targetId, current.group.session);
      } else if (current.kind === 'resource') onOpenResource(current.targetId, current.resource.id);
      else if (current.kind === 'standalone') onActivateStandalone(current.targetId, current.item.id);
      else onActivate(current.targetId, current.item);
    }
    document.addEventListener('keydown', shortcuts);
    return () => document.removeEventListener('keydown', shortcuts);
  }, [currentTargetId, focusedPanel, highlightedNavigationKey, keyboardEnabled, navigationItems,
    onActivate, onActivateStandalone, onOpenResource, onTargetChange, open, sessionsPanel, view]);

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
    if (highlighted?.kind === 'panel-group') {
      if (highlighted.group.type === 'terminal') onActivateStandalone(highlighted.targetId, highlighted.group.id);
      else if (highlighted.group.session) onActivate(highlighted.targetId, highlighted.group.session);
      return;
    }
    if (highlighted?.kind === 'resource') {
      onOpenResource(highlighted.targetId, highlighted.resource.id);
      return;
    }
    onContentFocus();
  }

  function setTargetCollapsed(id, collapsed) {
    setExpandedTargets((current) => {
      if (current.has(id) === !collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.delete(id); else next.add(id);
      return next;
    });
  }

  function chooseTargetSection(id) {
    const collapsed = !expandedTargets.has(id);
    onTargetChange(id);
    if (collapsed) setTargetCollapsed(id, false);
    else if (id === currentTargetId) setTargetCollapsed(id, true);
  }

  function setGroupCollapsed(sectionId, kind, label, collapsed) {
    const key = groupNavigationKey(sectionId, kind, label);
    setExpandedGroups((current) => {
      if (current.has(key) === !collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleGroup(sectionId, kind, label) {
    const key = groupNavigationKey(sectionId, kind, label);
    setGroupCollapsed(sectionId, kind, label, expandedGroups.has(key));
  }

  function setPanelGroupCollapsed(sectionId, groupId, collapsed) {
    const key = panelGroupNavigationKey(sectionId, groupId);
    setExpandedGroups((current) => {
      if (current.has(key) === !collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.delete(key); else next.add(key);
      return next;
    });
  }

  function togglePanelGroup(sectionId, groupId) {
    const key = panelGroupNavigationKey(sectionId, groupId);
    setPanelGroupCollapsed(sectionId, groupId, expandedGroups.has(key));
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
        className={`relative h-full min-w-0 overflow-hidden border-r border-primary/35 bg-page ring-inset transition-opacity duration-200 ${focusedPanel === currentPanel ? 'ring-2 ring-accent/50' : ''} ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        aria-hidden={!open}
        inert={!open}
        data-panel={currentPanel}
        data-panel-focused={focusedPanel === currentPanel}
        onPointerEnter={() => onPanelFocus(currentPanel)}
        onPointerDownCapture={() => onPanelFocus(currentPanel)}
        onFocusCapture={() => onPanelFocus(currentPanel)}
      >
        <div className="sticky top-0 grid h-screen min-w-60 content-start gap-1 overflow-y-auto pr-1.5">
          <div className="border-b-4 border-accent px-2 pt-2 pb-2">
            <div className="flex min-w-0 items-center gap-2">
              <BrandLogo className="size-11 shrink-0 drop-shadow-sm" />
              <h1 className="truncate text-2xl font-black tracking-tight">FritzWorks</h1>
            </div>
          </div>
          {view === 'sessions' ? (
            <div id={`${sessionsPanel}-view`} aria-label="Sessions" className="grid min-w-0 content-start gap-1 pb-16">
              <div className="flex min-h-9 items-center justify-between gap-2 px-2">
                <h2 className="truncate text-sm font-bold text-primary">Sessions</h2>
              </div>
              {targetSections.map((section) => {
                const sectionId = section.target.id;
                const collapsed = !expandedTargets.has(sectionId);
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
                      aria-label={`${section.target.name}; ${connectionLabel}; ${section.panelGroups?.length ?? (section.items.length + section.standaloneSessions.length)} sessions`}
                      onClick={() => chooseTargetSection(sectionId)}
                      onFocus={() => setHighlightedNavigationKey(navigationKey)}
                    >
                      <ChevronIcon className={`size-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                      <AssetIcon name={sectionId === 'local' ? 'local' : 'remote'} className="size-4" />
                      <span className={`size-2 shrink-0 rounded-full ${CONNECTION_DOT_CLASS[section.connection] || CONNECTION_DOT_CLASS.connecting}`} aria-hidden="true" />
                      <span className="truncate">{section.target.name}</span>
                      {section.loading
                        ? <Spinner className="ml-auto size-3.5" />
                        : <span className={`ml-auto text-[0.65rem] font-normal tabular-nums ${highlighted ? 'text-on-row-highlight/70' : 'text-muted'}`}>{section.panelGroups?.length ?? (section.items.length + section.standaloneSessions.length)}</span>}
                    </button>
                    <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}>
                      <div className="min-h-0 overflow-hidden">
                        <div className="flex items-center gap-1.5 px-2 py-1.5" data-sidebar-session-actions={sectionId}>
                          <button
                            type="button"
                            className="inline-flex min-h-7 min-w-9 shrink-0 items-center justify-center gap-1 rounded-md border border-primary/60 px-2 text-xs font-semibold text-primary transition-colors hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent"
                            aria-label={`New repository session on ${section.target.name}`}
                            title={`New repository session on ${section.target.name}`}
                            onClick={() => onNewRepo(sectionId)}
                          ><span className="text-sm font-bold" aria-hidden="true">+</span><AssetIcon name="git-branch" className="size-3.5" /></button>
                          <button
                            type="button"
                            className="inline-flex min-h-7 min-w-9 shrink-0 items-center justify-center gap-1 rounded-md border border-primary/60 px-2 text-xs font-semibold text-primary transition-colors hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent"
                            aria-label={`New scratchpad session on ${section.target.name}`}
                            title={`New scratchpad session on ${section.target.name}`}
                            onClick={() => onNewScratchpad(sectionId)}
                          ><span className="text-sm font-bold" aria-hidden="true">+</span><AssetIcon name="folder" className="size-3.5" /></button>
                          <button
                            type="button"
                            className="inline-flex min-h-7 min-w-9 shrink-0 items-center justify-center gap-1 rounded-md border border-primary/60 px-2 text-xs font-semibold text-primary transition-colors hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent"
                            aria-label={`New ${section.target.name} terminal`}
                            title={`New ${section.target.name} terminal`}
                            onClick={() => onCreateTerminal(sectionId)}
                          ><span className="text-sm font-bold" aria-hidden="true">+</span><ShellIcon className="size-3.5" /></button>
                          {!section.panelGroups && <button
                            type="button"
                            className="inline-flex min-h-7 min-w-0 flex-1 items-center justify-center gap-1 overflow-hidden rounded-md border border-primary/60 px-1 text-xs font-semibold text-primary transition-colors hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent"
                            aria-label={`Open ${section.target.name} Markdown`}
                            title={`Open ${section.target.name} Markdown`}
                            onClick={() => onOpenMarkdown(sectionId)}
                          ><span className="text-sm font-bold" aria-hidden="true">+</span><EditorIcon className="size-3.5 shrink-0" /><span className="truncate">Markdown</span></button>}
                        </div>
                        {section.error && <p className="m-1 rounded border border-danger/40 bg-danger/10 p-2 text-xs text-danger">{section.error}</p>}
                        {!section.loading && !section.error && section.workstreamGroups.length === 0 && (!section.panelGroups || section.panelGroups.length === 0) && <p className="px-3 py-2 text-xs text-muted">No active or paused workstreams.</p>}
                        {section.panelGroupCollections?.map((collection) => {
                          const collectionKey = groupNavigationKey(
                            sectionId, 'panel-collection', collection.key,
                          );
                          const collectionCollapsed = !expandedGroups.has(collectionKey);
                          const collectionHighlighted = highlightedNavigationKey === collectionKey;
                          return (
                            <section key={collection.key} className="min-w-0 pl-2">
                              <button
                                ref={(node) => {
                                  if (node) navigationRows.current.set(collectionKey, node); else navigationRows.current.delete(collectionKey);
                                }}
                                type="button"
                                data-sidebar-group={collection.label}
                                className={`flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-sm font-bold transition-colors focus-visible:outline-2 focus-visible:outline-accent ${collectionHighlighted ? 'bg-row-highlight text-on-row-highlight outline-2 -outline-offset-2 outline-accent' : 'text-primary hover:bg-soft hover:text-on-soft'}`}
                                aria-expanded={!collectionCollapsed}
                                onClick={() => toggleGroup(
                                  sectionId, 'panel-collection', collection.key,
                                )}
                                onFocus={() => setHighlightedNavigationKey(collectionKey)}
                              >
                                <ChevronIcon className={`size-3.5 transition-transform ${collectionCollapsed ? '-rotate-90' : ''}`} />
                                <span className="truncate">{collection.label}</span>
                                <span className={`ml-auto text-[0.65rem] font-normal tabular-nums ${collectionHighlighted ? 'text-on-row-highlight/70' : 'text-muted'}`}>{collection.groups.length}</span>
                              </button>
                              <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${collectionCollapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}>
                                <div className="min-h-0 overflow-hidden">
                                  {collection.groups.map((group) => {
                                    const itemKey = panelGroupNavigationKey(sectionId, group.id);
                                    return (
                                      <PanelGroupNode
                                        key={group.id}
                                        group={group}
                                        session={group.session}
                                        targetId={sectionId}
                                        selected={section.activePanelGroupId === group.id}
                                        highlighted={highlightedNavigationKey === itemKey}
                                        collapsed={!expandedGroups.has(itemKey)}
                                        navigationKey={itemKey}
                                        onHighlight={setHighlightedNavigationKey}
                                        onActivate={() => {
                                          if (group.type === 'terminal') onActivateStandalone(sectionId, group.id);
                                          else if (group.session) onActivate(sectionId, group.session);
                                        }}
                                        onToggle={() => togglePanelGroup(sectionId, group.id)}
                                        onOpenResource={(resourceId) => onOpenResource(sectionId, resourceId)}
                                        onMergeTerminalGroup={(sourceId, destinationId) => (
                                          onGroupStandalone(sectionId, sourceId, destinationId)
                                        )}
                                        rowRef={(node) => {
                                          if (node) navigationRows.current.set(itemKey, node); else navigationRows.current.delete(itemKey);
                                        }}
                                        resourceRowRef={(key, node) => {
                                          if (node) navigationRows.current.set(key, node); else navigationRows.current.delete(key);
                                        }}
                                      />
                                    );
                                  })}
                                </div>
                              </div>
                            </section>
                          );
                        })}
                        {section.groups.map((group) => {
                          const groupKey = groupNavigationKey(sectionId, group.kind, group.label);
                          const groupCollapsed = !expandedGroups.has(groupKey);
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
                                            targetId={sectionId}
                                            selected={String(section.activeStandaloneId) === String(item.id)}
                                            navigationKey={itemKey}
                                            highlighted={highlightedNavigationKey === itemKey}
                                            onHighlight={setHighlightedNavigationKey}
                                            onActivate={() => onActivateStandalone(sectionId, item.id)}
                                            onClose={() => onCloseStandalone(sectionId, item.id)}
                                            onMinimize={() => onMinimizeStandalone?.(sectionId, item.id)}
                                            onGroup={(sourceId, destinationId) => (
                                              onGroupStandalone(sectionId, sourceId, destinationId)
                                            )}
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
            <div id={`${panelName('settings')}-view`} aria-label="Settings" className="grid content-start gap-5 px-2 pt-3 pb-16">
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
        {view === 'sessions' ? (
          <button
            type="button"
            className="absolute right-3 bottom-3 z-10 flex size-10 items-center justify-center rounded-full border border-primary/60 bg-page text-primary shadow-md transition-colors hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            aria-label="Open settings"
            aria-controls={`${panelName('settings')}-view`}
            title="Settings"
            onClick={() => chooseView('settings')}
          >
            <GearIcon className="size-5" />
          </button>
        ) : (
          <button
            type="button"
            className="absolute right-3 bottom-3 z-10 flex h-10 w-16 items-center justify-center gap-1 rounded-full border border-primary/60 bg-page text-primary shadow-md transition-colors hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            aria-label="Back to sessions"
            aria-controls={`${sessionsPanel}-view`}
            title="Back to sessions"
            onClick={() => chooseView('sessions')}
          >
            <ArrowLeftIcon className="size-4" />
            <AssetIcon name="folder" className="size-5" />
          </button>
        )}
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
