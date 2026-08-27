const table = document.querySelector('#workstreams');
const empty = document.querySelector('#empty');
const error = document.querySelector('#error');
const connection = document.querySelector('#connection');
const themeSelect = document.querySelector('#theme-select');
const themeCredit = document.querySelector('#theme-credit');
const panelModeToggle = document.querySelector('#panel-mode-toggle');
const filters = document.querySelector('#filters');
const pagination = document.querySelector('#pagination');
const pageNumbers = document.querySelector('#page-numbers');
const pagePrevious = document.querySelector('#page-previous');
const pageNext = document.querySelector('#page-next');
const perpageSelect = document.querySelector('#perpage');
const modal = document.querySelector('#session-modal');
const modalError = document.querySelector('#modal-error');
const modalActions = [...document.querySelectorAll('.modal-action')];
const panelButtons = [...document.querySelectorAll('.panel-toggle')];
const panelNote = document.querySelector('#modal-panel-note');
const agentSelect = document.querySelector('#modal-agent-select');
const scratchpadNameRow = document.querySelector('#modal-scratchpad-name-row');
const scratchpadNameInput = document.querySelector('#modal-scratchpad-name');
const modalLinkControls = document.querySelector('#modal-link-controls');
const modalLink = document.querySelector('#modal-link');
const modalLinearLink = document.querySelector('#modal-linear-link');
const modalGithubLink = document.querySelector('#modal-github-link');
const modalLinkValues = document.querySelector('#modal-link-values');
const linkNote = document.querySelector('#modal-links-note');
const newRepoButton = document.querySelector('#new-repo-button');
const newRepoModal = document.querySelector('#new-repo-modal');
const newRepoForm = document.querySelector('#new-repo-form');
const newRepoDismiss = document.querySelector('#new-repo-dismiss');
const newRepoCancel = document.querySelector('#new-repo-cancel');
const newRepoSubmit = document.querySelector('#new-repo-submit');
const newRepoCombobox = document.querySelector('#new-repo-combobox');
const newRepoRepository = document.querySelector('#new-repo-repository');
const newRepoRepositoryToggle = document.querySelector('#new-repo-repository-toggle');
const newRepoRepositories = document.querySelector('#new-repo-repositories');
const newRepoSelector = document.querySelector('#new-repo-selector');
const newRepoSource = document.querySelector('#new-repo-source');
const newRepoAgent = document.querySelector('#new-repo-agent');
const newRepoPath = document.querySelector('#new-repo-path');
const newRepoLinks = document.querySelector('#new-repo-links');
const newRepoLinearLink = document.querySelector('#new-repo-linear-link');
const newRepoGithubLink = document.querySelector('#new-repo-github-link');
const newRepoError = document.querySelector('#new-repo-error');
const newRepoSubmitting = document.querySelector('#new-repo-submitting');
const newPanelButtons = [...document.querySelectorAll('.new-panel-toggle')];
const newScratchpadButton = document.querySelector('#new-scratchpad-button');
const newScratchpadModal = document.querySelector('#new-scratchpad-modal');
const newScratchpadForm = document.querySelector('#new-scratchpad-form');
const newScratchpadDismiss = document.querySelector('#new-scratchpad-dismiss');
const newScratchpadCancel = document.querySelector('#new-scratchpad-cancel');
const newScratchpadSubmit = document.querySelector('#new-scratchpad-submit');
const newScratchpadName = document.querySelector('#new-scratchpad-name');
const newScratchpadAgent = document.querySelector('#new-scratchpad-agent');
const newScratchpadPath = document.querySelector('#new-scratchpad-path');
const newScratchpadLinks = document.querySelector('#new-scratchpad-links');
const newScratchpadLinearLink = document.querySelector('#new-scratchpad-linear-link');
const newScratchpadGithubLink = document.querySelector('#new-scratchpad-github-link');
const newScratchpadError = document.querySelector('#new-scratchpad-error');
const newScratchpadSubmitting = document.querySelector('#new-scratchpad-submitting');
const newScratchpadPanelButtons = [...document.querySelectorAll('.new-scratchpad-panel-toggle')];
const linkAutocompleteInputs = [...document.querySelectorAll('.link-autocomplete-input')];
const linkAddButtons = [...document.querySelectorAll('.link-add-button')];
const newRepoLinkInputs = [newRepoLinks, newRepoLinearLink, newRepoGithubLink];
const newScratchpadLinkInputs = [newScratchpadLinks, newScratchpadLinearLink, newScratchpadGithubLink];
const creationLinkInputs = [...newRepoLinkInputs, ...newScratchpadLinkInputs];
const modalLinkInputs = [modalLink, modalLinearLink, modalGithubLink];
let selectedSession = null;
let currentPage = 0;
let savingDetailLinks = false;
let renamingScratchpad = false;
let closingModalFromHistory = false;
let newRepoDefaults = null;
let newRepoPanels = new Set();
let recentRepositoryValues = [];
let newScratchpadDefaults = null;
let newScratchpadPanels = new Set();
let panelMode = 'three';
const newRepoAddedLinks = [];
const newScratchpadAddedLinks = [];
const linkSuggestionCache = new Map();
const linkSuggestionTimers = new WeakMap();

const TYPE_FILTERS = new Set(['', 'repo', 'scratchpad', 'misc']);
const STATUS_FILTERS = new Set(['active_paused', 'active', 'paused', 'closed', 'all']);
const OPTICAL_CONTROL_SELECTOR = [
  'button:not(.modal-dismiss):not(.path-action)',
  '.status-pill',
  '.issue-pill',
].join(', ');

function updateOpticalAlignment() {
  for (const control of document.querySelectorAll(OPTICAL_CONTROL_SELECTOR)) {
    const label = control.textContent.trim();
    control.classList.toggle('optical-no-descender', Boolean(label) && !/[gjpqy]/.test(label));
  }
}

const opticalAlignmentObserver = new MutationObserver(updateOpticalAlignment);
opticalAlignmentObserver.observe(document.body, { childList: true, characterData: true, subtree: true });
updateOpticalAlignment();

const THEME_KEY = 'ai-workstream-theme';
const THEMES = {
  curiosities: {
    href: 'https://lospec.com/palette-list/curiosities',
    credit: 'curiosities on Lospec',
  },
  'clement-8': {
    href: 'https://lospec.com/palette-list/clement-8',
    credit: 'Clément 8 on Lospec',
  },
  'oil-6': {
    href: 'https://lospec.com/palette-list/oil-6',
    credit: 'Oil 6 on Lospec',
  },
  slso8: {
    href: 'https://lospec.com/palette-list/slso8',
    credit: 'SLSO8 on Lospec',
  },
  'endesga-8': {
    href: 'https://lospec.com/palette-list/endesga-8',
    credit: 'Endesga 8 on Lospec',
  },
  'funkyfuture-8': {
    href: 'https://lospec.com/palette-list/funkyfuture-8',
    credit: 'FunkyFuture 8 on Lospec',
  },
  dracula: {
    href: 'https://github.com/dracula/dracula-theme',
    credit: 'Dracula color scheme',
  },
  nord: {
    href: 'https://www.nordtheme.com/docs/colors-and-palettes/',
    credit: 'Nord color scheme',
  },
};

function colorChannels(value) {
  const color = value.trim();
  const hex = color.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3 ? [...hex].map((digit) => digit.repeat(2)).join('') : hex;
    return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16));
  }
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  return rgb ? rgb.slice(1).map(Number) : null;
}

function relativeLuminance(channels) {
  const [red, green, blue] = channels.map((channel) => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return .2126 * red + .7152 * green + .0722 * blue;
}

function contrastRatio(left, right) {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + .05) / (darker + .05);
}

function updateThemeContrast() {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const paletteCandidates = ['ink', 'cream'].map((name) => ({
    value: styles.getPropertyValue(`--${name}`).trim(),
    channels: colorChannels(styles.getPropertyValue(`--${name}`)),
  }));
  const fallbackCandidates = ['#000000', '#ffffff'].map((value) => ({
    value,
    channels: colorChannels(value),
  }));
  if (paletteCandidates.some(({ channels }) => !channels)) return;
  for (const backgroundName of ['teal', 'cyan', 'peach', 'coral']) {
    const background = colorChannels(styles.getPropertyValue(`--${backgroundName}`));
    if (!background) continue;
    let foreground = paletteCandidates.reduce((best, candidate) => (
      contrastRatio(background, candidate.channels) > contrastRatio(background, best.channels)
        ? candidate
        : best
    ));
    if (contrastRatio(background, foreground.channels) < 4.5) {
      foreground = fallbackCandidates.reduce((best, candidate) => (
        contrastRatio(background, candidate.channels) > contrastRatio(background, best.channels)
          ? candidate
          : best
      ));
    }
    root.style.setProperty(`--on-${backgroundName}`, foreground.value);
  }
}

function applyTheme(theme) {
  const migrated = theme === 'default' ? 'curiosities' : theme;
  const selected = THEMES[migrated] ? migrated : 'curiosities';
  document.documentElement.dataset.theme = selected;
  updateThemeContrast();
  themeSelect.value = selected;
  themeCredit.href = THEMES[selected].href;
  themeCredit.textContent = THEMES[selected].credit;
}

