export const MIN_PANEL_WIDTH = 320;

export function panelCapacity(width, minimum = MIN_PANEL_WIDTH) {
  if (!Number.isFinite(Number(width)) || Number(width) <= 0) return 1;
  return Math.max(1, Math.floor(Number(width) / minimum));
}

export function panelsToMinimize(panels, width, minimum = MIN_PANEL_WIDTH) {
  const visible = (panels || []).filter((panel) => !panel.minimized);
  const remove = Math.max(0, visible.length - panelCapacity(width, minimum));
  return visible.slice(Math.max(1, visible.length - remove)).reverse().map((panel) => panel.id);
}
