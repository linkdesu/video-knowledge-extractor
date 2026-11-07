import { useCallback, useRef, useState, type JSX } from "react";
import type {
  ProjectDetail,
  ProjectSubtitleLineInfo,
  ProjectTaskQueue,
  ProjectTaskStatus,
  ProjectTopicLines,
} from "../../../shared/ipc";
import {
  analysisRangeLabel,
  analysisStages,
  analysisTopicProgress,
  pendingTopics,
  proposedTopicSource,
  queueCountLabel,
  queueFootline,
  sliceTaskMeta,
  taskStatusLabel,
  type PendingTopic,
} from "../lib/project-queue";
import { TopicConfirmDialog } from "./TopicConfirmDialog";

type ActiveTopic = {
  topic: PendingTopic;
  /** 弹窗副标题（来源文件 · 分析区间）；与列表行的 `topic.sourceLine` 不是同一段文案。 */
  sourceLine: string;
  lines: ProjectSubtitleLineInfo[];
  loading: boolean;
  loadError: string | null;
};

function statusClass(status: ProjectTaskStatus): string {
  if (status === "done") return "ok";
  if (status === "failed") return "err";
  if (status === "running") return "accent";
  return "";
}

/**
 * 切片队列 tab（#142 队列 + #143 单主题确认弹窗，原型 L66-L68 / L82 / L131 / L137-L139）：
 * 分析队列每块两步、待确认主题（不占队列、不自动弹窗）、切片队列、底部「未切片内容时长」。
 * 待确认区只承载入口，弹窗、勾选与提交都在这里接线；#142 的队列展示逻辑保持不变。
 */
