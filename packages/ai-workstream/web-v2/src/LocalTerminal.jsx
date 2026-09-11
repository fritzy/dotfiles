import { useEffect, useRef, useState } from 'react';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { wsUrl } from './api.js';
import { browserClientId } from './browser-client.js';
import { copyTerminalSelection } from './clipboard.js';
import { trackOsc52Clipboard } from './osc52-clipboard.js';
import { useTarget } from './target-context.js';
import { websocketReconnectDelay } from './websocket-retry.js';

const TERMINAL_CONNECT_TIMEOUT_MS = 10_000;
const TERMINAL_READY_TIMEOUT_MS = 20_000;

const TERMINAL_THEMES = {
  dark: {
    background: '#0f172a',
    foreground: '#e2e8f0',
    cursor: '#22d3ee',
    cursorAccent: '#0f172a',
    selectionBackground: '#334155',
    selectionForeground: '#f8fafc',
  },
  black: {
    background: '#000000',
    foreground: '#ffffff',
    cursor: '#ffffff',
    cursorAccent: '#000000',
    selectionBackground: '#4d4d4d',
    selectionForeground: '#ffffff',
    black: '#000000',
    red: '#cd0000',
    green: '#00cd00',
    yellow: '#cdcd00',
    blue: '#0000ee',
    magenta: '#cd00cd',
    cyan: '#00cdcd',
    white: '#e5e5e5',
    brightBlack: '#a8a8a8',
    brightRed: '#ff0000',
    brightGreen: '#00ff00',
    brightYellow: '#ffff00',
    brightBlue: '#5c5cff',
    brightMagenta: '#ff00ff',
    brightCyan: '#00ffff',
    brightWhite: '#ffffff',
  },
  light: {
    background: '#f8fafc',
    foreground: '#0f172a',
    cursor: '#0891b2',
    cursorAccent: '#f8fafc',
    selectionBackground: '#cbd5e1',
    selectionForeground: '#0f172a',
  },
};

function terminalTheme(mode) {
  return TERMINAL_THEMES[mode] || TERMINAL_THEMES.dark;
}

