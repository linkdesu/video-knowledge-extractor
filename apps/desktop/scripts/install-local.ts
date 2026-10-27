#!/usr/bin/env bun
/**
 * 双机本地安装脚本：
 * 1. 校验 package.json / apps/desktop / apps/cli / packages/core 版本号一致（可选校验相对基准 git ref 已递增）；
 * 2. 构建并重装 macOS 应用到 /Applications/Video Notes.app（清除 quarantine + ad-hoc 签名并校验 CFBundleShortVersionString）；
 * 3. 将对应版本的 Windows NSIS 安装包静默重装到 gamepc 的 D:\code\video-notes\app（安装前自动停止运行中的 Video Notes.exe，修复桌面/开始菜单快捷方式，校验 Uninstall/Registry/app.asar 版本号一致）。
 *
 * 用法：
 *   bun run install:local [--check-bump-against <git-ref>] [--mac-only | --win-only] [--skip-mac-build] [--win-installer <path>] [--ssh-host <host>]
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertVersionBumped,
  assertWorkspaceVersionsMatch,
} from "../src/main/release-version";

const desktopRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const macSystemAppPath = "/Applications/Video Notes.app";
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
  sshHost: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    checkBumpAgainst: null,
    macOnly: false,
    winOnly: false,
    skipMacBuild: false,
    winInstaller: null,
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
  return {
    appPath: macSystemAppPath,
    previousInstalledVersion,
    installedVersion,
  };
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

function resolveOrDownloadWinInstaller(
  version: string,
  explicitPath: string | null,
): { localPath: string | null; remotePath: string | null } {
  const expectedName = `Video Notes-${version}-setup.exe`;
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

  const candidates = [
    resolve(desktopRoot, `release-win/${expectedName}`),
    resolve(repoRoot, `tmp/installer/v${version}/${expectedName}`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return { localPath: c, remotePath: null };
    }
  }

  console.log(
    `[win] 本地未找到 ${expectedName}，尝试从 GitHub Actions (windows-build.yml) 下载...`,
  );
  const runsJson = runCmd(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      "windows-build.yml",
      "--limit",
      "10",
      "--json",
      "databaseId,status,conclusion,headSha",
    ],
    { env: ghEnv() },
  );
  const runs = JSON.parse(runsJson) as Array<{
    databaseId: number;
    status: string;
    conclusion: string | null;
    headSha: string;
  }>;
  const successRun = runs.find(
    (r) => r.status === "completed" && r.conclusion === "success",
  );
  if (!successRun) {
    throw new Error(
      `未找到成功的 windows-build.yml 运行记录，请先触发或等待 Windows 构建完成，或通过 --win-installer 指定 ${expectedName}`,
    );
  }
  const destDir = resolve(repoRoot, `tmp/installer/v${version}`);
  mkdirSync(destDir, { recursive: true });
  runCmd(
    "gh",
    [
      "run",
      "download",
      String(successRun.databaseId),
      "-n",
      "video-notes-windows-installer",
      "-D",
      destDir,
    ],
    { env: ghEnv(), inherit: true },
  );
  const downloaded = resolve(destDir, expectedName);
  if (!existsSync(downloaded)) {
    throw new Error(
      `下载的构建产物中未找到 ${expectedName}（实际目录: ${destDir}），请确认 CI 构建对应的版本号已更新为 ${version}`,
    );
  }
  return { localPath: downloaded, remotePath: null };
}

function installWindowsApp(
  version: string,
  sshHost: string,
  explicitInstaller: string | null,
) {
  const { localPath, remotePath } = resolveOrDownloadWinInstaller(
    version,
    explicitInstaller,
  );
  const remoteInstallerPath =
    remotePath ??
    `${defaultWinInstallerStageDir}\\Video Notes-${version}-setup.exe`;

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

[pscustomobject]@{
  exePath = $targetExe
  previousInstalledVersion = $previousVersion
  installedVersion = $reg.DisplayVersion
  uninstallerVersion = $uninstVer
  desktopShortcutTarget = $wsh.CreateShortcut($shortcuts[0]).TargetPath
  startMenuShortcutTarget = $wsh.CreateShortcut($shortcuts[1]).TargetPath
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
  return JSON.parse(lastLine) as {
    exePath: string;
    previousInstalledVersion: string | null;
    installedVersion: string;
    uninstallerVersion: string;
    desktopShortcutTarget: string;
    startMenuShortcutTarget: string;
  };
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
    );
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
