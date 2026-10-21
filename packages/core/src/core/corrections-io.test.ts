import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadCorrections, parseCorrections, readVideoCorrections, saveVideoCorrections } from "./corrections-io";

function tempRoot(): string {
  return mkdtempSync(resolve(tmpdir(), "vnote-corrections-"));
}

describe("parseCorrections", () => {
  test("wrong/right 映射成 from/to", () => {
    expect(parseCorrections([{ wrong: "CQ", right: "skill" }], "t.json")).toEqual([{ from: "CQ", to: "skill" }]);
  });

  test("不是数组就报错并指出文件", () => {
    expect(() => parseCorrections({ wrong: "a", right: "b" }, "x.json")).toThrow("x.json");
  });

  test("缺 wrong 或 right 报错并指出条目序号", () => {
    expect(() => parseCorrections([{ wrong: "a" }], "x.json")).toThrow("第 1 条");
    expect(() => parseCorrections([{ wrong: "a", right: "" }], "x.json")).toThrow("第 1 条");
  });
});

describe("loadCorrections", () => {
  test("两份文件各自加载；缺文件是空表", () => {
    const root = tempRoot();
    const videoDir = resolve(root, "video");
    writeFileSync(resolve(root, "corrections.json"), JSON.stringify([{ wrong: "SKQ", right: "skill" }]));
    const list = loadCorrections(root, videoDir);
    expect(list.global).toEqual([{ from: "SKQ", to: "skill" }]);
    expect(list.video).toEqual([]);
  });

  test("视频目录里的词表单独加载", () => {
    const root = tempRoot();
    const videoDir = resolve(root, "video");
    writeFileSync(resolve(root, "corrections.json"), JSON.stringify([{ wrong: "SKQ", right: "skill" }]));
    Bun.spawnSync(["mkdir", "-p", videoDir]);
    writeFileSync(resolve(videoDir, "corrections.json"), JSON.stringify([{ wrong: "SKQ", right: "skill 文件" }]));
    const list = loadCorrections(root, videoDir);
    expect(list.video).toEqual([{ from: "SKQ", to: "skill 文件" }]);
  });
});

describe("readVideoCorrections", () => {
  test("缺文件是空表", () => {
    const dir = resolve(tempRoot(), "video");
    expect(readVideoCorrections(dir)).toEqual([]);
  });

  test("读取并校验词条", () => {
    const dir = resolve(tempRoot(), "video");
    Bun.spawnSync(["mkdir", "-p", dir]);
    writeFileSync(resolve(dir, "corrections.json"), JSON.stringify([{ wrong: "SKQ", right: "skill" }]));
    expect(readVideoCorrections(dir)).toEqual([{ wrong: "SKQ", right: "skill" }]);
  });

  test("格式错抛错而不是当成空表", () => {
    const dir = resolve(tempRoot(), "video");
    Bun.spawnSync(["mkdir", "-p", dir]);
    writeFileSync(resolve(dir, "corrections.json"), JSON.stringify([{ wrong: "SKQ" }]));
    expect(() => readVideoCorrections(dir)).toThrow("第 1 条");
  });
});

describe("saveVideoCorrections", () => {
  test("写入后再读回一致", () => {
    const dir = resolve(tempRoot(), "video");
    Bun.spawnSync(["mkdir", "-p", dir]);
    const saved = saveVideoCorrections(dir, [{ wrong: "SKQ", right: "skill" }]);
    expect(saved).toEqual([{ wrong: "SKQ", right: "skill" }]);
    expect(readVideoCorrections(dir)).toEqual([{ wrong: "SKQ", right: "skill" }]);
  });

  test("空 wrong 保存前报错，文件不落盘", () => {
    const dir = resolve(tempRoot(), "video");
    Bun.spawnSync(["mkdir", "-p", dir]);
    expect(() => saveVideoCorrections(dir, [{ wrong: "", right: "skill" }])).toThrow("第 1 条");
    expect(readVideoCorrections(dir)).toEqual([]);
  });
});
