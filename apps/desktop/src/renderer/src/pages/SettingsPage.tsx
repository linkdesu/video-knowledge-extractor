import { useCallback, useEffect, useState } from "react";
import type {
  DirectoryKind,
  SettingsPatch,
  SettingsStatus,
} from "../../../shared/ipc";
import { errMessage, fmtBytes } from "../lib/format";
import { showToast } from "../lib/toast";

const FIELD_LABEL: Record<"notesRoot" | "cacheRoot" | "modelDir", string> = {
  notesRoot: "notes 根目录",
  cacheRoot: "缓存目录（cache）",
  modelDir: "模型目录",
};

const FIELD_KIND: Record<"notesRoot" | "cacheRoot" | "modelDir", DirectoryKind> = {
  notesRoot: "notes",
  cacheRoot: "cache",
  modelDir: "model",
};

type PathField = "notesRoot" | "cacheRoot" | "modelDir";

function PathInput({
  label,
  value,
  locked,
  onCommit,
}: {
  label: PathField;
  value: string;
  locked: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    if (locked) return;
    if (draft.trim() !== "" && draft !== value) onCommit(draft.trim());
  };

  return (
    <div className="vn-field" data-testid={`settings-path-${label}`}>
      <label>{FIELD_LABEL[label]}</label>
      <div className="vn-row">
        <input
          className="vn-input"
          style={{ flex: 1 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          readOnly={locked}
          aria-label={FIELD_LABEL[label]}
          data-testid={`settings-path-input-${label}`}
        />
        <button
          type="button"
          className="vn-btn sm"
          data-testid={`settings-pick-${label}`}
          disabled={locked}
          onClick={() => {
            window.vnote
              .pickDirectory(FIELD_KIND[label])
              .then((dir) => {
                if (dir !== null) {
                  setDraft(dir);
                  onCommit(dir);
                }
              })
              .catch((err) => showToast(`选择目录失败：${errMessage(err)}`));
          }}
        >
          选择…
        </button>
      </div>
      {locked ? (
        <span className="vn-hint" data-testid={`settings-path-locked-${label}`}>
          由环境变量控制
        </span>
      ) : null}
    </div>
  );
}

export function SettingsPage() {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);

  const reload = useCallback(() => {
    setLoadError(null);
    window.vnote
      .settings()
      .then(setStatus)
      .catch((err) => setLoadError(errMessage(err)));
  }, []);

  useEffect(reload, [reload]);

  const update = useCallback((patch: SettingsPatch) => {
    window.vnote
      .updateSettings(patch)
      .then(setStatus)
      .catch((err) => showToast(`保存失败：${errMessage(err)}`));
  }, []);

  const testLlm = () => {
    setTesting(true);
    window.vnote
      .testLlm()
      .then((r) =>
        showToast(r.ok ? `连接正常${r.model !== null ? ` · ${r.model}` : ""}` : r.message),
      )
      .catch((err) => showToast(`测试失败：${errMessage(err)}`))
      .finally(() => setTesting(false));
  };

  const clearCache = () => {
    setClearing(true);
    window.vnote
      .clearCache()
      .then((r) => showToast(`缓存已清理，释放 ${fmtBytes(r.freedBytes)}`))
      .catch((err) => showToast(`清理缓存失败：${errMessage(err)}`))
      .then(reload)
      .finally(() => setClearing(false));
  };

  if (loadError !== null) {
    return (
      <div className="vn-hint">
        加载设置失败：{loadError}
        <button
          type="button"
          className="vn-btn sm"
          style={{ marginLeft: 12 }}
          onClick={reload}
        >
          重试
        </button>
      </div>
    );
  }

  if (status === null) {
    return <div className="vn-hint">加载设置中…</div>;
  }

  const asrModelNote = status.asr.modelPresent
    ? "模型文件已在模型目录"
    : "模型文件缺失，请检查模型目录";

  return (
    <>
      <h1 className="vn-h1">设置</h1>
      <p className="vn-sub">模型、存储与缓存。API key 安全存储，界面只显示已保存。</p>

      <div className="vn-grid vn-cards2" data-testid="settings-page">
        <section className="vn-card vn-pad" data-testid="settings-asr">
          <b>语音转写</b>
          <div className="vn-field" style={{ marginTop: 12 }}>
            <label>提供方</label>
            <span className="vn-read">
              {status.asr.provider === "sherpa-onnx"
                ? "本地 sherpa-onnx"
                : status.asr.provider}
            </span>
          </div>
          <div className="vn-field">
            <label>模型</label>
            <span className="vn-read">{status.asr.modelId}</span>
          </div>
          <p className="vn-hint" style={{ marginTop: 8 }}>
            模型文件放在「模型目录」（{status.modelDir}）。{asrModelNote}
          </p>
        </section>

        <section className="vn-card vn-pad" data-testid="settings-llm">
          <b>总结分析</b>
          <div className="vn-field" style={{ marginTop: 12 }}>
            <label>接口地址</label>
            <span className="vn-read">{status.llm.baseUrl ?? "未配置"}</span>
          </div>
          <div className="vn-field">
            <label>模型名</label>
            <span className="vn-read">
              {status.llm.model ?? status.llm.discoveredModel ?? "未配置"}
            </span>
          </div>
          <button
            type="button"
            data-testid="settings-test-llm"
            className="vn-btn sm"
            onClick={testLlm}
            disabled={testing}
          >
            {testing ? "测试中…" : "测试连接"}
          </button>
        </section>

        <section className="vn-card vn-pad" data-testid="settings-storage">
          <b>存储</b>
          <div style={{ marginTop: 12 }}>
            <PathInput
              label="notesRoot"
              value={status.notesRoot}
              locked={status.locked.notesRoot}
              onCommit={(v) => update({ notesRoot: v })}
            />
            <PathInput
              label="cacheRoot"
              value={status.cacheRoot}
              locked={status.locked.cacheRoot}
              onCommit={(v) => update({ cacheRoot: v })}
            />
            <PathInput
              label="modelDir"
              value={status.modelDir}
              locked={status.locked.modelDir}
              onCommit={(v) => update({ modelDir: v })}
            />
          </div>
          <div className="vn-row vn-between">
            <span className="vn-hint">缓存占用 {fmtBytes(status.cacheBytes)}</span>
            <button
              type="button"
              data-testid="settings-clear-cache"
              className="vn-btn sm"
              onClick={clearCache}
              disabled={clearing}
            >
              {clearing ? "清理中…" : "清理缓存"}
            </button>
          </div>
        </section>

        <section className="vn-card vn-pad" data-testid="settings-about">
          <b>关于</b>
          <div className="vn-meta" style={{ marginTop: 12, flexDirection: "column", gap: 6 }}>
            <span>VideoNotes {status.appVersion}</span>
            <span>ffmpeg {status.ffmpegVersion ?? "未安装"}</span>
          </div>
        </section>
      </div>
    </>
  );
}
