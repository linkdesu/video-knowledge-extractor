import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, ftruncateSync, closeSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { join, resolve, basename } from "node:path";
import type { DownloadSnapshot, ModelBundle, ModelsStatus } from "./catalog";
import { MODEL_BUNDLES, modelStatus } from "./catalog";
import { assertInsideModelDir, extractArchive, listStagedInstalls, streamSha256 } from "./extract";
import { verifyBundle } from "./verify";
import { acquireModelLock } from "./oplock";

export type HttpResponse = { status: number; headers: Headers; body: ReadableStream<Uint8Array> };
export type FetchImpl = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<HttpResponse>;

export type DownloadProgress = (snapshot: DownloadSnapshot) => void;
export type DownloadLogLine = { level: "info" | "warn" | "error"; text: string };

/** 进度日志字节数格式（与 renderer 的 fmtBytes 同规则；core 不依赖 renderer）。 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

type Sidecar = {
  url: string;
  etag?: string;
  lastModified?: string;
  totalBytes?: number;
};

function partPath(modelDir: string, bundle: ModelBundle): string {
  return join(modelDir, ".downloads", `${bundle.id}.part`);
}

function sidecarPathFor(part: string): string {
  return `${part}.json`;
}

function readSidecar(path: string): Sidecar | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Sidecar>;
    if (typeof parsed.url !== "string") return null;
    return {
      url: parsed.url,
      etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
      lastModified: typeof parsed.lastModified === "string" ? parsed.lastModified : undefined,
      totalBytes: typeof parsed.totalBytes === "number" ? parsed.totalBytes : undefined,
    };
  } catch {
    return null;
  }
}

function writeSidecar(path: string, sidecar: Sidecar): void {
  writeFileSync(path, JSON.stringify(sidecar, null, 2));
}

function partSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * 按包下载（ADR-0015 §4）：断点续传（.part + .part.json，Range/If-Range），
 * 落盘后校验并按包原子安装。tar.bz2 包走安全解包；单文件直接校验后 rename。
 * hash 失败删 .part、sidecar 与 staging，本次立即失败，不自动重试。
 */
export async function downloadBundle(
  modelDirArg: string,
  bundle: ModelBundle,
  input: { fetchImpl?: FetchImpl; onProgress?: DownloadProgress; onLog?: (line: DownloadLogLine) => void; signal?: AbortSignal } = {},
): Promise<ModelsStatus> {
  const fetchImpl: FetchImpl =
    input.fetchImpl ?? ((url, init) => fetch(url, init) as Promise<HttpResponse>);
  const signal = input.signal ?? new AbortController().signal;
  const modelDir = resolve(modelDirArg);
  for (const spec of bundle.files) assertInsideModelDir(modelDir, spec.path);
  const part = partPath(modelDir, bundle);
  const sidecarPath = sidecarPathFor(part);
  mkdirSync(join(modelDir, ".downloads"), { recursive: true });

  // 有 .part 但没有 sidecar：没有来源信息，不能安全续传，从零开始
  let sidecar = readSidecar(sidecarPath);
  let haveBytes = partSize(part);
  if (sidecar === null && haveBytes > 0) {
    rmSync(part, { force: true });
    haveBytes = 0;
  }
  if (sidecar === null) {
    sidecar = { url: bundle.source.url };
    writeSidecar(sidecarPath, sidecar);
  }

  const stagingDir = join(modelDir, ".downloads", `${bundle.id}.staging`);
  const totalBytes = (): number => sidecar.totalBytes ?? 0;
  const log = (level: DownloadLogLine["level"], text: string): void => input.onLog?.({ level, text });
  const loggedMilestones = new Set<number>();
  const emit = (state: DownloadSnapshot["state"], received: number, message: string | null): void => {
    input.onProgress?.({
      state,
      bundleId: bundle.id,
      receivedBytes: received,
      totalBytes: totalBytes(),
      percent: totalBytes() > 0 ? Math.min(100, Math.round((received * 100) / totalBytes())) : null,
      message,
    });
  };
  const manifestBytes = bundle.files.reduce((sum, f) => sum + f.bytes, 0);
  const logProgress = (received: number): void => {
    const total = totalBytes() > 0 ? totalBytes() : manifestBytes;
    if (total <= 0) return;
    const milestone = Math.floor(Math.min(100, (received * 100) / total) / 10) * 10;
    if (milestone === 0 || loggedMilestones.has(milestone)) return;
    loggedMilestones.add(milestone);
    log("info", `下载 ${bundle.title} ${milestone}%（${received}/${total}）`);
  };
  log("info", `开始下载 ${bundle.title}（${fmtBytes(manifestBytes)}）`);
  if (haveBytes > 0) log("info", `续传：从 ${haveBytes} 继续`);
  try {
    await downloadWithResume(fetchImpl, part, sidecarPath, sidecar, haveBytes, signal, emit, logProgress);
    logProgress(partSize(part));
    emit("verifying", partSize(part), `校验 ${bundle.title}…`);
    log("info", `校验 ${bundle.title} sha256`);
    if (bundle.source.kind === "tar.bz2") {
      rmSync(stagingDir, { recursive: true, force: true });
      mkdirSync(stagingDir, { recursive: true });
      emit("verifying", partSize(part), `解压 ${bundle.title}…`);
      log("info", `解压 ${basename(new URL(bundle.source.url).pathname)}`);
      await extractArchive(part, stagingDir, bundle);
      // staging 里就是清单相对路径本身，直接按清单校验
      await verifyBundle(stagingDir, [bundle]);
    } else {
      const sha = await streamSha256(part);
      const spec = bundle.files[0];
      if (spec === undefined) throw new Error(`包 ${bundle.id} 没有文件`);
      if (sha !== spec.sha256) throw new Error(`sha256 不符（期望 ${spec.sha256.slice(0, 12)}…，实际 ${sha.slice(0, 12)}…）`);
    }

    emit("installing", partSize(part), `安装 ${bundle.title}…`);
    log("info", `安装 ${bundle.title}`);
    await installBundle(modelDir, bundle, stagingDir, part);

    rmSync(part, { force: true });
    rmSync(sidecarPath, { force: true });
    rmSync(stagingDir, { recursive: true, force: true });
    // 校验结果写进进程内缓存，modelStatus 直接 ready
    await verifyBundle(modelDir, [bundle]);
    emit("done", totalBytes(), null);
    log("info", `完成 ${bundle.title}`);
    return modelStatus(modelDirArg, [bundle]);
  } catch (err) {
    // hash/解包/安装失败：删 .part、sidecar 与 staging，下一次从零下载
    rmSync(part, { force: true });
    rmSync(sidecarPath, { force: true });
    rmSync(stagingDir, { recursive: true, force: true });
    const message = err instanceof Error ? err.message : String(err);
    emit("failed", 0, message.length > 200 ? message.slice(0, 200) : message);
    throw err;
  }
}

