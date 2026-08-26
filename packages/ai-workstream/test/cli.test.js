import assert from 'node:assert/strict';
import test from 'node:test';

import { VERSION, usageText } from '../cli.js';
import { CONFIG } from '../lib/config.js';

test('CLI exposes help, version, and resolved configuration without running on import', () => {
  const help = usageText();
  assert.match(help, /AI workstream manager/);
  assert.match(help, /--agent claude\|codex/);
  assert.equal(VERSION, '1.0.0');
  assert.ok(CONFIG.defaultConfigPath.endsWith('/ai-workstream/config.ini'));
  assert.ok(CONFIG.configPath.endsWith('/ai-workstream/config.ini'));
  assert.deepEqual(CONFIG.panels, ['shell', 'editor', 'agent']);
});
