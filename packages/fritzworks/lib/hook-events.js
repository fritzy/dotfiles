import { browserTerminalSessionName } from './zellij.js';
import { randomUUID } from 'node:crypto';
import { setAgentStatus, setShellStatus, setConfiguredLocationAgentStatus, setConfiguredLocationShellStatus } from './core.js';

export function createHookEvents(context, { resetStatus = true } = {}) {
  const { db } = context;
  db.exec(`CREATE TABLE IF NOT EXISTS terminal_hook_generations (owner TEXT NOT NULL, provider TEXT NOT NULL, generation TEXT NOT NULL, terminal TEXT NOT NULL, PRIMARY KEY(owner,provider,terminal));
    CREATE TABLE IF NOT EXISTS terminal_hook_events (owner TEXT NOT NULL, provider TEXT NOT NULL, emitter TEXT NOT NULL, event_id TEXT NOT NULL, sequence REAL NOT NULL, occurred_at REAL NOT NULL, terminal TEXT NOT NULL, PRIMARY KEY(owner,provider,emitter,terminal));`);
  if (resetStatus) {
    db.exec('UPDATE workstreams SET agent_status=NULL, shell_status=NULL; UPDATE configured_location_state SET agent_status=NULL, shell_status=NULL');
  }
  function environment(owner, provider, identity = { sessionId: String(owner), role: provider === 'shell' ? 'shell' : 'agent' }) {
    const id = String(context.ownerId(owner));
    const terminal = browserTerminalSessionName({ ...identity, namespace: context.terminalNamespace });
    db.prepare('INSERT OR IGNORE INTO terminal_hook_generations VALUES (?,?,?,?)').run(id, provider, randomUUID(), terminal);
    const generation = db.prepare('SELECT generation FROM terminal_hook_generations WHERE owner=? AND provider=? AND terminal=?').get(id, provider, terminal).generation;
    return { FRITZWORKS_INSTANCE_ID: context.instanceId, FRITZWORKS_ID: id, FRITZWORKS_PROVIDER: provider,
      FRITZWORKS_GENERATION: generation, FRITZWORKS_TERMINAL_ID: terminal, FRITZWORKS_DAEMON_URL: context.runtimeEndpoint || (() => { const host = context.config.server.host; const local = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host; return `http://${local.includes(':') ? '[' + local + ']' : local}:${context.config.server.port}`; })() };
  }
  function revoke(owner, provider) {
    const id = String(context.ownerId(owner));
    const rows = db.prepare('SELECT * FROM terminal_hook_generations WHERE owner=?').all(id).filter((row) => !provider || row.provider === provider);
    for (const row of rows) db.prepare('UPDATE terminal_hook_generations SET generation=? WHERE owner=? AND provider=? AND terminal=?').run(randomUUID(), id, row.provider, row.terminal);
    if (provider) db.prepare('DELETE FROM terminal_hook_events WHERE owner=? AND provider=?').run(id, provider);
    else db.prepare('DELETE FROM terminal_hook_events WHERE owner=?').run(id);
  }
  const diagnostics = { accepted: 0, dropped: 0, reasons: {} };
  function ingest(event) {
    const dropped = (reason) => { diagnostics.dropped++; diagnostics.reasons[reason] = (diagnostics.reasons[reason] || 0) + 1; return { updated: false, reason }; };
    if (!event || typeof event !== 'object' || Array.isArray(event)) return dropped('invalid event');
    if (event.instanceId !== context.instanceId) return dropped('wrong instance');
    if (!['shell', 'claude', 'codex'].includes(event.provider) || !['working', 'ready'].includes(event.status)) return dropped('unsupported provider or status');
    if (!event.sessionId || typeof event.generation !== 'string' || typeof event.eventId !== 'string' || !event.eventId || event.eventId.length > 200) return dropped('missing event identity');
    let target;
    try { target = context.resolveTarget(String(event.sessionId)); } catch { return dropped('unknown session'); }
    const owner = String(context.ownerId(target));
    if (typeof event.terminalId !== 'string') return dropped('missing terminal identity');
    const generation = db.prepare('SELECT generation FROM terminal_hook_generations WHERE owner=? AND provider=? AND terminal=?').get(owner, event.provider, event.terminalId)?.generation;
    if (!generation || generation !== event.generation) return dropped('stale terminal generation');
    if (target.kind === 'session' && db.prepare('SELECT status FROM workstreams WHERE uuid=?').get(target.id)?.status === 'closed') return dropped('closed session');
    const sequence = Number(event.sequence);
    const occurredAt = typeof event.occurredAt === 'string' ? Date.parse(event.occurredAt) : Number(event.occurredAt);
    const now = Date.now();
    if (!Number.isFinite(sequence) || sequence < 0 || !Number.isFinite(occurredAt) || occurredAt > now + 30_000 || occurredAt < now - 120_000) return dropped('stale event time');
    const emitter = String(event.emitterId || event.provider);
    if (!emitter || emitter.length > 200) return dropped('invalid emitter');
    const previous = db.prepare('SELECT * FROM terminal_hook_events WHERE owner=? AND provider=? AND emitter=? AND terminal=?').get(owner, event.provider, emitter, event.terminalId);
    if (previous && (previous.event_id === event.eventId || previous.sequence >= sequence || previous.occurred_at > occurredAt)) return dropped('duplicate or out-of-order event');
    const latest = db.prepare('SELECT MAX(occurred_at) AS time FROM terminal_hook_events WHERE owner=? AND provider=?').get(owner, event.provider).time;
    if (latest != null && latest > occurredAt) return dropped('out-of-order status');
    db.prepare('INSERT OR REPLACE INTO terminal_hook_events VALUES (?,?,?,?,?,?,?)').run(owner, event.provider, emitter, event.eventId, sequence, occurredAt, event.terminalId);
    db.prepare('DELETE FROM terminal_hook_events WHERE occurred_at < ?').run(now - 120_000);
    const write = target.kind === 'location'
      ? event.provider === 'shell' ? setConfiguredLocationShellStatus : setConfiguredLocationAgentStatus
      : event.provider === 'shell' ? setShellStatus : setAgentStatus;
    write(db, owner, event.status);
    diagnostics.accepted++;
    context.publish({ type: 'update_session', id: owner });
    return { updated: true, id: owner, status: event.status };
  }
  function revokeIdentity(identity) {
    const terminal = browserTerminalSessionName({ ...identity, namespace: context.terminalNamespace });
    db.prepare('UPDATE terminal_hook_generations SET generation=? WHERE terminal=?').run(randomUUID(), terminal);
    db.prepare('DELETE FROM terminal_hook_events WHERE terminal=?').run(terminal);
  }
  return { environment, revoke, revokeIdentity, ingest, diagnostics: () => structuredClone(diagnostics) };
}
