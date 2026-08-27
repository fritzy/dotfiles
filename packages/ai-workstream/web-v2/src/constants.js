export const THEMES = {
  curiosities: {
    label: 'Curiosities',
    href: 'https://lospec.com/palette-list/curiosities',
    credit: 'curiosities on Lospec',
  },
  'clement-8': {
    label: 'Clément 8',
    href: 'https://lospec.com/palette-list/clement-8',
    credit: 'Clément 8 on Lospec',
  },
  'oil-6': {
    label: 'Oil 6',
    href: 'https://lospec.com/palette-list/oil-6',
    credit: 'Oil 6 on Lospec',
  },
  slso8: {
    label: 'SLSO8',
    href: 'https://lospec.com/palette-list/slso8',
    credit: 'SLSO8 on Lospec',
  },
  'endesga-8': {
    label: 'Endesga 8',
    href: 'https://lospec.com/palette-list/endesga-8',
    credit: 'Endesga 8 on Lospec',
  },
  'funkyfuture-8': {
    label: 'FunkyFuture 8',
    href: 'https://lospec.com/palette-list/funkyfuture-8',
    credit: 'FunkyFuture 8 on Lospec',
  },
  dracula: {
    label: 'Dracula',
    href: 'https://github.com/dracula/dracula-theme',
    credit: 'Dracula color scheme',
  },
  nord: {
    label: 'Nord',
    href: 'https://www.nordtheme.com/docs/colors-and-palettes/',
    credit: 'Nord color scheme',
  },
  'tailwind-light': {
    label: 'Tailwind Light',
    href: 'https://tailwindcss.com/docs/colors',
    credit: 'Tailwind CSS colors',
  },
  'tailwind-dark': {
    label: 'Tailwind Dark',
    href: 'https://tailwindcss.com/docs/colors',
    credit: 'Tailwind CSS colors',
  },
};

export const THEME_STORAGE_KEY = 'ai-workstream-theme';
export const TERMINAL_MODE_STORAGE_KEY = 'ai-workstream-terminal-mode';
export const TERMINAL_FONT_STORAGE_KEY = 'ai-workstream-terminal-font';
export const SYNC_WINDOW_FULLSCREEN_STORAGE_KEY = 'ai-workstream-sync-window-fullscreen';
export const SIDEBAR_WIDTH_STORAGE_KEY = 'ai-workstream-sidebar-width';
export const TERMINAL_FONTS = {
  'roboto-mono': { label: 'Roboto Mono', family: '"Roboto Mono", monospace' },
  inconsolata: { label: 'Inconsolata', family: '"Inconsolata", monospace' },
  'jetbrains-mono': { label: 'JetBrains Mono', family: '"JetBrains Mono", monospace' },
  'source-code-pro': { label: 'Source Code Pro', family: '"Source Code Pro", monospace' },
  'ibm-plex-mono': { label: 'IBM Plex Mono', family: '"IBM Plex Mono", monospace' },
};
export const DEFAULT_TERMINAL_FONT = 'roboto-mono';
export const PANEL_ROLES = ['shell', 'editor', 'agent'];
export const DEFAULT_WORKSPACE_ROLES = ['shell', 'agent'];
export const SOCKET_MESSAGE_TYPES = new Set([
  'new_session', 'update_session', 'agent_status', 'shell_status',
]);

export function panelsForMode(mode) {
  return mode === 'two' ? ['shell', 'agent'] : ['shell', 'editor', 'agent'];
}