/** 多文件包的顶级目录名（单文件包返回 [""]）。 */
function topDirsOf(bundle: ModelBundle): string[] {
  if (bundle.files.length === 1 && (bundle.files[0]?.path ?? "").indexOf("/") === -1) return [""];
  return [...new Set(bundle.files.map((f) => (f.path.split("/")[0] ?? "")))];
}

/** 续传协议（ADR-0015 §4）：206 校起点与总长后 append；200 截断重写；416 当候选完整文件返回。 */
async function downloadWithResume(
  fetchImpl: FetchImpl,
  part: string,
  sidecarPath: string,
  sidecar: Sidecar,
  startBytes: number,
  signal: AbortSignal,
  emit: (state: DownloadSnapshot["state"], received: number, message: string | null) => void,
  onProgress: (received: number) => void,
): Promise<void> {
  emit("downloading", startBytes, null);
  const headers: Record<string, string> = {};
  if (startBytes > 0) {
    headers.Range = `bytes=${startBytes}-`;
    // If-Range 只在有 ETag 或 Last-Modified 时才发
    if (sidecar.etag !== undefined) headers["If-Range"] = sidecar.etag;
    else if (sidecar.lastModified !== undefined) headers["If-Range"] = sidecar.lastModified;
  }
  const response = await fetchImpl(sidecar.url, { method: "GET", headers, signal });
  const etag = response.headers.get("ETag") ?? undefined;
  const lastModified = response.headers.get("Last-Modified") ?? undefined;
  if (response.status === 416) {
    // 服务端认为 .part 已是完整文件：外层按候选完整文件校验（失败则删 part 从零下载）
    return;
  }
  if (response.status === 206) {
    const contentRange = response.headers.get("Content-Range") ?? "";
    const match = contentRange.match(/^bytes (\d+)-(\d+|)\/(\d+|)$/);
    const start = match !== null ? Number(match[1]) : NaN;
    const total = match !== null && match[3] !== "" ? Number(match[3]) : NaN;
    if (start !== startBytes) throw new Error(`206 响应起点 ${start} 与本地 ${startBytes} 不符，续传失败`);
    if (!Number.isNaN(total) && sidecar.totalBytes !== undefined && total !== sidecar.totalBytes) {
      throw new Error(`206 响应总长 ${total} 与已知 ${sidecar.totalBytes} 不符，续传失败`);
    }
    if (!Number.isNaN(total)) sidecar.totalBytes = total;
  }
  if (response.status === 200) {
    // 服务端忽略 Range：截断 .part 从头写
    truncatePart(part);
    const contentLength = Number(response.headers.get("Content-Length") ?? NaN);
    if (Number.isFinite(contentLength)) sidecar.totalBytes = contentLength;
  }
  if (response.status !== 206 && response.status !== 200) {
    throw new Error(`下载 ${sidecar.url} 得到意外状态 ${response.status}`);
  }
  sidecar.etag = etag !== undefined ? etag : sidecar.etag;
  sidecar.lastModified = lastModified !== undefined ? lastModified : sidecar.lastModified;
  writeSidecar(sidecarPath, sidecar);
  await pipeToBody(response.body, part, response.status === 206, startBytes, onProgress);
}

