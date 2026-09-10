import {
  forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from 'react';

import {
  readBrowserState, readEditorTabs, writeBrowserState, writeEditorTabs,
} from './api.js';
import { EditorIcon, ShellIcon, XIcon } from './icons.jsx';
import NotePicker from './NotePicker.jsx';
import { useTarget } from './target-context.js';

const LocalTerminal = lazy(() => import('./LocalTerminal.jsx'));
const MarkdownEditor = lazy(() => import('./MarkdownEditor.jsx'));

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const TAB_SAVE_DEBOUNCE_MS = 400;
const EDITOR_TAB_SCOPE = 'global';
const TERMINAL_STATE_SCOPE = 'bottom-terminals';
const TERMINAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

let fallbackTerminalId = 0;

function newTerminalId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `terminal-${uuid}`;
  fallbackTerminalId += 1;
  return `terminal-${Date.now().toString(36)}-${fallbackTerminalId}`;
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
    fontSize: DEFAULT_FONT_SIZE,
    fullscreen: false,
  };
}

function FontSizeControls({ tab, onChange }) {
  return (
    <div className="inline-flex items-center rounded-md border border-primary bg-page/90 shadow-md backdrop-blur-sm" aria-label={`${tab.label} font size`}>
      <button
        type="button"
        className="flex size-7 items-center justify-center rounded-l-md text-base font-bold text-primary transition-colors hover:bg-soft hover:text-on-soft disabled:opacity-40"
        aria-label={`Decrease ${tab.label} font size`}
        title="Decrease font size"
        disabled={tab.fontSize <= MIN_FONT_SIZE}
        onClick={() => onChange(tab.id, -1)}
      >−</button>
      <span className="min-w-8 text-center text-xs font-semibold tabular-nums text-primary" aria-hidden="true">{tab.fontSize}</span>
      <button
        type="button"
        className="flex size-7 items-center justify-center rounded-r-md text-base font-bold text-primary transition-colors hover:bg-soft hover:text-on-soft disabled:opacity-40"
        aria-label={`Increase ${tab.label} font size`}
        title="Increase font size"
        disabled={tab.fontSize >= MAX_FONT_SIZE}
        onClick={() => onChange(tab.id, 1)}
      >+</button>
    </div>
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
  const [active, setActive] = useState(null);
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
            label: typeof tab.label === 'string' && tab.label ? tab.label : `terminal ${index + 1}`,
            fontSize: Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Number(tab.fontSize) || DEFAULT_FONT_SIZE)),
            fullscreen: false,
          }));
        skipTerminalStateSaveRef.current = true;
        setTabs((current) => [...restored, ...current.filter((tab) => tab.kind === 'editor')]);
        const restoredIds = new Set(restored.map((tab) => tab.id));
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
        terminals: terminals.map((tab) => ({
          id: tab.id,
          kind: 'terminal',
          label: tab.label,
          fontSize: tab.fontSize,
        })),
        displayedId: terminals.some((tab) => tab.id === active) ? active : null,
      }, target).catch(() => { /* remembering terminals is best-effort */ });
    }, TAB_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, tabs, target, terminalTabsRestored]);

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
      items: tabs.map((tab) => ({
        id: tab.id,
        kind: tab.kind,
        label: tab.label,
        path: tab.path,
        dirty: tab.kind === 'editor' && dirtyPaths.has(tab.path),
      })),
      activeId: active,
    });
  }, [active, dirtyPaths, onSessionsChange, tabs]);

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
      fontSize: DEFAULT_FONT_SIZE,
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
    if (lastUsedRef.current === id) lastUsedRef.current = remaining.at(-1)?.id || null;
    setTabs(remaining);
    if (wasActive) {
      leaveFullscreen();
      setActive(null);
      onCloseActive?.();
    }
    return true;
  }, [dirtyPaths, lastEditorPath, leaveFullscreen, markDirty, onCloseActive, tabs]);

  useImperativeHandle(ref, () => ({
    activate,
    close: closeTab,
    createTerminal,
    focusLastUsed,
    hide: deactivate,
    openMarkdown: () => setPickerOpen(true),
    openNote,
  }), [activate, closeTab, createTerminal, deactivate, focusLastUsed, openNote]);

  function changeFontSize(id, amount) {
    setTabs((current) => current.map((tab) => (tab.id === id
      ? { ...tab, fontSize: Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, tab.fontSize + amount)) }
      : tab)));
  }

  function toggleFullscreen(id) {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;
    onFullscreenChange?.(fullscreenSource, !tab.fullscreen);
    setTabs((current) => current.map((item) => (item.id === id
      ? { ...item, fullscreen: !item.fullscreen }
      : item)));
    onPanelFocus(panelId(id));
  }

  function navigatePanel(direction) {
    if (direction >= 0) return false;
    leaveFullscreen();
    return typeof onSidebarFocus === 'function' ? onSidebarFocus() : false;
  }

  useEffect(() => {
    if (!activeTab || focusedPanel !== activePanel) return undefined;
    function onKeyDown(event) {
      if (event.defaultPrevented || !event.ctrlKey || event.altKey || event.metaKey
          || event.shiftKey || event.repeat) return;
      const key = event.key.toLowerCase();
      if (!['h', 'j', 'k', 'l'].includes(key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (key === 'h') navigatePanel(-1);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [activePanel, activeTab, focusedPanel, onSidebarFocus, tabs]);

  const openEditorPaths = new Set(tabs.filter((tab) => tab.kind === 'editor').map((tab) => tab.path));
  const ActiveIcon = activeTab?.kind === 'editor' ? EditorIcon : ShellIcon;

  return (
    <div
      className={visible ? 'contents' : 'hidden'}
      aria-label={`${target?.name || 'Local'} standalone terminal and Markdown sessions`}
      data-standalone-sessions={targetId}
      inert={!visible}
    >
      <section
        id={activePanel ? `${activePanel}-panel` : undefined}
        aria-label={activeTab ? `${activeTab.label} standalone session` : undefined}
        aria-hidden={!activeTab}
        className={`${activeTab ? 'flex' : 'hidden'} absolute inset-0 z-20 min-h-0 flex-col overflow-hidden bg-page text-ink ring-inset ${focusedPanel === activePanel ? 'ring-2 ring-accent/60' : ''}`}
        data-panel={activePanel || undefined}
        data-panel-focused={Boolean(activePanel && focusedPanel === activePanel)}
        data-terminal-fullscreen={activeFullscreen}
        onPointerEnter={() => { if (activePanel) onPanelFocus(activePanel); }}
        onPointerDownCapture={() => { if (activePanel) onPanelFocus(activePanel); }}
        onFocusCapture={() => { if (activePanel) onPanelFocus(activePanel); }}
      >
        {activeTab?.kind === 'terminal' && !activeFullscreen && (
          <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-primary/40 px-3 py-1.5">
            <ActiveIcon className="size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-mono text-sm font-bold text-primary">{activeTab.label}</h2>
              {activeTab.path && <p className="truncate font-mono text-xs text-muted" title={activeTab.path}>{activeTab.path}</p>}
            </div>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md border border-primary bg-page text-primary transition-colors hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent"
              aria-label={`Close ${activeTab.label}`}
              title={`Close ${activeTab.label}`}
              onClick={() => closeTab(activeTab.id)}
            ><XIcon className="size-3.5" /></button>
          </header>
        )}

        <div className={`relative min-h-0 flex-1 p-1 ${activeTab ? 'flex' : 'hidden'}`}>
            {activeTab?.kind === 'terminal' && (
              <div className="absolute top-3 right-3 z-20 opacity-20 transition-opacity hover:opacity-100 focus-within:opacity-100">
                <FontSizeControls tab={activeTab} onChange={changeFontSize} />
              </div>
            )}
            <div className="relative min-h-0 flex-1">
              <Suspense fallback={<div className="flex h-full items-center justify-center gap-2 text-primary"><span className="size-5 animate-spin rounded-full border-2 border-current/25 border-t-current" /> Loading…</div>}>
                {tabs.map((tab) => {
                  const tabVisible = visible && active === tab.id;
                  return (
                    <div key={tab.id} className={`absolute inset-0 min-h-0 ${tabVisible ? 'flex' : 'hidden'}`}>
                      {tab.kind === 'editor' ? (
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
                          onPanelNavigate={navigatePanel}
                          onToggleFullscreen={() => toggleFullscreen(tab.id)}
                          onToggleSidebar={onToggleSidebar}
                          onNewTerminal={createTerminal}
                          onClose={() => closeTab(tab.id)}
                        />
                      ) : (
                        <LocalTerminal
                          terminalId={tab.id}
                          onControlReady={(controls) => {
                            if (controls) terminalControlsRef.current.set(tab.id, controls);
                            else terminalControlsRef.current.delete(tab.id);
                          }}
                          visible={tabVisible}
                          autoFocus={false}
                          focused={tabVisible && focusedPanel === panelId(tab.id)}
                          onPanelNavigate={navigatePanel}
                          onToggleFullscreen={() => toggleFullscreen(tab.id)}
                          onToggleSidebar={onToggleSidebar}
                          onNewTerminal={createTerminal}
                          onExit={() => closeTab(tab.id)}
                          label={tab.label}
                          themeMode={terminalMode}
                          fontFamily={fontFamily}
                          fontSize={tab.fontSize}
                        />
                      )}
                    </div>
                  );
                })}
              </Suspense>
            </div>
        </div>
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
