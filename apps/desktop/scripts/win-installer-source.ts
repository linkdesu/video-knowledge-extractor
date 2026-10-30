/**
 * Windows 安装包来源判定：按「当前提交 + 当前 package 版本」对齐 CI 产物（r61 / #81）。
 *
 * 故障来源（r60 / #69）：install:local 取「最近一次成功的 windows-build 运行」，
 * 不看提交、不看版本，期望 0.1.19 时下载到 main 上 0.1.18 的产物。
 * 这里的规则：只认 headSha === 当前提交的成功运行；产物版本必须等于期望版本；
 * CI 还在跑就等，跑失败了/超时/只有旧提交就明确报错 —— 绝不回退去装旧包。
 *
 * 纯函数 + 依赖注入，便于测试；不做 IO。
 */

export interface WindowsBuildRun {
  databaseId: number;
  status: string;
  conclusion: string | null;
  headSha: string;
  displayTitle?: string;
}

export function installerName(version: string): string {
  return `Video Notes-${version}-setup.exe`;
}

/** 从产物文件清单里挑出期望版本的安装包；文件名里的版本就是产物版本。 */
export function assertArtifactVersion(
  files: string[],
  expected: { version: string; runId: number; headSha: string },
): string {
  const expectedName = installerName(expected.version);
  if (files.includes(expectedName)) return expectedName;

  const exeVersions = files
    .map((f) => /^Video Notes-(.+)-setup\.exe$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]!);
  const actual =
    exeVersions.length > 0
      ? `实际产物版本是 ${[...new Set(exeVersions)].join("、")}`
      : `产物里没有任何安装包（文件：${files.length > 0 ? files.join("、") : "(空)"}）`;
  throw new Error(
    `CI 产物版本不符：期望 v${expected.version} 的 ${expectedName}，但 run ${expected.runId}（${expected.headSha.slice(0, 7)}）${actual}。` +
      `请确认该提交已把四个 package.json 版本同步到 ${expected.version} 并等 Windows CI 重新构建完成（或本地打包后用 --win-installer 指定），本脚本不会退回去装旧版本。`,
  );
}

/** 只接受当前提交的已完成成功运行；没有就返回 null（调用方决定等待或报错）。 */
export function selectRunForCommit(
  runs: WindowsBuildRun[],
  expectedSha: string,
): WindowsBuildRun | null {
  return (
    runs.find(
      (r) =>
        r.headSha === expectedSha && r.status === "completed" && r.conclusion === "success",
    ) ?? null
  );
}

/** 与 `.github/workflows/windows-build.yml` 的 paths-ignore 保持一致。 */
export function isBuildRelevantPath(path: string): boolean {
  return !(path.endsWith(".md") || path === "docs" || path.startsWith("docs/"));
}

export interface ArtifactProvenance {
  schemaVersion: number;
  runId: number;
  headSha: string;
  /** CI 报告的 artifact zip 摘要（`sha256:<64 hex>`），可信来源的锚点。 */
  artifactDigest: string;
  /** CI 报告的 artifact zip 大小。 */
  artifactSizeBytes: number;
  /** artifact 里的安装包文件名。 */
  fileName: string;
  fileSizeBytes: number;
  /** 解压出来的安装包内容哈希：缓存命中前重算比对。 */
  fileSha256: string;
}

/** 缓存 provenance 的当前版本；r61 的 `{ runId, headSha }` 没有内容哈希，等同没有来源。 */
export const PROVENANCE_SCHEMA_VERSION = 2;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * JSON 边界守卫：解析出来的值只有过了这一关才允许按字段读。
 * 只证明「是对象」，字段形状由下面的 `in` / `typeof` 逐个核对。
 */
