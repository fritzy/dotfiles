import assert from 'node:assert/strict';
import test from 'node:test';

import { githubPullRequestUrl } from '../lib/github-pr-url.js';
import { readGithubPullRequest } from '../lib/github-pr.js';

test('PR URLs normalize tabs and fragments and reject unrelated links and command input', () => {
  const url = 'https://github.com/org/repo/pull/123';
  for (const suffix of ['', '/', '/files', '/commits?x=1', '#issuecomment-123']) {
    assert.equal(githubPullRequestUrl(url + suffix), url);
  }
  for (const value of ['--help', '$(whoami)', 'https://github.com/org/repo/issues/123',
    'https://github.com.evil.test/org/repo/pull/123', 'https://user@github.com/org/repo/pull/123',
    'https://github.com/org/repo/pull/0', 'http://github.com/org/repo/pull/1']) {
    assert.equal(githubPullRequestUrl(value), null);
  }
});

test('PR reader retrieves structured body and conversation and reports CLI failures', async () => {
  const url = 'https://github.com/org/repo/pull/123';
  const pr = { title: 'Test', body: '# Description', comments: [{ body: 'Feedback' }] };
  const result = await readGithubPullRequest(url + '/files', {
    run(program, args, options, callback) {
      assert.equal(program, 'gh');
      assert.deepEqual(args.slice(0, 5), ['pr', 'view', url, '--json', 'number,title,body,author,state,isDraft,url,createdAt,comments']);
      assert.ok(options.timeout > 0);
      callback(null, JSON.stringify(pr), '');
    },
  });
  assert.deepEqual(result, { ...pr, url });
  await assert.rejects(readGithubPullRequest('--help'), /expected a GitHub/);
  await assert.rejects(readGithubPullRequest(url, {
    run: (_program, _args, _options, callback) => callback(new Error('exit 1'), '', 'Please run gh auth login'),
  }), /gh auth login/);
  await assert.rejects(readGithubPullRequest(url, {
    run: (_program, _args, _options, callback) => callback(null, 'not json'),
  }), /invalid JSON/);
});
