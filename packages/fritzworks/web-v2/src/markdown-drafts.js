import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'fritzworks-markdown-drafts';
const listeners = new Set();
let drafts = [];
let loadedStorage;
function storage() { try { return window.sessionStorage; } catch { return null; } }
function snapshot() {
  const current = storage();
  if (current && current !== loadedStorage) {
    loadedStorage = current;
    try { drafts = JSON.parse(current.getItem(STORAGE_KEY) || '[]'); } catch { drafts = []; }
    if (!Array.isArray(drafts)) drafts = [];
  }
  return drafts;
}
const keyFor = (target, path, source, editor) => JSON.stringify([target?.instanceId, source, path, editor]);
export function readDraft(target, path, source, editor = path) {
  if (!target?.instanceId) return null;
  return snapshot().find((draft) => draft.key === keyFor(target, path, source, editor));
}
export function discardDraft(target, path, source, editor = path) {
  if (!target?.instanceId) return;
  const key = keyFor(target, path, source, editor);
  const current = snapshot();
  drafts = current.filter((draft) => draft.key !== key);
  if (drafts.length === current.length) { drafts = current; return; }
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(drafts)); } catch { /* retain in memory */ }
  for (const listener of listeners) listener();
}
export function retainDraft(target, path, source, content, saved, version, editor = path, owner) {
  if (!target?.instanceId) return;
  const key = keyFor(target, path, source, editor);
  const current = snapshot();
  const previous = current.find((draft) => draft.key === key);
  if (content === saved && (!previous || previous.owner !== owner)) return;
  if (content !== saved && previous?.content === content && previous.saved === saved && previous.version === version && previous.owner === owner) return;
  drafts = current.filter((draft) => draft.key !== key);
  if (content !== saved) drafts.push({ key, targetId: target.id, targetName: target.name || target.id,
    instanceId: target.instanceId, path, source, content, saved, version, owner });
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(drafts)); } catch { /* retain in memory */ }
  for (const listener of listeners) listener();
}
export function useMarkdownDrafts() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, snapshot);
}
