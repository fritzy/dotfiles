import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const PANEL_GROUP_TYPES = ['repository', 'scratchpad', 'configured', 'terminal'];
export const PANEL_KINDS = ['terminal', 'ai', 'markdown', 'iframe'];
export const RESOURCE_KINDS = ['link', 'markdown'];
export const RESOURCE_SOURCES = ['explicit', 'legacy', 'discovered'];
export const PANEL_LAYOUT_VERSION = 1;

const DEFAULT_PANEL_WIDTH = 1;
const MAX_LABEL_LENGTH = 160;

export class PanelModelError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const timestamp = () => new Date().toISOString();
const cleanLabel = (value, fallback) => {
  const label = typeof value === 'string' ? value.trim().slice(0, MAX_LABEL_LENGTH) : '';
  return label || fallback;
};
const bool = (value) => Boolean(Number(value));
const stableId = (prefix, value) => {
  const digest = createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
  return `${prefix}-${digest}`;
};
const generatedId = (prefix) => `${prefix}-${randomUUID()}`;

export function initializePanelSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS panel_groups (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('repository', 'scratchpad', 'configured', 'terminal')),
      owner_id TEXT,
      label TEXT NOT NULL,
      path TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(type, owner_id)
    );

    CREATE TABLE IF NOT EXISTS resource_associations (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES panel_groups(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('link', 'markdown')),
      value TEXT NOT NULL,
      label TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'explicit' CHECK(source IN ('explicit', 'legacy', 'discovered')),
      created_at TEXT NOT NULL,
      UNIQUE(group_id, kind, value)
    );

    CREATE TABLE IF NOT EXISTS panels (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES panel_groups(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('terminal', 'ai', 'markdown', 'iframe')),
      minimized INTEGER NOT NULL DEFAULT 0 CHECK(minimized IN (0, 1)),
      width REAL NOT NULL DEFAULT 1 CHECK(width > 0),
      label TEXT NOT NULL,
      terminal_role TEXT CHECK(terminal_role IN ('shell', 'editor', 'agent')),
      legacy_terminal INTEGER NOT NULL DEFAULT 0 CHECK(legacy_terminal IN (0, 1)),
      markdown_mode TEXT CHECK(markdown_mode IN ('edit', 'preview')),
      resource_id TEXT REFERENCES resource_associations(id) ON DELETE CASCADE,
      font_size INTEGER NOT NULL DEFAULT 14 CHECK(font_size BETWEEN 10 AND 24),
      created_at TEXT NOT NULL,
      UNIQUE(group_id, position),
      UNIQUE(group_id, resource_id)
    );

    CREATE TABLE IF NOT EXISTS panel_layout_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      active_group_id TEXT REFERENCES panel_groups(id) ON DELETE SET NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS panel_migrations (
      name TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL
    );

    INSERT OR IGNORE INTO panel_layout_state (singleton, active_group_id, revision, updated_at)
    VALUES (1, NULL, 0, CURRENT_TIMESTAMP);

    CREATE INDEX IF NOT EXISTS panels_group_position ON panels(group_id, position);
    CREATE UNIQUE INDEX IF NOT EXISTS panels_one_ai_per_group ON panels(group_id) WHERE kind='ai';
    CREATE INDEX IF NOT EXISTS resources_group_kind ON resource_associations(group_id, kind);
    CREATE INDEX IF NOT EXISTS panel_groups_owner ON panel_groups(owner_id);
  `);
}

export const panelLayoutRevision = (db) => Number(
  db.prepare('SELECT revision FROM panel_layout_state WHERE singleton=1').get()?.revision || 0,
);

function requireRevision(db, expectedRevision) {
  const current = panelLayoutRevision(db);
  if (!Number.isInteger(expectedRevision)) {
    throw new PanelModelError(400, 'revision must be an integer');
  }
  if (expectedRevision !== current) {
    throw new PanelModelError(409, 'panel layout changed on another client', { revision: current });
  }
  return current;
}

function bumpRevision(db, reference = timestamp()) {
  db.prepare(`
    UPDATE panel_layout_state
    SET revision=revision+1, updated_at=?
    WHERE singleton=1
  `).run(reference);
  return panelLayoutRevision(db);
}

export function mutatePanelLayout(db, expectedRevision, change, { now = timestamp } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    requireRevision(db, expectedRevision);
    const result = change();
    const revision = bumpRevision(db, now());
    db.exec('COMMIT');
    return { ...result, revision };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
    throw error;
  }
}

function groupRow(db, id) {
  const row = db.prepare('SELECT * FROM panel_groups WHERE id=?').get(String(id));
  if (!row) throw new PanelModelError(404, `no panel group "${id}"`);
  return row;
}

function panelRow(db, id) {
  const row = db.prepare('SELECT * FROM panels WHERE id=?').get(String(id));
  if (!row) throw new PanelModelError(404, `no panel "${id}"`);
  return row;
}

function resourceRow(db, id) {
  const row = db.prepare('SELECT * FROM resource_associations WHERE id=?').get(String(id));
  if (!row) throw new PanelModelError(404, `no associated resource "${id}"`);
  return row;
}

export const sessionGroupId = (ownerId, type = 'repository') => stableId('session', `${type}:${ownerId}`);

function insertGroup(db, {
  id = generatedId('group'), type, ownerId = null, label, path = null, createdAt = timestamp(),
}) {
  if (!PANEL_GROUP_TYPES.includes(type)) throw new PanelModelError(400, `group type must be one of: ${PANEL_GROUP_TYPES.join(', ')}`);
  db.prepare(`
    INSERT INTO panel_groups (id, type, owner_id, label, path, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, type, ownerId == null ? null : String(ownerId), cleanLabel(label, 'Untitled group'), path, createdAt);
  return db.prepare('SELECT * FROM panel_groups WHERE id=?').get(id);
}

