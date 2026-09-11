import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';

import {
  activatePanelGroup as activatePanelGroupApi, createGroupPanel, createTerminalGroup,
  getWorkstream, listActivePausedWorkstreams, postCommand, readBrowserState, readPanelLayout,
  mergeTerminalGroups, openPanelResource, resetAllTerminalSessions, writeBrowserState, wsUrl,
} from './api.js';
import {
  DEFAULT_WORKSPACE_ROLES, SOCKET_MESSAGE_TYPES,
} from './constants.js';
import BottomTabs from './BottomTabs.jsx';
import GroupWorkspace from './GroupWorkspace.jsx';
import { browserClientId } from './browser-client.js';
import NewSessionModal from './NewSessionModal.jsx';
import SessionDetailModal from './SessionDetailModal.jsx';
import SessionWorkspace from './SessionWorkspace.jsx';
import { TargetProvider } from './target-context.js';
import { websocketReconnectDelay } from './websocket-retry.js';
import { panelCapacity } from './panel-layout.js';

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
  const groupPanelId = (id) => `group-panel-${targetId}-${id}`;

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
  const [panelLayoutStateRevision, setPanelLayoutStateRevision] = useState(0);
  const [panelLayout, setPanelLayout] = useState(null);
  const [mountedPanelGroupIds, setMountedPanelGroupIds] = useState(() => new Set());
  const [dirtyPanelResources, setDirtyPanelResources] = useState(() => new Set());
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
  const panelModelEnabled = panelLayout?.version === 1 && Array.isArray(panelLayout.groups);
  const activePanelGroup = panelModelEnabled
    ? panelLayout.groups.find((group) => group.id === panelLayout.activeGroupId) || null
    : null;
  const sidebarPanelGroups = useMemo(() => panelLayout?.groups?.map((group) => ({
    ...group,
    resources: group.resources.map((resource) => ({
      ...resource, dirty: dirtyPanelResources.has(resource.id),
    })),
  })) || null, [dirtyPanelResources, panelLayout]);

  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { onConnectionChange?.(targetId, connection); }, [connection, onConnectionChange, targetId]);

  const mountPanelGroup = useCallback((groupId) => {
    if (!groupId) return;
    setMountedPanelGroupIds((current) => {
      if (current.has(groupId)) return current;
      const next = new Set(current);
      next.add(groupId);
      return next;
    });
  }, []);

  const unmountPanelGroup = useCallback((groupId) => {
    if (!groupId) return;
    setMountedPanelGroupIds((current) => {
      if (!current.has(groupId)) return current;
      const next = new Set(current);
      next.delete(groupId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!panelModelEnabled) return;
    const valid = new Set(panelLayout.groups.map((group) => group.id));
    setMountedPanelGroupIds((current) => {
      const next = new Set([...current].filter((groupId) => valid.has(groupId)));
      if (panelLayout.activeGroupId && valid.has(panelLayout.activeGroupId)) {
        next.add(panelLayout.activeGroupId);
      }
      if (next.size === current.size && [...next].every((groupId) => current.has(groupId))) {
        return current;
      }
      return next;
    });
  }, [panelLayout, panelModelEnabled]);

  const refreshPanelLayout = useCallback(async () => {
    try {
      const layout = await readPanelLayout(undefined, target);
      if (layout?.version === 1 && Array.isArray(layout.groups)) setPanelLayout(layout);
      return layout;
    } catch {
      return null;
    }
  }, [target]);

  useEffect(() => {
    const controller = new AbortController();
    readPanelLayout(controller.signal, target)
      .then((layout) => {
        if (!controller.signal.aborted && layout?.version === 1 && Array.isArray(layout.groups)) {
          setPanelLayout(layout);
        }
      })
      .catch(() => { /* legacy daemon fallback */ });
    return () => controller.abort();
  }, [panelLayoutStateRevision, target]);

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
    if (!workspaceStateRestored || panelModelEnabled) return undefined;
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
  }, [activeWorkspaceId, panelModelEnabled, target, workspaceSessions, workspaceStateRestored]);

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
    const group = panelLayout?.groups?.find((candidate) => String(candidate.ownerId) === selected);
    if (panelLayout?.version === 1 && group) {
      mountPanelGroup(group.id);
      void activatePanelGroupApi(group.id, panelLayout.revision, target)
        .then(refreshPanelLayout)
        .catch(refreshPanelLayout);
      const panel = group.panels.find((candidate) => !candidate.minimized) || group.panels[0];
      if (panel) onPanelFocus(groupPanelId(panel.id));
      return;
    }
    bottomTabsRef.current?.hide();
    setWorkspaceSessions((current) => {
      const existing = current.find((session) => String(session.id) === selected);
      const remaining = current.filter((session) => String(session.id) !== selected);
      return [...remaining, existing ? { ...existing, ...item } : { ...item, panelMode: 'two' }];
    });
    setActiveWorkspaceId(selected);
    onPanelFocus(workspacePanelId(item.id, DEFAULT_WORKSPACE_ROLES[0]));
  }, [mountPanelGroup, onPanelFocus, onRequestFullscreenExit, panelLayout, refreshPanelLayout, target, targetId]);

  const activateStandalone = useCallback((id) => {
    onRequestFullscreenExit();
    const group = panelLayout?.groups?.find((candidate) => candidate.id === id);
    if (panelLayout?.version === 1 && group) {
      mountPanelGroup(group.id);
      void activatePanelGroupApi(group.id, panelLayout.revision, target)
        .then(refreshPanelLayout)
        .catch(refreshPanelLayout);
      const panel = group.panels.find((candidate) => !candidate.minimized) || group.panels[0];
      if (panel) onPanelFocus(groupPanelId(panel.id));
      return true;
    }
    return bottomTabsRef.current?.activate(id) || false;
  }, [mountPanelGroup, onPanelFocus, onRequestFullscreenExit, panelLayout, refreshPanelLayout, target, targetId]);

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
        setPanelLayoutStateRevision((value) => value + 1);
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
        if (message?.type === 'panel_layout') {
          if (message.clientId !== browserClientId()) setPanelLayoutStateRevision((value) => value + 1);
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
    setRevision((value) => value + 1);
    if (command === 'resume' && result.workstream) activateSession(result.workstream);
    if (command === 'pause' || command === 'archive' || command === 'close') {
      const group = panelLayout?.groups?.find(
        (candidate) => String(candidate.ownerId) === String(item.id),
      );
      unmountPanelGroup(group?.id);
      closeWorkspace(item.id);
    }
    return result;
  }, [activateSession, closeWorkspace, panelLayout, target, unmountPanelGroup]);

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

  const reportPanelResourceDirty = useCallback((resourceId, dirty) => {
    setDirtyPanelResources((current) => {
      if (current.has(resourceId) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(resourceId); else next.delete(resourceId);
      return next;
    });
  }, []);

  useEffect(() => {
    onSidebarStateChange?.(targetId, {
      items: activeSessions,
      loading: activeSessionsLoading,
      error: activeSessionsError,
      selectedId: activeStandaloneId ? null : activeWorkspaceId,
      standaloneSessions: standaloneSessions.items,
      activeStandaloneId,
      panelGroups: sidebarPanelGroups,
      activePanelGroupId: panelLayout?.activeGroupId || null,
      keyboardEnabled: !sessionId && !newKind,
    });
  }, [activeSessions, activeSessionsError, activeSessionsLoading, activeStandaloneId,
    activeWorkspaceId, newKind, onSidebarStateChange, panelLayout, sessionId, sidebarPanelGroups,
    standaloneSessions.items, targetId]);

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
    if (panelModelEnabled && activePanelGroup) {
      const panel = activePanelGroup.panels.find((item) => !item.minimized) || activePanelGroup.panels[0];
      if (!panel) return false;
      onPanelFocus(groupPanelId(panel.id));
      return true;
    }
    if (activeStandaloneId) return bottomTabsRef.current?.activate(activeStandaloneId) || false;
    return focusActiveWorkspace();
  }, [activePanelGroup, activeStandaloneId, focusActiveWorkspace, onPanelFocus, panelModelEnabled]);

  const openNewBottomTerminal = useCallback(() => (
    panelModelEnabled
      ? createTerminalGroup(panelLayout.revision, target).then(refreshPanelLayout).then(() => true)
      : bottomTabsRef.current?.createTerminal() || false
  ), [panelLayout, panelModelEnabled, refreshPanelLayout, target]);

  const openMarkdown = useCallback(() => {
    if (panelModelEnabled) return false;
    bottomTabsRef.current?.openMarkdown();
    return true;
  }, [panelModelEnabled]);

  const openResource = useCallback((resourceId) => {
    if (!panelModelEnabled) return false;
    const group = panelLayout.groups.find((candidate) => candidate.resources.some((resource) => resource.id === resourceId));
    const panel = group?.panels.find((candidate) => candidate.resourceId === resourceId);
    const width = document.querySelector(`[data-daemon-pane="${targetId}"]`)?.getBoundingClientRect().width || 0;
    const visibleCount = group?.panels.filter((candidate) => !candidate.minimized).length || 0;
    if ((!panel || panel.minimized) && width > 0 && visibleCount >= panelCapacity(width)) {
      window.alert('Minimize another panel to open this.');
      return false;
    }
    void openPanelResource(resourceId, panelLayout.revision, target)
      .then(refreshPanelLayout)
      .catch(refreshPanelLayout);
    return true;
  }, [panelLayout, panelModelEnabled, refreshPanelLayout, target, targetId]);

  const closeStandalone = useCallback((id) => (
    bottomTabsRef.current?.close(id) || false
  ), []);

  const groupStandalone = useCallback((sourceId, destinationId) => {
    onRequestFullscreenExit();
    if (panelModelEnabled) {
      if (sourceId === destinationId) return false;
      void mergeTerminalGroups(sourceId, destinationId, panelLayout.revision, target)
        .then(refreshPanelLayout)
        .catch(refreshPanelLayout);
      return true;
    }
    return bottomTabsRef.current?.groupTerminals(sourceId, destinationId, 'right') || false;
  }, [onRequestFullscreenExit, panelLayout, panelModelEnabled, refreshPanelLayout, target]);

  const minimizeStandalone = useCallback((id) => {
    onRequestFullscreenExit();
    return bottomTabsRef.current?.minimizeTerminal(id) || false;
  }, [onRequestFullscreenExit]);

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
    groupStandalone,
    minimizeStandalone,
    createTerminal: openNewBottomTerminal,
    focusActiveContent,
    openMarkdown,
    openResource,
  }), [activateSession, activateStandalone, closeStandalone, focusActiveContent, groupStandalone,
    minimizeStandalone, openMarkdown, openNewBottomTerminal, openResource, openSession, resetDaemonTerminals]);

  return (
    <TargetProvider value={target}>
      <div
        className={`${visible ? 'block' : 'hidden'} absolute inset-0 min-h-screen w-full`}
        aria-hidden={!visible}
        inert={!visible}
        data-daemon-pane={targetId}
      >
        <div className="relative min-h-screen min-w-0 overflow-hidden">
          {panelModelEnabled && panelLayout.groups
            .filter((group) => mountedPanelGroupIds.has(group.id))
            .map((group) => {
              const groupSession = group.ownerId == null ? null : activeSessions.find(
                (item) => String(item.id) === String(group.ownerId),
              ) || null;
              return (
                <GroupWorkspace
                  key={group.id}
                  group={group}
                  revision={panelLayout.revision}
                  target={target}
                  session={groupSession}
                  visible={visible && group.id === activePanelGroup?.id}
                  focusedPanel={focusedPanel}
                  onPanelFocus={onPanelFocus}
                  onRefresh={refreshPanelLayout}
                  terminalMode={terminalMode}
                  fontFamily={fontFamily}
                  onSidebarFocus={() => focusSessionsSidebar()}
                  onToggleSidebar={onToggleSidebar}
                  onAgentChange={changeWorkspaceAgent}
                  onDetails={openSession}
                  onArchive={archiveWorkspace}
                  onReset={resetWorkspaceTerminals}
                  onResourceDirtyChange={reportPanelResourceDirty}
                />
              );
            })}
          {!panelModelEnabled && workspaceSessions.map((workspaceSession) => (
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
          {panelModelEnabled && !activePanelGroup && <div className="min-h-screen min-w-0" aria-hidden="true" />}
          {!panelModelEnabled && !activeWorkspaceSession && !activeStandaloneId && <div className="min-h-screen min-w-0" aria-hidden="true" />}
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

        {!panelModelEnabled && <BottomTabs
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
        />}
      </div>
    </TargetProvider>
  );
});

export default DaemonPane;