function isObjectShape(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 严格解析 `tmp/installer/v<version>/provenance.json`。
 * 任何字段缺失/形状不对都返回 null —— 认不出来就当没有来源，重下，不猜。
 */
export function parseArtifactProvenance(raw: unknown): ArtifactProvenance | null {
  if (!isObjectShape(raw)) return null;
  if (!("schemaVersion" in raw) || raw.schemaVersion !== PROVENANCE_SCHEMA_VERSION) return null;
  if (
    !("runId" in raw) ||
    typeof raw.runId !== "number" ||
    !Number.isInteger(raw.runId) ||
    raw.runId < 0
  ) {
    return null;
  }
  if (
    !("artifactSizeBytes" in raw) ||
    typeof raw.artifactSizeBytes !== "number" ||
    !Number.isInteger(raw.artifactSizeBytes) ||
    raw.artifactSizeBytes < 0
  ) {
    return null;
  }
  if (
    !("fileSizeBytes" in raw) ||
    typeof raw.fileSizeBytes !== "number" ||
    !Number.isInteger(raw.fileSizeBytes) ||
    raw.fileSizeBytes < 0
  ) {
    return null;
  }
  if (!("headSha" in raw) || typeof raw.headSha !== "string" || raw.headSha === "") return null;
  if (!("fileName" in raw) || typeof raw.fileName !== "string" || raw.fileName === "") return null;
  if (
    !("artifactDigest" in raw) ||
    typeof raw.artifactDigest !== "string" ||
    !DIGEST.test(raw.artifactDigest)
  ) {
    return null;
  }
  if (
    !("fileSha256" in raw) ||
    typeof raw.fileSha256 !== "string" ||
    !SHA256_HEX.test(raw.fileSha256)
  ) {
    return null;
  }
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    runId: raw.runId,
    artifactSizeBytes: raw.artifactSizeBytes,
    fileSizeBytes: raw.fileSizeBytes,
    headSha: raw.headSha,
    fileName: raw.fileName,
    artifactDigest: raw.artifactDigest,
    fileSha256: raw.fileSha256,
  };
}

