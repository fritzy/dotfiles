import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from 'react';

import {
  getWorkstream, listActivePausedWorkstreams, postCommand, readBrowserState,
  resetAllTerminalSessions, writeBrowserState, wsUrl,
} from './api.js';
import {
  DEFAULT_WORKSPACE_ROLES, SOCKET_MESSAGE_TYPES,
} from './constants.js';
import BottomTabs from './BottomTabs.jsx';
import { browserClientId } from './browser-client.js';
import NewSessionModal from './NewSessionModal.jsx';
import SessionDetailModal from './SessionDetailModal.jsx';
import SessionWorkspace from './SessionWorkspace.jsx';
import { TargetProvider } from './target-context.js';
import { websocketReconnectDelay } from './websocket-retry.js';

const REFRESH_DEBOUNCE_MS = 75;
const STATE_SAVE_DEBOUNCE_MS = 400;
const WORKSPACE_STATE_SCOPE = 'workspaces';

const readSessionId = () => new URLSearchParams(location.search).get('session');

function Connection({ state }) {
  const label = state === 'open' ? 'live' : state === 'connecting' ? 'connecting…' : 'reconnecting…';
  const color = state === 'open' ? 'bg-accent' : state === 'connecting' ? 'bg-soft' : 'bg-danger';
  return <span className="inline-flex items-center gap-2 text-xs font-semibold text-primary"><span className={`size-2.5 rounded-full ${color}`} aria-hidden="true" />{label}</span>;
}

