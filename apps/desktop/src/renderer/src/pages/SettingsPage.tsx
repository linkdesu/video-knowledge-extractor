import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AsrProvider,
  AsrSecretField,
  DirectoryKind,
  DownloadSnapshot,
  ModelLogEntry,
  ModelDownloadEvent,
  ModelsStatus,
  SettingsStatus,
  VolcengineAuthMode,
  VolcengineMode,
} from "../../../shared/ipc";
import { ModelPanel } from "../components/ModelPanel";
import { errMessage, fmtBytes } from "../lib/format";
import {
  draftFrom,
  llmDirty,
  llmPatch,
  modelOptions,
  type LlmFormDraft,
  type LlmSaved,
} from "../lib/llm-draft";
import { showToast } from "../lib/toast";
import { VOLC_MODE_INFO } from "../../../shared/volc";
import {
  Button,
  Combobox,
  PasswordInput,
  Select,
  SettingsField,
  SettingsPanel,
  TextInput,
} from "../rbp/blocks/settings-form-3";

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

type KeyState = { draft: string; saving: boolean; clearing: boolean };

const EMPTY_KEY: KeyState = { draft: "", saving: false, clearing: false };

const KEY_FIELDS = [
  "openaiKey",
  "volcApiKey",
  "volcAppKey",
  "volcAccessKey",
] as const;

type KeyFieldId = (typeof KEY_FIELDS)[number];

