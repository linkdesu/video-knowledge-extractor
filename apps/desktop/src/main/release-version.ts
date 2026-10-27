/**
 * 版本号一致性与递增校验：确保根仓库、desktop、cli、core 四个包版本完全一致，
 * 且每次迭代交付时版本号严格递增。
 */

export function parseSemver(version: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (m === null) {
    throw new Error(`非法版本号 "${version}"：必须为 X.Y.Z 格式的非负整数`);
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);
  if (aMaj !== bMaj) return aMaj > bMaj ? 1 : -1;
  if (aMin !== bMin) return aMin > bMin ? 1 : -1;
  if (aPat !== bPat) return aPat > bPat ? 1 : -1;
  return 0;
}

export function assertWorkspaceVersionsMatch(versions: Record<string, string>): string {
  const entries = Object.entries(versions);
  if (entries.length === 0) {
    throw new Error("未提供任何 package.json 版本信息");
  }
  const [firstPath, firstVer] = entries[0]!;
  parseSemver(firstVer);
  const mismatches: string[] = [];
  for (const [path, ver] of entries.slice(1)) {
    parseSemver(ver);
    if (ver !== firstVer) {
      mismatches.push(`${path}=${ver}（期望与 ${firstPath}=${firstVer} 一致）`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`工作区 package.json 版本号不一致：${mismatches.join("；")}`);
  }
  return firstVer;
}

export function assertVersionBumped(previous: string, current: string): void {
  if (compareSemver(current, previous) <= 0) {
    throw new Error(`版本号未递增：当前版本 ${current} 必须大于上一版本 ${previous}`);
  }
}
