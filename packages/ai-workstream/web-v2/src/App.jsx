import {
  useCallback, useEffect, useRef, useState,
} from 'react';

import {
  getWorkstream, listActivePausedWorkstreams, postCommand,
} from './api.js';
import {
  DEFAULT_TERMINAL_FONT, DEFAULT_WORKSPACE_ROLES, SIDEBAR_WIDTH_STORAGE_KEY,
  SOCKET_MESSAGE_TYPES, SYNC_WINDOW_FULLSCREEN_STORAGE_KEY, TERMINAL_FONTS,
  TERMINAL_FONT_STORAGE_KEY, TERMINAL_MODE_STORAGE_KEY,
  THEMES, THEME_STORAGE_KEY,
} from './constants.js';
import BottomTabs from './BottomTabs.jsx';
import ActiveSessionsSidebar from './ActiveSessionsSidebar.jsx';
import NewSessionModal from './NewSessionModal.jsx';
import SessionDetailModal from './SessionDetailModal.jsx';
import SessionWorkspace from './SessionWorkspace.jsx';

const REFRESH_DEBOUNCE_MS = 75;
const DEFAULT_SIDEBAR_WIDTH = 264;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 640;

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

const readSessionId = () => new URLSearchParams(location.search).get('session');

function Connection({ state }) {
  const label = state === 'open' ? 'live' : state === 'connecting' ? 'connecting…' : 'reconnecting…';
  const color = state === 'open' ? 'bg-accent' : state === 'connecting' ? 'bg-soft' : 'bg-danger';
  return <span className="inline-flex items-center gap-2 text-xs font-semibold text-primary"><span className={`size-2.5 rounded-full ${color}`} aria-hidden="true" />{label}</span>;
}

