
export function fmtClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function fmtElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** 词表「修改时间」：月-日 时:分，本地时区。 */
export function fmtDateTime(iso: string | null): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function videoName(sourcePath: string): string {
  const seg = sourcePath.split("/").filter((s) => s.length > 0);
  return seg.at(-1) ?? sourcePath;
}

export function errMessage(err: unknown): string {
  const original = err instanceof Error ? err.message : String(err);
  let s = original;
  // Electron IPC 会把远端错误包成 Error invoking remote method 'x': Error: 正文
  // 多层嵌套时前缀会连续出现，逐层剥掉
  let wrapped = true;
  while (wrapped) {
    wrapped = false;
    const m1 = s.match(/^Error invoking remote method '[^']*':\s*/i);
    if (m1 !== null) {
      s = s.slice(m1[0].length);
      wrapped = true;
      continue;
    }
    const m2 = s.match(/^Error:\s*/);
    if (m2 !== null) {
      s = s.slice(m2[0].length);
      wrapped = true;
    }
  }
  // 整条只有前缀时保留原文：回退 String(err) 会多出一层 "Error: "
  return s.length > 0 ? s : original;
}
