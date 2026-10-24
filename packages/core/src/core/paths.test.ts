import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { logDirFor } from "./paths";

describe("logDirFor", () => {
  test("日志目录在 notes 根目录下的 .logs", () => {
    const root = resolve("notes-root");
    expect(logDirFor(root)).toBe(join(root, ".logs"));
    expect(logDirFor(root).endsWith(join(".logs"))).toBe(true);
  });
});
