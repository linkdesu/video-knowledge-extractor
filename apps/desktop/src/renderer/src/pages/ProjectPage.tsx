import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ProjectDetail } from "../../../shared/ipc";
import {
  PROJECT_TAB_LABEL,
  projectLogSummary,
  tabIndexAfterKey,
  type ProjectTab,
} from "../lib/project-frame";

const PROJECT_TABS: ReadonlyArray<{ key: ProjectTab; label: string }> = [
  { key: "config", label: PROJECT_TAB_LABEL.config },
  { key: "queue", label: PROJECT_TAB_LABEL.queue },
  { key: "output", label: PROJECT_TAB_LABEL.output },
];

function eventTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function countBy(tasks: ProjectDetail["queue"] extends infer Q ? Q : never): string {
  return "";
}

/**
 * 项目页外框（#127，原型 L125-L135 / L42-L46 / L155）：
 * 返回、项目名与两个目录、项目级自动切片开关、tabs 上方可折叠公共日志、三个 tab。
 * tab 面板内容由 #128-#130 通过 `panels` 注入；外框只负责面包屑、开关与公共日志。
 */
export function ProjectPage({
  project,
  tab,
  panels,
  onTab,
  onBack,
  onToggleAutoSlice,
}: {
  project: ProjectDetail;
  tab: ProjectTab;
  panels?: Partial<Record<ProjectTab, ReactNode>>;
  onTab: (tab: ProjectTab) => void;
  onBack: () => void;
  onToggleAutoSlice: (next: boolean) => Promise<void>;
}) {
  const [toggling, setToggling] = useState(false);
  const tabRefs = useRef<Partial<Record<ProjectTab, HTMLButtonElement | null>>>({});

  const toggleAutoSlice = (next: boolean) => {
    if (toggling) return;
    setToggling(true);
    void onToggleAutoSlice(next).finally(() => setToggling(false));
  };

  const onTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = PROJECT_TABS.findIndex((item) => item.key === tab);
    const next = tabIndexAfterKey(index, event.key, PROJECT_TABS.length);
    if (next === null) return;
    event.preventDefault();
    const nextTab = PROJECT_TABS[next]?.key;
    if (nextTab === undefined) return;
    onTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  const queue = project.queue;
  const analysisWaiting = queue?.analysis.filter((task) => task.status === "waiting").length ?? 0;
  const analysisDone = queue?.analysis.filter((task) => task.status === "done").length ?? 0;
  const sliceWaiting = queue?.slices.filter((task) => task.status === "waiting").length ?? 0;
  const sliceDone = queue?.slices.filter((task) => task.status === "done").length ?? 0;
  const stateCells: Array<[string, string]> = [
    ["监控目录", project.watchDir ?? "未连接"],
    [
      "项目设置",
      `${project.chunkMinutes} 分钟 / 自动切片${project.autoSlice ? "开启" : "关闭"}`,
    ],
    ["分析队列", `${analysisWaiting} 等待 / ${analysisDone} 完成`],
    ["切片队列", `${sliceWaiting} 等待 / ${sliceDone} 完成`],
    ["待确认主题", `${queue?.proposed.length ?? 0} 个（不占用队列）`],
    ["切片", `${project.clipCount} 条`],
  ];

  return (
    <>
      <div className="vn-row vn-between vn-project-actions">
        <button
          type="button"
          className="vn-btn sm"
          data-testid="project-back"
          onClick={onBack}
        >
          返回项目管理
        </button>
      </div>

      <div className="vn-project-head">
        <h1 className="vn-h1" data-testid="project-title">
          {project.name}
        </h1>
        <p className="vn-sub">每个项目独立保存配置、视频、队列和切片。</p>
      </div>

      <div className="vn-project-info" data-testid="project-info">
        <p>
          <strong>项目目录</strong> <span className="vn-project-path">{project.rootDir}</span>
        </p>
        <p>
          <strong>切片目录</strong> <span className="vn-project-path">{project.clipsDir}</span>
        </p>
      </div>

      <div className="vn-project-auto">
        <label className="vn-switch">
          <input
            type="checkbox"
            role="switch"
            data-testid="project-auto-slice"
            checked={project.autoSlice}
            disabled={toggling}
            onChange={(event) => toggleAutoSlice(event.target.checked)}
          />
          自动切片
        </label>
        <span className="vn-sub">
          开启：全部主题自动入切片队列；关闭：分析继续，主题等待人工确认。开启也会处理已有待确认主题。
        </span>
      </div>

      <details className="vn-public-log" data-testid="project-log">
        <summary data-testid="project-log-summary">
          <span>运行日志与状态</span>
          <span className="vn-log-summary" data-testid="project-log-summary-text">
            {projectLogSummary(project)}
          </span>
        </summary>
        <div className="vn-public-body">
          <div className="vn-state-grid" data-testid="project-state-grid">
            {stateCells.map(([label, value]) => (
              <div key={label}>
                {label}
                <b>{value}</b>
              </div>
            ))}
          </div>
          <div className="vn-event-log" data-testid="project-event-log">
            {project.events.length === 0 ? (
              <p className="vn-hint">开始监控后显示事件。</p>
            ) : (
              project.events.map((event) => (
                <div key={event.id} data-level={event.level}>
                  <time>{eventTime(event.at)}</time>
                  {event.text}
                </div>
              ))
            )}
          </div>
        </div>
      </details>

      <div className="vn-tabs" role="tablist" aria-label="项目内容" onKeyDown={onTabsKeyDown}>
        {PROJECT_TABS.map((item) => (
          <button
            key={item.key}
            ref={(el) => {
              tabRefs.current[item.key] = el;
            }}
            type="button"
            role="tab"
            id={`project-tab-${item.key}`}
            aria-controls={`project-panel-${item.key}`}
            aria-selected={tab === item.key}
            tabIndex={tab === item.key ? 0 : -1}
            data-testid={`project-tab-${item.key}`}
            className="vn-tab"
            onClick={() => onTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {PROJECT_TABS.map((item) => (
        <section
          key={item.key}
          id={`project-panel-${item.key}`}
          role="tabpanel"
          aria-labelledby={`project-tab-${item.key}`}
          tabIndex={0}
          hidden={tab !== item.key}
          className="vn-tab-panel"
        >
          {panels?.[item.key] ?? null}
        </section>
      ))}
    </>
  );
}
