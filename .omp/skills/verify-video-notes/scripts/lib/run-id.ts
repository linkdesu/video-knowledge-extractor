/**
 * run id 的合法性（r51）。
 *
 * run id 会拼成 `tmp/verify/<run>`，而 `tmp/verify/latest` 是固定常量指针。macOS 的 APFS
 * 默认不区分大小写，`Latest` / `LATEST` 与 `latest` 是同一个 inode，所以只否决小写
 * `latest` 时：`latest` 尚不存在 → `--run Latest` 通过校验 → `up` 建好 `tmp/verify/Latest`、
 * 拉起 app、写完 state.json → 最后 `writeLatestPointer` 把这份证据当成“旧指针”删掉，
 * 换成一行文本。结果是 `up` 退出 0、state.json 消失、app 成孤儿，`down` / `doctor` 找不到它。
 *
 * 因此保留名按小写比较，`.` / `..` 与带路径分隔符的 id 也一律在新建目录、拉起 app 之前拒绝。
 */

/** 允许的字符集：字母数字与 `. _ -`（不含分隔符，所以拼路径时不会逃出 `tmp/verify`）。 */
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** 拒绝原因（中文，直接给人看）；合法时返回 null。 */
export function runIdProblem(runId: string): string | null {
  if (runId.trim() === "") return "--run 不能是空字符串";
  // 大小写不敏感：APFS / NTFS 上 Latest 就是 latest，run 目录与指针是同一个 inode
  if (runId.toLowerCase() === "latest") {
    return `--run 不能用 latest（大小写不敏感）：那是 tmp/verify/latest 指针本身，up 会把自己的 run 目录删成指针文件`;
  }
  if (runId === "." || runId === "..") {
    return `--run 不能是 ${runId}：会解析成证据根自身或 tmp 目录，而不是一个 run 目录`;
  }
  if (/[\\/]/.test(runId)) return `--run 不能带路径分隔符：${runId}`;
  if (!RUN_ID_PATTERN.test(runId)) return `--run 只接受字母数字与 . _ -：${runId}`;
  return null;
}
