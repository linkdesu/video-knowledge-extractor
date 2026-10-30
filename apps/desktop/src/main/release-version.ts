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

/**
 * Windows PE 版本资源读回来可能是 `0.1.23` 也可能是四段 `0.1.23.0`，按段比较、末尾零忽略。
 * 非数字段返回 null（调用方按不匹配处理）。r64：exe 属性页的版本号必须等于 package.json 版本。
 */
function windowsVersionParts(value: string): number[] | null {
  const text = value.trim();
  if (!/^\d+(?:\.\d+)*$/.test(text)) return null;
  const parts = text.split(".").map(Number);
  while (parts.length > 3 && parts[parts.length - 1] === 0) parts.pop();
  return parts;
}

export function assertExeVersionMatches(
  actual: { fileVersion: string | null; productVersion: string | null },
  expected: string,
): void {
  const want = windowsVersionParts(expected);
  if (want === null) throw new Error(`期望版本号不是数字段格式：${expected}`);
  const mismatches: string[] = [];
  for (const [label, value] of [
    ["FileVersion", actual.fileVersion],
    ["ProductVersion", actual.productVersion],
  ] as const) {
    const got = value === null ? null : windowsVersionParts(value);
    if (got === null || got.length !== want.length || want.some((part, i) => part !== got[i])) {
      mismatches.push(`${label}=${value ?? "null"}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`exe 版本资源与 package.json 不一致：期望 ${expected}，实际 ${mismatches.join("，")}`);
  }
}
