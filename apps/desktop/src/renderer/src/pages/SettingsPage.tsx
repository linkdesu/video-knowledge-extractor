import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AsrProvider,
  AsrSecretField,
  DirectoryKind,
  DownloadSnapshot,
  ModelsStatus,
  SettingsPatch,
  SettingsStatus,
  VolcengineAuthMode,
  VolcengineMode,
} from "../../../shared/ipc";
import { ModelPanel } from "../components/ModelPanel";
import { errMessage, fmtBytes } from "../lib/format";
import { showToast } from "../lib/toast";

/** 火山引擎的端点与 resource id 是协议常量，不是用户配置（ADR-0016 §2）；这里只用于只读展示。 */
const VOLC_MODE_INFO: Record<
  VolcengineMode,
  { endpoint: string; queryEndpoint?: string; resourceId: string }
> = {
  flash: {
    endpoint: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
    resourceId: "volc.bigasr.auc_turbo",
  },
  standard: {
    endpoint: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
    queryEndpoint: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
    resourceId: "volc.seedasr.auc",
  },
};

const PROVIDER_LABEL: Record<AsrProvider, string> = {
  local: "本地 sherpa-onnx",
  openai: "远程 ASR（OpenAI 兼容）",
  volcengine: "火山引擎 · 录音文件识别",
};

const VOLC_MODE_LABEL: Record<VolcengineMode, string> = {
  flash: "极速版（同步，上传音频）",
  standard: "标准版（异步，需公网 URL）",
};

const VOLC_AUTH_LABEL: Record<VolcengineAuthMode, string> = {
  apiKey: "新版控制台 API Key",
  appAccessKey: "旧版控制台 App Key + Access Key",
};

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

type TextCommit = {
  value: string;
  locked: boolean;
  placeholder?: string;
  onCommit: (value: string) => void;
  testId: string;
};

function CommitInput({ value, locked, placeholder, onCommit, testId }: TextCommit) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    if (locked) return;
    if (draft !== value) onCommit(draft);
  };

  return (
    <input
      className="vn-input"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      readOnly={locked}
      data-testid={testId}
    />
  );
}

type KeyFieldProps = {
  /** 字段名（API key / API Key / App Key / Access Key）。 */
  label: string;
  hasKey: boolean;
  keySource: "env" | "stored" | "none";
  keyStorageAvailable: boolean;
  onSave: (key: string) => Promise<void>;
  onClear: () => Promise<void>;
  testId: string;
};

