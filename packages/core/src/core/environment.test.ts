import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findExecutable, checkPath, collectEnvironment, formatEnvironment } from "./environment";

const tempDir = mkdtempSync(join(tmpdir(), "vnote-env-"));
const fakeEnv: NodeJS.ProcessEnv = { HOME: "/home/tester" };
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

describe("findExecutable", () => {
  test("PATH（本机分隔符）里找到真实文件返回绝对路径", () => {
    const dir = join(tempDir, "bin");
    mkdirSync(dir);
    const exeSuffix = process.platform === "win32" ? ".exe" : "";
    const file = join(dir, `ffmpeg${exeSuffix}`);
    writeFileSync(file, "x");
    expect(
      findExecutable("ffmpeg", {
        env: { PATH: [join(dir, "empty"), dir].join(delimiter) },
        platform: process.platform,
      }),
    ).toBe(file);
  });

  test("posix：不在 PATH 里返回 null", () => {
    expect(findExecutable("no-such-tool-xyz", { env: { PATH: tempDir }, platform: process.platform })).toBeNull();
  });

  test("win32：PATH（; 分隔）里只认 .exe 后缀", () => {
    const dir = join(tempDir, "win-bin");
    mkdirSync(dir);
    const plain = join(dir, "ffprobe");
    const exe = join(dir, "ffprobe.exe");
    writeFileSync(plain, "x");
    writeFileSync(exe, "x");
    // 同名普通文件（无 .exe）不算命中
    expect(findExecutable("ffprobe", { env: { PATH: `${dir};C:\\nope` }, platform: "win32" })).toBe(exe);
  });

  test("win32：没有 .exe 文件返回 null", () => {
    const dir = join(tempDir, "win-empty");
    expect(findExecutable("ffprobe", { env: { PATH: `${dir};C:\\nope` }, platform: "win32" })).toBeNull();
    expect(findExecutable("ffmpeg", { env: { PATH: dir }, platform: "win32" })).toBeNull();
  });

  test("多个目录时返回 PATH 中第一个命中", () => {
    const exeSuffix = process.platform === "win32" ? ".exe" : "";
    const first = join(tempDir, "first");
    const second = join(tempDir, "second");
    mkdirSync(first);
    mkdirSync(second);
    const f1 = join(first, `ffprobe${exeSuffix}`);
    const f2 = join(second, `ffprobe${exeSuffix}`);
    writeFileSync(f1, "a");
    writeFileSync(f2, "b");
    expect(findExecutable("ffprobe", { env: { PATH: [first, second].join(delimiter) }, platform: process.platform })).toBe(f1);
  });
});

describe("checkPath", () => {
  test("存在的文件：exists true 且 bytes 为文件大小", () => {
    const file = join(tempDir, "f.txt");
    writeFileSync(file, "hello");
    const check = checkPath("file", file);
    expect(check.exists).toBe(true);
    expect(check.bytes).toBe(5);
    expect(check.kind).toBe("file");
  });

  test("存在的目录：exists true、bytes 为 null、kind 为 dir", () => {
    const check = checkPath("dir", tempDir);
    expect(check.exists).toBe(true);
    expect(check.bytes).toBeNull();
    expect(check.kind).toBe("dir");
  });

  test("不存在的文件：exists false 且 bytes 为 null", () => {
    const check = checkPath("missing", join(tempDir, "no-such-file"));
    expect(check.exists).toBe(false);
    expect(check.bytes).toBeNull();
    expect(check.kind).toBeNull();
  });
});

describe("路径标志", () => {
  test("非 ASCII 路径标记 nonAscii", () => {
    expect(checkPath("r", "/home/视频/模型.onnx").nonAscii).toBe(true);
  });

  test("纯 ASCII 路径 nonAscii 为 false", () => {
    expect(checkPath("r", "/home/user/model.onnx").nonAscii).toBe(false);
  });

  test("含空格路径标记 hasSpace", () => {
    expect(checkPath("r", "/home/My Models/a onnx").hasSpace).toBe(true);
    expect(checkPath("r", "/home/MyModels/a.onnx").hasSpace).toBe(false);
  });
});

describe("collectEnvironment", () => {
  test("tools/models/dirs 都按角色收集", () => {
    const modelDir = join(tempDir, "models");
    mkdirSync(modelDir, { recursive: true });
    const snapshot = collectEnvironment({
      env: { ...fakeEnv, PATH: "" },
      modelDir,
      extraDirs: [{ role: "extraDir", path: join(tempDir, "extra") }],
    });
    expect(snapshot.tools.map((t) => t.role)).toEqual(["ffmpeg", "ffprobe"]);
    expect(snapshot.models.map((m) => m.role)).toEqual(["asr-model", "asr-tokens", "diarization", "speaker-embedding", "punctuation"]);
    expect(snapshot.dirs.map((d) => d.role)).toEqual(["notesRoot", "cacheRoot", "modelDir", "extraDir"]);
    // 空 PATH：工具解析不到，回落到裸名且 exists false
    for (const tool of snapshot.tools) {
      expect(tool.path).toBe(tool.role);
      expect(tool.exists).toBe(false);
    }
    expect(snapshot.cpuCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.totalMemBytes).toBeGreaterThan(0);
  });
});

describe("formatEnvironment", () => {
  test("覆盖全部工具、模型、目录角色，且带标志", () => {
    const modelDir = join(tempDir, "models");
    mkdirSync(modelDir, { recursive: true });
    const snapshot = collectEnvironment({ env: { ...fakeEnv, PATH: "" }, modelDir });
    const lines = formatEnvironment(snapshot);
    const roles = lines.map((line) => line.slice(0, line.indexOf(":")));
    expect(roles).toEqual([
      "ffmpeg",
      "ffprobe",
      "asr-model",
      "asr-tokens",
      "diarization",
      "speaker-embedding",
      "punctuation",
      "notesRoot",
      "cacheRoot",
      "modelDir",
    ]);
    // 缺失项带 missing 标记；存在的目录显示 dir 而不是 ?（r40）
    expect(lines[2]).toContain("missing");
    expect(lines[9]).toContain("dir");
    // 含空格路径带 含空格 标记
    const spaced: (typeof snapshot.dirs) = [
      { role: "spaced", path: "/tmp/My Models", exists: false, bytes: null, kind: null, nonAscii: false, hasSpace: true },
    ];
    const spacedLine = formatEnvironment({ ...snapshot, dirs: spaced }).find((line) => line.startsWith("spaced:"));
    expect(spacedLine).toContain("含空格");
  });
});
