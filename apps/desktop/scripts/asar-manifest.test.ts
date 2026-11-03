import { describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowedPrefixes,
  diffManifestShape,
  judgeAsarManifest,
  manifestShape,
  normalizeEntry,
  readAsarEntries,
  requiredEntries,
} from "./asar-manifest";

/** 一份干净的 Windows 运行时清单：out/ + package.json + 两个 sherpa 包。 */
const CLEAN_WIN = [
  "package.json",
  "out/main/index.js",
  "out/preload/index.cjs",
  "out/renderer/index.html",
  "node_modules/sherpa-onnx-node/package.json",
  "node_modules/sherpa-onnx-node/sherpa-onnx.js",
  "node_modules/sherpa-onnx-win-x64/package.json",
  "node_modules/sherpa-onnx-win-x64/sherpa-onnx.node",
];

/** #96 的真实泄漏样本（摘自 CI run 41402337086 的 156 项）。 */
const LEAKED = [
  ...CLEAN_WIN,
  "node_modules/@video-notes/core/package.json",
  "node_modules/@video-notes/core/src/core/cache.ts",
  "node_modules/@video-notes/core/src/core/cache.test.ts",
  "node_modules/@video-notes/core/src/core/__snapshots__/media-normalize.test.ts.snap",
  "node_modules/@video-notes/core/.turbo/turbo-test.log",
  "node_modules/@video-notes/core/bunfig.toml",
  "node_modules/dotenv/package.json",
];

describe("judgeAsarManifest", () => {
  test("干净清单通过，且能给出分组计数", () => {
    const verdict = judgeAsarManifest(CLEAN_WIN, "win32");
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
    expect(verdict.total).toBe(CLEAN_WIN.length);
    expect(verdict.counts).toEqual({
      "package.json": 1,
      out: 3,
      "node_modules/sherpa-onnx-node": 2,
      "node_modules/sherpa-onnx-win-x64": 2,
    });
  });

  test("前导斜杠不影响判定（asar 清单两种写法都出现过）", () => {
    const verdict = judgeAsarManifest(CLEAN_WIN.map((entry) => `/${entry}`), "win32");
    expect(verdict.ok).toBe(true);
    expect(verdict.total).toBe(CLEAN_WIN.length);
  });

  test("多带 core 源码/测试/快照/turbo 日志/dotenv 时逐条报出原因", () => {
    const verdict = judgeAsarManifest(LEAKED, "win32");
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toHaveLength(7);
    const joined = verdict.problems.join("\n");
    expect(joined).toContain("多带：node_modules/@video-notes/core/src/core/cache.ts");
    expect(joined).toContain("测试文件");
    expect(joined).toContain("测试快照");
    expect(joined).toContain("turbo 构建缓存/日志");
    expect(joined).toContain("dotenv");
    expect(verdict.counts["白名单外"]).toBe(7);
  });

  test("别的平台的原生包出现即失败（Windows 包里混进 darwin-arm64）", () => {
    const verdict = judgeAsarManifest([...CLEAN_WIN, "node_modules/sherpa-onnx-darwin-arm64/package.json"], "win32");
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]).toContain("其它平台的原生包");
  });

  test("只剩白名单文件但缺运行时文件也算失败（禁止假通过）", () => {
    const verdict = judgeAsarManifest(["package.json", "out/main/index.js"], "win32");
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain("缺少运行时文件：out/preload/index.cjs");
    expect(verdict.problems).toContain("缺少运行时文件：node_modules/sherpa-onnx-win-x64/package.json");
  });

  test("每个平台只放行自己的原生包", () => {
    expect(allowedPrefixes("win32")).toContain("node_modules/sherpa-onnx-win-x64/");
    expect(allowedPrefixes("win32")).not.toContain("node_modules/sherpa-onnx-darwin-arm64/");
    expect(allowedPrefixes("darwin")).toContain("node_modules/sherpa-onnx-darwin-arm64/");
    expect(requiredEntries("darwin")).toContain("node_modules/sherpa-onnx-darwin-arm64/package.json");
  });
});

describe("跨平台形状", () => {
  const MAC = [
    "/package.json",
    "/out/main/index.js",
    "/out/preload/index.cjs",
    "/out/renderer/index.html",
    "/node_modules/sherpa-onnx-node/package.json",
    "/node_modules/sherpa-onnx-node/sherpa-onnx.js",
    "/node_modules/sherpa-onnx-darwin-arm64/package.json",
    "/node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node",
  ];

  test("只换原生包目录时形状一致", () => {
    expect(diffManifestShape(manifestShape(MAC, "darwin"), manifestShape(CLEAN_WIN, "win32"))).toEqual({
      onlyInLeft: [],
      onlyInRight: [],
    });
  });

  test("形状比对能指出真正的差异（Windows 多带 core）", () => {
    const diff = diffManifestShape(manifestShape(LEAKED, "win32"), manifestShape(MAC, "darwin"));
    expect(diff.onlyInLeft).toContain("node_modules/@video-notes/core/src/core/cache.ts");
    expect(diff.onlyInRight).toEqual([]);
  });

  test("原生二进制文件名不同、单边多 README 都不算结构差异", () => {
    const winWithReadme = [...CLEAN_WIN, "node_modules/sherpa-onnx-node/README.md"];
    expect(diffManifestShape(manifestShape(winWithReadme, "win32"), manifestShape(MAC, "darwin"))).toEqual({
      onlyInLeft: [],
      onlyInRight: [],
    });
    expect(manifestShape(MAC, "darwin")).toContain("node_modules/<native>");
  });

  test("normalizeEntry 去掉前后斜杠", () => {
    expect(normalizeEntry("/out/main/index.js")).toBe("out/main/index.js");
    expect(normalizeEntry("out/main/")).toBe("out/main");
  });
});

describe("readAsarEntries", () => {
  /** 按 chromium pickle 布局拼一个最小 asar 头（无 payload，只读清单）。 */
  function writeAsar(dir: string, tree: unknown): string {
    const json = Buffer.from(JSON.stringify(tree), "utf8");
    const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4)]);
    const head = Buffer.alloc(16);
    head.writeUInt32LE(4, 0);
    head.writeUInt32LE(padded.length + 8, 4);
    head.writeUInt32LE(padded.length, 8);
    head.writeUInt32LE(json.length, 12);
    const path = join(dir, "app.asar");
    const fd = openSync(path, "w");
    try {
      writeSync(fd, head);
      writeSync(fd, padded);
    } finally {
      closeSync(fd);
    }
    return path;
  }

  test("扁平与目录节点都展开成文件路径", () => {
    const dir = mkdtempSync(join(tmpdir(), "asar-manifest-"));
    try {
      const path = writeAsar(dir, {
        files: {
          "package.json": { size: 1, offset: "0" },
          out: { files: { main: { files: { "index.js": { size: 1, offset: "0" } } } } },
        },
      });
      expect(readAsarEntries(path).sort()).toEqual(["out/main/index.js", "package.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("非 asar 文件给出可读错误，不是 JSON 崩栈", () => {
    const dir = mkdtempSync(join(tmpdir(), "asar-manifest-"));
    try {
      const path = join(dir, "not-asar.bin");
      const fd = openSync(path, "w");
      try {
        writeSync(fd, Buffer.alloc(16));
      } finally {
        closeSync(fd);
      }
      expect(() => readAsarEntries(path)).toThrow("不是 asar 格式");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
