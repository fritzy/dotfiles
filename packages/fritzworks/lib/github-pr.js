import { execFile } from 'node:child_process';

import { githubPullRequestUrl } from './github-pr-url.js';

export async function readGithubPullRequest(value, { run = execFile } = {}) {
  const url = githubPullRequestUrl(value);
  if (!url) throw new Error('expected a GitHub pull request URL');
  const stdout = await new Promise((resolve, reject) => {
    run('gh', ['pr', 'view', url, '--json', 'number,title,body,author,state,isDraft,url,createdAt,comments'], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    }, (error, output, stderr) => {
      if (error) {
        reject(new Error(`Unable to load pull request: ${String(stderr || '').trim() || error.message}`));
      } else {
        resolve(output);
      }
    });
  });
  let pr;
  try { pr = JSON.parse(stdout); }
  catch { throw new Error('GitHub CLI returned invalid JSON'); }
  if (!pr || typeof pr.title !== 'string' || !Array.isArray(pr.comments)) {
    throw new Error('GitHub CLI returned an invalid pull request');
  }
  return { ...pr, url };
}
