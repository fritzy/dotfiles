import { useEffect, useRef, useState } from 'react';

const MIN_PANEL_PIXELS = 160;

export function defaultSplitBoundaries(count) {
  return Array.from({ length: Math.max(0, count - 1) }, (_, index) => ((index + 1) * 100) / count);
}

export function normalizeSplitBoundaries(boundaries, count) {
  const fallback = defaultSplitBoundaries(count);
  if (!Array.isArray(boundaries) || boundaries.length !== count - 1) return fallback;
  const values = boundaries.map(Number);
  if (values.some((value, index) => !Number.isFinite(value)
    || value <= (index ? values[index - 1] : 0) || value >= 100)) return fallback;
  return values;
}

function columnsFor(boundaries) {
  const edges = [0, ...boundaries, 100];
  return edges.slice(1).map((edge, index) => `${edge - edges[index]}%`).join(' ');
}

function SplitHandle({
  index, value, containerRef, boundaries, onChange, onCommit, onFocus, onReset,
}) {
  const pointer = useRef(null);
  const [dragging, setDragging] = useState(false);

  function restoreDocument() {
    if (!pointer.current) return;
    document.documentElement.style.cursor = pointer.current.cursor;
    document.body.style.userSelect = pointer.current.userSelect;
    pointer.current = null;
  }

  useEffect(() => () => restoreDocument(), []);

  function constrainedValue(clientX) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect?.width) return value;
    const minimum = Math.min(25, Math.max(6, (MIN_PANEL_PIXELS / rect.width) * 100));
    const lower = (boundaries[index - 1] ?? 0) + minimum;
    const upper = (boundaries[index + 1] ?? 100) - minimum;
    return Math.max(lower, Math.min(upper, ((clientX - rect.left) / rect.width) * 100));
  }

  function begin(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    pointer.current = {
      pointerId: event.pointerId,
      cursor: document.documentElement.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setDragging(true);
    onFocus?.();
  }

  function move(event) {
    if (pointer.current?.pointerId === event.pointerId) onChange(index, constrainedValue(event.clientX));
  }

  function finish(event, cancelled = false) {
    if (pointer.current?.pointerId !== event.pointerId) return;
    if (!cancelled) onChange(index, constrainedValue(event.clientX));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    restoreDocument();
    setDragging(false);
    onCommit?.();
  }

  function keyDown(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    onFocus?.();
    onChange(index, constrainedValue(rect.left + ((value / 100) * rect.width)
      + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 32 : 8)));
    onCommit?.();
  }

  return (
    <div
      role="separator"
      aria-label={`Resize terminal panels ${index + 1} and ${index + 2}`}
      aria-orientation="vertical"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      className="group absolute top-0 bottom-0 z-20 flex w-3 -translate-x-1/2 touch-none cursor-col-resize justify-center outline-none"
      style={{ left: `${value}%` }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={(event) => finish(event)}
      onPointerCancel={(event) => finish(event, true)}
      onDoubleClick={(event) => { event.preventDefault(); onFocus?.(); onReset?.(); }}
      onKeyDown={keyDown}
    >
      <span className={`h-full transition-[width,background-color] ${dragging ? 'w-1 bg-accent' : 'w-px bg-primary/50 group-hover:w-1 group-hover:bg-accent group-focus-visible:w-1 group-focus-visible:bg-accent'}`} aria-hidden="true" />
    </div>
  );
}

export default function TerminalSplitLayout({
  count, boundaries, fullscreen = false, children, className = '',
  onBoundaryChange, onBoundaryCommit, onBoundaryFocus, onResetBoundaries,
}) {
  const containerRef = useRef(null);
  const normalized = normalizeSplitBoundaries(boundaries, count);

  return (
    <div
      ref={containerRef}
      className={`relative grid min-h-0 flex-1 ${className}`}
      style={{ gridTemplateColumns: fullscreen ? 'minmax(0, 1fr)' : columnsFor(normalized) }}
      data-terminal-split-count={count}
    >
      {children}
      {!fullscreen && normalized.map((value, index) => (
        <SplitHandle
          key={index}
          index={index}
          value={value}
          containerRef={containerRef}
          boundaries={normalized}
          onChange={onBoundaryChange}
          onCommit={onBoundaryCommit}
          onFocus={() => onBoundaryFocus?.(index)}
          onReset={onResetBoundaries}
        />
      ))}
    </div>
  );
}
