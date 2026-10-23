import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sha256, sweepNoteCache } from "./cache";
import { OUTPUT_MANIFEST, cleanupStaleOutputs, isToolTopicDir, readManifest, sweepStaleTopicDirs, writeManifest } from "./outputs";
import { writeFileAtomic } from "./paths";

/** 切片命名的 mp4（真实切片名形如 01-00-13-53-00-16-24.mp4）；内容无关紧要，清理只看文件名。 */
const CLIP = "01-00-13-53-00-16-24.mp4";

/** manifest v2 的一条所有权记录。 */
type ManifestEntry = { name: string; topicMdHash: string };

function tempDir(): string {
  return mkdtempSync(resolve(tmpdir(), "vnote-outputs-"));
}

function makeToolTopicDir(outputDir: string, name: string, extraFiles: string[] = []): string {
  const dir = resolve(outputDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "topic.md"), `# ${name}\n`);
  writeFileSync(resolve(dir, CLIP), "");
  for (const file of extraFiles) writeFileSync(resolve(dir, file), "user content\n");
  return dir;
}

/** 按目录里当前 topic.md 的内容算出所有权记录，写 manifest 用。 */
function entryFor(name: string, dir: string): ManifestEntry {
  return { name, topicMdHash: sha256(readFileSync(resolve(dir, "topic.md"), "utf8")) };
}

