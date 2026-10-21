import type { SettingsStatus } from "../../../shared/ipc";
import {
  badge,
  badgeNeutral,
  buttonSm,
  cx,
  frameTitle,
  optionText,
  panel,
  panelBody,
  panelHead,
  rowsRuled,
  secondaryButton,
  SettingsRow,
  text1,
  typeHeadingXs,
} from "../rbp/blocks/settings-form-1";
import { errMessage } from "../lib/format";
import { useEffect, useState } from "react";

// 设置状态面板：整屏浮层，只读展示，契约里没有 key，这里也不显示。
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

  const sectionTitle = (title: string, blurb: string) => (
    <div className="min-w-0">
      <h3 className={cx(frameTitle, text1)}>{title}</h3>
      <p className={cx(optionText, "mt-0.5")}>{blurb}</p>
    </div>
  );

  return (
    <div
      data-testid="settings-panel"
      className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain"
    >
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-neutral-950/50 dark:bg-neutral-950/70"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="relative flex h-[min(640px,90vh)] w-full max-w-2xl flex-col overflow-hidden rounded-[var(--rb-r-lg,10px)] border border-neutral-900/10 bg-white shadow-[0_24px_48px_-12px_rgb(0_0_0/0.5)] dark:border-neutral-100/14 dark:bg-neutral-950"
      >
        <div
          className={cx(
            panelHead,
            "shrink-0 border-b border-neutral-900/8 py-3 dark:border-neutral-100/8",
          )}
        >
          <h2 className={cx(typeHeadingXs, text1)}>设置</h2>
          <button
            type="button"
            data-testid="settings-close"
            onClick={onClose}
            aria-label="关闭"
            className={cx(secondaryButton, buttonSm, "shrink-0")}
          >
            返回
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error !== null && (
            <div
              className={cx(
                optionText,
                "rounded-[var(--rb-r-sm,6px)] border border-[oklch(60%_0.236_26)/40] bg-[oklch(60%_0.236_26)/10] px-3 py-2.5",
              )}
            >
              加载设置失败：{error}
            </div>
          )}
          {status === null && error === null && (
            <div
              className={cx(
                optionText,
                "rounded-[var(--rb-r-sm,6px)] border border-neutral-900/8 bg-neutral-50 px-3 py-2.5 dark:border-neutral-100/8 dark:bg-neutral-900",
              )}
            >
              加载设置中…
            </div>
          )}
          {status !== null && (
            <div className="flex flex-col gap-4">
              <section className={panel}>
                <div className={panelHead}>
                  {sectionTitle("模型", "模型配置与发现状态")}
                </div>
                <div className={cx(panelBody, rowsRuled)}>
                  <SettingsRow id="model-config" label="配置状态">
                    <span className={cx(badge, badgeNeutral)}>
                      {status.configured ? "已配置" : "未配置"}
                    </span>
                  </SettingsRow>
                  <SettingsRow id="model-name" label="模型">
                    <div className="flex flex-col gap-1.5">
                      <span
                        data-testid="settings-model"
                        className={cx(optionText, "truncate")}
                      >
                        {status.model ??
                          status.discoveredModel ??
                          "未发现"}
                      </span>
                      {status.model === null &&
                        status.discoveredModel !== null && (
                          <span className={cx(badge, badgeNeutral)}>
                            自动发现
                          </span>
                        )}
                      {status.modelError !== null && (
                        <p
                          className={cx(
                            optionText,
                            "mt-0.5 text-[oklch(60%_0.236_26)] dark:text-[oklch(65.2%_0.219_26)]",
                          )}
                        >
                          {status.modelError}
                        </p>
                      )}
                    </div>
                  </SettingsRow>
                </div>
              </section>

              <section className={panel}>
                <div className={panelHead}>
                  {sectionTitle("路径", "笔记与模型目录")}
                </div>
                <div className={cx(panelBody, rowsRuled)}>
                  <SettingsRow id="notes-root" label="笔记目录">
                    <span className={cx(optionText, "truncate")}>
                      {status.notesRoot}
                    </span>
                  </SettingsRow>
                  <SettingsRow id="model-dir" label="模型目录">
                    <span className={cx(optionText, "truncate")}>
                      {status.modelDir}
                    </span>
                  </SettingsRow>
                </div>
              </section>

              <section className={panel}>
                <div className={panelHead}>
                  {sectionTitle("环境", "运行时依赖")}
                </div>
                <div className={cx(panelBody, rowsRuled)}>
                  <SettingsRow id="ffmpeg" label="ffmpeg">
                    <span className={cx(badge, badgeNeutral)}>
                      {status.ffmpeg ? "可用" : "未找到"}
                    </span>
                  </SettingsRow>
                  {status.dotenvFiles.length > 0 && (
                    <SettingsRow id="dotenv-files" label="已加载的 dotenv 文件">
                      <ul className={cx(optionText, "flex flex-col gap-1")}>
                        {status.dotenvFiles.map((file) => (
                          <li key={file} className="truncate">
                            {file}
                          </li>
                        ))}
                      </ul>
                    </SettingsRow>
                  )}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
