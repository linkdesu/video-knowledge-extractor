/**
 * 每个项目一个运行日志环形缓冲（#121 实现决策 9）：界面展开「运行日志与状态」时
 * 最多看到最近 80 条，最新在前。事件只活在内存里，不写进项目清单；需要长期留存的
 * 记录由调用方同步写进结构化日志（ADR-0028）。
 */
export const PROJECT_EVENT_LIMIT = 80;

export type ProjectEventLevel = "info" | "warn" | "error";

export type ProjectEventRecord = {
  /** 项目内自增，界面用它做列表 key；重启后从 1 重新开始。 */
  id: number;
  at: string;
  level: ProjectEventLevel;
  text: string;
};

type EventBucket = { serial: number; events: ProjectEventRecord[] };

export class ProjectEventLog {
  private readonly buckets = new Map<string, EventBucket>();
  private readonly limit: number;
  private readonly now: () => Date;

  constructor(options: { limit?: number; now?: () => Date } = {}) {
    this.limit = options.limit ?? PROJECT_EVENT_LIMIT;
    this.now = options.now ?? (() => new Date());
  }

  push(projectId: string, text: string, level: ProjectEventLevel = "info"): ProjectEventRecord {
    const bucket = this.buckets.get(projectId) ?? { serial: 0, events: [] };
    bucket.serial += 1;
    const event: ProjectEventRecord = { id: bucket.serial, at: this.now().toISOString(), level, text };
    bucket.events.unshift(event);
    if (bucket.events.length > this.limit) bucket.events.length = this.limit;
    this.buckets.set(projectId, bucket);
    return event;
  }

  /** 最新在前；未知项目返回空数组。 */
  list(projectId: string): ProjectEventRecord[] {
    return [...(this.buckets.get(projectId)?.events ?? [])];
  }

  clear(projectId: string): void {
    this.buckets.delete(projectId);
  }
}