/** 缓存目录里现有的安装包实测结果（大小 + sha256）。 */
export interface LocalArtifact {
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export interface CachedArtifactCheck {
  provenance: ArtifactProvenance | null;
  /** null = 缓存目录里没有这个文件。 */
  local: LocalArtifact | null;
  expectedFileName: string;
  headSha: string;
  /** 来源提交到 HEAD 的差异路径；`null` 表示算不出来（来源提交不在本地）。 */
  changedPaths: string[] | null;
  /** HEAD 自己那次 CI 运行（成功且构建的是本版本）；有则绝不用别的提交的缓存。 */
  headOwnRunId: number | null;
  /** 现查的该 run 的 CI 产物摘要；`null` = 查不到，无法与可信来源比对。 */
  ci: { runId: number; digest: string | null } | null;
}

export type CachedArtifactVerdict =
  | { usable: true; fromOtherCommit: boolean; summary: string }
  | { usable: false; reason: string };

/**
 * `tmp/installer/v<version>/` 里的缓存能不能直接用（r63 / #86）。
 *
 * r62 的故障：缓存只在下载时记录了 run id 与提交，命中时不再核对内容 ——
 * 于是被截断/替换过的 exe（或手写 provenance.json）会被静默装到 gamepc。
 * 现在的门槛，任何一条不过就删缓存重下：
 * 1. provenance 是带内容哈希的新格式；
 * 2. 目录里的 exe 存在、文件名对、大小与 sha256 与记录一致（篡改/半包在这里挂）；
 * 3. 现查 CI 该 run 的产物摘要与记录一致（把记录锚回可信来源）；
 * 4. HEAD 已有自己的 CI 产物时，绝不使用别的提交的缓存；
 * 5. 来源不是 HEAD 时，必须算得出差异且差异全是文档（构建输入相同），并明确报出来源。
 */
export function judgeCachedArtifact(input: CachedArtifactCheck): CachedArtifactVerdict {
  const prov = input.provenance;
  if (prov === null) {
    const reason = "缓存没有可解析的 provenance.json（来源无法核对）";
    return { usable: false, reason };
  }
  const local = input.local;
  if (local === null) {
    const reason = `缓存目录里没有 ${input.expectedFileName}`;
    return { usable: false, reason };
  }
  if (local.fileName !== input.expectedFileName || prov.fileName !== input.expectedFileName) {
    const reason = `缓存里的安装包名不符：期望 ${input.expectedFileName}，实际 ${local.fileName}（记录 ${prov.fileName}）`;
    return { usable: false, reason };
  }
  if (local.sizeBytes !== prov.fileSizeBytes) {
    const reason = `缓存文件大小与记录不符（文件不完整或被改动）：记录 ${prov.fileSizeBytes} 字节，实际 ${local.sizeBytes} 字节`;
    return { usable: false, reason };
  }
  if (local.sha256 !== prov.fileSha256) {
    const reason = `缓存文件内容与记录不符（文件被改动）：记录 sha256=${prov.fileSha256}，实际 sha256=${local.sha256}`;
    return { usable: false, reason };
  }
  if (input.ci === null || input.ci.digest === null) {
    const reason = `无法与 CI 产物摘要比对：查不到 run ${prov.runId} 的产物摘要（产物过期或未上报 digest），缓存内容不可信`;
    return { usable: false, reason };
  }
  if (input.ci.runId !== prov.runId) {
    const reason = `CI 产物摘要是 run ${input.ci.runId} 的，与记录的 run ${prov.runId} 不符`;
    return { usable: false, reason };
  }
  if (input.ci.digest !== prov.artifactDigest) {
    const reason = `CI 产物摘要与记录不符：CI 说 ${input.ci.digest}，记录是 ${prov.artifactDigest}（来源被改写）`;
    return { usable: false, reason };
  }

  const shortSha = prov.headSha.slice(0, 7);
  if (prov.headSha === input.headSha) {
    return {
      usable: true,
      fromOtherCommit: false,
      summary: `安装包来源：run ${prov.runId} @ ${shortSha}（HEAD 自己的 CI 产物），sha256=${prov.fileSha256}`,
    };
  }
  if (input.headOwnRunId !== null) {
    const reason = `HEAD 已有自己的 CI 产物（run ${input.headOwnRunId}），不使用旧提交 ${shortSha}（run ${prov.runId}）的缓存`;
    return { usable: false, reason };
  }
  if (input.changedPaths === null) {
    const reason = `来源提交 ${shortSha} 不在本地仓库，算不出与 HEAD ${input.headSha.slice(0, 7)} 的差异，无法确认构建输入相同`;
    return { usable: false, reason };
  }
  const relevant = input.changedPaths.filter(isBuildRelevantPath);
  if (relevant.length > 0) {
    const reason = `来源提交 ${shortSha} 与 HEAD ${input.headSha.slice(0, 7)} 之间有代码差异（${relevant.slice(0, 3).join("、")}${relevant.length > 3 ? " 等" : ""}），不能复用该产物`;
    return { usable: false, reason };
  }
  return {
    usable: true,
    fromOtherCommit: true,
    summary: `⚠ 安装包来自其他提交：run ${prov.runId} @ ${shortSha}（HEAD ${input.headSha.slice(0, 7)} 与之只差文档，构建输入相同），sha256=${prov.fileSha256}`,
  };
}

export interface CiArtifact {
  id: number;
  sizeInBytes: number;
  digest: string | null;
  expired: boolean;
}

/**
 * 从 `gh api .../runs/<id>/artifacts` 的 JSON 里按名字取产物（id + 摘要）。
 * 摘要缺失/过期时 digest 为 null，调用方必须把它当成「无法核对」，不能当成通过。
 */
export function pickRunArtifact(raw: unknown, name: string): CiArtifact | null {
  if (!isObjectShape(raw)) return null;
  if (!("artifacts" in raw)) return null;
  const list = raw.artifacts;
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (!isObjectShape(entry)) continue;
    if (!("name" in entry) || entry.name !== name) continue;
    if (!("id" in entry) || typeof entry.id !== "number") continue;
    const size = "size_in_bytes" in entry ? entry.size_in_bytes : undefined;
    const digest = "digest" in entry ? entry.digest : undefined;
    const expired = "expired" in entry ? entry.expired : undefined;
    return {
      id: entry.id,
      sizeInBytes: typeof size === "number" ? size : 0,
      digest: typeof digest === "string" && digest !== "" ? digest : null,
      expired: expired === true,
    };
  }
  return null;
}


