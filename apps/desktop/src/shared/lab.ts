/**
 * 开发模式「说话人分离验收台」（r48）的线上契约。
 * 只为 Lab 使用：打包版不注册这些通道，preload 也不暴露 `vnote.lab`。
 */

/** Lab 方案：sherpa 原始簇、二次聚类、二次聚类 + 语气词过滤。 */
export type LabConfigName = "baseline" | "refine" | "refine_filter";

export const LAB_CONFIGS: LabConfigName[] = ["baseline", "refine", "refine_filter"];

export const LAB_CONFIG_LABEL: Record<LabConfigName, string> = {
  baseline: "baseline（sherpa 原始簇）",
  refine: "refine（二次聚类）",
  refine_filter: "refine + filter",
};

/** 一个字幕行：某方案下 buildSpans → splitSpan → assignSpeakers 的结果。 */
export type LabLine = { start: number; end: number; speakerId: string; text: string };

export type LabSpeaker = {
  id: string;
  seconds: number;
  lines: number;
  /** 该簇最长的三段起点（秒），供「▶样例」依次试听。 */
  sampleStarts: number[];
};

export type LabConfigMeta = {
  /** 最终说话人数（assignSpeakers 之后）。 */
  speakers: number;
  /** 聚类阶段得到的簇数（baseline 为 sherpa 原始簇数）。 */
  k: number;
  picked: "sherpa" | "sil" | "bic1" | "fallback" | "given";
  silhouette: number | null;
  bicK: number | null;
  seeds: number | null;
  /** 主播锚点覆盖的簇数；样本没有锚点时 null。 */
  hostClusters: number | null;
};

export type LabConfig = { name: LabConfigName; meta: LabConfigMeta; speakers: LabSpeaker[]; lines: LabLine[] };

export type LabSampleMeta = {
  id: string;
  name: string;
  sourcePath: string;
  duration: number;
  createdAt: string;
  segments: number;
  /** computed：本机真实跑过分离/嵌入/段级解码；experiment：读取已有实验目录。 */
  mode: "computed" | "experiment";
  hasAudio: boolean;
  timings: Record<string, number>;
  anchors: number | null;
};

export type LabPayload = { sample: LabSampleMeta; configs: Record<LabConfigName, LabConfig>; audioUrl: string | null };

export type LabProgressStep = "extract" | "diarize" | "embed" | "decode" | "save" | "load";

export type LabProgress = {
  sampleId: string | null;
  step: LabProgressStep;
  done: number;
  total: number;
  detail: string | null;
};

/**
 * 行标注（r74 起「差异行标记」，r77 起每行一条记录）。键是行起点毫秒。
 *
 * `mark` 是唯一标记：A / B / both 回答「谁的说话人对」；三类问题类型换一个角度记 A/B 之外的错因。
 * `speaker` 是这一行的实际说话人（本录音说话人列表里的 id，如 `speaker-1`），与 `mark` 相互独立：
 * A/B 都标对的行仍可能被听成别人，一致行也可能整句归错，所以两个字段各自可空。
 *
 * 磁盘值域只增不减：r74–r76 写的是单个标记字符串，`normalizeMark` 读成 `{ mark }`，旧文件不需要迁移。
 */
export const LAB_MARK_VERDICTS = ["A", "B", "both"] as const;
export type LabMarkVerdict = (typeof LAB_MARK_VERDICTS)[number];

export const LAB_ISSUE_TYPES = ["overlap_wrong_speaker", "false_duplicate", "backchannel_not_ignored"] as const;
export type LabIssueType = (typeof LAB_ISSUE_TYPES)[number];

export type LabMark = LabMarkVerdict | LabIssueType;

/** 一行的人工标注记录：两个字段都可空；两个都空表示这一行没有标注。 */
export type LabLineNote = {
  mark?: LabMark;
  /** 实际说话人：只认本录音说话人列表里的 id（`speaker-<n>`）。 */
  speaker?: string;
};

export type LabMarks = Record<string, LabLineNote>;

