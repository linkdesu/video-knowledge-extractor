import { useCallback, useRef, useState } from "react";
import type { CreateProjectInput, ProjectSummary } from "../../../shared/ipc";
import { errMessage } from "../lib/format";
import { projectStatsLine } from "../lib/project-frame";
import { ProjectDeleteDialog } from "../components/ProjectDeleteDialog";

/** 项目列表（#127，原型 L29-L34 / L129 / L145）：创建表单 + 每个项目一行统计。 */
export function ProjectListPage({
  projects,
  loading,
  loadError,
  onReload,
  onOpen,
  onDelete,
  onCreate,
}: {
  projects: ProjectSummary[];
  loading: boolean;
  loadError: string | null;
  onReload: () => void;
  onOpen: (project: ProjectSummary) => void;
  /** 删除项目（#154）：只删登记，成功由父层刷新列表；失败以可读错误 reject。 */
  onDelete: (project: ProjectSummary) => Promise<void>;
  /** 成功时 App 直接进入新项目页，这里只负责表单状态。 */
  onCreate: (input: CreateProjectInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [rootDir, setRootDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** 待确认删除的项目与触发按钮：关闭后焦点必须回到那颗按钮（列表可能整行消失）。 */
  const [deleting, setDeleting] = useState<{ project: ProjectSummary } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);

  const openDelete = (project: ProjectSummary, trigger: HTMLButtonElement) => {
    deleteTriggerRef.current = trigger;
    setDeleteError(null);
    setDeleting({ project });
  };

  const closeDelete = useCallback(() => {
    setDeleting(null);
    setDeleteError(null);
    // 弹窗卸载后再还焦点：目标按钮要还在（删除成功时整行已消失，此时不硬还）
    const trigger = deleteTriggerRef.current;
    deleteTriggerRef.current = null;
    if (trigger !== null && trigger.isConnected) trigger.focus();
  }, []);

  const confirmDelete = () => {
    if (deleting === null || deleteBusy) return;
    const target = deleting.project;
    setDeleteBusy(true);
    setDeleteError(null);
    void onDelete(target)
      .then(() => {
        deleteTriggerRef.current = null;
        setDeleting(null);
      })
      .catch((err) => setDeleteError(errMessage(err)))
      .finally(() => setDeleteBusy(false));
  };

  const submit = () => {
    if (busy) return;
    setBusy(true);
    setFormError(null);
    void onCreate({ name: name.trim(), rootDir: rootDir.trim() })
      .then(() => {
        setName("");
        setRootDir("");
      })
      .catch((err) => setFormError(errMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <div className="vn-project-head">
        <div>
          <h1 className="vn-h1">
            <span className="vn-gtext">切片项目</span>
          </h1>
          <p className="vn-sub">按项目管理录制目录、处理队列和切片产出。</p>
        </div>
      </div>

      <form
        className="vn-card vn-pad vn-project-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="vn-field">
          项目名称
          <input
            className="vn-input"
            data-testid="project-create-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：晚场直播精华"
            maxLength={60}
            required
          />
        </label>
        <label className="vn-field">
          项目目录
          <input
            className="vn-input"
            data-testid="project-create-root"
            value={rootDir}
            onChange={(e) => setRootDir(e.target.value)}
            placeholder="例如 /Users/link/Movies/切片项目/晚场直播"
            required
          />
        </label>
        <button
          type="submit"
          className="vn-btn primary"
          data-testid="project-create"
          disabled={busy || name.trim() === "" || rootDir.trim() === ""}
        >
          {busy ? "创建中…" : "创建项目"}
        </button>
      </form>
      {formError !== null ? (
        <p className="vn-hint vn-project-error" data-testid="project-create-error">
          创建失败：{formError}
        </p>
      ) : null}

      {loading ? (
        <p className="vn-hint vn-project-loading">加载项目中…</p>
      ) : loadError !== null ? (
        <p className="vn-hint vn-project-loading">
          加载项目失败：{loadError}
          <button type="button" className="vn-btn sm" style={{ marginLeft: 12 }} onClick={onReload}>
            重试
          </button>
        </p>
      ) : projects.length === 0 ? (
        <p className="vn-hint vn-project-loading" data-testid="project-empty">
          创建项目后配置监控目录。
        </p>
      ) : (
        <div className="vn-project-list" data-testid="project-list">
          {projects.map((project) => (
            <article className="vn-project-row" key={project.id} data-testid="project-row">
              <div className="vn-project-row-meta">
                <h2 className="vn-project-name">{project.name}</h2>
                <p className="vn-project-path">{project.rootDir}</p>
                <p className="vn-project-stats" data-testid="project-stats">
                  {projectStatsLine(project)}
                </p>
              </div>
              <div className="vn-project-row-actions">
                <button
                  type="button"
                  className="vn-btn primary sm"
                  data-testid={`project-open-${project.id}`}
                  onClick={() => onOpen(project)}
                >
                  进入项目
                </button>
                <button
                  type="button"
                  className="vn-btn sm"
                  data-testid={`project-delete-${project.id}`}
                  aria-label={`删除项目 ${project.name}`}
                  onClick={(event) => openDelete(project, event.currentTarget)}
                >
                  删除项目
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {deleting === null ? null : (
        <ProjectDeleteDialog
          project={deleting.project}
          busy={deleteBusy}
          error={deleteError}
          onCancel={closeDelete}
          onConfirm={confirmDelete}
        />
      )}
    </>
  );
}
