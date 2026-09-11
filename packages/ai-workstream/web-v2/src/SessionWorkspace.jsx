import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';

import { syncWorkstream } from './api.js';
import {
  ArchiveIcon, AssetIcon, EditorIcon, RefreshIcon, RobotIcon, ShellIcon, Spinner, TargetIcon, XIcon,
} from './icons.jsx';
import { LinkPill } from './LinkEditor.jsx';
import { panelsForMode } from './constants.js';
import {
  AgentToggle, Button, IconButton, PanelModeToggle,
} from './ui.jsx';
import { canArchiveSession } from './utils.js';
import TerminalPanel, {
  clampTerminalFontSize, DEFAULT_TERMINAL_FONT_SIZE,
} from './TerminalPanel.jsx';
import TerminalSplitLayout, {
  defaultSplitBoundaries, normalizeSplitBoundaries,
} from './TerminalSplitLayout.jsx';

const SPLIT_STORAGE_PREFIX = 'ai-workstream-workspace-splits';
const FONT_SIZE_STORAGE_PREFIX = 'ai-workstream-terminal-font-sizes';
const ROLE_DETAILS = {
  shell: { label: 'Shell', Icon: ShellIcon },
  editor: { label: 'Editor', Icon: EditorIcon },
  agent: { label: 'Agent', Icon: RobotIcon },
};

function readFontSizes(sessionId) {
  const fallback = Object.fromEntries(Object.keys(ROLE_DETAILS).map((role) => [role, DEFAULT_TERMINAL_FONT_SIZE]));
  try {
    const stored = JSON.parse(localStorage.getItem(`${FONT_SIZE_STORAGE_PREFIX}-${sessionId}`));
    for (const role of Object.keys(fallback)) {
      const value = Number(stored?.[role]);
      if (Number.isFinite(value)) fallback[role] = clampTerminalFontSize(value);
    }
  } catch { /* optional persistence */ }
  return fallback;
}

function readBoundaries(count) {
  try {
    const stored = JSON.parse(localStorage.getItem(`${SPLIT_STORAGE_PREFIX}-${count}`));
    return normalizeSplitBoundaries(stored, count);
  } catch {
    return defaultSplitBoundaries(count);
  }
}

