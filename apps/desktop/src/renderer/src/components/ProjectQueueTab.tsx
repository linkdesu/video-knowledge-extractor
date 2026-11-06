import type { JSX } from "react";
import type { ProjectDetail, ProjectTaskStatus } from "../../../shared/ipc";
import {
  analysisRangeLabel,
  analysisStages,
  pendingTopics,
  queueCountLabel,
  queueFootline,
  sliceTaskMeta,
  taskStatusLabel,
} from "../lib/project-queue";

function statusClass(status: ProjectTaskStatus): string {
  if (status === "done") return "ok";
  if (status === "failed") return "err";
  if (status === "running") return "accent";
  return "";
}

/**
 * 切片队列 tab（#142，原型 L66-L68 / L131）：
 * 分析队列每块两步、待确认主题（不占队列、不自动弹窗）、切片队列、底部「未切片内容时长」。
 * 「确认字幕」的弹窗交互由 #143 接入；本 tab 只负责入口与列表面板，入口不自动打开任何东西。
 */
export function ProjectQueueTab({ project }: { project: ProjectDetail }): JSX.Element {
  const queue = project.queue;
  const analysis = queue?.analysis ?? [];
  const slices = queue?.slices ?? [];
  const proposed = pendingTopics(queue);

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
                  <span
                    className={`vn-tag ${statusClass(job.status)}`}
                    data-testid="analysis-task-status"
                  >
                    {taskStatusLabel(job.status)}
                  </span>
                </div>
                <div className="vn-analysis-stages" role="group" aria-label={`分析任务 #${job.id} 阶段`}>
                  {analysisStages(job).map((stage) => (
                    <div
                      key={stage.name}
                      className="vn-analysis-stage"
                      data-testid="analysis-stage"
                      data-stage={stage.name}
                      data-state={stage.state}
                    >
                      <span>{stage.name}</span>
                      <span className="vn-analysis-stage-state">{taskStatusLabel(stage.state)}</span>
                    </div>
                  ))}
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
                  {/* 入口先按原型就位；#143 接上单主题确认弹窗，不自动弹、不占队列。 */}
                  <button
                    type="button"
                    className="vn-btn sm primary"
                    data-testid="pending-topic-confirm"
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
                  <span
                    className={`vn-tag ${statusClass(task.status)}`}
                    data-testid="slice-task-status"
                  >
                    {taskStatusLabel(task.status)}
                  </span>
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      <p className="vn-queue-foot" data-testid="queue-foot">
        {queueFootline(queue, project.videoIds)}
      </p>
    </div>
  );
}
