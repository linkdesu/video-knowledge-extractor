/**
 * 顶层视口布局不变量：`video-notes` 的 `.vn-shell` / `.vn-aside` 必须恒等于
 * `window.innerHeight`（±2px）；任务浮层打开时 `.vn-content` 必须有 >= 360px
 * 的底部安全留白。doctor 用这些纯函数判定，非空即 hard fail。
 */
export type ViewportSample = { innerHeight: number; shellHeight: number; asideHeight: number };

export const VIEWPORT_TOLERANCE_PX = 2;
export const JOB_SAFE_PADDING_PX = 360;

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

/** 浮层打开时 .vn-content 必须有 >= JOB_SAFE_PADDING_PX 的底部内边距。 */
export function jobPaddingProblems(input: { hasJob: boolean; contentPaddingBottom: number }): string[] {
  if (!input.hasJob) return [];
  if (input.contentPaddingBottom < JOB_SAFE_PADDING_PX) {
    return [`.vn-content padding-bottom ${input.contentPaddingBottom} < ${JOB_SAFE_PADDING_PX} while the job overlay is open`];
  }
  return [];
}
