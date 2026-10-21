/**
 * 子进程执行：收 stdout/stderr；非零退出默认抛错。
 */
export type ProcResult = { stdout: string; stderr: string; code: number };

export async function run(
  cmd: string[],
  opts: { label?: string; allowFail?: boolean } = {},
): Promise<ProcResult> {
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !opts.allowFail) {
    const tail = stderr.trim().split("\n").slice(-12).join("\n");
    throw new Error(`${opts.label ?? cmd[0]} failed (exit ${code})\n${tail}`);
  }
  return { stdout, stderr, code };
}
