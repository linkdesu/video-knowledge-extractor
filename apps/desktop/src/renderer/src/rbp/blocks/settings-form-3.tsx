"use client";

import {
  type ButtonHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Eye, EyeOff } from "lucide-react";
import { comboboxEmptyHint, filterComboboxOptions } from "../../lib/combobox";

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
  ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly SelectOption[];
  disabled?: boolean;
  testId?: string;
  ariaLabel?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // r52c：弹层不再留在卡片里（`.vn-card` 的 backdrop-filter 会自建层叠上下文，把弹层困在卡片下，
  // 且会被 DOM 后面的卡片整块盖住）。改为 portal 到 body + fixed 定位，placement 就是此刻的锚点几何。
  const [placement, setPlacement] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight?: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ buffer: "", at: 0 });

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  // 可见区域 = 视口 ∩ 各滚动祖先的矩形；body 本身也是滚动容器，必须参与求交。
  const place = useCallback(() => {
    const node = rootRef.current;
    if (node === null) return null;
    const box = node.getBoundingClientRect();
    let top = 0;
    let bottom = window.innerHeight;
    let el: HTMLElement | null = node.parentElement;
    while (el !== null) {
      const style = window.getComputedStyle(el);
      if (style.overflowY !== "visible") {
        const clip = el.getBoundingClientRect();
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
      el = el.parentElement;
    }
    const listHeight = Math.min(options.length * 32 + 10, 264);
    const roomBelow = bottom - box.bottom;
    const roomAbove = box.top - top;
    const up = roomBelow < listHeight + 6 && roomAbove > roomBelow;
    const room = (up ? roomAbove : roomBelow) - 10;
    const maxHeight = room < listHeight ? Math.max(room, 72) : undefined;
    return {
      left: box.left,
      width: box.width,
      ...(up ? { bottom: window.innerHeight - box.top + 6 } : { top: box.bottom + 6 }),
      ...(maxHeight === undefined ? {} : { maxHeight }),
    };
  }, [options.length]);

  const openList = () => {
    const next = place();
    if (next !== null) setPlacement(next);
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  // 打开期间跟随触发器的位置（内容区滚动、窗口缩放、任务浮层改变留白都会移动锚点）。
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const reposition = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = place();
        if (next !== null) setPlacement(next);
      });
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const node = rootRef.current;
    if (node === null) return;
    const doc = node.ownerDocument;
    if (doc === null) return;
    const onPointer = (e: Event) => {
      const target = e.target as Node;
      // 弹层在 body 上，不在 rootRef 里，必须单独判一次，否则点选项会先被当成“点外面”。
      if (node.contains(target) || listRef.current?.contains(target) === true) return;
      setOpen(false);
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
        aria-label={ariaLabel}
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

      {open && placement !== null
        ? createPortal(
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              tabIndex={-1}
              data-testid={testId !== undefined ? `${testId}-listbox` : undefined}
              style={{ left: placement.left, width: placement.width, top: placement.top, bottom: placement.bottom, maxHeight: placement.maxHeight }}
              className="vn-select-list portal"
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
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}

export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  testId,
  ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
  ariaLabel?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [flip, setFlip] = useState(false);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  // r32：只在「打开后用户还在打字」时过滤。每次展开都以全部候选开始，
  // 否则选中一个模型后再次打开只会剩它自己。
  const [query, setQuery] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const blurTimer = useRef(0);

  const visible = filterComboboxOptions(options, query);
  const emptyHint = comboboxEmptyHint(options, query);

  const openList = () => {
    window.clearTimeout(blurTimer.current);
    setQuery(null);
    const node = rootRef.current;
    if (node !== null) {
      const box = node.getBoundingClientRect();
      let top = 0;
      let bottom = window.innerHeight;
      let el: HTMLElement | null = node.parentElement;
      while (el !== null) {
        const style = window.getComputedStyle(el);
        if (style.overflowY !== "visible") {
          const clip = el.getBoundingClientRect();
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
        el = el.parentElement;
      }
      const listHeight = Math.min(options.length * 32 + 10, 264);
      const roomBelow = bottom - box.bottom;
      const roomAbove = box.top - top;
      const up = roomBelow < listHeight + 6 && roomAbove > roomBelow;
      const room = (up ? roomAbove : roomBelow) - 10;
      setFlip(up);
      setMaxHeight(room < listHeight ? Math.max(room, 72) : undefined);
    }
    const selected = options.findIndex((o) => o.value === value);
    setActive(selected >= 0 ? selected : 0);
    setOpen(true);
  };

  // 用户正在输入：列表跟着过滤，但输入值本身仍交给上层当草稿。
  const typeList = (next: string) => {
    if (!open) openList();
    setQuery(next);
  };

  const closeList = () => {
    window.clearTimeout(blurTimer.current);
    blurTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  const cancelBlur = () => {
    window.clearTimeout(blurTimer.current);
  };

  useEffect(() => {
    if (!open) return;
    const node = rootRef.current;
    if (node === null) return;
    const doc = node.ownerDocument;
    if (doc === null) return;
    const onPointer = (e: Event) => {
      if (!node.contains(e.target as Node)) {
        window.clearTimeout(blurTimer.current);
        setOpen(false);
      }
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
    if (visible.length > 0) setActive((i) => Math.min(i, visible.length - 1));
  }, [visible.length]);
  useEffect(() => () => window.clearTimeout(blurTimer.current), []);

  const commit = (index: number) => {
    const option = visible[index];
    if (option === undefined) return;
    onChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (open) {
        e.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(visible.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(active);
    }
  };

  return (
    <div ref={rootRef} className="vn-select-wrap vn-combobox">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-haspopup="listbox"
        aria-activedescendant={open && visible.length > 0 ? `${listId}-opt-${active}` : undefined}
        aria-label={ariaLabel}
        data-testid={testId}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        className="vn-input"
        onChange={(e) => {
          onChange(e.target.value);
          typeList(e.target.value);
        }}
        onFocus={openList}
        onClick={() => {
          // 关掉列表后焦点还在输入框里，再点一次不会再触发 focus；没有这条就永远打不开。
          if (!open) openList();
        }}
        onBlur={closeList}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        tabIndex={-1}
        className="vn-combobox-caret"
        aria-hidden="true"
        onClick={() => (open ? setOpen(false) : openList())}
      >
        <ChevronDown size={15} style={{ transform: open ? "rotate(180deg)" : undefined }} />
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
          {visible.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              data-highlighted={i === active ? "" : undefined}
              data-index={i}
              data-testid={testId !== undefined ? `${testId}-option-${i}` : undefined}
              data-value={o.value}
              onMouseDown={(e) => {
                e.preventDefault();
                cancelBlur();
              }}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(i)}
              className="vn-select-option"
            >
              <span className="vn-select-option-text">{o.label}</span>
              {o.value === value ? <span className="vn-select-check" aria-hidden="true">✓</span> : null}
            </li>
          ))}
          {visible.length === 0 && emptyHint !== null ? (
            <li role="presentation" data-testid={testId !== undefined ? `${testId}-empty` : undefined} className="vn-select-empty">
              {emptyHint}
            </li>
          ) : null}
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
  id,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  readOnly?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
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
        id={id}
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
        onClick={() => setRevealed((r) => !r)}
      >
        {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
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
  size?: "sm";
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
