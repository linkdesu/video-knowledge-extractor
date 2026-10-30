/**
 * r61 / #81：install:local 从 CI 取 Windows 安装包必须按「当前提交 + 当前版本」对齐。
 *
 * 历史故障（r60 / #69）：脚本取「最近一次成功的 windows-build 运行」，不看提交与版本，
 * 于是在期望 0.1.19 时下载了 main（0.1.18）的产物，直到文件名比对失败才报错。
 * 这些用例锁定的行为：版本对不上必须直接失败并同时报出期望/实际版本，且永不回退到旧提交。
 */
import { describe, expect, test } from "bun:test";
import {
  PROVENANCE_SCHEMA_VERSION,
  assertArtifactVersion,
  installerName,
  isBuildRelevantPath,
  judgeCachedArtifact,
  parseArtifactProvenance,
  pickReusableAncestorRun,
  pickRunArtifact,
  selectRunForCommit,
  waitForRunForCommit,
  type ArtifactProvenance,
  type CachedArtifactCheck,
  type LocalArtifact,
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

const EXE_NAME = "Video Notes-0.1.22-setup.exe";
const CI_DIGEST = `sha256:${"a".repeat(64)}`;
const EXE_SHA = "b".repeat(64);
const HEAD_RUN = 900;
const OLD_RUN = 700;

function provenance(over: Partial<ArtifactProvenance> = {}): ArtifactProvenance {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    runId: HEAD_RUN,
    headSha: SHA_HEAD,
    artifactDigest: CI_DIGEST,
    artifactSizeBytes: 174_269_292,
    fileName: EXE_NAME,
    fileSizeBytes: 174_253_093,
    fileSha256: EXE_SHA,
    ...over,
  };
}

function localArtifact(over: Partial<LocalArtifact> = {}): LocalArtifact {
  return { fileName: EXE_NAME, sizeBytes: 174_253_093, sha256: EXE_SHA, ...over };
}

function cacheCheck(over: Partial<CachedArtifactCheck> = {}): CachedArtifactCheck {
  return {
    provenance: provenance(),
    local: localArtifact(),
    expectedFileName: EXE_NAME,
    headSha: SHA_HEAD,
    changedPaths: [],
    headOwnRunId: HEAD_RUN,
    ci: { runId: HEAD_RUN, digest: CI_DIGEST },
    ...over,
  };
}

describe("parseArtifactProvenance：只认带内容哈希的新格式", () => {
  test("r61 的老格式（只有 runId + headSha）不认，等同没有来源", () => {
    expect(parseArtifactProvenance({ runId: 7, headSha: SHA_HEAD })).toBeNull();
  });

  test("缺少 fileSha256 / artifactDigest 不认", () => {
    const { fileSha256: _sha, ...withoutSha } = provenance();
    expect(parseArtifactProvenance(withoutSha)).toBeNull();
    const { artifactDigest: _digest, ...withoutDigest } = provenance();
    expect(parseArtifactProvenance(withoutDigest)).toBeNull();
  });

  test("sha256 形状不对不认", () => {
    expect(parseArtifactProvenance({ ...provenance(), fileSha256: "b".repeat(63) })).toBeNull();
    expect(
      parseArtifactProvenance({ ...provenance(), artifactDigest: `sha256:${"a".repeat(63)}` }),
    ).toBeNull();
  });

  test("完整记录能解析回来", () => {
    expect(parseArtifactProvenance(provenance())).toEqual(provenance());
  });
});

