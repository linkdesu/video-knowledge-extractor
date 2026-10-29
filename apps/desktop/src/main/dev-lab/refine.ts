/**
 * 二次聚类（r48 Lab）：移植 `tmp/ref/diarization-r2/labels.py` 的自适应版本，
 * 只用于开发模式验收台，不进入正式管线。
 *
 * 步骤：种子（时长 >= 1.5s 且有嵌入）→ BIC 单人守卫 → 平均连接层次聚类（NCC）
 * + silhouette 选 k → 短段「前后最近种子同簇则沿用，否则取质心余弦最大者」。
 */
import type { DiarizationSegment } from "@video-notes/core";

export type EmbeddingRow = { start: number; end: number; v: number[] | null };

export type RefineResult = {
  labels: number[];
  /** 聚类后的簇数（未合并进 assignSpeakers 之前）。 */
  k: number;
  picked: "sherpa" | "sil" | "bic1" | "fallback";
  silhouette: number | null;
  bicK: number | null;
  seeds: number;
};

export type RefineOptions = { seedSeconds?: number; maxK?: number; fallbackCut?: number };

const DEFAULT_SEED_SECONDS = 1.5;
const DEFAULT_MAX_K = 12;
const DEFAULT_FALLBACK_CUT = 0.65;

function normalizeVectors(rows: number[][]): Float64Array[] {
  return rows.map((v) => {
    let norm = 0;
    for (const x of v) norm += x * x;
    const scale = 1 / (Math.sqrt(norm) + 1e-12);
    const out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i += 1) out[i] = (v[i] ?? 0) * scale;
    return out;
  });
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/** 余弦距离矩阵（Float64Array，行优先）。 */
function distanceMatrix(x: Float64Array[]): Float64Array {
  const n = x.length;
  const d = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    const xi = x[i];
    if (xi === undefined) continue;
    for (let j = i + 1; j < n; j += 1) {
      const xj = x[j];
      if (xj === undefined) continue;
      const dist = 1 - dot(xi, xj);
      d[i * n + j] = dist;
      d[j * n + i] = dist;
    }
  }
  return d;
}

type Merge = { a: number; b: number; distance: number };

/**
 * 平均连接层次聚类，最近邻链（NCC）+ Lance–Williams 更新。
 * 返回 n-1 次合并的顺序；按顺序回放即可得到任意 k 的分层。
 */
function averageLinkageMerges(x: Float64Array[], d: Float64Array): Merge[] {
  const n = x.length;
  const size = new Float64Array(n).fill(1);
  const active = new Uint8Array(n).fill(1);
  const merges: Merge[] = [];
  const nearest = (a: number): number => {
    let best = -1;
    let bestD = Infinity;
    const row = a * n;
    for (let b = 0; b < n; b += 1) {
      if (b === a || active[b] === 0) continue;
      const dist = d[row + b] ?? Infinity;
      if (dist < bestD) {
        bestD = dist;
        best = b;
      }
    }
    return best;
  };

  const chain: number[] = [];
  for (let step = 0; step < n - 1; step += 1) {
    if (chain.length === 0) {
      let first = -1;
      for (let i = 0; i < n; i += 1) if (active[i] === 1) { first = i; break; }
      if (first === -1) break;
      chain.push(first);
    }
    // 最近邻链：直到链尾两个点互为最近邻。
    for (;;) {
      const last = chain[chain.length - 1];
      if (last === undefined) throw new Error("聚类链为空");
      const next = nearest(last);
      if (next === -1) throw new Error("聚类链找不到最近邻");
      const prev = chain[chain.length - 2];
      if (prev === next) break;
      chain.push(next);
    }
    const a = chain.pop();
    const b = chain.pop();
    if (a === undefined || b === undefined) throw new Error("聚类链长度不足");
    const distance = d[a * n + b] ?? Infinity;
    merges.push({ a, b, distance });
    const wa = size[a] ?? 1;
    const wb = size[b] ?? 1;
    const total = wa + wb;
    for (let c = 0; c < n; c += 1) {
      if (active[c] === 0 || c === a || c === b) continue;
      const merged = ((wa * (d[a * n + c] ?? 0)) + (wb * (d[b * n + c] ?? 0))) / total;
      d[a * n + c] = merged;
      d[c * n + a] = merged;
    }
    size[a] = total;
    active[b] = 0;
    chain.push(a);
  }
  return merges;
}

