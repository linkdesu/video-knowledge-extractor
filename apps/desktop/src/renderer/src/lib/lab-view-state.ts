/**
 * Lab 输入区的视图状态（r52）：样本、A/B 方案、阈值、两处滚动位置。
 * 纯模块：不依赖 React/DOM，只读写一个 JSON 字符串，方便 bun test 直接覆盖。
 */
import { LAB_CONFIGS } from "../../../shared/lab";
import type { LabConfigName } from "../../../shared/lab";

export const LAB_VIEW_STORAGE_KEY = "vn.lab.view";

/** 阈值滑块 `min`/`max`：与页面上的 range 输入保持一致。 */
export const LAB_THRESHOLD_MIN = 0.6;
export const LAB_THRESHOLD_MAX = 1.5;

export type LabViewState = {
  /** null = 没保存过，或上次的样本已不存在。 */
  sampleId: string | null;
  configA: LabConfigName;
  configB: LabConfigName;
  threshold: number;
  /** `.vn-content` 页面滚动位置。 */
  contentScrollTop: number;
  /** 字幕行列表内部滚动位置。 */
  rowsScrollTop: number;
};

export const LAB_VIEW_DEFAULTS: LabViewState = {
  sampleId: null,
  configA: "baseline",
  configB: "refine_filter",
  threshold: 1,
  contentScrollTop: 0,
  rowsScrollTop: 0,
};

function isLabConfigName(value: unknown): value is LabConfigName {
  return typeof value === "string" && (LAB_CONFIGS as readonly string[]).includes(value);
}

/**
 * 严格白名单归一化：只取六个已知字段，其余丢弃。
 * 非空字符串才算 sampleId；未知方案名各自回退默认；阈值 clamp 到滑块范围并取 1 位小数；
 * 滚动位置只接受有限非负数，向下取整到整像素。
 */
function normalizeLabView(input: Record<string, unknown>): LabViewState {
  const rawSampleId = input.sampleId;
  const sampleId =
    typeof rawSampleId === "string" && rawSampleId.trim() !== "" ? rawSampleId.trim() : null;

  const rawThreshold = input.threshold;
  const threshold =
    typeof rawThreshold === "number" && Number.isFinite(rawThreshold)
      ? Math.round(
          Math.min(LAB_THRESHOLD_MAX, Math.max(LAB_THRESHOLD_MIN, rawThreshold)) * 10,
        ) / 10
      : LAB_VIEW_DEFAULTS.threshold;

  const rawContentScrollTop = input.contentScrollTop;
  const contentScrollTop =
    typeof rawContentScrollTop === "number" &&
    Number.isFinite(rawContentScrollTop) &&
    rawContentScrollTop >= 0
      ? Math.floor(rawContentScrollTop)
      : 0;

  const rawRowsScrollTop = input.rowsScrollTop;
  const rowsScrollTop =
    typeof rawRowsScrollTop === "number" &&
    Number.isFinite(rawRowsScrollTop) &&
    rawRowsScrollTop >= 0
      ? Math.floor(rawRowsScrollTop)
      : 0;

  return {
    sampleId,
    configA: isLabConfigName(input.configA) ? input.configA : LAB_VIEW_DEFAULTS.configA,
    configB: isLabConfigName(input.configB) ? input.configB : LAB_VIEW_DEFAULTS.configB,
    threshold,
    contentScrollTop,
    rowsScrollTop,
  };
}

/** 非法 JSON / 非对象 / 数组 / 空串一律回默认值；缺字段逐个回退默认。 */
export function parseLabViewState(raw: string | null): LabViewState {
  if (raw === null || raw.trim() === "") return { ...LAB_VIEW_DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...LAB_VIEW_DEFAULTS };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...LAB_VIEW_DEFAULTS };
  }
  return normalizeLabView(parsed as Record<string, unknown>);
}

/** 稳定字段顺序（与类型定义一致），写入前同样归一化，保证读回的结果与写入一致。 */
export function serializeLabViewState(state: LabViewState): string {
  return JSON.stringify(normalizeLabView(state));
}

/** 读取 + 解析；storage 不可用（隐私模式、配额、被拦截）时回退默认值。 */
export function readLabViewState(storage: Pick<Storage, "getItem">): LabViewState {
  let raw: string | null | undefined;
  try {
    raw = storage.getItem(LAB_VIEW_STORAGE_KEY);
  } catch {
    return { ...LAB_VIEW_DEFAULTS };
  }
  return parseLabViewState(raw ?? null);
}

/** 序列化 + 写入；写失败静默忽略，视图状态丢失不影响验收台可用。 */
export function writeLabViewState(storage: Pick<Storage, "setItem">, state: LabViewState): void {
  try {
    storage.setItem(LAB_VIEW_STORAGE_KEY, serializeLabViewState(state));
  } catch {
    // Best-effort persistence only.
  }
}
