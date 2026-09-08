# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [v0.1.0] - 2026-09-04

cpx 自 cannbot-insight/proxy 独立成包（`packages/cpx`，git mv 保留历史）后的首个独立版本。独立前的变更见 `../insight/CHANGELOG.md`（proxy 相关条目：v1.81 捕获自动刷新、v1.83 `x_cannbay` schema 契约、v2.06 subagent 声明恢复等）。

### Added
- 【版本号体系】三段式 `0.1.0`，单一版本源 `src/version.ts`（与 cannbot-insight 的 `src/lib/version.ts` 同构；`package.json` version 不作展示版本；升版本策略：新增特性或修复严重 bug +0.0.1，小修小补不升）
  - `cpx --version | -v`：输出 `cpx v<版本> (<包路径>)` —— 多仓共存 / symlink 单指针切换时一条命令确认当前生效副本（替代 `readlink -f $(which cpx)`）
  - 启动横幅首行 `[cpx-cli] cpx v<版本> (<包路径>)`；`--help` 标题动态带版本号，与 `--version` 同源不漂移
  - README 命令参考补 `--version` 行
  - IT：`tests/cpx-version.test.ts` 3 用例（双 flag 输出、版本与单一源一致、help 标题同版本）
- 注：`cc-session-meta.ccVersion` 是 agent 侧（Claude Code）版本，与 cpx 包版本分属两个概念；捕获格式本身本次未动（受 `docs/cannbay-schema-spec.md` 契约约束）
