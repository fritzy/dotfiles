import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { terminalPanelDescriptor } from './panels.js';
import { browserTerminalSessionName } from './zellij.js';
import { replaceFile } from './storage-files.js';
import { storageBackup } from './storage-migration.js';
import { ApiError } from './operation-error.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
export const terminalIdentityKey = (identity) => browserTerminalSessionName({ ...identity, namespace: 'fw' });
const conflict = (message) => { throw new ApiError(409, message, { code: 'terminal_migration_conflict' }); };

export function terminalEnvironmentMatches(env, identity, config, instanceId) {
  const checks = [
    [env.FRITZWORKS_INSTANCE_ID, instanceId],
    ...['FRITZWORKS_CONFIG', 'FW_CONFIG'].map((key) => [env[key] && resolve(env[key]), resolve(config.configPath)]),
    ...['FRITZWORKS_DATA', 'FRITZWORKS_DATA_DIR', 'FW_DATA_DIR'].map((key) => [env[key] && resolve(env[key]), resolve(config.paths.data)]),
  ];
  if (checks.some(([value, expected], index) => value && value !== expected
    && !(index >= 3 && config.previousDataPaths?.includes(value)))) return false;
  return checks.some(([value, expected], index) => value === expected || (index >= 3 && config.previousDataPaths?.includes(value)))
    && (identity.sessionId == null || env.FRITZWORKS_ID === String(identity.sessionId));
}

// An ID/cwd match alone cannot distinguish two legacy installations.
export function readTerminalProcesses() {
  const processes = [];
  let incomplete = false;
  for (const entry of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const path = `/proc/${entry}`;
      if (lstatSync(path).uid !== process.getuid()) continue;
      const args = readFileSync(join(path, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      const stat = readFileSync(join(path, 'stat'), 'utf8').split(') ').at(-1).split(' ');
      let environment = '';
      try { environment = readFileSync(join(path, 'environ'), 'utf8'); } catch { /* presence is still observable */ }
      const env = Object.fromEntries(environment.split('\0').filter(Boolean).map((value) => {
        const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)];
      }));
      let cwd = null;
      try { cwd = readlinkSync(join(path, 'cwd')); } catch { /* kernel/server process */ }
      processes.push({ pid: Number(entry), ppid: Number(stat[1]), start: stat[19], args, env, cwd });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) incomplete = true; }
  }
  return { processes, incomplete };
}

export function terminalSocketOwners(output, stat = lstatSync, uid = process.getuid?.()) {
  const owners = [];
  for (const line of String(output).split('\n')) {
    const match = line.match(/^u_str\s+LISTEN\s+\d+\s+\d+\s+(\S+)\s+\d+.*users:\(\("zellij",pid=(\d+),fd=\d+\)\).*\bino:(\d+)\s+dev:(\d+)\/(\d+)/);
    if (!match) continue;
    const [, path, pid, inode, major, minor] = match;
    try {
      const entry = stat(path);
      const device = BigInt(entry.dev);
      const majorNumber = Number((device >> 8n & 0xfffn) | (device >> 32n & 0xfffff000n));
      const minorNumber = Number((device & 0xffn) | (device >> 12n & 0xffffff00n));
      if (!entry.isSocket() || entry.uid !== uid || String(entry.ino) !== inode
          || majorNumber !== Number(major) || minorNumber !== Number(minor)) continue;
      owners.push({ path, pid: Number(pid), inode, device: String(entry.dev) });
    } catch { /* removed or replaced socket */ }
  }
  return owners;
}

