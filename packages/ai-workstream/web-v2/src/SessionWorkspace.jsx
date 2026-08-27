import {
  lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';

import {
  AssetIcon, EditorIcon, RobotIcon, ShellIcon, Spinner, XIcon,
} from './icons.jsx';
import { LinkPill } from './LinkEditor.jsx';
import { panelsForMode } from './constants.js';
import {
  AgentToggle, Button, IconButton, PanelModeToggle,
} from './ui.jsx';

const LocalTerminal = lazy(() => import('./LocalTerminal.jsx'));
const MIN_PANEL_PIXELS = 160;
const SPLIT_STORAGE_PREFIX = 'ai-workstream-workspace-splits';
const FONT_SIZE_STORAGE_PREFIX = 'ai-workstream-terminal-font-sizes';
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const ROLE_DETAILS = {
  shell: { label: 'Shell', Icon: ShellIcon },
  editor: { label: 'Editor', Icon: EditorIcon },
  agent: { label: 'Agent', Icon: RobotIcon },
};

function readFontSizes(sessionId) {
  const fallback = Object.fromEntries(Object.keys(ROLE_DETAILS).map((role) => [role, DEFAULT_FONT_SIZE]));
  try {
    const stored = JSON.parse(localStorage.getItem(`${FONT_SIZE_STORAGE_PREFIX}-${sessionId}`));
    for (const role of Object.keys(fallback)) {
      const value = Number(stored?.[role]);
      if (Number.isFinite(value)) fallback[role] = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, value));
    }
  } catch { /* optional persistence */ }
  return fallback;
}

function TerminalFontControls({ label, value, onChange }) {
  const buttonClass = 'flex size-6 items-center justify-center rounded border border-primary bg-page text-base leading-none text-primary transition-colors hover:bg-soft hover:text-on-soft disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5" role="group" aria-label={`${label} terminal font size`}>
      <button type="button" className={buttonClass} disabled={value <= MIN_FONT_SIZE} aria-label={`Decrease ${label} terminal font size`} title={`Decrease font size (${value}px)`} onClick={() => onChange(-1)}>−</button>
      <button type="button" className={buttonClass} disabled={value >= MAX_FONT_SIZE} aria-label={`Increase ${label} terminal font size`} title={`Increase font size (${value}px)`} onClick={() => onChange(1)}>+</button>
    </div>
  );
}

function defaultBoundaries(count) {
  return Array.from({ length: count - 1 }, (_, index) => ((index + 1) * 100) / count);
}

function readBoundaries(count) {
  const fallback = defaultBoundaries(count);
  try {
    const stored = JSON.parse(localStorage.getItem(`${SPLIT_STORAGE_PREFIX}-${count}`));
    if (!Array.isArray(stored) || stored.length !== count - 1) return fallback;
    const values = stored.map(Number);
    if (values.some((value, index) => !Number.isFinite(value)
      || value <= (index ? values[index - 1] : 0) || value >= 100)) return fallback;
    return values;
  } catch {
    return fallback;
  }
}

function columnsFor(boundaries) {
  const edges = [0, ...boundaries, 100];
  return edges.slice(1).map((edge, index) => `${edge - edges[index]}%`).join(' ');
}