try { applyTheme(localStorage.getItem(THEME_KEY) || 'curiosities'); }
catch { applyTheme('curiosities'); }

themeSelect.addEventListener('change', () => {
  applyTheme(themeSelect.value);
  try { localStorage.setItem(THEME_KEY, themeSelect.value); }
  catch { /* theme still applies when storage is unavailable */ }
});

const PANEL_MODE_KEY = 'ai-workstream-panel-mode';

function selectedLayoutPanels() {
  return panelMode === 'two' ? ['shell', 'agent'] : ['shell', 'editor', 'agent'];
}

function applyPanelMode(mode, { persist = false, syncCreationForms = false } = {}) {
  panelMode = mode === 'two' ? 'two' : 'three';
  const twoPanels = panelMode === 'two';
  panelModeToggle.dataset.mode = panelMode;
  panelModeToggle.setAttribute('aria-pressed', String(twoPanels));
  panelModeToggle.setAttribute('aria-label', twoPanels
    ? 'Switch to three-panel layout'
    : 'Switch to two-panel layout');
  panelModeToggle.title = twoPanels
    ? 'Two panels: shell and agent'
    : 'Three panels: shell, editor, and agent';
  if (syncCreationForms) {
    if (newRepoModal.open) {
      newRepoPanels = new Set(selectedLayoutPanels());
      renderNewRepoPanels();
    }
    if (newScratchpadModal.open) {
      newScratchpadPanels = new Set(selectedLayoutPanels());
      renderNewScratchpadPanels();
    }
  }
  if (persist) {
    try { localStorage.setItem(PANEL_MODE_KEY, panelMode); }
    catch { /* panel mode still applies when storage is unavailable */ }
  }
}

function commandRequestBody(command) {
  return command === 'resume' ? { panels: selectedLayoutPanels() } : {};
}

try { applyPanelMode(localStorage.getItem(PANEL_MODE_KEY) || 'three'); }
catch { applyPanelMode('three'); }

panelModeToggle.addEventListener('click', () => {
  applyPanelMode(panelMode === 'three' ? 'two' : 'three', {
    persist: true,
    syncCreationForms: true,
  });
});

function agentToggleValue(toggle) {
  return toggle.dataset.agent === 'codex' ? 'codex' : 'claude';
}

function updateAgentToggle(toggle, agent, busy = false) {
  const selected = agent === 'codex' ? 'codex' : 'claude';
  const next = selected === 'codex' ? 'Claude' : 'Codex';
  toggle.dataset.agent = selected;
  toggle.disabled = busy;
  toggle.setAttribute('aria-pressed', String(selected === 'codex'));
  toggle.setAttribute('aria-label', `Switch to ${next} agent`);
  toggle.title = `${selected === 'codex' ? 'Codex' : 'Claude'} selected`;
}

function toggleAgent(toggle) {
  updateAgentToggle(toggle, agentToggleValue(toggle) === 'claude' ? 'codex' : 'claude');
}

function updatePanelIconButton(button, enabled) {
  const panel = button.dataset.panel;
  const label = `${panel[0].toUpperCase()}${panel.slice(1)}`;
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-label', `${enabled ? 'Disable' : 'Enable'} ${panel} panel`);
  button.title = `${label} panel: ${enabled ? 'on' : 'off'}`;
}

const detail = Object.fromEntries([
  'title', 'status', 'repo', 'branch', 'branch-icon', 'path',
  'path-presence', 'created', 'last-joined', 'stack',
].map((name) => [name, document.querySelector(`#modal-${name}`)]));

function cell(row, value, code = false) {
  const td = document.createElement('td');
  const node = code ? document.createElement('code') : document.createTextNode(String(value ?? ''));
  if (code) node.textContent = String(value ?? '');
  td.append(node);
  row.append(td);
}

function gitState(item) {
  if (item.gitClean === true) return { className: 'branch-icon-clean', label: 'Git worktree is clean' };
  if (item.gitClean === false) return { className: 'branch-icon-dirty', label: 'Git worktree has changes' };
  return { className: 'branch-icon-unknown', label: 'Git status unavailable' };
}

function branchIconState(item) {
  if (item.type === 'scratchpad') {
    return { className: 'branch-icon-folder', label: 'Scratchpad directory' };
  }
  if (item.prDone === true) {
    return { className: 'branch-icon-pr-done', label: 'Pull request is closed or merged' };
  }
  return gitState(item);
}

function githubBranchUrl(item) {
  if (item.type === 'scratchpad' || !item.repoUrl || !item.branch) return null;
  try {
    const url = new URL(item.repoUrl);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null;
    const repositoryPath = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
    if (repositoryPath.split('/').filter(Boolean).length !== 2) return null;
    const branchPath = String(item.branch).split('/').map(encodeURIComponent).join('/');
    url.pathname = `${repositoryPath}/tree/${branchPath}`;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function repoCell(row, item) {
  const td = document.createElement('td');
  td.className = 'repo-column';
  td.textContent = item.type === 'scratchpad' ? '' : item.repo;
  row.append(td);
}

function branchCell(row, item) {
  const td = document.createElement('td');
  td.className = 'branch-column';
  const value = document.createElement('div');
  value.className = 'branch-value';
  const icon = document.createElement('span');
  const state = branchIconState(item);
  icon.className = `branch-icon ${state.className}`;
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', state.label);
  icon.title = state.label;
  const branchUrl = githubBranchUrl(item);
  const branch = document.createElement(branchUrl ? 'a' : 'span');
  branch.textContent = item.type === 'scratchpad' ? item.name : item.branch;
  if (branchUrl) {
    branch.href = branchUrl;
    branch.target = '_blank';
    branch.rel = 'noreferrer';
    branch.title = `View ${item.branch} on GitHub`;
    branch.addEventListener('click', (event) => event.stopPropagation());
  }
  value.append(icon, branch);
  td.append(value);
  row.append(td);
}

function calendarIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('calendar-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  body.setAttribute('d', 'M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2ZM3 9h18M8 2v4M16 2v4');
  svg.append(body);
  return svg;
}

function lastUsedCell(row, value) {
  const td = document.createElement('td');
  td.className = 'last-used-column';
  if (!value) {
    td.textContent = '—';
  } else {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) {
      td.textContent = '—';
    } else {
      const days = Math.floor(Math.max(0, Date.now() - date.valueOf()) / 86_400_000);
      const exact = date.toLocaleString();
      const display = document.createElement('span');
      display.className = 'last-used-value';
      const count = document.createElement('span');
      count.textContent = `${days}d`;
      display.append(calendarIcon(), count);
      td.title = `Last used ${exact}`;
      td.setAttribute('aria-label', `Last used ${days} ${days === 1 ? 'day' : 'days'} ago, ${exact}`);
      td.append(display);
    }
  }
  row.append(td);
}

function closeActionIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('close-action-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M5 5l14 14M19 5L5 19');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-width', '2.5');
  svg.append(path);
  return svg;
}

function refreshActionIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('refresh-action-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arc.setAttribute('d', 'M18.2 17.3A8.5 8.5 0 1 1 18.4 6.4');
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke', 'currentColor');
  arc.setAttribute('stroke-linecap', 'round');
  arc.setAttribute('stroke-width', '3.25');
  const head = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  head.setAttribute('points', '23,11.5 12.5,8.7 19.7,1.5');
  head.setAttribute('fill', 'currentColor');
  head.setAttribute('stroke', 'currentColor');
  head.setAttribute('stroke-linejoin', 'round');
  head.setAttribute('stroke-width', '.8');
  svg.append(arc, head);
  return svg;
}

function issueLink(ref) {
  const href = linkFor(ref);
  if (!href) return null;
  const url = new URL(href);
  const github = url.hostname.toLowerCase() === 'github.com'
    ? url.pathname.match(/^\/[^/]+\/[^/]+\/(?:issues|pull)\/(\d+)(?:\/|$)/)
    : null;
  if (github) return {
    href, label: `#${github[1]}`, icon: 'github', provider: 'GitHub',
  };
  const linear = url.hostname.toLowerCase() === 'linear.app'
    ? url.pathname.match(/\/issue\/([a-z][a-z0-9]*-\d+)(?:\/|$)/i)
    : null;
  if (linear) return {
    href, label: linear[1].toUpperCase(), icon: 'linear', provider: 'Linear',
  };
  return {
    href,
    label: url.hostname,
    favicon: `${url.origin}/favicon.ico`,
    provider: 'custom',
  };
}