/** 回放前 n-k 次合并得到 k 簇标签（按首次出现顺序重编号）。 */
function cutTree(merges: Merge[], n: number, k: number): number[] {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i += 1) parent[i] = i;
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    while (parent[i] !== r) {
      const next = parent[i] ?? r;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const mergesNeeded = Math.max(0, n - k);
  for (let i = 0; i < mergesNeeded; i += 1) {
    const m = merges[i];
    if (m === undefined) break;
    const ra = find(m.a);
    const rb = find(m.b);
    if (ra !== rb) parent[rb] = ra;
  }
  return renumber(Array.from(parent, (_, i) => find(i)));
}

function renumber(raw: number[]): number[] {
  const map = new Map<number, number>();
  const out: number[] = [];
  for (const label of raw) {
    let mapped = map.get(label);
    if (mapped === undefined) {
      mapped = map.size;
      map.set(label, mapped);
    }
    out.push(mapped);
  }
  return out;
}

/** 子样本轮廓系数（cosine 距离）；只统计子样本内簇大小 >= 2 的点。 */
function silhouette(labels: number[], x: Float64Array[], sampleCap: number): number {
  const n = x.length;
  const stride = Math.max(1, Math.floor(n / Math.min(sampleCap, n)));
  const idx: number[] = [];
  for (let i = 0; i < n; i += stride) idx.push(i);
  if (idx.length < 2) return 0;
  const clusterSizes = new Map<number, number>();
  for (const i of idx) {
    const label = labels[i] ?? 0;
    clusterSizes.set(label, (clusterSizes.get(label) ?? 0) + 1);
  }
  const clusters = [...clusterSizes.keys()];
  if (clusters.length < 2) return 0;
  const sums = new Map<number, number>();
  let sum = 0;
  let count = 0;
  for (const i of idx) {
    const li = labels[i] ?? 0;
    const ownSize = clusterSizes.get(li) ?? 0;
    if (ownSize < 2) continue;
    const intra: Record<string, number> = {};
    const inter: Record<string, number> = {};
    for (const j of idx) {
      if (i === j) continue;
      const lj = labels[j] ?? 0;
      const xi = x[i];
      const xj = x[j];
      if (xi === undefined || xj === undefined) continue;
      const dist = 1 - dot(xi, xj);
      if (lj === li) intra[String(li)] = (intra[String(li)] ?? 0) + dist;
      else inter[String(lj)] = (inter[String(lj)] ?? 0) + dist;
    }
    const a = (intra[String(li)] ?? 0) / (ownSize - 1);
    let b = Infinity;
    for (const lj of clusters) {
      if (lj === li) continue;
      const sizeL = clusterSizes.get(lj) ?? 0;
      if (sizeL === 0) continue;
      const mean = (inter[String(lj)] ?? 0) / sizeL;
      if (mean < b) b = mean;
    }
    if (!Number.isFinite(b)) continue;
    const denom = Math.max(a, b);
    sum += denom === 0 ? 0 : (b - a) / denom;
    count += 1;
  }
  sums.clear();
  return count === 0 ? 0 : sum / count;
}

function silhouetteK(x: Float64Array[], d: Float64Array, maxK: number): { labels: number[]; k: number; score: number } {
  const n = x.length;
  const merges = averageLinkageMerges(x, d);
  const hi = Math.min(maxK, Math.max(3, Math.floor(n / 8)));
  let best = { labels: new Array<number>(n).fill(0), k: 1, score: -1 };
  for (let k = 2; k <= hi; k += 1) {
    const labels = cutTree(merges, n, k);
    if (new Set(labels).size < 2) continue;
    const score = silhouette(labels, x, 300);
    if (score > best.score) best = { labels, k, score };
  }
  return best;
}

