export function linkFor(ref) {
  try {
    const url = new URL(ref);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function issueLink(ref) {
  const href = linkFor(ref);
  if (!href) return null;
  const url = new URL(href);
  const github = url.hostname.toLowerCase() === 'github.com'
    ? url.pathname.match(/^\/[^/]+\/[^/]+\/(?:issues|pull)\/(\d+)(?:\/|$)/)
    : null;
  if (github) return { href, label: `#${github[1]}`, icon: 'github', provider: 'GitHub' };
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

export function githubBranchUrl(item) {
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

export function timestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function daysSince(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return {
    days: Math.floor(Math.max(0, Date.now() - date.valueOf()) / 86_400_000),
    exact: date.toLocaleString(),
  };
}

function lastUsedTime(item) {
  const value = Date.parse(item.lastJoined || '');
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

export function groupActiveSessionsByRepo(items) {
  const ordered = [...items]
    .filter((item) => item.status === 'active' || item.status === 'paused')
    .sort((left, right) => {
      const leftTime = lastUsedTime(left);
      const rightTime = lastUsedTime(right);
      if (rightTime !== leftTime) return rightTime > leftTime ? 1 : -1;
      return String(right.id).localeCompare(String(left.id), undefined, { numeric: true });
    });
  const groups = new Map();
  for (const item of ordered) {
    const label = item.type === 'scratchpad' ? 'Scratchpads' : item.repo || 'Other';
    if (!groups.has(label)) groups.set(label, { label, items: [] });
    groups.get(label).items.push(item);
  }
  return [...groups.values()];
}

export function opticalPillPadding(label) {
  const text = String(label ?? '').trim();
  return text && !/[gjpqy]/.test(text) ? 'pt-[5px] pb-[3px]' : 'py-1';
}

export function branchState(item) {
  if (item.type === 'scratchpad') {
    return { icon: 'folder', color: 'text-primary', label: 'Scratchpad directory' };
  }
  if (item.prDone === true) {
    return { icon: 'check', color: 'text-success', label: 'Pull request is closed or merged' };
  }
  if (item.gitClean === true) {
    return { icon: 'git-branch', color: 'text-success', label: 'Git worktree is clean' };
  }
  if (item.gitClean === false) {
    return { icon: 'git-branch', color: 'text-danger', label: 'Git worktree has changes' };
  }
  return { icon: 'git-branch', color: 'text-muted', label: 'Git status unavailable' };
}

export function visiblePages(pageCount, page) {
  const visible = new Set([0, pageCount - 1]);
  for (let candidate = page - 2; candidate <= page + 2; candidate += 1) {
    if (candidate >= 0 && candidate < pageCount) visible.add(candidate);
  }
  if (page < 4) {
    for (let candidate = 0; candidate < Math.min(5, pageCount); candidate += 1) visible.add(candidate);
  }
  if (page > pageCount - 5) {
    for (let candidate = Math.max(0, pageCount - 5); candidate < pageCount; candidate += 1) {
      visible.add(candidate);
    }
  }
  return [...visible].sort((left, right) => left - right);
}

export function repoSelectorPreview(selector) {
  const pr = selector.match(/^#?(\d+)$/);
  if (pr) return { source: `pr:${pr[1]}`, branch: null };
  if (selector.includes(':')) {
    const [owner, branch] = selector.split(':');
    if (owner && branch) return { source: `fork:${owner}`, branch };
  }
  return selector ? { source: 'origin', branch: selector } : { source: null, branch: null };
}

export function scratchpadSlug(value) {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function stackDescription(item) {
  const parts = [];
  if (item.stackedOn) parts.push(`on #${item.stackedOn.id} (${item.stackedOn.branch})`);
  if (item.stackedBy?.length) {
    parts.push(`followed by ${item.stackedBy.map((row) => `#${row.id} (${row.branch})`).join(', ')}`);
  }
  return parts.join('; ') || '—';
}
