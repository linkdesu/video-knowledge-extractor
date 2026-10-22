"use client";

import {
  type ButtonHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";

// settings-form-3 改造：上游演示页改为设置页 primitives（ADR-0022）；重跑 rbp:vendor 会用上游原文覆盖本文件。

export type SelectOption = { value: string; label: string };

export function SettingsPanel({
  title,
  hint,
  testId,
  children,
}: {
  title: string;
  hint?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section className="vn-card vn-pad" data-testid={testId}>
      <b>{title}</b>
      {hint !== undefined ? <p className="vn-hint" style={{ marginTop: 6 }}>{hint}</p> : null}
      {children}
    </section>
  );
}

export function SettingsField({
  label,
  hint,
  locked,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  locked?: boolean;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="vn-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {locked ? <span className="vn-hint">由环境变量控制</span> : null}
      {hint !== undefined ? <span className="vn-hint">{hint}</span> : null}
    </div>
  );
}

export function Select({
  id,
  value,
  onChange,
  options,
  disabled,
  testId,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly SelectOption[];
  disabled?: boolean;
  testId?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [flip, setFlip] = useState(false);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ buffer: "", at: 0 });

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const openList = () => {
    const node = rootRef.current;
    if (node !== null) {
      const box = node.getBoundingClientRect();
      let top = 0;
      let bottom = box.bottom;
      let el = node.parentElement;
      while (el !== null && el !== document.body) {
        const style = window.getComputedStyle(el);
        if (style.overflowY !== "visible") {
          const clip = el.getBoundingClientRect();
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
        el = el.parentElement;
      }
      const listHeight = Math.min(options.length * 32 + 10, 264);
      const up = bottom - box.bottom < listHeight + 6 && box.top - top > bottom - box.bottom;
      const room = (up ? box.top - top : bottom - box.bottom) - 10;
      setFlip(up);
      setMaxHeight(room < listHeight ? Math.max(room, 72) : undefined);
    }
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const node = rootRef.current;
    if (node === null) return;
    const doc = node.ownerDocument;
    if (doc === null) return;
    const onPointer = (e: Event) => {
      if (!node.contains(e.target as Node)) setOpen(false);
    };
    doc.addEventListener("mousedown", onPointer);
    doc.addEventListener("touchstart", onPointer);
    return () => {
      doc.removeEventListener("mousedown", onPointer);
      doc.removeEventListener("touchstart", onPointer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (list === null || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight)
      list.scrollTop = bottom - list.clientHeight;
  }, [open, active]);

  useEffect(() => {
    if (!open && selectedIndex >= 0) setActive(selectedIndex);
  }, [open, selectedIndex]);

  const commit = (index: number) => {
    const option = options[index];
    if (option === undefined) return;
    onChange(option.value);
    setOpen(false);
    rootRef.current
      ?.querySelector("button")
      ?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) {
      e.preventDefault();
      return;
    }
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(active);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const now = Date.now();
      const t = typeahead.current;
      t.buffer = now - t.at > 700 ? e.key : t.buffer + e.key;
      t.at = now;
      const hit = options.findIndex((o) =>
        o.label.toLowerCase().startsWith(t.buffer.toLowerCase()),
      );
      if (hit >= 0) setActive(hit);
    }
  };

  return (
    <div ref={rootRef} className="vn-select-wrap">
      <button
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${listId}-opt-${active}` : undefined}
        data-testid={testId}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className="vn-select-trigger"
      >
        <span className="vn-select-trigger-text">{selected?.label ?? ""}</span>
        <span className="vn-select-caret" aria-hidden="true" />
      </button>

      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          data-testid={testId !== undefined ? `${testId}-listbox` : undefined}
          style={maxHeight !== undefined ? { maxHeight } : undefined}
          className={`vn-select-list${flip ? " up" : ""}`}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              data-highlighted={i === active ? "" : undefined}
              data-index={i}
              data-testid={testId !== undefined ? `${testId}-option-${i}` : undefined}
              data-value={o.value}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(i)}
              className="vn-select-option"
            >
              <span className="vn-select-option-text">{o.label}</span>
              {o.value === value ? <span className="vn-select-check" aria-hidden="true">✓</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function TextInput({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={
        className === undefined
          ? "vn-input"
          : ["vn-input", className].filter(Boolean).join(" ")
      }
    />
  );
}

export function PasswordInput({
  value,
  onChange,
  onEnter,
  readOnly,
  placeholder,
  ariaLabel,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  readOnly?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  testId?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="vn-password">
      <input
        type={revealed ? "text" : "password"}
        autoComplete="off"
        className="vn-input"
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        aria-label={ariaLabel}
        data-testid={testId !== undefined ? `${testId}-input` : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter !== undefined) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      <button
        type="button"
        className="vn-btn-eye"
        aria-label={revealed ? "隐藏密钥" : "显示密钥"}
        data-testid={testId !== undefined ? `${testId}-reveal` : undefined}
        disabled={readOnly}
        onClick={() => setRevealed((r) => !r)}
      >
        <span aria-hidden="true">👁</span>
      </button>
    </div>
  );
}

export function Button({
  variant = "secondary",
  size = "sm",
  pending,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
  size?: "sm" | "md";
  pending?: boolean;
}) {
  const cls = ["vn-btn", size, variant === "primary" ? "primary" : "", rest.className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      {...rest}
      className={cls}
      disabled={pending === true ? true : rest.disabled}
    >
      {children}
    </button>
  );
}