describe("tmp/installer/v<version> 缓存命中前必须核对内容（r63 / #86）", () => {
  test("内容哈希、大小、CI 摘要全对且来源是 HEAD：可用", () => {
    const verdict = judgeCachedArtifact(cacheCheck());
    expect(verdict.usable).toBe(true);
    if (verdict.usable) {
      expect(verdict.fromOtherCommit).toBe(false);
      expect(verdict.summary).toContain(String(HEAD_RUN));
      expect(verdict.summary).toContain(SHA_HEAD.slice(0, 7));
      expect(verdict.summary).toContain(EXE_SHA);
    }
  });

  test("缓存文件被篡改（哈希对不上）：不安装，理由带期望与实际哈希", () => {
    const tampered = "c".repeat(64);
    const verdict = judgeCachedArtifact(cacheCheck({ local: localArtifact({ sha256: tampered }) }));
    expect(verdict.usable).toBe(false);
    if (!verdict.usable) {
      expect(verdict.reason).toContain(EXE_SHA);
      expect(verdict.reason).toContain(tampered);
    }
  });

  test("缓存文件不完整（大小对不上）：不安装", () => {
    const verdict = judgeCachedArtifact(cacheCheck({ local: localArtifact({ sizeBytes: 1024 }) }));
    expect(verdict.usable).toBe(false);
    if (!verdict.usable) expect(verdict.reason).toContain("174253093");
  });

  test("缓存目录里其实没有安装包：不安装", () => {
    expect(judgeCachedArtifact(cacheCheck({ local: null })).usable).toBe(false);
  });

  test("没有来源记录（老目录/手工放的包）：不安装", () => {
    expect(judgeCachedArtifact(cacheCheck({ provenance: null })).usable).toBe(false);
  });

  test("查不到 CI 产物摘要：无法与可信来源比对，不安装", () => {
    const verdict = judgeCachedArtifact(cacheCheck({ ci: null }));
    expect(verdict.usable).toBe(false);
    if (!verdict.usable) expect(verdict.reason).toContain("CI");
  });

  test("CI 产物摘要与记录不同（来源被改写）：不安装", () => {
    const verdict = judgeCachedArtifact(
      cacheCheck({ ci: { runId: HEAD_RUN, digest: `sha256:${"d".repeat(64)}` } }),
    );
    expect(verdict.usable).toBe(false);
    if (!verdict.usable) expect(verdict.reason).toContain(CI_DIGEST);
  });

  test("CI 产物摘要是别的 run 的：不安装", () => {
    const verdict = judgeCachedArtifact(
      cacheCheck({ ci: { runId: OLD_RUN, digest: CI_DIGEST } }),
    );
    expect(verdict.usable).toBe(false);
  });

  test("来源是祖先且只差文档、HEAD 没有自己的运行：可用，但必须明确说明包来自其他提交", () => {
    const verdict = judgeCachedArtifact(
      cacheCheck({
        provenance: provenance({ runId: OLD_RUN, headSha: SHA_OLD }),
        changedPaths: ["docs/adr/0040-x.md"],
        headOwnRunId: null,
        ci: { runId: OLD_RUN, digest: CI_DIGEST },
      }),
    );
    expect(verdict.usable).toBe(true);
    if (verdict.usable) {
      expect(verdict.fromOtherCommit).toBe(true);
      expect(verdict.summary).toContain("其他提交");
      expect(verdict.summary).toContain(String(OLD_RUN));
      expect(verdict.summary).toContain(SHA_OLD.slice(0, 7));
      expect(verdict.summary).toContain(EXE_SHA);
    }
  });

  test("HEAD 已有自己的 CI 产物时不使用旧提交的缓存（哪怕只差文档、哈希全对）", () => {
    const verdict = judgeCachedArtifact(
      cacheCheck({
        provenance: provenance({ runId: OLD_RUN, headSha: SHA_OLD }),
        changedPaths: ["docs/adr/0040-x.md"],
        headOwnRunId: HEAD_RUN,
        ci: { runId: OLD_RUN, digest: CI_DIGEST },
      }),
    );
    expect(verdict.usable).toBe(false);
    if (!verdict.usable) {
      expect(verdict.reason).toContain(String(HEAD_RUN));
      expect(verdict.reason).toContain(SHA_OLD.slice(0, 7));
    }
  });

  test("来源提交与 HEAD 之间有代码差异：不安装", () => {
    const verdict = judgeCachedArtifact(
      cacheCheck({
        provenance: provenance({ runId: OLD_RUN, headSha: SHA_OLD }),
        changedPaths: ["apps/desktop/src/main/index.ts"],
        headOwnRunId: null,
        ci: { runId: OLD_RUN, digest: CI_DIGEST },
      }),
    );
    expect(verdict.usable).toBe(false);
  });

  test("算不出与 HEAD 的差异（来源提交不在本地）：不安装", () => {
    const verdict = judgeCachedArtifact(
      cacheCheck({
        provenance: provenance({ runId: OLD_RUN, headSha: SHA_OLD }),
        changedPaths: null,
        headOwnRunId: null,
        ci: { runId: OLD_RUN, digest: CI_DIGEST },
      }),
    );
    expect(verdict.usable).toBe(false);
  });

  test("缓存里是别的版本的文件名：不安装", () => {
    const verdict = judgeCachedArtifact(
      cacheCheck({ local: localArtifact({ fileName: "Video Notes-0.1.21-setup.exe" }) }),
    );
    expect(verdict.usable).toBe(false);
  });
});

describe("pickRunArtifact：从 gh api 的产物清单里取摘要", () => {
  const listing = {
    total_count: 2,
    artifacts: [
      {
        id: 11,
        name: "some-other",
        size_in_bytes: 10,
        digest: `sha256:${"e".repeat(64)}`,
        expired: false,
      },
      {
        id: 12,
        name: "video-notes-windows-installer",
        size_in_bytes: 174_269_292,
        digest: CI_DIGEST,
        expired: false,
      },
    ],
  };

  test("按名字取到 id、大小与摘要", () => {
    expect(pickRunArtifact(listing, "video-notes-windows-installer")).toEqual({
      id: 12,
      sizeInBytes: 174_269_292,
      digest: CI_DIGEST,
      expired: false,
    });
  });

  test("产物没有摘要时 digest 为 null（调用方不能据此认缓存）", () => {
    const noDigest = {
      artifacts: [{ ...listing.artifacts[1]!, digest: null }],
    };
    expect(pickRunArtifact(noDigest, "video-notes-windows-installer")?.digest).toBeNull();
  });

  test("找不到该名字的产物时返回 null", () => {
    expect(pickRunArtifact(listing, "missing")).toBeNull();
    expect(pickRunArtifact({ artifacts: "nope" }, "missing")).toBeNull();
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
