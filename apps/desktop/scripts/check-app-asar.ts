/**
 * app.asar 清单门禁（r72 / #96）：确认安装包里只有运行时文件，且 Windows 与 mac 条目一致。
 *
 * CI（windows-build.yml）在 Package (NSIS) 之后跑默认检查：
 *   bun scripts/check-app-asar.ts
 * 本机比对两个平台的产物（打包完 win + mac 后）：
 *   bun scripts/check-app-asar.ts \
 *     --win "release-win/win-unpacked/resources/app.asar" \
 *     --mac "release/Video Notes-darwin-arm64/Video Notes.app/Contents/Resources/app.asar"
 *
 * 规则本身在 scripts/asar-manifest.ts（纯函数），这里只做 IO、默认路径与退出码。
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  diffManifestShape,
  judgeAsarManifest,
  manifestShape,
  readAsarEntries,
  type AppPlatform,
  type ManifestVerdict,
  type ShapeDiff,
} from "./asar-manifest";

const appDir = resolve(import.meta.dirname, "..");
const DEFAULT_WIN = join(appDir, "release-win", "win-unpacked", "resources", "app.asar");

interface Paths {
  win: string;
  mac: string | null;
}

function parseArgs(argv: string[]): Paths {
  let win = DEFAULT_WIN;
  let mac: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    if (arg === "--win" || arg === "--mac") {
      if (value === undefined) throw new Error(`${arg} 后面缺少路径`);
      if (arg === "--win") win = resolve(value);
      else mac = resolve(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`未知参数 ${arg}（只支持 --win、--mac）`);
    throw new Error(`多余的位置参数 ${arg}（只支持 --win、--mac）`);
  }
  return { win, mac };
}

function check(path: string, platform: AppPlatform): { asarPath: string; verdict: ManifestVerdict } {
  if (!existsSync(path)) {
    throw new Error(`找不到 ${path}：先跑 \`bun run package:win\` / \`bun run package:mac\``);
  }
  return { asarPath: path, verdict: judgeAsarManifest(readAsarEntries(path), platform) };
}

const paths = parseArgs(process.argv.slice(2));
const winCheck = check(paths.win, "win32");
const macPath = paths.mac;
const macCheck = macPath === null ? null : check(macPath, "darwin");

let parity: ShapeDiff | null = null;
let parityOk: boolean | null = null;
if (macPath !== null) {
  parity = diffManifestShape(
    manifestShape(readAsarEntries(paths.win), "win32"),
    manifestShape(readAsarEntries(macPath), "darwin"),
  );
  parityOk = parity.onlyInLeft.length === 0 && parity.onlyInRight.length === 0;
}

const ok = winCheck.verdict.ok && (macCheck?.verdict.ok ?? true) && (parityOk ?? true);
console.log(
  JSON.stringify(
    {
      ok,
      win: { asarPath: winCheck.asarPath, ...winCheck.verdict },
      mac: macCheck === null ? null : { asarPath: macCheck.asarPath, ...macCheck.verdict },
      parity: macCheck === null ? null : { ok: parityOk, ...parity },
    },
    null,
    2,
  ),
);
if (!ok) process.exit(1);