/** 确定性伪随机（mulberry32），保证 BIC 的初始化可复现。 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type DiagGmm = { weights: Float64Array; means: Float64Array; vars: Float64Array; logLik: number };

/** 对角协方差 GMM 的 EM（k-means++ 初始化，固定种子，30 次迭代）。 */
function fitDiagGmm(x: Float64Array[], k: number): DiagGmm {
  const n = x.length;
  const dim = x[0]?.length ?? 0;
  const rand = rng(0x9e3779b9);
  const means = new Float64Array(k * dim);
  // k-means++ 选初始中心
  const chosen = [Math.floor(rand() * n)];
  while (chosen.length < k) {
    const dists = new Float64Array(n).fill(Infinity);
    for (let i = 0; i < n; i += 1) {
      for (const c of chosen) {
        const cc = x[c];
        const xi = x[i];
        if (cc === undefined || xi === undefined) continue;
        const dist = 1 - dot(xi, cc);
        if (dist < (dists[i] ?? Infinity)) dists[i] = dist;
      }
    }
    let total = 0;
    for (let i = 0; i < n; i += 1) total += dists[i] ?? 0;
    let pick = 0;
    if (total > 0) {
      let r = rand() * total;
      for (let i = 0; i < n; i += 1) {
        r -= dists[i] ?? 0;
        if (r <= 0) { pick = i; break; }
      }
    } else {
      pick = Math.floor(rand() * n);
    }
    chosen.push(pick);
  }
  for (let c = 0; c < k; c += 1) {
    const src = x[chosen[c] ?? 0];
    if (src === undefined) continue;
    for (let d = 0; d < dim; d += 1) means[c * dim + d] = src[d] ?? 0;
  }
  const vars = new Float64Array(k * dim).fill(1e-3);
  const weights = new Float64Array(k).fill(1 / k);
  const resp = new Float64Array(n * k);
  const logNorm = new Float64Array(k);
  const logProb = new Float64Array(n * k);
  let logLik = -Infinity;
  const regCovar = 1e-3;

  for (let iter = 0; iter < 30; iter += 1) {
    for (let c = 0; c < k; c += 1) {
      let norm = 0;
      for (let d = 0; d < dim; d += 1) norm += Math.log((vars[c * dim + d] ?? regCovar) + regCovar);
      logNorm[c] = -0.5 * (dim * Math.log(2 * Math.PI) + norm);
    }
    logLik = 0;
    for (let i = 0; i < n; i += 1) {
      const xi = x[i];
      if (xi === undefined) continue;
      let maxLog = -Infinity;
      for (let c = 0; c < k; c += 1) {
        let acc = Math.log(Math.max(weights[c] ?? 1e-12, 1e-12)) + (logNorm[c] ?? 0);
        for (let d = 0; d < dim; d += 1) {
          const diff = (xi[d] ?? 0) - (means[c * dim + d] ?? 0);
          acc -= (diff * diff) / (2 * ((vars[c * dim + d] ?? regCovar) + regCovar));
        }
        logProb[i * k + c] = acc;
        if (acc > maxLog) maxLog = acc;
      }
      let sumExp = 0;
      for (let c = 0; c < k; c += 1) {
        const e = Math.exp((logProb[i * k + c] ?? -Infinity) - maxLog);
        sumExp += e;
        resp[i * k + c] = e;
      }
      logLik += maxLog + Math.log(sumExp);
      for (let c = 0; c < k; c += 1) resp[i * k + c] = (resp[i * k + c] ?? 0) / sumExp;
    }
    // M 步
    const nk = new Float64Array(k);
    for (let c = 0; c < k; c += 1) {
      for (let d = 0; d < dim; d += 1) means[c * dim + d] = 0;
    }
    for (let i = 0; i < n; i += 1) {
      for (let c = 0; c < k; c += 1) {
        const r = resp[i * k + c] ?? 0;
        nk[c] = (nk[c] ?? 0) + r;
        const xi = x[i];
        if (xi === undefined) continue;
        for (let d = 0; d < dim; d += 1) means[c * dim + d] = (means[c * dim + d] ?? 0) + r * (xi[d] ?? 0);
      }
    }
    for (let c = 0; c < k; c += 1) {
      const denom = Math.max(nk[c] ?? 0, 1e-12);
      weights[c] = denom / n;
      for (let d = 0; d < dim; d += 1) means[c * dim + d] = (means[c * dim + d] ?? 0) / denom;
    }
    for (let c = 0; c < k; c += 1) {
      for (let d = 0; d < dim; d += 1) vars[c * dim + d] = regCovar;
    }
    for (let i = 0; i < n; i += 1) {
      for (let c = 0; c < k; c += 1) {
        const r = resp[i * k + c] ?? 0;
        const xi = x[i];
        if (xi === undefined) continue;
        for (let d = 0; d < dim; d += 1) {
          const diff = (xi[d] ?? 0) - (means[c * dim + d] ?? 0);
          vars[c * dim + d] = (vars[c * dim + d] ?? 0) + r * diff * diff;
        }
      }
    }
    for (let c = 0; c < k; c += 1) {
      const denom = Math.max(nk[c] ?? 0, 1e-12);
      for (let d = 0; d < dim; d += 1) vars[c * dim + d] = (vars[c * dim + d] ?? 0) / denom + regCovar;
    }
  }
  return { weights, means, vars, logLik };
}

