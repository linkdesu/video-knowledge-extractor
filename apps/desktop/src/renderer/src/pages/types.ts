import type { JobSnapshot, VideoDetail } from "../../../shared/ipc";

export type WorkspacePage = "transcript" | "topics" | "notes";

export type PageContext = {
  detail: VideoDetail;
  job: JobSnapshot | null;
  onRefresh: () => Promise<void>;
  onPage: (page: WorkspacePage) => void;
  onStartNotes: (topicIds: string[]) => Promise<void>;
  onRebuildTopics: () => Promise<void>;
};
