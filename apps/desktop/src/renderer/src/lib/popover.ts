/**
 * 弹层定位的唯一实现（r69，ADR-0045）：Select 与 Combobox 的 listbox 都 portal 到
 * `document.body` 用 `position: fixed` 渲染，几何由这里算。
 *
 * 为什么必须 portal：`.vn-card` 带 `backdrop-filter`，会自建层叠上下文；弹层留在卡片里，
 * 卡片比弹层矮时下方卡片会盖住超出部分（r52b G1 / r69 设置页模型下拉）。
 * portal 之后弹层的坐标基准是视口，不再受祖先裁剪影响，但仍要避开滚动容器与窗口边界，
 * 所以纵向范围取「视口 ∩ 各滚动祖先矩形」。
 */

/** 触发器与弹层之间的间距；也用于弹层「向上」时的底边偏移。 */
export const POPOVER_GAP = 6;
/** 每行高度与列表容器内边距 + 边框：与 `.vn-select-option` 的 7px 上下内距一致。 */
export const POPOVER_ROW_HEIGHT = 32;
export const POPOVER_CHROME = 10;
/** 弹层最多 264px；再高就在列表内部滚动。 */
export const POPOVER_MAX_HEIGHT = 264;
/** 空间不足时允许压缩到的下限；低于它就没有可用性，交给列表内部滚动。 */
export const POPOVER_MIN_HEIGHT = 72;
/** 计算可用空间时再留出的余量（间距 + 1px 边框）。 */
export const POPOVER_ROOM_MARGIN = 10;

export type PopoverAnchor = {
  left: number;
  width: number;
  top: number;
  bottom: number;
};

/** 纵向可见范围（视口坐标）：视口与所有 `overflow-y` 祖先矩形的交集。 */
export type VerticalBand = { top: number; bottom: number };

export type PopoverPlacement = {
  left: number;
  width: number;
  /** 向下展开时的顶边；向上展开时为 null。 */
  top: number | null;
  /** 向上展开时的底边偏移（相对视口下沿）；向下展开时为 null。 */
  bottom: number | null;
  /** 空间不足时的最大高度；空间充足为 null。 */
  maxHeight: number | null;
  up: boolean;
};

/** 候选数量对应的列表高度（未压缩时）。 */
export function listHeightFor(optionCount: number): number {
  return Math.min(optionCount * POPOVER_ROW_HEIGHT + POPOVER_CHROME, POPOVER_MAX_HEIGHT);
}

/**
 * 弹层几何：默认向下，下方空间不足且上方更宽裕时向上翻转；
 * 可用空间比列表矮时压缩 maxHeight，但不少于 `POPOVER_MIN_HEIGHT`。
 */
export function computePopoverPlacement(input: {
  anchor: PopoverAnchor;
  band: VerticalBand;
  /** portal 的 `fixed` 定位基准高度，即 `window.innerHeight`。 */
  viewportHeight: number;
  listHeight: number;
}): PopoverPlacement {
  const { anchor, band, viewportHeight, listHeight } = input;
  const roomBelow = band.bottom - anchor.bottom;
  const roomAbove = anchor.top - band.top;
  const up = roomBelow < listHeight + POPOVER_GAP && roomAbove > roomBelow;
  const room = (up ? roomAbove : roomBelow) - POPOVER_ROOM_MARGIN;
  const maxHeight = room < listHeight ? Math.max(room, POPOVER_MIN_HEIGHT) : null;
  return {
    left: anchor.left,
    width: anchor.width,
    top: up ? null : anchor.bottom + POPOVER_GAP,
    bottom: up ? viewportHeight - anchor.top + POPOVER_GAP : null,
    maxHeight,
    up,
  };
}

/**
 * 触发器可用的纵向范围：从视口开始，逐个求交所有 `overflow-y !== visible` 的祖先。
 * body 本身也是滚动容器，必须参与求交（内容区 `.vn-content` 滚动时弹层要跟着收）。
 */
export function clipVerticalBand(node: Element | null): VerticalBand | null {
  if (node === null) return null;
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
  return { top, bottom };
}

/** 触发器的视口矩形 → 弹层锚点。 */
export function anchorOf(node: Element): PopoverAnchor {
  const box = node.getBoundingClientRect();
  return { left: box.left, width: box.width, top: box.top, bottom: box.bottom };
}

/** portal 弹层的内联样式：固定定位 + 锚点几何 +（必要时）高度上限。 */
export function popoverStyle(placement: PopoverPlacement): {
  position: "fixed";
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight?: number;
} {
  return {
    position: "fixed",
    left: placement.left,
    width: placement.width,
    ...(placement.top === null ? {} : { top: placement.top }),
    ...(placement.bottom === null ? {} : { bottom: placement.bottom }),
    ...(placement.maxHeight === null ? {} : { maxHeight: placement.maxHeight }),
  };
}
