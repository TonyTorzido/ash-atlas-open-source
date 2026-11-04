import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";

const MAX_DIGITS = 19;

interface PadField {
  value: string;
  disabled: boolean;
  maxLength: number;
  onValueChange(raw: string): void;
  onCommit?: () => void;
}

interface NumberPadContextValue {
  activeId: string | null;
  open(id: string): void;
  register(id: string, field: PadField): void;
  unregister(id: string): void;
}

const NumberPadContext = createContext<NumberPadContextValue | null>(null);

/**
 * Phone only: wraps the market so its number boxes open an in-game pad instead of the system
 * keyboard. Without this provider (desktop) MarketNumberInput is a normal typed input.
 */
export function MarketNumberPadProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const fields = useRef(new Map<string, PadField>());
  const [active, setActive] = useState<{ id: string; fresh: boolean } | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const close = useCallback((): void => {
    const current = activeRef.current;
    if (!current) return;
    activeRef.current = null;
    setActive(null);
    fields.current.get(current.id)?.onCommit?.();
  }, []);

  const open = useCallback((id: string): void => {
    const current = activeRef.current;
    if (current?.id === id) return;
    if (current) fields.current.get(current.id)?.onCommit?.();
    const next = { id, fresh: true };
    activeRef.current = next;
    setActive(next);
  }, []);
  const register = useCallback((id: string, field: PadField): void => { fields.current.set(id, field); }, []);
  const unregister = useCallback((id: string): void => {
    fields.current.delete(id);
    if (activeRef.current?.id === id) {
      activeRef.current = null;
      setActive(null);
    }
  }, []);
  const activeId = active?.id ?? null;
  const context = useMemo<NumberPadContextValue>(() => ({ activeId, open, register, unregister }), [activeId, open, register, unregister]);

  const isOpen = active !== null;
  useEffect(() => {
    if (!isOpen) return undefined;
    const root = document.documentElement;
    root.setAttribute("data-number-pad-open", "");
    const onPointerDown = (event: Event): void => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-market-number-pad], [data-market-number-box]")) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      root.removeAttribute("data-number-pad-open");
    };
  }, [isOpen, close]);

  const press = (key: string): void => {
    const current = activeRef.current;
    const field = current ? fields.current.get(current.id) : undefined;
    if (!current || !field || field.disabled) return;
    let next: string;
    if (key === "back") next = field.value.slice(0, -1);
    else if (key === "clear") next = "";
    else next = (current.fresh ? key : field.value + key).replace(/^0+(?=\d)/, "").slice(0, Math.min(field.maxLength, MAX_DIGITS));
    if (current.fresh) {
      const settled = { id: current.id, fresh: false };
      activeRef.current = settled;
      setActive(settled);
    }
    field.onValueChange(next);
  };

  return (
    <NumberPadContext.Provider value={context}>
      {children}
      {active ? (
        <div className="market-number-pad" role="group" aria-label="Number pad" data-market-number-pad onMouseDown={(event) => event.preventDefault()}>
          <div className="market-number-pad-grid">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
              <button key={digit} type="button" onClick={() => press(digit)}>{digit}</button>
            ))}
            <button type="button" className="market-number-pad-aux" onClick={() => press("clear")}>Clear</button>
            <button type="button" onClick={() => press("0")}>0</button>
            <button type="button" className="market-number-pad-aux" aria-label="Backspace" onClick={() => press("back")}>⌫</button>
          </div>
          <button type="button" className="market-number-pad-done" onClick={close}>Done</button>
        </div>
      ) : null}
    </NumberPadContext.Provider>
  );
}

export function MarketNumberInput({ label, value, onValueChange, onCommit, maxLength = MAX_DIGITS, disabled = false, invalid }: {
  label: string;
  value: string;
  onValueChange(raw: string): void;
  onCommit?: () => void;
  maxLength?: number;
  disabled?: boolean;
  invalid?: boolean;
}): React.JSX.Element {
  const pad = useContext(NumberPadContext);
  const id = useId();
  const padRegister = pad?.register;
  const padUnregister = pad?.unregister;
  useEffect(() => {
    padRegister?.(id, { value, disabled, maxLength, onValueChange, ...(onCommit ? { onCommit } : {}) });
  });
  useEffect(() => () => padUnregister?.(id), [id, padUnregister]);

  if (!pad) {
    return (
      <input
        aria-label={label}
        {...(invalid !== undefined ? { "aria-invalid": invalid } : {})}
        value={value}
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={maxLength}
        disabled={disabled}
        onChange={(event) => onValueChange(event.currentTarget.value.replace(/\D/g, "").slice(0, maxLength))}
        {...(onCommit ? { onBlur: onCommit } : {})}
      />
    );
  }
  const isActive = pad.activeId === id;
  return (
    <span className={`market-number-box${isActive ? " market-number-box-active" : ""}`} data-market-number-box>
      <input
        aria-label={label}
        {...(invalid !== undefined ? { "aria-invalid": invalid } : {})}
        aria-haspopup="dialog"
        aria-expanded={isActive}
        value={value}
        readOnly
        inputMode="none"
        maxLength={maxLength}
        disabled={disabled}
        onClick={() => pad.open(id)}
        onFocus={() => pad.open(id)}
      />
      {isActive ? <span className="market-number-caret" aria-hidden="true" /> : null}
    </span>
  );
}
