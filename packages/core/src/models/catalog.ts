import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type ModelFileSpec = { path: string; sha256: string; bytes: number };
export type ModelBundle = {
  id: "asr" | "diarization" | "speaker-embedding" | "punctuation";
  title: string;
  files: ModelFileSpec[];
  source:
    | { kind: "tar.bz2"; url: string; members: string[] }
    | { kind: "file"; url: string; name: string };
};

// sha256 与字节数来自本机已下载文件的实测（ADR-0015 §4），是硬编码契约：
// 上游重新发布同名文件会让校验失败，必须更新 ADR 与清单，不能跳过校验。
const ASR_MODEL_DIR = "sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25";
const PUNCT_MODEL_DIR = "sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12";

export const MODEL_BUNDLES: readonly ModelBundle[] = [
  {
    id: "asr",
    title: "识别（FireRed ASR2 CTC）",
    files: [
      { path: `${ASR_MODEL_DIR}/model.int8.onnx`, sha256: "ca3dbabd82170110cc0b343c2890866d449984bc9cd92b9a18371ff80a81bb99", bytes: 775861420 },
      { path: `${ASR_MODEL_DIR}/tokens.txt`, sha256: "1bc613de2112d257e61a349c3e72d1b1a9cf19c33d3ca954197ad2171e5ea07b", bytes: 79172 },
    ],
    source: {
      kind: "tar.bz2",
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25.tar.bz2",
      members: [`${ASR_MODEL_DIR}/model.int8.onnx`, `${ASR_MODEL_DIR}/tokens.txt`],
    },
  },
  {
    id: "diarization",
    title: "说话人分离（PyAnnote 3.0）",
    files: [
      { path: "sherpa-onnx-pyannote-segmentation-3-0/model.onnx", sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079", bytes: 5992913 },
    ],
    source: {
      kind: "tar.bz2",
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
      members: ["sherpa-onnx-pyannote-segmentation-3-0/model.onnx"],
    },
  },
  {
    id: "speaker-embedding",
    title: "说话人嵌入（CAM++ 中文）",
    files: [
      { path: "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx", sha256: "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11", bytes: 28281138 },
    ],
    source: {
      kind: "file",
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
      name: "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
    },
  },
  {
    id: "punctuation",
    title: "标点（Punct CTC Transformer）",
    files: [
      { path: `${PUNCT_MODEL_DIR}/model.onnx`, sha256: "e93593a6dbd69a07f8734ef269dbe861a379755f8d1c8354719432116f2c44bd", bytes: 294372519 },
    ],
    source: {
      kind: "tar.bz2",
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12.tar.bz2",
      members: [`${PUNCT_MODEL_DIR}/model.onnx`],
    },
  },
];

export type ModelFileStatus = {
  path: string;
  present: boolean;
  bytes: number | null;
  expectedBytes: number;
  sha256: string;
  verified: boolean | null;
};
export type ModelBundleStatus = {
  id: ModelBundle["id"];
  title: string;
  state: "ready" | "unverified" | "missing" | "invalid";
  files: ModelFileStatus[];
};
export type DownloadSnapshot = {
  state: "idle" | "downloading" | "verifying" | "installing" | "done" | "failed" | "cancelled";
  bundleId: string | null;
  receivedBytes: number;
  totalBytes: number;
  percent: number | null;
  message: string | null;
};
export type ModelsStatus = {
  modelDir: string;
  locked: boolean;
  ready: boolean;
  bundles: ModelBundleStatus[];
  totalBytes: number;
  presentBytes: number;
  autoDownloadDisabled: boolean;
  download: DownloadSnapshot;
};

export type ImportResult = {
  installed: string[];
  rejected: { bundleId: string; reason: string }[];
  status: ModelsStatus;
};

/** 进程内校验结果缓存：key 含路径、字节数、mtime 与期望 hash，文件身份变化即失效。 */
const verifiedCache = new Map<string, boolean>();

/** 写回校验结果：下载/导入/校验成功后记住该身份（路径+字节+mtime+期望 hash）。 */
export function rememberVerified(absPath: string, bytes: number, mtimeMs: number, expectedSha: string, ok: boolean): void {
  verifiedCache.set(`${absPath}|${bytes}|${mtimeMs}|${expectedSha}`, ok);
}

/** 查校验缓存：未知身份返回 null（未校验），不是 false。 */
export function cachedVerified(absPath: string, bytes: number, mtimeMs: number, expectedSha: string): boolean | null {
  const value = verifiedCache.get(`${absPath}|${bytes}|${mtimeMs}|${expectedSha}`);
  return value === undefined ? null : value;
}

function statFile(path: string): { bytes: number; mtimeMs: number } | null {
  // 用 statSync 跟随符号链接：用户常把已有模型 symlink 进模型目录
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    return { bytes: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function fileStatus(absModelDir: string, spec: ModelFileSpec): ModelFileStatus {
  const absPath = resolve(absModelDir, spec.path);
  const info = statFile(absPath);
  if (info === null) {
    return { path: spec.path, present: false, bytes: null, expectedBytes: spec.bytes, sha256: spec.sha256, verified: null };
  }
  return {
    path: spec.path,
    present: true,
    bytes: info.bytes,
    expectedBytes: spec.bytes,
    sha256: spec.sha256,
    verified: cachedVerified(absPath, info.bytes, info.mtimeMs, spec.sha256),
  };
}

function bundleStatus(bundle: ModelBundle, absModelDir: string): ModelBundleStatus {
  const files = bundle.files.map((spec) => fileStatus(absModelDir, spec));
  const missing = files.some((f) => !f.present);
  const sizeMismatch = files.some((f) => f.present && f.bytes !== f.expectedBytes);
  const knownBad = files.some((f) => f.verified === false);
  const unverified = files.some((f) => f.present && f.bytes === f.expectedBytes && f.verified === null);
  // 优先级：已知校验失败 > 缺失/字节不符 > 未校验 > 全部校验通过
  const state = knownBad ? "invalid" : missing || sizeMismatch ? "missing" : unverified ? "unverified" : "ready";
  return { id: bundle.id, title: bundle.title, state, files };
}

export const MODEL_LOCK_FILE = ".vnote-models.lock";

/** 模型目录锁的绝对路径（oplock 与状态检查共用）。 */
export function modelLockPath(absModelDir: string): string {
  return resolve(absModelDir, MODEL_LOCK_FILE);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function modelDirLocked(absModelDir: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(modelLockPath(absModelDir), "utf8");
  } catch {
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid !== "number") return false;
    return processAlive(parsed.pid);
  } catch {
    return false;
  }
}

/** 只查存在与字节数；verified 取进程内缓存，不读磁盘算 hash（ADR-0015 §4）。 */
export function modelStatus(modelDirArg: string, bundles: readonly ModelBundle[] = MODEL_BUNDLES): ModelsStatus {
  const absModelDir = resolve(modelDirArg);
  const bundleStatuses = bundles.map((bundle) => bundleStatus(bundle, absModelDir));
  const totalBytes = bundles.reduce((sum, b) => sum + b.files.reduce((s, f) => s + f.bytes, 0), 0);
  const presentBytes = bundleStatuses.reduce(
    (sum, b) => sum + b.files.reduce((s, f) => s + (f.present && f.bytes === f.expectedBytes ? f.bytes : 0), 0),
    0,
  );
  return {
    modelDir: modelDirArg,
    locked: modelDirLocked(absModelDir),
    ready: bundleStatuses.every((b) => b.state === "ready"),
    bundles: bundleStatuses,
    totalBytes,
    presentBytes,
    autoDownloadDisabled: process.env.VNOTE_DISABLE_MODEL_DOWNLOAD === "1",
    download: { state: "idle", bundleId: null, receivedBytes: 0, totalBytes: 0, percent: null, message: null },
  };
}
