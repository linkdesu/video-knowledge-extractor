#!/usr/bin/env bun
/**
 * 双机本地安装脚本：
 * 1. 校验 package.json / apps/desktop / apps/cli / packages/core 版本号一致（可选校验相对基准 git ref 已递增）；
 * 2. 构建并重装 macOS 应用到 /Applications/Video Notes.app（清除 quarantine + ad-hoc 签名并校验 CFBundleShortVersionString）；
 * 3. 将对应版本的 Windows NSIS 安装包静默重装到 gamepc 的 D:\code\video-notes\app（安装前自动停止运行中的 Video Notes.exe，修复桌面/开始菜单快捷方式，校验 Uninstall/Registry/app.asar 版本号一致）。
 *    CI 产物按「当前提交 + 当前 package 版本」对齐：只下载 headSha === HEAD 的成功 windows-build 运行，
 *    产物版本不符直接失败，等不到就超时报错，绝不回退去装旧提交/旧版本的包（r61 / #81）。
 *
 * 用法：
 *   bun run install:local [--check-bump-against <git-ref>] [--mac-only | --win-only] [--skip-mac-build] [--win-installer <path>] [--win-ci-wait-seconds <n>] [--ssh-host <host>]
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertVersionBumped,
  assertWorkspaceVersionsMatch,
} from "../src/main/release-version";
import {
  assertLlmConfigPreserved,
  readLlmConfigFingerprint,
} from "../src/main/settings-fingerprint";
import {
  assertArtifactVersion,
  cachedArtifactMatchesHead,
  installerName,
  pickReusableAncestorRun,
  waitForRunForCommit,
  type ArtifactProvenance,
  type WindowsBuildRun,
} from "./win-installer-source";

const desktopRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const macSystemAppPath = "/Applications/Video Notes.app";
/** 已安装 mac 应用的真实 userData：升级前后各读一次 LLM 配置指纹（r45c）。 */
const macUserDataDir = resolve(process.env.HOME ?? ".", "Library/Application Support/Video Notes");
const macReleaseAppPath = resolve(
  desktopRoot,
  `release/Video Notes-darwin-${process.arch}/Video Notes.app`,
);
const defaultWinInstallDir = "D:\\code\\video-notes\\app";
const defaultWinInstallerStageDir = "D:\\code\\video-notes\\installer";

interface CliOptions {
  checkBumpAgainst: string | null;
  macOnly: boolean;
  winOnly: boolean;
  skipMacBuild: boolean;
  winInstaller: string | null;
  winCiWaitSeconds: number;
  sshHost: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    checkBumpAgainst: null,
    macOnly: false,
    winOnly: false,
    skipMacBuild: false,
    winInstaller: null,
    winCiWaitSeconds: 1800,
    sshHost: "gamepc",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--check-bump-against") {
      opts.checkBumpAgainst = argv[++i] ?? null;
    } else if (arg === "--mac-only") {
      opts.macOnly = true;
    } else if (arg === "--win-only") {
      opts.winOnly = true;
    } else if (arg === "--skip-mac-build") {
      opts.skipMacBuild = true;
    } else if (arg === "--win-installer") {
      opts.winInstaller = argv[++i] ?? null;
    } else if (arg === "--win-ci-wait-seconds") {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (raw === undefined || !Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--win-ci-wait-seconds 需要一个非负秒数，实际: ${String(raw)}`);
      }
      opts.winCiWaitSeconds = parsed;
    } else if (arg === "--ssh-host") {
      opts.sshHost = argv[++i] ?? "gamepc";
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  if (opts.macOnly && opts.winOnly) {
    throw new Error("--mac-only 与 --win-only 不能同时指定");
  }
  return opts;
}

function runCmd(
  cmd: string,
  args: string[],
  options: { cwd?: string; inherit?: boolean; env?: NodeJS.ProcessEnv } = {},
): string {
  const res = spawnSync(cmd, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if ((res.status ?? 1) !== 0) {
    const detail = options.inherit
      ? ""
      : `\nstdout: ${res.stdout ?? ""}\nstderr: ${res.stderr ?? ""}`;
    throw new Error(
      `命令失败 (${cmd} ${args.join(" ")}, exit=${String(res.status)})${detail}`,
    );
  }
  return (res.stdout ?? "").trim();
}

function runWinPwsh(sshHost: string, psScript: string): string {
  const fullScript = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n${psScript.replace(/\r?\n/g, "\r\n")}\r\n`;
  if (fullScript.length < 600) {
    const encoded = Buffer.from(fullScript, "utf16le").toString("base64");
    return runCmd("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      sshHost,
      `pwsh -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    ]);
  }
  const localTmpDir = resolve(repoRoot, "tmp/installer");
  mkdirSync(localTmpDir, { recursive: true });
  const localPs1 = resolve(localTmpDir, "install-local-remote.ps1");
  const remotePs1 = `${defaultWinInstallerStageDir}\\install-local-remote.ps1`;
  writeFileSync(localPs1, `\uFEFF${fullScript}`, "utf8");
  runCmd("scp", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", localPs1, `${sshHost}:${remotePs1}`]);
  try {
    return runCmd("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      sshHost,
      `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${remotePs1}"`,
    ]);
  } finally {
    rmSync(localPs1, { force: true });
  }
}