/** 绕开 writeManifest 直接落盘，用例可以写出任意（含非法结构/坏名字）的 manifest。 */
function writeRawManifest(outputDir: string, topicDirs: unknown): void {
  writeFileSync(resolve(outputDir, OUTPUT_MANIFEST), JSON.stringify({ topicDirs }));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe("manifest 读写", () => {
  test("没有 manifest 时读回 undefined", () => {
    expect(readManifest(tempDir())).toBeUndefined();
  });

  test("写入时名字去重排序，读回同一份", () => {
    const outputDir = tempDir();
    const a: ManifestEntry = { name: "a", topicMdHash: sha256("# a\n") };
    const b: ManifestEntry = { name: "b", topicMdHash: sha256("# b\n") };
    writeManifest(outputDir, [b, a, { ...a }]);
    expect(readManifest(outputDir)).toEqual({ topicDirs: [a, b] });
    expect(JSON.parse(readFileSync(resolve(outputDir, OUTPUT_MANIFEST), "utf8"))).toEqual({ topicDirs: [a, b] });
  });

  test("topicDirs 不是条目数组时报错并指出文件", () => {
    const outputDir = tempDir();
    writeRawManifest(outputDir, "x");
    expect(() => readManifest(outputDir)).toThrow(outputDir);
  });

  test("条目缺 topicMdHash 时报错并指出文件", () => {
    const outputDir = tempDir();
    writeRawManifest(outputDir, [{ name: "a" }]);
    expect(() => readManifest(outputDir)).toThrow(outputDir);
  });

  test("旧版字符串条目结构报错并指出文件", () => {
    const outputDir = tempDir();
    writeRawManifest(outputDir, ["a"]);
    expect(() => readManifest(outputDir)).toThrow(outputDir);
  });

  test("坏 JSON 时报错并指出文件", () => {
    const outputDir = tempDir();
    writeFileSync(resolve(outputDir, OUTPUT_MANIFEST), "{ 不是 json");
    expect(() => readManifest(outputDir)).toThrow(outputDir);
  });
});

describe("isToolTopicDir", () => {
  test("含子目录就不是纯工具目录", () => {
    const outputDir = tempDir();
    const dir = makeToolTopicDir(outputDir, "with-sub");
    mkdirSync(resolve(dir, "sub"), { recursive: true });
    expect(isToolTopicDir(outputDir, "with-sub")).toBe(false);
  });

  test("topic.md 加切片 mp4 与 .DS_Store 是纯工具目录", () => {
    const outputDir = tempDir();
    makeToolTopicDir(outputDir, "plain", [".DS_Store"]);
    expect(isToolTopicDir(outputDir, "plain")).toBe(true);
  });

  test("topic.md 加 topic.mp4 是纯工具目录（r33 单文件切片）", () => {
    const outputDir = tempDir();
    mkdirSync(resolve(outputDir, "single"), { recursive: true });
    writeFileSync(resolve(outputDir, "single", "topic.md"), "# single\n");
    writeFileSync(resolve(outputDir, "single", "topic.mp4"), "");
    expect(isToolTopicDir(outputDir, "single")).toBe(true);
  });

  test("topic.mp4 与旧编号切片并存仍是纯工具目录", () => {
    const outputDir = tempDir();
    makeToolTopicDir(outputDir, "mixed", ["topic.mp4"]);
    expect(isToolTopicDir(outputDir, "mixed")).toBe(true);
  });

  test("缺 topic.md 就不是纯工具目录", () => {
    const outputDir = tempDir();
    mkdirSync(resolve(outputDir, "no-topic-md"), { recursive: true });
    writeFileSync(resolve(outputDir, "no-topic-md", CLIP), "");
    expect(isToolTopicDir(outputDir, "no-topic-md")).toBe(false);
  });

  test("名为 topic.md 的子目录不是 notes 文件，目录不算纯工具目录", () => {
    const outputDir = tempDir();
    const dir = resolve(outputDir, "sub-topic-md");
    mkdirSync(resolve(dir, "topic.md"), { recursive: true });
    writeFileSync(resolve(dir, "topic.md", "keep.txt"), "user content\n");
    writeFileSync(resolve(dir, CLIP), "");
    expect(isToolTopicDir(outputDir, "sub-topic-md")).toBe(false);
  });

  test("名为 .DS_Store 的子目录不算纯工具目录", () => {
    const outputDir = tempDir();
    const dir = makeToolTopicDir(outputDir, "sub-ds-store");
    mkdirSync(resolve(dir, ".DS_Store"), { recursive: true });
    expect(isToolTopicDir(outputDir, "sub-ds-store")).toBe(false);
  });

  test("只有 topic.md 没有切片 mp4 的目录不算纯工具目录", () => {
    const outputDir = tempDir();
    const dir = resolve(outputDir, "only-topic-md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "topic.md"), "# 用户自己的笔记\n");
    expect(isToolTopicDir(outputDir, "only-topic-md")).toBe(false);
  });

  test("切片命名的符号链接不算普通文件，目录不算纯工具目录", () => {
    const outputDir = tempDir();
    const target = resolve(outputDir, "real-clip.mp4");
    writeFileSync(target, "");
    const dir = makeToolTopicDir(outputDir, "symlinked-clip");
    symlinkSync(target, resolve(dir, "02-00-00-00-00-00-00.mp4"));
    expect(isToolTopicDir(outputDir, "symlinked-clip")).toBe(false);
  });

  test("topic.md 是符号链接时目录不算纯工具目录", () => {
    const outputDir = tempDir();
    const target = resolve(outputDir, "real-topic.md");
    writeFileSync(target, "# 链接目标\n");
    const dir = resolve(outputDir, "symlinked-topic-md");
    mkdirSync(dir, { recursive: true });
    symlinkSync(target, resolve(dir, "topic.md"));
    writeFileSync(resolve(dir, CLIP), "");
    expect(isToolTopicDir(outputDir, "symlinked-topic-md")).toBe(false);
  });
});

describe("sweepStaleTopicDirs", () => {
  test("重跑后主题更少：hash 匹配的旧工具目录被删，被引用的与根文件保留", () => {
    const outputDir = tempDir();
    const a = makeToolTopicDir(outputDir, "topic-a");
    const b = makeToolTopicDir(outputDir, "topic-b");
    const c = makeToolTopicDir(outputDir, "topic-c");
    writeFileSync(resolve(outputDir, "index.md"), "# 旧索引\n");
    writeFileSync(resolve(outputDir, "corrections.json"), "[]\n");
    writeManifest(outputDir, [entryFor("topic-a", a), entryFor("topic-b", b), entryFor("topic-c", c)]);

    const result = sweepStaleTopicDirs({ outputDir, keep: ["topic-a"] });

    expect(sorted(result.removed)).toEqual(["topic-b", "topic-c"]);
    expect(result.kept).toEqual([]);
    expect(existsSync(resolve(outputDir, "topic-a", "topic.md"))).toBe(true);
    expect(existsSync(resolve(outputDir, "topic-b"))).toBe(false);
    expect(existsSync(resolve(outputDir, "topic-c"))).toBe(false);
    expect(existsSync(resolve(outputDir, "index.md"))).toBe(true);
    expect(existsSync(resolve(outputDir, "corrections.json"))).toBe(true);
    expect(readManifest(outputDir)).toEqual({ topicDirs: [entryFor("topic-a", a)] });
  });

  test("旧主题目录里有用户文件时整体保留并留在 manifest", () => {
    const outputDir = tempDir();
    const fresh = makeToolTopicDir(outputDir, "new-topic");
    const old = makeToolTopicDir(outputDir, "old-topic", ["我的笔记.txt"]);
    const oldEntry = entryFor("old-topic", old);
    writeManifest(outputDir, [entryFor("new-topic", fresh), oldEntry]);

    const result = sweepStaleTopicDirs({ outputDir, keep: ["new-topic"] });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(["old-topic"]);
    expect(existsSync(resolve(outputDir, "old-topic", "我的笔记.txt"))).toBe(true);
    expect(existsSync(resolve(outputDir, "old-topic", "topic.md"))).toBe(true);
    expect(readManifest(outputDir)).toEqual({ topicDirs: [entryFor("new-topic", fresh), oldEntry] });
  });

  test("没有 manifest 的旧目录也能按内容判定并清理", () => {
    const outputDir = tempDir();
    const fresh = makeToolTopicDir(outputDir, "new-topic");
    makeToolTopicDir(outputDir, "old-topic");
    expect(readManifest(outputDir)).toBeUndefined();

    const result = sweepStaleTopicDirs({ outputDir, keep: ["new-topic"] });

    expect(result.removed).toEqual(["old-topic"]);
    expect(result.kept).toEqual([]);
    expect(existsSync(resolve(outputDir, "old-topic"))).toBe(false);
    expect(readManifest(outputDir)).toEqual({ topicDirs: [entryFor("new-topic", fresh)] });
  });

  test("同一输入连跑两次，第二次不再删除任何东西", () => {
    const outputDir = tempDir();
    const a = makeToolTopicDir(outputDir, "topic-a");
    const b = makeToolTopicDir(outputDir, "topic-b");
    const c = makeToolTopicDir(outputDir, "topic-c");
    writeManifest(outputDir, [entryFor("topic-a", a), entryFor("topic-b", b), entryFor("topic-c", c)]);

    const first = sweepStaleTopicDirs({ outputDir, keep: ["topic-a"] });
    expect(sorted(first.removed)).toEqual(["topic-b", "topic-c"]);

    const second = sweepStaleTopicDirs({ outputDir, keep: ["topic-a"] });
    expect(second.removed).toEqual([]);
    expect(second.kept).toEqual([]);
    expect(existsSync(resolve(outputDir, "topic-a", "topic.md"))).toBe(true);
  });

  test("名为 topic.md 的子目录不让整个目录被当成纯工具目录删掉", () => {
    const outputDir = tempDir();
    const dir = resolve(outputDir, "victim");
    mkdirSync(resolve(dir, "topic.md"), { recursive: true });
    writeFileSync(resolve(dir, "topic.md", "keep.txt"), "user content\n");
    writeFileSync(resolve(dir, CLIP), "");
    writeManifest(outputDir, [{ name: "victim", topicMdHash: sha256("# stale\n") }]);

    const result = sweepStaleTopicDirs({ outputDir, keep: [] });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(["victim"]);
    expect(existsSync(resolve(dir, "topic.md", "keep.txt"))).toBe(true);
    expect(existsSync(resolve(dir, CLIP))).toBe(true);
  });

  test("名为 .DS_Store 的子目录同样让目录免于清理", () => {
    const outputDir = tempDir();
    const dir = makeToolTopicDir(outputDir, "victim");
    mkdirSync(resolve(dir, ".DS_Store"), { recursive: true });
    writeFileSync(resolve(dir, ".DS_Store", "keep.txt"), "user content\n");
    writeManifest(outputDir, [entryFor("victim", dir)]);

    const result = sweepStaleTopicDirs({ outputDir, keep: [] });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(["victim"]);
    expect(existsSync(resolve(dir, ".DS_Store", "keep.txt"))).toBe(true);
  });

  test("只有 topic.md 没有切片 mp4 的目录不算工具产物，保留并沿用旧 hash", () => {
    const outputDir = tempDir();
    const dir = resolve(outputDir, "my-notes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "topic.md"), "# 用户自己的笔记\n");
    const entry = entryFor("my-notes", dir);
    writeManifest(outputDir, [entry]);

    const result = sweepStaleTopicDirs({ outputDir, keep: [] });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(["my-notes"]);
    expect(existsSync(resolve(dir, "topic.md"))).toBe(true);
    expect(readManifest(outputDir)).toEqual({ topicDirs: [entry] });
  });

  test("manifest 里的 ../outside 不会被解析到输出目录之外", () => {
    const root = tempDir();
    const outputDir = resolve(root, "out");
    mkdirSync(outputDir, { recursive: true });
    const outside = resolve(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(resolve(outside, "topic.md"), "# 外面的笔记\n");
    writeFileSync(resolve(outside, CLIP), "");
    writeFileSync(resolve(outside, "sentinel.txt"), "sentinel\n");
    const inside = makeToolTopicDir(outputDir, "topic-a");
    writeRawManifest(outputDir, [
      { name: "../outside", topicMdHash: sha256("# 外面的笔记\n") },
      entryFor("topic-a", inside),
    ]);

    const result = sweepStaleTopicDirs({ outputDir, keep: [] });

    expect(result.removed).toEqual(["topic-a"]);
    expect(result.kept).toEqual([]);
    expect(existsSync(resolve(outside, "sentinel.txt"))).toBe(true);
    expect(existsSync(resolve(outside, "topic.md"))).toBe(true);
    expect(existsSync(resolve(outside, CLIP))).toBe(true);
    // 非法名字不参与候选，也不会被写回新的 manifest
    expect(readManifest(outputDir)).toEqual({ topicDirs: [] });
  });

  test("用户改过 topic.md 的目录不删，manifest 沿用旧 hash", () => {
    const outputDir = tempDir();
    const dir = makeToolTopicDir(outputDir, "edited-topic");
    const original = entryFor("edited-topic", dir);
    writeManifest(outputDir, [original]);
    writeFileSync(resolve(dir, "topic.md"), "# 用户改过的笔记\n");

    const result = sweepStaleTopicDirs({ outputDir, keep: [] });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(["edited-topic"]);
    expect(readFileSync(resolve(dir, "topic.md"), "utf8")).toBe("# 用户改过的笔记\n");
    expect(readManifest(outputDir)).toEqual({ topicDirs: [original] });
  });

  test("keep 登记本轮 hash：同一目录两轮重写后，下一轮不被旧 hash 挡住删除", () => {
    const outputDir = tempDir();
    const dir = makeToolTopicDir(outputDir, "topic-a");
    const hashA = sha256("# topic-a\n");

    // 第一轮：写出内容 A 且 keep，manifest 登记 A 的 hash
    const first = sweepStaleTopicDirs({ outputDir, keep: ["topic-a"] });
    expect(first.removed).toEqual([]);
    expect(readManifest(outputDir)).toEqual({ topicDirs: [{ name: "topic-a", topicMdHash: hashA }] });

    // 同一目录被重新生成出内容 B（keep）：登记 B 的 hash，而不是沿用 A
    writeFileSync(resolve(dir, "topic.md"), "# topic-a v2\n");
    const hashB = sha256("# topic-a v2\n");
    const second = sweepStaleTopicDirs({ outputDir, keep: ["topic-a"] });
    expect(second.removed).toEqual([]);
    expect(readManifest(outputDir)).toEqual({ topicDirs: [{ name: "topic-a", topicMdHash: hashB }] });

    // 下一轮不在 keep：B 是工具刚写出的（不是用户改的），目录应被删
    const third = sweepStaleTopicDirs({ outputDir, keep: [] });
    expect(third.removed).toEqual(["topic-a"]);
    expect(existsSync(dir)).toBe(false);
  });

  test("topic.md 换成子目录时目录被 kept 且 manifest 原记录保留，恢复成文件后仍被 kept", () => {
    const outputDir = tempDir();
    const dir = makeToolTopicDir(outputDir, "topic-a");
    const original = entryFor("topic-a", dir); // hash A
    writeManifest(outputDir, [original]);
    // 用户改成 B
    writeFileSync(resolve(dir, "topic.md"), "# 用户批注\n");

    // 再把 topic.md 换成同名子目录（此期间读不到文件）
    rmSync(resolve(dir, "topic.md"));
    mkdirSync(resolve(dir, "topic.md"), { recursive: true });
    writeFileSync(resolve(dir, "topic.md", "keep.txt"), "user content\n");

    const first = sweepStaleTopicDirs({ outputDir, keep: [] });
    expect(first.removed).toEqual([]);
    expect(first.kept).toEqual(["topic-a"]);
    expect(existsSync(resolve(dir, "topic.md", "keep.txt"))).toBe(true);
    // 读不到当前 hash 不能丢原记录，否则下一轮它会变成「无记录」被指纹删除
    expect(readManifest(outputDir)).toEqual({ topicDirs: [original] });

    // 把 topic.md 恢复成 B 文件后再 sweep：B ≠ A，仍被 kept
    rmSync(resolve(dir, "topic.md"), { recursive: true });
    writeFileSync(resolve(dir, "topic.md"), "# 用户批注\n");
    const second = sweepStaleTopicDirs({ outputDir, keep: [] });
    expect(second.removed).toEqual([]);
    expect(second.kept).toEqual(["topic-a"]);
  });

  test("大小写别名守卫：keep 里的 topic-a 在磁盘上叫 Topic-A 时不被删，其他旧目录照常清理", () => {
    const outputDir = tempDir();
    makeToolTopicDir(outputDir, "Topic-A");
    makeToolTopicDir(outputDir, "old-topic");
    writeManifest(outputDir, [
      { name: "topic-a", topicMdHash: sha256("# Topic-A\n") },
      { name: "old-topic", topicMdHash: sha256("# old-topic\n") },
    ]);
    renameSync(resolve(outputDir, "Topic-A"), resolve(outputDir, "topic-a-x"));
    renameSync(resolve(outputDir, "topic-a-x"), resolve(outputDir, "Topic-A"));

    const result = sweepStaleTopicDirs({ outputDir, keep: ["topic-a"] });

    expect(result.removed).toEqual(["old-topic"]);
    expect(result.kept).toEqual([]);
    expect(existsSync(resolve(outputDir, "Topic-A", "topic.md"))).toBe(true);
  });
});

describe("sweepNoteCache", () => {
  test("只保留 keep 里的笔记缓存，并回收崩溃残留 tmp 文件，返回被删文件名", () => {
    const cacheDir = tempDir();
    mkdirSync(resolve(cacheDir, "note"), { recursive: true });
    for (const name of ["a", "b"]) {
      writeFileSync(resolve(cacheDir, "note", `${name}.json`), `${JSON.stringify({ keyPoints: [name] })}\n`);
    }
    writeFileSync(resolve(cacheDir, "note", "dead.json.12345.tmp"), "partial\n");

    const removed = sweepNoteCache(cacheDir, new Set(["a"]));

    expect(sorted(removed)).toEqual(["b.json", "dead.json.12345.tmp"]);
    expect(existsSync(resolve(cacheDir, "note", "a.json"))).toBe(true);
    expect(existsSync(resolve(cacheDir, "note", "b.json"))).toBe(false);
    expect(existsSync(resolve(cacheDir, "note", "dead.json.12345.tmp"))).toBe(false);
  });

  test("笔记缓存目录不存在时返回空数组", () => {
    expect(sweepNoteCache(resolve(tempDir(), "missing"), new Set<string>())).toEqual([]);
  });
});

describe("cleanupStaleOutputs", () => {
  test("manifest 损坏时返回空数组、不抛错，目录与文件都不动", () => {
    const outputDir = tempDir();
    const keepDir = makeToolTopicDir(outputDir, "keep");
    makeToolTopicDir(outputDir, "stale");
    writeFileSync(resolve(outputDir, OUTPUT_MANIFEST), "not json");
    const cacheDir = tempDir();
    mkdirSync(resolve(cacheDir, "note"), { recursive: true });
    writeFileSync(resolve(cacheDir, "note", "a.json"), "{}\n");

    const removed = cleanupStaleOutputs({ outputDir, keep: ["keep"], cacheDir, noteCacheKeys: ["a"] });

    expect(removed).toEqual([]);
    expect(existsSync(resolve(outputDir, "stale"))).toBe(true);
    expect(existsSync(keepDir)).toBe(true);
    expect(existsSync(resolve(outputDir, OUTPUT_MANIFEST))).toBe(true);
    expect(existsSync(resolve(cacheDir, "note", "a.json"))).toBe(true);
  });

  test("正常 manifest：不在 keep 的工具目录被删，没用到的笔记缓存被删", () => {
    const outputDir = tempDir();
    const keepDir = makeToolTopicDir(outputDir, "keep");
    makeToolTopicDir(outputDir, "stale");
    writeRawManifest(outputDir, [entryFor("stale", resolve(outputDir, "stale"))]);
    const cacheDir = tempDir();
    mkdirSync(resolve(cacheDir, "note"), { recursive: true });
    writeFileSync(resolve(cacheDir, "note", "a.json"), "{}\n");
    writeFileSync(resolve(cacheDir, "note", "b.json"), "{}\n");

    const removed = cleanupStaleOutputs({ outputDir, keep: ["keep"], cacheDir, noteCacheKeys: ["a"] });

    expect(sorted(removed)).toEqual(["stale"]);
    expect(existsSync(resolve(outputDir, "stale"))).toBe(false);
    expect(existsSync(keepDir)).toBe(true);
    expect(existsSync(resolve(cacheDir, "note", "a.json"))).toBe(true);
    expect(existsSync(resolve(cacheDir, "note", "b.json"))).toBe(false);
  });
});

describe("writeFileAtomic", () => {
  test("写入后内容逐字相等，同目录不留临时文件", () => {
    const dir = tempDir();
    const path = resolve(dir, "topic.md");
    const text = "# 标题\n\n- 要点：中文与符号 🎬\n";
    writeFileAtomic(path, text);

    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readdirSync(dir)).toEqual(["topic.md"]);
  });

  test("覆盖已有文件时整份替换，不残留旧内容", () => {
    const dir = tempDir();
    const path = resolve(dir, "index.md");
    writeFileSync(path, "# 旧的更长的索引内容\n".repeat(20));
    writeFileAtomic(path, "# 新索引\n");

    expect(readFileSync(path, "utf8")).toBe("# 新索引\n");
    expect(readdirSync(dir)).toEqual(["index.md"]);
  });

  test("父目录不存在时自动创建", () => {
    const dir = tempDir();
    const path = resolve(dir, "a", "b", "topic.md");
    writeFileAtomic(path, "# 深层笔记\n");

    expect(readFileSync(path, "utf8")).toBe("# 深层笔记\n");
    expect(readdirSync(resolve(dir, "a", "b"))).toEqual(["topic.md"]);
  });
});