function KeyField({
  label,
  hasKey,
  keySource,
  keyStorageAvailable,
  onSave,
  onClear,
  testId,
}: KeyFieldProps) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    if (!hasKey) setDraft("");
  }, [hasKey]);

  // 每个密钥字段独立判断来源：env 提供的那个字段显示「由环境变量控制」，与整套凭据的解析结果无关。
  if (keySource === "env") {
    return (
      <div className="vn-field" data-testid={`${testId}-field`}>
        <label>{label}</label>
        <span className="vn-hint">由环境变量控制</span>
      </div>
    );
  }
  if (hasKey) {
    return (
      <div className="vn-field" data-testid={`${testId}-field`}>
        <label>{label}</label>
        <div className="vn-row">
          <span className="vn-hint">已保存（系统密钥库）</span>
          {keyStorageAvailable ? (
            <button
              type="button"
              className="vn-btn sm"
              data-testid={`${testId}-clear`}
              disabled={clearing}
              onClick={() => {
                setClearing(true);
                onClear()
                  .catch((err) => showToast(`清除失败：${errMessage(err)}`))
                  .finally(() => setClearing(false));
              }}
            >
              {clearing ? "清除中…" : "清除"}
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="vn-field" data-testid={`${testId}-field`}>
      <label>{label}</label>
      <div className="vn-row">
        <input
          type="password"
          className="vn-input"
          style={{ flex: 1 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (draft.trim() !== "") {
                setSaving(true);
                onSave(draft.trim())
                  .catch((err) => showToast(`保存失败：${errMessage(err)}`))
                  .finally(() => setSaving(false));
              }
            }
          }}
          aria-label={label}
          data-testid={`${testId}-input`}
        />
        {keyStorageAvailable ? (
          <button
            type="button"
            className="vn-btn sm"
            data-testid={`${testId}-save`}
            disabled={saving || draft.trim() === ""}
            onClick={() => {
              if (draft.trim() === "") return;
              setSaving(true);
              onSave(draft.trim())
                .catch((err) => showToast(`保存失败：${errMessage(err)}`))
                .finally(() => setSaving(false));
            }}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        ) : null}
      </div>
      {keyStorageAvailable ? null : (
        <span className="vn-hint" data-testid={`${testId}-no-storage`}>
          系统密钥存储不可用，请用环境变量配置密钥
        </span>
      )}
    </div>
  );
}

export function SettingsPage() {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testingLlm, setTestingLlm] = useState(false);
  const [testingAsr, setTestingAsr] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [models, setModels] = useState<ModelsStatus | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [snapshot, setSnapshot] = useState<DownloadSnapshot | null>(null);
  const reloadTimers = useRef<number[]>([]);

  const reload = useCallback(() => {
    setLoadError(null);
    window.vnote
      .settings()
      .then(setStatus)
      .catch((err) => setLoadError(errMessage(err)));
  }, []);

  useEffect(reload, [reload]);

  const reloadModels = useCallback(() => {
    setModelsError(null);
    window.vnote
      .models()
      .then(setModels)
      .catch((err) => setModelsError(errMessage(err)));
  }, []);
  useEffect(() => {
    reloadModels();
    return () => {
      for (const t of reloadTimers.current) window.clearTimeout(t);
    };
  }, [reloadModels]);

  useEffect(() => {
    // 端点发现是后台异步的：落定后重拉一次，模型名提示才不会是「留空时自动发现」
    const off = window.vnote.onLlmChanged(reload);
    return off;
  }, [reload]);

  useEffect(() => {
    const off = window.vnote.onModelDownload((snap) => {
      setSnapshot(snap);
      setDownloading(snap.state === "downloading");
      if (snap.state === "done" || snap.state === "failed") reloadModels();
    });
    return off;
  }, []);

  const update = useCallback((patch: SettingsPatch) => {
    window.vnote
      .updateSettings(patch)
      .then(setStatus)
      .catch((err) => showToast(`保存失败：${errMessage(err)}`));
  }, []);

  // 一次只改一个密钥：四个字段各自一次调用（ADR-0016 §5），两次保存之间是可见的中间态。
  const saveSecret =
    (field: AsrSecretField, label: string) =>
    (value: string): Promise<void> =>
      window.vnote
        .updateAsr({ secret: { field, value } })
        .then(setStatus)
        .then(() => showToast(`${label} 已保存`));

  const clearSecret =
    (field: AsrSecretField, label: string) =>
    (): Promise<void> =>
      window.vnote
        .updateAsr({ secret: { field, clear: true } })
        .then(setStatus)
        .then(() => showToast(`${label} 已清除`));

  const testLlm = () => {
    setTestingLlm(true);
    window.vnote
      .testLlm()
      .then((r) =>
        showToast(r.ok ? `连接正常${r.model !== null ? ` · ${r.model}` : ""}` : r.message),
      )
      .catch((err) => showToast(`测试失败：${errMessage(err)}`))
      .finally(() => setTestingLlm(false));
  };

  const testAsr = () => {
    setTestingAsr(true);
    window.vnote
      .testAsr()
      .then((r) =>
        showToast(
          r.ok
            ? `连接正常${r.modelsFound !== null ? ` · 发现 ${r.modelsFound} 个模型` : ""}`
            : r.message,
        ),
      )
      .catch((err) => showToast(`测试失败：${errMessage(err)}`))
      .finally(() => setTestingAsr(false));
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

  const runModelAction = (action: () => Promise<unknown>) =>
    action()
      .then(() => reloadModels())
      .catch((err) => showToast(`操作失败：${errMessage(err)}`));


  const verify = () => {
    setVerifying(true);
    runModelAction(() => window.vnote.verifyModels()).finally(() => setVerifying(false));
  };

  const importModels = () => {
    setImporting(true);
    window.vnote
      .importModels()
      .then((r) => {
        if (!r.canceled) {
          if (r.rejected.length > 0) {
            showToast(`导入完成，${r.rejected.length} 个包被拒绝`);
          } else if (r.installed.length > 0) {
            showToast(`已导入 ${r.installed.length} 个模型包`);
          } else {
            showToast("未找到可导入的模型文件");
          }
        }
      })
      .catch((err) => showToast(`导入失败：${errMessage(err)}`))
      .then(() => {
        reloadModels();
        const t = window.setTimeout(reloadModels, 2000);
        reloadTimers.current.push(t);
      })
      .finally(() => setImporting(false));
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

  const asr = status.asr;
  const llm = status.llm;
  // r26：试用版只启用本地 ASR；隐藏提供方切换与云端面板（存盘值由 main 求值为 local）
  const cloudAsr = status.features.cloudAsr;
  const volcModeInfo = VOLC_MODE_INFO[asr.volcengine.mode];
  const busyModel = downloading || importing || verifying;
  const localMissing =
    models !== null
      ? models.bundles.filter((b) => b.state !== "ready").map((b) => b.title)
      : asr.local.missing;

  return (
    <>
      <h1 className="vn-h1">设置</h1>
      <p className="vn-sub">模型、存储与缓存。API key 安全存储，界面只显示已保存。</p>

      <div className="vn-grid vn-cards2" data-testid="settings-page">
        <section className="vn-card vn-pad" data-testid="settings-asr">
          <b>语音转写</b>
          <div className="vn-field" style={{ marginTop: 12 }}>
            <label>提供方</label>
            {cloudAsr ? (
              <>
                <select
                  className="vn-select"
                  value={asr.provider}
                  disabled={asr.providerLocked}
                  data-testid="settings-asr-provider"
                  onChange={(e) =>
                    update({ asr: { provider: e.target.value as AsrProvider } })
                  }
                >
                  {(Object.keys(PROVIDER_LABEL) as AsrProvider[]).map((value) => (
                    <option key={value} value={value}>
                      {PROVIDER_LABEL[value]}
                    </option>
                  ))}
                </select>
                {asr.providerLocked ? (
                  <span className="vn-hint">由环境变量控制</span>
                ) : null}
              </>
            ) : (
              <span className="vn-read" data-testid="settings-asr-provider-fixed">
                {PROVIDER_LABEL.local}
              </span>
            )}
          </div>
          {cloudAsr && asr.provider === "openai" ? (
            <>
              <div className="vn-field">
                <label>接口地址</label>
                <CommitInput
                  value={asr.openai.baseUrl}
                  locked={asr.openai.locked.baseUrl}
                  placeholder="https://api.example.com/v1"
                  onCommit={(v) => update({ asr: { openai: { baseUrl: v } } })}
                  testId="settings-asr-base-url"
                />
                {asr.openai.locked.baseUrl ? <span className="vn-hint">由环境变量控制</span> : null}
              </div>
              <div className="vn-field">
                <label>模型名</label>
                <CommitInput
                  value={asr.openai.model}
                  locked={asr.openai.locked.model}
                  onCommit={(v) => update({ asr: { openai: { model: v } } })}
                  testId="settings-asr-model"
                />
                {asr.openai.locked.model ? <span className="vn-hint">由环境变量控制</span> : null}
              </div>
              <KeyField
                label="API key"
                hasKey={asr.openai.hasKey}
                keySource={asr.openai.keySource}
                keyStorageAvailable={asr.openai.keyStorageAvailable}
                testId="settings-asr-key"
                onSave={saveSecret("openaiKey", "API key")}
                onClear={clearSecret("openaiKey", "API key")}
              />
              {asr.openai.error !== null ? (
                <p className="vn-hint" data-testid="settings-asr-error">
                  {asr.openai.error}
                </p>
              ) : null}
              <button
                type="button"
                data-testid="settings-test-asr"
                className="vn-btn sm"
                onClick={testAsr}
                disabled={testingAsr}
              >
                {testingAsr ? "测试中…" : "测试连接"}
              </button>
              <p className="vn-hint" style={{ marginTop: 8 }}>
                远程 ASR 不含说话人分离。
              </p>
            </>
          ) : cloudAsr && asr.provider === "volcengine" ? (
            <>
              <div className="vn-field">
                <label>版本</label>
                <select
                  className="vn-select"
                  value={asr.volcengine.mode}
                  disabled={asr.volcengine.modeLocked}
                  data-testid="settings-asr-volc-mode"
                  onChange={(e) =>
                    update({
                      asr: { volcengine: { mode: e.target.value as VolcengineMode } },
                    })
                  }
                >
                  {(Object.keys(VOLC_MODE_LABEL) as VolcengineMode[]).map((value) => (
                    <option key={value} value={value}>
                      {VOLC_MODE_LABEL[value]}
                    </option>
                  ))}
                </select>
                {asr.volcengine.modeLocked ? (
                  <span className="vn-hint">由环境变量控制</span>
                ) : null}
              </div>
              <div className="vn-field">
                <label>{volcModeInfo.queryEndpoint === undefined ? "端点" : "端点（提交 / 查询）"}</label>
                <span className="vn-read" data-testid="settings-asr-volc-endpoint">
                  {volcModeInfo.endpoint}
                </span>
                {volcModeInfo.queryEndpoint === undefined ? null : (
                  <span className="vn-read" data-testid="settings-asr-volc-query-endpoint">
                    {volcModeInfo.queryEndpoint}
                  </span>
                )}
              </div>
              <div className="vn-field">
                <label>Resource ID</label>
                <span className="vn-read" data-testid="settings-asr-volc-resource-id">
                  {volcModeInfo.resourceId}
                </span>
              </div>
              <div className="vn-field">
                <label>鉴权方式</label>
                <select
                  className="vn-select"
                  value={asr.volcengine.authMode}
                  disabled={asr.volcengine.authModeLocked}
                  data-testid="settings-asr-volc-auth"
                  onChange={(e) =>
                    update({
                      asr: {
                        volcengine: { authMode: e.target.value as VolcengineAuthMode },
                      },
                    })
                  }
                >
                  {(Object.keys(VOLC_AUTH_LABEL) as VolcengineAuthMode[]).map((value) => (
                    <option key={value} value={value}>
                      {VOLC_AUTH_LABEL[value]}
                    </option>
                  ))}
                </select>
                {asr.volcengine.authModeLocked ? (
                  <span className="vn-hint">由环境变量控制</span>
                ) : null}
              </div>
              {asr.volcengine.authMode === "apiKey" ? (
                <KeyField
                  label="API Key"
                  hasKey={asr.volcengine.apiKey.hasKey}
                  keySource={asr.volcengine.apiKey.keySource}
                  keyStorageAvailable={asr.volcengine.apiKey.keyStorageAvailable}
                  testId="settings-asr-volc-api-key"
                  onSave={saveSecret("volcApiKey", "API Key")}
                  onClear={clearSecret("volcApiKey", "API Key")}
                />
              ) : (
                <>
                  <KeyField
                    label="App Key"
                    hasKey={asr.volcengine.appKey.hasKey}
                    keySource={asr.volcengine.appKey.keySource}
                    keyStorageAvailable={asr.volcengine.appKey.keyStorageAvailable}
                    testId="settings-asr-volc-app-key"
                    onSave={saveSecret("volcAppKey", "App Key")}
                    onClear={clearSecret("volcAppKey", "App Key")}
                  />
                  <KeyField
                    label="Access Key"
                    hasKey={asr.volcengine.accessKey.hasKey}
                    keySource={asr.volcengine.accessKey.keySource}
                    keyStorageAvailable={asr.volcengine.accessKey.keyStorageAvailable}
                    testId="settings-asr-volc-access-key"
                    onSave={saveSecret("volcAccessKey", "Access Key")}
                    onClear={clearSecret("volcAccessKey", "Access Key")}
                  />
                </>
              )}
              {asr.volcengine.error !== null ? (
                <p className="vn-hint" data-testid="settings-asr-volc-error">
                  {asr.volcengine.error}
                </p>
              ) : null}
              <button
                type="button"
                data-testid="settings-test-asr"
                className="vn-btn sm"
                onClick={testAsr}
                disabled={testingAsr}
              >
                {testingAsr ? "测试中…" : "测试连接"}
              </button>
              {asr.volcengine.mode === "standard" ? (
                <p className="vn-hint" style={{ marginTop: 8 }} data-testid="settings-asr-volc-url-hint">
                  只接受公网 URL；本地视频请用极速版或本地 ASR。
                </p>
              ) : null}
              <p className="vn-hint" style={{ marginTop: 8 }} data-testid="settings-asr-volc-billing-hint">
                测试会发一次真实请求，可能计费。
              </p>
              <p className="vn-hint" style={{ marginTop: 8 }}>
                远程 ASR 不含说话人分离。
              </p>
            </>
          ) : (
            <>
              <div className="vn-field">
                <label>模型</label>
                <span className="vn-read">{asr.local.modelId}</span>
              </div>
              {localMissing.length > 0 ? (
                <p className="vn-hint">缺失文件：{localMissing.join("、")}</p>
              ) : null}
              {models !== null ? (
                <ModelPanel
                  status={models}
                  snapshot={snapshot}
                  busy={busyModel}
                  verifying={verifying}
                  onDownload={() => runModelAction(() => window.vnote.downloadModels())}
                  onCancel={() => runModelAction(() => window.vnote.cancelModelDownload())}
                  onImport={importModels}
                  onVerify={verify}
                />
              ) : (
                <p className="vn-hint" data-testid="models-loading">
                  加载模型状态中…
                </p>
              )}
              {modelsError !== null ? (
                <p className="vn-hint" data-testid="models-error">
                  加载模型状态失败：{modelsError}
                  <button type="button" className="vn-btn sm" style={{ marginLeft: 12 }} onClick={reloadModels}>
                    重试
                  </button>
                </p>
              ) : null}
              <p className="vn-hint" style={{ marginTop: 8 }}>
                网络不通时：从网盘/离线包下载模型 → 导入本地模型，或解压到模型目录。
              </p>
            </>
          )}
        </section>

        <section className="vn-card vn-pad" data-testid="settings-llm">
          <b>总结分析</b>
          <div className="vn-field" style={{ marginTop: 12 }}>
            <label>接口地址</label>
            <CommitInput
              value={llm.baseUrl ?? ""}
              locked={llm.locked.baseUrl}
              placeholder="https://api.example.com/v1"
              onCommit={(v) => update({ llm: { baseUrl: v } })}
              testId="settings-llm-base-url"
            />
            {llm.locked.baseUrl ? <span className="vn-hint">由环境变量控制</span> : null}
          </div>
          <div className="vn-field">
            <label>模型名</label>
            <CommitInput
              value={llm.model ?? ""}
              locked={llm.locked.model}
              placeholder="留空时自动发现"
              onCommit={(v) => update({ llm: { model: v } })}
              testId="settings-llm-model"
            />
            {llm.locked.model ? (
              <span className="vn-hint">由环境变量控制</span>
            ) : llm.model === null ? (
              <span className="vn-hint" data-testid="settings-llm-discovered">
                {llm.discoveredModel === null ? "留空时自动发现" : `已自动发现 ${llm.discoveredModel}`}
              </span>
            ) : null}
          </div>
          <KeyField
            label="API key"
            hasKey={llm.hasKey}
            keySource={llm.keySource}
            keyStorageAvailable={llm.keyStorageAvailable}
            testId="settings-llm-key"
            onSave={(key) =>
              window.vnote
                .updateLlm({ apiKey: key })
                .then(setStatus)
                .then(() => showToast("API key 已保存"))
            }
            onClear={() =>
              window.vnote
                .updateLlm({ clearApiKey: true })
                .then(setStatus)
                .then(() => showToast("API key 已清除"))
            }
          />
          <button
            type="button"
            data-testid="settings-test-llm"
            className="vn-btn sm"
            onClick={testLlm}
            disabled={testingLlm}
          >
            {testingLlm ? "测试中…" : "测试连接"}
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
