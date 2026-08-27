import { useEffect, useRef } from 'react';

import { PANEL_ROLES } from './constants.js';
import {
  EditorIcon, ProviderIcon, RobotIcon, ShellIcon, ThreePanelIcon, TwoPanelIcon, XIcon,
} from './icons.jsx';

const BUTTON_VARIANTS = {
  primary: 'border-primary bg-primary text-on-primary hover:border-accent hover:bg-accent hover:text-on-accent',
  secondary: 'border-primary bg-page text-primary hover:bg-soft hover:text-on-soft',
  danger: 'border-danger bg-danger text-on-danger hover:border-accent hover:bg-accent hover:text-on-accent',
  soft: 'border-soft bg-soft text-on-soft hover:border-accent hover:bg-accent hover:text-on-accent',
  ghost: 'border-transparent bg-transparent text-ink hover:bg-soft hover:text-on-soft',
};

export function Button({ variant = 'primary', className = '', type = 'button', ...props }) {
  return <button type={type} className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_VARIANTS[variant]} ${className}`} {...props} />;
}

export function IconButton({ label, title = label, children, className = '', variant = 'secondary', compact = false, type = 'button', ...props }) {
  const dimensions = compact ? 'size-7 rounded' : 'size-9 rounded-md';
  return <button type={type} aria-label={label} title={title} className={`inline-flex shrink-0 items-center justify-center border p-0 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${dimensions} ${BUTTON_VARIANTS[variant]} ${className}`} {...props}>{children}</button>;
}

export function Field({ label, children, className = '' }) {
  return <label className={`grid gap-1 text-sm font-semibold text-primary ${className}`}><span>{label}</span>{children}</label>;
}

export const inputClass = 'min-h-10 w-full rounded-md border border-primary bg-page px-3 py-2 text-sm text-ink shadow-sm outline-none placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50';
export const selectClass = 'min-h-9 rounded-md border border-primary bg-page px-2 py-1.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/40';

export function Modal({ open, onClose, title, children, busy = false, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className={`modal-dialog m-auto max-h-[92vh] w-[min(56rem,calc(100%-1.5rem))] overflow-y-auto rounded-xl border border-primary bg-page p-0 text-ink shadow-2xl ${className}`}
      onCancel={(event) => { if (busy) event.preventDefault(); else onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <div className="relative p-5 sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-xl font-bold leading-tight sm:text-2xl">{title}</h2>
          <IconButton label="Close" variant="ghost" onClick={onClose} disabled={busy}><XIcon className="size-5" /></IconButton>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function AgentToggle({ value, onChange, disabled = false, compact = false }) {
  const containerClass = compact ? 'rounded-md p-0.5' : 'rounded-lg p-1';
  const buttonClass = compact ? 'size-6 rounded' : 'size-8 rounded-md';
  return (
    <div className={`inline-grid grid-cols-2 border border-primary bg-page ${containerClass}`} aria-label="Agent provider">
      {['claude', 'codex'].map((provider) => (
        <button
          key={provider}
          type="button"
          className={`flex items-center justify-center transition-colors ${buttonClass} ${value === provider ? 'bg-accent text-on-accent shadow-sm' : 'text-primary hover:bg-soft hover:text-on-soft'} disabled:opacity-40`}
          aria-label={`Use ${provider === 'codex' ? 'Codex' : 'Claude'}`}
          aria-pressed={value === provider}
          title={provider === 'codex' ? 'Codex' : 'Claude'}
          disabled={disabled}
          onClick={() => onChange(provider)}
        ><ProviderIcon provider={provider} /></button>
      ))}
    </div>
  );
}

const PANEL_ICONS = { shell: ShellIcon, editor: EditorIcon, agent: RobotIcon };

export function PanelToggles({ panels, onToggle, disabled = false, available = true }) {
  const selected = new Set(panels || []);
  return (
    <div className="inline-flex gap-1" aria-label="Panels">
      {PANEL_ROLES.map((panel) => {
        const Icon = PANEL_ICONS[panel];
        const enabled = selected.has(panel);
        return (
          <button
            key={panel}
            type="button"
            className={`flex size-9 items-center justify-center rounded-md border border-primary transition-colors ${enabled ? 'bg-accent text-on-accent' : 'bg-page text-primary hover:bg-soft hover:text-on-soft'} disabled:cursor-not-allowed disabled:opacity-40`}
            aria-label={`${enabled ? 'Disable' : 'Enable'} ${panel} panel`}
            aria-pressed={enabled}
            title={`${panel[0].toUpperCase()}${panel.slice(1)} panel: ${enabled ? 'on' : 'off'}`}
            disabled={disabled || !available}
            onClick={() => onToggle(panel)}
          ><Icon /></button>
        );
      })}
    </div>
  );
}

export function PanelModeToggle({ value, onChange }) {
  return (
    <button
      type="button"
      className="grid grid-cols-2 rounded-lg border border-primary bg-page p-1 text-primary"
      aria-label={`Switch to ${value === 'three' ? 'two' : 'three'}-panel layout`}
      title={value === 'two' ? 'Two panels: shell and agent' : 'Three panels: shell, editor, and agent'}
      onClick={() => onChange(value === 'three' ? 'two' : 'three')}
    >
      <span className={`flex size-8 items-center justify-center rounded-md transition-colors ${value === 'three' ? 'bg-accent text-on-accent shadow-sm' : ''}`}><ThreePanelIcon /></span>
      <span className={`flex size-8 items-center justify-center rounded-md transition-colors ${value === 'two' ? 'bg-accent text-on-accent shadow-sm' : ''}`}><TwoPanelIcon /></span>
    </button>
  );
}

export function ErrorMessage({ children }) {
  return children ? <p className="whitespace-pre-wrap rounded-md border border-danger/40 bg-danger/10 p-3 text-sm font-semibold text-danger" role="alert">{children}</p> : null;
}

export function DefinitionList({ children }) {
  return <dl className="grid grid-cols-[minmax(7rem,1fr)_minmax(0,3fr)] divide-y divide-primary/20 border-y border-primary/20">{children}</dl>;
}

export function Definition({ term, children }) {
  return <><dt className="py-3 pr-4 text-sm font-semibold text-primary">{term}</dt><dd className="min-w-0 py-3 text-sm [overflow-wrap:anywhere]">{children}</dd></>;
}
