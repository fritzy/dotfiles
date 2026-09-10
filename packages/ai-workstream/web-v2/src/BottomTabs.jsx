import {
  forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from 'react';

import {
  readBrowserState, readEditorTabs, writeBrowserState, writeEditorTabs,
} from './api.js';
import { MinimizeIcon, ShellIcon } from './icons.jsx';
import NotePicker from './NotePicker.jsx';
import { useTarget } from './target-context.js';
import { STANDALONE_TERMINAL_DRAG_TYPE } from './constants.js';
import TerminalPanel, {
  clampTerminalFontSize, DEFAULT_TERMINAL_FONT_SIZE,
} from './TerminalPanel.jsx';
import TerminalSplitLayout, {
  defaultSplitBoundaries, normalizeSplitBoundaries,
} from './TerminalSplitLayout.jsx';

const MarkdownEditor = lazy(() => import('./MarkdownEditor.jsx'));

const TAB_SAVE_DEBOUNCE_MS = 400;
const EDITOR_TAB_SCOPE = 'global';
const TERMINAL_STATE_SCOPE = 'bottom-terminals';
const TERMINAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_SPLIT_TERMINALS = 3;
const MAX_TERMINAL_LABEL_LENGTH = 80;

let fallbackTerminalId = 0;
let fallbackSplitId = 0;

function newTerminalId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `terminal-${uuid}`;
  fallbackTerminalId += 1;
  return `terminal-${Date.now().toString(36)}-${fallbackTerminalId}`;
}

function newSplitId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `split-${uuid}`;
  fallbackSplitId += 1;
  return `split-${Date.now().toString(36)}-${fallbackSplitId}`;
}

function terminalLabel(value, fallback) {
  const label = typeof value === 'string' ? value.trim().slice(0, MAX_TERMINAL_LABEL_LENGTH) : '';
  return label || fallback;
}

export function normalizeTerminalSplitGroups(groups, terminalIds) {
  const available = new Set(terminalIds);
  const assigned = new Set();
  const groupIds = new Set();
  const normalized = [];
  for (const group of (Array.isArray(groups) ? groups : []).slice(0, 25)) {
    if (!group || !TERMINAL_ID_PATTERN.test(group.id || '') || groupIds.has(group.id)) continue;
    const members = [];
    for (const id of Array.isArray(group.members) ? group.members : []) {
      if (members.length === MAX_SPLIT_TERMINALS) break;
      if (typeof id !== 'string' || !available.has(id) || assigned.has(id) || members.includes(id)) continue;
      members.push(id);
    }
    if (members.length < 2) continue;
    members.forEach((id) => assigned.add(id));
    groupIds.add(group.id);
    normalized.push({
      id: group.id,
      members,
      boundaries: normalizeSplitBoundaries(
        Array.isArray(group.boundaries) ? group.boundaries.slice(0, members.length - 1) : group.boundaries,
        members.length,
      ),
    });
  }
  return normalized;
}

const editorTabId = (path, source = 'notes') => `editor:${source}:${path}`;

const editorPathFromId = (id) => {
  if (!id?.startsWith('editor:')) return null;
  const pathAt = id.indexOf(':', 'editor:'.length);
  return pathAt === -1 ? null : id.slice(pathAt + 1);
};

function editorTab({ path, name, source = 'notes' }) {
  return {
    id: editorTabId(path, source),
    kind: 'editor',
    label: name || path.split('/').pop(),
    path,
    source,
    fontSize: DEFAULT_TERMINAL_FONT_SIZE,
    fullscreen: false,
  };
}

function EditableTerminalTitle({ tab, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.label);

  useEffect(() => { if (!editing) setDraft(tab.label); }, [editing, tab.label]);

  function commit() {
    if (!editing) return;
    onRename(tab.id, draft);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        className="min-w-0 flex-1 rounded border border-accent bg-page px-1 py-0.5 font-mono text-xs font-bold text-primary outline-none"
        aria-label={`Rename ${tab.label}`}
        value={draft}
        maxLength={MAX_TERMINAL_LABEL_LENGTH}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit(); }
          if (event.key === 'Escape') { event.preventDefault(); setDraft(tab.label); setEditing(false); }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent"
      aria-label={`Rename ${tab.label}`}
      title={`${tab.label} · click to rename`}
      onClick={() => { setDraft(tab.label); setEditing(true); }}
    >{tab.label}</button>
  );
}

