import {
  forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from 'react';

import { readEditorTabs, writeEditorTabs } from './api.js';
import { EditorIcon, ShellIcon, XIcon } from './icons.jsx';
import NotePicker from './NotePicker.jsx';

const LocalTerminal = lazy(() => import('./LocalTerminal.jsx'));
const MarkdownEditor = lazy(() => import('./MarkdownEditor.jsx'));

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const TAB_SWITCH_MS = 300;
const TAB_SAVE_DEBOUNCE_MS = 400;
const EDITOR_TAB_SCOPE = 'global';

// A fixed tab width keeps the strip from reflowing as notes with longer filenames
// are opened and closed.
const TAB_WIDTH = 'w-40';
const ADD_BUTTON_WIDTH = 'w-14';

const editorTabId = (path) => `editor:${path}`;

function editorTab({ path, name }) {
  return {
    id: editorTabId(path),
    kind: 'editor',
    label: name || path.split('/').pop(),
    path,
    fontSize: DEFAULT_FONT_SIZE,
    fullscreen: false,
  };
}

function TabButton({ tab, selected, dirty, onChoose, onClose }) {
  const Icon = tab.kind === 'editor' ? EditorIcon : ShellIcon;
  return (
    <div className={`pointer-events-auto relative -mb-px h-10 ${TAB_WIDTH}`}>
      <button
        id={`${tab.id}-tab`}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls="bottom-terminal-panel"
        title={tab.kind === 'editor' ? tab.path : tab.label}
        className={`relative inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-t-xl border border-b-0 pr-9 pl-4 text-sm font-semibold shadow-[0_-0.25rem_0.75rem_rgb(0_0_0/0.12)] transition-colors before:absolute before:-bottom-px before:-left-2 before:size-2 before:content-[''] after:absolute after:-right-2 after:-bottom-px after:size-2 after:content-[''] focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${selected ? "z-10 border-primary bg-accent text-on-accent before:bg-accent before:[clip-path:polygon(100%_0,100%_100%,0_100%)] after:bg-accent after:[clip-path:polygon(0_0,100%_100%,0_100%)]" : 'border-primary/60 bg-page text-primary before:hidden after:hidden hover:bg-soft hover:text-on-soft'}`}
        onClick={() => onChoose(tab.id)}
      >
        <Icon />
        <span className="truncate">{tab.label}</span>
        {dirty && <span className="size-1.5 shrink-0 rounded-full bg-current" title="Unsaved changes" aria-label="Unsaved changes" />}
      </button>
      <button
        type="button"
        className={`absolute top-1/2 right-1 z-30 flex size-6 -translate-y-1/2 items-center justify-center rounded transition-colors focus-visible:outline-2 focus-visible:outline-accent ${selected ? 'text-on-accent/70 hover:bg-on-accent/15 hover:text-on-accent' : 'text-primary/70 hover:bg-soft hover:text-on-soft'}`}
        aria-label={`Close ${tab.label}`}
        title={`Close ${tab.label}`}
        onClick={() => onClose(tab.id)}
      ><XIcon className="size-3.5" /></button>
    </div>
  );
}

function AddButton({ label, Icon, onClick }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`pointer-events-auto mb-1 inline-flex h-9 ${ADD_BUTTON_WIDTH} items-center justify-center gap-0.5 rounded-full border border-primary bg-page px-3 text-primary shadow-lg transition-[color,background-color,transform] hover:-translate-y-0.5 hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
      onClick={onClick}
    >
      <span className="text-base font-bold leading-none" aria-hidden="true">+</span>
      <Icon className="size-4" />
    </button>
  );
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

const BottomTabs = forwardRef(function BottomTabs({
  focusedPanel, onPanelFocus, leftOffset = '0rem', layoutResizing = false,
  terminalMode = 'dark', fontFamily = '"Roboto Mono", monospace', onFullscreenChange,
  fullscreenExitRevision, onSidebarFocus, onWorkspaceFocus, onToggleSidebar,
}, ref) {
  const [tabs, setTabs] = useState([]);
  const [active, setActive] = useState(null);
  const [displayed, setDisplayed] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dirtyPaths, setDirtyPaths] = useState(() => new Set());
  const [lastEditorPath, setLastEditorPath] = useState(null);
  const [tabsRestored, setTabsRestored] = useState(false);
  const queuedTab = useRef(null);
  const pendingRemoval = useRef(null);
  const nextTerminalNumber = useRef(1);
  const lastUsedRef = useRef(null);
  const fullscreenReportedRef = useRef(false);
  const activeTab = tabs.find((tab) => tab.id === displayed) || null;
  const activePanel = activeTab ? `bottom-${activeTab.id}` : null;
  const activeFullscreen = Boolean(activeTab?.fullscreen);
  const tabOpacity = focusedPanel?.startsWith('workspace-')
    ? 'opacity-20 hover:opacity-100 focus-within:opacity-100'
    : 'opacity-100';

  // Which notes were open is remembered server-side, so the tab strip comes back
  // after a reload (closed, not reopened — the drawer stays out of the way).
  useEffect(() => {
    const controller = new AbortController();
    readEditorTabs(EDITOR_TAB_SCOPE, controller.signal)
      .then((state) => {
        if (controller.signal.aborted) return;
        const restored = (state.tabs || []).map(editorTab);
        if (restored.length) setTabs((current) => [...current, ...restored]);
        if (state.activePath) setLastEditorPath(state.activePath);
        // Seed the last-used tab too, so navigating down into the drawer returns to
        // the remembered note rather than treating the strip as empty.
        const remembered = state.activePath || restored.at(-1)?.path;
        if (remembered) lastUsedRef.current = editorTabId(remembered);
      })
      .catch(() => { /* the editor still works without remembered tabs */ })
      .finally(() => { if (!controller.signal.aborted) setTabsRestored(true); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!tabsRestored) return undefined;
    const openPaths = tabs.filter((tab) => tab.kind === 'editor').map((tab) => ({ path: tab.path }));
    const timer = setTimeout(() => {
      writeEditorTabs(EDITOR_TAB_SCOPE, openPaths, lastEditorPath)
        .catch(() => { /* remembering tabs is best-effort */ });
    }, TAB_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [lastEditorPath, tabs, tabsRestored]);

  useEffect(() => {
    const fullscreenVisible = drawerOpen && activeFullscreen;
    if (fullscreenReportedRef.current === fullscreenVisible) return;
    fullscreenReportedRef.current = fullscreenVisible;
    onFullscreenChange?.('bottom-terminals', fullscreenVisible);
  }, [activeFullscreen, drawerOpen, onFullscreenChange]);

  useEffect(() => () => {
    if (fullscreenReportedRef.current) onFullscreenChange?.('bottom-terminals', false);
    fullscreenReportedRef.current = false;
  }, [onFullscreenChange]);

  const leaveFullscreen = useCallback(() => {
    if (!tabs.some((tab) => tab.fullscreen)) return false;
    onFullscreenChange?.('bottom-terminals', false);
    setTabs((current) => current.map((tab) => (tab.fullscreen ? { ...tab, fullscreen: false } : tab)));
    return true;
  }, [onFullscreenChange, tabs]);

  useEffect(() => {
    leaveFullscreen();
  }, [fullscreenExitRevision]);

  const hideDrawer = useCallback(() => {
    if (!drawerOpen && !closing) return false;
    leaveFullscreen();
    queuedTab.current = null;
    setDrawerOpen(false);
    if (drawerOpen) setClosing(true);
    return true;
  }, [closing, drawerOpen, leaveFullscreen]);

  const collapseDrawer = useCallback(() => {
    if (!hideDrawer()) return false;
    onPanelFocus(null);
    return true;
  }, [hideDrawer, onPanelFocus]);

  const remember = useCallback((id) => {
    lastUsedRef.current = id;
    if (id?.startsWith('editor:')) setLastEditorPath(id.slice('editor:'.length));
  }, []);

  const focusTab = useCallback((id) => {
    if (!id) return false;
    if (id !== active) leaveFullscreen();
    remember(id);
    if (closing) {
      queuedTab.current = id;
      onPanelFocus(`bottom-${id}`);
      return true;
    }
    queuedTab.current = null;
    setDisplayed(id);
    setActive(id);
    setDrawerOpen(true);
    onPanelFocus(`bottom-${id}`);
    return true;
  }, [active, closing, leaveFullscreen, onPanelFocus, remember]);

  const chooseTab = useCallback((id) => {
    remember(id);
    if (id !== active || (drawerOpen && active === id)) leaveFullscreen();
    if (closing) {
      queuedTab.current = id;
      onPanelFocus(`bottom-${id}`);
      return true;
    }
    if (drawerOpen && active === id) {
      collapseDrawer();
      return true;
    }
    if (drawerOpen) {
      queuedTab.current = id;
      setDrawerOpen(false);
      setClosing(true);
      onPanelFocus(`bottom-${id}`);
      return true;
    }
    queuedTab.current = null;
    setDisplayed(id);
    setActive(id);
    setDrawerOpen(true);
    onPanelFocus(`bottom-${id}`);
    return true;
  }, [active, closing, collapseDrawer, drawerOpen, leaveFullscreen, onPanelFocus, remember]);

  const createTerminal = useCallback(() => {
    const number = nextTerminalNumber.current;
    nextTerminalNumber.current += 1;
    const terminal = {
      id: `terminal-${number}`,
      kind: 'terminal',
      label: `terminal ${number}`,
      fontSize: DEFAULT_FONT_SIZE,
      fullscreen: false,
    };
    setTabs((current) => [...current, terminal]);
    return chooseTab(terminal.id);
  }, [chooseTab]);

  const openNote = useCallback((file) => {
    setPickerOpen(false);
    const id = editorTabId(file.path);
    setTabs((current) => (current.some((tab) => tab.id === id) ? current : [...current, editorTab(file)]));
    return chooseTab(id);
  }, [chooseTab]);

  // Falls back to whatever tab is last in the strip, note or terminal. A new
  // terminal is spawned only when the drawer is genuinely empty.
  const focusLastUsed = useCallback(() => {
    const remembered = lastUsedRef.current;
    const id = tabs.some((tab) => tab.id === remembered) ? remembered : tabs.at(-1)?.id;
    return id ? focusTab(id) : createTerminal();
  }, [createTerminal, focusTab, tabs]);

  useImperativeHandle(ref, () => ({
    focusLastUsed,
    hide: hideDrawer,
    openNote,
  }), [focusLastUsed, hideDrawer, openNote]);

  const markDirty = useCallback((path, dirty) => {
    setDirtyPaths((current) => {
      if (current.has(path) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(path); else next.delete(path);
      return next;
    });
  }, []);

  function withoutTab(current, id) {
    const remaining = current.filter((tab) => tab.id !== id);
    if (lastUsedRef.current === id) lastUsedRef.current = remaining.at(-1)?.id || null;
    return remaining;
  }

  function closeTab(id) {
    const tab = tabs.find((item) => item.id === id);
    if (tab?.kind === 'editor') {
      if (dirtyPaths.has(tab.path)
          && !window.confirm(`${tab.label} has unsaved changes. Close it anyway?`)) return;
      markDirty(tab.path, false);
      if (lastEditorPath === tab.path) {
        const nextEditor = tabs.filter((item) => item.kind === 'editor' && item.id !== id).at(-1);
        setLastEditorPath(nextEditor?.path || null);
      }
    }
    const displayedTab = id === displayed;
    if (displayedTab && (drawerOpen || closing)) {
      pendingRemoval.current = id;
      if (!closing) {
        queuedTab.current = null;
        setDrawerOpen(false);
        setClosing(true);
      }
      onPanelFocus(null);
      return;
    }
    if (queuedTab.current === id) queuedTab.current = null;
    setTabs((current) => withoutTab(current, id));
    if (displayedTab) {
      setDisplayed(null);
      setActive(null);
    }
  }

  function changeFontSize(id, amount) {
    setTabs((current) => current.map((tab) => (tab.id === id
      ? { ...tab, fontSize: Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, tab.fontSize + amount)) }
      : tab)));
  }

  function toggleFullscreen(id) {
    const target = tabs.find((item) => item.id === id);
    if (!target) return;
    // Report during the input event so requestFullscreen retains user activation.
    onFullscreenChange?.('bottom-terminals', !target.fullscreen);
    setTabs((current) => current.map((tab) => (tab.id === id
      ? { ...tab, fullscreen: !tab.fullscreen }
      : tab)));
    onPanelFocus(`bottom-${id}`);
  }

  function navigateTab(id, direction) {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return false;
    const next = tabs[index + direction];
    if (next) return focusTab(next.id);
    if (direction === -1 && index === 0) {
      leaveFullscreen();
      return typeof onSidebarFocus === 'function' ? onSidebarFocus() : false;
    }
    return true;
  }

  function focusWorkspace() {
    leaveFullscreen();
    return onWorkspaceFocus();
  }

  useEffect(() => {
    if (!closing) return undefined;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const timer = window.setTimeout(() => {
      const removed = pendingRemoval.current;
      pendingRemoval.current = null;
      if (removed) setTabs((current) => withoutTab(current, removed));
      const next = queuedTab.current;
      queuedTab.current = null;
      setClosing(false);
      if (next && next !== removed) {
        setDisplayed(next);
        setActive(next);
        setDrawerOpen(true);
      } else {
        setActive(null);
        if (removed) setDisplayed(null);
      }
    }, reducedMotion ? 0 : TAB_SWITCH_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  // Panel navigation also has to work when DOM focus has drifted out of the drawer
  // (a note that was still loading, a control button). Terminals and the markdown
  // source both preventDefault first, so exactly one handler ever acts.
  useEffect(() => {
    if (!drawerOpen || !activeTab) return undefined;
    const panel = `bottom-${activeTab.id}`;
    function onKeyDown(event) {
      if (event.defaultPrevented || !event.ctrlKey || event.altKey || event.metaKey
          || event.shiftKey || event.repeat || focusedPanel !== panel) return;
      const key = event.key.toLowerCase();
      if (key !== 'h' && key !== 'l' && key !== 'k') return;
      event.preventDefault();
      if (key === 'k') focusWorkspace();
      else navigateTab(activeTab.id, key === 'h' ? -1 : 1);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [activeTab, drawerOpen, focusedPanel, onSidebarFocus, onWorkspaceFocus, tabs]);

  // Losing focus slides the drawer away, the same as focusing a session terminal
  // used to. `closing` is excluded so a tab switch, which briefly points the focused
  // panel at the incoming tab while the outgoing one animates out, is not cut short.
  useEffect(() => {
    if (!drawerOpen || closing || !activeTab) return;
    if (focusedPanel !== `bottom-${activeTab.id}`) hideDrawer();
  }, [activeTab, closing, drawerOpen, focusedPanel, hideDrawer]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      // Terminals and the markdown source both own Escape while they have focus.
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.xterm') || target instanceof HTMLTextAreaElement
          || target instanceof HTMLInputElement) return;
      collapseDrawer();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [collapseDrawer, drawerOpen]);

  const openEditorPaths = new Set(tabs.filter((tab) => tab.kind === 'editor').map((tab) => tab.path));

  return (
    <div className="contents" role="tablist" aria-label="Terminals and notes">
      {drawerOpen && activeTab && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Collapse ${activeTab.label}`}
          className={`fixed top-0 right-0 bottom-0 z-30 cursor-default bg-transparent motion-reduce:transition-none ${layoutResizing ? '' : 'transition-[left] duration-300 ease-in-out'}`}
          style={{ left: leftOffset }}
          onClick={collapseDrawer}
        />
      )}

      <div
        className={`fixed right-0 bottom-0 z-40 flex flex-col duration-300 ease-in-out motion-reduce:transition-none ${activeFullscreen ? 'h-screen' : 'h-[calc(75vh+2.5rem)]'} ${layoutResizing ? 'transition-[translate]' : 'transition-[translate,left]'} ${drawerOpen && activeTab ? 'translate-y-0' : 'translate-y-[calc(100%-2.5rem)]'}`}
        style={{ left: leftOffset }}
      >
        <div className={`pointer-events-none relative z-10 flex h-10 shrink-0 items-end gap-1 px-2 transition-opacity duration-200 motion-reduce:transition-none ${tabOpacity}`}>
          <AddButton label="New terminal" Icon={ShellIcon} onClick={createTerminal} />
          <AddButton label="Open a note" Icon={EditorIcon} onClick={() => setPickerOpen((open) => !open)} />
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              selected={active === tab.id}
              dirty={dirtyPaths.has(tab.path)}
              onChoose={chooseTab}
              onClose={closeTab}
            />
          ))}
        </div>

        <section
          id="bottom-terminal-panel"
          role="tabpanel"
          aria-labelledby={activeTab ? `${activeTab.id}-tab` : undefined}
          aria-hidden={!drawerOpen || !activeTab}
          className={`flex shrink-0 flex-col overflow-hidden rounded-t-2xl border-2 bg-page pb-1 text-ink shadow-[0_-1rem_3rem_rgb(0_0_0/0.25)] ${activeFullscreen ? 'h-[calc(100vh-2.5rem)]' : 'h-[75vh]'} ${focusedPanel === activePanel ? 'border-accent' : 'border-primary'} ${drawerOpen && activeTab ? '' : 'pointer-events-none'}`}
          data-panel={activePanel || undefined}
          data-panel-focused={Boolean(activePanel && focusedPanel === activePanel)}
          data-terminal-fullscreen={activeFullscreen}
          onPointerEnter={() => { if (activePanel) onPanelFocus(activePanel); }}
          onPointerDownCapture={() => { if (activePanel) onPanelFocus(activePanel); }}
          onFocusCapture={() => { if (activePanel) onPanelFocus(activePanel); }}
        >
          {activeTab && (
            <div className="relative flex min-h-0 flex-1 p-1">
              {activeTab.kind === 'terminal' && (
                <div className="absolute top-3 right-3 z-20 opacity-20 transition-opacity hover:opacity-100 focus-within:opacity-100">
                  <FontSizeControls tab={activeTab} onChange={changeFontSize} />
                </div>
              )}
              <div className="relative min-h-0 flex-1">
                <Suspense fallback={<div className="flex h-full items-center justify-center gap-2 text-primary"><span className="size-5 animate-spin rounded-full border-2 border-current/25 border-t-current" /> Loading…</div>}>
                  {tabs.map((tab) => {
                    const tabVisible = drawerOpen && active === tab.id;
                    return (
                      <div key={tab.id} className={`absolute inset-0 min-h-0 ${tabVisible ? 'flex' : 'hidden'}`}>
                        {tab.kind === 'editor' ? (
                          <MarkdownEditor
                            path={tab.path}
                            name={tab.label}
                            focused={tabVisible && focusedPanel === `bottom-${tab.id}`}
                            fontFamily={fontFamily}
                            fontSize={tab.fontSize}
                            fullscreen={tab.fullscreen}
                            onFontSizeChange={(delta) => changeFontSize(tab.id, delta)}
                            onDirtyChange={markDirty}
                            onFocusRequest={() => onPanelFocus(`bottom-${tab.id}`)}
                            onPanelNavigate={(direction) => navigateTab(tab.id, direction)}
                            onNavigateUp={focusWorkspace}
                            onToggleFullscreen={() => toggleFullscreen(tab.id)}
                            onToggleSidebar={onToggleSidebar}
                          />
                        ) : (
                          <LocalTerminal
                            visible={tabVisible}
                            autoFocus={false}
                            focused={tabVisible && focusedPanel === `bottom-${tab.id}`}
                            onPanelNavigate={(direction) => navigateTab(tab.id, direction)}
                            onNavigateUp={focusWorkspace}
                            onToggleFullscreen={() => toggleFullscreen(tab.id)}
                            onToggleSidebar={onToggleSidebar}
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
          )}
        </section>
      </div>

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
