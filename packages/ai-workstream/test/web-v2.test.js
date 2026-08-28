import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('v2 is an isolated React and Tailwind client using the existing protocol', () => {
  const main = read('web-v2/src/main.jsx');
  const app = read('web-v2/src/App.jsx');
  const api = read('web-v2/src/api.js');
  const constants = read('web-v2/src/constants.js');
  const styles = read('web-v2/src/styles.css');
  const localTerminal = read('web-v2/src/LocalTerminal.jsx');
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
  assert.match(app, /new WebSocket\(`\$\{protocol\}\/\/\$\{location\.host\}\/ws\/events`\)/);
  assert.match(app, /SOCKET_MESSAGE_TYPES\.has\(message\.type\)/);
  assert.match(api, /`\/ws\/all\/\?\$\{query\}`/);
  assert.match(api, /listActivePausedWorkstreams/);
  assert.match(api, /status: 'active_paused'/);
  assert.match(api, /`\/ws\/\$\{encodeURIComponent\(id\)\}\/\?status=all`/);
  assert.match(api, /`\/ws\/\$\{encodeURIComponent\(id\)\}\/\$\{command\}`/);
  assert.match(api, /'\/ws\/scratchpad'/);
  assert.match(vite, /base: '\/v2\/'/);
  assert.match(vite, /outDir: '\.\.\/web\/v2'/);
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

test('v2 retains the session controls and creation widgets as React components', () => {
  const app = read('web-v2/src/App.jsx');
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

  assert.doesNotMatch(app, /SessionTable/);
  assert.doesNotMatch(app, /listWorkstreams/);
  assert.doesNotMatch(app, /Items per page/);
  assert.doesNotMatch(app, /Pagination/);
  assert.match(app, /<ActiveSessionsSidebar/);
  assert.match(app, /<SessionWorkspace/);
  assert.doesNotMatch(app, /roles=\{panelsForMode\(panelMode\)\}/);
  assert.doesNotMatch(app, /PANEL_MODE_STORAGE_KEY/);
  assert.doesNotMatch(app, /const \[panelMode, setPanelMode\]/);
  assert.match(app, /\{ \.\.\.body, panels: \[\.\.\.DEFAULT_WORKSPACE_ROLES\] \}/);
  assert.match(app, /workspaceSessions\.map\(\(workspaceSession\) =>/);
  assert.match(app, /key=\{workspaceSession\.id\}/);
  assert.match(app, /visible=\{String\(workspaceSession\.id\) === activeWorkspaceId\}/);
  assert.match(app, /onClose=\{\(\) => closeWorkspace\(workspaceSession\.id\)\}/);
  assert.match(app, /command === 'resume' && result\.workstream/);
  assert.match(app, /command === 'pause' \|\| command === 'close'/);
  assert.match(app, /function created\(item\)/);
  assert.match(app, /activateSession\(item\)/);
  assert.match(app, /bottomTabsRef\.current\?\.hide\(\)/);
  assert.match(app, /focusedPanel\?\.startsWith\('workspace-'\)/);
  assert.match(app, /\[focusedPanel\]/);
  assert.match(app, /listActivePausedWorkstreams/);
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
  assert.match(app, /gridTemplateColumns: `\$\{sidebarWidth\}/);
  assert.match(app, /SIDEBAR_WIDTH_STORAGE_KEY/);
  assert.match(app, /localStorage\.setItem\(SIDEBAR_WIDTH_STORAGE_KEY/);
  assert.match(app, /localStorage\.setItem\(TERMINAL_MODE_STORAGE_KEY, terminalMode\)/);
  assert.match(app, /localStorage\.setItem\(SYNC_WINDOW_FULLSCREEN_STORAGE_KEY, String\(syncWindowFullscreen\)\)/);
  assert.match(app, /syncWindowFullscreenRef\.current && !document\.fullscreenElement/);
  assert.match(app, /syncWindowFullscreenRef\.current && document\.fullscreenElement/);
  assert.match(app, /localStorage\.setItem\(TERMINAL_FONT_STORAGE_KEY, terminalFont\)/);
  assert.match(app, /const \[sidebarResizing, setSidebarResizing\]/);
  assert.match(app, /useState\('sidebar-sessions'\)/);
  assert.doesNotMatch(app, /data-panel="main"/);
  assert.doesNotMatch(app, /setFocusedPanel\('main'\)/);
  assert.match(app, /<BottomTabs[\s\S]*leftOffset=\{sidebarWidth\}[\s\S]*layoutResizing=\{sidebarResizing\}/);
  assert.match(app, /ref=\{bottomTabsRef\}/);
  assert.match(app, /REFRESH_DEBOUNCE_MS/);
  assert.doesNotMatch(app, /listRequestRef/);
  assert.match(app, /activeSessionsRequestRef\.current !== requestId/);
  assert.doesNotMatch(app, /controller\.abort\(\)/);
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
  assert.match(activeSidebar, /\['sessions', 'settings'\]\.map/);
  assert.match(activeSidebar, /onClick=\{\(\) => chooseView\(option\)\}/);
  assert.match(activeSidebar, /<AssetIcon name="folder" className="size-5"/);
  assert.match(activeSidebar, /<GearIcon className="size-5"/);
  assert.match(activeSidebar, /Syncing Window Fullscreen/);
  assert.match(activeSidebar, /checked=\{syncWindowFullscreen\}/);
  assert.match(activeSidebar, /onSyncWindowFullscreenChange\(event\.target\.checked\)/);
  assert.doesNotMatch(activeSidebar, /writing-mode:vertical-rl/);
  assert.match(activeSidebar, /focusedPanel !== 'sidebar-sessions'/);
  assert.match(activeSidebar, /\['f', 'h', 'j', 'k', 'l'\]\.includes\(key\)/);
  assert.match(activeSidebar, /event\.ctrlKey/);
  assert.match(activeSidebar, /function controlNavigation\(event\)/);
  assert.match(activeSidebar, /event\.preventDefault\(\)/);
  assert.match(activeSidebar, /event\.stopPropagation\(\)/);
  assert.match(activeSidebar, /key === 'l' && !event\.repeat/);
  assert.match(activeSidebar, /onWorkspaceFocus\(\)/);
  assert.match(activeSidebar, /panelRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(activeSidebar, /\['j', 'k', 'h', 'l', 'Enter'\]/);
  assert.match(activeSidebar, /kind: 'group'/);
  assert.match(activeSidebar, /kind: 'session'/);
  assert.match(activeSidebar, /event\.key === 'h'/);
  assert.match(activeSidebar, /setGroupCollapsed\(current\.groupLabel, true\)/);
  assert.match(activeSidebar, /event\.key === 'l'/);
  assert.match(activeSidebar, /setGroupCollapsed\(current\.groupLabel, false\)/);
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
  assert.match(activeSidebar, /sidebar-settings-view/);
  assert.doesNotMatch(activeSidebar, /PanelModeToggle/);
  assert.doesNotMatch(activeSidebar, /Panel layout/);
  assert.match(activeSidebar, /id="sidebar-theme"/);
  assert.match(activeSidebar, /id="sidebar-terminal-mode"/);
  assert.match(activeSidebar, /id="sidebar-terminal-font"/);
  assert.match(activeSidebar, /Object\.entries\(TERMINAL_FONTS\)/);
  assert.match(activeSidebar, /<option value="dark">Dark<\/option>/);
  assert.match(activeSidebar, /<option value="light">Light<\/option>/);
  assert.doesNotMatch(app, /<PanelModeToggle/);
  assert.doesNotMatch(app, /aria-label="Theme"/);
  assert.match(app, /fixed right-2 bottom-2 z-\[60\]/);
  assert.doesNotMatch(app, /event\.key === 'j'/);
  assert.doesNotMatch(app, /runTableCommand/);
  assert.match(table, /highlightedId/);
  assert.match(table, /scrollIntoView/);
  assert.match(ui, /event\.key !== 'Escape'/);
  assert.match(utils, /!\/\[gjpqy\]\//);
  assert.match(utils, /pt-\[5px\] pb-\[3px\]/);
  assert.match(app, /<SessionDetailModal/);
  assert.match(app, /<NewSessionModal/);
  assert.match(app, /<BottomTabs/);
  assert.match(bottomTabs, /aria-label="Terminals and notes"/);
  assert.match(bottomTabs, /forwardRef\(function BottomTabs/);
  assert.match(bottomTabs, /useImperativeHandle\(ref/);
  assert.match(bottomTabs, /focusLastUsed/);
  assert.match(bottomTabs, /const hideDrawer = useCallback/);
  assert.match(bottomTabs, /const collapseDrawer = useCallback/);
  assert.match(bottomTabs, /if \(!hideDrawer\(\)\) return false/);
  assert.match(bottomTabs, /hide: hideDrawer/);
  assert.match(bottomTabs, /const lastUsedRef = useRef\(null\)/);
  assert.match(bottomTabs, /function navigateTab\(id, direction\)/);
  assert.match(bottomTabs, /onPanelNavigate=\{\(direction\) => navigateTab\(tab\.id, direction\)\}/);
  assert.match(bottomTabs, /onNavigateUp=\{focusWorkspace\}/);
  assert.match(bottomTabs, /onToggleSidebar=\{onToggleSidebar\}/);
  assert.match(bottomTabs, /onExit=\{\(\) => closeTab\(tab\.id\)\}/);
  assert.match(bottomTabs, /function AddButton/);
  assert.match(bottomTabs, /label="New terminal"/);
  assert.match(bottomTabs, /relative z-10 flex h-10[\s\S]*<AddButton label="New terminal" Icon=\{ShellIcon\} onClick=\{createTerminal\} \/>/);
  assert.match(bottomTabs, /<AddButton label="Open a note" Icon=\{EditorIcon\}/);
  // One strip, inside the sliding container: every tab rides up and down with the
  // panel instead of the unselected ones staying pinned to the viewport.
  assert.match(bottomTabs, /const TAB_WIDTH = 'w-40'/);
  assert.equal(bottomTabs.match(/\$\{TAB_WIDTH\}/g).length, 1);
  assert.equal(bottomTabs.match(/<TabButton/g).length, 1);
  assert.doesNotMatch(bottomTabs, /z-50/);
  assert.match(bottomTabs, /selected=\{active === tab\.id\}/);
  assert.match(bottomTabs, /<Icon className="size-4" \/>/);
  assert.match(bottomTabs, /const \[tabs, setTabs\] = useState\(\[\]\)/);
  assert.match(bottomTabs, /const nextTerminalNumber = useRef\(1\)/);
  assert.match(bottomTabs, /id: `terminal-\$\{number\}`/);
  assert.match(bottomTabs, /setTabs\(\(current\) => \[\.\.\.current, terminal\]\)/);
  assert.match(bottomTabs, /return chooseTab\(terminal\.id\)/);
  assert.match(bottomTabs, /const createTerminal = useCallback/);
  assert.match(bottomTabs, /return id \? focusTab\(id\) : createTerminal\(\)/);
  assert.match(bottomTabs, /aria-controls="bottom-terminal-panel"/);
  // The tab strip is inside the sliding container, so it moves with the panel.
  assert.match(bottomTabs, /fixed right-0 bottom-0 z-40 flex flex-col[\s\S]*relative z-10 flex h-10 shrink-0 items-end/);
  assert.match(bottomTabs, /focusedPanel\?\.startsWith\('workspace-'\)/);
  assert.match(bottomTabs, /opacity-20 hover:opacity-100 focus-within:opacity-100/);
  assert.match(bottomTabs, /fixed top-0 right-0 bottom-0 z-30 cursor-default bg-transparent/);
  assert.match(bottomTabs, /active === tab\.id/);
  assert.match(bottomTabs, /transition-\[translate,left\]/);
  assert.match(bottomTabs, /queuedTab\.current = id/);
  assert.match(bottomTabs, /reducedMotion \? 0 : TAB_SWITCH_MS/);
  assert.match(bottomTabs, /const pendingRemoval = useRef\(null\)/);
  assert.match(bottomTabs, /withoutTab\(current, removed\)/);
  assert.match(bottomTabs, /function closeTab\(id\)/);
  assert.match(bottomTabs, /onClose=\{closeTab\}/);
  assert.match(bottomTabs, /aria-label=\{`Close \$\{tab\.label\}`\}/);
  assert.match(bottomTabs, /<XIcon className="size-3\.5" \/>/);
  assert.match(bottomTabs, /current\.filter\(\(tab\) => tab\.id !== id\)/);
  assert.doesNotMatch(bottomTabs, /<header/);
  assert.doesNotMatch(bottomTabs, /<h2/);
  assert.doesNotMatch(bottomTabs, /IconButton/);
  assert.match(bottomTabs, /bg-page\/90 shadow-md backdrop-blur-sm/);
  assert.match(bottomTabs, /opacity-20 transition-opacity hover:opacity-100 focus-within:opacity-100/);
  assert.match(bottomTabs, /rounded-t-2xl border-2 bg-page pb-1/);
  assert.doesNotMatch(bottomTabs, /Lorem ipsum/);
  assert.doesNotMatch(bottomTabs, /test 1/);
  assert.match(bottomTabs, /<LocalTerminal/);
  assert.match(bottomTabs, /tabs\.map\(\(tab\) =>/);
  assert.match(bottomTabs, /visible=\{tabVisible\}/);
  assert.match(bottomTabs, /focused=\{tabVisible && focusedPanel === `bottom-\$\{tab\.id\}`\}/);
  assert.match(bottomTabs, /onPanelFocus\(null\)/);
  assert.match(bottomTabs, /data-panel=\{activePanel \|\| undefined\}/);
  assert.match(bottomTabs, /leftOffset = '0rem'/);
  assert.match(bottomTabs, /transition-\[translate,left\]/);
  assert.match(bottomTabs, /style=\{\{ left: leftOffset \}\}/);
  assert.match(bottomTabs, /onPointerEnter=\{\(\) => \{ if \(activePanel\) onPanelFocus\(activePanel\); \}\}/);
  assert.match(bottomTabs, /fontSize=\{tab\.fontSize\}/);
  assert.match(bottomTabs, /fullscreen: false/);
  assert.match(bottomTabs, /function toggleFullscreen\(id\)/);
  assert.match(bottomTabs, /onFullscreenChange\?\.\('bottom-terminals', !target\.fullscreen\)/);
  assert.match(bottomTabs, /const leaveFullscreen = useCallback/);
  assert.match(bottomTabs, /fullscreenExitRevision/);
  assert.match(bottomTabs, /fullscreen: !tab\.fullscreen/);
  assert.match(bottomTabs, /activeFullscreen \? 'h-screen' : 'h-\[calc\(75vh\+2\.5rem\)\]'/);
  assert.match(bottomTabs, /data-terminal-fullscreen=\{activeFullscreen\}/);
  assert.match(bottomTabs, /onToggleFullscreen=\{\(\) => toggleFullscreen\(tab\.id\)\}/);
  assert.match(bottomTabs, /const fullscreenVisible = drawerOpen && activeFullscreen/);
  assert.match(bottomTabs, /onFullscreenChange\?\.\('bottom-terminals', fullscreenVisible\)/);
  assert.match(bottomTabs, /onFullscreenChange\?\.\('bottom-terminals', false\)/);
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
  assert.match(sessionWorkspace, /const \[panelMode, setPanelMode\] = useState\('two'\)/);
  assert.match(sessionWorkspace, /const roles = useMemo\(\(\) => panelsForMode\(panelMode\), \[panelMode\]\)/);
  assert.match(sessionWorkspace, /<PanelModeToggle value=\{panelMode\} onChange=\{changePanelMode\} \/>/);
  assert.match(sessionWorkspace, /setPanelMode\(nextMode\)/);
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
  assert.match(sessionWorkspace, /session\.issues\?\.map\(\(issue\) => <LinkPill key=\{issue\.ref\} entry=\{issue\} \/>\)/);
  assert.match(sessionWorkspace, /key=\{role === 'agent' \? `\$\{role\}-\$\{session\.agent\}` : role\}/);
  assert.match(sessionWorkspace, /<AgentToggle/);
  assert.match(sessionWorkspace, /className="ml-auto flex min-w-0 items-center gap-1\.5"/);
  assert.match(sessionWorkspace, /compact/);
  assert.match(sessionWorkspace, /onAgentChange\(session, agent\)/);
  assert.match(app, /onAgentChange=\{changeWorkspaceAgent\}/);
  assert.match(app, /mutate\(item, 'agent-set', \{ agent \}\)/);
  assert.match(sessionWorkspace, /role=\{role\}/);
  assert.match(sessionWorkspace, /visible=\{visible && !suppressed\}/);
  assert.match(sessionWorkspace, /focused=\{visible && !suppressed && focused\}/);
  assert.match(sessionWorkspace, /onPanelNavigate=\{\(direction\) => navigatePanel\(index, direction\)\}/);
  assert.match(sessionWorkspace, /onNavigateDown=\{focusBottomTerminal\}/);
  assert.match(sessionWorkspace, /onToggleSidebar=\{onToggleSidebar\}/);
  assert.match(sessionWorkspace, /roles\[index \+ direction\]/);
  assert.match(sessionWorkspace, /index === 0 && direction === -1/);
  assert.match(sessionWorkspace, /onSidebarFocus\(\)/);
  assert.match(app, /onWorkspaceFocus=\{focusActiveWorkspace\}/);
  assert.match(app, /bottomTabsRef\.current\?\.focusLastUsed\(\)/);
  assert.match(app, /onBottomTerminalFocus=\{focusLastBottomTerminal\}/);
  assert.match(app, /onSidebarFocus=\{focusVisibleSidebar\}/);
  assert.match(app, /onToggleSidebar=\{toggleSidebar\}/);
  assert.match(app, /event\.key\.toLowerCase\(\) !== 'p'/);
  assert.match(app, /target\?\.closest\('\.xterm'\)/);
  assert.match(app, /onSidebarFocus=\{focusSessionsSidebar\}/);
  assert.match(app, /onFullscreenChange=\{reportTerminalFullscreen\}/);
  assert.match(app, /onOpenNotes=\{openWorkspaceNotes\}/);
  assert.match(app, /mutate\(item, 'open-notes'\)/);
  assert.match(sessionWorkspace, /visible \? 'flex' : 'hidden'/);
  assert.match(sessionWorkspace, /useLayoutEffect/);
  assert.doesNotMatch(app, /<h1[^>]*>FritzWorks<\/h1>/);
  assert.match(activeSidebar, /<h1[^>]*>FritzWorks<\/h1>/);
  assert.match(activeSidebar, /aria-label="New repository session"/);
  assert.match(activeSidebar, /<AssetIcon name="git-branch"/);
  assert.match(activeSidebar, /aria-label="New scratchpad session"/);
  assert.match(activeSidebar, /<AssetIcon name="folder"/);
  assert.match(detail, /'agent-set'/);
  assert.match(detail, /'panel-toggle'/);
  assert.match(detail, /'issue-add'/);
  assert.match(detail, /'issue-remove'/);
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
  assert.match(table, /focus-\$\{panel\}/);
  assert.match(table, /open-notes/);
});

test('v2 markdown preview parses the shapes the notes skill actually writes', async () => {
  const { parseMarkdown, parseInline } = await import('../web-v2/src/markdown.js');
  const blocks = parseMarkdown([
    '## Thursday, June 25th, 2026',
    '',
    '- [x] Shipped the **editor**',
    '    - https://github.com/example/project/pull/41',
    '    - [ ] follow-up still to do',
    '- [x] Another item',
    '',
    '> a quoted aside',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    'Trailing `code` paragraph.',
  ].join('\n'));

  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'list', 'quote', 'code', 'paragraph']);
  assert.equal(blocks[0].level, 2);
  assert.equal(blocks[1].items.length, 2);
  assert.equal(blocks[1].items[0].checked, true);
  assert.deepEqual(blocks[1].items[0].spans.map((span) => span.type), ['text', 'strong']);
  assert.equal(blocks[1].items[0].children.length, 2);
  assert.equal(blocks[1].items[0].children[0].spans[0].href, 'https://github.com/example/project/pull/41');
  assert.equal(blocks[1].items[0].children[1].checked, false);
  assert.equal(blocks[3].lang, 'js');
  assert.equal(blocks[3].code, 'const answer = 42;');

  const link = parseInline('see [the plan](https://linear.app/eco-1) now');
  assert.deepEqual(link.map((span) => span.type), ['text', 'link', 'text']);
  assert.equal(link[1].href, 'https://linear.app/eco-1');
  assert.equal(link[1].text, 'the plan');

  // An image match starts one character before a link would, so `![...]` must not
  // fall through to the link branch and leave a stray "!" behind.
  const image = parseInline('before ![desc](https://example.com/a/fritzworks.png) after');
  assert.deepEqual(image.map((span) => span.type), ['text', 'image', 'text']);
  assert.equal(image[1].href, 'https://example.com/a/fritzworks.png');
  assert.equal(image[1].text, 'desc');
  assert.equal(image[0].text, 'before ');
  assert.deepEqual(parseInline('![](https://example.com/b.png)').map((span) => span.type), ['image']);
  // A bare image line is still a paragraph holding a single image span.
  const [block] = parseMarkdown('![shot](https://example.com/c.png)');
  assert.equal(block.type, 'paragraph');
  assert.equal(block.spans[0].type, 'image');
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

test('v2 bottom drawer hosts markdown tabs backed by the notes endpoints', () => {
  const bottomTabs = read('web-v2/src/BottomTabs.jsx');
  const editor = read('web-v2/src/MarkdownEditor.jsx');
  const picker = read('web-v2/src/NotePicker.jsx');
  const api = read('web-v2/src/api.js');

  assert.match(api, /'\/notes\/files'/);
  assert.match(api, /`\/notes\/file\?path=\$\{encodeURIComponent\(path\)\}`/);
  assert.match(api, /'\/notes\/weekly'/);
  assert.match(api, /`\/notes\/tabs\?scope=\$\{encodeURIComponent\(scope\)\}`/);
  // Open tabs live server-side so the strip survives a reload.
  assert.match(bottomTabs, /readEditorTabs\(EDITOR_TAB_SCOPE/);
  assert.match(bottomTabs, /writeEditorTabs\(EDITOR_TAB_SCOPE/);
  assert.match(bottomTabs, /kind === 'editor'/);
  assert.match(bottomTabs, /<MarkdownEditor/);
  assert.match(editor, /parseMarkdown/);
  assert.match(editor, /writeNotesFile/);
  assert.match(editor, /span\.type === 'image'/);
  assert.match(editor, /<img[\s\S]*src=\{span\.href\}[\s\S]*alt=\{span\.text\}/);
  assert.match(picker, /openWeeklyNote/);
  // The scaffold action disappears once the week's file exists, because it is then
  // listed like any other work note.
  assert.match(picker, /const missingWeekly = \(data\?\.weekly \|\| \[\]\)\.filter\(\(entry\) => !entry\.exists\);/);
  assert.match(picker, /\{missingWeekly\.length > 0 && \(/);
  assert.doesNotMatch(picker, /create \$\{week\}/);

  // Ctrl-H/L must only ever move between existing tabs. A terminal is spawned only
  // when the drawer is empty, so navigating into a strip of restored notes cannot
  // keep creating terminals.
  assert.match(bottomTabs, /const id = tabs\.some\(\(tab\) => tab\.id === remembered\) \? remembered : tabs\.at\(-1\)\?\.id;/);
  assert.equal(bottomTabs.match(/createTerminal\(\)/g).length, 1);
  assert.match(bottomTabs, /if \(remembered\) lastUsedRef\.current = editorTabId\(remembered\)/);
  assert.match(bottomTabs, /if \(key !== 'h' && key !== 'l' && key !== 'k'\) return;/);
  assert.match(bottomTabs, /event\.defaultPrevented \|\| !event\.ctrlKey/);
  // The textarea only exists once the file has loaded, so focus has to be reapplied.
  assert.match(editor, /if \(!focused \|\| preview \|\| loading\) return;/);
  assert.match(editor, /\}, \[focused, loading, preview\]\);/);

  // The drawer slides away as soon as it stops being the focused panel, whatever
  // moved focus, and a tab switch mid-animation is not mistaken for focus loss.
  assert.match(bottomTabs, /if \(!drawerOpen \|\| closing \|\| !activeTab\) return;/);
  assert.match(bottomTabs, /if \(focusedPanel !== `bottom-\$\{activeTab\.id\}`\) hideDrawer\(\);/);
  assert.match(bottomTabs, /\[activeTab, closing, drawerOpen, focusedPanel, hideDrawer\]/);
});