function insertPanel(db, {
  id = generatedId('panel'), groupId, position, kind, minimized = false,
  width = DEFAULT_PANEL_WIDTH, label, terminalRole = null, legacyTerminal = false,
  markdownMode = null, resourceId = null, fontSize = 14, createdAt = timestamp(),
}) {
  db.prepare(`
    INSERT INTO panels (
      id, group_id, position, kind, minimized, width, label, terminal_role,
      legacy_terminal, markdown_mode, resource_id, font_size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, groupId, position, kind, minimized ? 1 : 0, Number(width) || DEFAULT_PANEL_WIDTH,
    cleanLabel(label, kind === 'ai' ? 'AI' : kind === 'terminal' ? 'Terminal' : 'Resource'),
    terminalRole, legacyTerminal ? 1 : 0, markdownMode, resourceId,
    Math.max(10, Math.min(24, Number(fontSize) || 14)), createdAt,
  );
  return db.prepare('SELECT * FROM panels WHERE id=?').get(id);
}

function ensureDefaultPanels(db, group, roles = ['shell', 'agent']) {
  let changed = false;
  let count = Number(db.prepare('SELECT COUNT(*) AS count FROM panels WHERE group_id=?').get(group.id).count);
  for (const role of roles) {
    if (role === 'agent' && db.prepare("SELECT 1 FROM panels WHERE group_id=? AND kind='ai'").get(group.id)) continue;
    if (db.prepare('SELECT 1 FROM panels WHERE group_id=? AND legacy_terminal=1 AND terminal_role=?').get(group.id, role)) continue;
    insertPanel(db, {
      id: stableId('panel', `${group.id}:${role}`),
      groupId: group.id,
      position: count++,
      kind: role === 'agent' ? 'ai' : 'terminal',
      label: role === 'agent' ? 'AI' : role === 'editor' ? 'Editor' : 'Shell',
      terminalRole: role,
      legacyTerminal: true,
    });
    changed = true;
  }
  if (changed) {
    const roleOrder = new Map(roles.map((role, index) => [role, index]));
    const ordered = db.prepare('SELECT * FROM panels WHERE group_id=? ORDER BY position').all(group.id)
      .sort((left, right) => {
        const leftOrder = left.legacy_terminal ? roleOrder.get(left.terminal_role) : undefined;
        const rightOrder = right.legacy_terminal ? roleOrder.get(right.terminal_role) : undefined;
        if (leftOrder !== undefined || rightOrder !== undefined) {
          if (leftOrder === undefined) return 1;
          if (rightOrder === undefined) return -1;
          return leftOrder - rightOrder;
        }
        return left.position - right.position;
      });
    ordered.forEach((panel, index) => db.prepare('UPDATE panels SET position=? WHERE id=?').run(-index - 1, panel.id));
    ordered.forEach((panel, index) => db.prepare('UPDATE panels SET position=? WHERE id=?').run(index, panel.id));
  }
  return changed;
}

export function ensureSessionPanelGroup(db, item, { roles = ['shell', 'agent'], bump = false } = {}) {
  const ownerId = String(item.id);
  const type = item.type === 'scratchpad' || item.source === 'scratch'
    ? 'scratchpad' : item.type === 'misc' || item.source === 'configured' ? 'configured' : 'repository';
  let group = db.prepare('SELECT * FROM panel_groups WHERE type=? AND owner_id=?').get(type, ownerId);
  let changed = false;
  if (!group) {
    group = insertGroup(db, {
      id: sessionGroupId(ownerId, type), type, ownerId,
      label: item.name || item.label || item.branch || ownerId,
      path: item.path || null,
    });
    changed = true;
  } else {
    const label = cleanLabel(item.name || item.label || item.branch, group.label);
    const path = item.path || group.path;
    if (label !== group.label || path !== group.path) {
      db.prepare('UPDATE panel_groups SET label=?, path=? WHERE id=?').run(label, path, group.id);
      group = { ...group, label, path };
      changed = true;
    }
  }
  if (ensureDefaultPanels(db, group, roles)) changed = true;
  if (changed && bump) bumpRevision(db);
  return { group, changed };
}

export function syncSessionPanelGroups(db, items, { bump = true } = {}) {
  let changed = false;
  for (const item of items || []) {
    const result = ensureSessionPanelGroup(db, item, { bump: false });
    changed ||= result.changed;
  }
  if (changed && bump) bumpRevision(db);
  return { changed, revision: panelLayoutRevision(db) };
}

function mapResource(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    kind: row.kind,
    value: row.value,
    label: row.label,
    source: row.source,
    discovered: row.source === 'discovered',
    disassociate: row.source !== 'discovered',
  };
}

function mapPanel(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    position: Number(row.position),
    kind: row.kind,
    minimized: bool(row.minimized),
    width: Number(row.width),
    label: row.label,
    terminalRole: row.terminal_role,
    legacyTerminal: bool(row.legacy_terminal),
    markdownMode: row.markdown_mode,
    resourceId: row.resource_id,
    fontSize: Number(row.font_size),
  };
}

export function readPanelLayout(db) {
  const state = db.prepare(`
    SELECT active_group_id, revision, updated_at FROM panel_layout_state WHERE singleton=1
  `).get();
  const groups = db.prepare('SELECT * FROM panel_groups ORDER BY created_at, id').all();
  const panels = db.prepare('SELECT * FROM panels ORDER BY group_id, position, id').all();
  const resources = db.prepare('SELECT * FROM resource_associations ORDER BY group_id, created_at, id').all();
  return {
    version: PANEL_LAYOUT_VERSION,
    revision: Number(state?.revision || 0),
    activeGroupId: state?.active_group_id || null,
    updatedAt: state?.updated_at || null,
    groups: groups.map((group) => ({
      id: group.id,
      type: group.type,
      ownerId: group.owner_id,
      label: group.label,
      path: group.path,
      panels: panels.filter((panel) => panel.group_id === group.id).map(mapPanel),
      resources: resources.filter((resource) => resource.group_id === group.id).map(mapResource),
    })),
  };
}

function validateGroupPanelKind(db, group, kind, resourceId = null) {
  if (!PANEL_KINDS.includes(kind)) throw new PanelModelError(400, `panel kind must be one of: ${PANEL_KINDS.join(', ')}`);
  if (group.type === 'terminal' && kind !== 'terminal') {
    throw new PanelModelError(400, 'terminal groups can contain terminal panels only');
  }
  if (kind === 'ai' && db.prepare("SELECT 1 FROM panels WHERE group_id=? AND kind='ai'").get(group.id)) {
    throw new PanelModelError(409, 'this group already has an AI panel');
  }
  if (kind === 'markdown' || kind === 'iframe') {
    if (!resourceId) throw new PanelModelError(400, `${kind} panels require an associated resource`);
    const resource = resourceRow(db, resourceId);
    if (resource.group_id !== group.id) throw new PanelModelError(400, 'resource belongs to a different panel group');
    const expected = kind === 'markdown' ? 'markdown' : 'link';
    if (resource.kind !== expected) throw new PanelModelError(400, `${kind} panels require a ${expected} resource`);
  }
}

export function createPanelGroup(db, body, expectedRevision) {
  return mutatePanelLayout(db, expectedRevision, () => {
    const type = body?.type || 'terminal';
    if (type !== 'terminal') throw new PanelModelError(400, 'session groups are created from workstreams');
    const labels = new Set(db.prepare("SELECT label FROM panel_groups WHERE type='terminal'").all().map((row) => row.label));
    let ordinal = 1;
    while (labels.has(`Terminal ${ordinal}`)) ordinal += 1;
    const defaultLabel = `Terminal ${ordinal}`;
    const group = insertGroup(db, {
      type, label: body?.label || defaultLabel, path: null,
    });
    const panel = insertPanel(db, {
      groupId: group.id, position: 0, kind: 'terminal', label: body?.panelLabel || defaultLabel,
    });
    if (body?.activate !== false) {
      db.prepare('UPDATE panel_layout_state SET active_group_id=? WHERE singleton=1').run(group.id);
    }
    return { groupId: group.id, panelId: panel.id };
  });
}

export function mergeTerminalGroups(db, sourceGroupId, destinationGroupId, expectedRevision) {
  return mutatePanelLayout(db, expectedRevision, () => {
    const source = groupRow(db, sourceGroupId);
    const destination = groupRow(db, destinationGroupId);
    if (source.id === destination.id) throw new PanelModelError(400, 'terminal groups must be different');
    if (source.type !== 'terminal' || destination.type !== 'terminal') {
      throw new PanelModelError(400, 'only terminal groups can be merged');
    }
    const destinationPosition = Number(db.prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM panels WHERE group_id=?',
    ).get(destination.id).position);
    const sourcePanels = db.prepare(
      'SELECT id FROM panels WHERE group_id=? ORDER BY position, id',
    ).all(source.id);
    const activeGroupId = db.prepare(
      'SELECT active_group_id FROM panel_layout_state WHERE singleton=1',
    ).get()?.active_group_id;
    sourcePanels.forEach((panel, index) => db.prepare(`
      UPDATE panels SET group_id=?, position=?, width=1 WHERE id=?
    `).run(destination.id, destinationPosition + index, panel.id));
    compactPositions(db, destination.id);
    db.prepare('UPDATE panels SET width=1 WHERE group_id=?').run(destination.id);
    db.prepare('DELETE FROM panel_groups WHERE id=?').run(source.id);
    if (activeGroupId === source.id) {
      db.prepare('UPDATE panel_layout_state SET active_group_id=? WHERE singleton=1').run(destination.id);
    }
    return {
      sourceGroupId: source.id,
      destinationGroupId: destination.id,
      panelIds: db.prepare(
        'SELECT id FROM panels WHERE group_id=? ORDER BY position, id',
      ).all(destination.id).map((panel) => panel.id),
    };
  });
}

export function activatePanelGroup(db, groupId, expectedRevision) {
  return mutatePanelLayout(db, expectedRevision, () => {
    groupRow(db, groupId);
    db.prepare('UPDATE panel_layout_state SET active_group_id=? WHERE singleton=1').run(String(groupId));
    return { activeGroupId: String(groupId) };
  });
}

export function updatePanelGroup(db, groupId, body, expectedRevision) {
  return mutatePanelLayout(db, expectedRevision, () => {
    const group = groupRow(db, groupId);
    if (group.type !== 'terminal') {
      throw new PanelModelError(400, 'only terminal groups can be renamed directly');
    }
    if (body?.label === undefined) {
      throw new PanelModelError(400, 'no supported panel group changes were provided');
    }
    const label = cleanLabel(body.label, group.label);
    db.prepare('UPDATE panel_groups SET label=? WHERE id=?').run(label, group.id);
    return {
      group: {
        id: group.id,
        type: group.type,
        ownerId: group.owner_id,
        label,
        path: group.path,
      },
    };
  });
}

export function deactivatePanelGroup(db, groupId, expectedRevision) {
  return mutatePanelLayout(db, expectedRevision, () => {
    const current = db.prepare('SELECT active_group_id FROM panel_layout_state WHERE singleton=1').get()?.active_group_id;
    if (current === String(groupId)) {
      db.prepare('UPDATE panel_layout_state SET active_group_id=NULL WHERE singleton=1').run();
    }
    return { activeGroupId: current === String(groupId) ? null : current || null };
  });
}

export function addPanel(db, groupId, body, expectedRevision) {
  return mutatePanelLayout(db, expectedRevision, () => {
    const group = groupRow(db, groupId);
    const kind = String(body?.kind || 'terminal');
    const resourceId = body?.resourceId == null ? null : String(body.resourceId);
    validateGroupPanelKind(db, group, kind, resourceId);
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM panels WHERE group_id=?').get(group.id).count);
    const role = kind === 'ai' ? 'agent'
      : kind === 'terminal' && group.owner_id != null ? 'shell' : null;
    const resource = resourceId ? resourceRow(db, resourceId) : null;
    const panel = insertPanel(db, {
      groupId: group.id,
      position: count,
      kind,
      minimized: body?.minimized === true,
      label: body?.label || resource?.label || (kind === 'ai' ? 'AI' : kind === 'terminal' ? `Terminal ${count + 1}` : 'Resource'),
      terminalRole: role,
      legacyTerminal: false,
      markdownMode: kind === 'markdown' ? (body?.markdownMode === 'preview' ? 'preview' : 'edit') : null,
      resourceId,
      fontSize: body?.fontSize,
    });
    db.prepare('UPDATE panels SET width=1 WHERE group_id=?').run(group.id);
    return { panel: mapPanel({ ...panel, width: 1 }) };
  });
}

export function updatePanel(db, panelId, body, expectedRevision) {
  return mutatePanelLayout(db, expectedRevision, () => {
    const panel = panelRow(db, panelId);
    const fields = [];
    const values = [];
    if (body?.minimized !== undefined) { fields.push('minimized=?'); values.push(body.minimized ? 1 : 0); }
    if (body?.width !== undefined) {
      const width = Number(body.width);
      if (!Number.isFinite(width) || width <= 0) throw new PanelModelError(400, 'panel width must be positive');
      fields.push('width=?'); values.push(width);
    }
    if (body?.label !== undefined) { fields.push('label=?'); values.push(cleanLabel(body.label, panel.label)); }
    if (body?.fontSize !== undefined) {
      const size = Number(body.fontSize);
      if (!Number.isInteger(size) || size < 10 || size > 24) throw new PanelModelError(400, 'font size must be from 10 to 24');
      fields.push('font_size=?'); values.push(size);
    }
    if (body?.markdownMode !== undefined) {
      if (panel.kind !== 'markdown' || !['edit', 'preview'].includes(body.markdownMode)) {
        throw new PanelModelError(400, 'markdown mode must be edit or preview on a Markdown panel');
      }
      fields.push('markdown_mode=?'); values.push(body.markdownMode);
    }
    if (!fields.length) throw new PanelModelError(400, 'no supported panel changes were provided');
    values.push(panel.id);
    db.prepare(`UPDATE panels SET ${fields.join(', ')} WHERE id=?`).run(...values);
    if (body?.minimized === false && bool(panel.minimized)) {
      db.prepare('UPDATE panels SET width=1 WHERE group_id=?').run(panel.group_id);
    }
    return { panel: mapPanel(panelRow(db, panel.id)) };
  });
}

function compactPositions(db, groupId) {
  const rows = db.prepare('SELECT id FROM panels WHERE group_id=? ORDER BY position, id').all(groupId);
  // Move out of the UNIQUE(group_id, position) range before assigning the final order.
  rows.forEach((row, index) => db.prepare('UPDATE panels SET position=? WHERE id=?').run(-index - 1, row.id));
  rows.forEach((row, index) => db.prepare('UPDATE panels SET position=? WHERE id=?').run(index, row.id));
}

export function removePanel(db, panelId, expectedRevision) {
  return mutatePanelLayout(db, expectedRevision, () => {
    const panel = panelRow(db, panelId);
    const group = groupRow(db, panel.group_id);
    db.prepare('DELETE FROM panels WHERE id=?').run(panel.id);
    const remaining = Number(db.prepare(
      'SELECT COUNT(*) AS count FROM panels WHERE group_id=?',
    ).get(panel.group_id).count);
    if (group.type === 'terminal' && remaining === 0) {
      db.prepare('DELETE FROM panel_groups WHERE id=?').run(group.id);
      return { removed: true, groupRemoved: true, panel: mapPanel(panel) };
    }
    compactPositions(db, panel.group_id);
    return { removed: true, groupRemoved: false, panel: mapPanel(panel) };
  });
}

export function reorderPanels(db, groupId, body, expectedRevision) {
  return mutatePanelLayout(db, expectedRevision, () => {
    const group = groupRow(db, groupId);
    const current = db.prepare('SELECT id FROM panels WHERE group_id=? ORDER BY position').all(group.id).map((row) => row.id);
    const ids = body?.panelIds;
    if (!Array.isArray(ids) || ids.length !== current.length
        || new Set(ids).size !== ids.length || current.some((id) => !ids.includes(id))) {
      throw new PanelModelError(400, 'panelIds must contain every panel in the group exactly once');
    }
    current.forEach((id, index) => db.prepare('UPDATE panels SET position=? WHERE id=?').run(-index - 1, id));
    ids.forEach((id, index) => db.prepare('UPDATE panels SET position=? WHERE id=?').run(index, id));
    if (body.widths !== undefined) {
      if (!Array.isArray(body.widths) || body.widths.length !== ids.length
          || body.widths.some((width) => !Number.isFinite(Number(width)) || Number(width) <= 0)) {
        throw new PanelModelError(400, 'widths must contain one positive number per panel');
      }
      ids.forEach((id, index) => db.prepare('UPDATE panels SET width=? WHERE id=?').run(Number(body.widths[index]), id));
    }
    return { panelIds: ids };
  });
}

function normalizeLink(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new PanelModelError(400, 'link must be a valid HTTP(S) URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PanelModelError(400, 'link must use HTTP or HTTPS');
  return url.href;
}

function normalizeMarkdown(group, value, { home = process.env.HOME || '', cwd = process.cwd() } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new PanelModelError(400, 'Markdown path must be a non-empty string');
  }
  let expanded = value.trim();
  if (expanded === '~') expanded = home;
  else if (expanded.startsWith('~/')) expanded = join(home, expanded.slice(2));
  const path = resolve(expanded.startsWith('/') ? expanded : join(group.path || cwd, expanded));
  if (!path.toLowerCase().endsWith('.md')) throw new PanelModelError(400, 'resource must be a .md file');
  if (!existsSync(path)) throw new PanelModelError(404, `no such Markdown file: ${path}`);
  let stats;
  try { stats = statSync(path); } catch { throw new PanelModelError(404, `no such Markdown file: ${path}`); }
  if (!stats.isFile()) throw new PanelModelError(400, 'Markdown resource must be a regular file');
  return path;
}

function insertResource(db, group, { kind, value, label, source = 'explicit' }, options = {}) {
  if (!RESOURCE_KINDS.includes(kind)) throw new PanelModelError(400, `resource kind must be one of: ${RESOURCE_KINDS.join(', ')}`);
  if (!RESOURCE_SOURCES.includes(source)) throw new PanelModelError(400, `resource source must be one of: ${RESOURCE_SOURCES.join(', ')}`);
  if (group.type === 'terminal') throw new PanelModelError(400, 'terminal groups cannot have associated resources');
  let normalized;
  if (kind === 'link') {
    try { normalized = normalizeLink(value); }
    catch (error) {
      if (source === 'explicit') throw error;
      normalized = String(value || '').trim();
      if (!normalized) throw error;
    }
  } else {
    normalized = normalizeMarkdown(group, value, options);
  }
  const id = stableId('resource', `${group.id}:${kind}:${normalized}`);
  db.prepare(`
    INSERT INTO resource_associations (id, group_id, kind, value, label, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_id, kind, value) DO UPDATE SET label=excluded.label
  `).run(id, group.id, kind, normalized, cleanLabel(label, kind === 'link' ? normalized : basename(normalized)), source, timestamp());
  return db.prepare('SELECT * FROM resource_associations WHERE id=?').get(id);
}

export function addResource(db, groupId, body, expectedRevision, options = {}) {
  return mutatePanelLayout(db, expectedRevision, () => {
    const group = groupRow(db, groupId);
    const resource = insertResource(db, group, {
      kind: body?.kind,
      value: body?.value,
      label: body?.label,
      source: 'explicit',
    }, options);
    return { resource: mapResource(resource) };
  });
}

export function removeResource(db, resourceId, body, expectedRevision) {
  return mutatePanelLayout(db, expectedRevision, () => {
    const resource = resourceRow(db, resourceId);
    if (resource.source === 'discovered') {
      throw new PanelModelError(403, 'automatically discovered session notes cannot be disassociated');
    }
    const panel = db.prepare('SELECT * FROM panels WHERE resource_id=?').get(resource.id);
    if (panel && body?.dirty === true && body?.force !== true) {
      throw new PanelModelError(409, 'Markdown file has unsaved changes', { panelId: panel.id });
    }
    db.prepare('DELETE FROM resource_associations WHERE id=?').run(resource.id);
    if (panel) compactPositions(db, panel.group_id);
    return { removed: true, resource: mapResource(resource), panel: panel ? mapPanel(panel) : null };
  });
}

export function openResourcePanel(db, resourceId, body, expectedRevision) {
  return mutatePanelLayout(db, expectedRevision, () => {
    const resource = resourceRow(db, resourceId);
    const existing = db.prepare('SELECT * FROM panels WHERE resource_id=?').get(resource.id);
    if (existing) {
      db.prepare('UPDATE panels SET minimized=0 WHERE id=?').run(existing.id);
      if (bool(existing.minimized)) db.prepare('UPDATE panels SET width=1 WHERE group_id=?').run(existing.group_id);
      db.prepare('UPDATE panel_layout_state SET active_group_id=? WHERE singleton=1').run(existing.group_id);
      return { panel: mapPanel(panelRow(db, existing.id)), restored: true };
    }
    const group = groupRow(db, resource.group_id);
    const kind = resource.kind === 'markdown' ? 'markdown' : 'iframe';
    validateGroupPanelKind(db, group, kind, resource.id);
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM panels WHERE group_id=?').get(group.id).count);
    const panel = insertPanel(db, {
      groupId: group.id, position: count, kind, resourceId: resource.id,
      minimized: body?.minimized === true, label: resource.label,
      markdownMode: kind === 'markdown' ? 'edit' : null,
    });
    db.prepare('UPDATE panels SET width=1 WHERE group_id=?').run(group.id);
    db.prepare('UPDATE panel_layout_state SET active_group_id=? WHERE singleton=1').run(group.id);
    return { panel: mapPanel({ ...panel, width: 1 }), restored: false };
  });
}

export function terminalIdentityForPanel(panel, group) {
  const role = panel.terminal_role || panel.terminalRole || (panel.kind === 'ai' ? 'agent' : 'shell');
  const ownerId = group.owner_id ?? group.ownerId;
  if (bool(panel.legacy_terminal ?? panel.legacyTerminal)) {
    if (ownerId != null) return { sessionId: String(ownerId), role };
    return { sessionId: null, role, terminalId: panel.id };
  }
  if (ownerId != null) {
    return { sessionId: String(ownerId), role, terminalId: panel.id, panelId: panel.id };
  }
  return { sessionId: null, role, terminalId: panel.id, panelId: panel.id };
}

export function terminalPanelsForOwner(db, ownerId, { role = null } = {}) {
  const rows = db.prepare(`
    SELECT p.*, g.owner_id, g.type AS group_type, g.path AS group_path
    FROM panels p JOIN panel_groups g ON g.id=p.group_id
    WHERE g.owner_id=? AND p.kind IN ('terminal', 'ai')
    ORDER BY p.position
  `).all(String(ownerId));
  return rows.filter((panel) => role == null || panel.terminal_role === role).map((panel) => ({
    panel: mapPanel(panel),
    group: { id: panel.group_id, owner_id: panel.owner_id, type: panel.group_type, path: panel.group_path },
    identity: terminalIdentityForPanel(panel, { owner_id: panel.owner_id }),
  }));
}

export function terminalPanelDescriptor(db, panelId) {
  const panel = panelRow(db, panelId);
  if (panel.kind !== 'terminal' && panel.kind !== 'ai') throw new PanelModelError(400, 'panel is not a terminal');
  const group = groupRow(db, panel.group_id);
  return { panel: mapPanel(panel), group, identity: terminalIdentityForPanel(panel, group) };
}

function upsertMigratedResource(db, group, kind, value, label, source, options) {
  try { return insertResource(db, group, { kind, value, label, source }, options); }
  catch (error) {
    // Missing legacy files are skipped; a bad legacy record must not prevent the
    // rest of the migration from committing.
    if (kind === 'markdown' && error instanceof PanelModelError) return null;
    throw error;
  }
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch { return fallback; }
}

function legacyBrowserState(db, scope) {
  const row = db.prepare('SELECT state_json FROM browser_ui_state WHERE scope=?').get(scope);
  return row ? parseJson(row.state_json) : {};
}

function legacyEditorTabs(dataDir) {
  try {
    const store = parseJson(readFileSync(join(dataDir, 'editor-tabs.json'), 'utf8'));
    return Array.isArray(store.global?.tabs) ? store.global.tabs : [];
  } catch { return []; }
}

function ensureMigrationScratchpad(db, config) {
  let row = db.prepare(`
    SELECT * FROM workstreams WHERE source='scratch' AND branch='unassigned-markdown'
  `).get();
  if (row) return row;
  const path = join(config.paths.scratchpads, 'unassigned-markdown');
  mkdirSync(path, { recursive: true });
  const createdAt = timestamp();
  const result = db.prepare(`
    INSERT INTO workstreams (
      org, repo, branch, path, source, status, label, created_at, last_joined_at
    ) VALUES ('scratch', 'scratch', 'unassigned-markdown', ?, 'scratch', 'paused',
      'Unassigned Markdown', ?, ?)
  `).run(path, createdAt, createdAt);
  row = db.prepare('SELECT * FROM workstreams WHERE id=?').get(Number(result.lastInsertRowid));
  return row;
}

function groupForOwner(db, ownerId) {
  return db.prepare('SELECT * FROM panel_groups WHERE owner_id=?').get(String(ownerId));
}

export function migrateLegacyPanelState(db, { dataDir, config, cwd = process.cwd() } = {}) {
  initializePanelSchema(db);
  if (db.prepare("SELECT 1 FROM panel_migrations WHERE name='unified-panels-v1'").get()) {
    return { migrated: false, revision: panelLayoutRevision(db) };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const workspaceState = legacyBrowserState(db, 'workspaces');
    const bottomState = legacyBrowserState(db, 'bottom-terminals');
    let activeGroupId = null;

    for (const spec of Array.isArray(workspaceState.workspaces) ? workspaceState.workspaces : []) {
      const ownerId = spec?.id == null ? null : String(spec.id);
      if (!ownerId) continue;
      const workstream = db.prepare('SELECT * FROM workstreams WHERE id=?').get(ownerId);
      const configured = config?.locations?.[ownerId];
      if (!workstream && !configured) continue;
      const item = workstream ? {
        ...workstream, id: workstream.id,
        type: workstream.source === 'scratch' ? 'scratchpad' : 'repo',
        name: workstream.label || workstream.branch,
      } : { ...configured, id: ownerId, type: 'misc', source: 'configured' };
      const roles = spec.panelMode === 'three' ? ['shell', 'editor', 'agent'] : ['shell', 'agent'];
      const { group } = ensureSessionPanelGroup(db, item, { roles, bump: false });
      if (String(workspaceState.activeWorkspaceId) === ownerId) activeGroupId = group.id;
    }

    // Existing issue associations become generic link resources, while the
    // issues table is retained for compatibility with current CLI commands.
    for (const issue of db.prepare('SELECT workstream_id, ref FROM issues ORDER BY id').all()) {
      let group = groupForOwner(db, issue.workstream_id);
      if (!group) {
        const row = db.prepare('SELECT * FROM workstreams WHERE id=?').get(issue.workstream_id);
        if (!row) continue;
        group = ensureSessionPanelGroup(db, {
          ...row, type: row.source === 'scratch' ? 'scratchpad' : 'repo',
          name: row.label || row.branch,
        }, { bump: false }).group;
      }
      upsertMigratedResource(db, group, 'link', issue.ref, issue.ref, 'legacy', { cwd });
    }

    const terminals = new Map((Array.isArray(bottomState.terminals) ? bottomState.terminals : [])
      .filter((terminal) => terminal?.id)
      .map((terminal) => [String(terminal.id), terminal]));
    const assigned = new Set();
    const createTerminalGroup = (members, label, boundaries = null) => {
      const group = insertGroup(db, { type: 'terminal', label });
      const points = Array.isArray(boundaries) ? boundaries.map(Number) : [];
      const validPoints = points.length === members.length - 1 && points.every((point, index) => (
        Number.isFinite(point) && point > (index ? points[index - 1] : 0) && point < 100
      ));
      const edges = validPoints ? [0, ...points, 100] : null;
      members.forEach((terminalId, position) => {
        const terminal = terminals.get(terminalId);
        if (!terminal) return;
        assigned.add(terminalId);
        insertPanel(db, {
          id: terminalId,
          groupId: group.id,
          position,
          kind: 'terminal',
          label: terminal.label || `Terminal ${position + 1}`,
          fontSize: terminal.fontSize,
          width: edges ? edges[position + 1] - edges[position] : DEFAULT_PANEL_WIDTH,
          legacyTerminal: true,
        });
      });
      if (members.includes(bottomState.displayedId)) activeGroupId ||= group.id;
      return group;
    };
    let terminalGroupNumber = 1;
    for (const legacyGroup of Array.isArray(bottomState.groups) ? bottomState.groups : []) {
      const members = (Array.isArray(legacyGroup?.members) ? legacyGroup.members : [])
        .map(String).filter((id) => terminals.has(id) && !assigned.has(id));
      if (!members.length) continue;
      createTerminalGroup(members, `Terminal group ${terminalGroupNumber++}`, legacyGroup.boundaries);
    }
    for (const terminalId of terminals.keys()) {
      if (!assigned.has(terminalId)) createTerminalGroup([terminalId], terminals.get(terminalId)?.label || `Terminal group ${terminalGroupNumber++}`);
    }

    const tabs = legacyEditorTabs(dataDir);
    if (tabs.length && config?.paths?.scratchpads) {
      const scratchpad = ensureMigrationScratchpad(db, config);
      const { group } = ensureSessionPanelGroup(db, {
        ...scratchpad, id: scratchpad.id, type: 'scratchpad', name: 'Unassigned Markdown',
      }, { roles: [], bump: false });
      let position = Number(db.prepare('SELECT COUNT(*) AS count FROM panels WHERE group_id=?').get(group.id).count);
      for (const tab of tabs) {
        const source = tab?.source || 'notes';
        const requested = tab?.path;
        const value = source === 'notes' ? join(config.paths.notes, String(requested || '')) : requested;
        const resource = upsertMigratedResource(
          db, group, 'markdown', value, tab?.name || basename(String(requested || 'Markdown')),
          'legacy', { cwd },
        );
        if (!resource || db.prepare('SELECT 1 FROM panels WHERE resource_id=?').get(resource.id)) continue;
        insertPanel(db, {
          id: stableId('panel', `${group.id}:${resource.id}`), groupId: group.id,
          position: position++, kind: 'markdown', minimized: true, resourceId: resource.id,
          label: resource.label, markdownMode: 'edit',
        });
      }
    }

    if (activeGroupId) {
      db.prepare('UPDATE panel_layout_state SET active_group_id=? WHERE singleton=1').run(activeGroupId);
    }
    db.prepare('INSERT INTO panel_migrations (name, completed_at) VALUES (?, ?)')
      .run('unified-panels-v1', timestamp());
    const revision = bumpRevision(db);
    db.exec('COMMIT');
    return { migrated: true, revision };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
    throw error;
  }
}

export function syncIssueResources(db) {
  let changed = false;
  const issueValuesByOwner = new Map();
  for (const issue of db.prepare('SELECT workstream_id, ref FROM issues ORDER BY id').all()) {
    const group = groupForOwner(db, issue.workstream_id);
    if (!group) continue;
    let normalized;
    try { normalized = normalizeLink(issue.ref); } catch { normalized = String(issue.ref).trim(); }
    if (!issueValuesByOwner.has(String(issue.workstream_id))) issueValuesByOwner.set(String(issue.workstream_id), new Set());
    issueValuesByOwner.get(String(issue.workstream_id)).add(normalized);
    if (db.prepare(`
      SELECT 1 FROM resource_associations WHERE group_id=? AND kind='link' AND value=?
    `).get(group.id, normalized)) continue;
    insertResource(db, group, { kind: 'link', value: normalized, label: issue.ref, source: 'legacy' });
    changed = true;
  }
  for (const resource of db.prepare(`
    SELECT r.*, g.owner_id FROM resource_associations r
    JOIN panel_groups g ON g.id=r.group_id
    WHERE r.kind='link' AND r.source='legacy' AND g.owner_id IS NOT NULL
  `).all()) {
    if (issueValuesByOwner.get(String(resource.owner_id))?.has(resource.value)) continue;
    db.prepare('DELETE FROM resource_associations WHERE id=?').run(resource.id);
    compactPositions(db, resource.group_id);
    changed = true;
  }
  if (changed) bumpRevision(db);
  return { changed, revision: panelLayoutRevision(db) };
}

export function syncDiscoveredSessionNotes(db, notesRoot) {
  const workDir = join(notesRoot, 'work');
  const desired = new Map();
  if (existsSync(workDir)) {
    const groups = db.prepare("SELECT * FROM panel_groups WHERE type IN ('repository', 'scratchpad')").all();
    for (const group of groups) {
      const row = db.prepare('SELECT * FROM workstreams WHERE id=?').get(group.owner_id);
      if (!row) continue;
      const rawSlug = row.source === 'scratch'
        ? `${row.id}-${row.branch}`
        : `${row.id}-${row.repo}-${String(row.branch).replaceAll('/', '-')}`;
      for (const year of readdirSync(workDir).sort()) {
        const dir = join(workDir, year, 'workstream', rawSlug);
        if (!existsSync(dir)) continue;
        let files = [];
        try { files = readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.md')).sort(); }
        catch { continue; }
        for (const file of files) {
          const path = join(dir, file);
          try { if (!statSync(path).isFile()) continue; } catch { continue; }
          desired.set(`${group.id}\0${path}`, { group, path, label: file });
        }
      }
    }
  }

  let changed = false;
  const current = db.prepare("SELECT * FROM resource_associations WHERE source='discovered'").all();
  for (const resource of current) {
    if (desired.has(`${resource.group_id}\0${resource.value}`)) continue;
    db.prepare('DELETE FROM resource_associations WHERE id=?').run(resource.id);
    compactPositions(db, resource.group_id);
    changed = true;
  }
  for (const { group, path, label } of desired.values()) {
    if (db.prepare(`
      SELECT 1 FROM resource_associations WHERE group_id=? AND kind='markdown' AND value=?
    `).get(group.id, path)) continue;
    insertResource(db, group, { kind: 'markdown', value: path, label, source: 'discovered' });
    changed = true;
  }
  if (changed) bumpRevision(db);
  return { changed, revision: panelLayoutRevision(db) };
}
