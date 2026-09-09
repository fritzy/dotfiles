const CLIENT_ID_KEY = 'ai-workstream-browser-client-id';

let volatileClientId = null;

function newClientId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `client-${uuid}`;
  const random = Math.random().toString(36).slice(2);
  return `client-${Date.now().toString(36)}-${random}`;
}

// sessionStorage survives refreshes but is isolated per browser tab/window. That
// gives the daemon enough identity to hand a detached Zellij session to the next
// waiting view without letting two simultaneously open clients type into it.
export function browserClientId() {
  if (volatileClientId) return volatileClientId;
  try {
    const existing = window.sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) {
      volatileClientId = existing;
      return existing;
    }
    volatileClientId = newClientId();
    window.sessionStorage.setItem(CLIENT_ID_KEY, volatileClientId);
    return volatileClientId;
  } catch {
    volatileClientId = newClientId();
    return volatileClientId;
  }
}
