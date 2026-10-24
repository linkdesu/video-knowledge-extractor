import { useEffect, useRef } from "react";
import type {
  DownloadSnapshot,
  ModelBundleStatus,
  ModelLogEntry,
  ModelsCheck,
} from "../../../shared/ipc";
import { fmtBytes } from "../lib/format";
import { Button } from "../rbp/blocks/settings-form-3";

const STATE_TEXT: Record<DownloadSnapshot["state"], string> = {
  idle: "未开始",
  downloading: "下载中",
  verifying: "校验中",
  installing: "安装中",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
};

type BundleId = ModelBundleStatus["id"];

type PanelProps = {
  modelDir: string;
  /** 就绪判定唯一事实源：文件存在即就绪（与本地检测、提取前检查同一口径）。 */
  check: ModelsCheck;
  /** 下载快照；null 时只看 check。 */
  snapshot: DownloadSnapshot | null;
  log: ModelLogEntry[];
  /** 本次运行点过「下载模型」；就绪或失败/取消后由父级清除。 */
  started: boolean;
  checking: boolean;
  onDownload: () => void;
  onDownloadBundle: (bundleId: BundleId) => void;
  onCancel: () => void;
  onVerify: () => void;
};

export function ModelPanel({
  modelDir,
  check,
  snapshot,
  log,
  started,
  checking,
  onDownload,
  onDownloadBundle,
  onCancel,
  onVerify,
}: PanelProps) {
  const snap = snapshot ?? { state: "idle", bundleId: null, receivedBytes: 0, totalBytes: 0, percent: null, message: null };
  const active = snap.state === "downloading" || snap.state === "verifying" || snap.state === "installing";
  const showProgress = started || active;
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [log]);
  return (
    <div data-testid="model-panel">
      <div className="vn-models">
        <div className="vn-row vn-between">
          <span className="vn-meta" data-testid="model-dir-path" style={{ minWidth: 0, wordBreak: "break-all" }}>
            {modelDir}
          </span>
          <Button size="sm" data-testid="model-open-dir" onClick={() => window.vnote.reveal(modelDir)}>
            打开模型目录
          </Button>
        </div>
        {check.models.map((m) => {
          const downloading = active && snap.bundleId === m.id;
          return (
            <div key={m.id} className="vn-model" data-testid={`model-required-${m.id}`}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="vn-model-name">{m.label}</div>
                <div className="vn-model-path">{m.relativePaths.join(" / ")}</div>
                {m.missing.length > 0 ? (
                  <div className="vn-model-missing">缺失：{m.missing.join("、")}</div>
                ) : null}
              </div>
              <div className="vn-model-actions">
                <span className={`vn-tag ${downloading ? "accent" : m.ready ? "ok" : "err"}`}>
                  {downloading ? "下载中" : m.ready ? "就绪" : "缺失"}
                </span>
                {m.ready ? null : (
                  <Button
                    size="sm"
                    data-testid={`model-download-${m.id}`}
                    disabled={active}
                    onClick={() => onDownloadBundle(m.id)}
                  >
                    下载
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="vn-row" style={{ flexWrap: "wrap", marginTop: 12 }}>
        <Button type="button" data-testid="model-download" disabled={active || check.ready} onClick={onDownload}>
          下载模型
        </Button>
        <Button type="button" data-testid="model-cancel" disabled={!active} onClick={onCancel}>
          取消
        </Button>
        <Button type="button" data-testid="model-verify" disabled={checking} onClick={onVerify}>
          {checking ? "检测中..." : "检测本地模型"}
        </Button>
      </div>
      {showProgress ? (
        <>
          <div className="vn-progress" data-testid="model-download-progress" aria-hidden="true">
            {snap.percent === null ? (
              <i className="indeterminate" />
            ) : (
              <i style={{ width: `${Math.max(0, Math.min(100, Math.round(snap.percent)))}%` }} />
            )}
          </div>
          <p className="vn-hint" data-testid="model-download-message">
            {STATE_TEXT[snap.state]}
            {snap.percent !== null ? ` ${Math.round(snap.percent)}%` : ""}
            {snap.totalBytes > 0 ? ` · ${fmtBytes(snap.receivedBytes)}/${fmtBytes(snap.totalBytes)}` : ""}
            {snap.message !== null && snap.message !== "" ? ` · ${snap.message}` : ""}
          </p>
        </>
      ) : null}
      <div className="vn-model-log" data-testid="model-download-log" ref={logRef}>
        {log.length === 0 ? (
          <span className="vn-model-log-empty">暂无日志</span>
        ) : (
          log.map((line, i) => (
            <div key={`${line.at}-${i}`} className={`vn-model-log-line ${line.level}`}>
              <span className="vn-model-log-time">{line.at.slice(11, 19)}</span>
              <span>{line.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
