"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";

export type LuminousTypeTag = "span" | "div" | "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
export type LuminousTypeIdle = "drift" | "center" | "none";

export interface LuminousTypeHandle {
  lightsOn: () => void;
  lightsOff: () => void;
}

export interface LuminousTypeProps {
  text?: string;
  as?: LuminousTypeTag;
  fontSize?: number | string;
  fontWeight?: number;
  letterSpacing?: string;
  lineHeight?: number;
  align?: "left" | "center" | "right";
  maxWidth?: string;
  color?: string;
  tint?: string;
  baseOpacity?: number;
  radius?: number;
  softness?: number;
  trail?: number;
  follow?: number;
  idle?: LuminousTypeIdle;
  driftSpeed?: number;
  clickToReveal?: boolean;
  interactive?: boolean;
  className?: string;
  style?: CSSProperties;
}

interface Settings {
  tint: string;
  baseOpacity: number;
  radius: number;
  softness: number;
  trail: number;
  follow: number;
  idle: LuminousTypeIdle;
  driftSpeed: number;
  clickToReveal: boolean;
  interactive: boolean;
  reduced: boolean;
}

interface Controller {
  sync: () => void;
  destroy: () => void;
  lights: (on: boolean) => void;
}

const subscribeToMotion = (notify: () => void) => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};

const readMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const createLight = (root: HTMLElement, lit: HTMLElement, base: HTMLElement, settingsRef: { current: Settings }): Controller => {
  const light = { x: 0, y: 0, vx: 0, vy: 0 };
  const glow = { x: 0, y: 0, vx: 0, vy: 0 };
  const pointer = { x: 0, y: 0, inside: false };
  let width = 1;
  let height = 1;
  let em = 16;
  let open = 0;
  let openGoal = 0;
  let presence = 0;
  let time = Math.random() * 40;
  let raf = 0;
  let last = 0;
  let visible = true;
  let destroyed = false;
  let placed = false;

  const measure = () => {
    const rect = root.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    em = parseFloat(getComputedStyle(root).fontSize) || 16;
    if (!placed) {
      light.x = glow.x = width / 2;
      light.y = glow.y = height / 2;
      placed = true;
    }
  };

  const target = () => {
    const settings = settingsRef.current;
    if (pointer.inside && settings.interactive) return [pointer.x, pointer.y] as const;
    if (settings.idle === "drift") {
      const speed = clamp(settings.driftSpeed, 0, 4);
      const t = time * speed;
      return [
        width / 2 + width * 0.4 * Math.sin(t * 0.23 + 0.4) * Math.cos(t * 0.071),
        height / 2 + height * 0.34 * Math.sin(t * 0.31 + 1.7),
      ] as const;
    }
    return [width / 2, height / 2] as const;
  };

  const spring = (body: typeof light, goalX: number, goalY: number, stiffness: number, dt: number) => {
    const damping = 2 * Math.sqrt(stiffness);
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      body.vx += (stiffness * (goalX - body.x) - damping * body.vx) * h;
      body.vy += (stiffness * (goalY - body.y) - damping * body.vy) * h;
      body.x += body.vx * h;
      body.y += body.vy * h;
    }
  };

  const paint = () => {
    const settings = settingsRef.current;
    const softness = clamp(settings.softness, 0, 1);
    const reach = clamp(settings.radius, 0.5, 20) * em;
    const core = (1 - softness) * 42 + 6;
    const cover = (Math.hypot(width, height) * 1.05 * 100) / core;
    const r = reach + (cover - reach) * open * open;
    const shoulder = core + (100 - core) * 0.45;
    const trail = clamp(settings.trail, 0, 1) * (1 - open) * presence;
    const main = `radial-gradient(circle ${r.toFixed(1)}px at ${light.x.toFixed(1)}px ${light.y.toFixed(1)}px, #000 0%, #000 ${core.toFixed(1)}%, rgba(0,0,0,0.55) ${shoulder.toFixed(1)}%, rgba(0,0,0,0) 100%)`;
    const after = `radial-gradient(circle ${(reach * 1.35).toFixed(1)}px at ${glow.x.toFixed(1)}px ${glow.y.toFixed(1)}px, rgba(0,0,0,${(0.5 * trail).toFixed(3)}) 0%, rgba(0,0,0,${(0.22 * trail).toFixed(3)}) 45%, rgba(0,0,0,0) 100%)`;
    const mask = trail > 0.01 ? `${main}, ${after}` : main;
    lit.style.setProperty("mask-image", mask);
    lit.style.setProperty("-webkit-mask-image", mask);
    const tint = settings.tint && typeof CSS !== "undefined" && CSS.supports("color", settings.tint) ? settings.tint : "";
    if (tint) {
      const hold = core * 0.8 + (100 - core * 0.8) * open;
      const fill = `radial-gradient(circle ${(r * 1.05).toFixed(1)}px at ${light.x.toFixed(1)}px ${light.y.toFixed(1)}px, currentColor 0%, currentColor ${hold.toFixed(1)}%, ${tint} ${Math.max(100, hold + 0.1).toFixed(1)}%)`;
      lit.style.backgroundImage = fill;
      lit.style.setProperty("-webkit-background-clip", "text");
      lit.style.backgroundClip = "text";
      lit.style.setProperty("-webkit-text-fill-color", "transparent");
    } else {
      lit.style.backgroundImage = "";
      lit.style.removeProperty("-webkit-text-fill-color");
    }
    lit.style.opacity = String(Math.max(presence, open));
    base.style.opacity = String(clamp(settings.baseOpacity, 0, 1));
  };

  const settled = () => {
    const settings = settingsRef.current;
    const [gx, gy] = target();
    const still = Math.hypot(light.x - gx, light.y - gy) < 0.3 && Math.hypot(light.vx, light.vy) < 2 && Math.hypot(glow.x - light.x, glow.y - light.y) < 0.5;
    const drifting = !pointer.inside && settings.idle === "drift" && !settings.reduced;
    return still && !drifting && Math.abs(open - openGoal) < 0.001 && Math.abs(presence - presenceGoal()) < 0.001;
  };

  const presenceGoal = () => {
    const settings = settingsRef.current;
    if (settings.reduced) return 1;
    if (pointer.inside && settings.interactive) return 1;
    return settings.idle === "none" ? 0 : 1;
  };

  const step = (dt: number) => {
    const settings = settingsRef.current;
    if (settings.reduced) {
      open = 1;
      presence = 1;
      return;
    }
    time += dt;
    const stiffness = 30 + 330 * clamp(settings.follow, 0, 1);
    const [gx, gy] = target();
    spring(light, gx, gy, pointer.inside ? stiffness : stiffness * 0.35, dt);
    spring(glow, light.x, light.y, 9, dt);
    open += (openGoal - open) * (1 - Math.exp(-dt / 0.32));
    const goal = presenceGoal();
    presence += (goal - presence) * (1 - Math.exp(-dt / (goal > presence ? 0.25 : 0.6)));
  };

  const tick = (now: number) => {
    raf = 0;
    if (destroyed) return;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    step(dt);
    paint();
    if (visible && !document.hidden && !settled()) raf = requestAnimationFrame(tick);
  };

  function wake() {
    if (destroyed || raf || !visible) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  const locate = (event: PointerEvent) => {
    const rect = root.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
  };

  const onMove = (event: PointerEvent) => {
    if (!settingsRef.current.interactive) return;
    locate(event);
    if (!pointer.inside) {
      pointer.inside = true;
      if (presence < 0.05) {
        light.x = glow.x = pointer.x;
        light.y = glow.y = pointer.y;
        light.vx = light.vy = glow.vx = glow.vy = 0;
      }
    }
    wake();
  };

  const onLeave = (event: PointerEvent) => {
    if (event.pointerType === "touch" && event.type === "pointercancel") return;
    pointer.inside = false;
    wake();
  };

  const onDown = (event: PointerEvent) => {
    const settings = settingsRef.current;
    if (!settings.interactive) return;
    locate(event);
    pointer.inside = true;
    wake();
  };

  const onClick = () => {
    const settings = settingsRef.current;
    if (!settings.interactive || !settings.clickToReveal || settings.reduced) return;
    openGoal = openGoal > 0.5 ? 0 : 1;
    wake();
  };

  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointerleave", onLeave);
  root.addEventListener("pointercancel", onLeave);
  root.addEventListener("click", onClick);
  const resizeObserver = new ResizeObserver(() => {
    measure();
    paint();
    wake();
  });
  resizeObserver.observe(root);
  const intersection = new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) wake();
    },
    { rootMargin: "80px" },
  );
  intersection.observe(root);
  const onVisibility = () => {
    if (!document.hidden) wake();
  };
  document.addEventListener("visibilitychange", onVisibility);
  measure();
  if (settingsRef.current.reduced) {
    open = 1;
    presence = 1;
  } else if (settingsRef.current.idle !== "none") presence = 1;
  paint();
  wake();

  return {
    sync: () => {
      if (settingsRef.current.reduced) {
        open = 1;
        presence = 1;
      } else if (openGoal === 0 && open > 0.999) open = 0;
      paint();
      wake();
    },
    destroy: () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointercancel", onLeave);
      root.removeEventListener("click", onClick);
      document.removeEventListener("visibilitychange", onVisibility);
      resizeObserver.disconnect();
      intersection.disconnect();
    },
    lights: (on: boolean) => {
      openGoal = on ? 1 : 0;
      wake();
    },
  };
};