const DaemonPane = forwardRef(function DaemonPane({
  target, visible, terminalMode, fontFamily,
  sidebarOpen, onShowSidebar,
  focusedPanel, onPanelFocus, onFullscreenChange, fullscreenExitRevision, onRequestFullscreenExit,
  onToggleSidebar, leftOffset, onConnectionChange, onSidebarStateChange,
}, controllerRef) {
  const targetId = target?.id || 'local';
  const sidebarSessionsPanel = `sidebar-${targetId}-sessions`;
  const workspacePanelId = (id, role) => `workspace-${targetId}-${id}-${role}`;

  const [sessionId, setSessionId] = useState(() => (visible ? readSessionId() : null));
  const sessionIdRef = useRef(sessionId);
  const activeSessionsRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const bottomTabsRef = useRef(null);
  const workspaceStateRequestRef = useRef(0);
  const skipWorkspaceStateSaveRef = useRef(false);
  const [activeSessions, setActiveSessions] = useState([]);
  const [activeSessionsLoading, setActiveSessionsLoading] = useState(true);
  const [activeSessionsError, setActiveSessionsError] = useState('');
  const [workspaceSessions, setWorkspaceSessions] = useState([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(null);
  const [workspaceStateRestored, setWorkspaceStateRestored] = useState(false);
  const [workspaceStateRevision, setWorkspaceStateRevision] = useState(0);
  const [bottomTerminalStateRevision, setBottomTerminalStateRevision] = useState(0);
  const [standaloneSessions, setStandaloneSessions] = useState({ items: [], activeId: null });
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [revision, setRevision] = useState(0);
  const [connection, setConnection] = useState('connecting');
  const [newKind, setNewKind] = useState(null);
  const activeWorkspaceSession = workspaceSessions.find(
    (item) => String(item.id) === activeWorkspaceId,
  ) || null;
  const activeStandaloneId = standaloneSessions.activeId;

  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { onConnectionChange?.(targetId, connection); }, [connection, onConnectionChange, targetId]);

  useEffect(() => {
    const requestId = ++workspaceStateRequestRef.current;
    setWorkspaceStateRestored(false);
    const controller = new AbortController();
    readBrowserState(WORKSPACE_STATE_SCOPE, controller.signal, target)
      .then(async ({ state = {} }) => {
        const specs = Array.isArray(state.workspaces) ? state.workspaces.slice(0, 100) : [];
        const seenIds = new Set();
        const restored = (await Promise.all(specs.map(async (spec) => {
          const id = spec && (typeof spec.id === 'string' || Number.isInteger(spec.id))
            ? String(spec.id) : null;
          if (!id || seenIds.has(id)) return null;
          seenIds.add(id);
          try {
            const item = await getWorkstream(id, controller.signal, target);
            if (item.status === 'closed') return null;
            return { ...item, panelMode: spec.panelMode === 'three' ? 'three' : 'two' };
          } catch {
            return null;
          }
        }))).filter(Boolean);
        if (controller.signal.aborted || workspaceStateRequestRef.current !== requestId) return;
        skipWorkspaceStateSaveRef.current = true;
        setWorkspaceSessions(restored);
        const remembered = state.activeWorkspaceId == null ? null : String(state.activeWorkspaceId);
        setActiveWorkspaceId((current) => {
          if (restored.some((item) => String(item.id) === current)) return current;
          return restored.some((item) => String(item.id) === remembered)
            ? remembered : restored.at(-1) ? String(restored.at(-1).id) : null;
        });
      })
      .catch(() => { /* older daemons simply start with an empty workspace */ })
      .finally(() => {
        if (!controller.signal.aborted && workspaceStateRequestRef.current === requestId) {
          setWorkspaceStateRestored(true);
        }
      });
    return () => controller.abort();
  }, [target, workspaceStateRevision]);

  useEffect(() => {
    if (!workspaceStateRestored) return undefined;
    if (skipWorkspaceStateSaveRef.current) {
      skipWorkspaceStateSaveRef.current = false;
      return undefined;
    }
    const timer = setTimeout(() => {
      writeBrowserState(WORKSPACE_STATE_SCOPE, {
        workspaces: workspaceSessions.map((item) => ({
          id: String(item.id),
          panelMode: item.panelMode === 'three' ? 'three' : 'two',
        })),
        activeWorkspaceId,
      }, target).catch(() => { /* remembering terminals is best-effort */ });
    }, STATE_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [activeWorkspaceId, target, workspaceSessions, workspaceStateRestored]);

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
    onRequestFullscreenExit();
    bottomTabsRef.current?.hide();
    setWorkspaceSessions((current) => {
      const existing = current.find((session) => String(session.id) === selected);
      const remaining = current.filter((session) => String(session.id) !== selected);
      return [...remaining, existing ? { ...existing, ...item } : { ...item, panelMode: 'two' }];
    });
    setActiveWorkspaceId(selected);
    onPanelFocus(workspacePanelId(item.id, DEFAULT_WORKSPACE_ROLES[0]));
  }, [onPanelFocus, onRequestFullscreenExit, targetId]);

  const activateStandalone = useCallback((id) => {
    onRequestFullscreenExit();
    return bottomTabsRef.current?.activate(id) || false;
  }, [onRequestFullscreenExit]);

  const closeWorkspace = useCallback((id) => {
    const selected = String(id);
    const remaining = workspaceSessions.filter((session) => String(session.id) !== selected);
    setWorkspaceSessions(remaining);
    if (activeWorkspaceId !== selected) return;
    const fallback = remaining.at(-1) || null;
    setActiveWorkspaceId(fallback ? String(fallback.id) : null);
    onPanelFocus(fallback
      ? workspacePanelId(fallback.id, DEFAULT_WORKSPACE_ROLES[0])
      : sidebarOpen ? sidebarSessionsPanel : null);
  }, [activeWorkspaceId, onPanelFocus, sidebarOpen, sidebarSessionsPanel, targetId, workspaceSessions]);

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
    if (!visible) return undefined;
    function pop() {
      const nextSession = readSessionId();
      setSessionId(nextSession);
      if (!nextSession) setDetail(null);
    }
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [visible]);

  useEffect(() => {
    const requestId = ++activeSessionsRequestRef.current;
    setActiveSessionsLoading(true);
    const timer = setTimeout(() => {
      listActivePausedWorkstreams(undefined, target)
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
  }, [revision, target]);

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
      getWorkstream(sessionId, undefined, target)
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
  }, [revision, sessionId, target]);

  useEffect(() => {
    let socket;
    let reconnectTimer;
    let reconnectAttempt = 0;
    let closed = false;
    function reconnect() {
      if (closed) return;
      setConnection('closed');
      reconnectTimer = setTimeout(connect, websocketReconnectDelay(reconnectAttempt));
      reconnectAttempt += 1;
    }
    function connect() {
      if (closed) return;
      setConnection('connecting');
      try {
        socket = new WebSocket(wsUrl('/ws/events', target));
      } catch {
        reconnect();
        return;
      }
      socket.addEventListener('open', () => {
        reconnectAttempt = 0;
        setConnection('open');
        // Reconcile everything that could have changed while events were down,
        // including the two server-side browser inventories.
        setRevision((value) => value + 1);
        setWorkspaceStateRevision((value) => value + 1);
        setBottomTerminalStateRevision((value) => value + 1);
      });
      socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message?.type === 'browser_state') {
          if (message.clientId === browserClientId()) return;
          if (message.scope === WORKSPACE_STATE_SCOPE) setWorkspaceStateRevision((value) => value + 1);
          if (message.scope === 'bottom-terminals') setBottomTerminalStateRevision((value) => value + 1);
          return;
        }
        if (message && SOCKET_MESSAGE_TYPES.has(message.type)) setRevision((value) => value + 1);
      });
      socket.addEventListener('close', () => {
        if (closed) return;
        reconnect();
      });
      socket.addEventListener('error', () => socket.close());
    }
    connect();
    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [target]);

  const mutate = useCallback(async (item, command, body = {}) => {
    const payload = command === 'resume'
      ? { ...body, panels: [...DEFAULT_WORKSPACE_ROLES] }
      : body;
    const result = await postCommand(item.id, command, payload, target);
    if (result.result?.terminalFocus?.focused === false) {
      throw new Error(`Zellij focused. ${result.result.terminalFocus.reason}.`);
    }
    setRevision((value) => value + 1);
    if (command === 'resume' && result.workstream) activateSession(result.workstream);
    if (command === 'pause' || command === 'archive' || command === 'close') closeWorkspace(item.id);
    return result;
  }, [activateSession, closeWorkspace, target]);

  const changeWorkspaceAgent = useCallback(async (item, agent) => {
    const result = await mutate(item, 'agent-set', { agent });
    if (result.workstream) {
      setWorkspaceSessions((current) => current.map((session) => (
        String(session.id) === String(item.id) ? { ...session, ...result.workstream } : session
      )));
    }
    return result;
  }, [mutate]);

  const changeWorkspacePanelMode = useCallback((item, panelMode) => {
    setWorkspaceSessions((current) => current.map((session) => (
      String(session.id) === String(item.id) ? { ...session, panelMode } : session
    )));
  }, []);

  const openWorkspaceNotes = useCallback((item) => mutate(item, 'open-notes'), [mutate]);
  const archiveWorkspace = useCallback((item) => mutate(item, 'archive'), [mutate]);
  const resetWorkspaceTerminals = useCallback((item) => mutate(item, 'terminal-reset'), [mutate]);
  const resetDaemonTerminals = useCallback(async () => {
    const result = await resetAllTerminalSessions(target);
    setRevision((value) => value + 1);
    return result;
  }, [target]);

  const reportStandaloneSessions = useCallback((state) => {
    setStandaloneSessions(state);
  }, []);

  useEffect(() => {
    onSidebarStateChange?.(targetId, {
      items: activeSessions,
      loading: activeSessionsLoading,
      error: activeSessionsError,
      selectedId: activeStandaloneId ? null : activeWorkspaceId,
      standaloneSessions: standaloneSessions.items,
      activeStandaloneId,
      keyboardEnabled: !sessionId && !newKind,
    });
  }, [activeSessions, activeSessionsError, activeSessionsLoading, activeStandaloneId,
    activeWorkspaceId, newKind, onSidebarStateChange, sessionId, standaloneSessions.items, targetId]);

  const focusSessionsSidebar = useCallback(() => {
    onShowSidebar();
    onPanelFocus(sidebarSessionsPanel);
  }, [onPanelFocus, onShowSidebar, sidebarSessionsPanel]);

  const focusActiveWorkspace = useCallback(() => {
    if (!activeWorkspaceSession) return false;
    onPanelFocus(workspacePanelId(activeWorkspaceSession.id, DEFAULT_WORKSPACE_ROLES[0]));
    return true;
  }, [activeWorkspaceSession, onPanelFocus, targetId]);

  const focusActiveContent = useCallback(() => {
    if (activeStandaloneId) return bottomTabsRef.current?.activate(activeStandaloneId) || false;
    return focusActiveWorkspace();
  }, [activeStandaloneId, focusActiveWorkspace]);

  const openNewBottomTerminal = useCallback(() => (
    bottomTabsRef.current?.createTerminal() || false
  ), []);

  const openMarkdown = useCallback(() => {
    bottomTabsRef.current?.openMarkdown();
    return true;
  }, []);

  const closeStandalone = useCallback((id) => (
    bottomTabsRef.current?.close(id) || false
  ), []);

  const focusAfterStandaloneClose = useCallback(() => {
    if (!visible) return;
    if (!focusActiveWorkspace()) focusSessionsSidebar();
  }, [focusActiveWorkspace, focusSessionsSidebar, visible]);

  useEffect(() => {
    if (focusedPanel?.startsWith('workspace-')) bottomTabsRef.current?.hide();
  }, [focusedPanel]);

  function created(item) {
    setNewKind(null);
    setRevision((value) => value + 1);
    activateSession(item);
    openSession(item.id);
  }

  useImperativeHandle(controllerRef, () => ({
    activateSession,
    openSession,
    openNewSession: setNewKind,
    resetTerminals: resetDaemonTerminals,
    activateStandalone,
    closeStandalone,
    createTerminal: openNewBottomTerminal,
    focusActiveContent,
    openMarkdown,
  }), [activateSession, activateStandalone, closeStandalone, focusActiveContent,
    openMarkdown, openNewBottomTerminal, openSession, resetDaemonTerminals]);

  return (
    <TargetProvider value={target}>
      <div
        className={`${visible ? 'block' : 'hidden'} absolute inset-0 min-h-screen w-full`}
        aria-hidden={!visible}
        inert={!visible}
        data-daemon-pane={targetId}
      >
        <div className="relative min-h-screen min-w-0 overflow-hidden">
          {workspaceSessions.map((workspaceSession) => (
            <SessionWorkspace
              key={workspaceSession.id}
              session={workspaceSession}
              target={target}
              visible={!activeStandaloneId && String(workspaceSession.id) === activeWorkspaceId}
              focusedPanel={focusedPanel}
              onPanelFocus={onPanelFocus}
              onDetails={openSession}
              onArchive={archiveWorkspace}
              onClose={() => closeWorkspace(workspaceSession.id)}
              onAgentChange={changeWorkspaceAgent}
              onReset={resetWorkspaceTerminals}
              panelMode={workspaceSession.panelMode}
              onPanelModeChange={(panelMode) => changeWorkspacePanelMode(workspaceSession, panelMode)}
              onOpenNotes={openWorkspaceNotes}
              terminalMode={terminalMode}
              fontFamily={fontFamily}
              onSidebarFocus={focusSessionsSidebar}
              onFullscreenChange={onFullscreenChange}
              fullscreenExitRevision={fullscreenExitRevision}
              onToggleSidebar={onToggleSidebar}
              onNewTerminal={openNewBottomTerminal}
            />
          ))}
          {!activeWorkspaceSession && !activeStandaloneId && <div className="min-h-screen min-w-0" aria-hidden="true" />}
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
          visible={visible}
          focusedPanel={focusedPanel}
          onPanelFocus={onPanelFocus}
          leftOffset={leftOffset}
          terminalMode={terminalMode}
          fontFamily={fontFamily}
          onFullscreenChange={onFullscreenChange}
          fullscreenExitRevision={fullscreenExitRevision}
          stateRevision={bottomTerminalStateRevision}
          onSidebarFocus={focusSessionsSidebar}
          onToggleSidebar={onToggleSidebar}
          onSessionsChange={reportStandaloneSessions}
          onCloseActive={focusAfterStandaloneClose}
        />
      </div>
    </TargetProvider>
  );
});

export default DaemonPane;
