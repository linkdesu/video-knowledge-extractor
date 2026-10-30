/**
 * r61 / #81：install:local 从 CI 取 Windows 安装包必须按「当前提交 + 当前版本」对齐。
 *
 * 历史故障（r60 / #69）：脚本取「最近一次成功的 windows-build 运行」，不看提交与版本，
 * 于是在期望 0.1.19 时下载了 main（0.1.18）的产物，直到文件名比对失败才报错。
 * 这些用例锁定的行为：版本对不上必须直接失败并同时报出期望/实际版本，且永不回退到旧提交。
 */
import { describe, expect, test } from "bun:test";
import {
  assertArtifactVersion,
  cachedArtifactMatchesHead,
  installerName,
  isBuildRelevantPath,
  pickReusableAncestorRun,
  selectRunForCommit,
  waitForRunForCommit,
  type WindowsBuildRun,
} from "./win-installer-source";

const SHA_HEAD = "e6edf7b0000000000000000000000000000000c1";
const SHA_OLD = "41129460179000000000000000000000000000aa";

function run(over: Partial<WindowsBuildRun>): WindowsBuildRun {
  return {
    databaseId: 1,
    status: "completed",
    conclusion: "success",
    headSha: SHA_HEAD,
    displayTitle: "test",
    ...over,
  };
}

describe("installerName", () => {
  test("安装包名带版本号", () => {
    expect(installerName("0.1.20")).toBe("Video Notes-0.1.20-setup.exe");
  });
});

