"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LabConfig, LabConfigName, LabImportResult, LabLine, LabPayload, LabProgress, LabSampleMeta } from "../../../shared/lab";
import { LAB_CONFIG_LABEL, LAB_CONFIGS } from "../../../shared/lab";
import {
  buildRows,
  filterRows,
  formatTime,
  labLineKey,
  parseJump,
  rowIndexAt,
  searchRows,
  summarize,
  type LabFilter,
  type LabRow,
} from "../../../shared/lab-view";
import { Select } from "@/rbp/blocks/settings-form-3";
import { LAB_THRESHOLD_MAX, LAB_THRESHOLD_MIN, readLabViewState, writeLabViewState } from "@/lib/lab-view-state";
import { errMessage } from "@/lib/format";
import { showToast } from "@/lib/toast";
import { LabTimeline } from "@/components/lab/LabTimeline";

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return formatTime(ms / 1000);
}

const PROGRESS_LABEL: Record<LabProgress["step"], string> = {
  extract: "抽音频",
  diarize: "说话人分离",
  embed: "逐段嵌入",
  decode: "段级解码",
  save: "落盘",
  load: "读取",
};

const SPEAKER_COLORS = [
  "#4f8ef7", "#e8764c", "#5faa55", "#c06bb0", "#d4a63a", "#5bc0c8",
  "#a78bfa", "#f472b6", "#a3e635", "#22d3ee", "#fbbf24", "#9aa3b8",
];

function colorFor(speakerId: string): string {
  let hash = 0;
  for (let i = 0; i < speakerId.length; i += 1) hash = (hash * 31 + speakerId.charCodeAt(i)) >>> 0;
  return SPEAKER_COLORS[hash % SPEAKER_COLORS.length] ?? SPEAKER_COLORS[0]!;
}

function lineAt(config: LabConfig, start: number): LabLine | undefined {
  return config.lines.find((l) => Math.abs(l.start - start) < 0.01);
}

/** 某说话人第 index 个样例段（用于 `1`/`2` 与 ▶样例）。 */
function speakerSample(config: LabConfig, speakerId: string, index = 0): { start: number; end: number } | null {
  const speaker = config.speakers.find((s) => s.id === speakerId);
  const start = speaker?.sampleStarts[index];
  if (start === undefined) return null;
  const line = lineAt(config, start);
  return line === undefined ? null : { start: line.start, end: line.end };
}