export const LAB_MARK_LABEL: Record<LabMark, string> = {
  A: "A 对",
  B: "B 对",
  both: "都错",
  overlap_wrong_speaker: "重叠归错人",
  false_duplicate: "误判重复",
  backchannel_not_ignored: "未忽略回应语",
};

export function isLabMark(value: unknown): value is LabMark {
  return (
    typeof value === "string" &&
    ((LAB_MARK_VERDICTS as readonly string[]).includes(value) || (LAB_ISSUE_TYPES as readonly string[]).includes(value))
  );
}

/** 说话人 id 只来自 core 的 assignSpeakers：`speaker-<序号>`。 */
export function isLabSpeakerId(value: unknown): value is string {
  return typeof value === "string" && /^speaker-[1-9]\d{0,3}$/.test(value);
}

/**
 * 一个磁盘值 → 一条标注记录。三种写法都认：
 * - `"A"` / `"overlap_wrong_speaker"`：r74–r76 的单标记字符串；
 * - `{ mark, speaker }`：r77 起的记录；
 * - 其余（null、数字、数组、陌生字符串）→ `null`（调用方跳过，绝不改写）。
 * 空记录（两个字段都没有）也返回 `null`，避免在文件里留空对象。
 */
export function normalizeMark(raw: unknown): LabLineNote | null {
  if (typeof raw === "string") return isLabMark(raw) ? { mark: raw } : null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as { mark?: unknown; speaker?: unknown };
  const note: LabLineNote = {};
  if (isLabMark(record.mark)) note.mark = record.mark;
  if (isLabSpeakerId(record.speaker)) note.speaker = record.speaker;
  return note.mark === undefined && note.speaker === undefined ? null : note;
}

/**
 * 合并一条行标注（r77）。`undefined` 不动该字段，`null` 清掉该字段；
 * 两个字段都空时整条删除，文件里不留空对象。返回新 map，方便 React 直接换状态。
 */
export function mergeMark(
  marks: LabMarks,
  key: string,
  patch: { mark?: LabMark | null; speaker?: string | null },
): LabMarks {
  const next: LabLineNote = { ...marks[key] };
  if (patch.mark !== undefined) {
    if (patch.mark === null) delete next.mark;
    else next.mark = patch.mark;
  }
  if (patch.speaker !== undefined) {
    if (patch.speaker === null) delete next.speaker;
    else next.speaker = patch.speaker;
  }
  const out = { ...marks };
  if (next.mark === undefined && next.speaker === undefined) delete out[key];
  else out[key] = next;
  return out;
}

/** 一次导入的缓存结果（r55）：界面据此显示「命中 / 未命中」与耗时。 */
export type LabImportResult = {
  sampleId: string;
  /** true = 只读了条目里的 JSON：未加载模型、未解码音频。 */
  hit: boolean;
  /** `hit` / `missing` / `cold` / `forced` / 各类自检失败原因（`broken: …` 等）。 */
  reason: string;
  /** 计算源内容指纹的耗时（ms）。 */
  hashMs: number;
  /** 整个导入的耗时（ms）；命中时是毫秒级，未命中含真实分析。 */
  elapsedMs: number;
  /** 源内容指纹：同一指纹在缓存里只保留一份条目。 */
  sourceHash: string;
};

export type LabImportOptions = {
  /** 跳过缓存：不读旧条目，重新分析并用新结果覆盖（r55「强制重新生成」）。 */
  force?: boolean;
};

export const LAB_IPC = {
  available: "dev:lab:available",
  list: "dev:lab:list",
  load: "dev:lab:load",
  importPath: "dev:lab:import",
  marksGet: "dev:lab:marks:get",
  marksSet: "dev:lab:marks:set",
  progress: "dev:lab:progress",
} as const;

export type LabApi = {
  list(): Promise<LabSampleMeta[]>;
  load(sampleId: string): Promise<LabPayload>;
  importPath(sourcePath: string, options?: LabImportOptions): Promise<LabImportResult>;
  onProgress(listener: (progress: LabProgress) => void): () => void;
  marks(sampleId: string): Promise<LabMarks>;
  saveMarks(sampleId: string, marks: LabMarks): Promise<LabMarks>;
};
