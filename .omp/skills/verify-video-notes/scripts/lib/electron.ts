/**
 * 全新 worktree 装不上 Electron（r58 验收 4）。
 *
 * `bun install` 在新 worktree 里只把 `node_modules/electron` 链接进来，不下载
 * `dist/`（也没有 `path.txt`），`up` 于是报 "Electron binary not found"。手工修法是
 * 跑一次包自带的 `install.js`，但验收脚本自己应该能修：先找现成二进制，找不到就补跑
 * install.js（连 electron 包都没有时先 `bun install`），仍然失败就把可以直接复制执行
 * 的命令和 stderr 尾巴一起报出来。
 */
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

export class ElectronBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElectronBootstrapError";
  }
}

export type CommandOutcome = { code: number; stderr: string };

export type ElectronDeps = {
  exists: (path: string) => boolean;
  run: (command: string[], cwd: string) => CommandOutcome;
  log: (line: string) => void;
};

export type ElectronCandidate = { binary: string; pkgDir: string };

export type ElectronBootstrapResult = {
  binary: string;
  /** 这次调用是否补装了 dist（state.json 与证据里要能看出来） */
  installed: boolean;
  /** 实际跑过的命令（相对仓库根，方便抄） */
  steps: string[];
};

const BINARY_RELATIVE = join("dist", "Electron.app", "Contents", "MacOS", "Electron");

/** 两个候选：workspace 包自己的 node_modules，和 hoist 到仓库根的 node_modules。 */
export function electronCandidates(repo: string, desktop: string): ElectronCandidate[] {
  return [join(desktop, "node_modules/electron"), join(repo, "node_modules/electron")].map((pkgDir) => ({
    binary: join(pkgDir, BINARY_RELATIVE),
    pkgDir,
  }));
}

export function findElectronBinary(
  repo: string,
  desktop: string,
  exists: (path: string) => boolean = existsSync,
): ElectronCandidate | null {
  return electronCandidates(repo, desktop).find((candidate) => exists(candidate.binary)) ?? null;
}

const realDeps: ElectronDeps = {
  exists: existsSync,
  run: (command, cwd) => {
    try {
      const probe = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
      return { code: probe.exitCode ?? -1, stderr: `${probe.stderr.toString()}${probe.stdout.toString()}` };
    } catch (err) {
      // spawn 本身失败（node 不在 PATH）当作 127，交给 bun 兜底
      return { code: 127, stderr: err instanceof Error ? err.message : String(err) };
    }
  },
  log: (line) => process.stderr.write(`verify: ${line}\n`),
};

function looksLikeMissingCommand(run: CommandOutcome): boolean {
  return run.code === 127 || /ENOENT/.test(run.stderr) || /not found/i.test(run.stderr);
}

export function ensureElectronBinary(repo: string, desktop: string, deps: ElectronDeps = realDeps): ElectronBootstrapResult {
  const found = findElectronBinary(repo, desktop, deps.exists);
  if (found !== null) return { binary: found.binary, installed: false, steps: [] };

  const steps: string[] = [];
  let candidates = electronCandidates(repo, desktop).filter((candidate) => deps.exists(join(candidate.pkgDir, "install.js")));
  if (candidates.length === 0) {
    deps.log("apps/desktop 的 Electron 包还没装（新 worktree）：先跑 bun install");
    deps.run(["bun", "install"], repo);
    steps.push("bun install");
    candidates = electronCandidates(repo, desktop).filter((candidate) => deps.exists(join(candidate.pkgDir, "install.js")));
    if (candidates.length === 0) {
      throw new ElectronBootstrapError(
        "Electron 包仍然不存在，`up` 无法启动 app。\n" +
          `已执行：bun install（cwd ${repo}）\n` +
          `检查过的路径：${electronCandidates(repo, desktop)
            .map((candidate) => relative(repo, candidate.pkgDir))
            .join(", ")}\n` +
          "手动修复：在仓库根执行 `bun install`（需要代理时先确认 HTTPS_PROXY 已设置），然后重试。",
      );
    }
  }

  const candidate = candidates[0]!;
  const relativePkg = relative(repo, candidate.pkgDir);
  deps.log(`Electron 二进制缺失（${relativePkg}）：补跑 install.js 下载 dist/`);
  let install = deps.run(["node", "install.js"], candidate.pkgDir);
  const nodeCommand = `node ${relativePkg}/install.js`;
  if (install.code !== 0 && looksLikeMissingCommand(install)) {
    // mac 上可能只有 bun 没有 node
    const fallback = deps.run(["bun", "install.js"], candidate.pkgDir);
    steps.push(`bun ${relativePkg}/install.js`);
    install = fallback;
  } else {
    steps.push(nodeCommand);
  }

  if (install.code !== 0) {
    throw new ElectronBootstrapError(
      `Electron 安装脚本失败（exit ${install.code}）：${relativePkg}/install.js\n` +
        `stderr 尾巴：\n${install.stderr.split("\n").slice(-8).join("\n")}\n` +
        "手动修复（下载 dist/ 需要网络，代理已在环境变量里）：\n" +
        `  1. cd ${repo} && bun install\n` +
        `  2. ${nodeCommand}\n` +
        `  确认 HTTPS_PROXY 指向可用代理（默认 http://127.0.0.1:6152）。`,
    );
  }

  const installed = findElectronBinary(repo, desktop, deps.exists);
  if (installed === null) {
    throw new ElectronBootstrapError(
      `install.js 退出 0，但二进制仍然缺失：${join(candidate.pkgDir, BINARY_RELATIVE)}\n` +
        `手动修复：rm -rf ${relativePkg}/dist && ${nodeCommand}`,
    );
  }
  return { binary: installed.binary, installed: true, steps };
}