export function DiarizationLabPage({ sourcePath }: { sourcePath?: string }) {
  const lab = window.vnote.lab;
  // r52：样本、A/B 方案、阈值、两处滚动位置跨导航与重启保留（localStorage，见 lib/lab-view-state）。
  const [storedView] = useState(() => readLabViewState(window.localStorage));
  const [samples, setSamples] = useState<LabSampleMeta[]>([]);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [payload, setPayload] = useState<LabPayload | null>(null);
  const [configA, setConfigA] = useState<LabConfigName>(storedView.configA);
  const [configB, setConfigB] = useState<LabConfigName>(storedView.configB);
  const [threshold, setThreshold] = useState(storedView.threshold);
  // 首屏加载完成前不写回，否则会把「还没选样本」的 null 覆盖到已保存的样本上。
  const [hydrated, setHydrated] = useState(false);
  const [filter, setFilter] = useState<LabFilter>("all");
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [jump, setJump] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [marks, setMarks] = useState<Record<string, "A" | "B" | "both">>({});
  const [progress, setProgress] = useState<LabProgress | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [outcome, setOutcome] = useState<LabImportResult | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const stopAtRef = useRef<number | null>(null);
  const queueRef = useRef<{ start: number; end: number }[]>([]);
  const markTimer = useRef<number | undefined>(undefined);
  const autoImportRef = useRef<string | null>(null);
  const scrollRef = useRef({ contentScrollTop: storedView.contentScrollTop, rowsScrollTop: storedView.rowsScrollTop });
  const restoreDoneRef = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const viewRef = useRef({ sampleId, configA, configB, threshold });

  // 写回整份视图状态：最新选择 + 最新滚动位置（滚动位置只在内存 ref 里攒，写盘节流）。
  const saveView = useCallback(() => {
    writeLabViewState(window.localStorage, { ...viewRef.current, ...scrollRef.current });
  }, []);

  const reloadSamples = useCallback(async (): Promise<LabSampleMeta[]> => {
    if (lab === undefined) return [];
    const list = await lab.list();
    setSamples(list);
    return list;
  }, [lab]);

  const loadSample = useCallback(
    async (id: string) => {
      if (lab === undefined) return;
      const loaded = await lab.load(id);
      setSampleId(id);
      setPayload(loaded);
      setSelectedKey(null);
      setCurrentTime(0);
      setMarks(await lab.marks(id));
    },
    [lab],
  );

  // 首次打开：列样本；带 sourcePath 时先导入那个视频。
  useEffect(() => {
    void (async () => {
      if (lab === undefined) return;
      try {
        const list = await reloadSamples();
        // 恢复上次的样本；样本已被删掉就退回最近一个。
        const stored = list.find((s) => s.id === storedView.sampleId);
        const target = sourcePath ?? stored?.id ?? list[0]?.id;
        if (sourcePath !== undefined && autoImportRef.current !== sourcePath) {
          autoImportRef.current = sourcePath;
          const first = list[0];
          if (first !== undefined) await loadSample(first.id);
          setImporting(true);
          try {
            const result = await lab.importPath(sourcePath);
            setProgress(null);
            await reloadSamples();
            await loadSample(result.sampleId);
            setOutcome(result);
          } finally {
            setImporting(false);
          }
          return;
        }
        if (target !== undefined) await loadSample(target);
      } catch (err) {
        showToast(`加载 Lab 样本失败：${errMessage(err)}`);
      } finally {
        setHydrated(true);
      }
    })();
  }, [lab, sourcePath, reloadSamples, loadSample, storedView.sampleId]);

  // 视图状态 ref 与 state 同步：saveView 是稳定回调，靠 ref 读最新选择。
  useEffect(() => {
    viewRef.current = { sampleId, configA, configB, threshold };
  }, [sampleId, configA, configB, threshold]);

  // 选择或阈值变化立即写回；滚动位置在下面单独节流。
  useEffect(() => {
    if (hydrated) saveView();
  }, [hydrated, sampleId, configA, configB, threshold, saveView]);

  // 两处滚动：页面（.vn-content）与字幕行列表。恢复完成前的滚动事件一律丢弃，避免把 0 写回。
  useEffect(() => {
    if (payload === null) return;
    const content = rootRef.current?.closest<HTMLElement>(".vn-content") ?? null;
    const rows = listRef.current;
    const onScroll = () => {
      if (!restoreDoneRef.current) return;
      scrollRef.current = { contentScrollTop: content?.scrollTop ?? 0, rowsScrollTop: rows?.scrollTop ?? 0 };
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(saveView, 200);
    };
    content?.addEventListener("scroll", onScroll, { passive: true });
    rows?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      content?.removeEventListener("scroll", onScroll);
      rows?.removeEventListener("scroll", onScroll);
    };
  }, [payload, saveView]);

  // 样本加载完（行列表已渲染）再恢复滚动，否则内容还没撑开，scrollTop 会被夹到 0。
  useEffect(() => {
    if (payload === null || restoreDoneRef.current) return;
    const content = rootRef.current?.closest<HTMLElement>(".vn-content") ?? null;
    const apply = () => {
      if (content !== null) content.scrollTop = storedView.contentScrollTop;
      if (listRef.current !== null) listRef.current.scrollTop = storedView.rowsScrollTop;
    };
    apply();
    // 卡片高度要等一次布局稳定，第二帧再对一次。
    requestAnimationFrame(apply);
    restoreDoneRef.current = true;
  }, [payload, storedView.contentScrollTop, storedView.rowsScrollTop]);

  // 卸载（导航离开）时立刻落盘，不等滚动节流。
  useEffect(() => () => {
    window.clearTimeout(saveTimer.current);
    if (hydrated) saveView();
  }, [hydrated, saveView]);

  // 导入进度
  useEffect(() => {
    if (lab === undefined) return;
    return lab.onProgress((p) => {
      setProgress(p);
      if (p.step === "save") setProgress(null);
    });
  }, [lab]);

  const saveMarksSoon = useCallback(
    (next: Record<string, "A" | "B" | "both">) => {
      setMarks(next);
      if (lab === undefined || sampleId === null) return;
      clearTimeout(markTimer.current);
      markTimer.current = window.setTimeout(() => {
        void lab.saveMarks(sampleId, next).catch((err: unknown) => showToast(`保存标记失败：${errMessage(err)}`));
      }, 300);
    },
    [lab, sampleId],
  );

  const configAValue = payload?.configs[configA] ?? null;
  const configBValue = payload?.configs[configB] ?? null;

  const rows = useMemo(
    () => (configAValue === null || configBValue === null ? [] : buildRows(configAValue, configBValue, threshold, marks)),
    [configAValue, configBValue, threshold, marks],
  );
  const visible = useMemo(
    () => searchRows(filterRows(rows, filter, speakerFilter), search),
    [rows, filter, speakerFilter, search],
  );
  const summary = useMemo(
    () => (configAValue === null || configBValue === null ? null : summarize(configAValue, configBValue, threshold)),
    [configAValue, configBValue, threshold],
  );

  const selectedRow = useMemo(
    () => (selectedKey === null ? null : rows.find((r) => labLineKey(r.line) === selectedKey) ?? null),
    [rows, selectedKey],
  );

  const audioUrl = payload?.audioUrl ?? null;
  const duration = payload?.sample.duration ?? 0;

  // 自定义 scheme 上 Chromium 不支持 #t= 时间片段（实测 error 4），改成 seek + timeupdate 自动停。
  const playSegment = useCallback(
    (start: number, end: number, keepQueue = false) => {
      const audio = audioRef.current;
      if (audio === null || audioUrl === null) return;
      if (!keepQueue) queueRef.current = [];
      stopAtRef.current = end;
      const begin = () => {
        audio.currentTime = start;
        setCurrentTime(start);
        void audio.play().catch(() => undefined);
        setPlaying(true);
      };
      if (audio.getAttribute("src") !== audioUrl) audio.src = audioUrl;
      if (audio.readyState >= 1) begin();
      else {
        audio.addEventListener("loadedmetadata", begin, { once: true });
        audio.load();
      }
    },
    [audioUrl],
  );

  const playQueue = useCallback(
    (ranges: { start: number; end: number }[]) => {
      const first = ranges[0];
      if (first === undefined) return;
      queueRef.current = ranges.slice(1);
      playSegment(first.start, first.end, true);
    },
    [playSegment],
  );

  const selectRow = useCallback(
    (row: LabRow, autoplay: boolean) => {
      setSelectedKey(labLineKey(row.line));
      if (autoplay) playSegment(row.line.start, row.line.end);
    },
    [playSegment],
  );

  // 播放到段尾自动停；队列里还有样例就接着播。
  const onTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    setCurrentTime(audio.currentTime);
    const stopAt = stopAtRef.current;
    if (stopAt === null || audio.currentTime < stopAt - 0.02) return;
    audio.pause();
    stopAtRef.current = null;
    const next = queueRef.current.shift();
    if (next === undefined) {
      setPlaying(false);
      return;
    }
    playSegment(next.start, next.end, true);
  }, [playSegment]);

  const jumpTo = useCallback(
    (index: number | null) => {
      if (index === null) return;
      const row = visible[index] ?? rows[index];
      if (row === undefined) return;
      selectRow(row, true);
    },
    [visible, rows, selectRow],
  );

  const moveDiff = useCallback(
    (direction: 1 | -1) => {
      if (rows.length === 0) return;
      const keys = rows.map((r) => labLineKey(r.line));
      const current = selectedKey === null ? -1 : keys.indexOf(selectedKey);
      const start = current === -1 ? (direction === 1 ? -1 : rows.length) : current;
      for (let i = start + direction; i >= 0 && i < rows.length; i += direction) {
        const row = rows[i];
        if (row !== undefined && row.diff) {
          selectRow(row, true);
          return;
        }
      }
    },
    [rows, selectedKey, selectRow],
  );

  // 键盘：J/K 差异、空格、1/2 试听；输入框聚焦时让路。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const editing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (editing) return;
      if (event.key === "j" || event.key === "J") {
        event.preventDefault();
        moveDiff(1);
      } else if (event.key === "k" || event.key === "K") {
        event.preventDefault();
        moveDiff(-1);
      } else if (event.key === " ") {
        event.preventDefault();
        const audio = audioRef.current;
        if (audio === null) return;
        if (audio.paused) void audio.play().catch(() => undefined);
        else audio.pause();
      } else if (event.key === "1" || event.key === "2") {
        const row = selectedRow;
        if (row === null || configAValue === null || configBValue === null) return;
        event.preventDefault();
        const config = event.key === "1" ? configAValue : configBValue;
        const speakerId = event.key === "1" ? row.aSpeakerId : row.line.speakerId;
        if (speakerId === null) return;
        const sample = speakerSample(config, speakerId, 0);
        if (sample !== null) playSegment(sample.start, sample.end);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moveDiff, playSegment, selectedRow, configAValue, configBValue]);

  // 选中行滚进可见区
  useEffect(() => {
    if (selectedKey === null) return;
    const node = listRef.current?.querySelector(`[data-line-key="${selectedKey}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  const importFile = useCallback(
    async (path: string) => {
      if (lab === undefined) return;
      setImporting(true);
      try {
        const result = await lab.importPath(path);
        setProgress(null);
        await reloadSamples();
        await loadSample(result.sampleId);
        setOutcome(result);
      } catch (err) {
        showToast(`导入失败：${errMessage(err)}`);
      } finally {
        setImporting(false);
      }
    },
    [lab, reloadSamples, loadSample],
  );

  const forceRegenerate = useCallback(async () => {
    if (lab === undefined || payload === null || importing) return;
    setImporting(true);
    try {
      const result = await lab.importPath(payload.sample.sourcePath, { force: true });
      setProgress(null);
      await reloadSamples();
      await loadSample(result.sampleId);
      setOutcome(result);
    } catch (err) {
      showToast(`强制重新生成失败：${errMessage(err)}`);
    } finally {
      setImporting(false);
    }
  }, [lab, payload, importing, reloadSamples, loadSample]);

  if (lab === undefined) {
    return (
      <div className="vn-wrap" data-testid="lab-page">
        <p className="vn-sub">Diarization Lab 只在开发模式可用。</p>
      </div>
    );
  }

  const sampleOptions = samples.map((s) => ({ value: s.id, label: `${s.name}（${formatTime(s.duration)}）` }));
  const configOptions = LAB_CONFIGS.map((name) => ({ value: name, label: LAB_CONFIG_LABEL[name] }));
  const speakerOptions = [
    { value: "", label: "全部说话人" },
    ...(configBValue?.speakers ?? []).map((s) => ({ value: s.id, label: `${s.id} · ${formatTime(s.seconds)}` })),
  ];

  return (
    <div
      ref={rootRef}
      className="vn-wrap vn-lab"
      data-testid="lab-page"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file === undefined) return;
        void importFile(window.vnote.pathForFile(file));
      }}
    >
      <section className={`vn-card vn-pad vn-lab-bar${dragging ? " dragging" : ""}`} data-testid="lab-drop">
        <div className="vn-lab-bar-row">
          <div className="vn-lab-drop-hint" data-testid="lab-dropzone">
            <b>拖入样本</b>
            <span>音视频文件，或含 segtext-*.json 的实验目录；样本落 ~/.cache/video-notes/lab-cache/</span>
          </div>
          <label className="vn-lab-control vn-lab-select-control">
            <span>最近样本</span>
            <Select
              value={sampleId ?? ""}
              options={sampleOptions.length === 0 ? [{ value: "", label: "还没有样本" }] : sampleOptions}
              onChange={(id) => void loadSample(id)}
              testId="lab-sample-select"
            />
          </label>
          <label className="vn-lab-control vn-lab-select-control">
            <span>方案 A</span>
            <Select value={configA} options={configOptions} onChange={(v) => setConfigA(v as LabConfigName)} testId="lab-config-a" />
          </label>
          <label className="vn-lab-control vn-lab-select-control">
            <span>方案 B</span>
            <Select value={configB} options={configOptions} onChange={(v) => setConfigB(v as LabConfigName)} testId="lab-config-b" />
          </label>
          <label className="vn-lab-control vn-lab-threshold">
            <span className="vn-lab-threshold-head">
              <span>语气词阈值</span>
              <span className="vn-lab-threshold-value">{threshold.toFixed(1)}s</span>
            </span>
            <span className="vn-lab-threshold-track">
              <input
                type="range"
                min={LAB_THRESHOLD_MIN}
                max={LAB_THRESHOLD_MAX}
                step={0.1}
                value={threshold}
                data-testid="lab-threshold"
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </span>
          </label>
          <div className="vn-lab-actions">
            {outcome === null ? null : (
              <p
                className={`vn-lab-cache-status${outcome.hit ? " hit" : ""}`}
                data-testid="lab-cache-status"
                title={outcome.hit ? undefined : outcome.reason}
              >
                {outcome.hit ? (
                  <>
                    {`命中缓存 · ${formatElapsed(outcome.elapsedMs)} · `}
                    <span className="vn-lab-cache-note">未加载模型、未解码音频</span>
                  </>
                ) : outcome.reason === "forced"
                  ? `强制重新生成 · ${formatElapsed(outcome.elapsedMs)}`
                  : outcome.reason === "cold"
                    ? `cold 模式重算 · ${formatElapsed(outcome.elapsedMs)}`
                    : `重新分析 · ${formatElapsed(outcome.elapsedMs)}`}
              </p>
            )}
            <button
              className="vn-btn sm vn-lab-force"
              data-testid="lab-force"
              disabled={payload === null || importing}
              onClick={() => void forceRegenerate()}
            >
              强制重新生成
            </button>
          </div>
        </div>
        <p className="vn-lab-summary" data-testid="lab-summary">
          {summary === null
            ? "导入一个样本开始对比"
            : `A ${summary.speakersA} 人 / B ${summary.speakersB} 人｜主播簇 ${summary.hostA ?? "—"}→${summary.hostB ?? "—"}｜过滤 ${summary.filteredLines} 行 ${summary.filteredSeconds}s｜两方案不同 ${summary.diffLines} 行`}
        </p>
        {progress !== null ? (
          <p className="vn-lab-progress" data-testid="lab-progress">
            {PROGRESS_LABEL[progress.step]} {progress.done}/{progress.total}
            {progress.detail === null ? "" : ` · ${progress.detail}`}
          </p>
        ) : null}
      </section>

      {payload === null ? (
        <section className="vn-card vn-pad" data-testid="lab-empty">
          <b>还没有可对比的样本</b>
          <p className="vn-hint">
            把任意音视频文件或已有实验目录拖进本页；导入会跑真实分离（30 分钟音频约 5 分钟），结果缓存在
            <code>~/.cache/video-notes/lab-cache/&lt;指纹&gt;/</code>，所有分支/工作目录共用。
          </p>
        </section>
      ) : (
        <>
          {configAValue === null || configBValue === null ? null : (
            <LabTimeline
              configA={configAValue}
              configB={configBValue}
              rows={rows}
              duration={duration}
              currentTime={currentTime}
              selectedKey={selectedKey}
              threshold={threshold}
              colorFor={colorFor}
              onPlay={(line) => {
                playSegment(line.start, line.end);
                setSelectedKey(labLineKey(line));
              }}
              onPickTime={(seconds) => {
                const index = rowIndexAt(rows, seconds);
                if (index !== null) {
                  const row = rows[index];
                  if (row !== undefined) setSelectedKey(labLineKey(row.line));
                }
                const audio = audioRef.current;
                if (audio !== null) {
                  stopAtRef.current = null;
                  audio.currentTime = seconds;
                }
                setCurrentTime(seconds);
              }}
            />
          )}

          <div className="vn-lab-split">
            <section className="vn-lab-list">
              <div className="vn-row vn-lab-tools">
                <input
                  className="vn-input"
                  placeholder="跳转：13:14 或行号"
                  data-testid="lab-jump"
                  value={jump}
                  onChange={(e) => setJump(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    jumpTo(parseJump(jump, visible));
                  }}
                />
                <input
                  ref={searchRef}
                  className="vn-input"
                  placeholder="搜索文本（⌘F）"
                  data-testid="lab-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="vn-lab-filters">
                  <button className={`vn-btn sm${filter === "all" ? " primary" : ""}`} data-testid="lab-filter-all" onClick={() => setFilter("all")}>全部</button>
                  <button className={`vn-btn sm${filter === "diff" ? " primary" : ""}`} data-testid="lab-filter-diff" onClick={() => setFilter("diff")}>仅差异</button>
                  <button className={`vn-btn sm${filter === "filtered" ? " primary" : ""}`} data-testid="lab-filter-filtered" onClick={() => setFilter("filtered")}>仅已过滤</button>
                  <Select
                    value={speakerFilter ?? ""}
                    options={speakerOptions}
                    onChange={(v) => {
                      setSpeakerFilter(v === "" ? null : v);
                      setFilter(v === "" ? "all" : "speaker");
                    }}
                    testId="lab-filter-speaker"
                  />
                </div>
              </div>

              <div className="vn-lab-rows" data-testid="lab-rows" ref={listRef}>
                {visible.length === 0 ? (
                  <p className="vn-hint">没有符合当前筛选的字幕行。</p>
                ) : (
                  visible.map((row, i) => {
                    const key = labLineKey(row.line);
                    const status = row.filler ? "已过滤" : row.diff ? "差异" : "一致";
                    return (
                      <div
                        key={key}
                        className={`vn-lab-row${key === selectedKey ? " on" : ""}${row.filler ? " filtered" : ""}`}
                        data-testid={`lab-line-${i}`}
                        data-line-key={key}
                        role="button"
                        tabIndex={0}
                        onClick={() => selectRow(row, true)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") selectRow(row, true);
                        }}
                      >
                        <span className="vn-lab-time">{formatTime(row.line.start)}</span>
                        <span className="vn-lab-sp" style={{ color: row.aSpeakerId === null ? "var(--vn-dim)" : colorFor(row.aSpeakerId) }}>
                          {row.aSpeakerId ?? "—"}
                        </span>
                        <span className="vn-lab-sp" style={{ color: colorFor(row.line.speakerId) }}>{row.line.speakerId}</span>
                        <span className="vn-lab-text">{row.line.text === "" ? "（无文本）" : row.line.text}</span>
                        <span className={`vn-tag ${row.filler ? "warn" : row.diff ? "err" : ""}`}>{status}</span>
                        <button
                          className="vn-btn sm"
                          data-testid={`lab-play-${i}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            playSegment(row.line.start, row.line.end);
                            setSelectedKey(key);
                          }}
                        >
                          ▶
                        </button>
                        {row.diff ? (
                          <span className="vn-lab-marks">
                            <button
                              className={`vn-btn sm${row.mark === "B" ? " primary" : ""}`}
                              data-testid="lab-mark-B"
                              onClick={(e) => { e.stopPropagation(); saveMarksSoon({ ...marks, [key]: "B" }); }}
                            >
                              B 对
                            </button>
                            <button
                              className={`vn-btn sm${row.mark === "A" ? " primary" : ""}`}
                              data-testid="lab-mark-A"
                              onClick={(e) => { e.stopPropagation(); saveMarksSoon({ ...marks, [key]: "A" }); }}
                            >
                              A 对
                            </button>
                            <button
                              className={`vn-btn sm${row.mark === "both" ? " primary" : ""}`}
                              data-testid="lab-mark-both"
                              onClick={(e) => { e.stopPropagation(); saveMarksSoon({ ...marks, [key]: "both" }); }}
                            >
                              都错
                            </button>
                          </span>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            <aside className="vn-card vn-pad vn-lab-speakers" data-testid="lab-speaker-panel">
              <b>说话人（方案 B）</b>
              {(configBValue?.speakers ?? []).map((s) => (
                <div key={s.id} className="vn-lab-speaker" data-testid={`lab-speaker-${s.id}`}>
                  <span className="vn-lab-dot" style={{ background: colorFor(s.id) }} />
                  <span className="vn-lab-sp-name">{s.id}</span>
                  <span className="vn-lab-sp-meta">{formatTime(s.seconds)} · {s.lines} 行</span>
                  <button
                    className="vn-btn sm"
                    data-testid={`lab-speaker-${s.id}-sample`}
                    onClick={() => {
                      if (configBValue === null) return;
                      playQueue(s.sampleStarts
                        .map((start) => lineAt(configBValue, start))
                        .filter((line): line is LabLine => line !== undefined)
                        .map((line) => ({ start: line.start, end: line.end })));
                    }}
                  >
                    ▶样例
                  </button>
                </div>
              ))}
              <p className="vn-hint">J/K 跳差异 · 空格播放 · 1/2 听 A/B 同段</p>
            </aside>
          </div>
        </>
      )}

      <audio
        ref={audioRef}
        data-testid="lab-audio"
        src={audioUrl ?? undefined}
        onTimeUpdate={onTimeUpdate}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        style={{ display: "none" }}
      />
      {playing ? <span className="vn-sr-only">播放中 {formatTime(currentTime)}</span> : null}
    </div>
  );
}
