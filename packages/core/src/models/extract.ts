import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createReadStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { run } from "../core/exec";
import type { ModelBundle } from "./catalog";

export type TarExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExecTar: TarExec = (args) => run(["tar", ...args], { label: `tar ${args.slice(0, 2).join(" ")}` });

/** 归档成员数上限：模型归档最多几个文件，超过几乎必然是坏包或投毒。 */
const MAX_MEMBERS = 200;

type Member = { name: string; type: string; size: number | null };

/**
 * 安全解包（ADR-0015 §4）：先全量验证成员清单与声明大小（此时不落盘），
 * 再逐成员解包并逐个核对实际大小，最后流式 sha256。
 * 解包前验证失败时 staging 保持为空；解包中失败删掉 staging。
 */
export async function extractArchive(
  archivePath: string,
  stagingDir: string,
  bundle: ModelBundle,
  execTar: TarExec = defaultExecTar,
): Promise<void> {
  if (bundle.source.kind !== "tar.bz2") throw new Error(`包 ${bundle.id} 是单文件，不走归档解包`);
  const members = await listMembers(archivePath, execTar);
  validateMembers(members, bundle);

  const allowed = new Set(bundle.source.members);
  const wanted = members.filter((m) => allowed.has(m.name));
  try {
    for (const member of wanted) {
      await extractOne(archivePath, stagingDir, member.name, execTar);
      const spec = bundle.files.find((f) => f.path === member.name);
      // wanted 全部来自 allowed，而 allowed 与 files.path 一一对应，这里必然命中
      if (spec === undefined) throw new Error(`成员 ${member.name} 不在清单内`);
      const actual = statSync(join(stagingDir, member.name)).size;
      if (actual !== spec.bytes) throw new Error(`成员 ${member.name} 解包后大小 ${actual} 与清单 ${spec.bytes} 不符`);
    }
    await verifyAll(stagingDir, wanted, bundle);
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

async function listMembers(archivePath: string, execTar: TarExec): Promise<Member[]> {
  const names = await execTar(["-tjf", archivePath]);
  const verbose = await execTar(["-tvjf", archivePath]);
  const verboseLines = verbose.stdout.split("\n").filter((l) => l.trim() !== "");
  const members: Member[] = [];
  for (const line of names.stdout.split("\n")) {
    const name = line.trim();
    if (name === "") continue;
    // 用「以成员名结尾」定位详例行；模型归档的成员名不含空格
    const detail = verboseLines.find((l) => l.endsWith(` ${name}`)) ?? "";
    members.push(parseMember(name, detail));
  }
  return members;
}

// tar -tvjf 行格式：权限位 链接数 属主 属组 大小 日期 时间 路径（BSD 日期 3 token、GNU 2 token）。
// 大小固定在第 5 个字段（index 4）；真实行恒 ≥8 列，列数不足视为畸形行，大小不可解析。
function parseMember(name: string, detail: string): Member {
  const fields = detail.trim().split(/\s+/);
  const perms = fields[0] ?? "";
  const type = perms.startsWith("d") ? "directory" : perms.startsWith("-") ? "file" : "other";
  const size = fields.length >= 8 ? Number(fields[4]) : NaN;
  return { name, type, size: Number.isFinite(size) ? size : null };
}

function validateMembers(members: Member[], bundle: ModelBundle): void {
  if (members.length > MAX_MEMBERS) throw new Error(`归档成员数 ${members.length} 超过上限 ${MAX_MEMBERS}`);
  const seen = new Set<string>();
  for (const member of members) {
    if (member.name.includes("\0")) throw new Error(`归档含空字节成员 ${JSON.stringify(member.name)}`);
    if (member.name.startsWith("/")) throw new Error(`归档含绝对路径成员 ${member.name}`);
    if (member.name.split("/").includes("..")) throw new Error(`归档含 .. 成员 ${member.name}`);
    if (seen.has(member.name)) throw new Error(`归档含重复成员 ${member.name}`);
    seen.add(member.name);
    if (member.type !== "file" && member.type !== "directory") {
      throw new Error(`归档含非普通文件/目录成员 ${member.name}（${member.type}）`);
    }
  }
  // 解包前就核对允许成员的声明大小与总大小；此时还没有任何 staging 文件
  const allowed = bundle.source.kind === "tar.bz2" ? bundle.source.members : [];
  let declaredTotal = 0;
  for (const name of allowed) {
    const spec = bundle.files.find((f) => f.path === name);
    if (spec === undefined) throw new Error(`清单成员 ${name} 没有对应的文件规格`);
    const member = members.find((m) => m.name === name);
    if (member === undefined) throw new Error(`归档缺少成员 ${name}`);
    if (member.size === null) throw new Error(`成员 ${name} 声明大小缺失`);
    if (member.size !== spec.bytes) throw new Error(`成员 ${name} 声明大小 ${member.size} 与清单 ${spec.bytes} 不符（解包前拒绝）`);
    declaredTotal += member.size;
  }
  const expectedTotal = bundle.files.reduce((sum, f) => sum + f.bytes, 0);
  if (declaredTotal !== expectedTotal) throw new Error(`归档声明总大小 ${declaredTotal} 与清单 ${expectedTotal} 不符`);
}

async function extractOne(archivePath: string, stagingDir: string, member: string, execTar: TarExec): Promise<void> {
  mkdirSync(dirname(join(stagingDir, member)), { recursive: true });
  const result = await execTar(["-xjf", archivePath, "-C", stagingDir, member]);
  if (result.stdout.trim() !== "" || result.stderr.trim() !== "") {
    throw new Error(`解包 ${member} 失败：${result.stderr.trim() || result.stdout.trim()}`);
  }
}

async function verifyAll(stagingDir: string, members: Member[], bundle: ModelBundle): Promise<void> {
  for (const member of members) {
    const spec = bundle.files.find((f) => f.path === member.name);
    if (spec === undefined) continue;
    const sha = await streamSha256(join(stagingDir, member.name));
    if (sha !== spec.sha256) throw new Error(`成员 ${member.name} sha256 不符（期望 ${spec.sha256.slice(0, 12)}…，实际 ${sha.slice(0, 12)}…）`);
  }
}

/** 流式 sha256，不整文件读进内存。 */
export async function streamSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash());
  });
  return hash.digest("hex");
}