function truncatePart(part: string): void {
  try {
    const handle = openSync(part, "w");
    try {
      ftruncateSync(handle, 0);
    } finally {
      closeSync(handle);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function pipeToBody(
  body: ReadableStream<Uint8Array>,
  file: string,
  append: boolean,
  baseBytes: number,
  onProgress: (received: number) => void,
): Promise<void> {
  await new Promise<void>((resolvePipe, rejectPipe) => {
    const out = createWriteStream(file, { flags: append ? "a" : "w" });
    out.on("error", rejectPipe);
    out.on("finish", () => resolvePipe());
    let received = baseBytes;
    (async (): Promise<void> => {
      for await (const chunk of body) {
        if (chunk !== undefined) {
          if (!out.write(Buffer.from(chunk))) {
            await new Promise<void>((r) => out.once("drain", r));
          }
          received += chunk.length;
          onProgress(received);
        }
      }
      out.end();
    })().catch(rejectPipe);
  });
}

/** 按包原子安装：多文件「旧目录 → .old-<uuid> → .new 改名 → 删 .old」；单文件直接 rename。 */
async function installBundle(modelDir: string, bundle: ModelBundle, stagingDir: string, part: string): Promise<void> {
  if (bundle.files.length === 1 && (bundle.files[0]?.path ?? "").indexOf("/") === -1) {
    renameSync(part, join(modelDir, bundle.files[0]?.path ?? ""));
    return;
  }
  const suffix = randomUUID();
  for (const topDir of topDirsOf(bundle)) {
    const finalDir = join(modelDir, topDir);
    const newDir = join(modelDir, `${topDir}.new-${suffix}`);
    const oldDir = join(modelDir, `${topDir}.old-${suffix}`);
    const stagedTop = join(stagingDir, topDir);
    mkdirSync(newDir, { recursive: true });
    for (const file of bundle.files.filter((f) => (f.path.split("/")[0] ?? "") === topDir)) {
      renameSync(join(stagedTop, file.path.slice(topDir.length + 1)), join(newDir, file.path.slice(topDir.length + 1)));
    }
    if (existsSync(finalDir)) renameSync(finalDir, oldDir);
    renameSync(newDir, finalDir);
    rmSync(oldDir, { recursive: true, force: true });
  }
}

/**
 * 启动恢复（ADR-0015 §4）：最终目录缺失且 .new-* 存在 → 前滚改名；
 * 否则 .old-* 存在 → 回滚改名。两种情况都清理多余 staging。
 * .new-* 的完整性在创建时已按清单校验过，这里按存在性判定。
 */
export function recoverModelDir(modelDirArg: string): void {
  const modelDir = resolve(modelDirArg);
  const staged = listStagedInstalls(modelDir);
  const handled = new Set<string>();
  for (const entry of staged) {
    if (entry.kind !== "new" || handled.has(entry.topDir)) continue;
    handled.add(entry.topDir);
    const newDir = join(modelDir, `${entry.topDir}.new-${entry.suffix}`);
    const finalDir = join(modelDir, entry.topDir);
    if (existsSync(newDir) && !existsSync(finalDir)) renameSync(newDir, finalDir);
  }
  const rolledBack = new Set<string>();
  for (const entry of staged) {
    if (entry.kind !== "old" || handled.has(entry.topDir) || rolledBack.has(entry.topDir)) continue;
    rolledBack.add(entry.topDir);
    const oldDir = join(modelDir, `${entry.topDir}.old-${entry.suffix}`);
    const finalDir = join(modelDir, entry.topDir);
    if (existsSync(oldDir) && !existsSync(finalDir)) renameSync(oldDir, finalDir);
  }
  // final 存在后残留的 staging（如回滚后多余的 .new-*）删掉
  for (const entry of staged) {
    if (existsSync(join(modelDir, entry.topDir))) {
      rmSync(join(modelDir, `${entry.topDir}.${entry.kind === "new" ? "new" : "old"}-${entry.suffix}`), { recursive: true, force: true });
    }
  }
}

/**
 * 多包下载入口（ADR-0015 §4）：整个过程只取一次模型锁，启动前先 recoverModelDir；
 * 按清单顺序逐包下载，跳过已 ready 的包；某包失败立即停止，已安装的包保留，
 * 错误抛给调用方。进度快照按包发出（bundleId/received/total/state）。
 */
export async function downloadModels(
  modelDirArg: string,
  opts: {
    bundles?: readonly ModelBundle[];
    fetchImpl?: FetchImpl;
    onProgress?: DownloadProgress;
    onLog?: (line: DownloadLogLine) => void;
    signal?: AbortSignal;
  } = {},
): Promise<ModelsStatus> {
  const lock = acquireModelLock(modelDirArg);
  try {
    recoverModelDir(modelDirArg);
    const bundles = opts.bundles ?? MODEL_BUNDLES;
    for (const bundle of bundles) {
      if (modelStatus(modelDirArg, [bundle]).ready) continue;
      await downloadBundle(modelDirArg, bundle, opts);
    }
  } finally {
    lock.release();
  }
  return modelStatus(modelDirArg, opts.bundles ?? MODEL_BUNDLES);
}
