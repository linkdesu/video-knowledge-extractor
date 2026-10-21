import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { ModelBundle } from "./catalog";
import { extractArchive } from "./extract";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "vnote-models-"));
}


/** 用系统 tar 在临时目录里生成一个 .tar.bz2 夹具；entries 是「相对路径:内容」。 */
function makeTargzBz2(dir: string, name: string, entries: Record<string, string>): string {
  for (const [rel, content] of Object.entries(entries)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  execFileSync("tar", ["-cjf", join(dir, name), ...Object.keys(entries)], { cwd: dir });
  const archive = join(dir, name);
  for (const rel of Object.keys(entries)) rmSync(join(dir, rel), { force: true });
  return archive;
}

/** 单文件包夹具：内容与清单 bytes/sha256 一致。 */
export function singleFileBundle(fixture: { id: ModelBundle["id"]; name: string; content: string }): { bundle: ModelBundle } {
  const bytes = Buffer.byteLength(fixture.content);
  const sha256 = createHash("sha256").update(fixture.content).digest("hex");
  return {
    bundle: {
      id: fixture.id,
      title: fixture.id,
      files: [{ path: fixture.name, sha256, bytes }],
      source: { kind: "file", url: "https://example.invalid/models", name: fixture.name },
    },
  };
}

/** tar.bz2 包夹具：members 与文件内容/大小/hash 一致。 */
export function archiveBundle(
  fixture: { id: ModelBundle["id"]; topDir: string; files: Record<string, string> },
): { bundle: ModelBundle } {
  return {
    bundle: {
      id: fixture.id,
      title: fixture.id,
      files: Object.entries(fixture.files).map(([rel, content]) => ({
        path: `${fixture.topDir}/${rel}`,
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: Buffer.byteLength(content),
      })),
      source: {
        kind: "tar.bz2",
        url: "https://example.invalid/models.tar.bz2",
        members: Object.keys(fixture.files).map((rel) => `${fixture.topDir}/${rel}`),
      },
    },
  };
}

describe("extractArchive", () => {
  test("正常归档：逐成员解包、大小与 sha256 通过", async () => {
    const root = tempRoot();
    const staging = join(root, "staging");
    const archive = makeTargzBz2(root, "m.tar.bz2", {
      "pkg/model.onnx": "onnx-content-1234",
      "pkg/tokens.txt": "1 hello\n2 world\n",
    });
    const { bundle } = archiveBundle({
      id: "asr",
      topDir: "pkg",
      files: { "model.onnx": "onnx-content-1234", "tokens.txt": "1 hello\n2 world\n" },
    });
    await extractArchive(archive, staging, bundle);
    expect(readFileSync(join(staging, "pkg/model.onnx"), "utf8")).toBe("onnx-content-1234");
    expect(readFileSync(join(staging, "pkg/tokens.txt"), "utf8")).toBe("1 hello\n2 world\n");
  });

  test("成员含 ../ 在解包前拒绝，staging 保持为空", async () => {
    const root = tempRoot();
    const staging = join(root, "staging");
    // 直接注入假 tar 输出，不真建归档
    const execTar = async (args: string[]) => {
      if (args[0] === "-tjf") return { stdout: "pkg/../../evil.txt\n", stderr: "" };
      return { stdout: "-rw-r--r-- 1 1 1 12 1月 1 00:00 pkg/../../evil.txt\n", stderr: "" };
    };
    const { bundle } = archiveBundle({ id: "asr", topDir: "pkg", files: { "model.onnx": "abc" } });
    await expect(extractArchive(join(root, "fake.tar.bz2"), staging, bundle, execTar)).rejects.toThrow(".. 成员");
    expect(existsSync(staging)).toBe(false);
  });

  test("成员为绝对路径在解包前拒绝", async () => {
    const root = tempRoot();
    const staging = join(root, "staging");
    const execTar = async (args: string[]) => {
      if (args[0] === "-tjf") return { stdout: "/etc/evil\n", stderr: "" };
      return { stdout: "-rw-r--r-- 1 1 1 12 1月 1 00:00 /etc/evil\n", stderr: "" };
    };
    const { bundle } = archiveBundle({ id: "asr", topDir: "pkg", files: { "model.onnx": "abc" } });
    await expect(extractArchive(join(root, "fake.tar.bz2"), staging, bundle, execTar)).rejects.toThrow("绝对路径成员");
    expect(existsSync(staging)).toBe(false);
  });

  test("符号链接成员整体拒绝", async () => {
    const root = tempRoot();
    const staging = join(root, "staging");
    const execTar = async (args: string[]) => {
      if (args[0] === "-tjf") return { stdout: "pkg/link\n", stderr: "" };
      return { stdout: "lrwxrwxrwx 1 1 1 12 1月 1 00:00 pkg/link\n", stderr: "" };
    };
    const { bundle } = archiveBundle({ id: "asr", topDir: "pkg", files: { "model.onnx": "abc" } });
    await expect(extractArchive(join(root, "fake.tar.bz2"), staging, bundle, execTar)).rejects.toThrow("非普通文件/目录");
  });

  test("重复成员在解包前拒绝", async () => {
    const root = tempRoot();
    const staging = join(root, "staging");
    const execTar = async (args: string[]) => {
      if (args[0] === "-tjf") return { stdout: "pkg/a.txt\npkg/a.txt\n", stderr: "" };
      return {
        stdout: "-rw-r--r-- 1 1 1 3 1月 1 00:00 pkg/a.txt\n-rw-r--r-- 1 1 1 3 1月 1 00:00 pkg/a.txt\n",
        stderr: "",
      };
    };
    const { bundle } = archiveBundle({ id: "asr", topDir: "pkg", files: { "a.txt": "abc" } });
    await expect(extractArchive(join(root, "fake.tar.bz2"), staging, bundle, execTar)).rejects.toThrow("重复成员");
  });

  test("成员数超过 200 直接拒绝", async () => {
    const root = tempRoot();
    const staging = join(root, "staging");
    const names = Array.from({ length: 201 }, (_, i) => `pkg/f${i}.txt`);
    const execTar = async (args: string[]) => {
      if (args[0] === "-tjf") return { stdout: names.join("\n") + "\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const { bundle } = archiveBundle({ id: "asr", topDir: "pkg", files: { "a.txt": "abc" } });
    await expect(extractArchive(join(root, "fake.tar.bz2"), staging, bundle, execTar)).rejects.toThrow("成员数");
    expect(existsSync(staging)).toBe(false);
  });

  test("允许成员的声明大小与清单不符在解包前拒绝，staging 为空", async () => {
    const root = tempRoot();
    const staging = join(root, "staging");
    // 清单期望 3 字节，归档声明 5
    const execTar = async (args: string[]) => {
      if (args[0] === "-tjf") return { stdout: "pkg/a.txt\n", stderr: "" };
      return { stdout: "-rw-r--r-- 1 1 1 5 1月 1 00:00 pkg/a.txt\n", stderr: "" };
    };
    const { bundle } = archiveBundle({ id: "asr", topDir: "pkg", files: { "a.txt": "abc" } });
    await expect(extractArchive(join(root, "fake.tar.bz2"), staging, bundle, execTar)).rejects.toThrow("声明大小");
    expect(existsSync(staging)).toBe(false);
  });

  test("允许成员缺声明大小在解包前拒绝", async () => {
    const root = tempRoot();
    const staging = join(root, "staging");
    const execTar = async (args: string[]) => {
      if (args[0] === "-tjf") return { stdout: "pkg/a.txt\n", stderr: "" };
      return { stdout: "-rw-r--r-- root root 1月 1 00:00 pkg/a.txt\n", stderr: "" };
    };
    const { bundle } = archiveBundle({ id: "asr", topDir: "pkg", files: { "a.txt": "abc" } });
    await expect(extractArchive(join(root, "fake.tar.bz2"), staging, bundle, execTar)).rejects.toThrow("声明大小缺失");
  });

  test("归档缺少清单要求的成员在解包前拒绝", async () => {
    const root = tempRoot();
    const staging = join(root, "staging");
    const execTar = async (args: string[]) => {
      if (args[0] === "-tjf") return { stdout: "pkg/other.txt\n", stderr: "" };
      return { stdout: "-rw-r--r-- 1 1 1 3 1月 1 00:00 pkg/other.txt\n", stderr: "" };
    };
    const { bundle } = archiveBundle({ id: "asr", topDir: "pkg", files: { "a.txt": "abc" } });
    await expect(extractArchive(join(root, "fake.tar.bz2"), staging, bundle, execTar)).rejects.toThrow("归档缺少成员");
  });

  test("成员数与内容都对但 sha256 不符：解包后失败并删 staging", async () => {
    const root = tempRoot();
    const staging = join(root, "staging");
    // 真实归档内容 "abc"，清单期望 "abd"（同字节数）
    const archive = makeTargzBz2(root, "m.tar.bz2", { "pkg/a.txt": "abc" });
    const { bundle } = archiveBundle({ id: "asr", topDir: "pkg", files: { "a.txt": "abd" } });
    await expect(extractArchive(archive, staging, bundle)).rejects.toThrow("sha256 不符");
    expect(existsSync(staging)).toBe(false);
  });

  test("清单要求两个成员但归档只声明一个：声明总大小不符", async () => {
    const root = tempRoot();
    const staging = join(root, "staging");
    const execTar = async (args: string[]) => {
      if (args[0] === "-tjf") return { stdout: "pkg/a.txt\n", stderr: "" };
      return { stdout: "-rw-r--r-- 1 1 1 3 1月 1 00:00 pkg/a.txt\n", stderr: "" };
    };
    const { bundle } = archiveBundle({
      id: "asr",
      topDir: "pkg",
      files: { "a.txt": "abc", "b.txt": "xyz" },
    });
    await expect(extractArchive(join(root, "fake.tar.bz2"), staging, bundle, execTar)).rejects.toThrow("归档缺少成员");
  });
});