// Standalone terminals and Markdown files used to be selected from a tab strip
// attached to a bottom drawer. Their state still belongs to the target daemon,
// but their selectors now live in the shared sidebar and the selected session
// occupies the same main content area as a workstream.
const BottomTabs = forwardRef(function BottomTabs({
  visible = true, focusedPanel, onPanelFocus,
  terminalMode = 'dark', fontFamily = '"Roboto Mono", monospace', onFullscreenChange,
  fullscreenExitRevision, onSidebarFocus, onToggleSidebar, onSessionsChange,
  onCloseActive, leftOffset = '0rem', stateRevision = 0,
}, ref) {
  const target = useTarget();
  const targetId = target?.id || 'local';
  const panelId = (id) => `standalone-${targetId}-${id}`;
  const fullscreenSource = `standalone-${targetId}`;
  const [tabs, setTabs] = useState([]);
  const [splitGroups, setSplitGroups] = useState([]);
  const [active, setActive] = useState(null);
  const [dropSide, setDropSide] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dirtyPaths, setDirtyPaths] = useState(() => new Set());
  const [lastEditorPath, setLastEditorPath] = useState(null);
  const [tabsRestored, setTabsRestored] = useState(false);
  const [terminalTabsRestored, setTerminalTabsRestored] = useState(false);
  const nextTerminalNumber = useRef(1);
  const lastUsedRef = useRef(null);
  const activeRef = useRef(active);
  const terminalControlsRef = useRef(new Map());
  const fullscreenReportedRef = useRef(false);
  const skipTerminalStateSaveRef = useRef(false);
  const activeTab = tabs.find((tab) => tab.id === active) || null;
  const activeGroup = activeTab?.kind === 'terminal'
    ? splitGroups.find((group) => group.members.includes(activeTab.id)) || null
    : null;
  const visibleTerminalIds = activeGroup?.members
    || (activeTab?.kind === 'terminal' ? [activeTab.id] : []);
  const activePanel = activeTab ? panelId(activeTab.id) : null;
  const activeFullscreen = Boolean(activeTab?.fullscreen);
  activeRef.current = active;

  // Restoring a terminal mounts it even when it is not selected, allowing it to
  // reclaim its persistent background Zellij session immediately.
  useEffect(() => {
    setTerminalTabsRestored(false);
    const controller = new AbortController();
    readBrowserState(TERMINAL_STATE_SCOPE, controller.signal, target)
      .then(({ state = {} }) => {
        if (controller.signal.aborted) return;
        const seenIds = new Set();
        const restored = (Array.isArray(state.terminals) ? state.terminals : [])
          .slice(0, 50)
          .filter((tab) => {
            if (tab?.kind !== 'terminal' || !TERMINAL_ID_PATTERN.test(tab.id || '') || seenIds.has(tab.id)) return false;
            seenIds.add(tab.id);
            return true;
          })
          .map((tab, index) => ({
            id: tab.id,
            kind: 'terminal',
            label: terminalLabel(tab.label, `terminal ${index + 1}`),
            fontSize: clampTerminalFontSize(tab.fontSize),
            fullscreen: false,
          }));
        skipTerminalStateSaveRef.current = true;
        setTabs((current) => [...restored, ...current.filter((tab) => tab.kind === 'editor')]);
        const restoredIds = new Set(restored.map((tab) => tab.id));
        setSplitGroups(normalizeTerminalSplitGroups(state.groups, restoredIds));
        if (activeRef.current && !activeRef.current.startsWith('editor:')
            && !restoredIds.has(activeRef.current)) setActive(null);
        if (restored.length) {
          const remembered = restored.some((tab) => tab.id === state.displayedId)
            ? state.displayedId : restored.at(-1).id;
          if (!lastUsedRef.current) lastUsedRef.current = remembered;
          nextTerminalNumber.current = Math.max(
            nextTerminalNumber.current,
            ...restored.map((tab) => Number(tab.label.match(/^terminal (\d+)$/)?.[1]) + 1 || 1),
          );
        }
      })
      .catch(() => { /* older daemons simply start without remembered terminals */ })
      .finally(() => { if (!controller.signal.aborted) setTerminalTabsRestored(true); });
    return () => controller.abort();
  }, [stateRevision, target]);

  useEffect(() => {
    if (!terminalTabsRestored) return undefined;
    if (skipTerminalStateSaveRef.current) {
      skipTerminalStateSaveRef.current = false;
      return undefined;
    }
    const terminals = tabs.filter((tab) => tab.kind === 'terminal');
    const timer = setTimeout(() => {
      writeBrowserState(TERMINAL_STATE_SCOPE, {
        version: 2,
        terminals: terminals.map((tab) => ({
          id: tab.id,
          kind: 'terminal',
          label: tab.label,
          fontSize: tab.fontSize,
        })),
        groups: splitGroups.map((group) => ({
          id: group.id,
          members: group.members,
          boundaries: group.boundaries,
        })),
        displayedId: terminals.some((tab) => tab.id === active) ? active : null,
      }, target).catch(() => { /* remembering terminals is best-effort */ });
    }, TAB_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, splitGroups, tabs, target, terminalTabsRestored]);

  useEffect(() => {
    const controller = new AbortController();
    readEditorTabs(EDITOR_TAB_SCOPE, controller.signal, target)
      .then((state) => {
        if (controller.signal.aborted) return;
        const restored = (state.tabs || []).map(editorTab);
        if (restored.length) setTabs((current) => [...current, ...restored]);
        if (state.activePath) setLastEditorPath(state.activePath);
        const remembered = restored.find((tab) => tab.path === state.activePath) || restored.at(-1);
        if (remembered) lastUsedRef.current = remembered.id;
      })
      .catch(() => { /* the editor still works without remembered tabs */ })
      .finally(() => { if (!controller.signal.aborted) setTabsRestored(true); });
    return () => controller.abort();
  }, [target]);

  useEffect(() => {
    if (!tabsRestored) return undefined;
    const openPaths = tabs.filter((tab) => tab.kind === 'editor')
      .map((tab) => ({ source: tab.source, path: tab.path }));
    const timer = setTimeout(() => {
      writeEditorTabs(EDITOR_TAB_SCOPE, openPaths, lastEditorPath, target)
        .catch(() => { /* remembering tabs is best-effort */ });
    }, TAB_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [lastEditorPath, tabs, tabsRestored, target]);

  useEffect(() => {
    onSessionsChange?.({
      items: tabs.map((tab) => {
        const splitGroup = splitGroups.find((group) => group.members.includes(tab.id));
        return {
          id: tab.id,
          kind: tab.kind,
          label: tab.label,
          path: tab.path,
          dirty: tab.kind === 'editor' && dirtyPaths.has(tab.path),
          splitGroupId: splitGroup?.id || null,
          splitGroupIndex: splitGroup ? splitGroup.members.indexOf(tab.id) : null,
          splitGroupSize: splitGroup?.members.length || null,
        };
      }),
      activeId: active,
    });
  }, [active, dirtyPaths, onSessionsChange, splitGroups, tabs]);

  useEffect(() => {
    const fullscreenVisible = visible && Boolean(activeTab) && activeFullscreen;
    if (fullscreenReportedRef.current === fullscreenVisible) return;
    fullscreenReportedRef.current = fullscreenVisible;
    onFullscreenChange?.(fullscreenSource, fullscreenVisible);
  }, [activeFullscreen, activeTab, fullscreenSource, onFullscreenChange, visible]);

  useEffect(() => () => {
    if (fullscreenReportedRef.current) onFullscreenChange?.(fullscreenSource, false);
    fullscreenReportedRef.current = false;
  }, [fullscreenSource, onFullscreenChange]);

  const leaveFullscreen = useCallback(() => {
    if (!tabs.some((tab) => tab.fullscreen)) return false;
    onFullscreenChange?.(fullscreenSource, false);
    setTabs((current) => current.map((tab) => (tab.fullscreen ? { ...tab, fullscreen: false } : tab)));
    return true;
  }, [fullscreenSource, onFullscreenChange, tabs]);

  useEffect(() => {
    leaveFullscreen();
  }, [fullscreenExitRevision]);

  const remember = useCallback((id) => {
    lastUsedRef.current = id;
    const path = editorPathFromId(id);
    if (path) setLastEditorPath(path);
  }, []);

  const activate = useCallback((id) => {
    if (!id || !tabs.some((tab) => tab.id === id)) return false;
    if (id !== activeRef.current) leaveFullscreen();
    remember(id);
    setActive(id);
    onPanelFocus(panelId(id));
    return true;
  }, [leaveFullscreen, onPanelFocus, remember, tabs, targetId]);

  const deactivate = useCallback(() => {
    if (!activeRef.current) return false;
    leaveFullscreen();
    setActive(null);
    return true;
  }, [leaveFullscreen]);

  const createTerminal = useCallback(() => {
    const number = nextTerminalNumber.current;
    nextTerminalNumber.current += 1;
    const terminal = {
      id: newTerminalId(),
      kind: 'terminal',
      label: `terminal ${number}`,
      fontSize: DEFAULT_TERMINAL_FONT_SIZE,
      fullscreen: false,
    };
    setTabs((current) => [...current, terminal]);
    remember(terminal.id);
    setActive(terminal.id);
    onPanelFocus(panelId(terminal.id));
    return true;
  }, [onPanelFocus, remember, targetId]);

  const openNote = useCallback((file) => {
    setPickerOpen(false);
    const id = editorTabId(file.path, file.source);
    setTabs((current) => (current.some((tab) => tab.id === id) ? current : [...current, editorTab(file)]));
    remember(id);
    setActive(id);
    onPanelFocus(panelId(id));
    return true;
  }, [onPanelFocus, remember, targetId]);

  const focusLastUsed = useCallback(() => {
    const remembered = lastUsedRef.current;
    const id = tabs.some((tab) => tab.id === remembered) ? remembered : tabs.at(-1)?.id;
    return id ? activate(id) : createTerminal();
  }, [activate, createTerminal, tabs]);

  const markDirty = useCallback((path, dirty) => {
    setDirtyPaths((current) => {
      if (current.has(path) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(path); else next.delete(path);
      return next;
    });
  }, []);

  const closeTab = useCallback((id) => {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return false;
    if (tab.kind === 'editor') {
      if (dirtyPaths.has(tab.path)
          && !window.confirm(`${tab.label} has unsaved changes. Close it anyway?`)) return false;
      markDirty(tab.path, false);
      if (lastEditorPath === tab.path) {
        const nextEditor = tabs.filter((item) => item.kind === 'editor' && item.id !== id).at(-1);
        setLastEditorPath(nextEditor?.path || null);
      }
    }
    if (tab.kind === 'terminal') terminalControlsRef.current.get(id)?.terminate();
    const wasActive = activeRef.current === id;
    const remaining = tabs.filter((item) => item.id !== id);
    const group = splitGroups.find((item) => item.members.includes(id));
    const groupMembers = group?.members.filter((member) => member !== id) || [];
    const groupedFallback = groupMembers.find((member) => remaining.some((item) => item.id === member)) || null;
    if (lastUsedRef.current === id) lastUsedRef.current = groupedFallback || remaining.at(-1)?.id || null;
    setSplitGroups((current) => current.flatMap((item) => {
      if (!item.members.includes(id)) return [item];
      const members = item.members.filter((member) => member !== id);
      return members.length < 2 ? [] : [{
        ...item, members, boundaries: defaultSplitBoundaries(members.length),
      }];
    }));
    setTabs(remaining);
    if (wasActive) {
      leaveFullscreen();
      if (groupedFallback) {
        remember(groupedFallback);
        setActive(groupedFallback);
        onPanelFocus(panelId(groupedFallback));
      } else {
        setActive(null);
        onCloseActive?.();
      }
    }
    return true;
  }, [dirtyPaths, lastEditorPath, leaveFullscreen, markDirty, onCloseActive,
    onPanelFocus, remember, splitGroups, tabs, targetId]);

  const focusTerminalPanel = useCallback((id) => {
    if (!tabs.some((tab) => tab.id === id && tab.kind === 'terminal')) return false;
    remember(id);
    setActive(id);
    onPanelFocus(panelId(id));
    return true;
  }, [onPanelFocus, remember, tabs, targetId]);

  const groupTerminals = useCallback((id, destination, side = 'right') => {
    if (!destination) return false;
    if (!tabs.some((tab) => tab.id === destination && tab.kind === 'terminal')
        || !tabs.some((tab) => tab.id === id && tab.kind === 'terminal')) return false;
    if (id === destination) return focusTerminalPanel(id);
    const destinationGroup = splitGroups.find((group) => group.members.includes(destination));
    const sourceGroup = splitGroups.find((group) => group.members.includes(id));
    if (destinationGroup && sourceGroup?.id !== destinationGroup.id
        && destinationGroup.members.length >= MAX_SPLIT_TERMINALS) return false;
    leaveFullscreen();
    if (destinationGroup && destinationGroup.id === sourceGroup?.id) {
      const withoutSource = destinationGroup.members.filter((member) => member !== id);
      const members = side === 'left' ? [id, ...withoutSource] : [...withoutSource, id];
      setSplitGroups((current) => current.map((group) => (group.id === destinationGroup.id
        ? { ...group, members, boundaries: defaultSplitBoundaries(members.length) } : group)));
    } else {
      let next = splitGroups.flatMap((group) => {
        if (group.id !== sourceGroup?.id) return [group];
        const members = group.members.filter((member) => member !== id);
        return members.length < 2 ? [] : [{
          ...group, members, boundaries: defaultSplitBoundaries(members.length),
        }];
      });
      if (destinationGroup) {
        const members = side === 'left'
          ? [id, ...destinationGroup.members]
          : [...destinationGroup.members, id];
        next = next.map((group) => (group.id === destinationGroup.id
          ? { ...group, members, boundaries: defaultSplitBoundaries(members.length) }
          : group));
      } else {
        const members = side === 'left' ? [id, destination] : [destination, id];
        next.push({ id: newSplitId(), members, boundaries: defaultSplitBoundaries(members.length) });
      }
      setSplitGroups(next);
    }
    focusTerminalPanel(id);
    return true;
  }, [focusTerminalPanel, leaveFullscreen, splitGroups, tabs]);

  const splitWithActive = useCallback((id, side = 'right') => (
    groupTerminals(id, activeRef.current, side)
  ), [groupTerminals]);

  const minimizeTerminal = useCallback((id) => {
    const group = splitGroups.find((item) => item.members.includes(id));
    if (!group) return false;
    const index = group.members.indexOf(id);
    const members = group.members.filter((member) => member !== id);
    const fallback = members[Math.min(index, members.length - 1)] || null;
    leaveFullscreen();
    setSplitGroups((current) => current.flatMap((item) => {
      if (item.id !== group.id) return [item];
      return members.length < 2 ? [] : [{
        ...item, members, boundaries: defaultSplitBoundaries(members.length),
      }];
    }));
    // Keeping a surviving member selected also handles a click on the minimize
    // button before React has committed that pane's pointer-focus update.
    if (fallback) focusTerminalPanel(fallback);
    return true;
  }, [focusTerminalPanel, leaveFullscreen, splitGroups]);

  const renameTerminal = useCallback((id, value) => {
    setTabs((current) => current.map((tab) => (tab.id === id && tab.kind === 'terminal'
      ? { ...tab, label: terminalLabel(value, tab.label) }
      : tab)));
  }, []);

  useImperativeHandle(ref, () => ({
    activate,
    close: closeTab,
    createTerminal,
    focusLastUsed,
    hide: deactivate,
    openMarkdown: () => setPickerOpen(true),
    openNote,
    groupTerminals,
    splitTerminal: splitWithActive,
    minimizeTerminal,
    renameTerminal,
  }), [activate, closeTab, createTerminal, deactivate, focusLastUsed, groupTerminals,
    minimizeTerminal, openNote, renameTerminal, splitWithActive]);

  function changeFontSize(id, amount) {
    setTabs((current) => current.map((tab) => (tab.id === id
      ? { ...tab, fontSize: clampTerminalFontSize(tab.fontSize + amount) }
      : tab)));
  }

  function toggleFullscreen(id) {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;
    onFullscreenChange?.(fullscreenSource, !tab.fullscreen);
    setTabs((current) => current.map((item) => ({
      ...item, fullscreen: item.id === id ? !item.fullscreen : false,
    })));
    focusTerminalPanel(id);
  }

  function navigateStandalonePanel(id, direction) {
    const group = splitGroups.find((item) => item.members.includes(id));
    const members = group?.members || [id];
    const index = members.indexOf(id);
    const next = members[index + direction];
    if (next) {
      leaveFullscreen();
      return focusTerminalPanel(next);
    }
    if (direction >= 0 || index > 0) return false;
    leaveFullscreen();
    return typeof onSidebarFocus === 'function' ? onSidebarFocus() : false;
  }

  function navigateEditorPanel(direction) {
    if (direction >= 0) return false;
    leaveFullscreen();
    return typeof onSidebarFocus === 'function' ? onSidebarFocus() : false;
  }

  function changeGroupBoundary(groupId, index, value) {
    setSplitGroups((current) => current.map((group) => (group.id === groupId
      ? { ...group, boundaries: group.boundaries.map((boundary, boundaryIndex) => (
        boundaryIndex === index ? value : boundary
      )) }
      : group)));
  }

  function resetGroupBoundaries(groupId, count) {
    setSplitGroups((current) => current.map((group) => (group.id === groupId
      ? { ...group, boundaries: defaultSplitBoundaries(count) }
      : group)));
  }

  function dragPayload(dataTransfer) {
    try {
      return JSON.parse(dataTransfer.getData(STANDALONE_TERMINAL_DRAG_TYPE));
    } catch {
      return null;
    }
  }

  function dragOverTerminal(event) {
    if (activeTab?.kind !== 'terminal' || (activeGroup?.members.length || 1) >= MAX_SPLIT_TERMINALS
        || !Array.from(event.dataTransfer.types || []).includes(STANDALONE_TERMINAL_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    setDropSide(event.clientX < rect.left + rect.width / 2 ? 'left' : 'right');
  }

  function dropTerminal(event) {
    event.preventDefault();
    const payload = dragPayload(event.dataTransfer);
    const side = dropSide || 'right';
    setDropSide(null);
    if (payload?.targetId !== targetId || typeof payload.terminalId !== 'string') return;
    splitWithActive(payload.terminalId, side);
  }

  useEffect(() => {
    if (!dropSide) return undefined;
    const finish = () => setDropSide(null);
    document.addEventListener('dragend', finish, { once: true });
    return () => document.removeEventListener('dragend', finish);
  }, [dropSide]);

  const openEditorPaths = new Set(tabs.filter((tab) => tab.kind === 'editor').map((tab) => tab.path));
  const terminalViewActive = activeTab?.kind === 'terminal';
  const editorViewActive = activeTab?.kind === 'editor';

  return (
    <div
      className={visible ? 'contents' : 'hidden'}
      aria-label={`${target?.name || 'Local'} standalone terminal and Markdown sessions`}
      data-standalone-sessions={targetId}
      inert={!visible}
    >
      <section
        aria-label={terminalViewActive ? `${activeTab.label} standalone terminal group` : undefined}
        aria-hidden={!terminalViewActive}
        className={`${terminalViewActive ? 'flex' : 'hidden'} absolute inset-0 z-20 min-h-0 flex-col overflow-hidden bg-page text-ink`}
        data-standalone-terminal-group={activeGroup?.id || activeTab?.id || undefined}
        onDragOver={dragOverTerminal}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setDropSide(null);
        }}
        onDrop={dropTerminal}
      >
        <TerminalSplitLayout
          count={visibleTerminalIds.length}
          boundaries={activeGroup?.boundaries || []}
          fullscreen={activeFullscreen}
          onBoundaryChange={(index, value) => {
            if (activeGroup) changeGroupBoundary(activeGroup.id, index, value);
          }}
          onBoundaryFocus={(index) => {
            const id = visibleTerminalIds[index];
            if (id) focusTerminalPanel(id);
          }}
          onResetBoundaries={() => {
            if (activeGroup) resetGroupBoundaries(activeGroup.id, visibleTerminalIds.length);
          }}
        >
          {tabs.filter((tab) => tab.kind === 'terminal').map((tab) => {
            const shownInGroup = visibleTerminalIds.includes(tab.id);
            const shown = shownInGroup && (!activeFullscreen || active === tab.id);
            const group = splitGroups.find((item) => item.members.includes(tab.id));
            return (
              <TerminalPanel
                key={tab.id}
                panelName={panelId(tab.id)}
                label={tab.label}
                titleContent={<EditableTerminalTitle tab={tab} onRename={renameTerminal} />}
                Icon={ShellIcon}
                shown={shown}
                visible={visible && terminalViewActive}
                focused={focusedPanel === panelId(tab.id)}
                fullscreen={activeFullscreen && active === tab.id}
                onPanelFocus={() => focusTerminalPanel(tab.id)}
                onToggleFullscreen={() => toggleFullscreen(tab.id)}
                onFontSizeChange={(delta) => changeFontSize(tab.id, delta)}
                headerActions={group ? (
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded border border-primary bg-page text-primary transition-colors hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent"
                    aria-label={`Minimize ${tab.label} from split group`}
                    title="Remove from split group; terminal keeps running"
                    onClick={() => minimizeTerminal(tab.id)}
                  ><MinimizeIcon className="size-3.5" /></button>
                ) : null}
                target={target}
                terminalId={tab.id}
                onControlReady={(controls) => {
                  if (controls) terminalControlsRef.current.set(tab.id, controls);
                  else terminalControlsRef.current.delete(tab.id);
                }}
                fontSize={tab.fontSize}
                fontFamily={fontFamily}
                themeMode={terminalMode}
                onPanelNavigate={(direction) => navigateStandalonePanel(tab.id, direction)}
                onToggleSidebar={onToggleSidebar}
                onNewTerminal={createTerminal}
                onExit={() => closeTab(tab.id)}
                terminalLabel={tab.label}
              />
            );
          })}
        </TerminalSplitLayout>
        {dropSide && (
          <div className="pointer-events-none absolute inset-0 z-40 grid grid-cols-2 gap-1 bg-page/30 p-3" aria-hidden="true">
            <div className={`rounded-lg border-2 border-dashed ${dropSide === 'left' ? 'border-accent bg-accent/20' : 'border-primary/25'}`} />
            <div className={`rounded-lg border-2 border-dashed ${dropSide === 'right' ? 'border-accent bg-accent/20' : 'border-primary/25'}`} />
            <div className="absolute inset-0 flex items-center justify-center font-mono text-sm font-bold text-primary">Drop to add terminal to this split</div>
          </div>
        )}
      </section>

      <section
        id={editorViewActive ? `${activePanel}-panel` : undefined}
        aria-label={editorViewActive ? `${activeTab.label} standalone session` : undefined}
        aria-hidden={!editorViewActive}
        className={`${editorViewActive ? 'flex' : 'hidden'} absolute inset-0 z-20 min-h-0 overflow-hidden bg-page text-ink ring-inset ${focusedPanel === activePanel ? 'ring-2 ring-accent/60' : ''}`}
        data-panel={editorViewActive ? activePanel : undefined}
        data-panel-focused={Boolean(editorViewActive && focusedPanel === activePanel)}
        data-terminal-fullscreen={editorViewActive && activeFullscreen}
        onPointerEnter={() => { if (editorViewActive) onPanelFocus(activePanel); }}
        onPointerDownCapture={() => { if (editorViewActive) onPanelFocus(activePanel); }}
        onFocusCapture={() => { if (editorViewActive) onPanelFocus(activePanel); }}
      >
        <Suspense fallback={<div className="flex h-full flex-1 items-center justify-center gap-2 text-primary"><span className="size-5 animate-spin rounded-full border-2 border-current/25 border-t-current" /> Loading…</div>}>
          {tabs.filter((tab) => tab.kind === 'editor').map((tab) => {
            const tabVisible = visible && active === tab.id;
            return (
              <div key={tab.id} className={`absolute inset-0 min-h-0 ${tabVisible ? 'flex' : 'hidden'}`}>
                <MarkdownEditor
                  path={tab.path}
                  name={tab.label}
                  source={tab.source}
                  focused={tabVisible && focusedPanel === panelId(tab.id)}
                  fontFamily={fontFamily}
                  fontSize={tab.fontSize}
                  fullscreen={tab.fullscreen}
                  onFontSizeChange={(delta) => changeFontSize(tab.id, delta)}
                  onDirtyChange={markDirty}
                  onFocusRequest={() => onPanelFocus(panelId(tab.id))}
                  onPanelNavigate={navigateEditorPanel}
                  onToggleFullscreen={() => toggleFullscreen(tab.id)}
                  onToggleSidebar={onToggleSidebar}
                  onNewTerminal={createTerminal}
                  onClose={() => closeTab(tab.id)}
                />
              </div>
            );
          })}
        </Suspense>
      </section>

      <NotePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onOpenFile={openNote}
        openPaths={openEditorPaths}
        leftOffset={leftOffset}
      />
    </div>
  );
});

export default BottomTabs;
