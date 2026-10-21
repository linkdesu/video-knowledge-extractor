import { createReadStream, realpathSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { isAbsolute, resolve, sep } from "node:path";

export const MEDIA_SCHEME = "vnote-media";

/** 把 `<输出目录名>/<主题目录>/<切片>.mp4` 相对路径编码进 media url。 */
export function encodeClipUrl(relativePath: string): string {
  return `${MEDIA_SCHEME}://clip/${Buffer.from(relativePath, "utf8").toString("base64url")}`;
}

export type ClipLocation = {
  /** 相对 notesRoot 的路径。 */
  relativePath: string;
  /** 校验过的绝对路径。 */
  absolutePath: string;
};

export type UrlError =
  | { code: "bad-url"; message: string }
  | { code: "not-found"; message: string }
  | { code: "forbidden"; message: string };

const UNSAFE_SEGMENTS: Record<string, true> = { ".": true, "..": true };

/**
 * 解码 `vnote-media://clip/<base64url>`：
 * 拒绝空段、`.`、`..`、绝对路径、反斜杠；resolve 到 root 下，realpath 后再确认仍在 root 内；
 * 扩展名必须 .mp4。`realpath` 缺省用真实 fs 实现，测试可以注入 fake。
 */
export function decodeClipUrl(
  url: string,
  root: string,
  realpath?: (p: string) => string,
  statIsFile?: (p: string) => boolean,
): ClipLocation | UrlError {
  const m = url.match(`^${MEDIA_SCHEME}://clip/([A-Za-z0-9_-]+)$`);
  if (m === null || m[1] === undefined) return { code: "bad-url", message: "非法的媒体 url" };
  const decoded = Buffer.from(m[1], "base64url").toString("utf8");
  if (isAbsolute(decoded)) return { code: "forbidden", message: "非法的媒体路径" };
  const segments = decoded.split("/");
  if (segments.length < 2 || segments.some((s) => s === "" || UNSAFE_SEGMENTS[s] !== undefined || s.includes("\\"))) {
    return { code: "forbidden", message: "非法的媒体路径" };
  }
  const rp = realpath ?? ((p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  });
  const rootReal = rp(root);
  const candidate = resolve(rootReal, ...segments);
  // 逻辑路径先确认在 root 内；realpath 展开符号链接后再确认一次
  if (candidate !== rootReal && !candidate.startsWith(rootReal + sep)) return { code: "forbidden", message: "路径越界" };
  const real = rp(candidate);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) return { code: "forbidden", message: "路径越界" };
  if (!real.endsWith(".mp4")) return { code: "forbidden", message: "只允许 .mp4" };
  const isFile = statIsFile ?? ((p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!isFile(real)) return { code: "not-found", message: "文件不存在" };
  return { relativePath: segments.join("/"), absolutePath: real };
}

export type RangeSpec = { start: number; end: number };

/**
 * 解析 `bytes=start-end` / `bytes=start-` / `bytes=-N`（后缀）。
 * 非法格式返回 "invalid"（→ 416）；起点超出文件返回 "unsatisfiable"（→ 416 带 Content-Range）；
 * 无 Range 头返回 undefined（→ 200 全量）。
 */
export function parseRangeHeader(
  header: string | undefined,
  fileSize: number,
): RangeSpec | "invalid" | "unsatisfiable" | undefined {
  if (header === undefined || header === "") return undefined;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (m === null) return "invalid";
  const [, startRaw, endRaw] = m;
  if (startRaw === "" && endRaw === "") return "invalid";
  if (startRaw === "") {
    // suffix：最后 N 字节
    const n = Number(endRaw);
    if (n === 0) return "unsatisfiable";
    return { start: Math.max(0, fileSize - n), end: fileSize - 1 };
  }
  const start = Number(startRaw);
  const end = endRaw === "" ? fileSize - 1 : Number(endRaw);
  if (start >= fileSize) return "unsatisfiable";
  if (start > end) return "invalid";
  return { start, end: Math.min(end, fileSize - 1) };
}

export type MediaDecision =
  | { kind: "full"; absolutePath: string; size: number }
  | { kind: "range"; absolutePath: string; range: RangeSpec; size: number }
  | { kind: "range416"; size: number }
  | { kind: "error"; status: 404 | 403; message: string };

/** 一次请求的完整判定：解码 + 存在性 + Range。`resolvePath` / `stat` 注入便于测试。 */
export function decideMediaRequest(
  url: string,
  opts: {
    root: string;
    header: string | undefined;
    resolvePath: (url: string) => ClipLocation | UrlError;
    stat: (path: string) => number;
  },
): MediaDecision {
  const loc = opts.resolvePath(url);
  if ("code" in loc) return { kind: "error", status: loc.code === "not-found" ? 404 : 403, message: loc.message };
  const size = opts.stat(loc.absolutePath);
  const range = parseRangeHeader(opts.header, size);
  if (range === "invalid" || range === "unsatisfiable") return { kind: "range416", size };
  if (range !== undefined) return { kind: "range", absolutePath: loc.absolutePath, range, size };
  return { kind: "full", absolutePath: loc.absolutePath, size };
}

export const MEDIA_CONTENT_TYPE = "video/mp4";

export function mediaResponse(decision: MediaDecision, streamOf: (path: string, range?: RangeSpec) => Readable): Response {
  if (decision.kind === "error") {
    return new Response(decision.message, {
      status: decision.status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (decision.kind === "range416") {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${decision.size}` } });
  }
  const headers: Record<string, string> = {
    "Content-Type": MEDIA_CONTENT_TYPE,
    "Accept-Ranges": "bytes",
  };
  let status = 200;
  let range: RangeSpec | undefined;
  if (decision.kind === "range") {
    status = 206;
    range = decision.range;
    const length = range.end - range.start + 1;
    headers["Content-Length"] = String(length);
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${decision.size}`;
  } else {
    headers["Content-Length"] = String(decision.size);
  }
  const body = streamOf(decision.absolutePath, range);
  return new Response(Readable.toWeb(body) as unknown as ReadableStream, { status, headers });
}

// 协议 handler 本体。root 在 whenReady 注册时由 main 闭包注入，
// 不走 env：env 在 Finder 启动时可能还没被 .env 补全，闭包值才和 settings() 一致。
export function createMediaHandler(notesRootValue: string): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const rangeHeader = request.headers.get("range");
    const decision = decideMediaRequest(request.url, {
      root: notesRootValue,
      header: rangeHeader === null ? undefined : rangeHeader,
      resolvePath: (u) => decodeClipUrl(u, notesRootValue),
      stat: (p) => {
        try {
          return statSync(p).size;
        } catch {
          return 0;
        }
      },
    });
    return mediaResponse(decision, (path, range) =>
      createReadStream(path, {
        start: range === undefined ? undefined : range.start,
        end: range === undefined ? undefined : range.end,
      }),
    );
  };
}