/**
 * 末尾只改了文档时，workflow 因 paths-ignore 不会为 HEAD 起构建。
 * 只有当 HEAD 与某个已有成功运行之间的 diff 全部是不触发构建的路径时，
 * 才允许复用那次运行的产物 —— 构建输入逐字节相同，产物也就等价于 HEAD 的构建。
 */
export function pickReusableAncestorRun(
  runs: WindowsBuildRun[],
  headSha: string,
  ancestors: Array<{ sha: string; changedPaths: string[] }>,
): WindowsBuildRun | null {
  if (runs.some((r) => r.headSha === headSha)) return null;
  for (const ancestor of ancestors) {
    if (ancestor.sha === headSha) continue;
    if (ancestor.changedPaths.some(isBuildRelevantPath)) continue;
    const run = selectRunForCommit(runs, ancestor.sha);
    if (run !== null) return run;
  }
  return null;
}

export interface WaitRunOptions {
  expectedSha: string;
  expectedVersion: string;
  fetchRuns: () => WindowsBuildRun[];
  sleep: (ms: number) => void;
  now?: () => number;
  timeoutMs: number;
  pollMs: number;
  log?: (message: string) => void;
}

/**
 * 等到当前提交的 windows-build 成功完成为止。
 * - 该提交已有成功运行 → 直接返回
 * - 该提交正在排队/进行中 → 轮询等待，超时抛错
 * - 该提交构建失败 → 立即抛错（不重试、不回退）
 * - 完全没有该提交的运行 → 立即抛错，提示先推送/触发 CI
 */
export function waitForRunForCommit(opts: WaitRunOptions): WindowsBuildRun {
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const sha = opts.expectedSha.slice(0, 7);
  const log = opts.log ?? (() => {});

  for (;;) {
    const runs = opts.fetchRuns();
    const success = selectRunForCommit(runs, opts.expectedSha);
    if (success !== null) return success;

    const mine = runs.filter((r) => r.headSha === opts.expectedSha);
    const pending = mine.find((r) => r.status !== "completed");
    if (pending !== undefined) {
      if (now() - started + opts.pollMs > opts.timeoutMs) {
        throw new Error(
          `等待 Windows CI 超时（${Math.round(opts.timeoutMs / 1000)}s）：提交 ${sha} 的 windows-build 仍在 ${pending.status}（run ${pending.databaseId}），` +
            `v${opts.expectedVersion} 的安装包还没出来。请等 CI 完成后重跑，本脚本不会退回去装旧版本。`,
        );
      }
      log(
        `[win] 提交 ${sha} 的 windows-build 仍为 ${pending.status}（run ${pending.databaseId}），${Math.round(opts.pollMs / 1000)}s 后重试...`,
      );
      opts.sleep(opts.pollMs);
      continue;
    }

    const failed = mine.find((r) => r.status === "completed");
    if (failed !== undefined) {
      throw new Error(
        `提交 ${sha} 的 windows-build 结论为 ${failed.conclusion ?? "null"}（run ${failed.databaseId}），没有可用的 v${opts.expectedVersion} 安装包。` +
          `请修复后重新推送以触发构建，本脚本不会退回去装旧版本。`,
      );
    }

    throw new Error(
      `找不到提交 ${sha} 的 windows-build 运行记录，v${opts.expectedVersion} 的安装包还没构建。` +
        `请先推送该提交（workflow 只监听 main / feat* / fix* 分支）并等 CI 完成，或本地打包后用 --win-installer 指定；本脚本不会退回去装旧版本。`,
    );
  }
}
