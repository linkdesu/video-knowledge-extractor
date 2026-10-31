/**
 * Windows exe 版本资源（属性页）校验（r67 / #89）。
 *
 * 故障来源：electron-builder 的 `CompanyName` 只取自 staging package.json 的 `author.name`，
 * 缺 author 时它不写这个键，exe 就保留 electron.exe 自带的 "GitHub, Inc."。
 * 这里把「读 exe 版本资源」与「判定是否为本应用的值」分开：
 * 判定是纯函数（可在任意平台单测），读取用 electron-builder 自己写这些字段时用的 resedit。
 */

import { readFile } from "node:fs/promises";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";
import { assertExeVersionMatches } from "../src/main/release-version";

export interface ExeMetadata {
  companyName: string | null;
  productName: string | null;
  legalCopyright: string | null;
  fileVersion: string | null;
  productVersion: string | null;
}

export interface ExpectedExeMetadata {
  companyName: string;
  productName: string;
  legalCopyright: string;
  /** package.json 的 version。 */
  version: string;
}

export type ExeMetadataVerdict =
  | { ok: true; summary: string }
  | { ok: false; problems: string[]; summary: string };

/** 没有 author 时 electron.exe 留下的默认值：命中说明打包配置漏了，不是「值不一样」那么简单。 */
const ELECTRON_DEFAULTS: Partial<Record<keyof ExeMetadata, string>> = {
  companyName: "GitHub, Inc.",
  productName: "Electron",
};

function describeActual(value: string | null): string {
  return value === null ? "缺失" : `"${value}"`;
}

function checkTextField(
  field: keyof ExeMetadata,
  actual: string | null,
  expected: string,
  problems: string[],
): void {
  if (actual === expected) return;
  const label = {
    companyName: "CompanyName（公司名）",
    productName: "ProductName（产品名）",
    legalCopyright: "LegalCopyright（版权）",
  }[field as "companyName" | "productName" | "legalCopyright"];
  const fallback =
    actual !== null && actual === ELECTRON_DEFAULTS[field]
      ? "，仍是 Electron 自带的默认值"
      : "";
  problems.push(`${label} 是 ${describeActual(actual)}，期望 "${expected}"${fallback}`);
}

export function judgeExeMetadata(
  actual: ExeMetadata,
  expected: ExpectedExeMetadata,
): ExeMetadataVerdict {
  const problems: string[] = [];
  checkTextField("companyName", actual.companyName, expected.companyName, problems);
  checkTextField("productName", actual.productName, expected.productName, problems);
  checkTextField("legalCopyright", actual.legalCopyright, expected.legalCopyright, problems);
  try {
    assertExeVersionMatches(
      { fileVersion: actual.fileVersion, productVersion: actual.productVersion },
      expected.version,
    );
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }

  if (problems.length > 0) {
    return { ok: false, problems, summary: `exe 版本资源不符（${problems.length} 项）` };
  }
  return {
    ok: true,
    summary:
      `公司名=${actual.companyName} 产品名=${actual.productName} 版权=${actual.legalCopyright} ` +
      `版本=${actual.fileVersion}`,
  };
}

/** VS_FIXEDFILEINFO 的四段数值版本（属性页在没有 FileVersion 字符串时显示它）。 */
function formatFixedVersion(ms: number, ls: number): string {
  const high = (ms >>> 16) & 0xffff;
  const low = ms & 0xffff;
  const build = (ls >>> 16) & 0xffff;
  const revision = ls & 0xffff;
  return [high, low, build, revision].join(".");
}

/** 读 PE 的 VS_VERSIONINFO 字符串字段（属性页可见的那几项）。 */
export async function readExeMetadata(exePath: string): Promise<ExeMetadata> {
  const executable = NtExecutable.from(await readFile(exePath), { ignoreCert: true });
  const resources = NtExecutableResource.from(executable);
  const [versionInfo] = Resource.VersionInfo.fromEntries(resources.entries);
  if (versionInfo === undefined) {
    throw new Error(`${exePath} 没有 VS_VERSIONINFO 资源`);
  }
  const [lang] = versionInfo.getAllLanguagesForStringValues();
  const strings = lang === undefined ? {} : versionInfo.getStringValues(lang);
  const fixed = versionInfo.fixedInfo;
  const text = (key: string): string | null => {
    const value = strings[key];
    return typeof value === "string" && value !== "" ? value : null;
  };
  return {
    companyName: text("CompanyName"),
    productName: text("ProductName"),
    legalCopyright: text("LegalCopyright"),
    fileVersion: text("FileVersion") ?? formatFixedVersion(fixed.fileVersionMS, fixed.fileVersionLS),
    productVersion:
      text("ProductVersion") ?? formatFixedVersion(fixed.productVersionMS, fixed.productVersionLS),
  };
}
