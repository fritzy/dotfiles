import { useSyncExternalStore } from 'react';
import { connections, subscribeConnections } from './connections.js';

export function useTargetAvailable(target) {
  const current = useSyncExternalStore(subscribeConnections, () => connections.snapshot().find((item) => item.id === (target?.id || 'local')));
  if (!target?.instanceId) return true;
  return Boolean(current?.ready && current.instanceId === target.instanceId && current.url === target.url);
}