function issuePillIcon(issue) {
  if (issue.icon) {
    const icon = document.createElement('span');
    icon.className = `issue-pill-icon issue-pill-icon-${issue.icon}`;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  }
  const slot = document.createElement('span');
  slot.className = 'issue-pill-favicon-slot';
  slot.setAttribute('aria-hidden', 'true');
  const fallback = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  fallback.classList.add('issue-pill-link-icon');
  fallback.setAttribute('viewBox', '0 0 24 24');
  fallback.setAttribute('fill', 'none');
  fallback.setAttribute('stroke', 'currentColor');
  fallback.setAttribute('stroke-linecap', 'round');
  fallback.setAttribute('stroke-linejoin', 'round');
  fallback.setAttribute('stroke-width', '2.5');
  const chain = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  chain.setAttribute('d', 'M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1');
  fallback.append(chain);
  const favicon = document.createElement('img');
  favicon.className = 'issue-pill-favicon';
  favicon.alt = '';
  favicon.referrerPolicy = 'no-referrer';
  favicon.addEventListener('load', () => slot.classList.add('favicon-loaded'));
  favicon.addEventListener('error', () => favicon.remove());
  favicon.src = issue.favicon;
  slot.append(fallback, favicon);
  return slot;
}

function linksCell(row, issues) {
  const td = document.createElement('td');
  td.className = 'links-column';
  const links = (issues || []).map((issue) => issueLink(issue.ref)).filter(Boolean);
  if (!links.length) {
    td.textContent = '—';
  } else {
    const pills = document.createElement('div');
    pills.className = 'issue-pills';
    for (const issue of links) {
      const link = document.createElement('a');
      link.className = 'issue-pill';
      link.href = issue.href;
      link.target = '_blank';
      link.rel = 'noreferrer';
      const label = document.createElement('span');
      label.textContent = issue.label;
      link.append(issuePillIcon(issue), label);
      link.setAttribute('aria-label', issue.provider === 'custom'
        ? `Open linked site ${issue.label} in a new tab`
        : `Open linked ${issue.provider} issue ${issue.label} in a new tab`);
      link.title = issue.provider === 'custom' ? issue.href : `Open ${issue.label}`;
      link.addEventListener('click', (event) => event.stopPropagation());
      pills.append(link);
    }
    td.append(pills);
  }
  row.append(td);
}

function statusCell(row, item) {
  const td = document.createElement('td');
  const actionable = item.status === 'active' || item.status === 'paused';
  const pill = document.createElement(actionable ? 'button' : 'span');
  pill.className = `status-pill status-${String(item.status).replace(/[^a-z_-]/g, '')}`;
  pill.textContent = item.status;
  if (actionable) {
    pill.type = 'button';
    pill.classList.add('status-action');
    const action = item.status === 'active' ? 'Pause' : 'Open';
    pill.setAttribute('aria-label', `${action} ${item.name || item.branch || item.id}`);
    pill.title = `${action} this workstream`;
    pill.addEventListener('click', (event) => {
      event.stopPropagation();
      runStatusAction(item, pill);
    });
  }
  td.append(pill);
  row.append(td);
}

function shellPromptIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('shell-prompt-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('stroke-width', '2.5');
  const prompt = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  prompt.setAttribute('d', 'M4 6l6 6-6 6M13 18h7');
  svg.append(prompt);
  return svg;
}

function shellAction(item) {
  const working = item.shellStatus === 'working';
  const indicator = document.createElement('button');
  indicator.type = 'button';
  indicator.className = 'panel-action shell-action';
  indicator.disabled = item.status !== 'active';
  const state = working ? 'working' : item.shellStatus === 'ready' ? 'waiting at a prompt' : 'available';
  indicator.setAttribute('aria-label', item.status === 'active'
    ? `Focus shell (${state})`
    : 'Shell unavailable while session is not active');
  indicator.title = item.status === 'active'
    ? working
      ? 'Shell command running — focus its terminal pane'
      : 'Focus shell terminal pane'
    : 'Shell unavailable while session is not active';
  indicator.addEventListener('click', (event) => {
    event.stopPropagation();
    focusShell(item, indicator);
  });
  const iconSlot = document.createElement('span');
  iconSlot.className = 'agent-icon-slot';
  iconSlot.setAttribute('aria-hidden', 'true');
  if (working) {
    const spinner = document.createElement('span');
    spinner.className = 'agent-spinner';
    iconSlot.append(spinner);
  } else {
    iconSlot.append(shellPromptIcon());
  }
  indicator.append(iconSlot);
  return indicator;
}

function agentAction(item) {
  const provider = item.agent === 'codex' ? 'codex' : 'claude';
  const working = item.agentStatus === 'working';
  const ready = item.agentStatus === 'ready';
  const indicator = document.createElement('button');
  indicator.type = 'button';
  indicator.className = 'panel-action agent-action';
  indicator.disabled = item.status !== 'active';
  const activity = working ? 'working ' : ready ? 'waiting ' : '';
  indicator.setAttribute('aria-label', item.status === 'active'
    ? `Focus ${activity}${provider} agent`
    : `${provider === 'codex' ? 'Codex' : 'Claude'} agent unavailable while session is not active`);
  indicator.title = item.status === 'active'
    ? working
      ? `${provider === 'codex' ? 'Codex' : 'Claude'} working — focus its terminal pane`
      : ready
        ? `${provider === 'codex' ? 'Codex' : 'Claude'} waiting for input — focus its terminal pane`
        : `Focus ${provider === 'codex' ? 'Codex' : 'Claude'} terminal pane`
    : 'Agent unavailable while session is not active';
  indicator.addEventListener('click', (event) => {
    event.stopPropagation();
    focusAgent(item, indicator);
  });
  const iconSlot = document.createElement('span');
  iconSlot.className = 'agent-icon-slot';
  iconSlot.setAttribute('aria-hidden', 'true');
  if (working) {
    const spinner = document.createElement('span');
    spinner.className = 'agent-spinner';
    iconSlot.append(spinner);
  } else {
    const icon = document.createElement('img');
    icon.className = `agent-icon agent-icon-${provider}`;
    icon.src = provider === 'codex' ? '/icons/openai.svg' : '/icons/claude.svg';
    icon.alt = '';
    iconSlot.append(icon);
  }
  indicator.append(iconSlot);
  return indicator;
}

async function focusAgent(item, button) {
  return focusPanel(item, button, 'agent');
}

async function focusShell(item, button) {
  return focusPanel(item, button, 'shell');
}

async function focusPanel(item, button, panel) {
  button.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch(`/ws/${encodeURIComponent(item.id)}/focus-${panel}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    if (body.result?.terminalFocus?.focused === false) {
      error.textContent = `Zellij focused. ${body.result.terminalFocus.reason}.`;
      error.hidden = false;
    }
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function runStatusAction(item, button) {
  const command = item.status === 'active' ? 'pause' : 'resume';
  button.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch(`/ws/${encodeURIComponent(item.id)}/${command}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commandRequestBody(command)),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    await refresh();
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
    button.disabled = false;
  }
}

function actionCell(row, item) {
  const td = document.createElement('td');
  td.className = 'action-column';
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const name = item.name || item.branch || item.id;

  actions.append(shellAction(item));
  actions.append(agentAction(item));

  const folder = document.createElement('button');
  folder.type = 'button';
  folder.className = 'folder-action';
  folder.disabled = !item.worktreePresent;
  folder.setAttribute('aria-label', item.worktreePresent
    ? `Open directory for ${name}`
    : `Directory unavailable for ${name}`);
  folder.title = item.worktreePresent ? 'Open directory' : 'Directory does not exist';
  const folderIcon = document.createElement('img');
  folderIcon.src = '/icons/folder.svg';
  folderIcon.alt = '';
  folderIcon.setAttribute('aria-hidden', 'true');
  folder.append(folderIcon);
  folder.addEventListener('click', (event) => {
    event.stopPropagation();
    openItemPath(item, folder);
  });
  actions.append(folder);

  const notes = document.createElement('button');
  notes.type = 'button';
  notes.className = 'notes-action';
  notes.disabled = !item.notesPath;
  notes.setAttribute('aria-label', item.notesPath
    ? `Open notes for ${name}`
    : `Notes directory unavailable for ${name}`);
  notes.title = item.notesPath ? 'Open notes directory' : 'No notes directory';
  const notesIcon = document.createElement('img');
  notesIcon.src = '/icons/notes.svg';
  notesIcon.alt = '';
  notesIcon.setAttribute('aria-hidden', 'true');
  notes.append(notesIcon);
  notes.addEventListener('click', (event) => {
    event.stopPropagation();
    openNotes(item, notes);
  });
  actions.append(notes);

  const managed = item.closeable !== false;
  const closed = managed && item.status === 'closed';
  const lifecycle = document.createElement('button');
  lifecycle.type = 'button';
  lifecycle.className = `row-action ${closed ? 'row-action-reopen' : 'row-action-close'}`;
  lifecycle.disabled = !managed;
  const label = closed ? 'Re-Open' : 'Close';
  lifecycle.append(closed ? refreshActionIcon() : closeActionIcon());
  lifecycle.setAttribute('aria-label', managed
    ? `${label} ${name}`
    : `Close unavailable for ${name}`);
  lifecycle.title = managed ? label : 'Configured locations cannot be closed';
  lifecycle.addEventListener('click', (event) => {
    event.stopPropagation();
    runRowAction(item, lifecycle);
  });
  actions.append(lifecycle);

  td.append(actions);
  row.append(td);
}