/** BIC 选 k：k=1..min(maxK, max(2, n/8))，最小 BIC 者胜。 */
export function bicBestK(x: Float64Array[], maxK = DEFAULT_MAX_K): { k: number; bic: number } {
  const n = x.length;
  const dim = x[0]?.length ?? 0;
  const hi = Math.min(maxK, Math.max(2, Math.floor(n / 8)));
  let best = { k: 1, bic: Infinity };
  for (let k = 1; k <= hi; k += 1) {
    if (k >= n) break;
    const gmm = fitDiagGmm(x, k);
    const params = 2 * k * dim + (k - 1);
    const bic = -2 * gmm.logLik + params * Math.log(n);
    if (bic < best.bic) best = { k, bic };
  }
  return best;
}

function centroids(x: Float64Array[], labels: number[], k: number, dim: number): Float64Array[] {
  const sums = Array.from({ length: k }, () => new Float64Array(dim));
  const counts = new Array<number>(k).fill(0);
  for (let i = 0; i < x.length; i += 1) {
    const label = labels[i] ?? 0;
    const target = sums[label];
    const xi = x[i];
    if (target === undefined || xi === undefined) continue;
    for (let d = 0; d < dim; d += 1) target[d] = (target[d] ?? 0) + (xi[d] ?? 0);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return sums.map((sum, c) => {
    const count = Math.max(counts[c] ?? 1, 1);
    let norm = 0;
    for (let d = 0; d < dim; d += 1) {
      sum[d] = (sum[d] ?? 0) / count;
      norm += (sum[d] ?? 0) ** 2;
    }
    const scale = 1 / (Math.sqrt(norm) + 1e-12);
    for (let d = 0; d < dim; d += 1) sum[d] = (sum[d] ?? 0) * scale;
    return sum;
  });
}

/**
 * 对 sherpa 分离段做二次聚类。
 * `embeddings` 与 `segments` 等长；没有嵌入的短段用 null 占位。
 */
export function refineSegments(
  segments: DiarizationSegment[],
  embeddings: EmbeddingRow[],
  opts: RefineOptions = {},
): RefineResult {
  const seedSeconds = opts.seedSeconds ?? DEFAULT_SEED_SECONDS;
  const maxK = opts.maxK ?? DEFAULT_MAX_K;
  const fallbackCut = opts.fallbackCut ?? DEFAULT_FALLBACK_CUT;
  const raw = segments.map((s) => s.speaker);
  const seedIdx: number[] = [];
  segments.forEach((s, i) => {
    if (s.end - s.start >= seedSeconds && embeddings[i]?.v != null) seedIdx.push(i);
  });
  if (seedIdx.length < 2) {
    return { labels: raw, k: new Set(raw).size, picked: "sherpa", silhouette: null, bicK: null, seeds: seedIdx.length };
  }
  const vectors = normalizeVectors(seedIdx.map((i) => embeddings[i]?.v ?? []));
  const dim = vectors[0]?.length ?? 0;
  const d = distanceMatrix(vectors);
  let seedLabels: number[];
  let k: number;
  let picked: RefineResult["picked"];
  let silhouetteScore: number | null = null;
  let bicK: number | null = null;

  if (seedIdx.length < 8) {
    // 种子太少：按固定切点切平均连接树。
    const merges = averageLinkageMerges(vectors, d);
    const parent = new Int32Array(seedIdx.length);
    for (let i = 0; i < parent.length; i += 1) parent[i] = i;
    const find = (i: number): number => {
      let r = i;
      while (parent[r] !== r) r = parent[r] ?? r;
      return r;
    };
    for (const m of merges) {
      if (m.distance > fallbackCut) break;
      const ra = find(m.a);
      const rb = find(m.b);
      if (ra !== rb) parent[rb] = ra;
    }
    seedLabels = renumber(Array.from(parent, (_, i) => find(i)));
    k = new Set(seedLabels).size;
    picked = "fallback";
  } else {
    const bic = bicBestK(vectors, maxK);
    bicK = bic.k;
    if (bic.k === 1) {
      seedLabels = new Array<number>(seedIdx.length).fill(0);
      k = 1;
      picked = "bic1";
    } else {
      const chosen = silhouetteK(vectors, d, maxK);
      seedLabels = chosen.labels;
      k = chosen.k;
      silhouetteScore = Math.round(chosen.score * 1000) / 1000;
      picked = "sil";
      if (chosen.score < 0.1) {
        seedLabels = new Array<number>(seedIdx.length).fill(0);
        k = 1;
        picked = "bic1";
      }
    }
  }

  const C = centroids(vectors, seedLabels, k, dim);
  const labels = new Array<number>(segments.length).fill(-1);
  seedIdx.forEach((segIndex, i) => {
    labels[segIndex] = seedLabels[i] ?? 0;
  });
  // 短段：前后最近种子同簇则沿用，否则质心余弦最大者。
  const seedTimes = seedIdx.map((i) => segments[i] ?? { start: 0, end: 0, speaker: 0 });
  for (let i = 0; i < segments.length; i += 1) {
    if (labels[i] !== -1) continue;
    const seg = segments[i];
    if (seg === undefined) continue;
    let prev = -1;
    let prevGap = Infinity;
    let next = -1;
    let nextGap = Infinity;
    for (let j = 0; j < seedTimes.length; j += 1) {
      const t = seedTimes[j];
      if (t === undefined) continue;
      if (t.end <= seg.start) {
        const gap = seg.start - t.end;
        if (gap < prevGap) { prevGap = gap; prev = labels[seedIdx[j] ?? 0] ?? 0; }
      }
      if (t.start >= seg.end) {
        const gap = t.start - seg.end;
        if (gap < nextGap) { nextGap = gap; next = labels[seedIdx[j] ?? 0] ?? 0; }
      }
    }
    if (prev >= 0 && prev === next) {
      labels[i] = prev;
      continue;
    }
    const v = embeddings[i]?.v;
    if (v == null) {
      labels[i] = prev >= 0 ? prev : next >= 0 ? next : 0;
      continue;
    }
    const nv = normalizeVectors([v])[0];
    if (nv === undefined) {
      labels[i] = prev >= 0 ? prev : 0;
      continue;
    }
    let best = 0;
    let bestScore = -Infinity;
    for (let c = 0; c < C.length; c += 1) {
      const centroid = C[c];
      if (centroid === undefined) continue;
      const score = dot(nv, centroid);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    labels[i] = best;
  }
  return { labels, k: new Set(labels).size, picked, silhouette: silhouetteScore, bicK, seeds: seedIdx.length };
}
