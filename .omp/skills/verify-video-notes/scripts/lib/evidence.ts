/**
 * 收尾产物清单（r58 验收 5）。
 *
 * 远端 run 目录里所有非缓存文件都是证据。以前 `down` 只按文件名白名单拉
 * `video.json` / `topic.md` / `trajectory.json` / `status.json`，别的东西静默留在
 * 远端。现在把它拆成纯逻辑：解析远端清单 → 排除渲染缓存 → 逐个比对本地大小，
 * 漏的、截断的都报出来，`down` 据此补拉并核对。
 */

export type RemoteFile = { path: string; bytes: number };

export type EvidenceGap = { path: string; reason: "missing" | "size"; expectedBytes: number; localBytes: number | null };

/** `Get-ChildItem … | ForEach-Object { "$($_.Length)`t$($_.FullName)" }` 的输出。 */
export function parseRemoteListing(output: string): RemoteFile[] {
  const files: RemoteFile[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const bytes = Number(line.slice(0, tab).trim());
    const path = line.slice(tab + 1).trim();
    if (!Number.isInteger(bytes) || bytes < 0 || path === "") continue;
    files.push({ path, bytes });
  }
  return files;
}

function splitPath(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment !== "");
}

/**
 * 远端路径相对 run 目录的段；不在 run 目录下（大小写不敏感地比较）时返回完整段，
 * 这样远程清单里混进别的路径也不会被误截断。
 */
export function relativeEvidencePath(remotePath: string, runDir: string): string[] {
  const segments = splitPath(remotePath);
  const base = splitPath(runDir);
  const prefixMatches =
    segments.length > base.length && base.every((segment, index) => segment.toLowerCase() === segments[index]?.toLowerCase());
  return prefixMatches ? segments.slice(base.length) : segments;
}

/** 渲染/Lab 缓存不是证据：`down` 会在远端剪掉它们，拉回来只会让证据目录膨胀。 */
export function isCacheFile(remotePath: string, runDir: string): boolean {
  return relativeEvidencePath(remotePath, runDir).some((segment) => segment.toLowerCase() === ".cache");
}

export function expectedEvidence(files: RemoteFile[], runDir: string): RemoteFile[] {
  return files.filter((file) => !isCacheFile(file.path, runDir));
}

/** 远端清单 vs 本地实际落盘大小；`localBytes(path)` 返回 null 表示本地没有这个文件。 */
export function evidenceGaps(expected: RemoteFile[], localBytes: (remotePath: string) => number | null): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  for (const file of expected) {
    const bytes = localBytes(file.path);
    if (bytes === null) gaps.push({ path: file.path, reason: "missing", expectedBytes: file.bytes, localBytes: null });
    else if (bytes !== file.bytes) gaps.push({ path: file.path, reason: "size", expectedBytes: file.bytes, localBytes: bytes });
  }
  return gaps;
}

export function describeGap(gap: EvidenceGap): string {
  return gap.reason === "missing" ? `未拉取：${gap.path}` : `大小不符：${gap.path}（远端 ${gap.expectedBytes}，本地 ${gap.localBytes}）`;
}
