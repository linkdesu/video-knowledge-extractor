# video-notes

- 给 Link 的报告：tmp/report/（中文）；agent 交接：tmp/handoff/。
- bun 优先。omp 不使用 ask 工具。TASK 并发 ≤ 6。

## 模型与评审

- agent → 模型映射固定在 `.omp/config.yml`；改映射只改这里，不碰 `~/.omp/agent/config.yml`。
- 评审与判分必须同时包含两个模型，各至少一个：`sol-reviewer`（`openai-codex/gpt-6.1-sol`）与 `k3-reviewer`（`kimi-code/k3`）。interrogate 派这两个评审；arena cross-judge 派两个只读 judge（两模型各一），评分分歧处记为缺口。
- `scout` / `sonic` 跑 `mimo-v2.6-flash`，只做调研与轻量档，禁止担任 reviewer 或 judge。

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage labels at default names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
