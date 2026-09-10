import { useEffect, useRef } from 'react';

// Stands in for the real LocalTerminal (xterm.js/canvas aren't meaningful under
// jsdom) in standalone-session navigation tests. Mirrors just the focus and Ctrl-key
// navigation contract LocalTerminal implements via attachCustomKeyEventHandler,
// so BottomTabs' orchestration can be exercised end-to-end with real DOM focus.
export default function FakeLocalTerminal({
  visible = true, focused = null, autoFocus = true, label = 'fake terminal',
  terminalId = 'default',
  onPanelNavigate = null, onNavigateUp = null, onNavigateDown = null,
  onToggleFullscreen = null, onToggleSidebar = null, onNewTerminal = null,
}) {
  const ref = useRef(null);

  useEffect(() => {
    if (!visible || !(focused === true || (focused == null && autoFocus))) return;
    ref.current?.focus();
  }, [autoFocus, focused, visible]);

  function onKeyDown(event) {
    const key = event.key.toLowerCase();
    const controlOnly = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
    if (!controlOnly) return;
    if (key === 'f') { event.preventDefault(); onToggleFullscreen?.(); return; }
    if (key === 'p') { event.preventDefault(); onToggleSidebar?.(); return; }
    if (key === 't') { event.preventDefault(); onNewTerminal?.(); return; }
    if (key === 'k') { event.preventDefault(); onNavigateUp?.(); return; }
    if (key === 'j') { event.preventDefault(); onNavigateDown?.(); return; }
    if (key === 'h') { event.preventDefault(); onPanelNavigate?.(-1); return; }
    if (key === 'l') { event.preventDefault(); onPanelNavigate?.(1); }
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-fake-terminal={label}
      data-terminal-id={terminalId}
      aria-label={label}
      onKeyDown={onKeyDown}
    />
  );
}
