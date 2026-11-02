/**
 * r67 / #89：Windows 安装版 exe 属性页必须显示本应用自己的公司名/产品名/版权，版本号仍等于 package.json。
 *
 * 这些用例锁定的是 #89 的故障形态：CompanyName 沿用 electron.exe 自带的 "GitHub, Inc."。
 * 真实产物上的校验由 scripts/check-win-metadata.ts 在 CI（Windows）与本机（下载的 exe）上跑，
 * 这里只锁定判定规则本身。
 */
import { describe, expect, test } from "bun:test";
import { APP_COMPANY_NAME, stagePackageJson } from "./app-metadata";
import { judgeExeMetadata, type ExeMetadata } from "./win-exe-metadata";

const EXPECTED = {
  companyName: "xieal",
  productName: "Video Notes",
  legalCopyright: "Copyright © 2026 xieal",
  version: "0.1.26",
};

function metadata(over: Partial<ExeMetadata> = {}): ExeMetadata {
  return {
    companyName: "xieal",
    productName: "Video Notes",
    legalCopyright: "Copyright © 2026 xieal",
    fileVersion: "0.1.26",
    productVersion: "0.1.26.0",
    ...over,
  };
}

describe("judgeExeMetadata：只有本应用的值才算通过", () => {
  test("companyName/productName/copyright/版本都对：通过", () => {
    const verdict = judgeExeMetadata(metadata(), EXPECTED);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.summary).toContain("xieal");
      expect(verdict.summary).toContain("0.1.26");
    }
  });

  test("#89 故障形态：CompanyName 还是 GitHub, Inc. → 失败，并点明是 Electron 默认值", () => {
    const verdict = judgeExeMetadata(metadata({ companyName: "GitHub, Inc." }), EXPECTED);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.problems).toHaveLength(1);
      expect(verdict.problems[0]).toContain("CompanyName");
      expect(verdict.problems[0]).toContain("GitHub, Inc.");
      expect(verdict.problems[0]).toContain("Electron 自带");
      expect(verdict.problems[0]).toContain(EXPECTED.companyName);
    }
  });

  test("ProductName 还是 Electron → 失败", () => {
    const verdict = judgeExeMetadata(metadata({ productName: "Electron" }), EXPECTED);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.problems[0]).toContain("ProductName");
      expect(verdict.problems[0]).toContain("Electron 自带");
    }
  });

  test("LegalCopyright 是别的值 → 失败，并报出实际值", () => {
    const verdict = judgeExeMetadata(
      metadata({ legalCopyright: "Copyright (C) 2019 GitHub, Inc." }),
      EXPECTED,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.problems[0]).toContain("LegalCopyright");
      expect(verdict.problems[0]).toContain("Copyright (C) 2019 GitHub, Inc.");
    }
  });

  test("字段缺失（null）→ 失败", () => {
    const verdict = judgeExeMetadata(metadata({ companyName: null }), EXPECTED);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problems[0]).toContain("缺失");
  });

  test("版本号没跟上 package.json → 失败（复用 r64 的 exe 版本判定）", () => {
    const verdict = judgeExeMetadata(
      metadata({ fileVersion: "0.1.25", productVersion: "0.1.25" }),
      EXPECTED,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.problems[0]).toContain("0.1.26");
      expect(verdict.problems[0]).toContain("0.1.25");
    }
  });

  test("四段版本 0.1.26.0 与三段 0.1.26 等价：通过", () => {
    const verdict = judgeExeMetadata(
      metadata({ fileVersion: "0.1.26.0", productVersion: "0.1.26.0.0" }),
      EXPECTED,
    );
    expect(verdict.ok).toBe(true);
  });
});

describe("staging package.json：electron-builder 的 CompanyName 唯一来源", () => {
  test("带 author.name，值等于本应用的公司名（缺了它 exe 会留下 GitHub, Inc.）", () => {
    const pkg = stagePackageJson("0.1.26");
    expect(pkg.author).toEqual({ name: APP_COMPANY_NAME });
  });
});
