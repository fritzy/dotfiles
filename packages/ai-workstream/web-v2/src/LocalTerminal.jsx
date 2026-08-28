import { useEffect, useRef, useState } from 'react';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

const TERMINAL_THEMES = {
  dark: {
    background: '#0f172a',
    foreground: '#e2e8f0',
    cursor: '#22d3ee',
    cursorAccent: '#0f172a',
    selectionBackground: '#334155',
    selectionForeground: '#f8fafc',
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
  role = null, onPanelNavigate = null, onNavigateUp = null, onNavigateDown = null,
  onToggleFullscreen = null, onToggleSidebar = null, onExit = null,
  label = 'Local zsh terminal', className = '',
  fontSize = 14, fontFamily = '"Roboto Mono", monospace', themeMode = 'dark',
}) {
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
  exitRef.current = onExit;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    let exited = false;
    let resizeFrame = null;
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
    terminal.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase();
      const controlOnly = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
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

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const terminalQuery = new URLSearchParams();
    if (sessionId != null) terminalQuery.set('session', String(sessionId));
    if (role) terminalQuery.set('role', role);
    const queryString = terminalQuery.toString();
    const socket = new WebSocket(`${protocol}//${location.host}/ws/terminal${queryString ? `?${queryString}` : ''}`);
    socketRef.current = socket;

    const sendResize = () => {
      if (disposed || !visibleRef.current || host.clientWidth < 1 || host.clientHeight < 1) return;
      try { fit.fit(); } catch { return; }
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const scheduleResize = () => {
      if (resizeFrame != null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(sendResize);
    };

    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    });
    socket.addEventListener('open', () => {
      if (disposed) return;
      setStatus('connected');
      scheduleResize();
      const shouldFocus = focusedRef.current == null ? autoFocusRef.current : focusedRef.current;
      if (visibleRef.current && shouldFocus) terminal.focus();
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'output' && typeof message.data === 'string') terminal.write(message.data);
      if (message.type === 'error') terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
      if (message.type === 'exit') {
        exited = true;
        setStatus('exited');
        terminal.writeln(`\r\n\x1b[90m[zsh exited with status ${message.exitCode}]\x1b[0m`);
        exitRef.current?.(message);
      }
    });
    socket.addEventListener('close', () => {
      if (!disposed && !exited) setStatus('disconnected');
    });
    socket.addEventListener('error', () => socket.close());

    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(host);
    scheduleResize();

    return () => {
      disposed = true;
      if (resizeFrame != null) cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      input.dispose();
      socket.close();
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [generation, role, sessionId]);

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
          disabled={status === 'connecting'}
          onClick={() => setGeneration((value) => value + 1)}
        >{status === 'connecting' ? 'connecting…' : `${status} · reconnect`}</button>
      )}
    </div>
  );
}
