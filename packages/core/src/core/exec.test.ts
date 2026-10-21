import { describe, expect, test } from "bun:test";
import { run, killActiveChildren } from "./exec";

describe("run", () => {
  test("命令不存在（ENOENT）报错，消息含 label 与命令名", async () => {
    await expect(run(["definitely-not-a-real-cmd-xyz"], { label: "测试命令" })).rejects.toThrow("测试命令");
    await expect(run(["definitely-not-a-real-cmd-xyz"], { label: "测试命令" })).rejects.toThrow("definitely-not-a-real-cmd-xyz");
  });

  test("非零退出默认抛错，消息含 stderr 尾部最后 12 行", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => "stderr-line-" + i);
    const script = lines.map((l) => "printf '%s\\n' '" + l + "' >&2").join("; ");
    const err = await run(["/bin/sh", "-c", script + "; exit 3"], { label: "失败命令" }).then(() => undefined).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("失败命令");
    expect(err!.message).toContain("exit 3");
    for (const line of lines.slice(-12)) {
      expect(err!.message).toContain(line);
    }
    expect(err!.message).not.toContain(lines[0]);
  });

  test("allowFail 时返回 code 不抛", async () => {
    const result = await run(["/bin/sh", "-c", "echo hi; exit 7"], { label: "允许失败", allowFail: true });
    expect(result.code).toBe(7);
    expect(result.stdout).toContain("hi");
  });

  test("killActiveChildren 杀掉等待中的命令，以非零结束", async () => {
    // run 内 activeChildren.add 在首个 await 前同步执行，spawn 后即可杀
    const pending = run(["/bin/sleep", "5"], { label: "等待中的命令" });
    killActiveChildren();
    const err = await pending.then(() => undefined).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("等待中的命令");
  });
});