export default function SessionWorkspace({
  session, target, visible, active = visible, focusedPanel, onPanelFocus, onDetails, onArchive, onClose, onAgentChange, onReset,
  panelMode = 'two', onPanelModeChange, onOpenNotes, terminalMode, fontFamily, onSidebarFocus,
  onFullscreenChange, fullscreenExitRevision, onToggleSidebar, onNewTerminal,
}) {
  const roles = useMemo(() => panelsForMode(panelMode), [panelMode]);
  const boundariesRef = useRef(readBoundaries(roles.length));
  const [boundaries, setBoundaries] = useState(boundariesRef.current);
  const [agentChanging, setAgentChanging] = useState(false);
  const [agentError, setAgentError] = useState('');
  const [notesOpening, setNotesOpening] = useState(false);
  const [notesError, setNotesError] = useState('');
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState('');
  const [terminalsResetting, setTerminalsResetting] = useState(false);
  const [terminalResetError, setTerminalResetError] = useState('');
  const [fontSizes, setFontSizes] = useState(() => readFontSizes(session.id));
  const [fullscreenRole, setFullscreenRole] = useState(null);
  const fullscreenReportedRef = useRef(false);
  const targetId = target?.id || 'local';
  const fullscreenSource = `workspace-${targetId}-${session.id}`;
  const panelId = (role) => `workspace-${targetId}-${session.id}-${role}`;
  boundariesRef.current = boundaries;
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
    const next = defaultSplitBoundaries(roles.length);
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
    onPanelFocus(panelId(nextRole));
  }

  function leaveFullscreen() {
    if (!fullscreenRole) return false;
    onFullscreenChange?.(fullscreenSource, false);
    setFullscreenRole(null);
    return true;
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

  async function archiveSession() {
    if (archiving || !canArchiveSession(session)) return;
    setArchiving(true);
    setArchiveError('');
    try {
      await onArchive(session);
    } catch (cause) {
      setArchiveError(cause.message);
      setArchiving(false);
    }
  }

  async function resetTerminals() {
    if (terminalsResetting) return;
    if (!window.confirm(`Reset every terminal for ${displayName}? Running shell, editor, and agent processes will be stopped and recreated.`)) return;
    setTerminalsResetting(true);
    setTerminalResetError('');
    try {
      await onReset(session);
    } catch (cause) {
      setTerminalResetError(cause.message);
    } finally {
      setTerminalsResetting(false);
    }
  }

  function changeFontSize(role, delta) {
    setFontSizes((current) => ({
      ...current,
      [role]: clampTerminalFontSize(current[role] + delta),
    }));
  }

  function changePanelMode(nextMode) {
    if (nextMode === panelMode) return;
    if (nextMode === 'two' && fullscreenRole === 'editor') setFullscreenRole(null);
    onPanelModeChange(nextMode);
    onPanelFocus(panelId(nextMode === 'three' ? 'editor' : 'shell'));
  }

  function toggleFullscreen(role) {
    const nextRole = fullscreenRole === role ? null : role;
    // Report during the input event so requestFullscreen retains user activation.
    onFullscreenChange?.(fullscreenSource, nextRole !== null);
    setFullscreenRole(nextRole);
    onPanelFocus(panelId(role));
  }

  return (
    <main
      className={`${visible ? 'flex' : 'hidden'} absolute inset-0 h-screen min-h-0 min-w-0 flex-col overflow-hidden bg-page`}
      aria-label={`${displayName} terminal workspace`}
      aria-hidden={!visible}
      inert={!visible}
    >
      {!fullscreenRole && <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-primary/40 px-3 py-1.5">
        <TargetIcon target={target} className="size-5" />
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
        {(archiveError || terminalResetError) && <span className="max-w-48 truncate text-xs text-danger" role="alert" title={archiveError || terminalResetError}>{archiveError || terminalResetError}</span>}
        {(session.type === 'repo' || session.type === 'scratchpad') && (
          <IconButton compact label="Refresh session" title={session.type === 'repo' ? 'Sync session Markdown and current-branch pull request' : 'Sync session Markdown'} onClick={() => { void syncWorkstream(session.id, target).catch(() => {}); }}>
            <RefreshIcon />
          </IconButton>
        )}
        {canArchiveSession(session) && (
          <IconButton compact label="Archive session" title="Archive session" disabled={archiving} onClick={archiveSession}>
            {archiving ? <Spinner /> : <ArchiveIcon />}
          </IconButton>
        )}
        <IconButton compact label="Reset terminal sessions" title="Stop and recreate shell, editor, and agent terminals" disabled={terminalsResetting} onClick={resetTerminals}>
          {terminalsResetting ? <Spinner /> : <RefreshIcon />}
        </IconButton>
        <Button variant="secondary" className="min-h-8 px-2 py-1 text-xs" onClick={() => onDetails(session.id)}>Details</Button>
        <IconButton compact label="Close terminal workspace" title="Close terminal workspace" onClick={onClose}><XIcon /></IconButton>
      </header>}
      <TerminalSplitLayout
        count={roles.length}
        boundaries={boundaries}
        fullscreen={Boolean(fullscreenRole)}
        onBoundaryChange={changeBoundary}
        onBoundaryCommit={saveBoundaries}
        onBoundaryFocus={(index) => onPanelFocus(panelId(roles[index]))}
        onResetBoundaries={resetBoundaries}
      >
        {roles.map((role, index) => {
          const { label, Icon } = ROLE_DETAILS[role];
          const panelName = panelId(role);
          const focused = focusedPanel === panelName;
          const suppressed = Boolean(fullscreenRole && fullscreenRole !== role);
          return (
            <TerminalPanel
              key={role}
              panelName={panelName}
              label={label}
              Icon={Icon}
              shown={!suppressed}
              visible={visible}
              active={active && !suppressed}
              focused={focused}
              fullscreen={fullscreenRole === role}
              onPanelFocus={onPanelFocus}
              onToggleFullscreen={() => toggleFullscreen(role)}
              onFontSizeChange={(delta) => changeFontSize(role, delta)}
              headerMessage={role === 'agent' && agentError
                ? <span className="truncate text-danger" role="alert" title={agentError}>{agentError}</span>
                : null}
              headerActions={role === 'agent' ? (
                <AgentToggle
                  compact
                  value={session.agent === 'codex' ? 'codex' : 'claude'}
                  disabled={agentChanging}
                  onChange={changeAgent}
                />
              ) : null}
              terminalKey={role === 'agent' ? `${role}-${session.agent}` : role}
              target={target}
              sessionId={session.id}
              role={role}
              terminalId={`workspace-${role}`}
              fontSize={fontSizes[role]}
              fontFamily={fontFamily}
              themeMode={terminalMode}
              autoFocus={index === 0}
              onPanelNavigate={(direction) => navigatePanel(index, direction)}
              onToggleSidebar={onToggleSidebar}
              onNewTerminal={onNewTerminal}
              terminalLabel={`${label} terminal for ${displayName}`}
            />
          );
        })}
      </TerminalSplitLayout>
    </main>
  );
}