export function ProjectQueueTab({
  project,
  loadTopicLines,
  confirmTopic,
  retry,
}: {
  project: ProjectDetail;
  loadTopicLines: (topicKey: string) => Promise<ProjectTopicLines>;
  confirmTopic: (topicKey: string, lineIds: string[]) => Promise<void>;
  /** 重试失败任务（#154）：按队列名 + 任务 id 原地回队，不新增任务。 */
  retry: (queue: ProjectTaskQueue, taskId: number) => Promise<void>;
}): JSX.Element {
  const queue = project.queue;
  const analysis = queue?.analysis ?? [];
  const slices = queue?.slices ?? [];
  const proposed = pendingTopics(queue);
  const [active, setActive] = useState<ActiveTopic | null>(null);
  /** 正在重试的任务（`<队列>:<id>`）：一次只能提交一个，按钮按它禁用自己。 */
  const [retrying, setRetrying] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const loadRequestRef = useRef(0);
  /** 当前打开的是哪个主题；提交期间用户 Esc 换主题时，这次提交就不能再关弹窗。 */
  const activeKeyRef = useRef<string | null>(null);
  /** 弹窗是否仍关闭；关闭后在同一帧内又打开时，焦点恢复必须放弃。 */
  const closedRef = useRef(true);

  /**
   * 关掉弹窗后把焦点放回去。`keepTrigger` 只对「稍后确认 / Esc」成立：那时入口按钮还在，
   * 回到原按钮最顺手。生成切片会把该主题移出待确认区，入口按钮正在被卸载，哪怕此刻
   * 还 `isConnected`（列表还没随推送重渲染），聚焦上去紧接着就会掉回 body —— 这条路径
   * 必须直接给下一个待确认入口。
   */
  const closeDialog = useCallback((keepTrigger: boolean) => {
    loadRequestRef.current += 1;
    const closingKey = activeKeyRef.current;
    activeKeyRef.current = null;
    closedRef.current = true;
    setActive(null);
    const trigger = keepTrigger ? triggerRef.current : null;
    requestAnimationFrame(() => {
      if (!closedRef.current) return;
      if (trigger !== null && trigger.isConnected) {
        trigger.focus();
        return;
      }
      /**
       * 焦点不能掉到 body：先给下一个待确认入口（跳过刚提交的主题那一行），没有就落在
       * 待确认区本身（section 带 tabIndex=-1，永不卸载）。
       */
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="pending-topic-confirm"]'),
      ).filter(
        (button) =>
          closingKey === null ||
          button.closest<HTMLElement>("[data-topic-key]")?.dataset.topicKey !== closingKey,
      );
      const next = candidates[0];
      if (next !== undefined) {
        next.focus();
        return;
      }
      document.querySelector<HTMLElement>('[data-testid="queue-pending"]')?.focus();
    });
  }, []);

  /** 稍后确认 / Esc：焦点回到原入口按钮。单独包一层，保持 Esc 监听的依赖稳定。 */
  const defer = useCallback(() => closeDialog(true), [closeDialog]);

  const openDialog = (topic: PendingTopic, trigger: HTMLButtonElement) => {
    const requestId = ++loadRequestRef.current;
    const job = analysis.find((item) => item.id === topic.jobId);
    activeKeyRef.current = topic.topicKey;
    closedRef.current = false;
    triggerRef.current = trigger;
    setActive({
      topic,
      sourceLine: job === undefined ? topic.sourceLine : proposedTopicSource(job),
      lines: [],
      loading: true,
      loadError: null,
    });

    void loadTopicLines(topic.topicKey).then(
      (result) => {
        if (loadRequestRef.current !== requestId) return;
        setActive((current) =>
          current === null || current.topic.topicKey !== topic.topicKey
            ? current
            : { ...current, lines: result.lines, loading: false, loadError: null },
        );
      },
      () => {
        if (loadRequestRef.current !== requestId) return;
        setActive((current) =>
          current === null || current.topic.topicKey !== topic.topicKey
            ? current
            : {
                ...current,
                lines: [],
                loading: false,
                loadError: "无法读取完整字幕，请关闭后重试。",
              },
        );
      },
    );
  };

  /**
   * 重试失败任务（#154）：服务端只接受 failed 任务并原地回队，成功与否由
   * `projects:event` 全量推送与父层的 toast 呈现，这里只负责防重复提交。
   */
  const retryTask = (queueName: ProjectTaskQueue, taskId: number) => {
    const key = `${queueName}:${taskId}`;
    if (retrying !== null) return;
    setRetrying(key);
    void retry(queueName, taskId).finally(() => setRetrying(null));
  };

  const generate = async (lineIds: string[]) => {
    if (active === null) return;
    const topicKey = active.topic.topicKey;
    // 打开这一份弹窗时的加载代次：Esc 后重开同一主题会 +1，用它区分「同一个弹窗」和「同主题的新弹窗」
    const requestAtSubmit = loadRequestRef.current;
    await confirmTopic(topicKey, lineIds);
    // 提交期间用户可能已经 Esc 并打开另一个（或同一）主题：只关掉发起这次提交的那个弹窗
    if (activeKeyRef.current === topicKey && loadRequestRef.current === requestAtSubmit) {
      // 主题已经移出待确认区，原入口按钮不可靠：焦点直接给下一个入口
      closeDialog(false);
    }
  };

  return (
    <div className="vn-queue" data-testid="project-queue-tab">
      <div className="vn-queue-head">
        <h2>切片队列</h2>
        <span className="vn-tag" data-testid="queue-count">
          {queueCountLabel(queue)}
        </span>
      </div>
      <p className="vn-sub vn-queue-intro">
        两条独立串行队列：字幕解析 + 主题分析总是自动；切片任务在自动开启或人工确认后入队。待确认主题不占用任何队列。
      </p>

      <section className="vn-queue-section" aria-labelledby="queue-analysis-title" data-testid="queue-analysis">
        <h3 id="queue-analysis-title">字幕解析 + 主题分析</h3>
        <div className="vn-queue-list">
          {analysis.length === 0 ? (
            <p className="vn-queue-empty">尚无分析任务，勾选视频并开始整理。</p>
          ) : (
            analysis.map((job) => (
              <article
                key={job.id}
                className="vn-queue-task"
                data-testid="analysis-task"
                data-job-id={job.id}
              >
                <div className="vn-queue-task-head">
                  <div className="vn-queue-task-copy">
                    <h4>#{job.id} · {job.name}</h4>
                    <p>{analysisRangeLabel(job)}</p>
                  </div>
                  <div className="vn-queue-task-actions">
                    <span
                      className={`vn-tag ${statusClass(job.status)}`}
                      data-testid="analysis-task-status"
                    >
                      {taskStatusLabel(job.status)}
                    </span>
                    {job.status === "failed" ? (
                      <button
                        type="button"
                        className="vn-btn sm"
                        data-testid={`analysis-retry-${job.id}`}
                        disabled={retrying !== null}
                        onClick={() => retryTask("analysis", job.id)}
                      >
                        {retrying === `analysis:${job.id}` ? "重试中…" : "重试"}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="vn-analysis-stages" role="group" aria-label={`分析任务 #${job.id} 阶段`}>
                  {analysisStages(job).map((stage, index) => {
                    // 第二步按窗口划主题（#155）：整段分析可能跑很久，给出 `3/12` 才不像卡死
                    const progress = index === 1 ? analysisTopicProgress(job) : null;
                    return (
                      <div
                        key={stage.name}
                        className="vn-analysis-stage"
                        data-testid="analysis-stage"
                        data-stage={stage.name}
                        data-state={stage.state}
                      >
                        <span>{progress === null ? stage.name : `${stage.name} ${progress}`}</span>
                        <span className="vn-analysis-stage-state">{taskStatusLabel(stage.state)}</span>
                      </div>
                    );
                  })}
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      <section
        className="vn-queue-section"
        aria-labelledby="queue-pending-title"
        data-testid="queue-pending"
        tabIndex={-1}
      >
        <h3 id="queue-pending-title">待确认主题</h3>
        <div className="vn-queue-list">
          {proposed.length === 0 ? (
            <p className="vn-queue-empty">暂无待确认主题。</p>
          ) : (
            proposed.map((topic) => (
              <article
                key={topic.topicKey}
                className="vn-queue-task vn-pending-topic"
                data-testid="pending-topic"
                data-topic-key={topic.topicKey}
              >
                <div className="vn-queue-task-head">
                  <div className="vn-queue-task-copy">
                    <h4>{topic.title}</h4>
                    <p>{topic.sourceLine}</p>
                  </div>
                  {/* 入口只打开当前主题的弹窗：不自动弹窗、不占队列。 */}
                  <button
                    type="button"
                    className="vn-btn sm primary"
                    data-testid="pending-topic-confirm"
                    onClick={(event) => openDialog(topic, event.currentTarget)}
                  >
                    确认字幕
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      <section className="vn-queue-section" aria-labelledby="queue-slices-title" data-testid="queue-slices">
        <h3 id="queue-slices-title">切片</h3>
        <div className="vn-queue-list">
          {slices.length === 0 ? (
            <p className="vn-queue-empty">尚无切片任务；关闭自动切片时，确认单个主题后才入队。</p>
          ) : (
            slices.map((task) => (
              <article
                key={task.id}
                className="vn-queue-task"
                data-testid="slice-task"
                data-slice-id={task.id}
              >
                <div className="vn-queue-task-head">
                  <div className="vn-queue-task-copy">
                    <h4>#{task.id} · {task.title}</h4>
                    <p>{sliceTaskMeta(task)}</p>
                  </div>
                  <div className="vn-queue-task-actions">
                    <span
                      className={`vn-tag ${statusClass(task.status)}`}
                      data-testid="slice-task-status"
                    >
                      {taskStatusLabel(task.status)}
                    </span>
                    {task.status === "failed" ? (
                      <button
                        type="button"
                        className="vn-btn sm"
                        data-testid={`slice-retry-${task.id}`}
                        disabled={retrying !== null}
                        onClick={() => retryTask("slice", task.id)}
                      >
                        {retrying === `slice:${task.id}` ? "重试中…" : "重试"}
                      </button>
                    ) : null}
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      <p className="vn-queue-foot" data-testid="queue-foot">
        {queueFootline(queue, project.videoIds)}
      </p>

      {active === null ? null : (
        <TopicConfirmDialog
          /**
           * 弹窗的勾选是 useState 初值：同一次挂载里换主题会沿用上一个主题的编辑。
           * key 让每次挂载只服务一个 topicKey；「稍后确认 / Esc 后重开」本身会先卸载
           * 弹窗，初值已经按 AI 建议重置，不依赖这个 key。
           */
          key={active.topic.topicKey}
          topic={active.topic}
          sourceLine={active.sourceLine}
          lines={active.lines}
          loading={active.loading}
          loadError={active.loadError}
          onDefer={defer}
          onGenerate={generate}
        />
      )}
    </div>
  );
}
