const DOT_CLASS = {
  open: 'bg-accent',
  connecting: 'bg-soft',
  closed: 'bg-danger',
};

export default function DaemonTabs({ targets, currentTargetId, connections, onChange }) {
  return (
    <nav
      className="flex min-w-0 flex-wrap gap-1 px-2 pt-2"
      aria-label="Connections"
      role="tablist"
    >
      {targets.map((target) => {
        const selected = target.id === currentTargetId;
        const state = connections[target.id] || 'connecting';
        return (
          <button
            key={target.id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={`Switch to ${target.name}; ${state === 'open' ? 'connected' : state}`}
            title={target.name}
            className={`inline-flex min-h-8 min-w-20 flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${selected ? 'border-accent bg-accent text-on-accent' : 'border-primary/50 bg-page text-primary hover:bg-soft hover:text-on-soft'}`}
            onClick={() => onChange(target.id)}
          >
            <span className={`size-2 shrink-0 rounded-full ${DOT_CLASS[state] || DOT_CLASS.connecting}`} aria-hidden="true" />
            <span className="truncate">{target.name}</span>
          </button>
        );
      })}
    </nav>
  );
}