async function openItemPath(item, button) {
  button.disabled = true;
  error.hidden = true;
  try {
    await postWorkstreamCommand(item.id, 'open-path', {});
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function openNotes(item, button) {
  button.disabled = true;
  error.hidden = true;
  try {
    await postWorkstreamCommand(item.id, 'open-notes', {});
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function runRowAction(item, button) {
  const command = item.status === 'closed' ? 'resume' : 'close';
  button.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch(`/ws/${encodeURIComponent(item.id)}/${command}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commandRequestBody(command)),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    await refresh();
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
    button.disabled = false;
  }
}

function render(items) {
  table.replaceChildren();
  for (const item of items) {
    const row = document.createElement('tr');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Show details for ${item.name || item.branch || item.id}`);
    row.addEventListener('click', () => openSession(item.id, { pushHistory: true }));
    row.addEventListener('keydown', (event) => {
      if (event.target !== row) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openSession(item.id, { pushHistory: true });
      }
    });
    repoCell(row, item);
    branchCell(row, item);
    linksCell(row, item.issues);
    statusCell(row, item);
    lastUsedCell(row, item.lastJoined);
    actionCell(row, item);
    table.append(row);
  }
  empty.hidden = items.length !== 0;
}

function timestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function linkFor(ref) {
  try {
    const url = new URL(ref);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function normalizedLinkRefs(value) {
  return [...new Set(value.split(/\r?\n/).map((ref) => ref.trim()).filter(Boolean))];
}

function creationLinksForInput(input) {
  return input.closest('#new-repo-form') ? newRepoAddedLinks : newScratchpadAddedLinks;
}

function creationInputsForInput(input) {
  return input.closest('#new-repo-form') ? newRepoLinkInputs : newScratchpadLinkInputs;
}

function creationLinkRefs(inputs, addedLinks) {
  return normalizedLinkRefs(addedLinks.map((entry) => entry.ref).join('\n'));
}

function linkEntryPill(entry, onRemove, disabled = false) {
  const issue = issueLink(entry.ref);
  const pill = document.createElement('span');
  pill.className = 'issue-pill link-entry-value';
  pill.title = issue?.provider === 'custom' ? entry.ref : entry.title || entry.ref;
  const href = linkFor(entry.ref);
  const value = document.createElement(href ? 'a' : 'span');
  value.className = href ? 'link-entry-value-link' : 'link-entry-value-text';
  if (href) {
    value.href = href;
    value.target = '_blank';
    value.rel = 'noreferrer';
    if (issue?.provider === 'custom') value.title = entry.ref;
  }
  if (issue) {
    value.append(issuePillIcon(issue));
  } else {
    const iconName = entry.kind === 'github' || entry.kind === 'linear' ? entry.kind : null;
    if (iconName) {
      const providerIcon = document.createElement('span');
      providerIcon.className = `issue-pill-icon issue-pill-icon-${iconName}`;
      providerIcon.setAttribute('aria-hidden', 'true');
      value.append(providerIcon);
    }
  }
  const label = document.createElement('span');
  label.className = 'link-entry-value-label';
  label.textContent = issue?.label || entry.label || entry.ref;
  value.append(label);
  const remove = document.createElement('button');
  remove.className = 'link-entry-remove';
  remove.type = 'button';
  remove.disabled = disabled;
  remove.setAttribute('aria-label', `Remove ${entry.label || entry.ref}`);
  remove.title = 'Remove';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M5 5l14 14M19 5L5 19');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-width', '2.5');
  icon.append(path);
  remove.append(icon);
  remove.addEventListener('click', () => onRemove(entry));
  pill.append(value, remove);
  return pill;
}

function renderCreationLinkValues(inputs, addedLinks) {
  const containers = new Set(inputs.map((input) => input.dataset.values));
  for (const id of containers) document.querySelector(`#${id}`).replaceChildren();
  for (const entry of addedLinks) {
    const values = document.querySelector(`#${entry.values}`);
    values.append(linkEntryPill(entry, () => {
      addedLinks.splice(addedLinks.indexOf(entry), 1);
      renderCreationLinkValues(inputs, addedLinks);
    }));
  }
}

function renderDetailLinkValues(issues, disabled = false) {
  modalLinkValues.replaceChildren();
  for (const issue of issues || []) {
    const entry = {
      ref: issue.ref,
      label: issueLink(issue.ref)?.label || issue.ref,
      title: issue.ref,
      kind: issue.kind,
    };
    modalLinkValues.append(linkEntryPill(entry, () => removeDetailLink(entry.ref), disabled));
  }
}

function stageCreationLink(input) {
  const ref = String(input.dataset.url || input.value).trim();
  if (!ref) return false;
  const addedLinks = creationLinksForInput(input);
  if (!addedLinks.some((entry) => entry.ref === ref)) {
    addedLinks.push({
      ref,
      label: input.value.trim() || ref,
      title: input.title,
      kind: input.dataset.linkKind,
      values: input.dataset.values,
    });
  }
  input.value = '';
  delete input.dataset.url;
  input.removeAttribute('title');
  if (input.classList.contains('link-autocomplete-input')) setLinkSuggestionMenu(input, false);
  renderCreationLinkValues(creationInputsForInput(input), addedLinks);
  input.focus();
  return true;
}

function clearLinkEntryInput(input, { focus = true } = {}) {
  input.value = '';
  delete input.dataset.url;
  input.removeAttribute('title');
  if (input.classList.contains('link-autocomplete-input')) setLinkSuggestionMenu(input, false);
  if (focus) input.focus();
}

function linkAutocompleteParts(input) {
  const combobox = input.closest('.link-combobox');
  return {
    combobox,
    list: document.querySelector(`#${input.getAttribute('aria-controls')}`),
    toggle: combobox.querySelector('.link-combobox-toggle'),
  };
}

function setLinkSuggestionMenu(input, open) {
  const { list, toggle } = linkAutocompleteParts(input);
  list.hidden = !open;
  input.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-expanded', String(open));
  const provider = input.dataset.provider === 'linear' ? 'Linear' : 'GitHub';
  toggle.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} ${provider} suggestions`);
  toggle.title = `${open ? 'Hide' : 'Show'} ${provider} suggestions`;
}

function linkSuggestionOptions(input) {
  return [...linkAutocompleteParts(input).list.querySelectorAll('.link-suggestion-option')];
}

function moveLinkSuggestionFocus(input, option, offset) {
  const options = linkSuggestionOptions(input);
  if (!options.length) return;
  const index = option ? options.indexOf(option) : -1;
  options[(index + offset + options.length) % options.length].focus();
}

function selectLinkSuggestion(input, item) {
  input.value = item.id;
  input.dataset.url = item.url;
  input.title = item.title;
  input.focus();
  setLinkSuggestionMenu(input, false);
}

function matchingLinkSuggestions(input, suggestions) {
  const query = input.value.trim().toLowerCase();
  if (!query || input.dataset.url) return suggestions;
  return suggestions.filter((item) => [item.id, item.title, item.repository, item.group, item.meta]
    .some((value) => String(value || '').toLowerCase().includes(query)));
}

function renderLinkSuggestionMessage(input, message) {
  const { list } = linkAutocompleteParts(input);
  list.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'link-suggestion-empty';
  empty.textContent = message;
  list.append(empty);
}

function renderLinkSuggestions(input, suggestions) {
  const { list } = linkAutocompleteParts(input);
  list.replaceChildren();
  const matches = matchingLinkSuggestions(input, suggestions);
  if (!matches.length) {
    renderLinkSuggestionMessage(input, 'No matching suggestions');
    return;
  }
  const groups = new Map();
  for (const item of matches) {
    const group = item.group || (input.dataset.provider === 'linear' ? 'Linear' : 'GitHub');
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  for (const [group, items] of groups) {
    const heading = document.createElement('div');
    heading.className = 'link-suggestion-group';
    heading.textContent = group;
    list.append(heading);
    for (const item of items) {
      const option = document.createElement('div');
      option.className = 'link-suggestion-option';
      option.role = 'option';
      option.tabIndex = -1;
      option.setAttribute('aria-selected', String(input.dataset.url === item.url));
      const title = document.createElement('span');
      title.className = 'link-suggestion-title';
      title.textContent = `${item.id} — ${item.title}`;
      const meta = document.createElement('span');
      meta.className = 'link-suggestion-meta';
      meta.textContent = [item.repository, item.meta].filter(Boolean).join(' · ');
      option.append(title, meta);
      option.addEventListener('click', () => selectLinkSuggestion(input, item));
      option.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          selectLinkSuggestion(input, item);
          submitLinkInput(input);
        } else if (event.key === ' ') {
          event.preventDefault();
          selectLinkSuggestion(input, item);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveLinkSuggestionFocus(input, option, event.key === 'ArrowDown' ? 1 : -1);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setLinkSuggestionMenu(input, false);
          input.focus();
        }
      });
      list.append(option);
    }
  }
}

async function loadLinkSuggestions(provider, query = '') {
  const key = `${provider}:${query.toLowerCase()}`;
  if (!linkSuggestionCache.has(key)) {
    const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
    const pending = fetch(`/ws/link-suggestions/${encodeURIComponent(provider)}${suffix}`)
      .then(async (response) => {
        const body = await response.json();
        if (response.status === 404) {
          throw new Error('the API daemon is out of date; run ws web start to restart it');
        }
        if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
        return body.items || [];
      })
      .catch((cause) => {
        linkSuggestionCache.delete(key);
        throw cause;
      });
    linkSuggestionCache.set(key, pending);
  }
  return linkSuggestionCache.get(key);
}

async function openLinkSuggestionMenu(input) {
  if (input.disabled) return;
  const query = input.dataset.url ? '' : input.value.trim();
  setLinkSuggestionMenu(input, true);
  renderLinkSuggestionMessage(input, query ? 'Searching…' : 'Loading suggestions…');
  try {
    const suggestions = await loadLinkSuggestions(input.dataset.provider, query);
    const currentQuery = input.dataset.url ? '' : input.value.trim();
    if (currentQuery === query) {
      const matches = matchingLinkSuggestions(input, suggestions);
      if (!linkAutocompleteParts(input).list.hidden) renderLinkSuggestions(input, matches);
      return matches;
    }
  } catch (cause) {
    if (!linkAutocompleteParts(input).list.hidden) {
      renderLinkSuggestionMessage(input, `Could not load suggestions: ${cause.message}`);
    }
  }
  return [];
}

function scheduleLinkSuggestionSearch(input) {
  clearTimeout(linkSuggestionTimers.get(input));
  if (!input.value.trim()) {
    openLinkSuggestionMenu(input);
    return;
  }
  setLinkSuggestionMenu(input, true);
  renderLinkSuggestionMessage(input, 'Searching…');
  linkSuggestionTimers.set(input, setTimeout(() => openLinkSuggestionMenu(input), 200));
}

async function submitCreationLink(input) {
  if (!input.value.trim() && !input.dataset.url) return false;
  const button = linkAddButtons.find((candidate) => candidate.dataset.input === input.id);
  if (button) button.disabled = true;
  try {
    if (!await prepareSubmittedLink(input)) return false;
    return stageCreationLink(input);
  } finally {
    if (button && button.closest('form').getAttribute('aria-busy') !== 'true') button.disabled = false;
  }
}

async function prepareSubmittedLink(input) {
  if (!input.value.trim() && !input.dataset.url) return false;
  if (input.dataset.provider && !input.dataset.url) {
    clearTimeout(linkSuggestionTimers.get(input));
    const suggestions = await openLinkSuggestionMenu(input);
    if (suggestions[0]) selectLinkSuggestion(input, suggestions[0]);
  }
  return input.dataset.provider !== 'linear' || Boolean(input.dataset.url)
    || /^[A-Z]{2,}-\d+$/.test(input.value.trim())
    || /^https:\/\/linear\.app\//i.test(input.value.trim());
}

function submitLinkInput(input) {
  return input.closest('#session-modal') ? submitDetailLink(input) : submitCreationLink(input);
}

async function stagePendingCreationLinks(inputs) {
  for (const input of inputs) {
    if ((input.value.trim() || input.dataset.url) && !await submitCreationLink(input)) return false;
  }
  return true;
}

function resetCreationLinkInputs(inputs, addedLinks) {
  addedLinks.length = 0;
  for (const input of inputs) {
    clearTimeout(linkSuggestionTimers.get(input));
    delete input.dataset.url;
    input.removeAttribute('title');
    if (input.classList.contains('link-autocomplete-input')) setLinkSuggestionMenu(input, false);
  }
  renderCreationLinkValues(inputs, addedLinks);
}

function newRepoSelectorPreview(selector) {
  const pr = selector.match(/^#?(\d+)$/);
  if (pr) return { source: `pr:${pr[1]}`, branch: null };
  if (selector.includes(':')) {
    const [owner, branch] = selector.split(':');
    if (owner && branch) return { source: `fork:${owner}`, branch };
  }
  return selector ? { source: 'origin', branch: selector } : { source: null, branch: null };
}

function updateNewRepoPreview() {
  const repository = newRepoRepository.value.trim();
  const selector = newRepoSelector.value.trim();
  const preview = newRepoSelectorPreview(selector);
  newRepoSource.textContent = preview.source || '—';
  const parts = repository.split('/');
  const validRepository = parts.length === 2 && parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part));
  if (!validRepository || !selector || !newRepoDefaults?.repositoryRoot) {
    newRepoPath.textContent = '—';
    return;
  }
  const root = newRepoDefaults.repositoryRoot.replace(/\/+$/, '');
  const leaf = preview.branch ? preview.branch.replaceAll('/', '-') : '(resolved PR branch)';
  newRepoPath.textContent = `${root}/${parts[0]}/${parts[1]}/${leaf}`;
}

function selectRecentRepository(repository) {
  newRepoRepository.value = repository;
  updateNewRepoPreview();
  setRecentRepositoryMenu(false);
  newRepoRepository.focus();
}

function recentRepositoryOptions() {
  return [...newRepoRepositories.querySelectorAll('.repo-combobox-option')];
}

function moveRecentRepositoryFocus(option, offset) {
  const options = recentRepositoryOptions();
  if (!options.length) return;
  const index = option ? options.indexOf(option) : -1;
  options[(index + offset + options.length) % options.length].focus();
}

function renderRecentRepositories(repositories = recentRepositoryValues) {
  recentRepositoryValues = [...new Set((repositories || []).filter((value) => typeof value === 'string'))];
  newRepoRepositories.replaceChildren();
  const query = newRepoRepository.value.trim().toLowerCase();
  const matches = recentRepositoryValues.filter((repository) => repository.toLowerCase().includes(query));
  for (const repository of matches) {
    const option = document.createElement('div');
    option.className = 'repo-combobox-option';
    option.role = 'option';
    option.tabIndex = -1;
    option.textContent = repository;
    option.setAttribute('aria-selected', String(repository === newRepoRepository.value.trim()));
    option.addEventListener('click', () => selectRecentRepository(repository));
    option.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectRecentRepository(repository);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveRecentRepositoryFocus(option, event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setRecentRepositoryMenu(false);
        newRepoRepository.focus();
      }
    });
    newRepoRepositories.append(option);
  }
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'repo-combobox-empty';
    empty.textContent = recentRepositoryValues.length
      ? 'No matching recent repositories'
      : 'No repositories used in the last three months';
    newRepoRepositories.append(empty);
  }
}

function setRecentRepositoryMenu(open) {
  newRepoRepositories.hidden = !open;
  newRepoRepository.setAttribute('aria-expanded', String(open));
  newRepoRepositoryToggle.setAttribute('aria-expanded', String(open));
  newRepoRepositoryToggle.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} recent repositories`);
  newRepoRepositoryToggle.title = `${open ? 'Hide' : 'Show'} recent repositories`;
}

function renderNewRepoPanels() {
  for (const button of newPanelButtons) {
    const enabled = newRepoPanels.has(button.dataset.panel);
    updatePanelIconButton(button, enabled);
  }
}

function setNewRepoBusy(busy) {
  newRepoForm.setAttribute('aria-busy', String(busy));
  newRepoSubmitting.hidden = !busy;
  newRepoSubmit.disabled = busy;
  newRepoDismiss.disabled = busy;
  newRepoCancel.disabled = busy;
  newRepoRepository.disabled = busy;
  newRepoSelector.disabled = busy;
  newRepoRepositoryToggle.disabled = busy;
  if (busy) setRecentRepositoryMenu(false);
  newRepoAgent.disabled = busy;
  for (const input of newRepoLinkInputs) input.disabled = busy;
  for (const input of [newRepoLinearLink, newRepoGithubLink]) {
    linkAutocompleteParts(input).toggle.disabled = busy;
    if (busy) setLinkSuggestionMenu(input, false);
  }
  for (const button of newRepoForm.querySelectorAll('.link-add-button')) button.disabled = busy;
  for (const button of newPanelButtons) button.disabled = busy;
}

async function openNewRepoModal() {
  newRepoButton.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch('/ws/new');
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    newRepoDefaults = body;
    newRepoForm.reset();
    resetCreationLinkInputs(newRepoLinkInputs, newRepoAddedLinks);
    renderRecentRepositories(body.recentRepositories);
    setRecentRepositoryMenu(false);
    updateAgentToggle(newRepoAgent, body.agent);
    newRepoPanels = new Set(selectedLayoutPanels());
    newRepoError.hidden = true;
    setNewRepoBusy(false);
    renderNewRepoPanels();
    updateNewRepoPreview();
    if (!newRepoModal.open) newRepoModal.showModal();
    newRepoRepository.focus();
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
  } finally {
    newRepoButton.disabled = false;
  }
}

