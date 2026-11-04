import { useEffect, useId, useRef, useState } from "react";

export type ThemedSelectOption<Value extends string> = Readonly<{
  value: Value;
  label: string;
  disabled?: boolean;
}>;

export function ThemedSelect<Value extends string>({
  label,
  value,
  options,
  disabled = false,
  onChange
}: {
  label: string;
  value: Value;
  options: readonly ThemedSelectOption<Value>[];
  disabled?: boolean;
  onChange(value: Value): void;
}): React.JSX.Element {
  const id = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options[selectedIndex];

  useEffect(() => setActiveIndex(selectedIndex), [selectedIndex]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const move = (direction: 1 | -1): void => {
    if (options.length === 0) return;
    let next = activeIndex;
    do next = (next + direction + options.length) % options.length;
    while (options[next]?.disabled && next !== activeIndex);
    setActiveIndex(next);
  };
  const choose = (index: number): void => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="themed-select">
      <span id={`${id}-label`} className="themed-select-label">{label}</span>
      <button
        type="button"
        value={value}
        className="themed-select-trigger"
        role="combobox"
        aria-labelledby={`${id}-label`}
        aria-controls={`${id}-listbox`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) setOpen(true);
            else move(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (open) choose(activeIndex);
            else setOpen(true);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      >
        <span>{selected?.label ?? "Choose"}</span><span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div id={`${id}-listbox`} className="themed-select-listbox" role="listbox" aria-labelledby={`${id}-label`}>
          {options.map((option, index) => (
            <button
              type="button"
              role="option"
              key={option.value}
              aria-selected={option.value === value}
              data-active={index === activeIndex}
              disabled={option.disabled}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>{option.value === value ? <span aria-hidden="true">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
