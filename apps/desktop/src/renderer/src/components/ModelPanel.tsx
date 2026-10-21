import type { DownloadSnapshot, ModelsStatus } from "../../../shared/ipc";
import { fmtBytes } from "../lib/format";

const STATE_LABEL: Record<"ready" | "unverified" | "missing" | "invalid", string> = {
  ready: "就绪",
  unverified: "未校验",
  missing: "缺失",
  invalid: "校验失败",
};

const STATE_TONE: Record<"ready" | "unverified" | "missing" | "invalid", "ok" | "warn" | "err"> = {
  ready: "ok",
  unverified: "warn",
  missing: "warn",
  invalid: "err",
};

const STATE_TEXT: Record<
  "idle" | "downloading" | "verifying" | "installing" | "done" | "failed" | "cancelled",
  string
> = {
  idle: "未开始",
  downloading: "下载中",
  verifying: "校验中",
  installing: "安装中",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
};

type BusyProps = {
  onDownload: () => void;
  onCancel: () => void;
  onImport: () => void;
  onVerify: () => void;
  busy: boolean;
  verifying: boolean;
};

export function ModelPanel({
  status,
  snapshot,
  onDownload,
  onCancel,
  onImport,
  onVerify,
  busy,
  verifying,
}: {
  status: ModelsStatus;
  snapshot: DownloadSnapshot | null;
} & BusyProps) {
  const snap = snapshot ?? status.download;
  const active =
    snap.state === "downloading" || snap.state === "verifying" || snap.state === "installing";
  return (
    <div data-testid="model-panel">
      <div className="vn-models">
        {status.bundles.map((b) => (
          <div
            key={b.id}
            className="vn-model"
            data-testid={`model-bundle-${b.id}`}
            data-state={b.state}
          >
            <div className="vn-model-name">{b.title}</div>
            <div className="vn-meta">
              <span>{fmtBytes(b.files.reduce((s, f) => s + f.expectedBytes, 0))}</span>
              <span className={`vn-tag ${STATE_TONE[b.state]}`}>{STATE_LABEL[b.state]}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="vn-row" style={{ flexWrap: "wrap", marginTop: 12 }}>
        <button
          type="button"
          className="vn-btn sm"
          data-testid="model-download"
          disabled={busy || active}
          onClick={onDownload}
        >
          下载模型
        </button>
        <button
          type="button"
          className="vn-btn sm"
          data-testid="model-cancel"
          disabled={!active}
          onClick={onCancel}
        >
          取消
        </button>
        <button
          type="button"
          className="vn-btn sm"
          data-testid="model-import"
          disabled={busy}
          onClick={onImport}
        >
          导入本地模型
        </button>
        <button
          type="button"
          className="vn-btn sm"
          data-testid="model-verify"
          disabled={busy || verifying}
          onClick={onVerify}
        >
          {verifying ? "校验中…" : "校验模型"}
        </button>
      </div>
      {active ? (
        <div className="vn-progress" data-testid="model-download-progress" aria-hidden="true">
          {snap.percent !== null ? (
            <i
              style={{ width: `${Math.max(0, Math.min(100, Math.round(snap.percent)))}%` }}
            />
          ) : (
            <i className="indeterminate" />
          )}
        </div>
      ) : null}
      {snap.message !== null ? (
        <p className="vn-hint" data-testid="model-download-message">
          {STATE_TEXT[snap.state]}
          {snap.percent !== null ? ` ${Math.round(snap.percent)}%` : ""}
          {snap.totalBytes > 0 ? ` · ${fmtBytes(snap.receivedBytes)}/${fmtBytes(snap.totalBytes)}` : ""}
          {snap.message !== "" ? ` · ${snap.message}` : ""}
        </p>
      ) : null}
    </div>
  );
}
