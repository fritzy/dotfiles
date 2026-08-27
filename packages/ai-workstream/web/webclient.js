const table = document.querySelector('#workstreams');
const empty = document.querySelector('#empty');
const error = document.querySelector('#error');
const connection = document.querySelector('#connection');
const themeSelect = document.querySelector('#theme-select');
const themeCredit = document.querySelector('#theme-credit');
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
const linkEditor = document.querySelector('#modal-links-editor');
const linkInput = document.querySelector('#modal-links-input');
const linkNote = document.querySelector('#modal-links-note');
const newRepoButton = document.querySelector('#new-repo-button');
const newRepoModal = document.querySelector('#new-repo-modal');
const newRepoForm = document.querySelector('#new-repo-form');
const newRepoDismiss = document.querySelector('#new-repo-dismiss');
const newRepoCancel = document.querySelector('#new-repo-cancel');
const newRepoSubmit = document.querySelector('#new-repo-submit');
const newRepoRepository = document.querySelector('#new-repo-repository');
const newRepoSelector = document.querySelector('#new-repo-selector');
const newRepoSource = document.querySelector('#new-repo-source');
const newRepoAgent = document.querySelector('#new-repo-agent');
const newRepoPath = document.querySelector('#new-repo-path');
const newRepoLinks = document.querySelector('#new-repo-links');
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
const newScratchpadError = document.querySelector('#new-scratchpad-error');
const newScratchpadSubmitting = document.querySelector('#new-scratchpad-submitting');
const newScratchpadPanelButtons = [...document.querySelectorAll('.new-scratchpad-panel-toggle')];
let selectedSession = null;
let currentPage = 0;
let editingLinks = false;
let savingLinks = false;
let originalLinkRefs = [];
let closingModalFromHistory = false;
let newRepoDefaults = null;
let newRepoPanels = new Set();
let newScratchpadDefaults = null;
let newScratchpadPanels = new Set();

