/**
 * 构建产物元数据检查（r67 / #89）：Windows exe 属性页的公司名/产品名/版权/版本号。
 *
 * 判定与期望值都来自生产代码（scripts/app-metadata.ts），所以在 CI 与本机都跑同一套规则：
 *   bun scripts/check-win-metadata.ts                                  # 默认 release-win/win-unpacked/Video Notes.exe
 *   bun scripts/check-win-metadata.ts --exe "/tmp/Video Notes.exe"      # 对下载下来的产物跑
 * 任一文件不通过就以非零退出，并把实际值打出来（缺哪项、实际是什么）。
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_COMPANY_NAME, APP_COPYRIGHT, APP_PRODUCT_NAME } from "./app-metadata";
import { judgeExeMetadata, readExeMetadata } from "./win-exe-metadata";

const appDir = resolve(import.meta.dirname, "..");
const DEFAULT_EXE = join(appDir, "release-win", "win-unpacked", "Video Notes.exe");

function parseExeArgs(argv: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--exe") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--exe 后面缺少路径");
      paths.push(resolve(value));
      i += 1;
      continue;
    }
    if (!arg.startsWith("--")) paths.push(resolve(arg));
  }
  return paths.length > 0 ? paths : [DEFAULT_EXE];
}

const desktopPackage = JSON.parse(
  readFileSync(join(appDir, "package.json"), "utf8"),
) as { version: string };

const expected = {
  companyName: APP_COMPANY_NAME,
  productName: APP_PRODUCT_NAME,
  legalCopyright: APP_COPYRIGHT,
  version: desktopPackage.version,
};

const reports = [];
let failed = false;
for (const exePath of parseExeArgs(process.argv.slice(2))) {
  const actual = await readExeMetadata(exePath);
  const verdict = judgeExeMetadata(actual, expected);
  if (!verdict.ok) failed = true;
  reports.push({
    exePath,
    ok: verdict.ok,
    summary: verdict.summary,
    problems: verdict.ok ? [] : verdict.problems,
    expected,
    actual,
  });
}

console.log(JSON.stringify({ reports }, null, 2));
if (failed) process.exit(1);