function SplitHandle({
  index, value, containerRef, boundaries, onChange, onCommit, onFocus, onReset,
}) {
  const pointer = useRef(null);
  const [dragging, setDragging] = useState(false);

  function restoreDocument() {
    if (!pointer.current) return;
    document.documentElement.style.cursor = pointer.current.cursor;
    document.body.style.userSelect = pointer.current.userSelect;
    pointer.current = null;
  }

  useEffect(() => () => restoreDocument(), []);

  function constrainedValue(clientX) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect?.width) return value;
    const minimum = Math.min(25, Math.max(6, (MIN_PANEL_PIXELS / rect.width) * 100));
    const lower = (boundaries[index - 1] ?? 0) + minimum;
    const upper = (boundaries[index + 1] ?? 100) - minimum;
    return Math.max(lower, Math.min(upper, ((clientX - rect.left) / rect.width) * 100));
  }

  function begin(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    pointer.current = {
      pointerId: event.pointerId,
      cursor: document.documentElement.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setDragging(true);
    onFocus();
  }

  function move(event) {
    if (pointer.current?.pointerId === event.pointerId) onChange(index, constrainedValue(event.clientX));
  }

  function finish(event, cancelled = false) {
    if (pointer.current?.pointerId !== event.pointerId) return;
    if (!cancelled) onChange(index, constrainedValue(event.clientX));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    restoreDocument();
    setDragging(false);
    onCommit();
  }

  function keyDown(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    onFocus();
    onChange(index, constrainedValue(rect.left + ((value / 100) * rect.width)
      + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 32 : 8)));
    onCommit();
  }

  function reset(event) {
    event.preventDefault();
    onFocus();
    onReset();
  }

  return (
    <div
      role="separator"
      aria-label={`Resize terminal panels ${index + 1} and ${index + 2}`}
      aria-orientation="vertical"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      className="group absolute top-0 bottom-0 z-20 flex w-3 -translate-x-1/2 touch-none cursor-col-resize justify-center outline-none"
      style={{ left: `${value}%` }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={(event) => finish(event)}
      onPointerCancel={(event) => finish(event, true)}
      onDoubleClick={reset}
      onKeyDown={keyDown}
    >
      <span className={`h-full transition-[width,background-color] ${dragging ? 'w-1 bg-accent' : 'w-px bg-primary/50 group-hover:w-1 group-hover:bg-accent group-focus-visible:w-1 group-focus-visible:bg-accent'}`} aria-hidden="true" />
    </div>
  );
}

