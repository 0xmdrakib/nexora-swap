'use client';

import * as React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import clsx from 'clsx';

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export function Select({
  value,
  onChange,
  options,
  className,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const shellRef = React.useRef<HTMLDivElement | null>(null);
  const selected = React.useMemo(() => options.find((o) => o.value === value), [options, value]);

  React.useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!open) return;
      const el = shellRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) setOpen(false);
    }

    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  React.useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div className="ui-select-shell" ref={shellRef}>
      <button
        type="button"
        className={clsx(
          'ui-select-trigger',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <span className="truncate">{selected?.label || placeholder || 'Select...'}</span>
        <ChevronDown size={16} className={clsx('muted-icon transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="ui-select-content" role="listbox" aria-label="Select route">
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={active}
                disabled={opt.disabled}
                className={clsx('ui-select-item', active && 'ui-select-item-active')}
                onClick={() => {
                  if (opt.disabled) return;
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 truncate">{opt.label}</span>
                {active && <Check size={16} className="ui-select-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
