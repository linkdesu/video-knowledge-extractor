import { createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { isAbsolute, resolve, sep } from "node:path";

export const MEDIA_SCHEME = "vnote-media";

/** 把 `<输出目录名>/<主题目录>/<切片>.mp4` 相对路径编码进 media url。 */
export function encodeClipUrl(relativePath: string): string {
  return `${MEDIA_SCHEME}://clip/${Buffer.from(relativePath, "utf8").toString("base64url")}`;
}

/** 源视频地址：只编码 videoId，路径由 handler 按库记录解析，url 本身不携带路径。 */
export function encodeSourceUrl(videoId: string): string {
  return `${MEDIA_SCHEME}://source/${videoId}`;
}

/** 封面地址：只编码 videoId，路径由 handler 按库记录解析；文件固定是 `<outputDir>/cover.jpg`。 */
export function encodeCoverUrl(videoId: string): string {
  return `${MEDIA_SCHEME}://cover/${videoId}`;
}

export type MediaLocation = {
  /** 校验过的绝对路径。 */
  absolutePath: string;
  /** 该扩展名对应的 content type。 */
  contentType: string;
};

export type UrlError =
  | { code: "bad-url"; message: string }
  | { code: "not-found"; message: string }
  | { code: "forbidden"; message: string };

const UNSAFE_SEGMENTS: Record<string, true> = { ".": true, "..": true };

const SOURCE_EXTENSIONS: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

/** 源视频只认库记录里登记的 sourcePath；videoId 不在库里直接 404。 */
export function decodeSourceUrl(
  url: string,
  resolveSource: (videoId: string) => string | undefined,
  realpath?: (p: string) => string,
  statIsFile?: (p: string) => boolean,
): MediaLocation | UrlError {
  const m = url.match(`^${MEDIA_SCHEME}://source/([A-Za-z0-9]+)$`);
  if (m === null || m[1] === undefined) return { code: "bad-url", message: "非法的媒体 url" };
  const sourcePath = resolveSource(m[1]);
  if (sourcePath === undefined) return { code: "not-found", message: "视频不在库中" };
  const rp = realpath ?? ((p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  });
  const real = rp(sourcePath);
  const dot = real.lastIndexOf(".");
  const ext = dot === -1 ? "" : real.slice(dot);
  const contentType = SOURCE_EXTENSIONS[ext];
  if (contentType === undefined) return { code: "forbidden", message: "源文件不是可播放的视频" };
  const isFile = statIsFile ?? ((p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!isFile(real)) return { code: "not-found", message: "源文件不存在" };
  return { absolutePath: real, contentType };
}

/**
 * 解码 `vnote-media://cover/<videoId>`：只认 `[A-Za-z0-9]+` 的 id，
 * 解析到 `<outputDir>/cover.jpg`；文件必须是常规文件，content type 固定 `image/jpeg`。
 * `realpath` 缺省用真实 fs 实现，测试可以注入 fake。
 */
export function decodeCoverUrl(
  url: string,
  resolveOutputDir: (videoId: string) => string | undefined,
  realpath?: (p: string) => string,
  statIsFile?: (p: string) => boolean,
): MediaLocation | UrlError {
  const m = url.match(`^${MEDIA_SCHEME}://cover/([A-Za-z0-9]+)$`);
  if (m === null || m[1] === undefined) return { code: "bad-url", message: "非法的媒体 url" };
  const outputDir = resolveOutputDir(m[1]);
  if (outputDir === undefined) return { code: "not-found", message: "视频不在库中" };
  const rp = realpath ?? ((p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  });
  const real = rp(resolve(outputDir, "cover.jpg"));
  const isFile = statIsFile ?? ((p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!isFile(real)) return { code: "not-found", message: "封面不存在" };
  return { absolutePath: real, contentType: "image/jpeg" };
}

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
): MediaLocation | UrlError {
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
  return { absolutePath: real, contentType: "video/mp4" };
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
  const startRaw = m[1];
  const endRaw = m[2];
  if (startRaw === undefined || endRaw === undefined) return "invalid";
  if (startRaw === "" && endRaw === "") return "invalid";
  const start = startRaw === "" ? undefined : Number(startRaw);
  const end = endRaw === "" ? undefined : Number(endRaw);
  if (startRaw !== "" && (!Number.isInteger(start) || (start as number) < 0)) return "invalid";
  if (endRaw !== "" && (!Number.isInteger(end) || (end as number) < 0)) return "invalid";
  if (endRaw !== "" && startRaw !== "" && (end as number) < (start as number)) return "invalid";
  if (endRaw !== "") {
    const s = startRaw === "" ? 0 : (start as number);
    if (s >= fileSize) return "unsatisfiable";
    return { start: s, end: Math.min(end as number, fileSize - 1) };
  }
  const s = start as number;
  if (s >= fileSize) return "unsatisfiable";
  return { start: s, end: fileSize - 1 };
}

export type MediaDecision =
  | { kind: "full"; absolutePath: string; size: number; contentType: string }
  | { kind: "range"; absolutePath: string; range: RangeSpec; size: number; contentType: string }
  | { kind: "range416"; size: number }
  | { kind: "error"; status: 404 | 403; message: string };

/** 一次请求的完整判定：解码 + 存在性 + Range。`resolvePath` / `stat` 注入便于测试。 */
export function decideMediaRequest(
  url: string,
  opts: {
    header: string | undefined;
    resolvePath: (url: string) => MediaLocation | UrlError;
    stat: (path: string) => number;
  },
): MediaDecision {
  const loc = opts.resolvePath(url);
  if ("code" in loc) return { kind: "error", status: loc.code === "not-found" ? 404 : 403, message: loc.message };
  const size = opts.stat(loc.absolutePath);
  const range = parseRangeHeader(opts.header, size);
  if (range === "invalid" || range === "unsatisfiable") return { kind: "range416", size };
  if (range !== undefined) return { kind: "range", absolutePath: loc.absolutePath, range, size, contentType: loc.contentType };
  return { kind: "full", absolutePath: loc.absolutePath, size, contentType: loc.contentType };
}

export const MEDIA_CONTENT_TYPE = "video/mp4";

export function mediaResponse(
  decision: MediaDecision,
  streamOf: (path: string, range?: RangeSpec) => Readable,
  signal?: AbortSignal,
): Response {
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
    "Content-Type": decision.contentType,
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
  // 播放器换片/关窗时取消请求：立即 destroy 底层文件流，Windows 上不再拖住句柄导致后续删除 EPERM
  if (signal !== undefined) {
    if (signal.aborted) body.destroy();
    else signal.addEventListener("abort", () => body.destroy(), { once: true });
  }
  return new Response(Readable.toWeb(body) as unknown as ReadableStream, { status, headers });
}

// 协议 handler 本体。root 与源路径解析都由 main 注入。
export function createMediaHandler(opts: {
  root: () => string;
  resolveSource: (videoId: string) => string | undefined;
  resolveOutputDir: (videoId: string) => string | undefined;
}): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    // 封面不走 Range 语义：无 Range 头也直接 200 全量，忽略任何 Range 请求
    if (request.url.startsWith(`${MEDIA_SCHEME}://cover/`)) {
      const loc = decodeCoverUrl(request.url, opts.resolveOutputDir);
      if ("code" in loc) {
        return new Response(loc.message, {
          status: loc.code === "not-found" ? 404 : 403,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      let body: Buffer;
      try {
        // 封面几十 KB：一次性读入内存，文件句柄零驻留（Windows 上流式读会拖住 cover.jpg 导致删目录 EPERM）
        body = readFileSync(loc.absolutePath);
      } catch {
        return new Response("封面不存在", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      return new Response(new Uint8Array(body), {
        headers: { "Content-Type": loc.contentType, "Content-Length": String(body.length) },
      });
    }
    const rangeHeader = request.headers.get("range");
    const isSource = request.url.startsWith(`${MEDIA_SCHEME}://source/`);
    const decision = decideMediaRequest(request.url, {
      header: rangeHeader === null ? undefined : rangeHeader,
      resolvePath: (u) => (isSource ? decodeSourceUrl(u, opts.resolveSource) : decodeClipUrl(u, opts.root())),
      stat: (p) => {
        try {
          return statSync(p).size;
        } catch {
          return 0;
        }
      },
    });
    return mediaResponse(
      decision,
      (path, range) =>
        createReadStream(path, {
          start: range === undefined ? undefined : range.start,
          end: range === undefined ? undefined : range.end,
        }),
      request.signal,
    );
  };
}
