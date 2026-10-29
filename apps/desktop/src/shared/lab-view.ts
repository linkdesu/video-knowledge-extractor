/**
 * Lab 的纯视图计算（r48）：A/B 行对齐、摘要、筛选、跳转解析。
 * 只被验收台页面使用，不进入正式管线；放在 shared 以便 bun test 直接覆盖。
 */
import type { LabConfig, LabLine } from "./lab";
import { isFillerLine } from "./lab-fillers";

/** 标记键：行起点毫秒。跨方案重载后同一时间点仍对得上。 */
export function labLineKey(line: { start: number }): string {
  return String(Math.round(line.start * 1000));
}

export type LineAlignment = {
  /** B 方案的行（列表以此为准）。 */
  line: LabLine;
  /** 与该行重叠最多的 A 方案说话人；无重叠时 null。 */
  aSpeakerId: string | null;
  /** 重叠秒数（用于判断换手处）。 */
  overlap: number;
};

/** 按时间重叠把 A 方案说话人贴到 B 方案每一行上；一行只取重叠最多者。 */
export function alignLines(bLines: LabLine[], aLines: LabLine[]): LineAlignment[] {
  const sortedA = [...aLines].sort((x, y) => x.start - y.start);
  const out: LineAlignment[] = [];
  let cursor = 0;
  for (const line of [...bLines].sort((x, y) => x.start - y.start)) {
    while (cursor < sortedA.length && (sortedA[cursor]?.end ?? 0) <= line.start) cursor += 1;
    let best: { speakerId: string; overlap: number } | null = null;
    for (let i = cursor; i < sortedA.length; i += 1) {
      const a = sortedA[i];
      if (a === undefined) break;
      if (a.start >= line.end) break;
      const overlap = Math.min(a.end, line.end) - Math.max(a.start, line.start);
      if (overlap > 0 && (best === null || overlap > best.overlap)) best = { speakerId: a.speakerId, overlap };
    }
    out.push({ line, aSpeakerId: best?.speakerId ?? null, overlap: best?.overlap ?? 0 });
  }
  return out;
}

export type LabFilter = "all" | "diff" | "filtered" | "speaker";

export type LabRow = LineAlignment & {
  /** 该行整行是语气词且时长 <= 当前阈值。 */
  filler: boolean;
  /** 两方案说话人不同（含 B 侧被过滤而 A 未过滤）。 */
  diff: boolean;
  mark: "A" | "B" | "both" | null;
};

export type LabSummary = {
  speakersA: number;
  speakersB: number;
  hostA: number | null;
  hostB: number | null;
  filteredLines: number;
  filteredSeconds: number;
  diffLines: number;
  kA: number;
  kB: number;
  pickedA: string;
  pickedB: string;
};

/**
 * 摘要：说话人数取方案 meta（assignSpeakers 之后），过滤量与差异量按当前阈值现算。
 * `filteredOnly` 为 false 时（B 方案不含 filter）过滤量恒为 0。
 */
export function summarize(configA: LabConfig, configB: LabConfig, thresholdSeconds: number): LabSummary {
  const filterB = configB.name === "refine_filter";
  let filteredLines = 0;
  let filteredSeconds = 0;
  for (const line of configB.lines) {
    if (filterB && isFillerLine(line, thresholdSeconds)) {
      filteredLines += 1;
      filteredSeconds += line.end - line.start;
    }
  }
  const rows = buildRows(configA, configB, thresholdSeconds);
  return {
    speakersA: configA.meta.speakers,
    speakersB: configB.meta.speakers,
    hostA: configA.meta.hostClusters,
    hostB: configB.meta.hostClusters,
    filteredLines,
    filteredSeconds: Math.round(filteredSeconds * 10) / 10,
    diffLines: rows.filter((r) => r.diff).length,
    kA: configA.meta.k,
    kB: configB.meta.k,
    pickedA: configA.meta.picked,
    pickedB: configB.meta.picked,
  };
}

/** B 方案的行按当前阈值判语气词、与 A 对齐、算差异、贴标记。 */
export function buildRows(
  configA: LabConfig,
  configB: LabConfig,
  thresholdSeconds: number,
  marks: Record<string, string> = {},
): LabRow[] {
  const filterB = configB.name === "refine_filter";
  return alignLines(configB.lines, configA.lines).map((aligned) => {
    const { line } = aligned;
    const filler = filterB && isFillerLine(line, thresholdSeconds);
    // 同一时间点上 A 侧也被过滤时不算差异：两边都当它不存在。
    const aFiller = configA.name === "refine_filter" && isFillerLine(line, thresholdSeconds);
    const diff = aligned.aSpeakerId !== null && aligned.aSpeakerId !== line.speakerId;
    const filteredDiff = filler !== aFiller;
    const mark = marks[labLineKey(line)];
    return {
      ...aligned,
      filler,
      diff: diff || filteredDiff,
      mark: mark === "A" || mark === "B" || mark === "both" ? mark : null,
    };
  });
}

/** 筛选器：只影响可见行，不影响摘要。 */
export function filterRows(rows: LabRow[], filter: LabFilter, speakerId: string | null): LabRow[] {
  if (filter === "diff") return rows.filter((r) => r.diff);
  if (filter === "filtered") return rows.filter((r) => r.filler);
  if (filter === "speaker" && speakerId !== null) return rows.filter((r) => r.line.speakerId === speakerId);
  return rows;
}

/** 文本搜索：大小写不敏感，命中行文本或说话人编号。 */
export function searchRows(rows: LabRow[], query: string): LabRow[] {
  const q = query.trim().toLowerCase();
  if (q === "") return rows;
  return rows.filter((r) => r.line.text.toLowerCase().includes(q) || r.line.speakerId.toLowerCase().includes(q));
}

/**
 * 跳转输入：`13:14` / `1:02:03`（时间）或纯数字（行号，1-based）。
 * 时间取第一条覆盖该时刻的行（`contain` 关时取下一条起点不早于它的行）。
 */
export function parseJump(input: string, rows: LabRow[]): number | null {
  const raw = input.trim();
  if (raw === "") return null;
  if (/^\d+$/.test(raw)) {
    const index = Number(raw) - 1;
    return index >= 0 && index < rows.length ? index : null;
  }
  const m = raw.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/);
  if (m === null) return null;
  const hours = m[1] === undefined ? 0 : Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (minutes > 59 || seconds > 59) return null;
  return rowIndexAt(rows, hours * 3600 + minutes * 60 + seconds);
}

/** 时间轴 → 列表反向定位：覆盖该时刻的行；落在间隙里取其后第一行。 */
export function rowIndexAt(rows: LabRow[], seconds: number): number | null {
  if (rows.length === 0) return null;
  const covering = rows.findIndex((r) => r.line.start <= seconds && seconds < r.line.end);
  if (covering !== -1) return covering;
  const next = rows.findIndex((r) => r.line.start >= seconds);
  return next === -1 ? rows.length - 1 : next;
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
