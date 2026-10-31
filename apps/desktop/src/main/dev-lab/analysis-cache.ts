/**
 * Lab 分析缓存（r53）：键 = 源内容指纹（流式 sha256）+ 规范化分析参数 + schema 版本。
 *
 * 条目就是 `<labRoot>/<键>/`：worker 先把整套产物写进 `<labRoot>/.tmp/…`，成功后整目录
 * rename 到位，所以「目录存在且自检通过」= 命中；半截目录永远不可能出现在键路径上。
 * 命中路径不碰模型、不解码，只读 JSON 与 wav。
 */
import { createHash } from "node:crypto";
import { closeSync, cpSync, createReadStream, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import { DIARIZATION_TUNING, SILENCE_DETECTION, logger, modelFileSpecs, type ModelRole } from "@video-notes/core";
import { REFINE_DEFAULTS } from "./refine";

/** 缓存 schema：产物格式或参数口径变了就 +1，旧条目自然全部 miss。 */
export const LAB_CACHE_SCHEMA = 1;

/** 段级解码前后各多取的秒数；进键（改它会改 segtext）。 */
export const LAB_SEGMENT_PADDING_SECONDS = 0.1;
/** 短于这个秒数的段不做嵌入（保留 null 占位）；进键。 */
export const LAB_EMBED_MIN_SECONDS = 0.1;

export type LabSourceMode = "file" | "dir";

/**
 * 一次 Lab 分析的全部输入参数，按「对象键排序」序列化进键。
 * 模型用文件名 + 大小 + mtime 标识：换模型/重下同名模型都会改键，跨机器时 mtime 不同（S3 共享缓存再换内容哈希）。
 */
export type LabAnalysisParams = {
  schema: number;
  mode: LabSourceMode;
  models: { role: ModelRole; file: string; size: number | null; mtimeMs: number | null }[];
  tuning: {
    segmentPaddingSeconds: number;
    embedMinSeconds: number;
    diarization: {
      windowShiftRatio: number;
      threshold: number;
      minDurationOn: number;
      minDurationOff: number;
    };
    /** silencedetect 的 noise/d 阈值：它们决定 silences.json，进而决定字幕行切分。 */
    silence: { noiseDb: number; minSilenceSeconds: number };
    /** 二次聚类的参数；maxK 就是说话人数上限。 */
    refine: { seedSeconds: number; maxK: number; fallbackCut: number };
    /** 说话人数：null = 由聚类自适应决定（Lab 目前没有手动指定入口）。 */
    speakerCount: number | null;
  };
};

/** 写进 sample.json 的分析戳：键 + schema + 源指纹 + 规范化参数（审计用）。 */
export type LabAnalysisStamp = {
  key: string;
  schema: number;
  sourceHash: string;
  params: LabAnalysisParams;
};

export function labAnalysisParams(input: { mode: LabSourceMode; modelDir: string; speakerCount?: number | null }): LabAnalysisParams {
  return {
    schema: LAB_CACHE_SCHEMA,
    mode: input.mode,
    models: modelFileSpecs(input.modelDir).map((spec) => {
      // 模型缺失时记 null：键因此不可能等于「模型齐全」时写下的条目，命中不会绕过加载失败。
      let size: number | null = null;
      let mtimeMs: number | null = null;
      try {
        const stat = statSync(spec.path);
        size = stat.size;
        mtimeMs = Math.round(stat.mtimeMs);
      } catch {
        // 缺模型
      }
      return { role: spec.role, file: basename(spec.path), size, mtimeMs };
    }),
    tuning: {
      segmentPaddingSeconds: LAB_SEGMENT_PADDING_SECONDS,
      embedMinSeconds: LAB_EMBED_MIN_SECONDS,
      diarization: { ...DIARIZATION_TUNING },
      silence: { ...SILENCE_DETECTION },
      refine: { ...REFINE_DEFAULTS },
      speakerCount: input.speakerCount ?? null,
    },
  };
}

/** 递归按对象键排序的 JSON；数组保持顺序（顺序本身是语义）。 */
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map(normalize);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input as Record<string, unknown>).sort()) {
      out[key] = normalize((input as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

/** 键：32 位十六进制（也是样本目录名，满足 `[a-z0-9]+`）。 */
export function labAnalysisKey(params: LabAnalysisParams, sourceHash: string): string {
  return createHash("sha256").update(`${sourceHash}\u0000${canonicalJson(params)}`).digest("hex").slice(0, 32);
}

export type LabSourceFingerprint = { mode: LabSourceMode; hash: string };

/**
 * 源内容指纹：文件按字节流式 sha256；目录按「相对路径 + 大小 + 文件内容哈希」逐个流式计算。
 * 目录里的文件顺序按路径排序，与 readdir 返回顺序无关。
 */
export async function hashSourcePath(path: string): Promise<LabSourceFingerprint> {
  const stat = statSync(path);
  if (stat.isFile()) return { mode: "file", hash: await hashFile(path) };
  if (!stat.isDirectory()) throw new Error(`只能分析文件或目录：${path}`);
  const hash = createHash("sha256");
  for (const file of listDirFiles(path)) {
    hash.update(`${file.rel}\u0000${String(file.size)}\u0000`);
    for await (const chunk of createReadStream(file.path)) hash.update(chunk as Buffer);
    hash.update("\u0000");
  }
  return { mode: "dir", hash: hash.digest("hex") };
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function listDirFiles(root: string, rel = ""): { rel: string; path: string; size: number }[] {
  const dir = rel === "" ? root : join(root, rel);
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: { rel: string; path: string; size: number }[] = [];
  for (const entry of entries) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    const childPath = join(root, childRel);
    if (entry.isDirectory()) {
      out.push(...listDirFiles(root, childRel));
      continue;
    }
    // 指向文件的符号链接按文件算；指向目录的链接跳过（避免成环）。
    if (entry.isSymbolicLink() && !statSync(childPath).isFile()) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    out.push({ rel: childRel, path: childPath, size: statSync(childPath).size });
  }
  return out;
}

/** 条目自检结果：`hit` 为 null 时 `reason` 说明为什么按 miss 处理。 */
export type LabCacheProbe = { hit: { key: string; createdAt: string } | null; reason: string };

/**
 * 这一跑要不要查缓存（r55）：`cold` 模式与「强制重新生成」都不读已有条目，
 * 区别只在理由 —— 日志里必须能分辨是模式决定还是用户按了按钮。
 */
export type LabProbeDecision = { probe: true } | { probe: false; reason: "cold" | "forced" };

export function labProbeDecision(input: { reads: boolean; force?: boolean }): LabProbeDecision {
  if (input.force === true) return { probe: false, reason: "forced" };
  if (!input.reads) return { probe: false, reason: "cold" };
  return { probe: true };
}

type EntrySample = {
  id?: string;
  mode?: string;
  createdAt?: string;
  duration?: number;
  segments?: number;
  labelsFile?: string;
  anchorsFile?: string;
  analysis?: { key?: string; schema?: number };
};

/** 逐字段校验 parsed JSON 的对象形状；`in` + `typeof` 收窄，不用断言。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 起止秒数；segments/segtext/silences/embeddings 的每一行都必须有。 */
function isRange(value: Record<string, unknown>): boolean {
  return typeof value.start === "number" && typeof value.end === "number";
}

/** audio.wav 必须是 RIFF/WAVE 头且超过头长度：写坏或截断的 wav 不能算样本音频。 */
function hasWavAudio(path: string): boolean {
  try {
    if (statSync(path).size <= 44) return false;
    const head = Buffer.alloc(12);
    const fd = openSync(path, "r");
    try {
      if (readSync(fd, head, 0, 12, 0) < 12) return false;
    } finally {
      closeSync(fd);
    }
    return head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WAVE";
  } catch {
    return false;
  }
}

/**
 * 命中判定：sample.json 的键/schema/mode/必填字段对得上，且产物齐全、JSON 可解析、元素形状与条数自洽。
 * 判定口径与 readSample/load 真正消费的字段一一对应 —— 能命中就一定能加载，否则按 miss 重算。
 */
export function probeLabEntry(root: string, key: string, mode: LabSourceMode): LabCacheProbe {
  const dir = join(root, key);
  if (!existsSync(dir)) return { hit: null, reason: "missing" };
  try {
    const sample = readJson<EntrySample>(join(dir, "sample.json"));
    if (sample === undefined) return { hit: null, reason: "sample" };
    if (sample.analysis?.key !== key) return { hit: null, reason: "key" };
    if (sample.analysis.schema !== LAB_CACHE_SCHEMA) return { hit: null, reason: "schema" };
    if (sample.mode !== (mode === "dir" ? "experiment" : "computed")) return { hit: null, reason: "mode" };
    if (sample.id !== key) return { hit: null, reason: "id" };
    // readSample 直接 join 这两个文件名、并把 duration/segments 当展示字段：缺一个就加载不了。
    if (
      typeof sample.createdAt !== "string" ||
      typeof sample.duration !== "number" ||
      typeof sample.segments !== "number" ||
      typeof sample.labelsFile !== "string" ||
      typeof sample.anchorsFile !== "string"
    ) {
      return { hit: null, reason: "sample-fields" };
    }
    const segments = readJson<{ segments: unknown[] }>(join(dir, "segments.json"));
    if (segments === undefined || !Array.isArray(segments.segments)) return { hit: null, reason: "segments" };
    const expected = segments.segments.length;
    if (!segments.segments.every((s) => isObject(s) && isRange(s) && typeof s.speaker === "number")) {
      return { hit: null, reason: "segments" };
    }
    const segtext = readJson<{ rows: unknown[] }>(join(dir, "segtext.json"));
    if (
      segtext === undefined ||
      !Array.isArray(segtext.rows) ||
      segtext.rows.length !== expected ||
      !segtext.rows.every((r) => isObject(r) && isRange(r) && typeof r.text === "string")
    ) {
      return { hit: null, reason: "segtext" };
    }
    const silences = readJson<{ silences: unknown[] }>(join(dir, "silences.json"));
    if (
      silences === undefined ||
      !Array.isArray(silences.silences) ||
      !silences.silences.every((s) => isObject(s) && isRange(s))
    ) {
      return { hit: null, reason: "silences" };
    }
    if (mode === "file") {
      const embeddings = readJson<{ rows: unknown[] }>(join(dir, "embeddings.json"));
      if (
        embeddings === undefined ||
        !Array.isArray(embeddings.rows) ||
        embeddings.rows.length !== expected ||
        !embeddings.rows.every((r) => {
          if (!isObject(r) || !isRange(r) || !("v" in r)) return false;
          return r.v === null || Array.isArray(r.v);
        })
      ) {
        return { hit: null, reason: "embeddings" };
      }
      if (!hasWavAudio(join(dir, "audio.wav"))) return { hit: null, reason: "audio" };
    }
    // 登记过的伴生文件不仅要存在，还要是 load 能读的形状（坏 JSON 由外层 catch 记 broken）。
    for (const file of [sample.labelsFile, sample.anchorsFile]) {
      if (file === "") continue;
      if (!existsSync(join(dir, file))) return { hit: null, reason: "side-file" };
      const parsed = readJson<unknown>(join(dir, file));
      if (!isObject(parsed)) return { hit: null, reason: file === sample.labelsFile ? "labels" : "anchors" };
      if (file === sample.labelsFile) {
        const ok = Object.values(parsed).every((labels) => Array.isArray(labels) && labels.every((n) => typeof n === "number"));
        if (!ok) return { hit: null, reason: "labels" };
        continue;
      }
      const anchors = parsed.anchors;
      const ok =
        Array.isArray(anchors) &&
        anchors.every(
          (anchor) =>
            isObject(anchor) &&
            Array.isArray(anchor.ranges) &&
            anchor.ranges.every((range) => Array.isArray(range) && range.length === 2 && range.every((n) => typeof n === "number")),
        );
      if (!ok) return { hit: null, reason: "anchors" };
    }
    return { hit: { key, createdAt: sample.createdAt }, reason: "hit" };
  } catch (err) {
    return { hit: null, reason: `broken: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** worker 的落盘目录：`.tmp/<键>-XXXXXX`（mkdtemp 保证同毫秒也不同名），listSamples 会跳过它。 */
export function newEntryDir(root: string, key: string): string {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  return mkdtempSync(join(root, ".tmp", `${key}-`));
}

/**
 * rename 可以「等一等再试」的 errno：POSIX 的 ENOTEMPTY/EEXIST 是目标被别人的条目占着；
 * Windows 上目录 rename 撞已有目录报 EPERM/EACCES，句柄/杀软没放手也报这几个，统一在这里收口。
 * 重试方式按「目标此刻在不在」分流，绝不因为这类 errno 直接判失败。
 */
const RENAME_RETRY_CODES: Record<string, true> = {
  ENOTEMPTY: true,
  EEXIST: true,
  EPERM: true,
  EACCES: true,
  EBUSY: true,
};
/** 目标被别人的条目占着时的退避预算：竞争窗口只有几微秒，800 ms 已是它的一万倍。 */
const PUBLISH_CONTENTION_BUDGET_MS = 800;
/** 目标空着、rename 仍被句柄挡住（Windows 索引器/杀软）：实测几十到几百毫秒，给足 3 s。 */
const PUBLISH_HANDLE_BUDGET_MS = 3000;
/** readdir/rename 的瞬时抖动（防病毒、索引器、句柄未释放）：小步重试，真错误照抛。 */
const FS_TRANSIENT_CODES: Record<string, true> = {
  EBUSY: true,
  EAGAIN: true,
  EINTR: true,
  EMFILE: true,
  ENFILE: true,
};

/** 主进程是同步路径：只能用阻塞小睡（与 core 的 lock/library 同一做法）。 */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errnoCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "";
}

/** 包装发布/读目录失败的上下文，并把 errno 留在 `code` 上：调用方日志与测试诊断都能直接读到。 */
function publishError(message: string, err: unknown): Error {
  const code = errnoCode(err);
  const detail = err instanceof Error ? err.message : String(err);
  const wrapped = new Error(`${message}（errno=${code || "unknown"}）：${detail}`);
  return code === "" ? wrapped : Object.assign(wrapped, { code });
}

/**
 * 目录级 fsync：rename 之后必须把父目录刷盘，否则掉电后「键路径存在」可能不成立。
 * Windows 不允许对目录开 fsync（EPERM/EISDIR/EACCES），忽略即可 —— NTFS 的 rename 本身有日志。
 */
function fsyncPath(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // 目录 fsync 在 Windows 上不可用；文件 fsync 失败也只是少一层掉电保证，不该把分析判成失败。
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 已关闭
      }
    }
  }
}

/** readdir 的瞬时抖动（索引器、防病毒、句柄未释放）重试；用尽或真错误时带上路径与 errno 抛出，绝不静默跳过。 */
function readDirEntries(path: string): Dirent[] {
  for (let attempt = 0; ; attempt++) {
    try {
      return readdirSync(path, { withFileTypes: true });
    } catch (err) {
      const code = errnoCode(err);
      if (attempt >= 3 || FS_TRANSIENT_CODES[code] !== true) {
        throw publishError(`读目录失败：${path}`, err);
      }
      logger().debug("fs", "fsyncTree 读目录重试", { path, code, attempt });
      sleepMs(5 * (attempt + 1));
    }
  }
}

/** 递归 fsync 一个目录树里的所有文件，再 fsync 目录本身：发布前的落盘保证。 */
export function fsyncTree(root: string): void {
  for (const entry of readDirEntries(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      fsyncTree(path);
      continue;
    }
    fsyncPath(path);
  }
  fsyncPath(root);
}

/** 发布结果：自己的目录已经 rename 到位，或采用了对方已发布的条目。 */
type PublishOutcome = "published" | "adopted";

/**
 * 最终兜底，保证返回时键路径上有某一方的完整条目：
 *   1. 目标已有条目 → 采用它（"adopted"）；
 *   2. 目标空着、而我们手里还攥着自己挪走的条目 → 先补回（"adopted"）；
 *   3. 目标空着、补不回去（那条已被对方清掉）→ 把自己这份发布进去（"published"）；
 *   4. 都不成 → 带 errno 抛错，调用方按分析失败处理。
 * 窗口里读到「目标不存在」绝不能直接判失败：那只是对端发布过程中的一瞬（#85）；
 * Windows 上 EPERM/EACCES/EBUSY 是句柄还没放手，短退避重试而不是报错。
 */
function resolveContention(target: string, tmpDir: string, stales: string[]): PublishOutcome {
  if (existsSync(target)) return "adopted";
  const stolen = stales[stales.length - 1];
  if (stolen !== undefined) {
    try {
      renameSync(stolen, target);
      stales.pop();
      return "adopted";
    } catch {
      // 补不回去：对方可能刚补上，也可能已经把那条清掉 —— 下面按目标状态再判一次。
      if (existsSync(target)) return "adopted";
    }
  }
  const until = Date.now() + PUBLISH_HANDLE_BUDGET_MS / 6;
  let lastErr: unknown = null;
  do {
    try {
      renameSync(tmpDir, target);
      return "published";
    } catch (err) {
      lastErr = err;
      // 先看目标：对方在这几微秒里发布了，就采用它（无论我们这次撞的是什么 errno）。
      if (existsSync(target)) return "adopted";
      const code = errnoCode(err);
      if (RENAME_RETRY_CODES[code] !== true) break;
      sleepMs(25);
    }
  } while (Date.now() < until);
  throw publishError(`发布条目失败：${tmpDir} -> ${target}（收尾仍无法发布）`, lastErr);
}

/**
 * 竞争预算用尽后的收尾：目标上有对方 rename 到位的完整条目就采用它，空着就把自己 rename
 * 进去；收尾阶段再给一小段预算处理 Windows 的句柄延迟，仍谈不拢才交给 `resolveContention`。
 * 不再用一次 `existsSync(target)` 判死：那正是 #85 的竞争窗口。
 */
function settlePublishedEntry(target: string, tmpDir: string, attempts: number, lastCode: string): PublishOutcome {
  const settleDeadline = Date.now() + PUBLISH_HANDLE_BUDGET_MS / 3;
  while (Date.now() < settleDeadline) {
    if (existsSync(target)) return "adopted";
    try {
      renameSync(tmpDir, target);
      return "published";
    } catch (err) {
      const code = errnoCode(err);
      if (RENAME_RETRY_CODES[code] !== true) {
        throw publishError(`发布条目失败：${tmpDir} -> ${target}（第 ${attempts} 次后收尾）`, err);
      }
      lastCode = code;
      sleepMs(25);
    }
  }
  // 最后一次 rename 之后对方可能刚好发布完成：再裁决一次，不当成失败。
  if (existsSync(target)) return "adopted";
  throw new Error(
    `发布条目竞争超时：${tmpDir} -> ${target}（${attempts} 次 rename 后仍在竞争，errno=${lastCode}）`,
  );
}

/**
 * 原子发布：目录整体 rename 到键路径。已有旧条目（重算同一键）先挪到 `.tmp`。
 *
 * r54：多个 worktree（不同进程）可能同时发布同一个键。整目录 rename 是原子的，但「目标已存在」
 * 时 rename 会失败（POSIX ENOTEMPTY，Windows 上常见 EPERM/EACCES），所以竞争表现为：
 *   1. 双方都想把旧条目挪走；
 *   2. 一方 rename 到键路径后，另一方再 rename 就撞上「目录非空」。
 * 处理：「目标已被占」就把当前目标挪到 `.tmp` 再退避重试（EPERM/EACCES/EBUSY 只当句柄延迟、
 * 原地重试，不动别人的条目）；预算内一直抢不到就采用对方那份（同一个键 = 同一份内容）。
 *
 * r66 / #85：旧实现在「第 4 次失败时 existsSync(target)」下决定抛不抛错 —— 而对方「把条目挪走 →
 * 自己 rename 到位」之间 keep 着几毫秒的空窗，这个读到的 false 只是窗口的一瞬，据此抛错会把正常
 * 竞争报成分析失败（实测 ENOTEMPTY 偶发子进程退出 1）。现在预算用尽后不再靠 existsSync 判死：
 * `settlePublishedEntry` / `resolveContention` 会一直把「键路径上要有某一方的完整条目」落到实处。
 */
export function publishEntry(root: string, key: string, tmpDir: string): void {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const target = join(root, key);
  // 发布前先把自己这份刷盘：rename 只保证目录项顺序，不保证文件内容落盘。
  fsyncTree(tmpDir);
  const stales: string[] = [];
  const collisionDeadline = Date.now() + PUBLISH_CONTENTION_BUDGET_MS;
  const handleDeadline = Date.now() + PUBLISH_HANDLE_BUDGET_MS;
  let attempts = 0;
  let outcome: PublishOutcome | null = null;
  for (;;) {
    attempts++;
    try {
      renameSync(tmpDir, target);
      outcome = "published";
      break;
    } catch (err) {
      const code = errnoCode(err);
      if (RENAME_RETRY_CODES[code] !== true) {
        throw publishError(`发布条目失败：${tmpDir} -> ${target}（第 ${attempts} 次）`, err);
      }
      // 目标此刻有东西 = 被别人的条目占着（含 Windows 目录 rename 的 EPERM）：挪走再抢。
      // 目标空着 = 只是句柄还没放手：原地让一让，别动任何目录。
      const occupied = existsSync(target);
      if (Date.now() >= (occupied ? collisionDeadline : handleDeadline)) {
        try {
          outcome = settlePublishedEntry(target, tmpDir, attempts, code);
        } catch {
          // 收尾没谈拢：交给统一兜底再裁决一次；能采用/补回/发布就不算失败，
          // 真的落不下才由它抛出带 errno 的错误。
          outcome = resolveContention(target, tmpDir, stales);
        }
        break;
      }
      if (occupied) {
        const aside = join(root, ".tmp", `${key}-stale-${process.pid}-${Date.now()}-${attempts}`);
        try {
          renameSync(target, aside);
          stales.push(aside);
        } catch {
          // 对方刚把目标挪走/替换掉：直接重试即可
        }
        // 退避：不给对方留出「rename 到位」的缝隙，重试会一直撞空。
        // 前几次不睡：竞争通常几微秒就结束，空转重试比睡过去更快；连续撞空才让一让。
        if (attempts > 3) sleepMs(Math.min(attempts - 3, 5));
      } else {
        // 句柄/杀软还没放手：让 25 ms 再试，不挪动任何东西。
        sleepMs(25);
      }
    }
  }
  if (outcome === "adopted") {
    // 采用对方那份：先把可能被我们挪进 .tmp 的那条补回键路径，绝不留下「键路径不存在」。
    // 兜底也可能反过来把「我们自己这份」发布进去（对方条目已被清掉），那就没什么可丢的。
    if (resolveContention(target, tmpDir, stales) === "adopted") {
      discardEntryDir(tmpDir);
      logger().warn("fs", "Lab 缓存发布竞争：采用对方已发布的条目", { root, key, attempts });
    }
  }
  fsyncPath(root);
  for (const stale of stales) {
    // 新条目已经发布到位：旧目录删不掉只是 .tmp 残留，交给启动清扫，不能报成分析失败。
    try {
      rmSync(stale, { recursive: true, force: true });
    } catch {
      // 留到 sweepTempEntries
    }
  }
}

/**
 * 从别处（旧的分支级目录）搬一个条目到 root：先整目录复制进 `.tmp`，再走 publishEntry。
 * 目标是共享目录时调用；已存在且自检通过的条目不会被覆盖（先探再搬）。
 */
export function copyEntryInto(root: string, key: string, sourceDir: string): void {
  const staging = newEntryDir(root, key);
  try {
    cpSync(sourceDir, staging, { recursive: true, force: true, errorOnExist: false });
    publishEntry(root, key, staging);
  } catch (err) {
    discardEntryDir(staging);
    throw err;
  }
}

/** 失败/取消时清掉半成品目录。 */
export function discardEntryDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 清掉崩溃残留：`.tmp` 下超过一天的东西。 */
export function sweepTempEntries(root: string, maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()): string[] {
  const dir = join(root, ".tmp");
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // 删不掉留到下次
    }
  }
  return removed;
}
