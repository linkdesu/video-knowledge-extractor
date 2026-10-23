import { describe, expect, test } from "bun:test";
import { run, killActiveChildren } from "./exec";
import { configureLogging } from "./logger";

// 用 process.execPath 跑 -e 脚本，Windows 上也能跑
const NODE = process.execPath;

describe("run", () => {
  test("命令不存在（ENOENT）报错，消息含 label 与命令名", async () => {
    await expect(run(["definitely-not-a-real-cmd-xyz"], { label: "测试命令" })).rejects.toThrow("测试命令");
    await expect(run(["definitely-not-a-real-cmd-xyz"], { label: "测试命令" })).rejects.toThrow("definitely-not-a-real-cmd-xyz");
  });

  test("非零退出默认抛错，消息含 stderr 尾部最后 12 行", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => "stderr-line-" + i);
    const script = lines.map((l) => `process.stderr.write('${l}\\n')`).join("; ");
    const err = await run([NODE, "-e", `${script}; process.exit(3)`], { label: "失败命令" }).then(() => undefined).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("失败命令");
    expect(err!.message).toContain("exit 3");
    for (const line of lines.slice(-12)) {
      expect(err!.message).toContain(line);
    }
    expect(err!.message).not.toContain(lines[0]);
  });

  test("allowFail 时返回 code 不抛", async () => {
    const result = await run([NODE, "-e", "console.log('hi'); process.exit(7)"], { label: "允许失败", allowFail: true });
    expect(result.code).toBe(7);
    expect(result.stdout).toContain("hi");
  });

  test("killActiveChildren 杀掉等待中的命令，以非零结束", async () => {
    // 真实定时器例外：长 setTimeout 只是让子进程存活到被 SIGKILL，等待的是 close 事件而非固定时长
    // run 内 activeChildren.add 在首个 await 前同步执行，spawn 后即可杀
    const pending = run([NODE, "-e", "setTimeout(() => {}, 5000)"], { label: "等待中的命令" });
    killActiveChildren();
    const err = await pending.then(() => undefined).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("等待中的命令");
  });

  test("sink 收到含命令名、退出码与 50 行 stderr 尾部的日志", async () => {
    const lines: string[] = [];
    configureLogging({ sink: (s) => lines.push(s) });
    // 30 行 stderr 都在 50 行尾部内，首尾都应出现在日志里
    const stderrScript = Array.from({ length: 30 }, (_, i) => `process.stderr.write('sline-${i}\\n')`).join("; ");
    await run([NODE, "-e", `${stderrScript}; process.exit(3)`], { label: "日志失败", allowFail: true });
    const cmdLine = lines.find((l) => l.includes("INFO") && l.includes("cmd=")) ?? "";
    expect(cmdLine).toContain(NODE);
    const errLine = lines.find((l) => l.includes("ERROR") && l.includes("命令失败")) ?? "";
    expect(errLine).toContain("code=3");
    expect(errLine).toContain("stderrTail=");
    expect(errLine).toContain("sline-0");
    expect(errLine).toContain("sline-29");
  });
});