/**
 * 扫描 modelDir 里的安装残留：`<bundle 顶级目录>.new-<uuid>` 与 `.old-<uuid>`。
 * 供 recoverModelDir（download.ts）前滚/回滚判定。
 */
export function listStagedInstalls(modelDir: string): { topDir: string; kind: "new" | "old"; suffix: string }[] {
  const result: { topDir: string; kind: "new" | "old"; suffix: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(modelDir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    const newMatch = entry.match(/^(.+)\.new-([0-9a-f-]+)$/);
    if (newMatch !== null && newMatch[1] !== undefined && newMatch[2] !== undefined) {
      result.push({ topDir: newMatch[1], kind: "new", suffix: newMatch[2] });
      continue;
    }
    const oldMatch = entry.match(/^(.+)\.old-([0-9a-f-]+)$/);
    if (oldMatch !== null && oldMatch[1] !== undefined && oldMatch[2] !== undefined) {
      result.push({ topDir: oldMatch[1], kind: "old", suffix: oldMatch[2] });
    }
  }
  return result;
}

/** 落位路径必须在 modelDir 内（resolve 后前缀校验，防 `..` 越界）。 */
export function assertInsideModelDir(modelDir: string, relativePath: string): void {
  const absModelDir = resolve(modelDir);
  const absTarget = resolve(absModelDir, relativePath);
  if (absTarget !== absModelDir && !absTarget.startsWith(absModelDir + "/")) {
    throw new Error(`落位路径 ${relativePath} 超出模型目录`);
  }
}

/** 包的顶级目录名（单文件包是 `.`，落位时直接放 modelDir 下）。 */
export function topDirOfBundle(bundle: ModelBundle): string {
  const first = bundle.files[0];
  if (first === undefined) throw new Error(`包 ${bundle.id} 没有文件`);
  const slash = first.path.indexOf("/");
  return slash === -1 ? "." : first.path.slice(0, slash);
}