function readAndVerifyWorkspaceVersion(checkBumpAgainst: string | null): {
  version: string;
  previousVersion: string | null;
} {
  const pkgPaths = [
    "package.json",
    "apps/desktop/package.json",
    "apps/cli/package.json",
    "packages/core/package.json",
  ];
  const map: Record<string, string> = {};
  for (const rel of pkgPaths) {
    const parsed = JSON.parse(readFileSync(resolve(repoRoot, rel), "utf8")) as {
      version: string;
    };
    map[rel] = parsed.version;
  }
  const version = assertWorkspaceVersionsMatch(map);
  let previousVersion: string | null = null;
  if (checkBumpAgainst !== null) {
    const rawPrev = runCmd("git", [
      "show",
      `${checkBumpAgainst}:apps/desktop/package.json`,
    ]);
    const prevPkg = JSON.parse(rawPrev) as { version: string };
    previousVersion = prevPkg.version;
    assertVersionBumped(previousVersion, version);
  }
  return { version, previousVersion };
}

function readMacPlistVersion(appPath: string): string | null {
  const plistPath = `${appPath}/Contents/Info.plist`;
  if (!existsSync(plistPath)) return null;
  const res = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", plistPath],
    { encoding: "utf8" },
  );
  if (res.status !== 0) return null;
  return (res.stdout ?? "").trim() || null;
}

function installMacApp(version: string, skipMacBuild: boolean) {
  const previousInstalledVersion = readMacPlistVersion(macSystemAppPath);
  // 升级前配置指纹：安装不得把已配齐的 LLM 设置弄丢
  const llmBefore = readLlmConfigFingerprint(macUserDataDir);
  if (!skipMacBuild) {
    console.log(`[mac] 正在打包 macOS 应用 (v${version})...`);
    runCmd("bun", ["run", "--cwd", "apps/desktop", "package:mac"], {
      inherit: true,
    });
  }
  if (!existsSync(macReleaseAppPath)) {
    throw new Error(`未找到打包产物: ${macReleaseAppPath}`);
  }
  const builtVersion = readMacPlistVersion(macReleaseAppPath);
  if (builtVersion !== version) {
    throw new Error(
      `macOS 打包产物版本 (${String(builtVersion)}) 与 package.json (${version}) 不一致`,
    );
  }

  // 若 /Applications/Video Notes.app 正在运行则先温和退出
  spawnSync("pkill", ["-f", `${macSystemAppPath}/Contents/MacOS/Video Notes`]);

  console.log(`[mac] 正在安装到 ${macSystemAppPath}...`);
  if (existsSync(macSystemAppPath)) {
    rmSync(macSystemAppPath, { recursive: true, force: true });
  }
  runCmd("ditto", [macReleaseAppPath, macSystemAppPath]);
  runCmd("xattr", ["-cr", macSystemAppPath]);

  const installedVersion = readMacPlistVersion(macSystemAppPath);
  if (installedVersion !== version) {
    throw new Error(
      `macOS 安装后版本校验失败：期望 ${version}，实际 ${String(installedVersion)}`,
    );
  }
  const llmAfter = readLlmConfigFingerprint(macUserDataDir);
  const llm = assertLlmConfigPreserved(llmBefore, llmAfter, "macOS");
  console.log(
    `[mac] LLM 配置：升级前 ${fmtFingerprint(llmBefore)} → 升级后 ${fmtFingerprint(llmAfter)}${llm.checked ? "（已校验保留）" : "（升级前未配置，跳过校验）"}`,
  );
  return {
    appPath: macSystemAppPath,
    previousInstalledVersion,
    installedVersion,
    llmBefore,
    llmAfter,
    llm,
  };
}

