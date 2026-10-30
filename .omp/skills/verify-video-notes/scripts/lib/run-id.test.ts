import { describe, expect, test } from "bun:test";
import { runIdProblem } from "./run-id";

describe("runIdProblem", () => {
  test("Latest / LATEST / 混写都被拒（大小写不敏感卷上等于 latest）", () => {
    for (const id of ["Latest", "LATEST", "laTest"]) {
      expect(runIdProblem(id)).toContain("latest");
    }
    expect(runIdProblem("latest")).toContain("大小写不敏感");
  });

  test("带路径分隔符的 id 被拒，latest/ 也逃不掉", () => {
    for (const id of ["latest/", "../x", "a/b", "..\\x", "/abs"]) {
      expect(runIdProblem(id)).not.toBeNull();
    }
    expect(runIdProblem("latest/")).toContain("路径分隔符");
  });

  test(". 与 .. 被拒（会解析成证据根自身或上一级目录）", () => {
    expect(runIdProblem(".")).toContain("证据根自身");
    expect(runIdProblem("..")).toContain("证据根自身");
  });

  test("空 id 与字符集之外的 id 被拒", () => {
    expect(runIdProblem("")).toContain("空字符串");
    expect(runIdProblem("  ")).toContain("空字符串");
    expect(runIdProblem("r51 mac")).toContain("只接受字母数字");
    expect(runIdProblem("r51:mac")).toContain("只接受字母数字");
    expect(runIdProblem("latest ")).toContain("只接受字母数字");
  });

  test("正常 id 仍然通过：时间戳、点号与连字符", () => {
    for (const id of ["r51", "r51-verify-run-id-case", "2026-10-30-120000", "r51.mac_1", "Latest-old", "r51..2"]) {
      expect(runIdProblem(id)).toBeNull();
    }
  });
});
