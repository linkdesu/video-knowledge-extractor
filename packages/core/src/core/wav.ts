import { readFileSync } from "node:fs";

/**
 * 纯 JS 的 WAV 读取：Electron utility process 里 NAPI 的 `readWave` 抛
 * "External buffers are not allowed"，而手写的 Float32Array 传给 diarize/decode 正常（r20 实测）。
 * 只接受 16-bit PCM；多声道按算术平均下混为单声道。
 */
export type WavData = { samples: Float32Array; sampleRate: number };

function expectUInt16(buf: Buffer, offset: number, what: string): number {
  if (offset + 2 > buf.length) throw new Error(`WAV 截断：${what} 缺字节`);
  return buf.readUInt16LE(offset);
}

function expectUInt32(buf: Buffer, offset: number, what: string): number {
  if (offset + 4 > buf.length) throw new Error(`WAV 截断：${what} 缺字节`);
  return buf.readUInt32LE(offset);
}

export function readWavBuffer(buf: Buffer): WavData {
  if (buf.length < 44 || buf.subarray(0, 4).toString() !== "RIFF" || buf.subarray(8, 12).toString() !== "WAVE") {
    throw new Error("WAV 文件损坏：缺少 RIFF/WAVE 头");
  }
  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let data: Buffer | undefined;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.subarray(offset, offset + 4).toString();
    const chunkSize = expectUInt32(buf, offset + 4, `${chunkId} 块大小`);
    const bodyStart = offset + 8;
    if (bodyStart + chunkSize > buf.length) throw new Error(`WAV 截断：${chunkId} 块只有 ${buf.length - bodyStart} 字节，声明 ${chunkSize}`);
    if (chunkId === "fmt ") {
      if (chunkSize < 16) throw new Error("WAV 文件损坏：fmt 块太小");
      const audioFormat = expectUInt16(buf, bodyStart, "音频格式");
      if (audioFormat !== 1) throw new Error(`WAV 只支持 16-bit PCM（格式 1），实际格式 ${audioFormat}`);
      fmt = {
        channels: expectUInt16(buf, bodyStart + 2, "声道数"),
        sampleRate: expectUInt32(buf, bodyStart + 4, "采样率"),
        bitsPerSample: expectUInt16(buf, bodyStart + 14, "位深"),
      };
      if (fmt.bitsPerSample !== 16) throw new Error(`WAV 只支持 16-bit PCM，实际位深 ${fmt.bitsPerSample}`);
    } else if (chunkId === "data") {
      data = buf.subarray(bodyStart, bodyStart + chunkSize);
    }
    // 块按 2 字节对齐
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }
  if (fmt === undefined) throw new Error("WAV 文件损坏：缺少 fmt 块");
  if (data === undefined) throw new Error("WAV 文件损坏：缺少 data 块");
  const frame = Math.floor(data.length / (fmt.channels * 2));
  const samples = new Float32Array(frame);
  for (let i = 0; i < frame; i++) {
    let sum = 0;
    for (let ch = 0; ch < fmt.channels; ch++) {
      sum += data.readInt16LE(i * fmt.channels * 2 + ch * 2) / 32768;
    }
    samples[i] = sum / fmt.channels;
  }
  return { samples, sampleRate: fmt.sampleRate };
}

export function readWav(path: string): WavData {
  return readWavBuffer(readFileSync(path));
}
