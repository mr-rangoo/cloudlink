"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** Accessible on/off switch (button role="switch"). */
export function Switch({ checked, onChange, label, description, id, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; id: string; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {description ? (
          <p id={`${id}-desc`} className="text-xs text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50",
          checked ? "border-accent bg-accent" : "border-border-strong bg-surface-muted",
        )}
      >
        <span className={cn("inline-block size-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-6" : "translate-x-1")} aria-hidden />
        <span className="sr-only">{checked ? "On" : "Off"}</span>
      </button>
    </div>
  );
}

/** Single-choice segmented control (radio group semantics, arrow keys move the selection). */
export function Segmented<T extends string>({ value, onChange, options, label, id }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; label: string; id: string }) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const move = (delta: number) => {
    const next = (index + delta + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} id={id} className="inline-flex rounded-md border border-border bg-surface-muted p-0.5">
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            }
          }}
          className={cn(
            "h-8 rounded px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
            o.value === value ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Multi-select chips (e.g. days of the week). */
export function ChipToggleGroup({ options, selected, onToggle, label }: { options: Array<{ value: number; label: string }>; selected: (v: number) => boolean; onToggle: (v: number) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={selected(o.value)}
          onClick={() => onToggle(o.value)}
          className={cn(
            "h-8 min-w-11 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
            selected(o.value) ? "border-accent bg-accent-soft text-accent" : "border-border text-muted-foreground hover:bg-surface-muted",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