const TYPE_FILTERS = new Set(['', 'repo', 'scratchpad', 'misc']);
const STATUS_FILTERS = new Set(['active_paused', 'active', 'paused', 'closed', 'all']);
const OPTICAL_CONTROL_SELECTOR = [
  'button:not(.modal-dismiss):not(.path-action):not(.agent-pill)',
  '.status-pill',
  '.issue-pill',
  '.agent-label',
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

const detail = Object.fromEntries([
  'title', 'status', 'repo', 'repo-row', 'branch', 'branch-icon', 'source', 'path',
  'path-presence', 'created', 'last-joined', 'stack', 'links',
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
  return gitState(item);
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
  const branch = document.createElement('span');
  branch.textContent = item.branch;
  value.append(icon, branch);
  td.append(value);
  row.append(td);
}

function lastUsedCell(row, value) {
  const td = document.createElement('td');
  td.className = 'last-used-column';
  if (!value) {
    td.textContent = '—';
  } else {
    const date = new Date(value);
    td.textContent = Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString();
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
  return null;
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
      const icon = document.createElement('span');
      icon.className = `issue-pill-icon issue-pill-icon-${issue.icon}`;
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = issue.label;
      link.append(icon, label);
      link.setAttribute('aria-label', `Open linked ${issue.provider} issue ${issue.label} in a new tab`);
      link.title = `Open ${issue.label}`;
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

function agentCell(row, item) {
  const td = document.createElement('td');
  td.className = 'agent-column';
  if (item.status !== 'active') {
    td.textContent = '—';
    td.setAttribute('aria-label', 'Agent unavailable while session is not active');
    row.append(td);
    return;
  }
  const provider = item.agent === 'codex' ? 'codex' : 'claude';
  const working = item.agentStatus === 'working';
  const ready = item.agentStatus === 'ready';
  const indicator = document.createElement('button');
  indicator.type = 'button';
  indicator.className = 'agent-pill';
  const activity = working ? 'working ' : ready ? 'waiting ' : '';
  indicator.setAttribute('aria-label', `Focus ${activity}${provider} agent`);
  indicator.title = working
    ? `${provider === 'codex' ? 'Codex' : 'Claude'} working — focus its terminal pane`
    : ready
      ? `${provider === 'codex' ? 'Codex' : 'Claude'} waiting for input — focus its terminal pane`
      : `Focus ${provider === 'codex' ? 'Codex' : 'Claude'} terminal pane`;
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
    icon.className = `agent-icon${provider === 'codex' ? ' agent-icon-codex' : ''}`;
    icon.src = provider === 'codex' ? '/icons/openai.svg' : '/icons/claude.svg';
    icon.alt = '';
    iconSlot.append(icon);
  }
  const label = document.createElement('span');
  label.className = 'agent-label';
  label.textContent = provider;
  indicator.append(iconSlot, label);
  td.append(indicator);
  row.append(td);
}

async function focusAgent(item, button) {
  button.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch(`/ws/${encodeURIComponent(item.id)}/focus-agent`, {
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
      body: '{}',
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
      body: '{}',
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
    agentCell(row, item);
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

function renderLinks(issues) {
  detail.links.replaceChildren();
  if (!issues?.length) {
    const item = document.createElement('li');
    item.textContent = 'None';
    detail.links.append(item);
    return;
  }
  for (const issue of issues) {
    const item = document.createElement('li');
    const href = linkFor(issue.ref);
    if (href) {
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = issue.ref;
      item.append(link);
    } else {
      item.textContent = issue.ref;
    }
    if (issue.kind) item.append(` (${issue.kind})`);
    detail.links.append(item);
  }
}

function normalizedLinkRefs(value) {
  return [...new Set(value.split(/\r?\n/).map((ref) => ref.trim()).filter(Boolean))];
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

function renderNewRepoPanels() {
  for (const button of newPanelButtons) {
    const enabled = newRepoPanels.has(button.dataset.panel);
    button.setAttribute('aria-pressed', String(enabled));
    const panel = button.dataset.panel;
    button.textContent = `${panel[0].toUpperCase()}${panel.slice(1)}: ${enabled ? 'on' : 'off'}`;
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
  newRepoAgent.disabled = busy;
  newRepoLinks.disabled = busy;
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
    newRepoAgent.value = body.agent === 'codex' ? 'codex' : 'claude';
    newRepoPanels = new Set(body.panels || []);
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
  setNewRepoBusy(true);
  newRepoError.hidden = true;
  try {
    const response = await fetch('/ws', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repository: newRepoRepository.value.trim(),
        selector: newRepoSelector.value.trim(),
        agent: newRepoAgent.value,
        panels: [...newRepoPanels],
        links: normalizedLinkRefs(newRepoLinks.value),
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
    button.setAttribute('aria-pressed', String(enabled));
    const panel = button.dataset.panel;
    button.textContent = `${panel[0].toUpperCase()}${panel.slice(1)}: ${enabled ? 'on' : 'off'}`;
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
  newScratchpadLinks.disabled = busy;
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
    newScratchpadAgent.value = body.agent === 'codex' ? 'codex' : 'claude';
    newScratchpadPanels = new Set(body.panels || []);
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
  setNewScratchpadBusy(true);
  newScratchpadError.hidden = true;
  try {
    const response = await fetch('/ws/scratchpad', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newScratchpadName.value.trim(),
        agent: newScratchpadAgent.value,
        panels: [...newScratchpadPanels],
        links: normalizedLinkRefs(newScratchpadLinks.value),
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

function showLinkList(issues) {
  editingLinks = false;
  linkInput.disabled = false;
  linkInput.hidden = true;
  detail.links.hidden = false;
  linkEditor.classList.remove('editing');
  renderLinks(issues);
}

function beginLinkEditing() {
  if (editingLinks || savingLinks || !selectedSession || selectedSession.type === 'misc') return;
  originalLinkRefs = selectedSession.issues.map((issue) => issue.ref);
  linkInput.value = originalLinkRefs.join('\n');
  editingLinks = true;
  detail.links.hidden = true;
  linkInput.hidden = false;
  linkEditor.classList.add('editing');
  linkInput.focus();
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

async function saveAssociatedLinks() {
  if (!editingLinks || savingLinks || !selectedSession) return;
  const id = selectedSession.id;
  const nextRefs = normalizedLinkRefs(linkInput.value);
  const additions = nextRefs.filter((ref) => !originalLinkRefs.includes(ref));
  const removals = originalLinkRefs.filter((ref) => !nextRefs.includes(ref));
  editingLinks = false;
  savingLinks = true;
  linkInput.disabled = true;
  modalError.hidden = true;
  try {
    if (additions.length) await postWorkstreamCommand(id, 'issue-add', { refs: additions });
    for (const ref of removals) await postWorkstreamCommand(id, 'issue-remove', { ref });
    savingLinks = false;
    showLinkList(nextRefs.map((ref) => ({ ref })));
    await refresh();
    if (modal.open && selectedSession && String(selectedSession.id) === String(id)) {
      await openSession(id);
    }
  } catch (cause) {
    savingLinks = false;
    editingLinks = true;
    linkInput.disabled = false;
    linkInput.hidden = false;
    detail.links.hidden = true;
    modalError.textContent = cause.message;
    modalError.hidden = false;
    if (modal.open) linkInput.focus();
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
    button.setAttribute('aria-pressed', String(enabled));
    button.textContent = `${panel[0].toUpperCase()}${panel.slice(1)}: ${enabled ? 'on' : 'off'}`;
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
  agentSelect.value = item.agent === 'codex' ? 'codex' : 'claude';
  agentSelect.disabled = busy;
}

function renderDetails(item, busy = false) {
  selectedSession = item;
  detail.title.textContent = `${item.id}: ${item.name || item.branch}`;
  detail.status.textContent = item.status;
  detail.status.className = `status-pill status-${String(item.status).replace(/[^a-z_-]/g, '')}`;
  detail.branch.textContent = item.branch;
  const branchState = branchIconState(item);
  detail['branch-icon'].className = `branch-icon ${branchState.className}`;
  detail['branch-icon'].setAttribute('aria-label', branchState.label);
  detail['branch-icon'].title = branchState.label;
  detail.source.textContent = item.source || '—';
  detail.path.textContent = item.path;
  detail.path.setAttribute('aria-label', `Open directory ${item.path}`);
  detail.path.title = 'Open this directory';
  detail['path-presence'].textContent = item.worktreePresent ? '✓' : '✕';
  detail['path-presence'].className = `path-presence ${item.worktreePresent ? 'path-present' : 'path-missing'}`;
  detail['path-presence'].setAttribute('aria-label', item.worktreePresent ? 'Directory exists' : 'Directory missing');
  detail['path-presence'].title = item.worktreePresent ? 'Directory exists' : 'Directory missing';
  detail.created.textContent = timestamp(item.createdAt);
  detail['last-joined'].textContent = timestamp(item.lastJoined);
  detail['repo-row'].hidden = !item.repoUrl;
  if (item.repoUrl) {
    detail.repo.href = item.repoUrl;
    detail.repo.textContent = item.repo;
  } else {
    detail.repo.removeAttribute('href');
    detail.repo.textContent = '';
  }
  renderStack(item);
  if (!editingLinks && !savingLinks) showLinkList(item.issues);
  const linksAvailable = item.type !== 'misc';
  linkEditor.tabIndex = linksAvailable ? 0 : -1;
  linkEditor.setAttribute('aria-disabled', String(!linksAvailable));
  linkNote.textContent = linksAvailable
    ? 'Click the area to edit; changes save when focus leaves it.'
    : 'Associated links are unavailable for configured locations.';
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
      body: '{}',
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

async function setAgent() {
  if (!selectedSession) return;
  const id = selectedSession.id;
  const agent = agentSelect.value;
  modalError.hidden = true;
  updateActions(selectedSession, true);
  updatePanelToggles(selectedSession, true);
  updateAgentSelect(selectedSession, true);
  try {
    await postWorkstreamCommand(id, 'agent-set', { agent });
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
    if (!message || !['new_session', 'update_session', 'agent_status'].includes(message.type)) return;
    refresh();
    if (modal.open && selectedSession && !editingLinks && !savingLinks
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
  if (editingLinks) saveAssociatedLinks();
  const closedFromHistory = closingModalFromHistory;
  closingModalFromHistory = false;
  selectedSession = null;
  if (!closedFromHistory) clearSessionUrl();
});
newRepoButton.addEventListener('click', openNewRepoModal);
newRepoDismiss.addEventListener('click', () => newRepoModal.close());
newRepoCancel.addEventListener('click', () => newRepoModal.close());
newRepoForm.addEventListener('submit', createNewRepoSession);
newRepoRepository.addEventListener('input', updateNewRepoPreview);
newRepoSelector.addEventListener('input', updateNewRepoPreview);
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
newScratchpadModal.addEventListener('click', (event) => {
  if (event.target === newScratchpadModal && !newScratchpadSubmit.disabled) newScratchpadModal.close();
});
newScratchpadModal.addEventListener('cancel', (event) => {
  if (newScratchpadSubmit.disabled) event.preventDefault();
});
for (const button of newScratchpadPanelButtons) {
  button.addEventListener('click', () => toggleNewScratchpadPanel(button.dataset.panel));
}
linkEditor.addEventListener('click', (event) => {
  if (event.target.closest('a')) return;
  beginLinkEditing();
});
linkEditor.addEventListener('keydown', (event) => {
  if (event.target !== linkEditor || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  beginLinkEditing();
});
linkInput.addEventListener('blur', saveAssociatedLinks);
detail.path.addEventListener('click', openSelectedPath);
agentSelect.addEventListener('change', setAgent);

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