function toggleNewRepoPanel(panel) {
  if (newRepoPanels.has(panel)) newRepoPanels.delete(panel);
  else newRepoPanels.add(panel);
  renderNewRepoPanels();
}

async function createNewRepoSession(event) {
  event.preventDefault();
  if (newRepoPanels.size === 0) {
    newRepoError.textContent = 'Select at least one panel.';
    newRepoError.hidden = false;
    return;
  }
  if (!await stagePendingCreationLinks(newRepoLinkInputs)) {
    newRepoError.textContent = 'Choose a suggestion or enter a valid link reference.';
    newRepoError.hidden = false;
    return;
  }
  setNewRepoBusy(true);
  newRepoError.hidden = true;
  try {
    const response = await fetch('/ws', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repository: newRepoRepository.value.trim(),
        selector: newRepoSelector.value.trim(),
        agent: agentToggleValue(newRepoAgent),
        panels: [...newRepoPanels],
        links: creationLinkRefs(newRepoLinkInputs, newRepoAddedLinks),
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    const id = body.workstream?.id;
    if (id === undefined || id === null) throw new Error('The server did not return the new session ID.');
    newRepoModal.close();
    await refresh();
    await openSession(id, { pushHistory: true });
  } catch (cause) {
    newRepoError.textContent = cause.message;
    newRepoError.hidden = false;
  } finally {
    setNewRepoBusy(false);
  }
}

function scratchpadSlug(value) {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function updateNewScratchpadPreview() {
  const root = newScratchpadDefaults?.scratchpadRoot?.replace(/\/+$/, '');
  if (!root) {
    newScratchpadPath.textContent = '—';
    return;
  }
  const name = scratchpadSlug(newScratchpadName.value) || '(random name)';
  newScratchpadPath.textContent = `${root}/${name}`;
}

function renderNewScratchpadPanels() {
  for (const button of newScratchpadPanelButtons) {
    const enabled = newScratchpadPanels.has(button.dataset.panel);
    updatePanelIconButton(button, enabled);
  }
}

function setNewScratchpadBusy(busy) {
  newScratchpadForm.setAttribute('aria-busy', String(busy));
  newScratchpadSubmitting.hidden = !busy;
  newScratchpadSubmit.disabled = busy;
  newScratchpadDismiss.disabled = busy;
  newScratchpadCancel.disabled = busy;
  newScratchpadName.disabled = busy;
  newScratchpadAgent.disabled = busy;
  for (const input of newScratchpadLinkInputs) input.disabled = busy;
  for (const input of [newScratchpadLinearLink, newScratchpadGithubLink]) {
    linkAutocompleteParts(input).toggle.disabled = busy;
    if (busy) setLinkSuggestionMenu(input, false);
  }
  for (const button of newScratchpadForm.querySelectorAll('.link-add-button')) button.disabled = busy;
  for (const button of newScratchpadPanelButtons) button.disabled = busy;
}

async function openNewScratchpadModal() {
  newScratchpadButton.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch('/ws/new');
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    newScratchpadDefaults = body;
    newScratchpadForm.reset();
    resetCreationLinkInputs(newScratchpadLinkInputs, newScratchpadAddedLinks);
    updateAgentToggle(newScratchpadAgent, body.agent);
    newScratchpadPanels = new Set(selectedLayoutPanels());
    newScratchpadError.hidden = true;
    setNewScratchpadBusy(false);
    renderNewScratchpadPanels();
    updateNewScratchpadPreview();
    if (!newScratchpadModal.open) newScratchpadModal.showModal();
    newScratchpadName.focus();
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
  } finally {
    newScratchpadButton.disabled = false;
  }
}

function toggleNewScratchpadPanel(panel) {
  if (newScratchpadPanels.has(panel)) newScratchpadPanels.delete(panel);
  else newScratchpadPanels.add(panel);
  renderNewScratchpadPanels();
}

async function createNewScratchpadSession(event) {
  event.preventDefault();
  if (newScratchpadPanels.size === 0) {
    newScratchpadError.textContent = 'Select at least one panel.';
    newScratchpadError.hidden = false;
    return;
  }
  if (!await stagePendingCreationLinks(newScratchpadLinkInputs)) {
    newScratchpadError.textContent = 'Choose a suggestion or enter a valid link reference.';
    newScratchpadError.hidden = false;
    return;
  }
  setNewScratchpadBusy(true);
  newScratchpadError.hidden = true;
  try {
    const response = await fetch('/ws/scratchpad', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newScratchpadName.value.trim(),
        agent: agentToggleValue(newScratchpadAgent),
        panels: [...newScratchpadPanels],
        links: creationLinkRefs(newScratchpadLinkInputs, newScratchpadAddedLinks),
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    const id = body.workstream?.id;
    if (id === undefined || id === null) throw new Error('The server did not return the new scratchpad ID.');
    newScratchpadModal.close();
    await refresh();
    await openSession(id, { pushHistory: true });
  } catch (cause) {
    newScratchpadError.textContent = cause.message;
    newScratchpadError.hidden = false;
  } finally {
    setNewScratchpadBusy(false);
  }
}

async function postWorkstreamCommand(id, command, body) {
  const response = await fetch(`/ws/${encodeURIComponent(id)}/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
  return result;
}

function resetDetailLinkInputs() {
  for (const input of modalLinkInputs) {
    clearTimeout(linkSuggestionTimers.get(input));
    clearLinkEntryInput(input, { focus: false });
  }
}

function updateDetailLinkControls(item, busy = false) {
  const available = item.type !== 'misc';
  for (const input of modalLinkInputs) input.disabled = busy || !available;
  for (const button of modalLinkControls.querySelectorAll('button')) button.disabled = busy || !available;
  linkNote.textContent = available
    ? 'Links are saved as soon as they are added or removed.'
    : 'Associated links are unavailable for configured locations.';
  renderDetailLinkValues(item.issues, busy || !available);
}

async function submitDetailLink(input) {
  if (!selectedSession || selectedSession.type === 'misc' || savingDetailLinks) return false;
  const button = linkAddButtons.find((candidate) => candidate.dataset.input === input.id);
  if (button) button.disabled = true;
  if (!await prepareSubmittedLink(input)) {
    if (button) button.disabled = false;
    return false;
  }
  const id = selectedSession.id;
  const ref = String(input.dataset.url || input.value).trim();
  if (selectedSession.issues?.some((issue) => issue.ref === ref)) {
    clearLinkEntryInput(input);
    if (button) button.disabled = false;
    return true;
  }
  savingDetailLinks = true;
  updateDetailLinkControls(selectedSession, true);
  modalError.hidden = true;
  try {
    await postWorkstreamCommand(id, 'issue-add', { refs: [ref] });
    clearLinkEntryInput(input, { focus: false });
    await refresh();
    if (modal.open && selectedSession && String(selectedSession.id) === String(id)) {
      await openSession(id);
    }
    if (modal.open && input.isConnected) input.focus();
    return true;
  } catch (cause) {
    modalError.textContent = cause.message;
    modalError.hidden = false;
    return false;
  } finally {
    savingDetailLinks = false;
    if (selectedSession && String(selectedSession.id) === String(id)) {
      updateDetailLinkControls(selectedSession);
    }
    if (button && selectedSession?.type !== 'misc') button.disabled = false;
  }
}

async function removeDetailLink(ref) {
  if (!selectedSession || selectedSession.type === 'misc' || savingDetailLinks) return;
  const id = selectedSession.id;
  savingDetailLinks = true;
  updateDetailLinkControls(selectedSession, true);
  modalError.hidden = true;
  try {
    await postWorkstreamCommand(id, 'issue-remove', { ref });
    await refresh();
    if (modal.open && selectedSession && String(selectedSession.id) === String(id)) {
      await openSession(id);
    }
  } catch (cause) {
    modalError.textContent = cause.message;
    modalError.hidden = false;
  } finally {
    savingDetailLinks = false;
    if (selectedSession && String(selectedSession.id) === String(id)) {
      updateDetailLinkControls(selectedSession);
    }
  }
}

function renderStack(item) {
  const parts = [];
  if (item.stackedOn) parts.push(`on #${item.stackedOn.id} (${item.stackedOn.branch})`);
  if (item.stackedBy?.length) {
    parts.push(`followed by ${item.stackedBy.map((row) => `#${row.id} (${row.branch})`).join(', ')}`);
  }
  detail.stack.textContent = parts.join('; ') || '—';
}

function updateActions(item, busy = false) {
  for (const button of modalActions) {
    const command = button.dataset.command;
    const unavailable = command === 'pause'
      ? item.status !== 'active'
      : command === 'resume'
        ? item.status === 'active'
        : item.closeable === false || item.status === 'closed';
    button.disabled = busy || unavailable;
  }
}

function updatePanelToggles(item, busy = false) {
  const available = Boolean(item.panels?.tabOpen);
  for (const button of panelButtons) {
    const panel = button.dataset.panel;
    const enabled = Boolean(item.panels?.[panel]);
    updatePanelIconButton(button, enabled);
    button.disabled = busy || !available;
  }
  const note = item.panelError
    ? `Panel state unavailable: ${item.panelError}`
    : available
      ? ''
      : 'Open or resume this workstream before changing its panels.';
  panelNote.textContent = note;
  panelNote.hidden = !note;
}

function updateAgentSelect(item, busy = false) {
  updateAgentToggle(agentSelect, item.agent, busy);
}

function renderDetails(item, busy = false) {
  const changedSession = !selectedSession || String(selectedSession.id) !== String(item.id);
  selectedSession = item;
  if (changedSession) resetDetailLinkInputs();
  detail.title.textContent = `${item.id}: ${item.name || item.branch}`;
  const scratchpad = item.type === 'scratchpad';
  scratchpadNameRow.hidden = !scratchpad;
  scratchpadNameInput.value = scratchpad ? item.name : '';
  scratchpadNameInput.disabled = busy || renamingScratchpad;
  detail.status.textContent = item.status;
  detail.status.className = `status-pill status-${String(item.status).replace(/[^a-z_-]/g, '')}`;
  detail.branch.textContent = scratchpad ? item.name : item.branch;
  const branchUrl = githubBranchUrl(item);
  if (branchUrl) {
    detail.branch.href = branchUrl;
    detail.branch.title = `View ${item.branch} on GitHub`;
  } else {
    detail.branch.removeAttribute('href');
    detail.branch.removeAttribute('title');
  }
  const branchState = branchIconState(item);
  detail['branch-icon'].className = `branch-icon ${branchState.className}`;
  detail['branch-icon'].setAttribute('aria-label', branchState.label);
  detail['branch-icon'].title = branchState.label;
  detail.path.textContent = item.path;
  detail.path.setAttribute('aria-label', `Open directory ${item.path}`);
  detail.path.title = 'Open this directory';
  detail['path-presence'].textContent = item.worktreePresent ? '✓' : '✕';
  detail['path-presence'].className = `path-presence ${item.worktreePresent ? 'path-present' : 'path-missing'}`;
  detail['path-presence'].setAttribute('aria-label', item.worktreePresent ? 'Directory exists' : 'Directory missing');
  detail['path-presence'].title = item.worktreePresent ? 'Directory exists' : 'Directory missing';
  detail.created.textContent = timestamp(item.createdAt);
  detail['last-joined'].textContent = timestamp(item.lastJoined);
  if (item.repoUrl) {
    detail.repo.href = item.repoUrl;
    detail.repo.textContent = item.repo;
  } else {
    detail.repo.removeAttribute('href');
    detail.repo.textContent = '';
  }
  renderStack(item);
  updateDetailLinkControls(item, busy || savingDetailLinks);
  updateActions(item, busy);
  updatePanelToggles(item, busy);
  updateAgentSelect(item, busy);
}

function pushSessionUrl(id) {
  const url = new URL(location.href);
  const session = String(id);
  if (url.searchParams.get('session') === session) return;
  url.searchParams.set('session', session);
  const currentState = history.state && typeof history.state === 'object' ? history.state : {};
  history.pushState({ ...currentState, aiWorkstreamModal: session }, '', url);
}

function clearSessionUrl() {
  const url = new URL(location.href);
  const session = url.searchParams.get('session');
  if (!session) return;
  if (history.state?.aiWorkstreamModal === session) {
    history.back();
    return;
  }
  url.searchParams.delete('session');
  const { aiWorkstreamModal: _modal, ...nextState } = history.state && typeof history.state === 'object'
    ? history.state
    : {};
  history.replaceState(Object.keys(nextState).length ? nextState : null, '', url);
}

async function openSession(id, { pushHistory = false, expectedSession = null } = {}) {
  try {
    const response = await fetch(`/ws/${encodeURIComponent(id)}/?status=all`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    const item = body.items[0];
    if (!item) throw new Error(`Session ${id} is no longer available`);
    if (expectedSession !== null
      && new URLSearchParams(location.search).get('session') !== String(expectedSession)) return;
    if (pushHistory) pushSessionUrl(item.id);
    modalError.hidden = true;
    renderDetails(item);
    if (!modal.open) modal.showModal();
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
  }
}

function syncModalFromUrl() {
  const session = new URLSearchParams(location.search).get('session');
  if (!session) {
    if (modal.open) {
      closingModalFromHistory = true;
      modal.close();
    }
    return;
  }
  if (modal.open && selectedSession && String(selectedSession.id) === session) return;
  openSession(session, { expectedSession: session });
}

async function runAction(command) {
  if (!selectedSession) return;
  const id = selectedSession.id;
  modalError.hidden = true;
  updateActions(selectedSession, true);
  updatePanelToggles(selectedSession, true);
  updateAgentSelect(selectedSession, true);
  try {
    const response = await fetch(`/ws/${encodeURIComponent(id)}/${command}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commandRequestBody(command)),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    await Promise.all([refresh(), openSession(id)]);
  } catch (cause) {
    modalError.textContent = cause.message;
    modalError.hidden = false;
  } finally {
    if (selectedSession) {
      updateActions(selectedSession);
      updatePanelToggles(selectedSession);
      updateAgentSelect(selectedSession);
    }
  }
}

async function openSelectedPath() {
  if (!selectedSession) return;
  const id = selectedSession.id;
  modalError.hidden = true;
  detail.path.disabled = true;
  try {
    await postWorkstreamCommand(id, 'open-path', {});
  } catch (cause) {
    modalError.textContent = cause.message;
    modalError.hidden = false;
  } finally {
    if (selectedSession && String(selectedSession.id) === String(id)) detail.path.disabled = false;
  }
}

async function togglePanel(panel) {
  if (!selectedSession) return;
  const id = selectedSession.id;
  modalError.hidden = true;
  updateActions(selectedSession, true);
  updatePanelToggles(selectedSession, true);
  updateAgentSelect(selectedSession, true);
  try {
    const response = await fetch(`/ws/${encodeURIComponent(id)}/panel-toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panel }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    await Promise.all([refresh(), openSession(id)]);
  } catch (cause) {
    modalError.textContent = cause.message;
    modalError.hidden = false;
  } finally {
    if (selectedSession) {
      updateActions(selectedSession);
      updatePanelToggles(selectedSession);
      updateAgentSelect(selectedSession);
    }
  }
}

async function setAgent(agent) {
  if (!selectedSession) return;
  const id = selectedSession.id;
  const selected = agent === 'codex' ? 'codex' : 'claude';
  modalError.hidden = true;
  updateActions(selectedSession, true);
  updatePanelToggles(selectedSession, true);
  updateAgentSelect({ ...selectedSession, agent: selected }, true);
  try {
    await postWorkstreamCommand(id, 'agent-set', { agent: selected });
    await Promise.all([refresh(), openSession(id)]);
  } catch (cause) {
    modalError.textContent = cause.message;
    modalError.hidden = false;
  } finally {
    if (selectedSession) {
      updateActions(selectedSession);
      updatePanelToggles(selectedSession);
      updateAgentSelect(selectedSession);
    }
  }
}

async function renameScratchpad() {
  if (!selectedSession || selectedSession.type !== 'scratchpad' || renamingScratchpad) return;
  const id = selectedSession.id;
  const previous = selectedSession.name;
  const name = scratchpadNameInput.value.trim();
  if (!name || name === previous) {
    scratchpadNameInput.value = previous;
    return;
  }
  renamingScratchpad = true;
  scratchpadNameInput.disabled = true;
  modalError.hidden = true;
  try {
    const result = await postWorkstreamCommand(id, 'rename', { name });
    await refresh();
    if (modal.open && selectedSession && String(selectedSession.id) === String(id)) {
      renderDetails({ ...selectedSession, ...result.workstream });
    }
  } catch (cause) {
    scratchpadNameInput.value = previous;
    modalError.textContent = cause.message;
    modalError.hidden = false;
  } finally {
    renamingScratchpad = false;
    if (selectedSession && String(selectedSession.id) === String(id)) {
      scratchpadNameInput.disabled = false;
    }
  }
}

function visiblePages(pageCount, page) {
  const visible = new Set([0, pageCount - 1]);
  for (let candidate = page - 2; candidate <= page + 2; candidate++) {
    if (candidate >= 0 && candidate < pageCount) visible.add(candidate);
  }
  if (page < 4) for (let candidate = 0; candidate < Math.min(5, pageCount); candidate++) visible.add(candidate);
  if (page > pageCount - 5) {
    for (let candidate = Math.max(0, pageCount - 5); candidate < pageCount; candidate++) visible.add(candidate);
  }
  return [...visible].sort((left, right) => left - right);
}

function setPerpage(value) {
  const numeric = /^\d+$/.test(value) ? Number(value) : 25;
  const perpage = String(numeric >= 1 && numeric <= 100 ? numeric : 25);
  if (![...perpageSelect.options].some((option) => option.value === perpage)) {
    const option = document.createElement('option');
    option.value = perpage;
    option.textContent = `${perpage} Per Page`;
    perpageSelect.append(option);
  }
  perpageSelect.value = perpage;
}

function renderPagination({ page, perpage, total }) {
  const pageCount = Math.ceil(total / perpage);
  currentPage = pageCount ? Math.min(page, pageCount - 1) : 0;
  setPerpage(String(perpage));
  pagination.hidden = pageCount === 0;
  pagePrevious.disabled = currentPage === 0;
  pageNext.disabled = currentPage >= pageCount - 1;
  pageNumbers.replaceChildren();
  if (pageCount === 0) return;
  let previous = -1;
  for (const pageIndex of visiblePages(pageCount, currentPage)) {
    if (previous !== -1 && pageIndex > previous + 1) {
      const ellipsis = document.createElement('span');
      ellipsis.className = 'page-ellipsis';
      ellipsis.textContent = '…';
      pageNumbers.append(ellipsis);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(pageIndex + 1);
    button.setAttribute('aria-label', `Page ${pageIndex + 1}`);
    if (pageIndex === currentPage) {
      button.setAttribute('aria-current', 'page');
      button.disabled = true;
    }
    button.addEventListener('click', () => goToPage(pageIndex));
    pageNumbers.append(button);
    previous = pageIndex;
  }
}

async function refresh() {
  const query = new URLSearchParams(new FormData(filters));
  if (!query.get('type')) query.delete('type');
  query.set('page', String(currentPage));
  query.set('perpage', perpageSelect.value);
  try {
    const response = await fetch(`/ws/all/?${query}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    const pageCount = Math.ceil(body.total / body.perpage);
    if (pageCount && body.page >= pageCount) {
      currentPage = pageCount - 1;
      writeListUrl({ replace: true });
      return refresh();
    }
    if (!pageCount && currentPage !== 0) {
      currentPage = 0;
      writeListUrl({ replace: true });
    }
    error.hidden = true;
    render(body.items);
    renderPagination(body);
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
  }
}

function readListStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const type = params.get('type') || '';
  const status = params.get('status') || 'active_paused';
  const page = params.get('page') || '0';
  const perpage = params.get('perpage') || '25';
  filters.elements.type.value = TYPE_FILTERS.has(type) ? type : '';
  filters.elements.status.value = STATUS_FILTERS.has(status) ? status : 'active_paused';
  currentPage = /^\d+$/.test(page) && Number(page) <= 1_000_000 ? Number(page) : 0;
  setPerpage(perpage);
}

function writeListUrl({ replace = false } = {}) {
  const url = new URL(location.href);
  const type = filters.elements.type.value;
  if (type) url.searchParams.set('type', type);
  else url.searchParams.delete('type');
  url.searchParams.set('status', filters.elements.status.value);
  url.searchParams.set('page', String(currentPage));
  url.searchParams.set('perpage', perpageSelect.value);
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
}

function goToPage(page) {
  if (page === currentPage || page < 0) return;
  currentPage = page;
  writeListUrl();
  refresh();
}

let reconnectTimer = null;

function scheduleReconnect() {
  connection.textContent = 'reconnecting…';
  connection.dataset.state = 'closed';
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1000);
}

function connect() {
  connection.textContent = 'connecting…';
  connection.dataset.state = 'connecting';
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  try {
    socket = new WebSocket(`${protocol}//${location.host}/ws/events`);
  } catch {
    scheduleReconnect();
    return;
  }
  socket.addEventListener('open', () => {
    connection.textContent = 'live';
    connection.dataset.state = 'open';
    refresh();
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); }
    catch { return; }
    if (!message || !['new_session', 'update_session', 'agent_status', 'shell_status'].includes(message.type)) return;
    refresh();
    if (modal.open && selectedSession && !savingDetailLinks && !renamingScratchpad
      && document.activeElement !== scratchpadNameInput
      && String(selectedSession.id) === String(message.id)) {
      openSession(message.id);
    }
  });
  socket.addEventListener('close', scheduleReconnect);
  socket.addEventListener('error', () => {
    scheduleReconnect();
    socket.close();
  });
}

filters.addEventListener('change', () => {
  currentPage = 0;
  writeListUrl();
  refresh();
});
perpageSelect.addEventListener('change', () => {
  currentPage = 0;
  writeListUrl();
  refresh();
});
pagePrevious.addEventListener('click', () => goToPage(currentPage - 1));
pageNext.addEventListener('click', () => goToPage(currentPage + 1));
window.addEventListener('popstate', () => {
  readListStateFromUrl();
  refresh();
  syncModalFromUrl();
});

modal.addEventListener('click', (event) => {
  if (event.target === modal) modal.close();
});
modal.addEventListener('close', () => {
  const closedFromHistory = closingModalFromHistory;
  closingModalFromHistory = false;
  resetDetailLinkInputs();
  selectedSession = null;
  if (!closedFromHistory) clearSessionUrl();
});
newRepoButton.addEventListener('click', openNewRepoModal);
newRepoDismiss.addEventListener('click', () => newRepoModal.close());
newRepoCancel.addEventListener('click', () => newRepoModal.close());
newRepoForm.addEventListener('submit', createNewRepoSession);
newRepoRepository.addEventListener('input', () => {
  updateNewRepoPreview();
  renderRecentRepositories();
  setRecentRepositoryMenu(true);
});
newRepoRepository.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    renderRecentRepositories();
    setRecentRepositoryMenu(true);
    moveRecentRepositoryFocus(null, 1);
  } else if (event.key === 'Escape') {
    setRecentRepositoryMenu(false);
  }
});
newRepoRepositoryToggle.addEventListener('click', () => {
  const open = newRepoRepositories.hidden;
  if (open) renderRecentRepositories();
  setRecentRepositoryMenu(open);
  if (open) newRepoRepository.focus();
});
newRepoCombobox.addEventListener('focusout', () => {
  setTimeout(() => {
    if (!newRepoCombobox.contains(document.activeElement)) setRecentRepositoryMenu(false);
  }, 0);
});
for (const input of linkAutocompleteInputs) {
  const { combobox, list, toggle } = linkAutocompleteParts(input);
  input.addEventListener('focus', () => openLinkSuggestionMenu(input));
  input.addEventListener('input', () => {
    delete input.dataset.url;
    input.removeAttribute('title');
    scheduleLinkSuggestionSearch(input);
  });
  input.addEventListener('keydown', async (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (list.hidden) await openLinkSuggestionMenu(input);
      moveLinkSuggestionFocus(input, null, 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      await submitLinkInput(input);
    } else if (event.key === 'Escape') {
      setLinkSuggestionMenu(input, false);
    }
  });
  toggle.addEventListener('click', () => {
    const open = list.hidden;
    input.focus();
    if (open) openLinkSuggestionMenu(input);
    else setLinkSuggestionMenu(input, false);
  });
  combobox.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!combobox.contains(document.activeElement)) setLinkSuggestionMenu(input, false);
    }, 0);
  });
}
for (const input of [...creationLinkInputs, ...modalLinkInputs]
  .filter((candidate) => !candidate.classList.contains('link-autocomplete-input'))) {
  input.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    await submitLinkInput(input);
  });
}
for (const button of linkAddButtons) {
  button.addEventListener('click', () => submitLinkInput(document.querySelector(`#${button.dataset.input}`)));
}
newRepoSelector.addEventListener('input', updateNewRepoPreview);
newRepoAgent.addEventListener('click', () => toggleAgent(newRepoAgent));
newRepoModal.addEventListener('click', (event) => {
  if (event.target === newRepoModal && !newRepoSubmit.disabled) newRepoModal.close();
});
newRepoModal.addEventListener('cancel', (event) => {
  if (newRepoSubmit.disabled) event.preventDefault();
});
for (const button of newPanelButtons) {
  button.addEventListener('click', () => toggleNewRepoPanel(button.dataset.panel));
}
newScratchpadButton.addEventListener('click', openNewScratchpadModal);
newScratchpadDismiss.addEventListener('click', () => newScratchpadModal.close());
newScratchpadCancel.addEventListener('click', () => newScratchpadModal.close());
newScratchpadForm.addEventListener('submit', createNewScratchpadSession);
newScratchpadName.addEventListener('input', updateNewScratchpadPreview);
newScratchpadAgent.addEventListener('click', () => toggleAgent(newScratchpadAgent));
newScratchpadModal.addEventListener('click', (event) => {
  if (event.target === newScratchpadModal && !newScratchpadSubmit.disabled) newScratchpadModal.close();
});
newScratchpadModal.addEventListener('cancel', (event) => {
  if (newScratchpadSubmit.disabled) event.preventDefault();
});
for (const button of newScratchpadPanelButtons) {
  button.addEventListener('click', () => toggleNewScratchpadPanel(button.dataset.panel));
}
detail.path.addEventListener('click', openSelectedPath);
agentSelect.addEventListener('click', () => {
  const agent = agentToggleValue(agentSelect) === 'claude' ? 'codex' : 'claude';
  setAgent(agent);
});
scratchpadNameInput.addEventListener('change', renameScratchpad);
scratchpadNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    scratchpadNameInput.blur();
  } else if (event.key === 'Escape') {
    scratchpadNameInput.value = selectedSession?.name || '';
    scratchpadNameInput.blur();
  }
});

for (const button of modalActions) {
  button.addEventListener('click', () => runAction(button.dataset.command));
}
for (const button of panelButtons) {
  button.addEventListener('click', () => togglePanel(button.dataset.panel));
}

readListStateFromUrl();
refresh();
syncModalFromUrl();
connect();
