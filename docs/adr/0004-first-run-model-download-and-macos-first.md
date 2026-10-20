# 首发只支持 macOS Apple Silicon，模型首次启动下载

首个版本要让用户零配置跑起来，但模型体积和上游运行时的平台缺陷决定了首发边界。因此模型在首次启动时下载（可断点续传、可手动导入），平台先只承诺 macOS Apple Silicon。

## Status

已接受（accepted）。

## 决定

- **模型获取**（Q11）：首次启动时下载识别、说话人分离与标点模型；下载支持断点续传，落盘后校验 sha256；也允许用户手动放入模型目录，供离线或受限网络使用。
- **平台**（Q12）：先做 macOS Apple Silicon。Windows 在设计上保持兼容（`sherpa-onnx-node` 自带 win-x64 预编译 addon 与 `onnxruntime.dll`，安装层可用），但暂不验证、不承诺可用。
- **发布流程**：签名、公证等放到发布前再做，开发期不做。

## 后果

- 首次启动需要网络；受限网络下走手动导入，手动导入的目录同样要过 sha256 校验。
- Windows 有一条未关闭的上游风险：sherpa-onnx issue #3993（同一 int8 模型在 Windows x64 恒定 0 token，open）、sherpa issue #828（部分 Windows 机器空输出）。上 Windows 前必须真机用 10–20s 的 wav 跑通，不能凭安装成功就承诺可用。
- 开发期产物未签名，不能直接对外分发。
- 断点续传与校验意味着下载器要按文件记录进度与期望哈希，不能只依赖 HTTP 的完整性。
