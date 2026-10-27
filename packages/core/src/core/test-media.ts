/**
 * 测试用合成媒体：真 ffmpeg 生成，仅被 `*.test.ts` 引用，不进打包产物。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const TS_PACKET_BYTES = 188;

/** 合法的 AAC-in-MPEG-TS（正弦波，无语音；只用于解码路径，不用于 ASR 断言）。 */
export function makeDecodableTs(path: string, seconds = 2): void {
  execFileSync(
    "ffmpeg",
    ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "aac", "-b:a", "48k", "-f", "mpegts", path],
    { stdio: "pipe" },
  );
}

/**
 * 容器合法、AAC 载荷是垃圾：复现加密/损坏的直播录像（ffprobe 照给时长，ffmpeg 解码全错、退出非零）。
 * 只改写 ADTS 帧头之后的载荷，TS 包结构、PES 与 ADTS 帧头保持完整，所以 demux 成功、decode 失败。
 */
export function makeUndecodableAacTs(path: string): void {
  makeDecodableTs(path, 2);
  const data = Buffer.from(readFileSync(path));
  const pidOf = (off: number) => ((data[off + 1]! & 0x1f) << 8) | data[off + 2]!;
  // 载荷起点：adaptation_field_control 2 = 只有 adaptation，3 = 两者都有（长度在 offset+4）
  const payloadStartOf = (off: number) => {
    const control = (data[off + 3]! >> 4) & 0x03;
    return control === 2 ? -1 : control === 3 ? 5 + data[off + 4]! : 4;
  };
  const sectionOf = (off: number): Buffer | null => {
    const start = payloadStartOf(off);
    if (start < 4 || start >= TS_PACKET_BYTES) return null;
    return data.subarray(off + start, off + TS_PACKET_BYTES);
  };

  // PAT → PMT → 第一条 AAC stream 的 PID；解析不出就报错，避免静默生成“没改坏”的 fixture
  let pmtPid = -1;
  for (let off = 0; off + TS_PACKET_BYTES <= data.length && pmtPid < 0; off += TS_PACKET_BYTES) {
    if (pidOf(off) !== 0) continue;
    const section = sectionOf(off);
    const start = section === null ? -1 : 1 + section[0]!; // pointer_field
    if (section !== null && start > 0 && section[start] === 0x00) pmtPid = ((section[start + 10]! & 0x1f) << 8) | section[start + 11]!;
  }
  if (pmtPid < 0) throw new Error("合成 TS 缺少 PAT");
  let audioPid = -1;
  for (let off = 0; off + TS_PACKET_BYTES <= data.length && audioPid < 0; off += TS_PACKET_BYTES) {
    if (pidOf(off) !== pmtPid) continue;
    const section = sectionOf(off);
    const start = section === null ? -1 : 1 + section[0]!; // pointer_field
    if (section === null || start < 0 || section[start] !== 0x02) continue;
    let at = start + 12 + (((section[start + 10]! & 0x0f) << 8) | section[start + 11]!);
    const end = start + 3 + (((section[start + 1]! & 0x0f) << 8) | section[start + 2]!);
    while (at + 5 <= end) {
      const streamType = section[at]!;
      if (streamType === 0x0f || streamType === 0x11) {
        audioPid = ((section[at + 1]! & 0x1f) << 8) | section[at + 2]!;
        break;
      }
      at += 5 + (((section[at + 3]! & 0x0f) << 8) | section[at + 4]!);
    }
  }
  if (audioPid < 0) throw new Error("合成 TS 缺少 AAC audio stream");

  const positions: number[] = [];
  for (let off = 0; off + TS_PACKET_BYTES <= data.length; off += TS_PACKET_BYTES) {
    if (pidOf(off) !== audioPid) continue;
    for (let i = off + payloadStartOf(off); i < off + TS_PACKET_BYTES; i++) positions.push(i);
  }
  // 把载荷拼成连续 ES，按 ADTS 帧走一遍：帧头（7 字节）保留，其余填固定垃圾
  const es = Buffer.from(positions.map((i) => data[i] ?? 0));
  let frameStart = 0;
  while (frameStart + 7 <= es.length) {
    if (es[frameStart] !== 0xff || (es[frameStart + 1] ?? 0) >> 4 !== 0x0f) {
      frameStart += 1;
      continue;
    }
    const frameLength = ((es[frameStart + 3]! & 0x03) << 11) | (es[frameStart + 4]! << 3) | ((es[frameStart + 5]! & 0xe0) >> 5);
    if (frameLength < 7) {
      frameStart += 1;
      continue;
    }
    for (let i = frameStart + 7; i < Math.min(frameStart + frameLength, es.length); i++) data[positions[i]!] = 0xa5;
    frameStart += frameLength;
  }
  writeFileSync(path, data);
}
