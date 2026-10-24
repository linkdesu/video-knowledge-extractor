import type { ModelsCheck } from "../../../shared/ipc";
import { Button } from "../rbp/blocks/settings-form-3";

type PanelProps = {
  modelDir: string;
  check: ModelsCheck;
  checking: boolean;
  onVerify: () => void;
};

/** r37：本地模型目录展示 + 存在性检测（替代在线下载）。 */
export function ModelPanel({ modelDir, check, checking, onVerify }: PanelProps) {
  return (
    <div data-testid="model-panel">
      <div className="vn-models">
        <div className="vn-row vn-between">
          <span className="vn-meta" data-testid="model-dir-path">
            {modelDir}
          </span>
          <Button size="sm" data-testid="model-open-dir" onClick={() => window.vnote.reveal(modelDir)}>
            打开模型目录
          </Button>
        </div>
        {check.models.map((m) => (
          <div
            key={m.id}
            className="vn-row vn-between"
            style={{ marginTop: 8 }}
            data-testid={`model-required-${m.id}`}
          >
            <div>
              <div>{m.label}</div>
              <div className="vn-meta">{m.relativePaths.join(" / ")}</div>
              {m.missing.length > 0 ? (
                <div className="vn-meta" style={{ color: "#fda4af" }}>
                  缺失：{m.missing.join("、")}
                </div>
              ) : null}
            </div>
            <span className={`vn-tag ${m.ready ? "ok" : "err"}`}>{m.ready ? "就绪" : "缺失"}</span>
          </div>
        ))}
      </div>
      <Button type="button" data-testid="model-verify" disabled={checking} onClick={onVerify}>
        {checking ? "检测中..." : "检测本地模型"}
      </Button>
    </div>
  );
}