export default function SessionWorkspace({
  session, visible, focusedPanel, onPanelFocus, onDetails, onClose, onAgentChange,
  onOpenNotes, terminalMode, fontFamily, onSidebarFocus, onBottomTerminalFocus,
  onFullscreenChange, fullscreenExitRevision, onToggleSidebar,
}) {
  const [panelMode, setPanelMode] = useState('two');
  const roles = useMemo(() => panelsForMode(panelMode), [panelMode]);
  const containerRef = useRef(null);
  const boundariesRef = useRef(readBoundaries(roles.length));
  const [boundaries, setBoundaries] = useState(boundariesRef.current);
  const [agentChanging, setAgentChanging] = useState(false);
  const [agentError, setAgentError] = useState('');
  const [notesOpening, setNotesOpening] = useState(false);
  const [notesError, setNotesError] = useState('');
  const [fontSizes, setFontSizes] = useState(() => readFontSizes(session.id));
  const [fullscreenRole, setFullscreenRole] = useState(null);
  const fullscreenReportedRef = useRef(false);
  const fullscreenSource = `workspace-${session.id}`;
  boundariesRef.current = boundaries;
  const columns = useMemo(() => columnsFor(boundaries), [boundaries]);
  const displayName = session.name || session.branch || String(session.id);

  useEffect(() => {
    try { localStorage.setItem(`${FONT_SIZE_STORAGE_PREFIX}-${session.id}`, JSON.stringify(fontSizes)); }
    catch { /* optional persistence */ }
  }, [fontSizes, session.id]);

  useEffect(() => {
    const fullscreenVisible = visible && fullscreenRole !== null;
    if (fullscreenReportedRef.current === fullscreenVisible) return;
    fullscreenReportedRef.current = fullscreenVisible;
    onFullscreenChange?.(fullscreenSource, fullscreenVisible);
  }, [fullscreenRole, fullscreenSource, onFullscreenChange, visible]);

  useEffect(() => () => {
    if (fullscreenReportedRef.current) onFullscreenChange?.(fullscreenSource, false);
    fullscreenReportedRef.current = false;
  }, [fullscreenSource, onFullscreenChange]);

  useEffect(() => {
    if (!fullscreenRole) return;
    onFullscreenChange?.(fullscreenSource, false);
    setFullscreenRole(null);
  }, [fullscreenExitRevision]);

  useLayoutEffect(() => {
    if (boundariesRef.current.length === roles.length - 1) return;
    const next = readBoundaries(roles.length);
    boundariesRef.current = next;
    setBoundaries(next);
  }, [roles.length]);

  function changeBoundary(index, value) {
    const next = boundariesRef.current.map((boundary, currentIndex) => (
      currentIndex === index ? value : boundary
    ));
    boundariesRef.current = next;
    setBoundaries(next);
  }

  function saveBoundaries() {
    try {
      localStorage.setItem(`${SPLIT_STORAGE_PREFIX}-${roles.length}`, JSON.stringify(boundariesRef.current));
    } catch { /* optional persistence */ }
  }

  function resetBoundaries() {
    const next = defaultBoundaries(roles.length);
    boundariesRef.current = next;
    setBoundaries(next);
    try {
      localStorage.setItem(`${SPLIT_STORAGE_PREFIX}-${roles.length}`, JSON.stringify(next));
    } catch { /* optional persistence */ }
  }

  function navigatePanel(index, direction) {
    if (index === 0 && direction === -1) {
      leaveFullscreen();
      onSidebarFocus();
      return;
    }
    const nextRole = roles[index + direction];
    if (!nextRole) return;
    leaveFullscreen();
    onPanelFocus(`workspace-${session.id}-${nextRole}`);
  }

  function leaveFullscreen() {
    if (!fullscreenRole) return false;
    onFullscreenChange?.(fullscreenSource, false);
    setFullscreenRole(null);
    return true;
  }

  function focusBottomTerminal() {
    leaveFullscreen();
    return onBottomTerminalFocus();
  }

  async function changeAgent(agent) {
    const current = session.agent === 'codex' ? 'codex' : 'claude';
    if (agent === current || agentChanging) return;
    setAgentChanging(true);
    setAgentError('');
    try {
      await onAgentChange(session, agent);
    } catch (cause) {
      setAgentError(cause.message);
    } finally {
      setAgentChanging(false);
    }
  }

  async function openNotes() {
    if (notesOpening || !session.notesPath) return;
    setNotesOpening(true);
    setNotesError('');
    try {
      await onOpenNotes(session);
    } catch (cause) {
      setNotesError(cause.message);
    } finally {
      setNotesOpening(false);
    }
  }

  function changeFontSize(role, delta) {
    setFontSizes((current) => ({
      ...current,
      [role]: Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, current[role] + delta)),
    }));
  }

  function changePanelMode(nextMode) {
    if (nextMode === panelMode) return;
    if (nextMode === 'two' && fullscreenRole === 'editor') setFullscreenRole(null);
    setPanelMode(nextMode);
    onPanelFocus(`workspace-${session.id}-${nextMode === 'three' ? 'editor' : 'shell'}`);
  }

  function toggleFullscreen(role) {
    const nextRole = fullscreenRole === role ? null : role;
    // Report during the input event so requestFullscreen retains user activation.
    onFullscreenChange?.(fullscreenSource, nextRole !== null);
    setFullscreenRole(nextRole);
    onPanelFocus(`workspace-${session.id}-${role}`);
  }

  return (
    <main
      className={`${visible ? 'flex' : 'hidden'} absolute inset-0 h-screen min-h-0 min-w-0 flex-col overflow-hidden bg-page`}
      aria-label={`${displayName} terminal workspace`}
      aria-hidden={!visible}
      inert={!visible}
    >
      {!fullscreenRole && <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-primary/40 px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-sm font-bold text-primary">{displayName}</h2>
          <p className="truncate font-mono text-xs text-muted" title={session.path}>{session.path}</p>
        </div>
        <PanelModeToggle value={panelMode} onChange={changePanelMode} />
        {(session.notesPath || session.issues?.length > 0) && (
          <nav className="flex max-w-[45%] flex-wrap items-center justify-end gap-1" aria-label="Associated links">
            {session.notesPath && (
              <button
                type="button"
                className="inline-flex min-h-6 items-center justify-center rounded-full border border-primary bg-accent px-2 py-1 text-on-accent shadow-sm transition-transform hover:scale-105 disabled:cursor-wait disabled:opacity-50"
                aria-label="Open session notes directory"
                title={session.notesPath}
                disabled={notesOpening}
                onClick={openNotes}
              >{notesOpening ? <Spinner className="size-3.5" /> : <AssetIcon name="notes" className="size-4" />}</button>
            )}
            {session.issues?.map((issue) => <LinkPill key={issue.ref} entry={issue} />)}
            {notesError && <span className="max-w-48 truncate text-xs text-danger" role="alert" title={notesError}>{notesError}</span>}
          </nav>
        )}
        <Button variant="secondary" className="min-h-8 px-2 py-1 text-xs" onClick={() => onDetails(session.id)}>Details</Button>
        <IconButton compact label="Close terminal workspace" title="Close terminal workspace" onClick={onClose}><XIcon /></IconButton>
      </header>}
      <div
        ref={containerRef}
        className="relative grid min-h-0 flex-1"
        style={{ gridTemplateColumns: fullscreenRole ? 'minmax(0, 1fr)' : columns }}
      >
        {roles.map((role, index) => {
          const { label, Icon } = ROLE_DETAILS[role];
          const panelName = `workspace-${session.id}-${role}`;
          const focused = focusedPanel === panelName;
          const suppressed = Boolean(fullscreenRole && fullscreenRole !== role);
          return (
            <section
              key={role}
              className={`${suppressed ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-col overflow-hidden ring-inset ${focused ? 'ring-2 ring-accent/60' : ''}`}
              aria-label={`${label} terminal panel`}
              aria-hidden={suppressed}
              inert={suppressed}
              data-panel={panelName}
              data-panel-focused={focused}
              data-terminal-fullscreen={fullscreenRole === role}
              onPointerEnter={() => onPanelFocus(panelName)}
              onPointerDownCapture={() => onPanelFocus(panelName)}
              onFocusCapture={() => onPanelFocus(panelName)}
            >
              <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-primary/30 px-2 font-mono text-xs font-bold text-primary">
                <h3 className="flex min-w-0 items-center gap-1.5"><Icon className="size-3.5" />{label}</h3>
                <div className="ml-auto flex min-w-0 items-center gap-1.5">
                  {role === 'agent' && agentError && <span className="truncate text-danger" role="alert" title={agentError}>{agentError}</span>}
                  <TerminalFontControls label={label} value={fontSizes[role]} onChange={(delta) => changeFontSize(role, delta)} />
                  {role === 'agent' && (
                    <AgentToggle
                      compact
                      value={session.agent === 'codex' ? 'codex' : 'claude'}
                      disabled={agentChanging}
                      onChange={changeAgent}
                    />
                  )}
                </div>
              </div>
              <div className="flex min-h-0 flex-1 p-1">
                <Suspense fallback={<div className="flex flex-1 items-center justify-center gap-2 text-xs text-primary"><span className="size-4 animate-spin rounded-full border-2 border-current/25 border-t-current" /> Loading terminal…</div>}>
                  <LocalTerminal
                    key={role === 'agent' ? `${role}-${session.agent}` : role}
                    sessionId={session.id}
                    role={role}
                    fontSize={fontSizes[role]}
                    fontFamily={fontFamily}
                    themeMode={terminalMode}
                    visible={visible && !suppressed}
                    autoFocus={index === 0}
                    focused={visible && !suppressed && focused}
                    onPanelNavigate={(direction) => navigatePanel(index, direction)}
                    onNavigateDown={focusBottomTerminal}
                    onToggleFullscreen={() => toggleFullscreen(role)}
                    onToggleSidebar={onToggleSidebar}
                    label={`${label} terminal for ${displayName}`}
                    className="rounded-none border-0"
                  />
                </Suspense>
              </div>
            </section>
          );
        })}
        {!fullscreenRole && boundaries.map((value, index) => (
          <SplitHandle
            key={index}
            index={index}
            value={value}
            containerRef={containerRef}
            boundaries={boundaries}
            onChange={changeBoundary}
            onCommit={saveBoundaries}
            onFocus={() => onPanelFocus(`workspace-${session.id}-${roles[index]}`)}
            onReset={resetBoundaries}
          />
        ))}
      </div>
    </main>
  );
}