/** 只打印布尔与模型名；baseUrl 与 key 永不输出。 */
function fmtFingerprint(f: { configured: boolean; model: string | null }): string {
  return `configured=${String(f.configured)} model=${f.model ?? "(null)"}`;
}

function ghEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ALL_PROXY: "",
    HTTPS_PROXY: "",
    HTTP_PROXY: "",
    all_proxy: "",
    https_proxy: "",
    http_proxy: "",
  };
}

/** git 里某提交的 desktop 版本号；形状不对就报可读错误（不猜字段）。 */
function commitDesktopVersion(sha: string): string {
  const parsed: unknown = JSON.parse(
    runCmd("git", ["show", `${sha}:apps/desktop/package.json`]),
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string"
  ) {
    throw new Error(`提交 ${sha} 的 apps/desktop/package.json 缺少字符串 version`);
  }
  return parsed.version;
}

/** 只取字段够用的运行列表；headSha 用于锁定当前提交，displayTitle 便于报错定位。 */
function listWindowsBuildRuns(): WindowsBuildRun[] {
  const runsJson = runCmd(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      "windows-build.yml",
      "--limit",
      "40",
      "--json",
      "databaseId,status,conclusion,headSha,displayTitle",
    ],
    { env: ghEnv() },
  );
  return JSON.parse(runsJson) as WindowsBuildRun[];
}

/** 读 `tmp/installer/v<version>/provenance.json`；缺失或形状不对一律当作没有来源。 */
function readCacheProvenance(cacheDir: string): ArtifactProvenance | null {
  const path = resolve(cacheDir, "provenance.json");
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!("runId" in parsed) || typeof parsed.runId !== "number") return null;
    if (!("headSha" in parsed) || typeof parsed.headSha !== "string") return null;
    return { runId: parsed.runId, headSha: parsed.headSha };
  } catch {
    return null;
  }
}