export default function LocalTerminal({
  visible = true, sessionId = null, autoFocus = true, focused = null,
  role = null, terminalId = 'default', panelId = null, onPanelNavigate = null, onNavigateUp = null, onNavigateDown = null,
  onToggleFullscreen = null, onToggleSidebar = null, onNewTerminal = null, onExit = null,
  onControlReady = null,
  label = 'Local zsh terminal', className = '',
  fontSize = 14, fontFamily = '"Roboto Mono", monospace', themeMode = 'dark',
}) {
  const target = useTarget();
  const hostRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const socketRef = useRef(null);
  const visibleRef = useRef(visible);
  const autoFocusRef = useRef(autoFocus);
  const focusedRef = useRef(focused);
  const panelNavigateRef = useRef(onPanelNavigate);
  const navigateUpRef = useRef(onNavigateUp);
  const navigateDownRef = useRef(onNavigateDown);
  const toggleFullscreenRef = useRef(onToggleFullscreen);
  const toggleSidebarRef = useRef(onToggleSidebar);
  const newTerminalRef = useRef(onNewTerminal);
  const exitRef = useRef(onExit);
  const [status, setStatus] = useState('connecting');
  const [generation, setGeneration] = useState(0);
  visibleRef.current = visible;
  autoFocusRef.current = autoFocus;
  focusedRef.current = focused;
  panelNavigateRef.current = onPanelNavigate;
  navigateUpRef.current = onNavigateUp;
  navigateDownRef.current = onNavigateDown;
  toggleFullscreenRef.current = onToggleFullscreen;
  toggleSidebarRef.current = onToggleSidebar;
  newTerminalRef.current = onNewTerminal;
  exitRef.current = onExit;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    let exited = false;
    let resizeFrame = null;
    let reconnectTimer = null;
    let connectionTimer = null;
    let readyTimer = null;
    let reconnectAttempt = 0;
    let socket = null;
    let ownedTerminal = false;
    setStatus('connecting');

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily,
      fontSize,
      scrollback: 5000,
      theme: terminalTheme(themeMode),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    const osc52Clipboard = trackOsc52Clipboard(terminal);
    terminal.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase();
      const controlOnly = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
      // Ctrl+C/Ctrl+V are the shell's interrupt and quoted-insert, so copy and
      // paste live on Ctrl+Shift+C/Ctrl+Shift+P instead — captured here (rather
      // than left to the browser) so Ctrl+Shift+C can't fall through to a
      // DevTools inspector shortcut.
      const controlShift = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
      if (key === 'c' && controlShift) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === 'keydown' && !event.repeat) {
          copyTerminalSelection(terminal, {
            fallbackText: osc52Clipboard.text,
            copyEventHandlesFallback: true,
          });
        }
        return false;
      }
      if (key === 'p' && controlShift) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === 'keydown' && !event.repeat) {
          navigator.clipboard?.readText()
            .then((text) => { if (text) terminal.paste(text); })
            .catch(() => {});
        }
        return false;
      }
      if (key === 't' && controlOnly && typeof newTerminalRef.current === 'function') {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === 'keydown' && !event.repeat) newTerminalRef.current();
        return false;
      }
      if (key === 'f' && controlOnly && typeof toggleFullscreenRef.current === 'function') {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === 'keydown' && !event.repeat) toggleFullscreenRef.current();
        return false;
      }
      if (key === 'p' && controlOnly && typeof toggleSidebarRef.current === 'function') {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === 'keydown' && !event.repeat) toggleSidebarRef.current();
        return false;
      }
      const verticalHandler = key === 'k' ? navigateUpRef.current
        : key === 'j' ? navigateDownRef.current : null;
      if (controlOnly && (key === 'j' || key === 'k')) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === 'keydown' && typeof verticalHandler === 'function') verticalHandler();
        return false;
      }
      const direction = key === 'h' ? -1 : key === 'l' ? 1 : 0;
      if (direction && controlOnly) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === 'keydown' && typeof panelNavigateRef.current === 'function') {
          panelNavigateRef.current(direction);
        }
        return false;
      }
      return true;
    });
    terminalRef.current = terminal;
    fitRef.current = fit;

    const terminalQuery = new URLSearchParams();
    terminalQuery.set('client', browserClientId());
    terminalQuery.set('terminal', terminalId);
    if (panelId) {
      // The persisted panel is authoritative for its owner, role, and cwd.
      // Omitting the redundant fields also keeps terminal-only group panels
      // from looking like session-role terminals to the WebSocket endpoint.
      terminalQuery.set('panel', panelId);
    } else {
      if (sessionId != null) terminalQuery.set('session', String(sessionId));
      if (role) terminalQuery.set('role', role);
    }
    const terminalUrl = () => {
      const reconnectQuery = new URLSearchParams(terminalQuery);
      if (ownedTerminal) reconnectQuery.set('owner', '1');
      return wsUrl(`/ws/terminal?${reconnectQuery.toString()}`, target);
    };
    onControlReady?.({
      terminate() {
        const activeSocket = socketRef.current;
        if (activeSocket?.readyState === WebSocket.OPEN) {
          activeSocket.send(JSON.stringify({ type: 'terminate' }));
        }
      },
    });

    const sendResize = () => {
      if (disposed || !visibleRef.current || host.clientWidth < 1 || host.clientHeight < 1) return;
      try { fit.fit(); } catch { return; }
      const activeSocket = socketRef.current;
      if (activeSocket?.readyState === WebSocket.OPEN) {
        activeSocket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const scheduleResize = () => {
      if (resizeFrame != null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(sendResize);
    };

    const input = terminal.onData((data) => {
      const activeSocket = socketRef.current;
      if (activeSocket?.readyState === WebSocket.OPEN) {
        activeSocket.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const reconnect = () => {
      if (disposed || exited) return;
      clearTimeout(connectionTimer);
      clearTimeout(readyTimer);
      clearTimeout(reconnectTimer);
      setStatus('reconnecting');
      reconnectTimer = setTimeout(connect, websocketReconnectDelay(reconnectAttempt));
      reconnectAttempt += 1;
    };
    const connect = () => {
      if (disposed || exited) return;
      setStatus('connecting');
      let candidate;
      try {
        candidate = new WebSocket(terminalUrl());
      } catch {
        reconnect();
        return;
      }
      socket = candidate;
      socketRef.current = candidate;
      connectionTimer = setTimeout(() => {
        if (disposed || candidate !== socket || candidate.readyState !== WebSocket.CONNECTING) return;
        setStatus('connection timed out');
        try { candidate.close(); } catch { reconnect(); }
      }, TERMINAL_CONNECT_TIMEOUT_MS);
      candidate.addEventListener('open', () => {
        if (disposed || candidate !== socket) return;
        clearTimeout(connectionTimer);
        reconnectAttempt = 0;
        setStatus('starting terminal');
        readyTimer = setTimeout(() => {
          if (disposed || candidate !== socket || ownedTerminal) return;
          setStatus('terminal startup timed out');
          candidate.close();
        }, TERMINAL_READY_TIMEOUT_MS);
      });
      candidate.addEventListener('message', (event) => {
        if (disposed || candidate !== socket) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'output' && typeof message.data === 'string') terminal.write(message.data);
        if (message.type === 'claimed') {
          clearTimeout(readyTimer);
          ownedTerminal = true;
          setStatus('connected');
          scheduleResize();
          const shouldFocus = focusedRef.current == null ? autoFocusRef.current : focusedRef.current;
          if (visibleRef.current && shouldFocus) terminal.focus();
        }
        if (message.type === 'busy') {
          clearTimeout(readyTimer);
          ownedTerminal = false;
          setStatus('active on another client');
        }
        if (message.type === 'error') {
          clearTimeout(readyTimer);
          setStatus('terminal error');
          terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
        }
        if (message.type === 'exit') {
          exited = true;
          clearTimeout(reconnectTimer);
          setStatus('exited');
          terminal.writeln(`\r\n\x1b[90m[zsh exited with status ${message.exitCode}]\x1b[0m`);
          exitRef.current?.(message);
        }
      });
      candidate.addEventListener('close', () => {
        if (candidate !== socket) return;
        clearTimeout(connectionTimer);
        clearTimeout(readyTimer);
        if (socketRef.current === candidate) socketRef.current = null;
        socket = null;
        reconnect();
      });
      candidate.addEventListener('error', () => candidate.close());
    };
    connect();

    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(host);
    scheduleResize();

    return () => {
      disposed = true;
      if (resizeFrame != null) cancelAnimationFrame(resizeFrame);
      clearTimeout(reconnectTimer);
      clearTimeout(connectionTimer);
      clearTimeout(readyTimer);
      resizeObserver.disconnect();
      input.dispose();
      osc52Clipboard.dispose();
      onControlReady?.(null);
      socket?.close();
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
      socketRef.current = null;
    };
  }, [generation, panelId, role, sessionId, target, terminalId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return undefined;
    terminal.options.theme = terminalTheme(themeMode);
    let cancelled = false;
    let frame = null;
    const applyFont = () => {
      if (cancelled) return;
      terminal.options.fontSize = fontSize;
      terminal.options.fontFamily = fontFamily;
      if (!visibleRef.current) return;
      frame = requestAnimationFrame(() => {
        const fit = fitRef.current;
        if (!fit) return;
        try { fit.fit(); } catch { return; }
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        }
      });
    };
    // Cell metrics come from the primary family only. Waiting on the whole stack
    // would hold the first fit until the Nerd Font fallback finishes streaming,
    // and it contributes no glyph the terminal measures.
    const primaryFamily = fontFamily.split(',')[0].trim();
    let loaded = null;
    try { loaded = document.fonts?.load(`${fontSize}px ${primaryFamily}`); }
    catch { loaded = null; }
    if (loaded) Promise.resolve(loaded).catch(() => {}).then(applyFont);
    else applyFont();
    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [fontFamily, fontSize, themeMode]);

  useEffect(() => {
    if (!visible) return undefined;
    const frame = requestAnimationFrame(() => {
      const terminal = terminalRef.current;
      const fit = fitRef.current;
      if (!terminal || !fit) return;
      try { fit.fit(); } catch { return; }
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  useEffect(() => {
    if (!visible || !(focused === true || (focused == null && autoFocus))) return undefined;
    const frame = requestAnimationFrame(() => terminalRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, focused, visible]);

  return (
    <div className={`relative min-h-0 flex-1 overflow-hidden rounded-lg border border-primary p-2 ${className}`} style={{ backgroundColor: terminalTheme(themeMode).background }}>
      <div ref={hostRef} className="xterm-host h-full min-h-0 w-full" aria-label={label} />
      {status !== 'connected' && (
        <button
          type="button"
          className="absolute top-3 right-3 rounded-md border border-primary bg-page/90 px-2 py-1 text-xs font-semibold text-primary shadow-sm hover:bg-soft hover:text-on-soft disabled:cursor-wait disabled:opacity-70"
          onClick={() => {
            if (status === 'active on another client' && socketRef.current?.readyState === WebSocket.OPEN) {
              socketRef.current.send(JSON.stringify({ type: 'takeover' }));
            } else {
              setGeneration((value) => value + 1);
            }
          }}
          title={status === 'active on another client' ? 'Take over this terminal' : undefined}
        >{status === 'connecting' ? 'connecting… · retry now'
            : status === 'active on another client' ? 'Active on another client · waiting'
              : status === 'reconnecting' ? 'reconnecting… · retry now'
              : `${status} · reconnect`}</button>
      )}
    </div>
  );
}
