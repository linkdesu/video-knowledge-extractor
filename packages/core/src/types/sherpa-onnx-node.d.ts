declare module "sherpa-onnx-node" {
  export class OfflineRecognizer {
    constructor(config: unknown);
    createStream(): { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void };
    decode(stream: unknown): void;
    getResult(stream: unknown): { text?: string };
  }
  export class OfflineSpeakerDiarization {
    constructor(config: unknown);
    sampleRate: number;
    process(samples: Float32Array): { start: number; end: number; speaker: number }[];
  }
  export class OfflinePunctuation {
    constructor(config: unknown);
    addPunct(text: string): string;
  }
  export function readWave(path: string): { samples: Float32Array; sampleRate: number };
}
declare module "sherpa-onnx-node" {
  export class SpeakerEmbeddingExtractor {
    constructor(config: unknown);
    createStream(): { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void };
    isReady(stream: unknown): boolean;
    compute(stream: unknown, enableExternalBuffer?: boolean): Float32Array;
  }
}
