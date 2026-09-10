import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';

import { listDaemons } from './api.js';
import {
  DEFAULT_TERMINAL_FONT, SIDEBAR_WIDTH_STORAGE_KEY,
  SYNC_WINDOW_FULLSCREEN_STORAGE_KEY, TERMINAL_FONTS,
  TERMINAL_FONT_STORAGE_KEY, TERMINAL_MODE_STORAGE_KEY,
  THEMES, THEME_STORAGE_KEY,
} from './constants.js';
import ActiveSessionsSidebar from './ActiveSessionsSidebar.jsx';
import DaemonPane from './DaemonPane.jsx';
import { TargetProvider } from './target-context.js';

const DEFAULT_SIDEBAR_WIDTH = 264;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 640;
// Hoisted so its identity is stable across renders — otherwise every DaemonPane
// and LocalTerminal effect keyed on `target` would reconnect the moment the
// /daemons fetch resolves and rebuilds this array.
const LOCAL_TARGET = { id: 'local', name: 'Local', url: null };

function storedValue(key, fallback) {
  try { return localStorage.getItem(key) || fallback; }
  catch { return fallback; }
}

function clampSidebarWidth(value) {
  const available = typeof window === 'undefined'
    ? MAX_SIDEBAR_WIDTH
    : Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - 320);
  return Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(Number(value) || DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, available)));
}

