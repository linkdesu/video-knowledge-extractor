/**
 * 顶层视口布局不变量：`video-notes` 的 `.vn-shell` / `.vn-aside` 必须恒等于
 * `window.innerHeight`（±2px）；任务浮层打开时 `.vn-content` 的底部留白必须
 * 盖住浮层本体（`bannerHeight + 32`），且不低于 240px 的绝对下限。
 * doctor 用这些纯函数判定，非空即 hard fail。
 */
export type ViewportSample = { innerHeight: number; shellHeight: number; asideHeight: number };

export const VIEWPORT_TOLERANCE_PX = 2;
/** 浮层高度之外还需要的呼吸空间（底部 16px + 顶部 16px）。 */
export const JOB_INSET_GAP_PX = 32;
/** 留白的绝对下限；矮窗口下组件自己会把下限降到 240，doctor 只认这个下限。 */
export const JOB_INSET_MIN_FLOOR_PX = 240;

/** 断言 .vn-shell / .vn-aside 高度恒等于 window.innerHeight（±2px）。返回人类可读的问题列表，空数组=通过。 */
export function viewportProblems(sample: ViewportSample): string[] {
  const problems: string[] = [];
  const check = (name: string, height: number): void => {
    if (height < 0) {
      problems.push(`${name} not found (height ${height})`);
      return;
    }
    const delta = Math.abs(height - sample.innerHeight);
    if (delta > VIEWPORT_TOLERANCE_PX) {
      problems.push(`${name} height ${height} != innerHeight ${sample.innerHeight} (Δ${delta})`);
    }
  };
  check(".vn-shell", sample.shellHeight);
  check(".vn-aside", sample.asideHeight);
  return problems;
}

/**
 * 浮层打开时 `.vn-content` 的底部留白必须盖住浮层本体：`>= bannerHeight + 32`
 * 且 `>= 240`。只看固定 360 会把「浮层比留白还高」的回归放过去，所以按实测高度判。
 */
export function jobPaddingProblems(input: {
  hasJob: boolean;
  contentPaddingBottom: number;
  bannerHeight: number;
}): string[] {
  if (!input.hasJob) return [];
  const problems: string[] = [];
  if (input.bannerHeight < 0) {
    problems.push("[data-testid=job-banner] not found while the job overlay is open");
    return problems;
  }
  const needed = Math.max(JOB_INSET_MIN_FLOOR_PX, Math.ceil(input.bannerHeight) + JOB_INSET_GAP_PX);
  if (input.contentPaddingBottom + VIEWPORT_TOLERANCE_PX < needed) {
    problems.push(
      `.vn-content padding-bottom ${input.contentPaddingBottom} < ${needed} (banner ${input.bannerHeight}px + ${JOB_INSET_GAP_PX}px, floor ${JOB_INSET_MIN_FLOOR_PX}px) while the job overlay is open`,
    );
  }
  return problems;
}
