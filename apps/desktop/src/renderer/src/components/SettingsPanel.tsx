import type { SettingsStatus } from "../../../shared/ipc";
import { errMessage } from "../lib/format";
import { useEffect, useState } from "react";

// 设置状态面板：只读展示，契约里没有 key，这里也不显示。
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    window.vnote
      .settings()
      .then((s) => {
        if (active) setStatus(s);
      })
      .catch((err) => {
        if (active) setError(errMessage(err));
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <aside className="settings">
      <header className="settings__header">
        <h2>设置</h2>
        <button type="button" className="settings__close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </header>
      {error !== null && <div className="statebox statebox--error">加载设置失败：{error}</div>}
      {status === null && error === null && <div className="statebox">加载设置中…</div>}
      {status !== null && (
        <>
          <dl className="settings__list">
            <div className="settings__row">
              <dt>模型配置</dt>
              <dd>{status.configured ? "已配置" : "未配置"}</dd>
            </div>
            <div className="settings__row">
              <dt>模型</dt>
              <dd>{status.model ?? "自动发现"}</dd>
            </div>
            <div className="settings__row">
              <dt>笔记目录</dt>
              <dd className="settings__path">{status.notesRoot}</dd>
            </div>
            <div className="settings__row">
              <dt>模型目录</dt>
              <dd className="settings__path">{status.modelDir}</dd>
            </div>
            <div className="settings__row">
              <dt>ffmpeg</dt>
              <dd>{status.ffmpeg ? "可用" : "未找到"}</dd>
            </div>
          </dl>
          {status.dotenvFiles.length > 0 && (
            <div className="settings__dotenv">
              <h3>已加载的 dotenv 文件</h3>
              <ul>
                {status.dotenvFiles.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