export default function App() {
  const [sessionId, setSessionId] = useState(readSessionId);
  const sessionIdRef = useRef(sessionId);
  const activeSessionsRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const bottomTabsRef = useRef(null);
  const [activeSessions, setActiveSessions] = useState([]);
  const [activeSessionsLoading, setActiveSessionsLoading] = useState(true);
  const [activeSessionsError, setActiveSessionsError] = useState('');
  const [workspaceSessions, setWorkspaceSessions] = useState([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(null);
  const [sidebarVisibility, setSidebarVisibility] = useState('shown');
  const fullscreenSourcesRef = useRef(new Set());
  const browserFullscreenWantedRef = useRef(false);
  const [fullscreenExitRevision, setFullscreenExitRevision] = useState(0);
  const sidebarOpen = sidebarVisibility === 'shown';
  const [sidebarWidthPixels, setSidebarWidthPixels] = useState(() => clampSidebarWidth(
    storedValue(SIDEBAR_WIDTH_STORAGE_KEY, DEFAULT_SIDEBAR_WIDTH),
  ));
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [focusedPanel, setFocusedPanel] = useState('sidebar-sessions');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [revision, setRevision] = useState(0);
  const [connection, setConnection] = useState('connecting');
  const [newKind, setNewKind] = useState(null);
  const [theme, setTheme] = useState(() => {
    const value = storedValue(THEME_STORAGE_KEY, 'curiosities');
    return THEMES[value] ? value : 'curiosities';
  });
  const [terminalMode, setTerminalMode] = useState(() => (
    storedValue(TERMINAL_MODE_STORAGE_KEY, 'dark') === 'light' ? 'light' : 'dark'
  ));
  const [terminalFont, setTerminalFont] = useState(() => {
    const value = storedValue(TERMINAL_FONT_STORAGE_KEY, DEFAULT_TERMINAL_FONT);
    return TERMINAL_FONTS[value] ? value : DEFAULT_TERMINAL_FONT;
  });
  const [syncWindowFullscreen, setSyncWindowFullscreen] = useState(() => (
    storedValue(SYNC_WINDOW_FULLSCREEN_STORAGE_KEY, 'true') !== 'false'
  ));
  const syncWindowFullscreenRef = useRef(syncWindowFullscreen);
  const activeWorkspaceSession = workspaceSessions.find(
    (item) => String(item.id) === activeWorkspaceId,
  ) || null;

  const requestTerminalFullscreenExit = useCallback(() => {
    setFullscreenExitRevision((value) => value + 1);
  }, []);

  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

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

  const writeSessionUrl = useCallback((nextSession, { replace = false, modal = false } = {}) => {
    const url = new URL(location.href);
    if (nextSession) url.searchParams.set('session', String(nextSession)); else url.searchParams.delete('session');
    const state = modal && nextSession ? { ...(history.state || {}), fritzWorksV2Modal: String(nextSession) } : history.state;
    history[replace ? 'replaceState' : 'pushState'](state, '', url);
  }, []);

  const openSession = useCallback((id) => {
    const selected = String(id);
    writeSessionUrl(selected, { modal: true });
    setSessionId(selected);
  }, [writeSessionUrl]);

  const activateSession = useCallback((item) => {
    const selected = String(item.id);
    if (fullscreenSourcesRef.current.size > 0) requestTerminalFullscreenExit();
    bottomTabsRef.current?.hide();
    setWorkspaceSessions((current) => {
      const existing = current.find((session) => String(session.id) === selected);
      const remaining = current.filter((session) => String(session.id) !== selected);
      return [...remaining, existing ? { ...existing, ...item } : item];
    });
    setActiveWorkspaceId(selected);
    setFocusedPanel(`workspace-${item.id}-${DEFAULT_WORKSPACE_ROLES[0]}`);
  }, [requestTerminalFullscreenExit]);

  const closeWorkspace = useCallback((id) => {
    const selected = String(id);
    const remaining = workspaceSessions.filter((session) => String(session.id) !== selected);
    setWorkspaceSessions(remaining);
    if (activeWorkspaceId !== selected) return;
    const fallback = remaining.at(-1) || null;
    setActiveWorkspaceId(fallback ? String(fallback.id) : null);
    setFocusedPanel(fallback
      ? `workspace-${fallback.id}-${DEFAULT_WORKSPACE_ROLES[0]}`
      : sidebarOpen ? 'sidebar-sessions' : null);
  }, [activeWorkspaceId, sidebarOpen, workspaceSessions]);

  const closeSession = useCallback(() => {
    const selected = sessionIdRef.current;
    if (selected && history.state?.fritzWorksV2Modal === selected) {
      history.back();
      return;
    }
    writeSessionUrl(null, { replace: true });
    setSessionId(null);
    setDetail(null);
  }, [writeSessionUrl]);

  useEffect(() => {
    function pop() {
      const nextSession = readSessionId();
      setSessionId(nextSession);
      if (!nextSession) setDetail(null);
    }
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  useEffect(() => {
    const requestId = ++activeSessionsRequestRef.current;
    setActiveSessionsLoading(true);
    const timer = setTimeout(() => {
      listActivePausedWorkstreams()
        .then((items) => {
          if (activeSessionsRequestRef.current !== requestId) return;
          setActiveSessions(items);
          setActiveSessionsError('');
        })
        .catch((cause) => {
          if (activeSessionsRequestRef.current === requestId) setActiveSessionsError(cause.message);
        })
        .finally(() => {
          if (activeSessionsRequestRef.current === requestId) setActiveSessionsLoading(false);
        });
    }, REFRESH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      if (activeSessionsRequestRef.current === requestId) activeSessionsRequestRef.current += 1;
    };
  }, [revision]);

  useEffect(() => {
    setWorkspaceSessions((current) => current.map((session) => {
      const updated = activeSessions.find((item) => String(item.id) === String(session.id));
      return updated ? { ...session, ...updated } : session;
    }));
  }, [activeSessions]);

  useEffect(() => {
    const requestId = ++detailRequestRef.current;
    if (!sessionId) return undefined;
    setDetailLoading(true);
    const timer = setTimeout(() => {
      getWorkstream(sessionId)
        .then((item) => {
          if (detailRequestRef.current === requestId && sessionIdRef.current === String(item.id)) {
            setDetail(item);
            setDetailError('');
          }
        })
        .catch((cause) => {
          if (detailRequestRef.current === requestId) setDetailError(cause.message);
        })
        .finally(() => {
          if (detailRequestRef.current === requestId) setDetailLoading(false);
        });
    }, REFRESH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      if (detailRequestRef.current === requestId) detailRequestRef.current += 1;
    };
  }, [revision, sessionId]);

  useEffect(() => {
    let socket;
    let reconnectTimer;
    let closed = false;
    function connect() {
      if (closed) return;
      setConnection('connecting');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      try {
        socket = new WebSocket(`${protocol}//${location.host}/ws/events`);
      } catch {
        setConnection('closed');
        reconnectTimer = setTimeout(connect, 1000);
        return;
      }
      socket.addEventListener('open', () => {
        setConnection('open');
        setRevision((value) => value + 1);
      });
      socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message && SOCKET_MESSAGE_TYPES.has(message.type)) setRevision((value) => value + 1);
      });
      socket.addEventListener('close', () => {
        if (closed) return;
        setConnection('closed');
        reconnectTimer = setTimeout(connect, 1000);
      });
      socket.addEventListener('error', () => socket.close());
    }
    connect();
    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  const mutate = useCallback(async (item, command, body = {}) => {
    const payload = command === 'resume'
      ? { ...body, panels: [...DEFAULT_WORKSPACE_ROLES] }
      : body;
    const result = await postCommand(item.id, command, payload);
    if (result.result?.terminalFocus?.focused === false) {
      throw new Error(`Zellij focused. ${result.result.terminalFocus.reason}.`);
    }
    setRevision((value) => value + 1);
    if (command === 'resume' && result.workstream) activateSession(result.workstream);
    if (command === 'pause' || command === 'close') closeWorkspace(item.id);
    return result;
  }, [activateSession, closeWorkspace]);

  const changeWorkspaceAgent = useCallback(async (item, agent) => {
    const result = await mutate(item, 'agent-set', { agent });
    if (result.workstream) {
      setWorkspaceSessions((current) => current.map((session) => (
        String(session.id) === String(item.id) ? { ...session, ...result.workstream } : session
      )));
    }
    return result;
  }, [mutate]);

  const openWorkspaceNotes = useCallback((item) => mutate(item, 'open-notes'), [mutate]);

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

  const focusSessionsSidebar = useCallback(() => {
    setSidebarVisibility('shown');
    setFocusedPanel('sidebar-sessions');
  }, []);

  const focusActiveWorkspace = useCallback(() => {
    if (!activeWorkspaceSession) return false;
    setFocusedPanel(`workspace-${activeWorkspaceSession.id}-${DEFAULT_WORKSPACE_ROLES[0]}`);
    return true;
  }, [activeWorkspaceSession]);

  const focusVisibleSidebar = useCallback(() => {
    if (!sidebarOpen) return false;
    setFocusedPanel('sidebar-sessions');
    return true;
  }, [sidebarOpen]);

  const focusLastBottomTerminal = useCallback(() => (
    bottomTabsRef.current?.focusLastUsed() || false
  ), []);

  useEffect(() => {
    if (focusedPanel?.startsWith('workspace-')) bottomTabsRef.current?.hide();
  }, [focusedPanel]);

  function created(item) {
    setNewKind(null);
    setRevision((value) => value + 1);
    activateSession(item);
    openSession(item.id);
  }

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

  return (
    <div className="min-h-screen w-full">
      <div
        className={`grid min-h-screen min-w-0 items-stretch ${sidebarResizing ? '' : 'transition-[grid-template-columns] duration-300 ease-in-out'}`}
        style={{ gridTemplateColumns: `${sidebarWidth} minmax(0, 1fr)` }}
      >
        <ActiveSessionsSidebar
          items={activeSessions}
          loading={activeSessionsLoading}
          error={activeSessionsError}
          open={sidebarOpen}
          selectedId={activeWorkspaceId}
          onActivate={activateSession}
          onOpenDetails={openSession}
          onToggle={toggleSidebar}
          onNewRepo={() => setNewKind('repo')}
          onNewScratchpad={() => setNewKind('scratchpad')}
          theme={theme}
          onThemeChange={setTheme}
          terminalMode={terminalMode}
          onTerminalModeChange={setTerminalMode}
          terminalFont={terminalFont}
          onTerminalFontChange={setTerminalFont}
          syncWindowFullscreen={syncWindowFullscreen}
          onSyncWindowFullscreenChange={setSyncWindowFullscreen}
          onWorkspaceFocus={focusActiveWorkspace}
          focusedPanel={focusedPanel}
          onPanelFocus={setFocusedPanel}
          keyboardEnabled={!sessionId && !newKind}
          sidebarWidth={sidebarWidth}
          sidebarWidthPixels={sidebarWidthPixels}
          sidebarResizing={sidebarResizing}
          onSidebarResizeStart={() => setSidebarResizing(true)}
          onSidebarResize={resizeSidebar}
          onSidebarResizeEnd={finishSidebarResize}
        />
        <div className="relative min-h-screen min-w-0 overflow-hidden">
          {workspaceSessions.map((workspaceSession) => (
            <SessionWorkspace
              key={workspaceSession.id}
              session={workspaceSession}
              visible={String(workspaceSession.id) === activeWorkspaceId}
              focusedPanel={focusedPanel}
              onPanelFocus={setFocusedPanel}
              onDetails={openSession}
              onClose={() => closeWorkspace(workspaceSession.id)}
              onAgentChange={changeWorkspaceAgent}
              onOpenNotes={openWorkspaceNotes}
              terminalMode={terminalMode}
              fontFamily={TERMINAL_FONTS[terminalFont].family}
              onSidebarFocus={focusSessionsSidebar}
              onBottomTerminalFocus={focusLastBottomTerminal}
              onFullscreenChange={reportTerminalFullscreen}
              fullscreenExitRevision={fullscreenExitRevision}
              onToggleSidebar={toggleSidebar}
            />
          ))}
          {!activeWorkspaceSession && <div className="min-h-screen min-w-0" aria-hidden="true" />}
        </div>
      </div>

      <div className="fixed right-2 bottom-2 z-[60] rounded-full border border-primary/40 bg-page/95 px-2.5 py-1.5 shadow-lg backdrop-blur-sm">
        <Connection state={connection} />
      </div>

      {sessionId && (
        <SessionDetailModal
          sessionId={sessionId}
          item={detail && String(detail.id) === String(sessionId) ? detail : null}
          loading={detailLoading}
          loadError={detailError}
          onClose={closeSession}
          mutate={mutate}
        />
      )}

      {newKind && (
        <NewSessionModal
          kind={newKind}
          onClose={() => setNewKind(null)}
          onCreated={created}
        />
      )}

      <BottomTabs
        ref={bottomTabsRef}
        focusedPanel={focusedPanel}
        onPanelFocus={setFocusedPanel}
        leftOffset={sidebarWidth}
        layoutResizing={sidebarResizing}
        terminalMode={terminalMode}
        fontFamily={TERMINAL_FONTS[terminalFont].family}
        onFullscreenChange={reportTerminalFullscreen}
        fullscreenExitRevision={fullscreenExitRevision}
        onSidebarFocus={focusVisibleSidebar}
        onWorkspaceFocus={focusActiveWorkspace}
        onToggleSidebar={toggleSidebar}
      />
    </div>
  );
}
