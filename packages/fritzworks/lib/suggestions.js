import { execFile } from 'node:child_process';

import { CONFIG } from './config.js';

function command(run, program, args) {
  return new Promise((resolve, reject) => {
    run(program, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 20_000 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || '').trim();
          reject(new Error(`${program} autocomplete failed${detail ? `: ${detail}` : `: ${error.message}`}`));
          return;
        }
        resolve(String(stdout || '').trim());
      });
  });
}

async function jsonCommand(run, program, args) {
  const output = await command(run, program, args);
  try { return JSON.parse(output); }
  catch { throw new Error(`${program} autocomplete returned invalid JSON`); }
}

export async function linearWorkSuggestions({ run = execFile, reference = new Date(), config = CONFIG } = {}) {
  const source = config.suggestions?.linear;
  if (!source?.enabled) return [];
  const timestamp = new Date(reference);
  if (Number.isNaN(timestamp.valueOf())) throw new Error('invalid Linear autocomplete reference date');
  const query = `{
    viewer { id name }
    cycles(first: 5, filter: {
      startsAt: { lte: "${timestamp.toISOString()}" }
      endsAt: { gte: "${timestamp.toISOString()}" }
      team: { key: { eq: ${JSON.stringify(source.team)} } }
    }) {
      nodes {
        issues(first: 100, filter: {
          state: { type: { nin: ["completed", "cancelled"] } }
        }) {
          nodes {
            identifier title url priority updatedAt
            state { name }
            assignee { id name }
          }
        }
      }
    }
  }`;
  const response = await jsonCommand(run, 'linear', ['api', query]);
  const viewer = response?.data?.viewer;
  const issues = response?.data?.cycles?.nodes?.[0]?.issues?.nodes || [];
  return issues
    .filter((issue) => !issue.assignee || issue.assignee.id === viewer?.id)
    .sort((left, right) => {
      const assignment = Number(!left.assignee) - Number(!right.assignee);
      if (assignment) return assignment;
      const leftPriority = left.priority || 99;
      const rightPriority = right.priority || 99;
      return leftPriority - rightPriority || String(right.updatedAt).localeCompare(String(left.updatedAt));
    })
    .slice(0, 20)
    .map((issue) => ({
      provider: 'linear',
      id: issue.identifier,
      title: issue.title,
      url: issue.url,
      group: `Current ${source.team} cycle`,
      meta: `${issue.state?.name || 'Unknown'} · ${issue.assignee?.name || 'unassigned'}`,
      updatedAt: issue.updatedAt || null,
    }));
}

export async function linearSearchSuggestions(query, { run = execFile, config = CONFIG } = {}) {
  const source = config.suggestions?.linear;
  if (!source?.enabled) return [];
  const search = String(query || '').trim();
  if (!search) return [];
  const response = await jsonCommand(run, 'linear', [
    'issue', 'query', '--search', search, '--team', source.team,
    '--state', 'triage', '--state', 'backlog', '--state', 'unstarted', '--state', 'started',
    '--limit', '20', '--json', '--no-pager',
  ]);
  return (response?.nodes || []).map((issue) => ({
    provider: 'linear',
    id: issue.identifier,
    title: issue.title,
    url: issue.url,
    group: 'Linear search',
    meta: [
      issue.state?.name || 'Unknown',
      issue.assignee?.name || 'unassigned',
      issue.project?.name,
    ].filter(Boolean).join(' · '),
    updatedAt: issue.updatedAt || null,
  }));
}

function githubSuggestion(item, repository, kind, group, meta) {
  return {
    provider: 'github',
    id: `${repository.split('/').at(-1)}#${item.number}`,
    title: item.title,
    url: item.url,
    group,
    meta,
    repository,
    number: item.number,
    kind,
    updatedAt: item.updatedAt || null,
  };
}

export async function githubWorkSuggestions({ run = execFile, config = CONFIG } = {}) {
  const source = config.suggestions?.github;
  if (!source?.enabled || (!source.issueRepository && !source.reviewRepositories.length)) return [];
  const { issueRepository, issueLabel, reviewRepositories } = source;
  const teammates = new Set(source.teammates);
  const login = await command(run, 'gh', ['api', 'user', '--jq', '.login']);
  const fields = 'number,title,url,updatedAt,assignees,labels';
  const [byLabel, byInvolvement, ...reviewResults] = await Promise.all([
    issueRepository && issueLabel ? jsonCommand(run, 'gh', [
      'search', 'issues', '--repo', issueRepository, '--state', 'open', '--label', issueLabel,
      '--include-prs=false', '--limit', '200', '--json', fields,
    ]) : [],
    issueRepository ? jsonCommand(run, 'gh', [
      'search', 'issues', '--repo', issueRepository, '--state', 'open', '--involves', login,
      '--include-prs=false', '--limit', '200', '--json', fields,
    ]) : [],
    ...reviewRepositories.map((repository) => jsonCommand(run, 'gh', [
      'search', 'prs', '--repo', repository, '--state', 'open', '--draft=false', '--review', 'required',
      '--sort', 'created', '--order', 'desc', '--limit', '100',
      '--json', 'number,title,url,createdAt,updatedAt,author',
    ])),
  ]);

  const escalations = new Map();
  for (const issue of [...byLabel, ...byInvolvement]) escalations.set(issue.number, issue);
  const suggestions = [...escalations.values()]
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, 20)
    .map((issue) => {
      const assigned = (issue.assignees || []).some((assignee) => assignee.login === login);
      const javascript = (issue.labels || []).some((label) => label.name === issueLabel);
      const flags = [assigned ? 'assigned' : null, javascript ? issueLabel : null].filter(Boolean);
      return githubSuggestion(
        issue, issueRepository, 'issue', `${issueRepository.split('/').at(-1)} issues`,
        ['Issue', ...flags].join(' · '),
      );
    });
  for (const [index, pulls] of reviewResults.entries()) {
    const repository = reviewRepositories[index];
    suggestions.push(...pulls
      .sort((left, right) => {
        const teammate = Number(!teammates.has(left.author?.login)) - Number(!teammates.has(right.author?.login));
        return teammate || String(right.createdAt).localeCompare(String(left.createdAt));
      })
      .slice(0, 20)
      .map((pull) => githubSuggestion(
        pull, repository, 'pull_request', `${repository.split('/').at(-1)} PRs`,
        `PR by @${pull.author?.login || 'unknown'}${teammates.has(pull.author?.login) ? ' · teammate' : ''}`,
      )));
  }
  return suggestions;
}
