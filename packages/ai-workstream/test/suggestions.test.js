import assert from 'node:assert/strict';
import test from 'node:test';

import {
  githubWorkSuggestions,
  linearSearchSuggestions,
  linearWorkSuggestions,
} from '../lib/suggestions.js';

function runner(handler) {
  return (program, args, _options, callback) => {
    try {
      const result = handler(program, args);
      callback(null, typeof result === 'string' ? result : JSON.stringify(result), '');
    } catch (error) {
      callback(error, '', error.message);
    }
  };
}

test('Linear suggestions include current-cycle work assigned to the viewer or unassigned', async () => {
  const calls = [];
  const run = runner((program, args) => {
    calls.push([program, args]);
    return {
      data: {
        viewer: { id: 'viewer-1', name: 'Nathan' },
        cycles: {
          nodes: [{
            issues: {
              nodes: [
                {
                  identifier: 'ECO-3', title: 'Unassigned high priority', url: 'https://linear.app/acme/issue/ECO-3',
                  priority: 2, updatedAt: '2026-08-25T00:00:00.000Z', state: { name: 'Todo' }, assignee: null,
                },
                {
                  identifier: 'ECO-2', title: 'My medium priority issue', url: 'https://linear.app/acme/issue/ECO-2',
                  priority: 3, updatedAt: '2026-08-24T00:00:00.000Z', state: { name: 'In Progress' },
                  assignee: { id: 'viewer-1', name: 'Nathan' },
                },
                {
                  identifier: 'ECO-1', title: 'Someone else owns this', url: 'https://linear.app/acme/issue/ECO-1',
                  priority: 1, updatedAt: '2026-08-26T00:00:00.000Z', state: { name: 'Todo' },
                  assignee: { id: 'viewer-2', name: 'Other' },
                },
              ],
            },
          }],
        },
      },
    };
  });

  const suggestions = await linearWorkSuggestions({
    run,
    reference: new Date('2026-08-27T12:00:00.000Z'),
  });

  assert.deepEqual(suggestions.map((item) => item.id), ['ECO-2', 'ECO-3']);
  assert.equal(suggestions[0].group, 'Current ECO cycle');
  assert.equal(suggestions[0].meta, 'In Progress · Nathan');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'linear');
  assert.equal(calls[0][1][0], 'api');
  assert.match(calls[0][1][1], /team: \{ key: \{ eq: "ECO" \} \}/);
});

test('typed Linear search finds active ECO issues outside the current cycle', async () => {
  const calls = [];
  const run = runner((program, args) => {
    calls.push([program, args]);
    return {
      nodes: [{
        identifier: 'ECO-3380',
        title: 'Update project description — Migrate the .JS rebuilder onto the shared Axlotl pipeline',
        url: 'https://linear.app/chainguard/issue/ECO-3380/update-project-description-migrate-the-js-rebuilder-onto-the-shared',
        updatedAt: '2026-08-06T19:55:30.084Z',
        state: { name: 'Triage' },
        assignee: { name: 'Nathan Fritz' },
        project: { name: 'Migrate the .JS rebuilder onto the shared Axlotl pipeline' },
      }],
    };
  });

  const suggestions = await linearSearchSuggestions('axlotl', { run });

  assert.deepEqual(suggestions.map((item) => item.id), ['ECO-3380']);
  assert.equal(suggestions[0].group, 'Linear search');
  assert.match(suggestions[0].meta, /Triage · Nathan Fritz/);
  assert.deepEqual(calls[0][1].slice(0, 6), [
    'issue', 'query', '--search', 'axlotl', '--team', 'ECO',
  ]);
  assert.ok(calls[0][1].includes('--state'));
});

test('GitHub suggestions combine customer escalations and review-required PRs in both work repos', async () => {
  const calls = [];
  const run = runner((program, args) => {
    calls.push([program, args]);
    if (args[0] === 'api' && args[1] === 'user') return 'fritzy';
    if (args[0] === 'search' && args[1] === 'issues' && args.includes('--label')) {
      return [
        {
          number: 11, title: 'JavaScript escalation', url: 'https://github.com/chainguard-dev/customer-issues/issues/11',
          updatedAt: '2026-08-25T00:00:00.000Z', assignees: [{ login: 'fritzy' }],
          labels: [{ name: 'eng:ecosystems:javascript' }],
        },
      ];
    }
    if (args[0] === 'search' && args[1] === 'issues' && args.includes('--involves')) {
      return [
        {
          number: 11, title: 'JavaScript escalation', url: 'https://github.com/chainguard-dev/customer-issues/issues/11',
          updatedAt: '2026-08-25T00:00:00.000Z', assignees: [{ login: 'fritzy' }],
          labels: [{ name: 'eng:ecosystems:javascript' }],
        },
        {
          number: 12, title: 'Mentioned escalation', url: 'https://github.com/chainguard-dev/customer-issues/issues/12',
          updatedAt: '2026-08-26T00:00:00.000Z', assignees: [], labels: [],
        },
      ];
    }
    if (args[0] === 'search' && args[1] === 'prs') {
      const repository = args[args.indexOf('--repo') + 1];
      if (repository === 'chainguard-dev/mono') {
        return [
          {
            number: 21, title: 'Newest outside PR', url: 'https://github.com/chainguard-dev/mono/pull/21',
            createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
            author: { login: 'outside' },
          },
          {
            number: 20, title: 'Teammate PR', url: 'https://github.com/chainguard-dev/mono/pull/20',
            createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
            author: { login: 'indexzero' },
          },
        ];
      }
      return [{
        number: 31, title: 'Rebuilder PR', url: 'https://github.com/chainguard-dev/ecosystems-rebuilder.js/pull/31',
        createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
        author: { login: 'jumoel' },
      }];
    }
    throw new Error(`unexpected command: ${program} ${args.join(' ')}`);
  });

  const suggestions = await githubWorkSuggestions({ run });

  assert.deepEqual(suggestions.map((item) => item.id), [
    'customer-issues#12', 'customer-issues#11',
    'mono#20', 'mono#21',
    'ecosystems-rebuilder.js#31',
  ]);
  assert.equal(suggestions[1].meta, 'Customer escalation · assigned · javascript');
  assert.equal(suggestions[2].meta, 'PR by @indexzero · teammate');
  assert.deepEqual([...new Set(suggestions.map((item) => item.group))], [
    'Customer escalations', 'mono PRs', 'ecosystems-rebuilder.js PRs',
  ]);
  assert.equal(calls.filter(([, args]) => args[0] === 'search' && args[1] === 'prs').length, 2);
});
