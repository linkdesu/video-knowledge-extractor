/**
 * 拉取固定版本的 Windows 静态 ffmpeg（gyan.dev essentials build），供 NSIS 打包 extraResources 使用。
 *
 * 为什么固定 url + sha256：ffmpeg 二进制是安全敏感的（用户机器上跑任意字节），
 * 不固定版本会把供应链风险交给上游；校验失败直接报错，绝不用未校验的文件。
 *
 * 用法：`bun run fetch:ffmpeg [--force]`。--force 强制重新下载，忽略本地缓存。
 * 跨平台（macOS 上就能准备好 Windows 资源），产物在 apps/desktop/win-resources/ffmpeg/。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const NAME = "ffmpeg-9.0.2-essentials_build";
const URL = `https://www.gyan.dev/ffmpeg/builds/packages/${NAME}.zip`;
const SHA256 = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba";
const BINARIES = ["ffmpeg.exe", "ffprobe.exe"];

const appDir = resolve(import.meta.dirname, "..");
const cacheDir = join(appDir, ".cache", "ffmpeg");
const zipPath = join(cacheDir, `${NAME}.zip`);
const destDir = join(appDir, "win-resources", "ffmpeg");

const force = process.argv.includes("--force");

/** 分块算 sha256，110MB 的 zip 不能整文件读进内存。 */
function sha256File(path: string): string {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
  const handle = openSync(path, "r");
  try {
    let n: number;
    do {
      n = readSync(handle, buf, 0, buf.length, null);
      if (n > 0) hash.update(buf.subarray(0, n));
    } while (n > 0);
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}

mkdirSync(cacheDir, { recursive: true });

if (!force && existsSync(zipPath) && sha256File(zipPath) === SHA256) {
  console.log(`使用已校验的缓存 ${zipPath}`);
} else {
  console.log(`下载 ${URL}（约 110MB）...`);
  const res = await fetch(URL);
  if (!res.ok) {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}（${URL}）`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(zipPath, bytes);
  console.log(`下载完成：${zipPath}（${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB）`);
}

const actual = sha256File(zipPath);
if (actual !== SHA256) {
  throw new Error(
    `sha256 不匹配：期望 ${SHA256}，实际 ${actual}（${zipPath}）。请检查网络或代理，再用 --force 重新下载。`,
  );
}
console.log("sha256 校验通过");

// 只解出需要的两个 exe，不解整包
rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });
for (const bin of BINARIES) {
  const member = `${NAME}/bin/${bin}`;
  // tar 按 zip 内相对路径定位成员；strip 掉包根目录和 bin 两层，exe 直接落在 dest
  execFileSync("tar", ["-xf", zipPath, "-C", destDir, "--strip-components", "2", member], {
    stdio: "inherit",
  });
}

for (const bin of BINARIES) {
  const p = join(destDir, bin);
  if (!existsSync(p)) throw new Error(`解包后缺少 ${p}`);
  const size = statSync(p).size;
  if (size === 0) throw new Error(`解包得到空文件 ${p}`);
  console.log(`${bin}：${(size / 1024 / 1024).toFixed(1)}MB`);
}

console.log(JSON.stringify({ destDir, binaries: BINARIES.map((b) => join(destDir, b)) }, null, 2));