export default function App() {
  const [daemons, setDaemons] = useState([]);
  const targets = useMemo(() => [LOCAL_TARGET, ...daemons], [daemons]);
  // Local is always where a fresh load lands; switching targets afterwards
  // never triggers a reload, so both stay connected in the background.
  const [currentTargetId, setCurrentTargetId] = useState('local');
  const [connections, setConnections] = useState({});
  const [sidebarStates, setSidebarStates] = useState({});
  const paneControllers = useRef(new Map());
  const paneControllerRefs = useRef(new Map());
  const [sidebarVisibility, setSidebarVisibility] = useState('shown');
  const fullscreenSourcesRef = useRef(new Set());
  const browserFullscreenWantedRef = useRef(false);
  const [fullscreenExitRevision, setFullscreenExitRevision] = useState(0);
  const sidebarOpen = sidebarVisibility === 'shown';
  const [sidebarWidthPixels, setSidebarWidthPixels] = useState(() => clampSidebarWidth(
    storedValue(SIDEBAR_WIDTH_STORAGE_KEY, DEFAULT_SIDEBAR_WIDTH),
  ));
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [focusedPanel, setFocusedPanel] = useState('sidebar-local-sessions');
  const [theme, setTheme] = useState(() => {
    const value = storedValue(THEME_STORAGE_KEY, 'curiosities');
    return THEMES[value] ? value : 'curiosities';
  });
  const [terminalMode, setTerminalMode] = useState(() => {
    const value = storedValue(TERMINAL_MODE_STORAGE_KEY, 'dark');
    return ['light', 'black'].includes(value) ? value : 'dark';
  });
  const [terminalFont, setTerminalFont] = useState(() => {
    const value = storedValue(TERMINAL_FONT_STORAGE_KEY, DEFAULT_TERMINAL_FONT);
    return TERMINAL_FONTS[value] ? value : DEFAULT_TERMINAL_FONT;
  });
  const [syncWindowFullscreen, setSyncWindowFullscreen] = useState(() => (
    storedValue(SYNC_WINDOW_FULLSCREEN_STORAGE_KEY, 'true') !== 'false'
  ));
  const syncWindowFullscreenRef = useRef(syncWindowFullscreen);

  const requestTerminalFullscreenExit = useCallback(() => {
    setFullscreenExitRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    listDaemons().then((body) => setDaemons(body.daemons || [])).catch(() => {});
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* optional persistence */ }
  }, [theme]);

  useEffect(() => {
    try { localStorage.setItem(TERMINAL_MODE_STORAGE_KEY, terminalMode); } catch { /* optional persistence */ }
  }, [terminalMode]);

  useEffect(() => {
    try { localStorage.setItem(TERMINAL_FONT_STORAGE_KEY, terminalFont); } catch { /* optional persistence */ }
  }, [terminalFont]);

  useEffect(() => {
    syncWindowFullscreenRef.current = syncWindowFullscreen;
    if (!syncWindowFullscreen) browserFullscreenWantedRef.current = false;
    try { localStorage.setItem(SYNC_WINDOW_FULLSCREEN_STORAGE_KEY, String(syncWindowFullscreen)); }
    catch { /* optional persistence */ }
  }, [syncWindowFullscreen]);

  const reportTerminalFullscreen = useCallback((source, fullscreen) => {
    const sources = fullscreenSourcesRef.current;
    if (fullscreen) {
      if (sources.has(source)) return;
      sources.add(source);
      setSidebarVisibility((current) => current === 'shown' ? 'temporarily-hidden' : current);
      if (syncWindowFullscreenRef.current && !document.fullscreenElement
          && typeof document.documentElement.requestFullscreen === 'function') {
        browserFullscreenWantedRef.current = true;
        document.documentElement.requestFullscreen()
          .then(() => {
            if (!browserFullscreenWantedRef.current && document.fullscreenElement
                && typeof document.exitFullscreen === 'function') {
              return document.exitFullscreen();
            }
            return undefined;
          })
          .catch(() => {
            // Terminal fullscreen remains useful when the browser denies fullscreen.
          });
      }
      return;
    }
    if (!sources.delete(source) || sources.size > 0) return;
    setSidebarVisibility((current) => current === 'temporarily-hidden' ? 'shown' : current);
    if (syncWindowFullscreenRef.current) browserFullscreenWantedRef.current = false;
    if (syncWindowFullscreenRef.current && document.fullscreenElement
        && typeof document.exitFullscreen === 'function') {
      document.exitFullscreen().catch(() => {
        // The browser may already be leaving fullscreen through its own controls.
      });
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    if (fullscreenSourcesRef.current.size > 0) requestTerminalFullscreenExit();
    setSidebarVisibility((current) => current === 'shown' ? 'manually-hidden' : 'shown');
  }, [requestTerminalFullscreenExit]);

  useEffect(() => {
    function browserFullscreenChanged() {
      if (syncWindowFullscreenRef.current && !document.fullscreenElement
          && fullscreenSourcesRef.current.size > 0) {
        requestTerminalFullscreenExit();
      }
    }
    document.addEventListener('fullscreenchange', browserFullscreenChanged);
    return () => document.removeEventListener('fullscreenchange', browserFullscreenChanged);
  }, [requestTerminalFullscreenExit]);

  useEffect(() => {
    function toggleSidebarShortcut(event) {
      if (event.key.toLowerCase() !== 'p' || !event.ctrlKey || event.altKey
          || event.metaKey || event.shiftKey || event.repeat) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.xterm')) return;
      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    }
    document.addEventListener('keydown', toggleSidebarShortcut);
    return () => document.removeEventListener('keydown', toggleSidebarShortcut);
  }, [toggleSidebar]);

  const onShowSidebar = useCallback(() => setSidebarVisibility('shown'), []);

  const handleConnectionChange = useCallback((id, state) => {
    setConnections((current) => (current[id] === state ? current : { ...current, [id]: state }));
  }, []);

  const selectTarget = useCallback((id) => {
    setCurrentTargetId(id);
    setSidebarVisibility('shown');
    setFocusedPanel(`sidebar-${id}-sessions`);
  }, []);

  const reportSidebarState = useCallback((id, state) => {
    setSidebarStates((current) => {
      const previous = current[id];
      if (previous?.items === state.items
          && previous.loading === state.loading
          && previous.error === state.error
          && previous.selectedId === state.selectedId
          && previous.standaloneSessions === state.standaloneSessions
          && previous.activeStandaloneId === state.activeStandaloneId
          && previous.keyboardEnabled === state.keyboardEnabled) return current;
      return { ...current, [id]: state };
    });
  }, []);

  function controllerRefFor(id) {
    if (!paneControllerRefs.current.has(id)) {
      paneControllerRefs.current.set(id, (controller) => {
        if (controller) paneControllers.current.set(id, controller);
        else paneControllers.current.delete(id);
      });
    }
    return paneControllerRefs.current.get(id);
  }

  const activateSession = useCallback((targetId, item) => {
    selectTarget(targetId);
    paneControllers.current.get(targetId)?.activateSession(item);
  }, [selectTarget]);

  const openSessionDetails = useCallback((targetId, id) => {
    selectTarget(targetId);
    paneControllers.current.get(targetId)?.openSession(id);
  }, [selectTarget]);

  const openNewSession = useCallback((kind) => {
    paneControllers.current.get(currentTargetId)?.openNewSession(kind);
  }, [currentTargetId]);

  const activateStandalone = useCallback((targetId, id) => {
    selectTarget(targetId);
    paneControllers.current.get(targetId)?.activateStandalone(id);
  }, [selectTarget]);

  const closeStandalone = useCallback((targetId, id) => {
    paneControllers.current.get(targetId)?.closeStandalone(id);
  }, []);

  const createTerminal = useCallback((targetId) => {
    selectTarget(targetId);
    paneControllers.current.get(targetId)?.createTerminal();
  }, [selectTarget]);

  const openMarkdown = useCallback((targetId) => {
    selectTarget(targetId);
    paneControllers.current.get(targetId)?.openMarkdown();
  }, [selectTarget]);

  const resetCurrentTargetTerminals = useCallback(() => {
    const controller = paneControllers.current.get(currentTargetId);
    if (!controller) return Promise.reject(new Error('The selected machine is not ready.'));
    return controller.resetTerminals();
  }, [currentTargetId]);

  const focusCurrentContent = useCallback(() => (
    paneControllers.current.get(currentTargetId)?.focusActiveContent() || false
  ), [currentTargetId]);

  const resizeSidebar = useCallback((width) => {
    setSidebarWidthPixels(clampSidebarWidth(width));
  }, []);

  const finishSidebarResize = useCallback((width) => {
    const next = clampSidebarWidth(width);
    setSidebarWidthPixels(next);
    setSidebarResizing(false);
    try { localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next)); } catch { /* optional persistence */ }
  }, []);

  const sidebarWidth = sidebarOpen ? `${sidebarWidthPixels}px` : '0px';
  const leftOffset = sidebarWidth;
  const currentTarget = targets.find((target) => target.id === currentTargetId) || LOCAL_TARGET;
  const targetSections = useMemo(() => targets.map((target) => ({
    target,
    connection: connections[target.id] || 'connecting',
    items: sidebarStates[target.id]?.items || [],
    loading: sidebarStates[target.id]?.loading ?? true,
    error: sidebarStates[target.id]?.error || '',
    selectedId: sidebarStates[target.id]?.selectedId ?? null,
    standaloneSessions: sidebarStates[target.id]?.standaloneSessions || [],
    activeStandaloneId: sidebarStates[target.id]?.activeStandaloneId ?? null,
  })), [connections, sidebarStates, targets]);

  return (
    <div className="min-h-screen w-full">
      <div className="relative min-h-screen min-w-0 overflow-hidden">
        <div
          className={`grid min-h-screen min-w-0 items-stretch ${sidebarResizing ? '' : 'transition-[grid-template-columns] duration-300 ease-in-out'}`}
          style={{ gridTemplateColumns: `${sidebarWidth} minmax(0, 1fr)` }}
        >
          <TargetProvider value={currentTarget}>
            <ActiveSessionsSidebar
              sections={targetSections}
              open={sidebarOpen}
              currentTargetId={currentTargetId}
              onTargetChange={selectTarget}
              onActivate={activateSession}
              onOpenDetails={openSessionDetails}
              onActivateStandalone={activateStandalone}
              onCloseStandalone={closeStandalone}
              onCreateTerminal={createTerminal}
              onOpenMarkdown={openMarkdown}
              onToggle={toggleSidebar}
              onNewRepo={() => openNewSession('repo')}
              onNewScratchpad={() => openNewSession('scratchpad')}
              theme={theme}
              onThemeChange={setTheme}
              terminalMode={terminalMode}
              onTerminalModeChange={setTerminalMode}
              terminalFont={terminalFont}
              onTerminalFontChange={setTerminalFont}
              onResetTerminals={resetCurrentTargetTerminals}
              syncWindowFullscreen={syncWindowFullscreen}
              onSyncWindowFullscreenChange={setSyncWindowFullscreen}
              onContentFocus={focusCurrentContent}
              focusedPanel={focusedPanel}
              onPanelFocus={setFocusedPanel}
              keyboardEnabled={sidebarStates[currentTargetId]?.keyboardEnabled ?? true}
              sidebarWidth={sidebarWidth}
              sidebarWidthPixels={sidebarWidthPixels}
              sidebarResizing={sidebarResizing}
              onSidebarResizeStart={() => setSidebarResizing(true)}
              onSidebarResize={resizeSidebar}
              onSidebarResizeEnd={finishSidebarResize}
            />
          </TargetProvider>
          <div className="relative min-h-screen min-w-0 overflow-hidden">
            {targets.map((target) => (
              <DaemonPane
                ref={controllerRefFor(target.id)}
                key={target.id}
                target={target}
                visible={target.id === currentTargetId}
                terminalMode={terminalMode}
                fontFamily={TERMINAL_FONTS[terminalFont].family}
                sidebarOpen={sidebarOpen}
                onShowSidebar={onShowSidebar}
                focusedPanel={focusedPanel}
                onPanelFocus={setFocusedPanel}
                onFullscreenChange={reportTerminalFullscreen}
                fullscreenExitRevision={fullscreenExitRevision}
                onRequestFullscreenExit={requestTerminalFullscreenExit}
                onToggleSidebar={toggleSidebar}
                leftOffset={leftOffset}
                onConnectionChange={handleConnectionChange}
                onSidebarStateChange={reportSidebarState}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