export function SettingsPage() {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testingLlm, setTestingLlm] = useState(false);
  const [testingAsr, setTestingAsr] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [models, setModels] = useState<ModelsStatus | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [downloadLog, setDownloadLog] = useState<ModelLogEntry[]>([]);
  const [importing, setImporting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [snapshot, setSnapshot] = useState<DownloadSnapshot | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
  const [modelsFetchError, setModelsFetchError] = useState<string | null>(null);
  const [diagnosticsChars, setDiagnosticsChars] = useState<number | null>(null);
  const [pathDrafts, setPathDrafts] = useState<
    Record<"notesRoot" | "cacheRoot" | "modelDir", string>
  >({ notesRoot: "", cacheRoot: "", modelDir: "" });
  const [keys, setKeys] = useState<Record<KeyFieldId, KeyState>>({
    openaiKey: EMPTY_KEY,
    volcApiKey: EMPTY_KEY,
    volcAppKey: EMPTY_KEY,
    volcAccessKey: EMPTY_KEY,
  });
  const reloadTimers = useRef<number[]>([]);
  const fetchGeneration = useRef(0);
  const [llmCard, setLlmCard] = useState<{
    draft: LlmFormDraft;
    saving: boolean;
    saveError: string | null;
  } | null>(null);
  const [clearingLlmKey, setClearingLlmKey] = useState(false);
  const draftBaseUrl = llmCard !== null ? llmCard.draft.baseUrl.trim() : null;
  const prevDraftBaseUrl = useRef<string | null>(null);
  useEffect(() => {
    if (prevDraftBaseUrl.current !== null && prevDraftBaseUrl.current !== draftBaseUrl) {
      setFetchedModels(null);
      // baseUrl 变了：在途的 listLlmModels 是旧端点的响应，丢弃。
      fetchGeneration.current += 1;
    }
    prevDraftBaseUrl.current = draftBaseUrl;
  }, [draftBaseUrl]);

  const [asrText, setAsrText] = useState<{ baseUrl: string; model: string } | null>(null);

  const llmInited = useRef(false);
  useEffect(() => {
    if (status === null) return;
    if (!llmInited.current) {
      llmInited.current = true;
      const saved: LlmSaved = {
        baseUrl: status.llm.baseUrl ?? "",
        model: status.llm.model,
        apiKey: status.llm.apiKey,
      };
      setLlmCard({ draft: draftFrom(saved), saving: false, saveError: null });
    }
  }, [status]);
  // 服务端值变了才重置本地编辑：值没变（如只保存 LLM）就不打断输入。
  const prevPath = useRef<{ notesRoot: string; cacheRoot: string; modelDir: string } | null>(null);
  useEffect(() => {
    if (status === null) return;
    const prev = prevPath.current;
    if (prev === null) {
      prevPath.current = { notesRoot: status.notesRoot, cacheRoot: status.cacheRoot, modelDir: status.modelDir };
      setPathDrafts({ notesRoot: status.notesRoot, cacheRoot: status.cacheRoot, modelDir: status.modelDir });
      return;
    }
    if (
      prev.notesRoot !== status.notesRoot ||
      prev.cacheRoot !== status.cacheRoot ||
      prev.modelDir !== status.modelDir
    ) {
      prevPath.current = { notesRoot: status.notesRoot, cacheRoot: status.cacheRoot, modelDir: status.modelDir };
      setPathDrafts({ notesRoot: status.notesRoot, cacheRoot: status.cacheRoot, modelDir: status.modelDir });
    }
  }, [status]);
  const prevAsrText = useRef<{ baseUrl: string; model: string } | null>(null);
  useEffect(() => {
    if (status === null) return;
    const prev = prevAsrText.current;
    const next = { baseUrl: status.asr.openai.baseUrl, model: status.asr.openai.model };
    if (prev === null || prev.baseUrl !== next.baseUrl || prev.model !== next.model) {
      prevAsrText.current = next;
      setAsrText(next);
    }
  }, [status]);
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
    const off = window.vnote.onModelDownload((event: ModelDownloadEvent) => {
      setSnapshot(event.snapshot);
      setDownloadLog(event.log);
      if (event.snapshot.state === "failed" || event.snapshot.state === "cancelled") {
        setStarted(false);
      }
      reloadModels();
    });
    return off;
  }, []);
  useEffect(() => {
    if (models !== null && models.ready) setStarted(false);
  }, [models]);

  const fetchLlmModels = () => {
    if (llmCard === null) return;
    setFetchingModels(true);
    setModelsFetchError(null);
    fetchGeneration.current += 1;
    const gen = fetchGeneration.current;
    window.vnote
      .listLlmModels({
        baseUrl: llmCard.draft.baseUrl.trim(),
        apiKey: llmCard.draft.apiKey.trim(),
      })
      .then((r) => {
        if (gen !== fetchGeneration.current) return;
        if (r.ok) {
          setFetchedModels(r.models);
        } else {
          setModelsFetchError(r.message);
        }
      })
      .catch((err) => {
        if (gen === fetchGeneration.current) setModelsFetchError(errMessage(err));
      })
      .finally(() => {
        // 只有一次在途请求（按钮在 fetching 时禁用），所以无条件复位；否则被丢弃的那次会把按钮永久卡在「拉取中」。
        setFetchingModels(false);
      });
  };

  const saveLlm = () => {
    if (status === null || llmCard === null || llmCard.saving) return;
    const saved: LlmSaved = {
      baseUrl: status.llm.baseUrl ?? "",
      model: status.llm.model,
      apiKey: status.llm.apiKey,
    };
    const patch = llmPatch(saved, llmCard.draft);
    if (patch === null) return;
    const atSave = { ...llmCard.draft };
    setLlmCard({ ...llmCard, saving: true, saveError: null });
    window.vnote
      .updateLlm(patch)
      .then((next) => {
        showToast("已保存");
        setLlmCard((cur) => {
          if (cur === null) return null;
          // 保存期间用户又改了：保留草稿，不回填服务端值。
          const untouched =
            cur.draft.baseUrl === atSave.baseUrl &&
            cur.draft.model === atSave.model &&
            cur.draft.apiKey === atSave.apiKey;
          return {
            draft: untouched
              ? draftFrom({
                  baseUrl: next.llm.baseUrl ?? "",
                  model: next.llm.model,
                  apiKey: next.llm.apiKey,
                })
              : cur.draft,
            saving: false,
            saveError: null,
          };
        });
        setStatus(next);
      })
      .catch((err) => {
        setLlmCard((cur) => (cur !== null ? { ...cur, saving: false, saveError: errMessage(err) } : cur));
      });
  };

  const setKey = (id: KeyFieldId, patch: Partial<KeyState>) =>
    setKeys((k) => ({ ...k, [id]: { ...k[id], ...patch } }));

  // 显式清空已存 key：留空再保存仍是「保持原 key」，这里才是唯一删除入口。
  const clearLlmKey = () => {
    if (llmCard === null || clearingLlmKey) return;
    setClearingLlmKey(true);
    const draftAtStart = llmCard.draft.apiKey;
    window.vnote
      .updateLlm({ clearApiKey: true })
      .then((next) => {
        showToast("API key 已清空");
        // 只在草稿仍等于点击时的快照时清空输入框；等待期间用户又输入过就不动。
        setLlmCard((cur) =>
          cur !== null && cur.draft.apiKey === draftAtStart
            ? { ...cur, draft: { ...cur.draft, apiKey: "" } }
            : cur,
        );
        setStatus(next);
      })
      .catch((err) => showToast(`清空失败：${errMessage(err)}`))
      .finally(() => setClearingLlmKey(false));
  };

  const saveAsrSecret = (field: AsrSecretField, label: string, id: KeyFieldId) => {
    const key = keys[id].draft.trim();
    if (key === "") return;
    setKey(id, { saving: true });
    window.vnote
      .updateAsr({ secret: { field, value: key } })
      .then(setStatus)
      .then(() => showToast(`${label} 已保存`))
      .catch((err) => showToast(`保存失败：${errMessage(err)}`))
      .finally(() => setKey(id, { saving: false }));
  };

  const clearAsrSecret = (field: AsrSecretField, label: string, id: KeyFieldId) => {
    setKey(id, { clearing: true });
    const draftAtStart = keys[id].draft;
    window.vnote
      .updateAsr({ secret: { field, clear: true } })
      .then(setStatus)
      .then(() => {
        showToast(`${label} 已清除`);
        // 只在草稿仍等于清除时的快照时清空，失败或用户又输入过都不动。
        setKeys((k) =>
          k[id].draft === draftAtStart ? { ...k, [id]: { ...k[id], draft: "" } } : k,
        );
      })
      .catch((err) => showToast(`清除失败：${errMessage(err)}`))
      .finally(() => setKey(id, { clearing: false }));
  };

  const testLlm = () => {
    if (llmCard === null) return;
    setTestingLlm(true);
    window.vnote
      .testLlm({
        baseUrl: llmCard.draft.baseUrl.trim(),
        apiKey: llmCard.draft.apiKey.trim(),
      })
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

  // 打开日志文件夹（r34）：失败给可读 toast
  const openLogs = () => {
    window.vnote
      .openLogs()
      .catch((err) => showToast(`打开日志文件夹失败：${errMessage(err)}`));
  };

  // 复制诊断信息（r34）：成功显示字符数；失败 toast
  const copyDiagnostics = () => {
    window.vnote
      .copyDiagnostics()
      .then((r) => {
        setDiagnosticsChars(r.chars);
      })
      .catch((err) => showToast(`复制诊断信息失败：${errMessage(err)}`));
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
        <Button size="sm" style={{ marginLeft: 12 }} onClick={reload}>
          重试
        </Button>
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
  const busyModel = started || importing || verifying;
  const localMissing =
    models !== null
      ? models.bundles.filter((b) => b.state !== "ready").map((b) => b.title)
      : asr.local.missing;

  const llmSaved: LlmSaved = { baseUrl: llm.baseUrl ?? "", model: llm.model, apiKey: llm.apiKey };
  const llmDirtyNow = llmCard !== null && llmDirty(llmSaved, llmCard.draft);
  // 保存整表单需要凭证事务：只有「要写新 key」且密钥库不可用时才禁用。
  const keyChanged =
    llmCard !== null &&
    llmCard.draft.apiKey.trim() !== "" &&
    llmCard.draft.apiKey.trim() !== (llm.apiKey ?? "");
  const llmSaveBlocked =
    llmCard === null || llmCard.saving || !llmDirtyNow || (keyChanged && !llm.keyStorageAvailable);

  const pickDir = (field: PathField) => {
    window.vnote
      .pickDirectory(FIELD_KIND[field])
      .then((dir) => {
        if (dir !== null) {
          setPathDrafts((d) => ({ ...d, [field]: dir }));
          window.vnote
            .updateSettings({ [field]: dir })
            .then(setStatus)
            .catch((err) => showToast(`保存失败：${errMessage(err)}`));
        }
      })
      .catch((err) => showToast(`选择目录失败：${errMessage(err)}`));
  };
  const commitAsrText = (field: "baseUrl" | "model", locked: boolean) => {
    if (locked || asrText === null) return;
    const v = asrText[field];
    if (v !== (field === "baseUrl" ? asr.openai.baseUrl : asr.openai.model)) {
      window.vnote
        .updateSettings({ asr: { openai: { [field]: v } } })
        .then(setStatus)
        .catch((err) => showToast(`保存失败：${errMessage(err)}`));
    }
  };

  return (
    <>
      <h1 className="vn-h1">设置</h1>
      <p className="vn-sub">模型、存储与缓存。API key 存在系统密钥库，输入框可编辑替换。</p>

      <div className="vn-grid vn-cards2" data-testid="settings-page">
        <SettingsPanel title="语音转写" testId="settings-asr">
          <SettingsField label="提供方" locked={asr.providerLocked} htmlFor="settings-asr-provider">
            {cloudAsr ? (
              <Select
                id="settings-asr-provider"
                value={asr.provider}
                disabled={asr.providerLocked}
                testId="settings-asr-provider"
                ariaLabel="提供方"
                options={(Object.keys(PROVIDER_LABEL) as AsrProvider[]).map((value) => ({
                  value,
                  label: PROVIDER_LABEL[value],
                }))}
                onChange={(v) =>
                  window.vnote
                    .updateSettings({ asr: { provider: v as AsrProvider } })
                    .then(setStatus)
                    .catch((err) => showToast(`保存失败：${errMessage(err)}`))
                }
              />
            ) : (
              <span className="vn-read" data-testid="settings-asr-provider-fixed">
                {PROVIDER_LABEL.local}
              </span>
            )}
          </SettingsField>
          {cloudAsr && asr.provider === "openai" ? (
            <>
              <SettingsField label="接口地址" locked={asr.openai.locked.baseUrl} htmlFor="settings-asr-base-url">
                <TextInput
                  id="settings-asr-base-url"
                  value={asrText?.baseUrl ?? asr.openai.baseUrl}
                  placeholder="https://api.example.com/v1"
                  readOnly={asr.openai.locked.baseUrl}
                  aria-label="接口地址"
                  data-testid="settings-asr-base-url"
                  onChange={(e) => setAsrText((t) => ({ baseUrl: e.target.value, model: t?.model ?? asr.openai.model }))}
                  onBlur={() => commitAsrText("baseUrl", asr.openai.locked.baseUrl)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
              </SettingsField>
              <SettingsField label="模型名" locked={asr.openai.locked.model} htmlFor="settings-asr-model">
                <TextInput
                  id="settings-asr-model"
                  value={asrText?.model ?? asr.openai.model}
                  readOnly={asr.openai.locked.model}
                  aria-label="模型名"
                  data-testid="settings-asr-model"
                  onChange={(e) => setAsrText((t) => ({ baseUrl: t?.baseUrl ?? asr.openai.baseUrl, model: e.target.value }))}
                  onBlur={() => commitAsrText("model", asr.openai.locked.model)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
              </SettingsField>
              <KeyRow
                label="API key"
                state={keys.openaiKey}
                hasKey={asr.openai.hasKey}
                keySource={asr.openai.keySource}
                keyStorageAvailable={asr.openai.keyStorageAvailable}
                testId="settings-asr-key"
                onDraft={(v) => setKey("openaiKey", { draft: v })}
                onSave={() => saveAsrSecret("openaiKey", "API key", "openaiKey")}
                onClear={() => clearAsrSecret("openaiKey", "API key", "openaiKey")}
              />
              {asr.openai.error !== null ? (
                <p className="vn-hint" data-testid="settings-asr-error">
                  {asr.openai.error}
                </p>
              ) : null}
              <Button
                size="sm"
                data-testid="settings-test-asr"
                onClick={testAsr}
                disabled={testingAsr}
              >
                {testingAsr ? "测试中…" : "测试连接"}
              </Button>
              <p className="vn-hint" style={{ marginTop: 8 }}>
                远程 ASR 不含说话人分离。
              </p>
            </>
          ) : cloudAsr && asr.provider === "volcengine" ? (
            <>
              <SettingsField label="版本" locked={asr.volcengine.modeLocked} htmlFor="settings-asr-volc-mode">
                <Select
                  id="settings-asr-volc-mode"
                  value={asr.volcengine.mode}
                  disabled={asr.volcengine.modeLocked}
                  testId="settings-asr-volc-mode"
                  ariaLabel="版本"
                  options={(Object.keys(VOLC_MODE_LABEL) as VolcengineMode[]).map((value) => ({
                    value,
                    label: VOLC_MODE_LABEL[value],
                  }))}
                  onChange={(v) =>
                    window.vnote
                      .updateSettings({ asr: { volcengine: { mode: v as VolcengineMode } } })
                      .then(setStatus)
                      .catch((err) => showToast(`保存失败：${errMessage(err)}`))
                  }
                />
              </SettingsField>
              <SettingsField
                label={volcModeInfo.queryEndpoint === undefined ? "端点" : "端点（提交 / 查询）"}
              >
                <span className="vn-read" data-testid="settings-asr-volc-endpoint">
                  {volcModeInfo.endpoint}
                </span>
                {volcModeInfo.queryEndpoint === undefined ? null : (
                  <span className="vn-read" data-testid="settings-asr-volc-query-endpoint">
                    {volcModeInfo.queryEndpoint}
                  </span>
                )}
              </SettingsField>
              <SettingsField label="Resource ID">
                <span className="vn-read" data-testid="settings-asr-volc-resource-id">
                  {volcModeInfo.resourceId}
                </span>
              </SettingsField>
              <SettingsField label="鉴权方式" locked={asr.volcengine.authModeLocked} htmlFor="settings-asr-volc-auth">
                <Select
                  id="settings-asr-volc-auth"
                  value={asr.volcengine.authMode}
                  disabled={asr.volcengine.authModeLocked}
                  testId="settings-asr-volc-auth"
                  ariaLabel="鉴权方式"
                  options={(Object.keys(VOLC_AUTH_LABEL) as VolcengineAuthMode[]).map((value) => ({
                    value,
                    label: VOLC_AUTH_LABEL[value],
                  }))}
                  onChange={(v) =>
                    window.vnote
                      .updateSettings({
                        asr: { volcengine: { authMode: v as VolcengineAuthMode } },
                      })
                      .then(setStatus)
                      .catch((err) => showToast(`保存失败：${errMessage(err)}`))
                  }
                />
              </SettingsField>
              {asr.volcengine.authMode === "apiKey" ? (
                <KeyRow
                  label="API Key"
                  state={keys.volcApiKey}
                  hasKey={asr.volcengine.apiKey.hasKey}
                  keySource={asr.volcengine.apiKey.keySource}
                  keyStorageAvailable={asr.volcengine.apiKey.keyStorageAvailable}
                  testId="settings-asr-volc-api-key"
                  onDraft={(v) => setKey("volcApiKey", { draft: v })}
                  onSave={() => saveAsrSecret("volcApiKey", "API Key", "volcApiKey")}
                  onClear={() => clearAsrSecret("volcApiKey", "API Key", "volcApiKey")}
                />
              ) : (
                <>
                  <KeyRow
                    label="App Key"
                    state={keys.volcAppKey}
                    hasKey={asr.volcengine.appKey.hasKey}
                    keySource={asr.volcengine.appKey.keySource}
                    keyStorageAvailable={asr.volcengine.appKey.keyStorageAvailable}
                    testId="settings-asr-volc-app-key"
                    onDraft={(v) => setKey("volcAppKey", { draft: v })}
                    onSave={() => saveAsrSecret("volcAppKey", "App Key", "volcAppKey")}
                    onClear={() => clearAsrSecret("volcAppKey", "App Key", "volcAppKey")}
                  />
                  <KeyRow
                    label="Access Key"
                    state={keys.volcAccessKey}
                    hasKey={asr.volcengine.accessKey.hasKey}
                    keySource={asr.volcengine.accessKey.keySource}
                    keyStorageAvailable={asr.volcengine.accessKey.keyStorageAvailable}
                    testId="settings-asr-volc-access-key"
                    onDraft={(v) => setKey("volcAccessKey", { draft: v })}
                    onSave={() => saveAsrSecret("volcAccessKey", "Access Key", "volcAccessKey")}
                    onClear={() => clearAsrSecret("volcAccessKey", "Access Key", "volcAccessKey")}
                  />
                </>
              )}
              {asr.volcengine.error !== null ? (
                <p className="vn-hint" data-testid="settings-asr-volc-error">
                  {asr.volcengine.error}
                </p>
              ) : null}
              <Button
                size="sm"
                data-testid="settings-test-asr"
                onClick={testAsr}
                disabled={testingAsr}
              >
                {testingAsr ? "测试中…" : "测试连接"}
              </Button>
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
              <SettingsField label="模型">
                <span className="vn-read">{asr.local.modelId}</span>
              </SettingsField>
              {localMissing.length > 0 ? (
                <p className="vn-hint">缺失文件：{localMissing.join("、")}</p>
              ) : null}
              {models !== null ? (
                <ModelPanel
                  status={models}
                  snapshot={snapshot}
                  started={started}
                  log={downloadLog}
                  busy={busyModel}
                  verifying={verifying}
                  onDownload={() => {
                    setStarted(true);
                    setDownloadLog([]);
                    runModelAction(() => window.vnote.downloadModels());
                  }}
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
                  <Button
                    size="sm"
                    style={{ marginLeft: 12 }}
                    onClick={reloadModels}
                  >
                    重试
                  </Button>
                </p>
              ) : null}
              <p className="vn-hint" style={{ marginTop: 8 }}>
                网络不通时：从网盘/离线包下载模型 → 导入本地模型，或解压到模型目录。
              </p>
            </>
          )}
        </SettingsPanel>
        <SettingsPanel title="总结分析" testId="settings-llm">
          <SettingsField label="接口地址" htmlFor="settings-llm-base-url">
            <TextInput
              id="settings-llm-base-url"
              value={llmCard?.draft.baseUrl ?? ""}
              placeholder="https://api.example.com/v1"
              aria-label="接口地址"
              data-testid="settings-llm-base-url"
              onChange={(e) =>
                setLlmCard((c) => (c !== null ? { ...c, draft: { ...c.draft, baseUrl: e.target.value } } : c))
              }
            />
          </SettingsField>
          <SettingsField label="API key" htmlFor="settings-llm-key-input">
            <div className="vn-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <PasswordInput
                  value={llmCard?.draft.apiKey ?? ""}
                  onChange={(v) =>
                    setLlmCard((c) => (c !== null ? { ...c, draft: { ...c.draft, apiKey: v } } : c))
                  }
                  id="settings-llm-key-input"
                  testId="settings-llm-key"
                  ariaLabel="API key"
                  readOnly={!llm.keyStorageAvailable}
                  placeholder="输入 API key"
                />
              </div>
              {llm.hasKey || (llmCard?.draft.apiKey.trim() ?? "") !== "" ? (
                <Button
                  size="sm"
                  data-testid="settings-llm-key-clear"
                  disabled={clearingLlmKey}
                  onClick={clearLlmKey}
                >
                  {clearingLlmKey ? "清空中…" : "清空"}
                </Button>
              ) : null}
            </div>
            {!llm.keyStorageAvailable ? (
              <span className="vn-hint" data-testid="settings-llm-key-no-storage">
                系统密钥存储不可用，无法保存新的 key
              </span>
            ) : llm.keySource === "env" ? (
              <span className="vn-hint" data-testid="settings-llm-key-env">
                当前 key 来自 dev 模式 .env 种子；保存后以这里为准
              </span>
            ) : llm.hasKey ? (
              <span className="vn-hint" data-testid="settings-llm-key-saved">
                已保存 key，掩码显示；点眼睛看明文，直接编辑即可替换
              </span>
            ) : (
              <span className="vn-hint" data-testid="settings-llm-key-none">
                尚未保存 key；可在此输入并随表单一起保存
              </span>
            )}
          </SettingsField>
          <SettingsField label="模型名" htmlFor="settings-llm-model">
            <Combobox
              id="settings-llm-model"
              value={llmCard?.draft.model ?? ""}
              onChange={(v) =>
                setLlmCard((c) => (c !== null ? { ...c, draft: { ...c.draft, model: v } } : c))
              }
              options={modelOptions(fetchedModels)}
              placeholder="留空时自动发现"
              testId="settings-llm-model"
              ariaLabel="模型名"
            />
            <div className="vn-row" style={{ marginTop: 8 }}>
              <Button
                size="sm"
                data-testid="settings-llm-fetch-models"
                disabled={fetchingModels || (llmCard?.draft.baseUrl.trim() ?? "") === ""}
                onClick={fetchLlmModels}
              >
                {fetchingModels ? "拉取中…" : "拉取模型"}
              </Button>
              <Button
                size="sm"
                data-testid="settings-test-llm"
                onClick={testLlm}
                disabled={testingLlm}
              >
                {testingLlm ? "测试中…" : "测试连接"}
              </Button>
            </div>
            {modelsFetchError !== null ? (
              <p className="vn-hint" data-testid="settings-llm-models-error">
                {modelsFetchError}
              </p>
            ) : null}
            {llm.model === null ? (
              <span className="vn-hint" data-testid="settings-llm-discovered">
                {llm.discoveredModel === null ? "留空时自动发现" : `已自动发现 ${llm.discoveredModel}`}
              </span>
            ) : null}
          </SettingsField>
          <Button
            variant="primary"
            size="sm"
            data-testid="settings-llm-save"
            disabled={llmSaveBlocked}
            onClick={saveLlm}
          >
            {llmCard?.saving ? "保存中…" : "保存"}
          </Button>
          {llmCard !== null && llmCard.saveError !== null ? (
            <p className="vn-hint" data-testid="settings-llm-save-error">
              {llmCard.saveError}
            </p>
          ) : null}
        </SettingsPanel>


        <SettingsPanel title="存储" testId="settings-storage">
          <div style={{ marginTop: 12 }}>
            {(Object.keys(FIELD_LABEL) as PathField[]).map((field) => {
              const locked = status.locked[field];
              return (
                <div className="vn-field" key={field} data-testid={`settings-path-${field}`}>
                  <label>{FIELD_LABEL[field]}</label>
                  <div className="vn-row">
                    <TextInput
                      value={pathDrafts[field]}
                      onChange={(e) => setPathDrafts((d) => ({ ...d, [field]: e.target.value }))}
                      onBlur={() => {
                        const v = pathDrafts[field].trim();
                        if (!locked && v !== "" && v !== status[field]) {
                          window.vnote
                            .updateSettings({ [field]: v })
                            .then(setStatus)
                            .catch((err) => showToast(`保存失败：${errMessage(err)}`));
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      readOnly={locked}
                      aria-label={FIELD_LABEL[field]}
                      data-testid={`settings-path-input-${field}`}
                      style={{ flex: 1 }}
                    />
                    <Button
                      size="sm"
                      data-testid={`settings-pick-${field}`}
                      disabled={locked}
                      onClick={() => pickDir(field)}
                    >
                      选择…
                    </Button>
                  </div>
                  {locked ? (
                    <span className="vn-hint" data-testid={`settings-path-locked-${field}`}>
                      由环境变量控制
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="vn-row vn-between">
            <span className="vn-hint">缓存占用 {fmtBytes(status.cacheBytes)}</span>
            <Button
              size="sm"
              data-testid="settings-clear-cache"
              onClick={clearCache}
              disabled={clearing}
            >
              {clearing ? "清理中…" : "清理缓存"}
            </Button>
          </div>
        </SettingsPanel>

        <SettingsPanel title="日志与诊断" testId="settings-logs">
          <SettingsField label="日志目录">
            <span className="vn-read" data-testid="settings-logs-dir">{status.logDir}</span>
          </SettingsField>
          <p className="vn-hint">
            诊断信息包含最近任务的日志与运行环境信息，可直接粘贴给排查问题的同事。
          </p>
          <div className="vn-row">
            <Button size="sm" data-testid="settings-logs-open" onClick={openLogs}>
              打开日志文件夹
            </Button>
            <Button size="sm" data-testid="settings-diagnostics-copy" onClick={copyDiagnostics}>
              复制诊断信息
            </Button>
            {diagnosticsChars !== null ? (
              <span className="vn-hint" data-testid="settings-diagnostics-status">
                已复制 {diagnosticsChars} 字符
              </span>
            ) : null}
          </div>
        </SettingsPanel>
        <SettingsPanel title="关于" testId="settings-about">
          <div className="vn-meta" style={{ marginTop: 12, flexDirection: "column", gap: 6 }}>
            <span>VideoNotes {status.appVersion}</span>
            <span>ffmpeg {status.ffmpegVersion ?? "未安装"}</span>
          </div>
        </SettingsPanel>
      </div>
    </>
  );
}

function KeyRow({
  label,
  state,
  hasKey,
  keySource,
  keyStorageAvailable,
  testId,
  onDraft,
  onSave,
  onClear,
}: {
  label: string;
  state: KeyState;
  hasKey: boolean;
  keySource: "env" | "stored" | "none";
  keyStorageAvailable: boolean;
  testId: string;
  onDraft: (v: string) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  return (
    <div className="vn-field" data-testid={`${testId}-field`}>
      <label htmlFor={`${testId}-input`}>{label}</label>
      <div className="vn-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <PasswordInput
            value={state.draft}
            onChange={onDraft}
            id={`${testId}-input`}
            onEnter={onSave}
            readOnly={!keyStorageAvailable}
            placeholder={hasKey ? "粘贴新 key 覆盖" : "输入 key"}
            ariaLabel={label}
            testId={testId}
          />
        </div>
        {keyStorageAvailable ? (
          <Button
            size="sm"
            data-testid={`${testId}-save`}
            disabled={state.saving || state.draft.trim() === ""}
            onClick={onSave}
          >
            {state.saving ? "保存中…" : "保存"}
          </Button>
        ) : null}
        {hasKey && keyStorageAvailable ? (
          <Button
            size="sm"
            data-testid={`${testId}-clear`}
            disabled={state.clearing}
            onClick={onClear}
          >
            {state.clearing ? "清除中…" : "清除"}
          </Button>
        ) : null}
      </div>
      {keySource === "env" ? (
        <span className="vn-hint" data-testid={`${testId}-env`}>
          当前使用环境变量中的 key，这里保存的 key 在环境变量移除后生效
        </span>
      ) : hasKey ? (
        <span className="vn-hint" data-testid={`${testId}-saved`}>
          已保存（系统密钥库），可粘贴新 key 覆盖
        </span>
      ) : null}
      {keyStorageAvailable ? null : (
        <span className="vn-hint" data-testid={`${testId}-no-storage`}>
          系统密钥存储不可用，请用环境变量配置密钥
        </span>
      )}
    </div>
  );
}
