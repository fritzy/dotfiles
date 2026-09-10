import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';

import {
  WEBSOCKET_RECONNECT_CAP_MS,
  websocketReconnectDelay,
} from '../web-v2/src/websocket-retry.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('v2 is an isolated React and Tailwind client using the existing protocol', () => {
  const main = read('web-v2/src/main.jsx');
  const app = read('web-v2/src/App.jsx');
  const daemonPane = read('web-v2/src/DaemonPane.jsx');
  const api = read('web-v2/src/api.js');
  const constants = read('web-v2/src/constants.js');
  const styles = read('web-v2/src/styles.css');
  const localTerminal = read('web-v2/src/LocalTerminal.jsx');
  const brandLogo = read('web-v2/src/BrandLogo.jsx');
  const sidebar = read('web-v2/src/ActiveSessionsSidebar.jsx');
  const index = read('web-v2/index.html');
  const vite = read('vite.config.js');

  assert.match(main, /createRoot/);
  assert.match(main, /<StrictMode>/);
  assert.match(styles, /@import "tailwindcss"/);
  assert.match(styles, /@theme inline/);
  assert.match(styles, /:root\[data-theme="dracula"\]/);
  assert.match(styles, /:root\[data-theme="tailwind-light"\]/);
  assert.match(styles, /:root\[data-theme="tailwind-dark"\]/);
  assert.match(constants, /label: 'Tailwind Light'/);
  assert.match(constants, /label: 'Tailwind Dark'/);
  assert.match(constants, /TERMINAL_MODE_STORAGE_KEY = 'ai-workstream-terminal-mode'/);
  assert.match(constants, /SYNC_WINDOW_FULLSCREEN_STORAGE_KEY = 'ai-workstream-sync-window-fullscreen'/);
  assert.match(constants, /TERMINAL_FONT_STORAGE_KEY = 'ai-workstream-terminal-font'/);
  // Every terminal font falls back to the Nerd Fonts symbol face for Powerline,
  // Devicons, Octicons, box drawing, and the rest.
  assert.match(constants, /NERD_FONT_FALLBACK = '"Symbols Nerd Font Mono"'/);
  assert.equal(constants.match(/\$\{NERD_FONT_FALLBACK\}, monospace`/g).length, 5);
  assert.match(styles, /font-family: "Symbols Nerd Font Mono"/);
  assert.match(localTerminal, /const primaryFamily = fontFamily\.split\(','\)\[0\]\.trim\(\)/);
  assert.match(localTerminal, /document\.fonts\?\.load\(`\$\{fontSize\}px \$\{primaryFamily\}`\)/);
  for (const family of ['Roboto Mono', 'Inconsolata', 'JetBrains Mono', 'Source Code Pro', 'IBM Plex Mono']) {
    assert.match(constants, new RegExp(family));
  }
  for (const asset of [
    'roboto-mono-latin.woff2', 'inconsolata-latin.woff2', 'jetbrains-mono-latin.woff2',
    'source-code-pro-latin.woff2', 'ibm-plex-mono-400-latin.woff2', 'ibm-plex-mono-700-latin.woff2',
    'symbols-nerd-font-mono.woff2',
  ]) {
    assert.equal(statSync(new URL(`../web-v2/public/fonts/${asset}`, import.meta.url)).size > 10_000, true);
    assert.match(styles, new RegExp(`/v2/fonts/${asset.replaceAll('.', '\\.')}`));
  }
  // The single global "current daemon" is gone: every request/socket takes an
  // explicit target, and DaemonPane (one live instance per target) owns the
  // events socket that used to live directly in App.jsx.
  assert.match(daemonPane, /new WebSocket\(wsUrl\('\/ws\/events', target\)\)/);
  assert.match(daemonPane, /setTimeout\(connect, websocketReconnectDelay\(reconnectAttempt\)\)/);
  assert.match(daemonPane, /setWorkspaceStateRevision\(\(value\) => value \+ 1\)/);
  assert.match(daemonPane, /setBottomTerminalStateRevision\(\(value\) => value \+ 1\)/);
  assert.match(daemonPane, /SOCKET_MESSAGE_TYPES\.has\(message\.type\)/);
  assert.match(localTerminal, /if \(ownedTerminal\) reconnectQuery\.set\('owner', '1'\)/);
  assert.match(localTerminal, /candidate = new WebSocket\(terminalUrl\(\)\)/);
  assert.match(localTerminal, /ownedTerminal = true/);
  assert.match(localTerminal, /ownedTerminal = false/);
  assert.match(localTerminal, /setTimeout\(connect, websocketReconnectDelay\(reconnectAttempt\)\)/);
  assert.match(api, /`\/ws\/all\/\?\$\{query\}`/);
  assert.match(api, /listActivePausedWorkstreams/);
  assert.match(api, /status: 'active_paused'/);
  assert.match(api, /`\/ws\/\$\{encodeURIComponent\(id\)\}\/\?status=all`/);
  assert.match(api, /`\/ws\/\$\{encodeURIComponent\(id\)\}\/\$\{command\}`/);
  assert.match(api, /'\/ws\/scratchpad'/);
  assert.match(api, /export function wsUrl\(path, target\)/);
  assert.doesNotMatch(api, /export function selectDaemon/);
  assert.doesNotMatch(api, /getCurrentDaemon/);
  assert.match(api, /export async function listDaemons\(signal\)/);
  assert.match(api, /fetch\('\/daemons', \{ signal \}\)/);
  // Target selection is passed into the existing sidebar rather than replacing
  // the target on each API call or reload.
  assert.doesNotMatch(sidebar, /daemons/);
  assert.doesNotMatch(sidebar, /onDaemonChange/);
  assert.match(vite, /base: '\/v2\/'/);
  assert.match(vite, /outDir: '\.\.\/web\/v2'/);
  assert.match(brandLogo, /viewBox="0 0 512 512"/);
  assert.match(brandLogo, /id="fw-brand-gear"/);
  assert.match(sidebar, /import BrandLogo from '\.\/BrandLogo\.jsx'/);
  assert.match(sidebar, /<BrandLogo className="size-11/);
  assert.match(index, /rel="icon" type="image\/svg\+xml"/);
  assert.match(index, /data:image\/svg\+xml/);

  // Local and Workstation share one collapsible sidebar while their DaemonPane
  // and BottomTabs instances remain mounted, so switching machines drops no
  // sockets and does not mix their terminal actions or persisted tab state.
  const targetContext = read('web-v2/src/target-context.js');
  // LOCAL_TARGET is hoisted so its identity is stable across renders — otherwise
  // every target-keyed effect (LocalTerminal's socket, DaemonPane's events socket)
  // would reconnect the moment the /daemons fetch resolves and rebuilds this array.
  assert.match(app, /const LOCAL_TARGET = \{ id: 'local', name: 'Local', url: null \};/);
  assert.match(app, /const targets = useMemo\(\(\) => \[LOCAL_TARGET, \.\.\.daemons\]/);
  assert.match(app, /const \[currentTargetId, setCurrentTargetId\] = useState\('local'\)/);
  assert.doesNotMatch(app, /localStorage.*currentTargetId|CURRENT_TARGET/);
  assert.doesNotMatch(app, /<DaemonRail/);
  assert.doesNotMatch(app, /DAEMON_RAIL_WIDTH_PIXELS/);
  assert.match(app, /targets\.map\(\(target\) => \(/);
  assert.match(app, /visible=\{target\.id === currentTargetId\}/);
  assert.match(app, /setFocusedPanel\(`sidebar-\$\{id\}-sessions`\)/);
  assert.match(app, /<ActiveSessionsSidebar/);
  assert.match(app, /sections=\{targetSections\}/);
  assert.match(sidebar, /targetSections\.map\(\(section\) =>/);
  assert.match(sidebar, /data-sidebar-target=\{sectionId\}/);
  assert.match(sidebar, /aria-expanded=\{!collapsed\}/);
  assert.match(sidebar, /onClick=\{\(\) => chooseTargetSection\(sectionId\)\}/);
  assert.doesNotMatch(sidebar, /DaemonTabs/);
  assert.match(targetContext, /export function useTarget\(\)/);
  assert.match(daemonPane, /<TargetProvider value=\{target\}>/);
});

test('websocket reconnect delay backs off exponentially to a fixed cap', () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_, attempt) => websocketReconnectDelay(attempt)),
    [500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000],
  );
  assert.equal(websocketReconnectDelay(1000), WEBSOCKET_RECONNECT_CAP_MS);
  assert.equal(websocketReconnectDelay(-1), 500);
});

test('v2 sidebar groups active sessions by repository in last-used order', async () => {
  const { groupActiveSessionsByRepo } = await import('../web-v2/src/utils.js');
  const groups = groupActiveSessionsByRepo([
    { id: 1, repo: 'acme/alpha', status: 'active', lastJoined: '2026-08-20T12:00:00Z' },
    { id: 2, repo: 'acme/beta', status: 'paused', lastJoined: '2026-08-26T12:00:00Z' },
    { id: 3, repo: 'acme/alpha', status: 'paused', lastJoined: '2026-08-25T12:00:00Z' },
    { id: 4, repo: 'scratch', type: 'scratchpad', status: 'active', lastJoined: null },
    { id: 5, repo: 'acme/closed', status: 'closed', lastJoined: '2026-08-27T12:00:00Z' },
  ]);
  assert.deepEqual(groups.map((group) => group.label), ['acme/beta', 'acme/alpha', 'Scratchpads']);
  assert.deepEqual(groups[1].items.map((item) => item.id), [3, 1]);
  assert.equal(groups.some((group) => group.label === 'acme/closed'), false);
});

test('v2 archives scratchpads in any open state and only completed repository sessions', async () => {
  const { canArchiveSession } = await import('../web-v2/src/utils.js');
  assert.equal(canArchiveSession({ type: 'scratchpad', status: 'active' }), true);
  assert.equal(canArchiveSession({ type: 'scratchpad', status: 'paused' }), true);
  assert.equal(canArchiveSession({ type: 'scratchpad', status: 'closed' }), false);
  assert.equal(canArchiveSession({ type: 'repo', status: 'active', prDone: true }), true);
  assert.equal(canArchiveSession({ type: 'repo', status: 'paused', prDone: false }), false);
  assert.equal(canArchiveSession({ type: 'misc', status: 'active', closeable: false }), false);
});

test('v2 retains the session controls and creation widgets as React components', () => {
  const app = read('web-v2/src/App.jsx');
  const daemonPane = read('web-v2/src/DaemonPane.jsx');
  const activeSidebar = read('web-v2/src/ActiveSessionsSidebar.jsx');
  const bottomTabs = read('web-v2/src/BottomTabs.jsx');
  const detail = read('web-v2/src/SessionDetailModal.jsx');
  const creation = read('web-v2/src/NewSessionModal.jsx');
  const icons = read('web-v2/src/icons.jsx');
  const links = read('web-v2/src/LinkEditor.jsx');
  const localTerminal = read('web-v2/src/LocalTerminal.jsx');
  const sessionWorkspace = read('web-v2/src/SessionWorkspace.jsx');
  const table = read('web-v2/src/SessionTable.jsx');
  const ui = read('web-v2/src/ui.jsx');
  const utils = read('web-v2/src/utils.js');

  assert.doesNotMatch(daemonPane, /SessionTable/);
  assert.doesNotMatch(daemonPane, /listWorkstreams/);
  assert.doesNotMatch(app, /Items per page/);
  assert.doesNotMatch(app, /Pagination/);
  assert.match(app, /<ActiveSessionsSidebar/);
  assert.doesNotMatch(daemonPane, /<ActiveSessionsSidebar/);
  assert.match(daemonPane, /<SessionWorkspace/);
  assert.doesNotMatch(app, /roles=\{panelsForMode\(panelMode\)\}/);
  assert.doesNotMatch(app, /PANEL_MODE_STORAGE_KEY/);
  assert.doesNotMatch(app, /const \[panelMode, setPanelMode\]/);
  assert.match(daemonPane, /\{ \.\.\.body, panels: \[\.\.\.DEFAULT_WORKSPACE_ROLES\] \}/);
  assert.match(daemonPane, /workspaceSessions\.map\(\(workspaceSession\) =>/);
  assert.match(daemonPane, /readBrowserState\(WORKSPACE_STATE_SCOPE/);
  assert.match(daemonPane, /writeBrowserState\(WORKSPACE_STATE_SCOPE/);
  assert.match(daemonPane, /panelMode: item\.panelMode === 'three' \? 'three' : 'two'/);
  assert.match(daemonPane, /key=\{workspaceSession\.id\}/);
  assert.match(daemonPane, /visible=\{!activeStandaloneId && String\(workspaceSession\.id\) === activeWorkspaceId\}/);
  assert.match(daemonPane, /onArchive=\{archiveWorkspace\}/);
  assert.match(daemonPane, /mutate\(item, 'terminal-reset'\)/);
  assert.match(daemonPane, /resetAllTerminalSessions\(target\)/);
  assert.match(daemonPane, /onReset=\{resetWorkspaceTerminals\}/);
  assert.match(daemonPane, /resetTerminals: resetDaemonTerminals/);
  assert.match(app, /onResetTerminals=\{resetCurrentTargetTerminals\}/);
  assert.match(daemonPane, /onClose=\{\(\) => closeWorkspace\(workspaceSession\.id\)\}/);
  assert.match(daemonPane, /command === 'resume' && result\.workstream/);
  assert.match(daemonPane, /command === 'pause' \|\| command === 'archive' \|\| command === 'close'/);
  assert.match(daemonPane, /mutate\(item, 'archive'\)/);
  assert.match(daemonPane, /function created\(item\)/);
  assert.match(daemonPane, /activateSession\(item\)/);
  assert.match(daemonPane, /bottomTabsRef\.current\?\.hide\(\)/);
  assert.match(daemonPane, /focusedPanel\?\.startsWith\('workspace-'\)/);
  assert.match(daemonPane, /\[focusedPanel\]/);
  assert.match(daemonPane, /listActivePausedWorkstreams/);
  // Sidebar width/visibility and browser-fullscreen tracking are the one physical
  // surface shared by every target, so they stay lifted in App.jsx.
  assert.match(app, /const sidebarWidth = sidebarOpen/);
  assert.match(app, /sidebarOpen \? `\$\{sidebarWidthPixels\}px` : '0px'/);
  assert.match(app, /const \[sidebarVisibility, setSidebarVisibility\] = useState\('shown'\)/);
  assert.match(app, /const sidebarOpen = sidebarVisibility === 'shown'/);
  assert.match(app, /const fullscreenSourcesRef = useRef\(new Set\(\)\)/);
  assert.match(app, /document\.documentElement\.requestFullscreen\(\)/);
  assert.match(app, /document\.exitFullscreen\(\)/);
  assert.match(app, /const \[fullscreenExitRevision, setFullscreenExitRevision\] = useState\(0\)/);
  assert.match(app, /requestTerminalFullscreenExit/);
  assert.match(app, /addEventListener\('fullscreenchange', browserFullscreenChanged\)/);
  assert.match(app, /function.*reportTerminalFullscreen|const reportTerminalFullscreen/);
  assert.match(app, /current === 'shown' \? 'temporarily-hidden' : current/);
  assert.match(app, /current === 'temporarily-hidden' \? 'shown' : current/);
  assert.match(app, /current === 'shown' \? 'manually-hidden' : 'shown'/);
  assert.doesNotMatch(app, /setSidebarOpen/);
  // App owns the one shared sidebar+content grid; each daemon pane owns that
  // machine's workstreams and standalone sessions.
  assert.match(app, /gridTemplateColumns: `\$\{sidebarWidth\}/);
  assert.doesNotMatch(daemonPane, /gridTemplateColumns/);
  assert.match(app, /const leftOffset = sidebarWidth/);
  assert.match(app, /SIDEBAR_WIDTH_STORAGE_KEY/);
  assert.match(app, /localStorage\.setItem\(SIDEBAR_WIDTH_STORAGE_KEY/);
  assert.match(app, /localStorage\.setItem\(TERMINAL_MODE_STORAGE_KEY, terminalMode\)/);
  assert.match(app, /localStorage\.setItem\(SYNC_WINDOW_FULLSCREEN_STORAGE_KEY, String\(syncWindowFullscreen\)\)/);
  assert.match(app, /syncWindowFullscreenRef\.current && !document\.fullscreenElement/);
  assert.match(app, /syncWindowFullscreenRef\.current && document\.fullscreenElement/);
  assert.match(app, /localStorage\.setItem\(TERMINAL_FONT_STORAGE_KEY, terminalFont\)/);
  assert.match(app, /const \[sidebarResizing, setSidebarResizing\]/);
  // A fresh load always lands on Local, so the app starts focused on its sidebar.
  assert.match(app, /useState\('sidebar-local-sessions'\)/);
  assert.doesNotMatch(app, /data-panel="main"/);
  assert.doesNotMatch(app, /setFocusedPanel\('main'\)/);
  // The machine-owned session host reports its selectors to the one shared sidebar.
  assert.match(daemonPane, /<BottomTabs[\s\S]*leftOffset=\{leftOffset\}/);
  assert.match(daemonPane, /ref=\{bottomTabsRef\}/);
  assert.match(bottomTabs, /data-standalone-sessions=\{targetId\}/);
  assert.match(bottomTabs, /onSessionsChange\?\.\(\{/);
  assert.match(daemonPane, /onSessionsChange=\{reportStandaloneSessions\}/);
  assert.match(app, /standaloneSessions: sidebarStates\[target\.id\]\?\.standaloneSessions \|\| \[\]/);
  assert.match(app, /onActivateStandalone=\{activateStandalone\}/);
  assert.match(app, /onCreateTerminal=\{createTerminal\}/);
  assert.match(app, /onOpenMarkdown=\{openMarkdown\}/);
  assert.match(daemonPane, /REFRESH_DEBOUNCE_MS/);
  assert.doesNotMatch(daemonPane, /listRequestRef/);
  assert.match(daemonPane, /activeSessionsRequestRef\.current !== requestId/);
  assert.match(daemonPane, /readBrowserState\(WORKSPACE_STATE_SCOPE, controller\.signal, target\)/);
  assert.match(activeSidebar, /groupActiveSessionsByRepo/);
  assert.match(activeSidebar, /aria-expanded=\{!collapsed\}/);
  assert.match(activeSidebar, /Collapse.*sidebar view/);
  assert.match(activeSidebar, /transition-\[grid-template-rows,opacity\]/);
  assert.match(activeSidebar, /name\.replace\(\/\^fritzy\\\//);
  assert.match(activeSidebar, /'…'/);
  assert.match(activeSidebar, /branchState\(item\)/);
  assert.match(utils, /item\.prDone === true/);
  assert.match(utils, /icon: 'check', color: 'text-success'/);
  assert.match(activeSidebar, /className=\{`size-3\.5 \$\{state\.color\}`\}/);
  assert.match(activeSidebar, /className=\{`size-2\.5 shrink-0 rounded-full ring-1 \$\{classes\}`\}/);
  assert.match(activeSidebar, /bg-active ring-on-active/);
  assert.match(activeSidebar, /bg-paused ring-on-paused/);
  assert.doesNotMatch(activeSidebar, />\{status\}<\/span>/);
  assert.match(activeSidebar, /active && item\.agentStatus === 'working'/);
  assert.match(activeSidebar, /active && item\.shellStatus === 'working'/);
  assert.match(activeSidebar, /if \(!agentWorking && !shellWorking\) return <SessionStatus status=\{item\.status\} \/>/);
  assert.match(activeSidebar, /inline-flex min-h-5 shrink-0 items-center gap-1 rounded-full px-1\.5 ring-1/);
  assert.match(activeSidebar, /<ProviderIcon provider=\{provider\} className="size-3\.5"/);
  assert.match(activeSidebar, /<ShellIcon className="size-3\.5"/);
  assert.match(activeSidebar, /<Spinner className="size-3" \/>/);
  assert.match(activeSidebar, /role="tablist"[\s\S]*aria-label="Sidebar views"/);
  assert.match(activeSidebar, /function chooseView\(nextView\)/);
  assert.match(activeSidebar, /const SIDEBAR_VIEWS = \['sessions', 'settings'\]/);
  assert.match(activeSidebar, /SIDEBAR_VIEWS\.map/);
  assert.match(activeSidebar, /onClick=\{\(\) => chooseView\(option\)\}/);
  assert.match(activeSidebar, /<AssetIcon name="folder" className="size-5"/);
  assert.match(activeSidebar, /<GearIcon className="size-5"/);
  assert.match(activeSidebar, /Syncing Window Fullscreen/);
  assert.match(activeSidebar, /checked=\{syncWindowFullscreen\}/);
  assert.match(activeSidebar, /onSyncWindowFullscreenChange\(event\.target\.checked\)/);
  assert.doesNotMatch(activeSidebar, /writing-mode:vertical-rl/);
  assert.match(activeSidebar, /focusedPanel !== sessionsPanel/);
  assert.match(activeSidebar, /\['f', 'h', 'j', 'k', 'l'\]\.includes\(key\)/);
  assert.match(activeSidebar, /event\.ctrlKey/);
  assert.match(activeSidebar, /function controlNavigation\(event\)/);
  assert.match(activeSidebar, /event\.preventDefault\(\)/);
  assert.match(activeSidebar, /event\.stopPropagation\(\)/);
  assert.match(activeSidebar, /function navigateView\(direction\)/);
  assert.match(activeSidebar, /navigateView\(key === 'j' \? 1 : -1\)/);
  assert.match(activeSidebar, /\(currentIndex \+ direction \+ SIDEBAR_VIEWS\.length\) % SIDEBAR_VIEWS\.length/);
  assert.match(activeSidebar, /onPanelFocus\(panelName\(nextView\)\)/);
  assert.match(activeSidebar, /key === 'l' && !event\.repeat/);
  assert.match(activeSidebar, /onContentFocus\(\)/);
  assert.match(activeSidebar, /panelRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(activeSidebar, /\['j', 'k', 'h', 'l', 'Enter'\]/);
  assert.match(activeSidebar, /kind: 'group'/);
  assert.match(activeSidebar, /kind: 'session'/);
  assert.match(activeSidebar, /event\.key === 'h'/);
  assert.match(activeSidebar, /setGroupCollapsed\(current\.targetId, current\.groupKind, current\.groupLabel, true\)/);
  assert.match(activeSidebar, /event\.key === 'l'/);
  assert.match(activeSidebar, /setGroupCollapsed\(current\.targetId, current\.groupKind, current\.groupLabel, false\)/);
  assert.match(activeSidebar, /data-sidebar-group=\{group\.label\}/);
  assert.match(activeSidebar, /text-left text-sm font-bold transition-colors/);
  assert.match(activeSidebar, /text-left font-mono text-sm transition-colors/);
  assert.match(activeSidebar, /onClick=\{\(\) => onActivate\(item\)\}/);
  assert.match(activeSidebar, /onDoubleClick=\{\(\) => onOpenDetails\(item\.id\)\}/);
  assert.match(activeSidebar, /min-h-screen/);
  assert.match(activeSidebar, /sticky top-0 grid h-screen/);
  assert.match(activeSidebar, /fixed top-2 z-\[55\] grid w-10/);
  assert.match(activeSidebar, /focusedPanel\?\.startsWith\('sidebar-'\)/);
  assert.match(activeSidebar, /opacity-20 hover:opacity-100 focus-within:opacity-100/);
  assert.match(activeSidebar, /transition-\[left,opacity\]/);
  assert.match(activeSidebar, /style=\{\{ left: sidebarWidth \}\}/);
  assert.match(activeSidebar, /role="separator"/);
  assert.match(activeSidebar, /aria-label="Resize sidebar"/);
  assert.match(activeSidebar, /setPointerCapture/);
  assert.match(activeSidebar, /onResizeEnd\(finalWidth\)/);
  assert.match(activeSidebar, /event\.key !== 'ArrowLeft'/);
  assert.doesNotMatch(activeSidebar, /grid-cols-\[minmax\(0,1fr\)_2\.5rem\]/);
  assert.match(activeSidebar, /data-panel=\{currentPanel\}/);
  assert.match(activeSidebar, /onPointerEnter=\{\(\) => onPanelFocus\(currentPanel\)\}/);
  assert.doesNotMatch(activeSidebar, /grid-cols-2 gap-1 px-1\.5 pt-1/);
  // The shared sidebar tracks the selected target in its panel id so focus can
  // move into the corresponding machine's selected content.
  assert.match(activeSidebar, /const panelName = \(forView\) => `sidebar-\$\{targetId\}-\$\{forView\}`/);
  assert.match(activeSidebar, /\$\{panelName\('settings'\)\}-view/);
  assert.doesNotMatch(activeSidebar, /PanelModeToggle/);
  assert.doesNotMatch(activeSidebar, /Panel layout/);
  assert.match(activeSidebar, /id="sidebar-theme"/);
  assert.match(activeSidebar, /id="sidebar-terminal-mode"/);
  assert.match(activeSidebar, /id="sidebar-terminal-font"/);
  assert.match(activeSidebar, /Object\.entries\(TERMINAL_FONTS\)/);
  assert.match(activeSidebar, /Reset all terminal sessions/);
  assert.match(activeSidebar, /Delete every FritzWorks Zellij session/);
  assert.match(activeSidebar, /<option value="dark">Dark<\/option>/);
  assert.match(activeSidebar, /<option value="light">Light<\/option>/);
  assert.doesNotMatch(app, /<PanelModeToggle/);
  assert.doesNotMatch(app, /aria-label="Theme"/);
  assert.match(daemonPane, /fixed right-2 bottom-2 z-\[60\]/);
  assert.doesNotMatch(app, /event\.key === 'j'/);
  assert.doesNotMatch(app, /runTableCommand/);
  assert.match(table, /highlightedId/);
  assert.match(table, /scrollIntoView/);
  assert.match(ui, /event\.key !== 'Escape'/);
  assert.match(utils, /!\/\[gjpqy\]\//);
  assert.match(utils, /pt-\[5px\] pb-\[3px\]/);
  assert.match(daemonPane, /<SessionDetailModal/);
  assert.match(detail, /run\('terminal-reset'\)/);
  assert.match(detail, /Reset terminals/);
  assert.match(daemonPane, /<NewSessionModal/);
  assert.match(daemonPane, /<BottomTabs/);
  assert.match(bottomTabs, /forwardRef\(function BottomTabs/);
  assert.match(bottomTabs, /useImperativeHandle\(ref/);
  assert.match(bottomTabs, /focusLastUsed/);
  assert.match(bottomTabs, /hide: deactivate/);
  assert.match(bottomTabs, /activate,/);
  assert.match(bottomTabs, /close: closeTab/);
  assert.match(bottomTabs, /openMarkdown: \(\) => setPickerOpen\(true\)/);
  assert.match(bottomTabs, /const lastUsedRef = useRef\(null\)/);
  assert.match(bottomTabs, /function navigatePanel\(direction\)/);
  assert.match(bottomTabs, /onPanelNavigate=\{navigatePanel\}/);
  assert.match(bottomTabs, /onToggleSidebar=\{onToggleSidebar\}/);
  assert.match(bottomTabs, /onExit=\{\(\) => closeTab\(tab\.id\)\}/);
  assert.doesNotMatch(bottomTabs, /function TabButton/);
  assert.doesNotMatch(bottomTabs, /role="tablist"/);
  assert.doesNotMatch(bottomTabs, /translate-y/);
  assert.match(activeSidebar, /function StandaloneSessionRow/);
  assert.match(activeSidebar, /data-sidebar-standalone=\{item\.id\}/);
  assert.match(activeSidebar, /label: 'Terminals', kind: 'standalone'/);
  assert.match(activeSidebar, /label: 'Markdown', kind: 'standalone'/);
  assert.match(activeSidebar, /aria-label=\{`New \$\{section\.target\.name\} terminal`\}/);
  assert.match(activeSidebar, /aria-label=\{`Open \$\{section\.target\.name\} Markdown`\}/);
  assert.match(activeSidebar, /onActivateStandalone\(sectionId, item\.id\)/);
  assert.match(activeSidebar, /onCloseStandalone\(sectionId, item\.id\)/);
  assert.match(bottomTabs, /const \[tabs, setTabs\] = useState\(\[\]\)/);
  assert.match(bottomTabs, /const nextTerminalNumber = useRef\(1\)/);
  assert.match(bottomTabs, /id: newTerminalId\(\)/);
  assert.match(bottomTabs, /setTabs\(\(current\) => \[\.\.\.current, terminal\]\)/);
  assert.match(bottomTabs, /const createTerminal = useCallback/);
  assert.match(bottomTabs, /return id \? activate\(id\) : createTerminal\(\)/);
  assert.match(bottomTabs, /const panelId = \(id\) => `standalone-\$\{targetId\}-\$\{id\}`/);
  assert.match(bottomTabs, /absolute inset-0 z-20 min-h-0 flex-col/);
  assert.match(bottomTabs, /active === tab\.id/);
  assert.match(bottomTabs, /const closeTab = useCallback/);
  assert.match(bottomTabs, /aria-label=\{`Close \$\{activeTab\.label\}`\}/);
  assert.match(bottomTabs, /<XIcon className="size-3\.5" \/>/);
  assert.match(bottomTabs, /tabs\.filter\(\(item\) => item\.id !== id\)/);
  assert.match(bottomTabs, /<header/);
  assert.match(bottomTabs, /<h2/);
  assert.doesNotMatch(bottomTabs, /IconButton/);
  assert.match(bottomTabs, /bg-page\/90 shadow-md backdrop-blur-sm/);
  assert.match(bottomTabs, /opacity-20 transition-opacity hover:opacity-100 focus-within:opacity-100/);
  assert.doesNotMatch(bottomTabs, /Lorem ipsum/);
  assert.doesNotMatch(bottomTabs, /test 1/);
  assert.match(bottomTabs, /<LocalTerminal/);
  assert.match(bottomTabs, /tabs\.map\(\(tab\) =>/);
  assert.match(bottomTabs, /visible=\{tabVisible\}/);
  assert.equal((bottomTabs.match(/focused=\{tabVisible && focusedPanel === panelId\(tab\.id\)\}/g) || []).length, 2);
  assert.match(bottomTabs, /data-panel=\{activePanel \|\| undefined\}/);
  assert.match(bottomTabs, /leftOffset = '0rem'/);
  assert.match(bottomTabs, /onPointerEnter=\{\(\) => \{ if \(activePanel\) onPanelFocus\(activePanel\); \}\}/);
  assert.match(bottomTabs, /fontSize=\{tab\.fontSize\}/);
  assert.match(bottomTabs, /fullscreen: false/);
  assert.match(bottomTabs, /function toggleFullscreen\(id\)/);
  assert.match(bottomTabs, /const fullscreenSource = `standalone-\$\{targetId\}`/);
  assert.match(bottomTabs, /onFullscreenChange\?\.\(fullscreenSource, !tab\.fullscreen\)/);
  assert.match(bottomTabs, /const leaveFullscreen = useCallback/);
  assert.match(bottomTabs, /fullscreenExitRevision/);
  assert.match(bottomTabs, /fullscreen: !item\.fullscreen/);
  assert.match(bottomTabs, /data-terminal-fullscreen=\{activeFullscreen\}/);
  assert.match(bottomTabs, /onToggleFullscreen=\{\(\) => toggleFullscreen\(tab\.id\)\}/);
  assert.match(bottomTabs, /const fullscreenVisible = visible && Boolean\(activeTab\) && activeFullscreen/);
  assert.match(bottomTabs, /onFullscreenChange\?\.\(fullscreenSource, fullscreenVisible\)/);
  assert.match(bottomTabs, /onFullscreenChange\?\.\(fullscreenSource, false\)/);
  // Every target keeps its standalone session host mounted but inert while hidden.
  assert.match(bottomTabs, /visible = true, focusedPanel/);
  assert.match(bottomTabs, /className=\{visible \? 'contents' : 'hidden'\}[\s\S]*inert=\{!visible\}/);
  assert.match(bottomTabs, /themeMode=\{terminalMode\}/);
  assert.match(bottomTabs, /fontFamily=\{fontFamily\}/);
  assert.match(bottomTabs, /lazy\(\(\) => import\('\.\/LocalTerminal\.jsx'\)\)/);
  assert.match(localTerminal, /new Terminal/);
  assert.match(localTerminal, /const TERMINAL_THEMES/);
  assert.match(localTerminal, /terminal\.options\.theme = terminalTheme\(themeMode\)/);
  assert.match(localTerminal, /terminal\.options\.fontSize = fontSize/);
  assert.match(localTerminal, /terminal\.options\.fontFamily = fontFamily/);
  assert.match(localTerminal, /document\.fonts\?\.load\(`\$\{fontSize\}px \$\{primaryFamily\}`\)/);
  assert.match(localTerminal, /\[fontFamily, fontSize, themeMode\]/);
  assert.doesNotMatch(localTerminal, /MutationObserver/);
  assert.match(localTerminal, /new FitAddon/);
  assert.match(localTerminal, /\/ws\/terminal/);
  assert.match(localTerminal, /terminalQuery\.set\('session', String\(sessionId\)\)/);
  assert.match(localTerminal, /terminalQuery\.set\('role', role\)/);
  assert.match(localTerminal, /type: 'resize'/);
  assert.match(localTerminal, /type: 'input'/);
  assert.match(localTerminal, /terminalRef/);
  assert.match(localTerminal, /focusedRef\.current == null \? autoFocusRef\.current : focusedRef\.current/);
  assert.match(localTerminal, /focused === true \|\| \(focused == null && autoFocus\)/);
  assert.match(localTerminal, /\}, \[visible\]\);/);
  assert.match(localTerminal, /requestAnimationFrame\(\(\) => terminalRef\.current\?\.focus\(\)\)/);
  assert.match(localTerminal, /attachCustomKeyEventHandler/);
  assert.match(localTerminal, /const toggleFullscreenRef = useRef\(onToggleFullscreen\)/);
  assert.match(localTerminal, /const exitRef = useRef\(onExit\)/);
  assert.match(localTerminal, /exitRef\.current\?\.\(message\)/);
  assert.match(localTerminal, /const navigateUpRef = useRef\(onNavigateUp\)/);
  assert.match(localTerminal, /const navigateDownRef = useRef\(onNavigateDown\)/);
  assert.match(localTerminal, /key === 'k' \? navigateUpRef\.current/);
  assert.match(localTerminal, /key === 'j' \? navigateDownRef\.current/);
  assert.match(localTerminal, /controlOnly && \(key === 'j' \|\| key === 'k'\)/);
  assert.match(localTerminal, /if \(direction && controlOnly\)/);
  assert.doesNotMatch(localTerminal, /verticalHandler\(\) !== false/);
  assert.doesNotMatch(localTerminal, /panelNavigateRef\.current\(direction\) === false/);
  assert.match(localTerminal, /key === 'p' && controlOnly/);
  assert.match(localTerminal, /toggleSidebarRef\.current\(\)/);
  assert.match(localTerminal, /key === 'f' && controlOnly/);
  assert.match(localTerminal, /event\.type === 'keydown' && !event\.repeat/);
  assert.match(localTerminal, /toggleFullscreenRef\.current\(\)/);
  assert.match(localTerminal, /event\.preventDefault\(\)/);
  assert.match(localTerminal, /event\.stopPropagation\(\)/);
  assert.match(localTerminal, /panelNavigateRef\.current\(direction\)/);
  assert.match(localTerminal, /return false/);
  assert.match(sessionWorkspace, /roles\.map/);
  assert.match(sessionWorkspace, /panelMode = 'two', onPanelModeChange/);
  assert.match(sessionWorkspace, /const roles = useMemo\(\(\) => panelsForMode\(panelMode\), \[panelMode\]\)/);
  assert.match(sessionWorkspace, /<PanelModeToggle value=\{panelMode\} onChange=\{changePanelMode\} \/>/);
  assert.match(sessionWorkspace, /onPanelModeChange\(nextMode\)/);
  assert.match(sessionWorkspace, /nextMode === 'three' \? 'editor' : 'shell'/);
  assert.match(sessionWorkspace, /const \[fullscreenRole, setFullscreenRole\] = useState\(null\)/);
  assert.match(sessionWorkspace, /\{!fullscreenRole && <header/);
  assert.match(sessionWorkspace, /<\/header>\}/);
  assert.match(sessionWorkspace, /function toggleFullscreen\(role\)/);
  assert.match(sessionWorkspace, /onFullscreenChange\?\.\(fullscreenSource, nextRole !== null\)/);
  assert.match(sessionWorkspace, /function leaveFullscreen\(\)/);
  assert.match(sessionWorkspace, /fullscreenExitRevision/);
  assert.match(sessionWorkspace, /const nextRole = fullscreenRole === role \? null : role/);
  assert.match(sessionWorkspace, /gridTemplateColumns: fullscreenRole \? 'minmax\(0, 1fr\)' : columns/);
  assert.match(sessionWorkspace, /suppressed \? 'hidden' : 'flex'/);
  assert.match(sessionWorkspace, /!fullscreenRole && boundaries\.map/);
  assert.match(sessionWorkspace, /onToggleFullscreen=\{\(\) => toggleFullscreen\(role\)\}/);
  assert.match(sessionWorkspace, /const fullscreenVisible = visible && fullscreenRole !== null/);
  assert.match(sessionWorkspace, /onFullscreenChange\?\.\(fullscreenSource, fullscreenVisible\)/);
  assert.match(sessionWorkspace, /onFullscreenChange\?\.\(fullscreenSource, false\)/);
  assert.match(sessionWorkspace, /role="separator"/);
  assert.match(sessionWorkspace, /setPointerCapture/);
  assert.match(sessionWorkspace, /onDoubleClick=\{reset\}/);
  assert.match(sessionWorkspace, /function resetBoundaries\(\)/);
  assert.match(sessionWorkspace, /const next = defaultBoundaries\(roles\.length\)/);
  assert.match(sessionWorkspace, /onReset=\{resetBoundaries\}/);
  assert.match(sessionWorkspace, /SPLIT_STORAGE_PREFIX/);
  assert.match(sessionWorkspace, /<LocalTerminal/);
  assert.match(sessionWorkspace, /function TerminalFontControls/);
  assert.match(sessionWorkspace, /Decrease \$\{label\} terminal font size/);
  assert.match(sessionWorkspace, /Increase \$\{label\} terminal font size/);
  assert.match(sessionWorkspace, /fontSize=\{fontSizes\[role\]\}/);
  assert.match(sessionWorkspace, /fontFamily=\{fontFamily\}/);
  assert.match(sessionWorkspace, /themeMode=\{terminalMode\}/);
  assert.match(sessionWorkspace, /FONT_SIZE_STORAGE_PREFIX/);
  assert.match(sessionWorkspace, /session\.issues\?\.length > 0/);
  assert.match(sessionWorkspace, /aria-label="Associated links"/);
  assert.match(sessionWorkspace, /session\.notesPath \|\| session\.issues\?\.length > 0/);
  assert.match(sessionWorkspace, /aria-label="Open session notes directory"/);
  assert.match(sessionWorkspace, /<AssetIcon name="notes" className="size-4" \/>/);
  assert.match(sessionWorkspace, /await onOpenNotes\(session\)/);
  assert.match(sessionWorkspace, /canArchiveSession\(session\)/);
  assert.match(sessionWorkspace, /await onArchive\(session\)/);
  assert.match(sessionWorkspace, /label="Archive session"/);
  assert.match(sessionWorkspace, /<ArchiveIcon \/>/);
  assert.match(sessionWorkspace, /session\.issues\?\.map\(\(issue\) => <LinkPill key=\{issue\.ref\} entry=\{issue\} \/>\)/);
  assert.match(sessionWorkspace, /key=\{role === 'agent' \? `\$\{role\}-\$\{session\.agent\}` : role\}/);
  assert.match(sessionWorkspace, /<AgentToggle/);
  assert.match(sessionWorkspace, /className="ml-auto flex min-w-0 items-center gap-1\.5"/);
  assert.match(sessionWorkspace, /compact/);
  assert.match(sessionWorkspace, /onAgentChange\(session, agent\)/);
  assert.match(sessionWorkspace, /onReset\(session\)/);
  assert.match(sessionWorkspace, /label="Reset terminal sessions"/);
  assert.match(daemonPane, /onAgentChange=\{changeWorkspaceAgent\}/);
  assert.match(daemonPane, /mutate\(item, 'agent-set', \{ agent \}\)/);
  assert.match(sessionWorkspace, /role=\{role\}/);
  assert.match(sessionWorkspace, /visible=\{visible && !suppressed\}/);
  assert.match(sessionWorkspace, /focused=\{visible && !suppressed && focused\}/);
  assert.match(sessionWorkspace, /onPanelNavigate=\{\(direction\) => navigatePanel\(index, direction\)\}/);
  assert.doesNotMatch(sessionWorkspace, /onNavigateDown=/);
  assert.match(sessionWorkspace, /onToggleSidebar=\{onToggleSidebar\}/);
  assert.match(sessionWorkspace, /roles\[index \+ direction\]/);
  assert.match(sessionWorkspace, /index === 0 && direction === -1/);
  assert.match(sessionWorkspace, /onSidebarFocus\(\)/);
  assert.match(daemonPane, /const focusActiveContent = useCallback/);
  assert.match(daemonPane, /bottomTabsRef\.current\?\.activate\(activeStandaloneId\)/);
  assert.match(daemonPane, /activateStandalone,/);
  assert.match(daemonPane, /createTerminal: openNewBottomTerminal/);
  assert.equal((daemonPane.match(/onSidebarFocus=\{focusSessionsSidebar\}/g) || []).length, 2);
  // App.jsx still owns the single Ctrl+P shortcut and hands every pane the same
  // toggleSidebar/reportTerminalFullscreen callbacks.
  assert.match(app, /event\.key\.toLowerCase\(\) !== 'p'/);
  assert.match(app, /target\?\.closest\('\.xterm'\)/);
  assert.match(app, /onToggleSidebar=\{toggleSidebar\}/);
  assert.match(app, /onFullscreenChange=\{reportTerminalFullscreen\}/);
  assert.match(daemonPane, /onOpenNotes=\{openWorkspaceNotes\}/);
  assert.match(daemonPane, /mutate\(item, 'open-notes'\)/);
  assert.match(sessionWorkspace, /visible \? 'flex' : 'hidden'/);
  assert.match(sessionWorkspace, /useLayoutEffect/);
  assert.doesNotMatch(app, /<h1[^>]*>FritzWorks<\/h1>/);
  assert.match(activeSidebar, /<h1[^>]*>FritzWorks<\/h1>/);
  assert.match(activeSidebar, /aria-label=\{`New repository session on/);
  assert.match(activeSidebar, /<AssetIcon name="git-branch"/);
  assert.match(activeSidebar, /aria-label=\{`New scratchpad session on/);
  assert.match(activeSidebar, /<AssetIcon name="folder"/);
  assert.match(detail, /'agent-set'/);
  assert.match(detail, /'panel-toggle'/);
  assert.match(detail, /'issue-add'/);
  assert.match(detail, /'issue-remove'/);
  assert.match(detail, /canArchiveSession\(item\)/);
  assert.match(detail, /run\('archive'\)/);
  assert.match(detail, /<ArchiveIcon \/>/);
  assert.match(creation, /<RepoCombobox/);
  assert.match(creation, /createRepoSession/);
  assert.match(creation, /createScratchpadSession/);
  assert.match(creation, /panels: \[\.\.\.DEFAULT_WORKSPACE_ROLES\]/);
  assert.doesNotMatch(creation, /PanelToggles/);
  assert.match(creation, /onCreated\(body\.workstream\)/);
  assert.match(links, /provider="linear"/);
  assert.match(links, /provider="github"/);
  assert.match(icons, /return <MaskIcon name=\{name\}/);
  assert.match(icons, /name=\{codex \? 'openai' : 'claude'\}/);
  assert.match(icons, /export function GearIcon/);
  assert.match(icons, /export function ArchiveIcon/);
  assert.match(table, /focus-\$\{panel\}/);
  assert.match(table, /open-notes/);
});

test('v2 markdown editing helpers continue lists, indent, and log the day', async () => {
  const {
    appendUnderHeading, continueList, shiftIndent,
  } = await import('../web-v2/src/markdown.js');

  const task = '- [x] shipped it';
  const continued = continueList(task, task.length);
  assert.equal(continued.value, '- [x] shipped it\n- [ ] ');
  assert.equal(continued.caret, continued.value.length);

  const numbered = continueList('1. first', 8);
  assert.equal(numbered.value, '1. first\n2. ');

  // An empty item ends the list rather than adding another bullet.
  const ended = continueList('- [x] done\n- ', 13);
  assert.equal(ended.value, '- [x] done\n');
  assert.equal(continueList('plain text', 10), null);

  const indented = shiftIndent('- one\n- two', 0, 11);
  assert.equal(indented.value, '  - one\n  - two');
  assert.equal(shiftIndent(indented.value, 0, 15, true).value, '- one\n- two');

  const heading = '## Thursday, June 25th, 2026';
  const logged = appendUnderHeading(`## Monday, June 22nd, 2026\n\n${heading}\n\n- [x] earlier\n\n## Friday, June 26th, 2026\n`, heading);
  assert.match(logged.value, /- \[x\] earlier\n- \[x\] \n\n## Friday/);
  assert.equal(logged.value.slice(0, logged.caret).endsWith('- [x] '), true);
  assert.equal(appendUnderHeading('# no day headings', heading), null);
});

test('v2 standalone sessions host Markdown files backed by notes and general-file endpoints', () => {
  const bottomTabs = read('web-v2/src/BottomTabs.jsx');
  const editor = read('web-v2/src/MarkdownEditor.jsx');
  const picker = read('web-v2/src/NotePicker.jsx');
  const api = read('web-v2/src/api.js');

  assert.match(api, /'\/notes\/files'/);
  assert.match(api, /`\/notes\/file\?path=\$\{encodeURIComponent\(path\)\}`/);
  assert.match(api, /'\/notes\/weekly'/);
  assert.match(api, /`\/markdown\/file\?path=\$\{encodeURIComponent\(path\)\}`/);
  assert.match(api, /`\/notes\/tabs\?scope=\$\{encodeURIComponent\(scope\)\}`/);
  // Open sessions live server-side so the sidebar inventory survives a reload.
  assert.match(bottomTabs, /readEditorTabs\(EDITOR_TAB_SCOPE/);
  assert.match(bottomTabs, /writeEditorTabs\(EDITOR_TAB_SCOPE/);
  assert.match(bottomTabs, /readBrowserState\(TERMINAL_STATE_SCOPE/);
  assert.match(bottomTabs, /writeBrowserState\(TERMINAL_STATE_SCOPE/);
  assert.match(bottomTabs, /terminalId=\{tab\.id\}/);
  assert.match(bottomTabs, /terminalControlsRef\.current\.get\(id\)\?\.terminate\(\)/);
  assert.match(bottomTabs, /kind === 'editor'/);
  assert.match(bottomTabs, /<MarkdownEditor/);
  assert.match(editor, /ReactMarkdown/);
  assert.match(editor, /remarkPlugins=\{\[remarkGfm\]\}/);
  assert.match(editor, /writeNotesFile/);
  assert.match(editor, /writeMarkdownFile/);
  assert.match(editor, /target="_blank"/);
  assert.match(editor, /className="markdown-table-wrap"/);
  assert.match(picker, /openWeeklyNote/);
  assert.match(picker, /readMarkdownFile/);
  assert.match(picker, /source: 'file'/);
  assert.match(picker, /source: 'notes'/);
  // The scaffold action disappears once the week's file exists, because it is then
  // listed like any other work note.
  assert.match(picker, /const missingWeekly = \(data\?\.weekly \|\| \[\]\)\.filter\(\(entry\) => !entry\.exists\);/);
  assert.match(picker, /\{missingWeekly\.length > 0 && \(/);
  assert.doesNotMatch(picker, /create \$\{week\}/);

  // A terminal is spawned only when the standalone session inventory is empty.
  assert.match(bottomTabs, /const id = tabs\.some\(\(tab\) => tab\.id === remembered\) \? remembered : tabs\.at\(-1\)\?\.id;/);
  assert.equal(bottomTabs.match(/createTerminal\(\)/g).length, 1);
  assert.match(bottomTabs, /if \(remembered\) lastUsedRef\.current = remembered\.id/);
  assert.match(bottomTabs, /if \(!\['h', 'j', 'k', 'l'\]\.includes\(key\)\) return;/);
  assert.match(bottomTabs, /event\.defaultPrevented \|\| !event\.ctrlKey/);
  // Neither the textarea nor the preview pane exists until the file has loaded,
  // so focus has to be reapplied — and it must land on whichever of the two is
  // actually rendered, or a note left in Preview mode goes keyboard-unreachable.
  assert.match(editor, /if \(!focused \|\| loading\) return;/);
  assert.match(editor, /\(preview \? previewRef : textareaRef\)\.current\?\.focus\(\);/);
  assert.match(editor, /\}, \[focused, loading, preview\]\);/);

  assert.match(bottomTabs, /items: tabs\.map\(\(tab\) => \(\{/);
  assert.match(bottomTabs, /activeId: active/);
  assert.match(bottomTabs, /if \(direction >= 0\) return false;/);
  assert.match(bottomTabs, /onSidebarFocus\(\)/);
});

test('v2 terminals copy, paste, and open a new standalone terminal from the keyboard', () => {
  const localTerminal = read('web-v2/src/LocalTerminal.jsx');
  const editor = read('web-v2/src/MarkdownEditor.jsx');
  const bottomTabs = read('web-v2/src/BottomTabs.jsx');
  const sessionWorkspace = read('web-v2/src/SessionWorkspace.jsx');
  const daemonPane = read('web-v2/src/DaemonPane.jsx');

  // Ctrl+C/Ctrl+V are the shell's interrupt and quoted-insert, so copy/paste
  // move to Ctrl+Shift+C/Ctrl+Shift+P and are captured before the browser
  // (e.g. a DevTools inspector shortcut) ever sees them.
  assert.match(localTerminal, /const controlShift = event\.ctrlKey && event\.shiftKey && !event\.altKey && !event\.metaKey;/);
  assert.match(localTerminal, /key === 'c' && controlShift/);
  assert.match(localTerminal, /trackOsc52Clipboard\(terminal\)/);
  assert.match(localTerminal, /fallbackText: osc52Clipboard\.text/);
  assert.match(localTerminal, /copyEventHandlesFallback: true/);
  assert.match(localTerminal, /key === 'p' && controlShift/);
  assert.match(localTerminal, /navigator\.clipboard\?\.readText\(\)/);
  assert.match(localTerminal, /terminal\.paste\(text\)/);
  assert.match(localTerminal, /terminalQuery\.set\('client', browserClientId\(\)\)/);
  assert.match(localTerminal, /terminalQuery\.set\('terminal', terminalId\)/);
  assert.match(localTerminal, /message\.type === 'busy'/);
  assert.match(localTerminal, /Active on another client · waiting/);
  assert.match(localTerminal, /JSON\.stringify\(\{ type: 'takeover' \}\)/);
  assert.match(localTerminal, /Take over this terminal/);
  assert.match(localTerminal, /JSON\.stringify\(\{ type: 'terminate' \}\)/);

  // Ctrl+T opens a new standalone terminal from a terminal or a note. LocalTerminal
  // handles it directly (mirroring the other Ctrl-key bindings below it); the
  // markdown editor's own navigation-key map handles it for notes.
  assert.match(localTerminal, /key === 't' && controlOnly && typeof newTerminalRef\.current === 'function'/);
  assert.match(editor, /t: onNewTerminal,/);

  // BottomTabs owns createTerminal, so its own terminal/note sessions wire it in
  // directly; DaemonPane exposes it to the main workspace terminals through the
  // same machine-owned controller.
  assert.match(bottomTabs, /createTerminal,\n\s*focusLastUsed,/);
  assert.match(bottomTabs, /onNewTerminal=\{createTerminal\}/);
  assert.equal((bottomTabs.match(/onNewTerminal=\{createTerminal\}/g) || []).length, 2);
  assert.match(daemonPane, /bottomTabsRef\.current\?\.createTerminal\(\) \|\| false/);
  assert.match(daemonPane, /onNewTerminal=\{openNewBottomTerminal\}/);
  assert.match(sessionWorkspace, /onNewTerminal,\n\}\) \{/);
  assert.match(sessionWorkspace, /onNewTerminal=\{onNewTerminal\}/);
});
