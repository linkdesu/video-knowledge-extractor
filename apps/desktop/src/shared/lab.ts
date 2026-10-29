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

/** 差异行标记：B 对 / A 对 / 都错。键是行起点毫秒。 */
export type LabMark = "A" | "B" | "both";
export type LabMarks = Record<string, LabMark>;

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
  importPath(sourcePath: string): Promise<{ sampleId: string }>;
  onProgress(listener: (progress: LabProgress) => void): () => void;
  marks(sampleId: string): Promise<LabMarks>;
  saveMarks(sampleId: string, marks: LabMarks): Promise<LabMarks>;
};