function readSocketOwners(run) {
  try {
    const result = run('ss', ['-xlpn', '-e'], { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
    return result.error || result.status !== 0 ? [] : terminalSocketOwners(result.stdout);
  } catch { return []; }
}

export function inspectTerminalProcesses({ name, identity, config, instanceId, expectedCwd, processes, incomplete, socketOwners = [] }) {
  let servers = processes.filter((item) => basename(item.args[0] || '') === 'zellij'
    && item.args.includes('--server') && basename(item.args[item.args.indexOf('--server') + 1] || '') === name);
  if (!servers.length && !incomplete) return { verified: false, absent: true, reason: 'no live server in complete process inventory' };
  const reachable = servers.filter((server) => socketOwners.some((socket) => socket.pid === server.pid
    && socket.path === server.args[server.args.indexOf('--server') + 1]));
  if (reachable.length === 1) servers = reachable;
  if (servers.length !== 1) return { verified: false, reason: 'no unique live Zellij server for this name' };
  const server = servers[0];
  const descendant = (item) => {
    const seen = new Set();
    while (item && !seen.has(item.pid)) {
      if (item.ppid === server.pid) return true;
      seen.add(item.pid); item = processes.find((parent) => parent.pid === item.ppid);
    }
    return false;
  };
  const children = processes.filter(descendant);
  const witnesses = [server, ...children];
  if (witnesses.some(({ env }) => env.FRITZWORKS_INSTANCE_ID && env.FRITZWORKS_INSTANCE_ID !== instanceId)) {
    return { verified: false, reason: 'terminal contains another daemon instance identity' };
  }
  if (witnesses.some(({ env }) => [env.FRITZWORKS_CONFIG, env.FW_CONFIG].some((value) => value && resolve(value) !== resolve(config.configPath))
    || [env.FRITZWORKS_DATA, env.FRITZWORKS_DATA_DIR, env.FW_DATA_DIR].some((value) => value && resolve(value) !== resolve(config.paths.data) && !config.previousDataPaths?.includes(resolve(value))))) {
    return { verified: false, reason: 'terminal contains contradictory config or data identity' };
  }
  const matches = children.filter(({ env }) => terminalEnvironmentMatches(env, identity, config, instanceId));
  const socket = socketOwners.find((item) => item.pid === server.pid && item.path === server.args[server.args.indexOf('--server') + 1]);
  const fingerprint = hash(`${server.pid}:${server.start}:${name}${socket ? `:${socket.device}:${socket.inode}` : ''}`);
  if (!matches.length) {
    const reviewable = Boolean(socket && expectedCwd && server.cwd === resolve(expectedCwd)
      && witnesses.some(({ env }) => env.FRITZWORKS_DAEMON === '1' && env.ZELLIJ_SESSION_NAME === name)
      && !witnesses.some(({ env }) => identity.sessionId != null && env.FRITZWORKS_ID && env.FRITZWORKS_ID !== String(identity.sessionId)));
    if (!reviewable) return { verified: false, reason: 'no descendant carries this installation identity and owner ID' };
    return { verified: false, reviewRequired: true, name, pid: server.pid, start: server.start, cwd: server.cwd, socket,
      fingerprint,
      reason: 'legacy session has no installation identity; explicit review of process and socket ownership is required' };
  }
  return { verified: true, name, pid: server.pid, start: server.start,
    fingerprint, witnessPids: matches.map(({ pid }) => pid) };
}

export function inspectLegacyTerminal(options) {
  if (process.platform !== 'linux') return { verified: false, reason: 'process ownership inspection currently requires Linux' };
  const snapshot = readTerminalProcesses();
  const present = snapshot.processes.some((item) => basename(item.args[0] || '') === 'zellij'
    && item.args.includes('--server') && basename(item.args[item.args.indexOf('--server') + 1] || '') === options.name);
  return inspectTerminalProcesses({ ...options, ...snapshot, socketOwners: present ? readSocketOwners(options.run || spawnSync) : [] });
}

export function createTerminalMigration(context, { inspect = inspectLegacyTerminal, claimsRoot = join(tmpdir(), `fritzworks-terminal-claims-${process.getuid?.() ?? 'user'}`) } = {}) {
  const { db, instanceId } = context;
  const config = { ...context.config, previousDataPaths: JSON.parse(db.prepare("SELECT value FROM application_metadata WHERE key='previousDataPaths'").get()?.value || '[]') };
  const inventory = () => {
    const snapshot = inspect === inspectLegacyTerminal && process.platform === 'linux' ? readTerminalProcesses() : null;
    if (snapshot) snapshot.socketOwners = snapshot.processes.some((item) => basename(item.args[0] || '') === 'zellij' && item.args.includes('--server'))
      ? readSocketOwners(context.runProcess || spawnSync) : [];
    const inspectCandidate = (options) => snapshot ? inspectTerminalProcesses({ ...options, ...snapshot }) : inspect(options);
    const terminals = db.prepare("SELECT id FROM panels WHERE kind IN ('terminal','ai') ORDER BY id").all().map(({ id }) => {
      const descriptor = terminalPanelDescriptor(db, id);
      const identity = descriptor.identity;
      const candidates = ['fw', 'ws'].map((namespace) => {
        const name = browserTerminalSessionName({ ...identity, namespace });
        return { name, ...inspectCandidate({ name, identity, config, instanceId, expectedCwd: descriptor.group.path }) };
      });
      const verified = candidates.filter((item) => item.verified);
      return { panelId: id, identity, key: terminalIdentityKey(identity), candidates,
        inactive: candidates.every((item) => item.absent === true), selected: verified.length === 1 ? verified[0] : null };
    });
    const revision = hash(JSON.stringify(terminals, (key, value) => key === 'witnessPids' ? undefined : value));
    return { instanceId, revision, terminals, blocked: terminals.filter((item) => !item.selected && !item.inactive).map((item) => item.panelId) };
  };
  const claim = (terminal) => {
    const evidence = terminal.selected;
    mkdirSync(claimsRoot, { recursive: true, mode: 0o700 });
    const stats = lstatSync(claimsRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) || (process.getuid && stats.uid !== process.getuid())) conflict('terminal claim directory is not private');
    const path = join(claimsRoot, `${hash(evidence.name)}.json`);
    const value = { instanceId, data: config.paths.data, fingerprint: evidence.fingerprint, name: evidence.name };
    try { writeFileSync(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (lstatSync(path).isSymbolicLink()) conflict('terminal claim is a symlink');
      const text = readFileSync(path, 'utf8');
      const previous = JSON.parse(text);
      if (previous.instanceId !== instanceId || previous.name !== evidence.name
        || (previous.data !== config.paths.data && !config.previousDataPaths.includes(previous.data))) conflict(`terminal is claimed by another instance: ${evidence.name}`);
      replaceFile(path, text, JSON.stringify(value));
    }
    return path;
  };
  const apply = ({ revision, legacyApprovals = [] } = {}) => {
    const plan = inventory();
    if (revision !== plan.revision) conflict('terminal inventory changed; preview again');
    if (!Array.isArray(legacyApprovals)) conflict('legacy approvals must be an array of reviewed panel/name/fingerprint records');
    const approved = new Set();
    for (const approval of legacyApprovals) {
      const terminal = plan.terminals.find((item) => item.panelId === approval?.panelId);
      const candidate = terminal?.candidates.find((item) => item.reviewRequired && item.name === approval.name && item.fingerprint === approval.fingerprint);
      if (!candidate || approved.has(terminal.panelId)) conflict('legacy approval does not match a unique reviewed process');
      terminal.selected = { ...candidate, operatorConfirmed: true };
      approved.add(terminal.panelId);
    }
    plan.blocked = plan.blocked.filter((id) => !approved.has(id));
    if (plan.blocked.length || !plan.terminals.length) conflict('terminal ownership remains ambiguous; no processes were changed');
    const id = `terminals-${plan.revision}`;
    const previous = db.prepare('SELECT backup_path FROM storage_migrations WHERE id=?').get(id);
    const backup = previous?.backup_path || storageBackup(db, config, id);
    db.prepare(`INSERT OR IGNORE INTO storage_migrations (id, kind, status, plan_json, backup_path, updated_at)
      VALUES (?, 'terminals', 'applying', ?, ?, ?)`).run(id, JSON.stringify(plan), backup, context.clock());
    try {
      for (const terminal of plan.terminals) {
        if (terminal.inactive) {
          if (!terminal.candidates.every(({ name }) => inspect({ name, identity: terminal.identity, config, instanceId }).absent === true)) conflict('inactive terminal became live during adoption');
          db.prepare("UPDATE terminal_adoptions SET status='released' WHERE identity_key=?").run(terminal.key);
          continue;
        }
        const fresh = inspect({ name: terminal.selected.name, identity: terminal.identity, config, instanceId, expectedCwd: terminal.selected.cwd, run: context.runProcess });
        if (!(fresh.verified || (terminal.selected.operatorConfirmed && fresh.reviewRequired)) || fresh.fingerprint !== terminal.selected.fingerprint) conflict('terminal process changed during adoption');
        if (terminal.selected.operatorConfirmed) fresh.operatorConfirmed = true;
        const path = claim(terminal);
        db.prepare(`INSERT OR REPLACE INTO terminal_adoptions (identity_key, session_name, evidence_json, claim_path, status)
          VALUES (?, ?, ?, ?, 'adopted')`).run(terminal.key, terminal.selected.name, JSON.stringify(fresh), path);
      }
      db.prepare("INSERT OR REPLACE INTO application_metadata (key,value) VALUES ('terminalOwnership',?)")
        .run(JSON.stringify({ status: 'owned', migration: id }));
      db.prepare("UPDATE storage_migrations SET status='complete', error=NULL, updated_at=? WHERE id=?").run(context.clock(), id);
      return { ...plan, status: 'complete', migrationId: id };
    } catch (error) {
      db.prepare("UPDATE storage_migrations SET status='interrupted', error=?, updated_at=? WHERE id=?").run(error.message, context.clock(), id);
      throw error;
    }
  };
  const mappedIdentity = (identity) => {
    const row = db.prepare("SELECT * FROM terminal_adoptions WHERE identity_key=? AND status='adopted'").get(terminalIdentityKey(identity));
    if (!row) return { ...identity, namespace: context.terminalNamespace };
    const evidence = JSON.parse(row.evidence_json);
    const proof = inspect({ name: row.session_name, identity, config, instanceId, expectedCwd: evidence.cwd, run: context.runProcess });
    const claim = JSON.parse(readFileSync(row.claim_path, 'utf8'));
    if (!(proof.verified || (evidence.operatorConfirmed && proof.reviewRequired)) || proof.fingerprint !== evidence.fingerprint || claim.instanceId !== instanceId
      || claim.fingerprint !== proof.fingerprint) conflict('adopted terminal ownership changed; preview recovery');
    return { ...identity, namespace: context.terminalNamespace, adoptedSession: row.session_name };
  };
  const release = (identity) => db.prepare("UPDATE terminal_adoptions SET status='released' WHERE identity_key=?").run(terminalIdentityKey(identity));
  const recover = (body = {}) => {
    if (!body.migrationId) return apply(body);
    const entry = db.prepare("SELECT plan_json FROM storage_migrations WHERE id=? AND kind='terminals'").get(body.migrationId);
    if (!entry) throw new ApiError(404, 'no such terminal migration');
    const plan = JSON.parse(entry.plan_json);
    return apply({ revision: plan.revision, legacyApprovals: plan.terminals.filter((item) => item.selected?.operatorConfirmed)
      .map((item) => ({ panelId: item.panelId, name: item.selected.name, fingerprint: item.selected.fingerprint })) });
  };
  return { inventory, apply, recover, mappedIdentity, release };
}
