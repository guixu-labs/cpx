# cpx — 网关 · 流量捕获（Capture）

CANNBot-Sentry 的流量捕获网关包：旁路捕获编码 Agent 与 LLM API 提供商之间全量上下文的请求/响应，为观测（insight）与审计评测（sift）提供 verbatim 事实源。

- **旁路网关**：不改 Agent 工作流，请求/响应原样转发并留痕
- **密钥永不落盘**：在唯一落盘咽喉对敏感字段与各厂家 API Key 形态统一打码

**迁入来源**：[cannbot-skills](https://gitcode.com/cann/cannbot-skills) `plugins-community/cannbot-insight/proxy`（cpx 网关）。

**状态**：待迁入。包内代码、测试与使用文档将在迁移后提供。

安装（迁入后）：根目录 `./install.sh cpx` 或本目录 `./install.sh`。
