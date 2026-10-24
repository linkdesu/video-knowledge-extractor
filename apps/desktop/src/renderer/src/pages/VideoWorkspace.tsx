import type { JobSnapshot, VideoDetail } from "../../../shared/ipc";
import { StepBar } from "@/rbp/blocks/app-shell-6";
import { hasReadyNote } from "@/lib/topic-state";
import type { PageContext, WorkspacePage } from "./types";
import { TranscriptPage } from "./TranscriptPage";
import { TopicsPage } from "./TopicsPage";
import { NotesPage } from "./NotesPage";

// 视频工作区：步骤条 + 当前页。App 传入的 detail 可能为 null（加载中），
// 回调可能返回 void 或 Promise；这里桥接成 PageContext 的严格契约。
export function VideoWorkspace(props: {
  detail: VideoDetail | null;
  page: WorkspacePage;
  job: JobSnapshot | null;
  onPage: (page: WorkspacePage) => void;
  onBack: () => void;
  onRefresh: () => void | Promise<void>;
  onStartNotes: (topicIds: string[], options?: { force?: boolean }) => void | Promise<unknown>;
  onRebuildTopics: () => void | Promise<void>;
}) {
  const { detail, page, job } = props;
  if (detail === null) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: 200 }}>
        <span style={{ color: "var(--vn-muted)", fontSize: 13 }}>加载中…</span>
      </div>
    );
  }
  const ctx: PageContext = {
    detail,
    job,
    onRefresh: () => Promise.resolve(props.onRefresh()),
    onPage: props.onPage,
    onStartNotes: (topicIds: string[], options?: { force?: boolean }) => Promise.resolve(props.onStartNotes(topicIds, options)).then(() => undefined),
    onRebuildTopics: () => Promise.resolve(props.onRebuildTopics()),
  };
  return (
    <>
      <StepBar page={page} onPage={props.onPage} notesReady={hasReadyNote(detail.topics)} />
      {page === "transcript" ? (
        <TranscriptPage {...ctx} />
      ) : page === "topics" ? (
        <TopicsPage {...ctx} />
      ) : (
        <NotesPage {...ctx} />
      )}
    </>
  );
}
