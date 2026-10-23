/** 错误文案里的地址只留 origin 与路径，丢掉 query 与片段。 */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** 非 2xx 的状态码映射成中文文案；正文永远不进文案，地址只留 origin 与路径。 */
export function llmHttpErrorMessage(status: number, url: string): string {
  const shown = displayUrl(url);
  switch (status) {
    case 400:
      return "请求无效（HTTP 400）";
    case 401:
      return "API key 无效或已停用";
    case 403:
      return "没有访问权限（API key 可能受限）";
    case 404:
      return `接口地址不存在（${shown}）`;
    case 408:
    case 504:
      return "服务端超时";
    case 429:
      return "请求过于频繁或额度不足";
    default:
      return status >= 500 ? `服务端错误（HTTP ${status}）` : `请求失败（HTTP ${status}）`;
  }
}

/** 超时/中止判定：Node 与 Bun 的 name / code 写法各取一套。 */
export function isTimeoutError(err: unknown): boolean {
  const e = err as { name?: string; code?: string; cause?: unknown } | null;
  const code = e?.code ?? (e?.cause as { code?: string } | null)?.code;
  const name = e?.name ?? (e?.cause as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError" || code === "23" || code === "ABORT_ERR";
}

/** fetch 抛错（未收到响应）映射成中文文案；超时走 isTimeoutError，其余 Node 与 Bun 的 code 写法各取一套。 */
export function llmNetworkErrorMessage(err: unknown, url: string): string {
  const e = err as { code?: string; message?: string; cause?: unknown } | null;
  const code = e?.code ?? (e?.cause as { code?: string } | null)?.code;
  const shown = displayUrl(url);
  if (isTimeoutError(err)) {
    return "请求超时";
  }
  if (code === "ECONNREFUSED" || code === "ConnectionRefused") {
    return `连接被拒绝（${shown}）`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "DNSGetAddrInfo failed") {
    return `域名解析失败（${shown}）`;
  }
  return `无法连接（${e?.message ?? String(err)}）`;
}
