/**
 * 命令层（r51）：`up --run <id>` 必须在新建目录、拉起 app 之前就拒绝危险 id；只读命令
 * （`down` / `doctor` / `drive`）的 `--run` 走同一条门禁。
 *
 * GAP-1 的实测复现：`--run Latest` 在 `latest` 不存在时绕过了大小写不敏感校验，`up` 建好
 * `tmp/verify/Latest`、拉起 app 之后，`writeLatestPointer` 把这份证据当成旧指针删掉。
 * 所以这里不只看退出码，还要证明 tmp/verify 一个条目都没多、latest 指针原样、没有新 Electron。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { latestPointerProblem } from "./lib/latest";
import { findSecretFiles } from "./lib/secrets-gate";

const REPO = resolve(import.meta.dirname, "../../../..");
const SCRIPT = join(import.meta.dirname, "verify.ts");
const VERIFY_ROOT = join(REPO, "tmp/verify");

type Snapshot = {
  /** 证据根下的条目名（排序）；根不存在时为空 */
  entries: string[];
  /** latest 指针的形态与内容：被删、被覆写或变成目录都会让这里变化 */
  latest: string;
};

function snapshot(): Snapshot {
  const entries = existsSync(VERIFY_ROOT) ? readdirSync(VERIFY_ROOT).sort() : [];
  const latestPath = join(VERIFY_ROOT, "latest");
  let latest: string;
  try {
    const st = lstatSync(latestPath);
    latest = st.isFile() ? `file:${readFileSync(latestPath, "utf8").trim()}` : `other:${st.mode}`;
  } catch {
    latest = "absent";
  }
  return { entries, latest };
}

/** 本 worktree 起的 Electron 数：并行会话的打包 app 命令行里没有这个路径，不会被算进来。 */
function electronCount(): number {
  if (process.platform !== "darwin") return 0;
  const probe = Bun.spawnSync(["pgrep", "-fl", "Electron apps/desktop"], { stdout: "pipe", stderr: "ignore" });
  return probe.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes(REPO)).length;
}

function runVerify(command: string, args: string[]): { exitCode: number; stderr: string } {
  const proc = Bun.spawnSync(["bun", SCRIPT, command, ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { exitCode: proc.exitCode ?? -1, stderr: proc.stderr.toString() };
}

/** id 门禁的五种文案：出任何一种都说明是被 run id 拒绝的，而不是别的门禁。 */
const RUN_ID_MESSAGES = ["不能用 latest", "不能带路径分隔符", "不能是 .", "只接受字母数字", "不能是空字符串"];

describe("verify.ts --run 的 id 门禁", () => {
  test("up：Latest / LATEST / latest\\// ../x / . / .. 全部在建目录之前被拒", () => {
    const before = snapshot();
    const electronsBefore = electronCount();
    const cases: Array<[string, string]> = [
      ["Latest", "latest（大小写不敏感）"],
      ["LATEST", "latest（大小写不敏感）"],
      ["latest/", "路径分隔符"],
      ["../x", "路径分隔符"],
      [".", "不能是 ."],
      ["..", "不能是 .."],
    ];
    for (const [id, message] of cases) {
      const { exitCode, stderr } = runVerify("up", ["--run", id, "--no-build", "--empty-settings"]);
      expect({ id, exitCode }).toEqual({ id, exitCode: 1 });
      expect({ id, rejected: stderr.includes(message) }).toEqual({ id, rejected: true });
      // 不是「run already exists」「port busy」这类跑起来之后的失败
      expect({ id, later: stderr.includes("run already exists") }).toEqual({ id, later: false });
    }
    // 一个条目都没多：既没有 tmp/verify/Latest，也没有把 latest 换成新内容
    expect(snapshot()).toEqual(before);
    expect(electronCount()).toBe(electronsBefore);
  });

  test("正常 id 不被 id 门禁拦下：同样的命令换成 r51-run-id-probe 就走到后面的门禁", () => {
    const id = "r51-run-id-probe";
    const before = snapshot();
    const { exitCode, stderr } = runVerify("up", ["--run", id, "--user-data", join(VERIFY_ROOT, id)]);
    expect(exitCode).toBe(1);
    for (const message of RUN_ID_MESSAGES) expect(stderr).not.toContain(message);
    expect(snapshot()).toEqual(before);
    // 干净的证据树（无密钥、latest 不是 run 目录、同名 run 不存在）上，失败点应当是 userData 边界：
    // 这条断言会随本机历史证据降级，因为前面还有两个门禁也会合法地先拒。
    const clean = findSecretFiles(VERIFY_ROOT).length === 0 && latestPointerProblem(join(VERIFY_ROOT, "latest")) === null && !existsSync(join(VERIFY_ROOT, id));
    if (clean) expect(stderr).toContain("userData 不能落在证据目录内");
  });

  test("只读命令（down / doctor / drive）的 --run 走同一条门禁，且不动任何文件", () => {
    const before = snapshot();
    // drive 的第一个参数是 action，--run 在它后面
    const cases: Array<[string, string[]]> = [
      ["down", ["--run", "../x"]],
      ["doctor", ["--run", "Latest"]],
      ["drive", ["log", "--run", ".."]],
    ];
    for (const [command, argv] of cases) {
      const { exitCode, stderr } = runVerify(command, argv);
      expect({ command, exitCode }).toEqual({ command, exitCode: 1 });
      expect({ command, sourced: stderr.includes("来源：--run") }).toEqual({ command, sourced: true });
    }
    expect(snapshot()).toEqual(before);
  });
});
