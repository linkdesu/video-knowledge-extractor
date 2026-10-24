import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { logDirFor } from "./paths";

describe("logDirFor", () => {
  test("日志目录在 notes 根目录下的 .logs", () => {
    expect(logDirFor("/data/notes")).toBe(resolve("/data/notes", ".logs"));
    expect(logDirFor("/data/notes")).toBe(join("/data/notes", ".logs"));
  });
});
