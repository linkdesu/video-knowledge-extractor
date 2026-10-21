import { describe, expect, test } from "bun:test";
import { readWavBuffer } from "../core/wav";

/** 构造最小 RIFF/WAVE：单块 fmt + data，16-bit PCM。 */
function makeWav(sampleRate: number, channels: number, frame: (ch: number) => number[]): Buffer {
  const samples = frame(channels);
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => bytes.writeInt16LE(v, i * 2));
  const chunk = Buffer.alloc(8 + bytes.length);
  chunk.write("data", 0);
  chunk.writeUInt32LE(bytes.length, 4);
  bytes.copy(chunk, 8);
  const fmt = Buffer.alloc(8 + 16);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * 2, 16);
  fmt.writeUInt16LE(channels * 2, 20);
  fmt.writeUInt16LE(16, 22);
  const body = Buffer.concat([fmt, chunk]);
  const riff = Buffer.alloc(12 + body.length);
  riff.write("RIFF", 0);
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write("WAVE", 8);
  body.copy(riff, 12);
  return riff;
}

describe("readWavBuffer", () => {
  test("16k 单声道：0x4000 → 0.5，采样率与长度原样", () => {
    const wav = makeWav(16000, 1, () => [0x4000, -0x4000, 32767]);
    const { samples, sampleRate } = readWavBuffer(wav);
    expect(sampleRate).toBe(16000);
    expect(samples.length).toBe(3);
    expect(samples[0]).toBe(0.5);
    expect(samples[1]).toBe(-0.5);
    expect(samples[2]).toBeCloseTo(0.99997, 4);
  });

  test("双声道按算术平均下混", () => {
    // 帧 0：ch0=16384(0.5)，ch1=-16384(-0.5) → 0；帧 1：两声道都 0x4000 → 0.5
    const wav = makeWav(16000, 2, () => [16384, -16384, 0x4000, 0x4000]);
    const { samples } = readWavBuffer(wav);
    expect(samples.length).toBe(2);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBe(0.5);
  });

  test("data 块长度不是整帧时只取完整帧", () => {
    const wav = makeWav(16000, 2, () => [1, 2, 3, 4, 5]); // 5 个样本，奇数
    const { samples } = readWavBuffer(wav);
    expect(samples.length).toBe(2);
  });

  test("截断的 data 块报错", () => {
    const wav = makeWav(16000, 1, () => [1, 2, 3]);
    const truncated = Buffer.from(wav.subarray(0, wav.length - 4));
    expect(() => readWavBuffer(truncated)).toThrow("截断");
  });

  test("缺少 RIFF/WAVE 头报错", () => {
    const wav = makeWav(16000, 1, () => [1, 2]);
    wav[0] = 0x00;
    expect(() => readWavBuffer(wav)).toThrow("RIFF/WAVE");
  });

  test("非 PCM 格式报错", () => {
    const wav = makeWav(16000, 1, () => [1, 2]);
    // fmt 块在 12 + 8（fmt 头）= 20 处开始，音频格式在 20
    wav.writeUInt16LE(2, 20);
    expect(() => readWavBuffer(wav)).toThrow("16-bit PCM");
  });
});
