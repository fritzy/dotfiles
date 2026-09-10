import assert from 'node:assert/strict';
import test from 'node:test';

import { creationRequestBody, VERSION, usageText } from '../cli.js';
import { CONFIG } from '../lib/config.js';

test('CLI exposes help, version, and resolved configuration without running on import', () => {
  const help = usageText();
  assert.match(help, /FritzWorks CLI/);
  assert.match(help, /--agent claude\|codex/);
  assert.match(help, /ws daemon \[start\|stop\|restart\|status\|foreground\|log]/);
  assert.match(help, /ws web start/);
  assert.match(help, /ws refresh/);
  assert.match(help, /ws archive \[id\|branch\]/);
  assert.match(help, /--link <ref>/);
  assert.match(help, /aliases: close, rm/);
  assert.match(help, /ws hooks \[install\|status]/);
  assert.doesNotMatch(help, /--model/);
  assert.doesNotMatch(help, /open-shell/);
  assert.equal(VERSION, '1.0.0');
  assert.ok(CONFIG.defaultConfigPath.endsWith('/ai-workstream/config.ini'));
  assert.ok(CONFIG.configPath.endsWith('/ai-workstream/config.ini'));
  assert.equal(CONFIG.panels, undefined);
});

test('creation options collect repeatable associated links', () => {
  assert.deepEqual(creationRequestBody([
    '--agent', 'codex',
    '--link', 'ECO-123',
    '--link=https://github.com/example/project/issues/456',
  ], { repository: 'example/project', selector: 'feature' }), {
    repository: 'example/project',
    selector: 'feature',
    links: ['ECO-123', 'https://github.com/example/project/issues/456'],
    agent: 'codex',
  });

  assert.throws(() => creationRequestBody(['--link']), /--link requires a value/);
  assert.throws(() => creationRequestBody(['--link=']), /--link requires a value/);
});
