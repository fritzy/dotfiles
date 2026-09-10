import { lazy, Suspense } from 'react';

import { CollapseIcon, ExpandIcon, TargetIcon } from './icons.jsx';

const LocalTerminal = lazy(() => import('./LocalTerminal.jsx'));

export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 24;

export function clampTerminalFontSize(value) {
  return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(
    MAX_TERMINAL_FONT_SIZE,
    Number(value) || DEFAULT_TERMINAL_FONT_SIZE,
  ));
}

export function TerminalFontControls({ label, value, onChange }) {
  const buttonClass = 'flex size-6 items-center justify-center rounded border border-primary bg-page text-base leading-none text-primary transition-colors hover:bg-soft hover:text-on-soft disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5" role="group" aria-label={`${label} terminal font size`}>
      <button type="button" className={buttonClass} disabled={value <= MIN_TERMINAL_FONT_SIZE} aria-label={`Decrease ${label} terminal font size`} title={`Decrease font size (${value}px)`} onClick={() => onChange(-1)}>−</button>
      <button type="button" className={buttonClass} disabled={value >= MAX_TERMINAL_FONT_SIZE} aria-label={`Increase ${label} terminal font size`} title={`Increase font size (${value}px)`} onClick={() => onChange(1)}>+</button>
    </div>
  );
}

export default function TerminalPanel({
  panelName, label, title = label, titleContent = null, Icon,
  shown = true, visible = true, focused = false, fullscreen = false,
  onPanelFocus, onToggleFullscreen, onFontSizeChange, headerActions = null, headerMessage = null,
  terminalKey, target, sessionId = null, role = null, terminalId = 'default',
  fontSize = DEFAULT_TERMINAL_FONT_SIZE, fontFamily, themeMode,
  autoFocus = false, onPanelNavigate, onToggleSidebar, onNewTerminal,
  onControlReady, onExit, terminalLabel = label,
}) {
  const terminalVisible = visible && shown;
  const focusPanel = () => { if (shown) onPanelFocus?.(panelName); };

  return (
    <section
      className={`${shown ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-col overflow-hidden ring-inset ${focused ? 'ring-2 ring-accent/60' : ''}`}
      aria-label={`${label} terminal panel`}
      aria-hidden={!shown}
      inert={!shown}
      data-panel={panelName}
      data-panel-focused={focused}
      data-terminal-fullscreen={fullscreen}
      onPointerEnter={focusPanel}
      onPointerDownCapture={focusPanel}
      onFocusCapture={focusPanel}
    >
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-primary/30 px-2 font-mono text-xs font-bold text-primary">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <TargetIcon target={target} className="size-3.5" />
          {Icon && <Icon className="size-3.5" />}
          {titleContent || <h3 className="truncate">{title}</h3>}
        </div>
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
          {headerMessage}
          <TerminalFontControls label={label} value={fontSize} onChange={onFontSizeChange} />
          {headerActions}
          {onToggleFullscreen && (
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded border border-primary bg-page text-primary transition-colors hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-accent"
              aria-label={fullscreen ? `Exit fullscreen for ${label}` : `Fullscreen ${label}`}
              title={`${fullscreen ? 'Exit fullscreen' : 'Fullscreen'} (Ctrl-F)`}
              aria-pressed={fullscreen}
              onClick={onToggleFullscreen}
            >{fullscreen ? <CollapseIcon className="size-3.5" /> : <ExpandIcon className="size-3.5" />}</button>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 p-1">
        <Suspense fallback={<div className="flex flex-1 items-center justify-center gap-2 text-xs text-primary"><span className="size-4 animate-spin rounded-full border-2 border-current/25 border-t-current" /> Loading terminal…</div>}>
          <LocalTerminal
            key={terminalKey}
            sessionId={sessionId}
            role={role}
            terminalId={terminalId}
            fontSize={fontSize}
            fontFamily={fontFamily}
            themeMode={themeMode}
            visible={terminalVisible}
            autoFocus={autoFocus}
            focused={terminalVisible && focused}
            onPanelNavigate={onPanelNavigate}
            onToggleFullscreen={onToggleFullscreen}
            onToggleSidebar={onToggleSidebar}
            onNewTerminal={onNewTerminal}
            onControlReady={onControlReady}
            onExit={onExit}
            label={terminalLabel}
            className="rounded-none border-0"
          />
        </Suspense>
      </div>
    </section>
  );
}