const LuminousType = forwardRef<LuminousTypeHandle, LuminousTypeProps>(function LuminousType(
  {
    text = "Look a little closer. There is more here than meets the eye.",
    as = "p",
    fontSize = "clamp(2rem, 5vw, 3.75rem)",
    fontWeight = 600,
    letterSpacing = "-0.035em",
    lineHeight = 1.15,
    align = "center",
    maxWidth = "20ch",
    color,
    tint = "#B19EEF",
    baseOpacity = 0.14,
    radius = 3,
    softness = 0.6,
    trail = 0.5,
    follow = 0.5,
    idle = "drift",
    driftSpeed = 1,
    clickToReveal = true,
    interactive = true,
    className,
    style,
  },
  ref,
) {
  const Tag = as as "span";
  const rootRef = useRef<HTMLElement>(null);
  const litRef = useRef<HTMLSpanElement>(null);
  const baseRef = useRef<HTMLSpanElement>(null);
  const controllerRef = useRef<Controller | null>(null);
  const reduced = useSyncExternalStore(subscribeToMotion, readMotion, () => false);
  const settingsRef = useRef<Settings>({
    tint,
    baseOpacity,
    radius,
    softness,
    trail,
    follow,
    idle,
    driftSpeed,
    clickToReveal,
    interactive,
    reduced,
  });

  useEffect(() => {
    settingsRef.current = {
      tint,
      baseOpacity,
      radius,
      softness,
      trail,
      follow,
      idle,
      driftSpeed,
      clickToReveal,
      interactive,
      reduced,
    };
    controllerRef.current?.sync();
  });

  useEffect(() => {
    const root = rootRef.current;
    const lit = litRef.current;
    const base = baseRef.current;
    if (!root || !lit || !base) return;
    const controller = createLight(root, lit, base, settingsRef);
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      lightsOn: () => controllerRef.current?.lights(true),
      lightsOff: () => controllerRef.current?.lights(false),
    }),
    [],
  );

  return (
    <Tag
      ref={rootRef as RefObject<HTMLSpanElement>}
      className={cn("relative inline-block max-w-full", className)}
      style={{
        fontSize: typeof fontSize === "number" ? `${fontSize}px` : fontSize,
        fontWeight,
        letterSpacing,
        lineHeight,
        textAlign: align,
        color,
        maxWidth: maxWidth ? `min(100%, ${maxWidth})` : undefined,
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
        cursor: clickToReveal && interactive ? "pointer" : undefined,
        touchAction: "pan-y",
        ...style,
      }}
    >
      <span ref={baseRef} style={{ display: "block", opacity: baseOpacity }}>
        {text}
      </span>
      <span
        ref={litRef}
        aria-hidden="true"
        style={{ position: "absolute", inset: 0, display: "block", pointerEvents: "none", opacity: reduced ? 1 : 0 }}
      >
        {text}
      </span>
    </Tag>
  );
});

LuminousType.displayName = "LuminousType";

export { LuminousType };
export default LuminousType;