/** 两个提交之间的差异路径；来源提交不在本地仓库时返回 null（表示算不出来）。 */
function diffPaths(fromSha: string, toSha: string): string[] | null {
  const res = spawnSync("git", ["diff", "--name-only", `${fromSha}..${toSha}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if ((res.status ?? 1) !== 0) return null;
  return (res.stdout ?? "")
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

function resolveOrDownloadWinInstaller(
  version: string,
  explicitPath: string | null,
  waitSeconds: number,
): { localPath: string | null; remotePath: string | null } {
  const expectedName = installerName(version);
  if (explicitPath !== null) {
    if (/^[A-Za-z]:\\/.test(explicitPath)) {
      return { localPath: null, remotePath: explicitPath };
    }
    const abs = resolve(repoRoot, explicitPath);
    if (!existsSync(abs)) {
      throw new Error(`指定的 --win-installer 不存在: ${abs}`);
    }
    return { localPath: abs, remotePath: null };
  }

  const sha = runCmd("git", ["rev-parse", "HEAD"]);
  const releaseWin = resolve(desktopRoot, `release-win/${expectedName}`);
  if (existsSync(releaseWin)) {
    console.log(`[win] 使用本机打包的 ${releaseWin}`);
    return { localPath: releaseWin, remotePath: null };
  }

  // 同版本的缓存可能来自别的提交（r61 实测）：只认来源提交与 HEAD 构建输入一致的缓存
  const cacheDir = resolve(repoRoot, `tmp/installer/v${version}`);
  const cachedPath = resolve(cacheDir, expectedName);
  if (existsSync(cachedPath)) {
    const provenance = readCacheProvenance(cacheDir);
    const changedPaths = provenance === null ? null : diffPaths(provenance.headSha, sha);
    if (provenance !== null && cachedArtifactMatchesHead(provenance, sha, changedPaths)) {
      console.log(
        `[win] 复用缓存 ${cachedPath}（来源 run ${provenance.runId} @ ${provenance.headSha.slice(0, 7)}）`,
      );
      return { localPath: cachedPath, remotePath: null };
    }
    console.log(
      `[win] 缓存 ${cachedPath} 没有可核对的来源提交或来源与 ${sha.slice(0, 7)} 构建输入不同，删除后重新下载`,
    );
    rmSync(cacheDir, { recursive: true, force: true });
  }

  // 只认「当前提交 + 当前版本」的 CI 产物：旧提交的成功运行绝不复用（r61 / #81）
  console.log(
    `[win] 本地未找到 ${expectedName}，按提交 ${sha.slice(0, 7)} 查找 windows-build.yml 的 v${version} 产物...`,
  );
  const initialRuns = listWindowsBuildRuns();
  // 末尾只改文档时 workflow 因 paths-ignore 不会起构建：仅当构建输入逐字节相同才复用祖先产物
  const ancestors: Array<{ sha: string; changedPaths: string[] }> = [];
  if (!initialRuns.some((r) => r.headSha === sha)) {
    for (const line of runCmd("git", ["rev-list", "--max-count=20", sha]).split("\n")) {
      const ancestorSha = line.trim();
      if (ancestorSha === "" || ancestorSha === sha) continue;
      ancestors.push({
        sha: ancestorSha,
        changedPaths: runCmd("git", ["diff", "--name-only", `${ancestorSha}..${sha}`])
          .split("\n")
          .map((p) => p.trim())
          .filter((p) => p !== ""),
      });
    }
  }
  const reused = pickReusableAncestorRun(initialRuns, sha, ancestors);
  const run =
    reused ??
    waitForRunForCommit({
      expectedSha: sha,
      expectedVersion: version,
      fetchRuns: listWindowsBuildRuns,
      sleep: (ms) => Bun.sleepSync(ms),
      timeoutMs: waitSeconds * 1000,
      pollMs: 15_000,
      log: (message) => console.log(message),
    });
  if (reused !== null) {
    console.log(
      `[win] HEAD ${sha.slice(0, 7)} 只改了不触发构建的文档，复用构建输入完全一致的 ${reused.headSha.slice(0, 7)} 产物（run ${reused.databaseId}）`,
    );
  }
  // 构建产物版本 = 该提交的 package.json 版本：先读 git，版本不符就别浪费 174 MB 下载
  const builtVersion = commitDesktopVersion(run.headSha);
  if (builtVersion !== version) {
    throw new Error(
      `CI 产物版本不符：run ${run.databaseId}（${run.headSha.slice(0, 7)}）构建的是 v${builtVersion}，期望 v${version}。` +
        `请先把四个 package.json 同步到 ${version} 并等该提交的 Windows CI 重新构建完成，本脚本不会退回去装旧版本。`,
    );
  }
  const destDir = resolve(repoRoot, `tmp/installer/v${version}`);
  // 清空该版本目录，避免上次失败留下的旧产物在这里冒充本版本
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  runCmd(
    "gh",
    [
      "run",
      "download",
      String(run.databaseId),
      "-n",
      "video-notes-windows-installer",
      "-D",
      destDir,
    ],
    { env: ghEnv(), inherit: true },
  );
  const files = readdirSync(destDir, { recursive: true, encoding: "utf8" }).map((f) =>
    f.split(/[/\\]/).pop()!,
  );
  const picked = assertArtifactVersion(files, {
    version,
    runId: run.databaseId,
    headSha: run.headSha,
  });
  const downloaded = resolve(destDir, picked);
  if (!existsSync(downloaded)) {
    throw new Error(
      `下载的构建产物中未找到 ${expectedName}（实际目录: ${destDir}），请确认 CI 构建对应的版本号已更新为 ${version}`,
    );
  }
  // 记录来源提交：下次复用这个缓存前要核对（同版本号可能来自别的提交）
  writeFileSync(
    resolve(destDir, "provenance.json"),
    `${JSON.stringify({ runId: run.databaseId, headSha: run.headSha }, null, 2)}\n`,
  );
  return { localPath: downloaded, remotePath: null };
}

function installWindowsApp(
  version: string,
  sshHost: string,
  explicitInstaller: string | null,
  waitSeconds: number,
) {
  const { localPath, remotePath } = resolveOrDownloadWinInstaller(
    version,
    explicitInstaller,
    waitSeconds,
  );
  const remoteInstallerPath =
    remotePath ??
    `${defaultWinInstallerStageDir}\\${installerName(version)}`;

  if (localPath !== null) {
    runWinPwsh(
      sshHost,
      `New-Item -ItemType Directory -Force -Path '${defaultWinInstallerStageDir}' | Out-Null`,
    );
    console.log(`[win] 正在上传安装包到 ${sshHost}:${remoteInstallerPath}...`);
    runCmd("scp", [localPath, `${sshHost}:${remoteInstallerPath}`], {
      inherit: true,
    });
  }

  console.log(
    `[win] 正在 ${sshHost} 上静默安装 Video Notes v${version} 到 ${defaultWinInstallDir}...`,
  );
  const installAndVerifyPs = `
$ErrorActionPreference = 'Stop'
$installer = '${remoteInstallerPath}'
$installDir = '${defaultWinInstallDir}'
$expectedVersion = '${version}'

if (-not (Test-Path -LiteralPath $installer)) {
  throw "Windows 安装包不存在: $installer"
}

$prevReg = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like '*Video Notes*' } |
  Select-Object -First 1
$previousVersion = if ($null -ne $prevReg) { $prevReg.DisplayVersion } else { $null }

# 升级前后各读一次 LLM 配置指纹（只回 configured/model，绝不出 baseUrl/key）
function Get-LlmFingerprint {
  $d = Join-Path $env:APPDATA 'Video Notes'
  $base = $false
  $model = $null
  $sp = Join-Path $d 'settings.json'
  if (Test-Path -LiteralPath $sp) {
    try {
      $s = Get-Content -LiteralPath $sp -Raw | ConvertFrom-Json
      if ($null -ne $s.llm -and [bool]$s.llm.baseUrl) { $base = $true }
      if ($null -ne $s.llm -and $s.llm.model) { $model = [string]$s.llm.model }
    } catch {}
  }
  $hasKey = $false
  $kp = Join-Path $d 'secrets.bin'
  if (Test-Path -LiteralPath $kp) {
    try {
      $sec = Get-Content -LiteralPath $kp -Raw | ConvertFrom-Json
      if ($null -ne $sec.llm -and [bool]$sec.llm) { $hasKey = $true }
    } catch {}
  }
  [pscustomobject]@{ configured = [bool]($base -and $hasKey); model = $model }
}
$llmBefore = Get-LlmFingerprint

# 停止所有正在运行的 Video Notes 进程，避免锁死 app.asar 与 Video Notes.exe
Get-Process -Name 'Video Notes' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
  $running = Get-Process -Name 'Video Notes' -ErrorAction SilentlyContinue
  if (-not $running) { break }
  Start-Sleep -Milliseconds 300
}

# 执行 NSIS 静默安装，固定写入标准目录 D:\\code\\video-notes\\app
cmd.exe /c "start /wait \`"\`" \`"$installer\`" /S /D=$installDir"
if ($LASTEXITCODE -ne 0) {
  throw "NSIS 静默安装失败，exitCode=$LASTEXITCODE"
}

# 清理历史遗留的桌面测试安装目录（如 C:\\Users\\xieal\\Desktop\\新建文件夹\\Video Notes）
$legacyTestDir = Join-Path $env:USERPROFILE 'Desktop\\新建文件夹\\Video Notes'
if (Test-Path -LiteralPath $legacyTestDir) {
  Remove-Item -LiteralPath $legacyTestDir -Recurse -Force -ErrorAction SilentlyContinue
}
$legacyParentDir = Join-Path $env:USERPROFILE 'Desktop\\新建文件夹'
if ((Test-Path -LiteralPath $legacyParentDir) -and ((Get-ChildItem -LiteralPath $legacyParentDir -Force | Measure-Object).Count -eq 0)) {
  Remove-Item -LiteralPath $legacyParentDir -Force -ErrorAction SilentlyContinue
}

# 确保桌面与开始菜单快捷方式均指向标准安装路径 D:\\code\\video-notes\\app\\Video Notes.exe
$targetExe = Join-Path $installDir 'Video Notes.exe'
$wsh = New-Object -ComObject WScript.Shell
$shortcuts = @(
  (Join-Path $env:USERPROFILE 'Desktop\\Video Notes.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Video Notes.lnk')
)
foreach ($lnkPath in $shortcuts) {
  $sc = $wsh.CreateShortcut($lnkPath)
  $sc.TargetPath = $targetExe
  $sc.WorkingDirectory = $installDir
  $sc.Description = '本地视频转结构化 Markdown 与切片的知识提取工具'
  $sc.Save()
}

# 校验 1：可执行文件与 Uninstall ProductVersion
$uninstExe = Join-Path $installDir 'Uninstall Video Notes.exe'
if (-not (Test-Path -LiteralPath $targetExe)) {
  throw "安装后未找到 $targetExe"
}
$uninstVer = (Get-Item -LiteralPath $uninstExe).VersionInfo.ProductVersion
if ($uninstVer -ne $expectedVersion) {
  throw "Uninstall Video Notes.exe ProductVersion ($uninstVer) 与期望 ($expectedVersion) 不一致"
}

# 校验 2：注册表 DisplayVersion
$reg = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like '*Video Notes*' } |
  Select-Object -First 1
if ($null -eq $reg -or $reg.DisplayVersion -ne $expectedVersion) {
  $actualReg = if ($null -ne $reg) { $reg.DisplayVersion } else { 'null' }
  throw "注册表 DisplayVersion ($actualReg) 与期望 ($expectedVersion) 不一致"
}

# 校验 3：resources\\app.asar 内的 package.json version（app.getVersion() 读取源）
$asarPath = Join-Path $installDir 'resources\\app.asar'
$fs = [System.IO.File]::OpenRead($asarPath)
try {
  $hdrBuf = New-Object byte[] 16
  [void]$fs.Read($hdrBuf, 0, 16)
  $headerSize = [BitConverter]::ToUInt32($hdrBuf, 4)
  $jsonSize = [BitConverter]::ToUInt32($hdrBuf, 12)
  $jsonBuf = New-Object byte[] $jsonSize
  [void]$fs.Read($jsonBuf, 0, $jsonSize)
  $headerObj = [System.Text.Encoding]::UTF8.GetString($jsonBuf) | ConvertFrom-Json
  $pkgEntry = $headerObj.files."package.json"
  $dataOffset = 8 + $headerSize + [int64]$pkgEntry.offset
  [void]$fs.Seek($dataOffset, [System.IO.SeekOrigin]::Begin)
  $pkgBuf = New-Object byte[] ([int]$pkgEntry.size)
  [void]$fs.Read($pkgBuf, 0, [int]$pkgEntry.size)
  $asarPkg = [System.Text.Encoding]::UTF8.GetString($pkgBuf) | ConvertFrom-Json
} finally {
  $fs.Close()
}
if ([string]$asarPkg.version -ne $expectedVersion) {
  throw "app.asar 内 package.json 的 version ($($asarPkg.version)) 未匹配 $expectedVersion"
}

$llmAfter = Get-LlmFingerprint
[pscustomobject]@{
  exePath = $targetExe
  previousInstalledVersion = $previousVersion
  installedVersion = $reg.DisplayVersion
  uninstallerVersion = $uninstVer
  desktopShortcutTarget = $wsh.CreateShortcut($shortcuts[0]).TargetPath
  startMenuShortcutTarget = $wsh.CreateShortcut($shortcuts[1]).TargetPath
  llmBefore = $llmBefore
  llmAfter = $llmAfter
} | ConvertTo-Json -Compress
`;
  const rawJson = runWinPwsh(sshHost, installAndVerifyPs);
  const lastLine = rawJson
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") && l.endsWith("}"))
    .pop();
  if (!lastLine) {
    throw new Error(`Windows 安装校验未返回有效 JSON: ${rawJson}`);
  }
  const parsed = JSON.parse(lastLine) as {
    exePath: string;
    previousInstalledVersion: string | null;
    installedVersion: string;
    uninstallerVersion: string;
    desktopShortcutTarget: string;
    startMenuShortcutTarget: string;
    llmBefore: { configured: boolean; model: string | null };
    llmAfter: { configured: boolean; model: string | null };
  };
  const llm = assertLlmConfigPreserved(parsed.llmBefore, parsed.llmAfter, "Windows");
  console.log(`[win] LLM 配置：升级前 ${fmtFingerprint(parsed.llmBefore)} → 升级后 ${fmtFingerprint(parsed.llmAfter)}${llm.checked ? "（已校验保留）" : "（升级前未配置，跳过校验）"}`);
  return { ...parsed, llm };
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const { version, previousVersion } = readAndVerifyWorkspaceVersion(
    opts.checkBumpAgainst,
  );

  const summary: Record<string, unknown> = {
    version,
    previousVersion,
  };

  if (!opts.winOnly) {
    summary.mac = installMacApp(version, opts.skipMacBuild);
  }
  if (!opts.macOnly) {
    summary.windows = installWindowsApp(
      version,
      opts.sshHost,
      opts.winInstaller,
      opts.winCiWaitSeconds,
    );
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
