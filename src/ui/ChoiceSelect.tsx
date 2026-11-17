import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

export type ChoiceOption = {
  value: string;
  label: string;
  hint?: string;
};

// One closed chip instead of a row of toggle buttons. The other options
// stay one click away, so the header and composer keep a single current value.
export function ChoiceSelect({
  label,
  value,
  valueLabel,
  options,
  onChange,
  disabled,
  compact,
  menu = "down",
  ariaLabel,
  title,
  tone,
}: {
  label?: string;
  value: string;
  valueLabel?: string;
  options: ChoiceOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  compact?: boolean;
  menu?: "up" | "down";
  ariaLabel: string;
  title?: string;
  tone?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number; up: boolean } | null>(null);
  const id = useId();
  const current = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    function place() {
      const el = rootRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const up = menu === "up";
      const minWidth = Math.max(rect.width, 210);
      setPos({
        top: up ? rect.top - 4 : rect.bottom + 4,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - minWidth - 8)),
        minWidth,
        up,
      });
    }
    place();
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, menu]);

  return (
    <div className={`choice-select${compact ? " compact" : ""}${tone ? ` tone-${tone}` : ""}`} ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ariaLabel}
        title={current?.hint || title}
        onClick={() => setOpen((next) => !next)}
      >
        {label ? <span className="choice-kicker">{label}</span> : null}
        <span className="choice-value">{valueLabel || current?.label || value}</span>
        <ChevronDown size={12} className="choice-chev" />
      </button>
      {open && pos
        ? createPortal(
            <div
              id={id}
              ref={menuRef}
              className="choice-menu"
              role="listbox"
              aria-label={ariaLabel}
              style={{
                top: pos.up ? undefined : pos.top,
                bottom: pos.up ? window.innerHeight - pos.top : undefined,
                left: pos.left,
                minWidth: pos.minWidth,
              }}
            >
              {options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-label={option.label}
                  aria-selected={option.value === value}
                  className={option.value === value ? "on" : ""}
                  onClick={() => {
                    setOpen(false);
                    if (option.value !== value) onChange(option.value);
                  }}
                >
                  <span>{option.label}</span>
                  {option.hint ? <small>{option.hint}</small> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
