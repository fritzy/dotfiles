import {
  forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from 'react';

import { ShellIcon, XIcon } from './icons.jsx';

const LocalTerminal = lazy(() => import('./LocalTerminal.jsx'));

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const TAB_SWITCH_MS = 300;

function TabButton({ terminal, selected, onChoose, onClose }) {
  return (
    <div className="pointer-events-auto relative -mb-px h-10 min-w-28">
      <button
        id={`${terminal.id}-tab`}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls="bottom-terminal-panel"
        className={`relative inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-t-xl border border-b-0 pr-9 pl-4 text-sm font-semibold shadow-[0_-0.25rem_0.75rem_rgb(0_0_0/0.12)] transition-colors before:absolute before:-bottom-px before:-left-2 before:size-2 before:content-[''] after:absolute after:-right-2 after:-bottom-px after:size-2 after:content-[''] focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${selected ? "z-10 border-primary bg-accent text-on-accent before:bg-accent before:[clip-path:polygon(100%_0,100%_100%,0_100%)] after:bg-accent after:[clip-path:polygon(0_0,100%_100%,0_100%)]" : 'border-primary/60 bg-page text-primary before:hidden after:hidden hover:bg-soft hover:text-on-soft'}`}
        onClick={() => onChoose(terminal.id)}
      >
        <ShellIcon />
        <span className="truncate">{terminal.label}</span>
      </button>
      <button
        type="button"
        className={`absolute top-1/2 right-1 z-30 flex size-6 -translate-y-1/2 items-center justify-center rounded transition-colors focus-visible:outline-2 focus-visible:outline-accent ${selected ? 'text-on-accent/70 hover:bg-on-accent/15 hover:text-on-accent' : 'text-primary/70 hover:bg-soft hover:text-on-soft'}`}
        aria-label={`Close ${terminal.label}`}
        title={`Close ${terminal.label}`}
        onClick={() => onClose(terminal.id)}
      ><XIcon className="size-3.5" /></button>
    </div>
  );
}

function AddTerminalButton({ onClick }) {
  return (
    <button
      type="button"
      aria-label="New terminal"
      title="New terminal"
      className="pointer-events-auto mb-1 inline-flex h-9 min-w-14 items-center justify-center gap-0.5 rounded-full border border-primary bg-page px-3 text-primary shadow-lg transition-[color,background-color,transform] hover:-translate-y-0.5 hover:bg-soft hover:text-on-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      onClick={onClick}
    >
      <span className="text-base font-bold leading-none" aria-hidden="true">+</span>
      <ShellIcon className="size-4" />
    </button>
  );
}

function FontSizeControls({ terminal, onChange }) {
  return (
    <div className="inline-flex items-center rounded-md border border-primary bg-page/90 shadow-md backdrop-blur-sm" aria-label={`${terminal.label} font size`}>
      <button
        type="button"
        className="flex size-7 items-center justify-center rounded-l-md text-base font-bold text-primary transition-colors hover:bg-soft hover:text-on-soft disabled:opacity-40"
        aria-label={`Decrease ${terminal.label} font size`}
        title="Decrease font size"
        disabled={terminal.fontSize <= MIN_FONT_SIZE}
        onClick={() => onChange(terminal.id, -1)}
      >−</button>
      <span className="min-w-8 text-center text-xs font-semibold tabular-nums text-primary" aria-hidden="true">{terminal.fontSize}</span>
      <button
        type="button"
        className="flex size-7 items-center justify-center rounded-r-md text-base font-bold text-primary transition-colors hover:bg-soft hover:text-on-soft disabled:opacity-40"
        aria-label={`Increase ${terminal.label} font size`}
        title="Increase font size"
        disabled={terminal.fontSize >= MAX_FONT_SIZE}
        onClick={() => onChange(terminal.id, 1)}
      >+</button>
    </div>
  );
}

const BottomTabs = forwardRef(function BottomTabs({
  focusedPanel, onPanelFocus, leftOffset = '0rem', layoutResizing = false,
  terminalMode = 'dark', fontFamily = '"Roboto Mono", monospace', onFullscreenChange,
  onSidebarFocus, onWorkspaceFocus, onToggleSidebar,
}, ref) {
  const [terminals, setTerminals] = useState([]);
  const [active, setActive] = useState(null);
  const [displayed, setDisplayed] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const queuedTab = useRef(null);
  const pendingRemoval = useRef(null);
  const nextTerminalNumber = useRef(1);
  const lastUsedRef = useRef(null);
  const fullscreenReportedRef = useRef(false);
  const activeTerminal = terminals.find((terminal) => terminal.id === displayed) || null;
  const activePanel = activeTerminal ? `bottom-${activeTerminal.id}` : null;
  const activeFullscreen = Boolean(activeTerminal?.fullscreen);
  const tabOpacity = focusedPanel?.startsWith('workspace-')
    ? 'opacity-20 hover:opacity-100 focus-within:opacity-100'
    : 'opacity-100';

  useEffect(() => {
    const fullscreenVisible = drawerOpen && activeFullscreen;
    if (fullscreenReportedRef.current === fullscreenVisible) return;
    fullscreenReportedRef.current = fullscreenVisible;
    onFullscreenChange?.('bottom-terminals', fullscreenVisible);
  }, [activeFullscreen, drawerOpen, onFullscreenChange]);

  useEffect(() => () => {
    if (fullscreenReportedRef.current) onFullscreenChange?.('bottom-terminals', false);
    fullscreenReportedRef.current = false;
  }, [onFullscreenChange]);

  const hideDrawer = useCallback(() => {
    if (!drawerOpen && !closing) return false;
    queuedTab.current = null;
    setDrawerOpen(false);
    if (drawerOpen) setClosing(true);
    return true;
  }, [closing, drawerOpen]);

  const collapseDrawer = useCallback(() => {
    if (!hideDrawer()) return false;
    onPanelFocus(null);
    return true;
  }, [hideDrawer, onPanelFocus]);

  const focusTerminal = useCallback((id) => {
    if (!id) return false;
    lastUsedRef.current = id;
    if (closing) {
      queuedTab.current = id;
      onPanelFocus(`bottom-${id}`);
      return true;
    }
    queuedTab.current = null;
    setDisplayed(id);
    setActive(id);
    setDrawerOpen(true);
    onPanelFocus(`bottom-${id}`);
    return true;
  }, [closing, onPanelFocus]);

  const focusLastUsed = useCallback(() => {
    const remembered = lastUsedRef.current;
    const id = terminals.some((terminal) => terminal.id === remembered)
      ? remembered
      : terminals.at(-1)?.id;
    return id ? focusTerminal(id) : false;
  }, [focusTerminal, terminals]);

  useImperativeHandle(ref, () => ({
    focusLastUsed,
    hide: hideDrawer,
  }), [focusLastUsed, hideDrawer]);

  function chooseTab(id) {
    lastUsedRef.current = id;
    if (closing) {
      queuedTab.current = id;
      onPanelFocus(`bottom-${id}`);
      return;
    }
    if (drawerOpen && active === id) {
      collapseDrawer();
      return;
    }
    if (drawerOpen) {
      queuedTab.current = id;
      setDrawerOpen(false);
      setClosing(true);
      onPanelFocus(`bottom-${id}`);
      return;
    }
    queuedTab.current = null;
    setDisplayed(id);
    setActive(id);
    setDrawerOpen(true);
    onPanelFocus(`bottom-${id}`);
  }

  function addTerminal() {
    const number = nextTerminalNumber.current;
    nextTerminalNumber.current += 1;
    const terminal = {
      id: `terminal-${number}`,
      label: `terminal ${number}`,
      fontSize: DEFAULT_FONT_SIZE,
      fullscreen: false,
    };
    setTerminals((current) => [...current, terminal]);
    chooseTab(terminal.id);
  }

  function withoutTerminal(current, id) {
    const remaining = current.filter((terminal) => terminal.id !== id);
    if (lastUsedRef.current === id) lastUsedRef.current = remaining.at(-1)?.id || null;
    return remaining;
  }

  function closeTerminal(id) {
    const displayedTerminal = id === displayed;
    if (displayedTerminal && (drawerOpen || closing)) {
      pendingRemoval.current = id;
      if (!closing) {
        queuedTab.current = null;
        setDrawerOpen(false);
        setClosing(true);
      }
      onPanelFocus(null);
      return;
    }
    if (queuedTab.current === id) queuedTab.current = null;
    setTerminals((current) => withoutTerminal(current, id));
    if (displayedTerminal) {
      setDisplayed(null);
      setActive(null);
    }
  }

  function changeFontSize(id, amount) {
    setTerminals((current) => current.map((terminal) => terminal.id === id
      ? {
          ...terminal,
          fontSize: Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, terminal.fontSize + amount)),
        }
      : terminal));
  }

  function toggleFullscreen(id) {
    setTerminals((current) => current.map((terminal) => terminal.id === id
      ? { ...terminal, fullscreen: !terminal.fullscreen }
      : terminal));
    onPanelFocus(`bottom-${id}`);
  }

  function navigateTerminal(id, direction) {
    const index = terminals.findIndex((terminal) => terminal.id === id);
    if (index < 0) return false;
    const next = terminals[index + direction];
    if (next) return focusTerminal(next.id);
    if (direction === -1 && index === 0) {
      return typeof onSidebarFocus === 'function' ? onSidebarFocus() : false;
    }
    return true;
  }

  useEffect(() => {
    if (!closing) return undefined;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const timer = window.setTimeout(() => {
      const removed = pendingRemoval.current;
      pendingRemoval.current = null;
      if (removed) setTerminals((current) => withoutTerminal(current, removed));
      const next = queuedTab.current;
      queuedTab.current = null;
      setClosing(false);
      if (next && next !== removed) {
        setDisplayed(next);
        setActive(next);
        setDrawerOpen(true);
      } else {
        setActive(null);
        if (removed) setDisplayed(null);
      }
    }, reducedMotion ? 0 : TAB_SWITCH_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    function onKeyDown(event) {
      if (event.key === 'Escape'
          && !(event.target instanceof Element && event.target.closest('.xterm'))) collapseDrawer();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [collapseDrawer, drawerOpen]);

  return (
    <div className="contents" role="tablist" aria-label="Custom terminals">
      {drawerOpen && activeTerminal && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Collapse ${activeTerminal.label}`}
          className={`fixed top-0 right-0 bottom-0 z-30 cursor-default bg-transparent motion-reduce:transition-none ${layoutResizing ? '' : 'transition-[left] duration-300 ease-in-out'}`}
          style={{ left: leftOffset }}
          onClick={collapseDrawer}
        />
      )}

      <div
        className={`fixed right-0 bottom-0 z-40 flex flex-col duration-300 ease-in-out motion-reduce:transition-none ${activeFullscreen ? 'h-screen' : 'h-[calc(75vh+2.5rem)]'} ${layoutResizing ? 'transition-[translate]' : 'transition-[translate,left]'} ${drawerOpen && activeTerminal ? 'translate-y-0' : 'translate-y-[calc(100%-2.5rem)]'}`}
        style={{ left: leftOffset }}
      >
        <div className={`pointer-events-none relative z-10 flex h-10 shrink-0 items-end gap-1 px-2 transition-opacity duration-200 motion-reduce:transition-none ${tabOpacity}`}>
          <AddTerminalButton onClick={addTerminal} />
          {terminals.map((terminal) => active === terminal.id
            ? <TabButton key={terminal.id} terminal={terminal} selected onChoose={chooseTab} onClose={closeTerminal} />
            : <span key={terminal.id} className="block h-10 min-w-28" aria-hidden="true" />)}
        </div>

        <section
          id="bottom-terminal-panel"
          role="tabpanel"
          aria-labelledby={activeTerminal ? `${activeTerminal.id}-tab` : undefined}
          aria-hidden={!drawerOpen || !activeTerminal}
          className={`flex shrink-0 flex-col overflow-hidden rounded-t-2xl border-2 bg-page pb-1 text-ink shadow-[0_-1rem_3rem_rgb(0_0_0/0.25)] ${activeFullscreen ? 'h-[calc(100vh-2.5rem)]' : 'h-[75vh]'} ${focusedPanel === activePanel ? 'border-accent' : 'border-primary'} ${drawerOpen && activeTerminal ? '' : 'pointer-events-none'}`}
          data-panel={activePanel || undefined}
          data-panel-focused={Boolean(activePanel && focusedPanel === activePanel)}
          data-terminal-fullscreen={activeFullscreen}
          onPointerEnter={() => { if (activePanel) onPanelFocus(activePanel); }}
          onPointerDownCapture={() => { if (activePanel) onPanelFocus(activePanel); }}
          onFocusCapture={() => { if (activePanel) onPanelFocus(activePanel); }}
        >
          {activeTerminal && (
            <div className="relative flex min-h-0 flex-1 p-1">
              <div className="absolute top-3 right-3 z-20 opacity-20 transition-opacity hover:opacity-100 focus-within:opacity-100">
                <FontSizeControls terminal={activeTerminal} onChange={changeFontSize} />
              </div>
              <div className="relative min-h-0 flex-1">
                <Suspense fallback={<div className="flex h-full items-center justify-center gap-2 text-primary"><span className="size-5 animate-spin rounded-full border-2 border-current/25 border-t-current" /> Loading terminal…</div>}>
                  {terminals.map((terminal) => {
                    const terminalVisible = drawerOpen && active === terminal.id;
                    return (
                      <div key={terminal.id} className={`absolute inset-0 min-h-0 ${terminalVisible ? 'flex' : 'hidden'}`}>
                        <LocalTerminal
                          visible={terminalVisible}
                          autoFocus={false}
                          focused={terminalVisible && focusedPanel === `bottom-${terminal.id}`}
                          onPanelNavigate={(direction) => navigateTerminal(terminal.id, direction)}
                          onNavigateUp={onWorkspaceFocus}
                          onToggleFullscreen={() => toggleFullscreen(terminal.id)}
                          onToggleSidebar={onToggleSidebar}
                          onExit={() => closeTerminal(terminal.id)}
                          label={terminal.label}
                          themeMode={terminalMode}
                          fontFamily={fontFamily}
                          fontSize={terminal.fontSize}
                        />
                      </div>
                    );
                  })}
                </Suspense>
              </div>
            </div>
          )}
        </section>
      </div>

      <div
        className={`pointer-events-none fixed right-0 bottom-0 z-50 flex h-12 items-end gap-1 px-2 motion-reduce:transition-none ${layoutResizing ? 'transition-opacity duration-200' : 'transition-[left,opacity] duration-300 ease-in-out'} ${tabOpacity}`}
        style={{ left: leftOffset }}
      >
        <span className="block h-10 min-w-14" aria-hidden="true" />
        {terminals.map((terminal) => active === terminal.id
          ? <span key={terminal.id} className="block h-10 min-w-28" aria-hidden="true" />
          : <TabButton key={terminal.id} terminal={terminal} selected={false} onChoose={chooseTab} onClose={closeTerminal} />)}
      </div>
    </div>
  );
});

export default BottomTabs;