describe("assertArtifactVersion：CI 产物版本必须等于期望版本", () => {
  test("版本一致时返回安装包文件名", () => {
    const picked = assertArtifactVersion(
      ["Video Notes-0.1.20-setup.exe", "Video Notes-0.1.20-setup.exe.blockmap"],
      { version: "0.1.20", runId: 42, headSha: SHA_HEAD },
    );
    expect(picked).toBe("Video Notes-0.1.20-setup.exe");
  });

  test("产物是旧版本时失败，并同时报出期望与实际版本", () => {
    let message = "";
    try {
      assertArtifactVersion(["Video Notes-0.1.18-setup.exe"], {
        version: "0.1.20",
        runId: 41129460179,
        headSha: SHA_HEAD,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("0.1.20");
    expect(message).toContain("0.1.18");
    expect(message).toContain("41129460179");
  });

  test("产物里没有安装包时失败，不静默继续", () => {
    expect(() =>
      assertArtifactVersion(["builder-debug.yml"], {
        version: "0.1.20",
        runId: 7,
        headSha: SHA_HEAD,
      }),
    ).toThrow(/0\.1\.20/);
  });
});

describe("selectRunForCommit：只认当前提交的构建", () => {
  test("命中同提交的成功运行", () => {
    const picked = selectRunForCommit(
      [run({ databaseId: 11, headSha: SHA_OLD }), run({ databaseId: 22 })],
      SHA_HEAD,
    );
    expect(picked?.databaseId).toBe(22);
  });

  test("同提交只有旧提交的成功运行时返回 null（r60 故障场景：不得回退）", () => {
    const picked = selectRunForCommit([run({ databaseId: 11, headSha: SHA_OLD })], SHA_HEAD);
    expect(picked).toBeNull();
  });

  test("同提交的失败运行不被当作可用产物", () => {
    const picked = selectRunForCommit(
      [run({ databaseId: 33, conclusion: "failure" }), run({ databaseId: 11, headSha: SHA_OLD })],
      SHA_HEAD,
    );
    expect(picked).toBeNull();
  });
});

describe("tmp/installer/v<version> 缓存必须有提交来源", () => {
  test("没有来源记录（老目录/手工放的包）一律不认，重新下载", () => {
    expect(cachedArtifactMatchesHead(null, SHA_HEAD, [])).toBe(false);
  });

  test("来源就是 HEAD：可用", () => {
    expect(
      cachedArtifactMatchesHead({ runId: 7, headSha: SHA_HEAD }, SHA_HEAD, []),
    ).toBe(true);
  });

  test("来源是祖先且差异全为文档：可用（构建输入相同）", () => {
    expect(
      cachedArtifactMatchesHead({ runId: 7, headSha: SHA_OLD }, SHA_HEAD, [
        "docs/adr/0039-x.md",
      ]),
    ).toBe(true);
  });

  test("来源提交含代码差异：不可用（必须重新构建/下载）", () => {
    expect(
      cachedArtifactMatchesHead({ runId: 7, headSha: SHA_OLD }, SHA_HEAD, [
        "apps/desktop/src/main/index.ts",
      ]),
    ).toBe(false);
  });

  test("算不出差异（来源提交不在本地）：不可用", () => {
    expect(cachedArtifactMatchesHead({ runId: 7, headSha: SHA_OLD }, SHA_HEAD, null)).toBe(false);
  });
});

describe("文档提交不影响构建输入时的复用", () => {
  test("workflow paths-ignore 认的路径不算构建输入", () => {
    expect(isBuildRelevantPath("docs/adr/0039-x.md")).toBe(false);
    expect(isBuildRelevantPath("README.md")).toBe(false);
    expect(isBuildRelevantPath("apps/desktop/package.json")).toBe(true);
    expect(isBuildRelevantPath("package.json")).toBe(true);
  });

  test("HEAD 只改文档、祖先提交有成功构建时复用该构建", () => {
    const picked = pickReusableAncestorRun(
      [run({ databaseId: 55, headSha: SHA_OLD })],
      SHA_HEAD,
      [{ sha: SHA_OLD, changedPaths: ["docs/adr/0039-x.md", "README.md"] }],
    );
    expect(picked?.databaseId).toBe(55);
  });

  test("祖先与 HEAD 之间有代码改动时不复用（必须重新构建）", () => {
    const picked = pickReusableAncestorRun(
      [run({ databaseId: 55, headSha: SHA_OLD })],
      SHA_HEAD,
      [{ sha: SHA_OLD, changedPaths: ["docs/adr/0039-x.md", "apps/cli/src/cli.ts"] }],
    );
    expect(picked).toBeNull();
  });

  test("HEAD 自己已有构建运行（哪怕还在跑）就不复用祖先产物", () => {
    const picked = pickReusableAncestorRun(
      [run({ databaseId: 66, status: "in_progress", conclusion: null }), run({ databaseId: 55, headSha: SHA_OLD })],
      SHA_HEAD,
      [{ sha: SHA_OLD, changedPaths: [] }],
    );
    expect(picked).toBeNull();
  });
});

describe("waitForRunForCommit：CI 未就绪时等待或明确报错", () => {
  test("先排队/运行中，等到成功", () => {
    const batches: WindowsBuildRun[][] = [
      [run({ status: "queued", conclusion: null })],
      [run({ status: "in_progress", conclusion: null })],
      [run({ status: "completed", conclusion: "success", databaseId: 99 })],
    ];
    let i = 0;
    const sleeps: number[] = [];
    const picked = waitForRunForCommit({
      expectedSha: SHA_HEAD,
      expectedVersion: "0.1.20",
      fetchRuns: () => batches[Math.min(i, batches.length - 1)]!,
      sleep: (ms) => {
        sleeps.push(ms);
        i += 1;
      },
      timeoutMs: 60_000,
      pollMs: 1_000,
    });
    expect(picked.databaseId).toBe(99);
    expect(sleeps.length).toBe(2);
  });

  test("只有旧提交的构建时立即报错，报出期望版本与提交，绝不返回旧 run", () => {
    const sleeps: number[] = [];
    let message = "";
    try {
      waitForRunForCommit({
        expectedSha: SHA_HEAD,
        expectedVersion: "0.1.20",
        fetchRuns: () => [run({ databaseId: 11, headSha: SHA_OLD })],
        sleep: (ms) => sleeps.push(ms),
        timeoutMs: 60_000,
        pollMs: 1_000,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("0.1.20");
    expect(message).toContain(SHA_HEAD.slice(0, 7));
    // 没有任何该提交的运行在跑，无需等待
    expect(sleeps.length).toBe(0);
  });

  test("同提交的构建失败时立即报错并指出失败结论", () => {
    let message = "";
    try {
      waitForRunForCommit({
        expectedSha: SHA_HEAD,
        expectedVersion: "0.1.20",
        fetchRuns: () => [run({ status: "completed", conclusion: "failure" })],
        sleep: () => {
          throw new Error("不应该等待");
        },
        timeoutMs: 60_000,
        pollMs: 1_000,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("failure");
    expect(message).toContain("0.1.20");
  });

  test("一直不结束则超时报错，不回退旧提交", () => {
    let clock = 0;
    let message = "";
    try {
      waitForRunForCommit({
        expectedSha: SHA_HEAD,
        expectedVersion: "0.1.20",
        fetchRuns: () => [run({ status: "in_progress", conclusion: null })],
        sleep: (ms) => {
          clock += ms;
        },
        now: () => clock,
        timeoutMs: 3_000,
        pollMs: 1_000,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/超时/);
    expect(message).toContain("0.1.20");
  });
});
