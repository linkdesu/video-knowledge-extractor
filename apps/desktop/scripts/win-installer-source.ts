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
