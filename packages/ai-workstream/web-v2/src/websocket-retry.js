export const WEBSOCKET_RECONNECT_BASE_MS = 500;
export const WEBSOCKET_RECONNECT_CAP_MS = 10_000;

// 0.5s, 1s, 2s, 4s, 8s, then 10s until a connection succeeds.
export function websocketReconnectDelay(attempt) {
  const exponent = Math.max(0, Math.min(30, Math.floor(Number(attempt) || 0)));
  return Math.min(WEBSOCKET_RECONNECT_CAP_MS, WEBSOCKET_RECONNECT_BASE_MS * (2 ** exponent));
}
