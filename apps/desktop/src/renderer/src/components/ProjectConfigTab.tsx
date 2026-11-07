import { useEffect, useRef, useState, type JSX } from "react";
import type { ProjectDetail, ProjectDirectoryFile } from "../../../shared/ipc";
import { fmtDateTime } from "../lib/format";
import {
  ORGANIZE_STATUS_LABEL,
  SortRefreshScheduler,
  clampChunkMinutes,
  directoryCountLabel,
  directoryEmptyHint,
  fileMeta,
  mergeDirectoryView,
  monitorStatusLabel,
  processedLabel,
  selectAllState,
  selectionSummary,
  sortDirectoryFiles,
  startButtonState,
} from "../lib/project-config";

export function ProjectConfigTab({
  project,
  onStartMonitor,
  onChunkMinutes,
  onSemanticChunking,
  onOrganize,
}: {
  project: ProjectDetail;
  onStartMonitor: (directory: string) => Promise<void>;
  onChunkMinutes: (minutes: number) => Promise<void>;
  /** 智能语义分块开关（#155）：停止增长后整段分析，不再按分块时长截断主题。 */
  onSemanticChunking: (enabled: boolean) => Promise<void>;
  onOrganize: (videoIds: string[]) => Promise<void>;
}): JSX.Element {
  const [directory, setDirectory] = useState(project.watchDir ?? "");
  const [chunkMinutes, setChunkMinutes] = useState(String(project.chunkMinutes));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [startingMonitor, setStartingMonitor] = useState(false);
  const [savingChunk, setSavingChunk] = useState(false);
  const [savingSemantic, setSavingSemantic] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  // 修改时间显示与排序 500ms 防抖、最长 2 秒（原型 scheduleSort / #132）
  const [sortSnapshot, setSortSnapshot] = useState<ProjectDirectoryFile[]>(() =>
    sortDirectoryFiles(project.directory, []),
  );
  const previousOrder = useRef<string[]>(sortSnapshot.map((file) => file.videoId));
  const schedulerRef = useRef<SortRefreshScheduler<ProjectDirectoryFile[]> | null>(null);
  if (schedulerRef.current === null) {
    schedulerRef.current = new SortRefreshScheduler((latest) => {
      const sorted = sortDirectoryFiles(latest, previousOrder.current);
      previousOrder.current = sorted.map((file) => file.videoId);
      setSortSnapshot(sorted);
    });
  }

  const files = mergeDirectoryView(project.directory, sortSnapshot);
  const selectAll = selectAllState(files, selected);
  const organizeButton = startButtonState(files, selected);

  useEffect(() => {
    schedulerRef.current?.push(project.directory);
  }, [project.directory]);

  useEffect(() => () => schedulerRef.current?.cancel(), []);

  const startMonitor = () => {
    const nextDirectory = directory.trim();
    if (project.monitoring || startingMonitor || nextDirectory === "") return;
    setStartingMonitor(true);
    void onStartMonitor(nextDirectory).finally(() => setStartingMonitor(false));
  };

  const commitChunkMinutes = () => {
    const next = clampChunkMinutes(chunkMinutes);
    setChunkMinutes(String(next));
    if (savingChunk || next === project.chunkMinutes) return;
    setSavingChunk(true);
    void onChunkMinutes(next).finally(() => setSavingChunk(false));
  };

  const commitSemanticChunking = (next: boolean) => {
    if (savingSemantic || next === project.semanticChunking) return;
    setSavingSemantic(true);
    void onSemanticChunking(next).finally(() => setSavingSemantic(false));
  };

  const startOrganize = () => {
    if (organizing || organizeButton.disabled) return;
    const videoIds = files
      .filter((file) => selected.has(file.videoId) && !file.added)
      .map((file) => file.videoId);
    setOrganizing(true);
    void onOrganize(videoIds).finally(() => setOrganizing(false));
  };

  return (
    <div className="vn-config">
      <section className="vn-card vn-pad vn-config-card">
        <div className="vn-config-head">
          <h2>监控录制目录</h2>
          <span
            className={project.monitoring ? "vn-tag ok" : "vn-tag"}
            data-testid="project-monitor-status"
          >
            {monitorStatusLabel(project.monitoring)}
          </span>
        </div>

        <form
          className="vn-config-directory-form"
          onSubmit={(event) => {
            event.preventDefault();
            startMonitor();
          }}
        >
          <label className="vn-config-label" htmlFor="project-monitor-directory">
            录屏软件输出目录
          </label>
          <div className="vn-config-directory-line">
            <input
              id="project-monitor-directory"
              className="vn-input"
              data-testid="project-monitor-directory"
              aria-label="录屏软件输出目录"
              value={directory}
              disabled={project.monitoring}
              onChange={(event) => setDirectory(event.target.value)}
            />
            <button
              type="submit"
              className="vn-btn primary"
              data-testid="project-monitor-start"
              disabled={project.monitoring || startingMonitor || directory.trim() === ""}
            >
              开始监控
            </button>
          </div>
        </form>
        <p className="vn-hint vn-config-hint">
          目录里的视频按修改时间倒序列在下方；新文件默认不勾选。
        </p>

        <div className="vn-config-chunk">
          <label htmlFor="project-chunk-minutes">分块时长</label>
          <input
            id="project-chunk-minutes"
            className="vn-input vn-config-chunk-input"
            data-testid="project-chunk-minutes"
            aria-label="分块时长（分钟）"
            type="number"
            min={1}
            max={30}
            step={1}
            value={chunkMinutes}
            onChange={(event) => setChunkMinutes(event.target.value)}
            onBlur={commitChunkMinutes}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              commitChunkMinutes();
            }}
          />
          <span>分钟</span>
        </div>
        <label className="vn-switch vn-config-semantic">
          <input
            type="checkbox"
            role="switch"
            data-testid="project-semantic-chunking"
            checked={project.semanticChunking}
            disabled={savingSemantic}
            onChange={(event) => commitSemanticChunking(event.target.checked)}
          />
          智能语义分块
        </label>
        <p className="vn-hint vn-config-hint">
          {project.semanticChunking
            ? "停止增长的视频整段做字幕与主题分析，话题不再被分块时长截断；还在增长时仍按分块时长推进。"
            : "按分块时长切块，每块单独划主题；关闭后分块时长只影响后续分析区间。"}
          自动切片开关位于上方项目设置，待确认主题不阻塞分析。
        </p>
      </section>

      <section className="vn-card vn-pad vn-config-card">
        <div className="vn-config-head">
          <h2>目录视频</h2>
          <span className="vn-tag" data-testid="project-file-count">
            {directoryCountLabel(files.length)}
          </span>
        </div>

        <div className="vn-config-table-wrap">
          <table className="vn-table vn-config-table">
            <thead>
              <tr>
                <th>
                  <input
                    ref={(element) => {
                      if (element !== null) element.indeterminate = selectAll.indeterminate;
                    }}
                    className="vn-config-check"
                    data-testid="project-select-all"
                    type="checkbox"
                    aria-label="全选视频"
                    checked={selectAll.checked}
                    disabled={selectAll.disabled}
                    onChange={(event) => {
                      setSelected(
                        event.target.checked
                          ? new Set(files.map((file) => file.videoId))
                          : new Set(),
                      );
                    }}
                  />
                </th>
                <th>文件名</th>
                <th>修改时间 ↓</th>
                <th>大小 / 时长</th>
                <th>整理状态</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => {
                const meta = fileMeta(file);
                return (
                  <tr key={file.videoId}>
                    <td>
                      <input
                        className="vn-config-check"
                        data-testid="project-file-checkbox"
                        type="checkbox"
                        aria-label={`选择 ${file.name}`}
                        checked={selected.has(file.videoId)}
                        onChange={(event) => {
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(file.videoId);
                            else next.delete(file.videoId);
                            return next;
                          });
                        }}
                      />
                    </td>
                    <td>
                      <div className="vn-config-file-name" data-testid="project-file-name">
                        {file.name}
                      </div>
                    </td>
                    <td className="vn-config-time">
                      <time dateTime={file.modifiedAt}>{fmtDateTime(file.modifiedAt)}</time>
                    </td>
                    <td className="vn-config-file-meta">
                      <span>{meta.size}</span>
                      <small>{meta.duration}</small>
                    </td>
                    <td>
                      <span
                        className="vn-tag vn-config-status"
                        data-status={file.organizeStatus}
                        data-testid="project-file-status"
                      >
                        {ORGANIZE_STATUS_LABEL[file.organizeStatus]}
                      </span>
                      <small className="vn-config-processed">
                        {processedLabel(file.processedSeconds)}
                      </small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {files.length === 0 ? <div className="vn-config-empty">{directoryEmptyHint()}</div> : null}

        <div className="vn-config-footer">
          <span className="vn-config-selection" data-testid="project-selection-info">
            {selectionSummary(files, selected)}
          </span>
          <button
            type="button"
            className="vn-btn primary"
            data-testid="project-organize-start"
            disabled={organizing || organizeButton.disabled}
            onClick={startOrganize}
          >
            {organizeButton.label}
          </button>
        </div>
      </section>

      <p className="vn-hint vn-config-footnote">
        修改时间降序；勾选只用于加入整理，取消勾选不会撤掉已加入的任务。
      </p>
    </div>
  );
}
