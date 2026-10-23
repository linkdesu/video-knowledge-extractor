import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultDataRoot, killProcessTree, prependPath, toolDirs } from "./platform";

describe("toolDirs", () => {
  test("posix：保持今天的顺序（VNOTE_FFMPEG_DIR、Homebrew、/usr/local/bin、/usr/bin、/bin）", () => {
    expect(toolDirs({ platform: "darwin", env: {} })).toEqual(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
    expect(toolDirs({ platform: "linux", env: { VNOTE_FFMPEG_DIR: "/custom" } })).toEqual([
      "/custom",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]);
  });

  test("win32：没有 unix 路径；VNOTE_FFMPEG_DIR 排第一，resourcesPath 补捆绑目录", () => {
    expect(toolDirs({ platform: "win32", env: {} })).toEqual([]);
    expect(toolDirs({ platform: "win32", env: { VNOTE_FFMPEG_DIR: "D:\\custom" } })).toEqual(["D:\\custom"]);
    const dirs = toolDirs({ platform: "win32", env: { VNOTE_FFMPEG_DIR: "D:\\custom" }, resourcesPath: "C:\\app\\resources" });
    expect(dirs).toEqual(["D:\\custom", join("C:\\app\\resources", "ffmpeg")]);
    // 没给 resourcesPath（未打包）不补捆绑目录
    expect(toolDirs({ platform: "win32", env: {}, resourcesPath: undefined })).toEqual([]);
    for (const unix of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) expect(dirs.includes(unix)).toBe(false);
  });

  test("VNOTE_FFMPEG_DIR 为空串时不出现在列表里", () => {
    expect(toolDirs({ platform: "darwin", env: { VNOTE_FFMPEG_DIR: "" } })).toEqual(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
  });
});

describe("prependPath", () => {
  test("posix 用 : 分隔，且与现有 PATH 去重", () => {
    const out = prependPath({ platform: "darwin", currentPath: "/opt/homebrew/bin:/usr/bin:/extra", env: {} });
    expect(out).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/extra");
  });

  test("win32 用 ; 分隔，空项过滤", () => {
    const out = prependPath({
      platform: "win32",
      resourcesPath: "C:\\app\\resources",
      env: {},
      currentPath: `${join("C:\\app\\resources", "ffmpeg")};;C:\\Windows`,
    });
    expect(out).toBe(`${join("C:\\app\\resources", "ffmpeg")};C:\\Windows`);
  });

  test("现有 PATH 里有重复项：保留首次出现", () => {
    const out = prependPath({ platform: "linux", currentPath: "/bin:/usr/bin", env: { VNOTE_FFMPEG_DIR: "/bin" } });
    expect(out).toBe("/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin");
  });
});

describe("killProcessTree", () => {
  test("win32：spawn taskkill 且 argv 精确，非零状态忽略", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const spawn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status: 1, stdout: "" };
    };
    expect(() => killProcessTree(4242, { platform: "win32", spawn })).not.toThrow();
    expect(calls).toEqual([{ cmd: "taskkill", args: ["/PID", "4242", "/T", "/F"] }]);
  });

  test("posix：先 pgrep 子进程再杀 pid；子进程 ESRCH 忽略", () => {
    const kills: number[] = [];
    const origKill = process.kill;
    const origWarn = console.warn;
    process.kill = ((pid: number, signal?: string) => {
      if (signal === "SIGKILL") kills.push(pid);
      else throw new Error("unexpected signal");
    }) as typeof process.kill;
    console.warn = () => {};
    try {
      const spawn = (cmd: string, args: string[]) => {
        expect(cmd).toBe("pgrep");
        expect(args).toEqual(["-P", "7"]);
        return { status: 0, stdout: "11\n12\nbad\n" };
      };
      killProcessTree(7, { platform: "darwin", spawn });
    } finally {
      process.kill = origKill;
      console.warn = origWarn;
    }
    expect(kills).toEqual([11, 12, 7]);
  });
});

describe("defaultDataRoot", () => {
  test("Documents 下拼 video-notes", () => {
    // 期望值同样走 join，分隔符跟随宿主（Windows 下为 \）
    expect(defaultDataRoot("/Users/link/Documents")).toBe(join("/Users/link/Documents", "video-notes"));
    expect(defaultDataRoot("C:\\Users\\link\\Documents")).toBe(join("C:\\Users\\link\\Documents", "video-notes"));
  });
});
