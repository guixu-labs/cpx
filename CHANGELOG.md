# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [v0.1.1] - 2026-09-09

### Added
- 【npm registry 一键安装】发布到公共 npmjs（包名 `cannbot-proxy`，bin 命令 `cpx`——`cpx` 裸名已被社区占用），用户 `npm install -g cannbot-proxy` / `npx cannbot-proxy` 一条命令安装；仓内 `install.sh` 源码安装方式不变
  - 新增 `bin/cpx.mjs` npm bin 启动器：`node --import tsx` 起 `src/cli/cpx-cli.ts`（tsx 是本包 dependency，安装即落包内 node_modules；PATH 前置包内 `.bin`）。原 bin 指向 `.ts` 源文件在 npm 全局装后不可执行，本文件补齐该缺口
  - `package.json`：去 `private:true`（放行 publish）、补 `license` 与 `LICENSE` 文件（与 insight 同源 CANN OSL 2.0）、`files` 白名单（src/bin/docs/CHANGELOG），package-lock.json 不随包
  - 【版本单轨化】`package.json` version 与单一版本源 `src/version.ts` 对齐同值（0.1.1 起；后续升版本两处同步改）
  - IT：`tests/cpx-npm-pack.test.ts`——`npm pack --dry-run` 产物清单断言（bin 启动器/src 在包内，tests 排除）+ package.json 发布就绪（无 private、版本与单一源一致、bin→cpx）+ `bin/cpx.mjs` 经 node --import tsx 实跑 `--version` 冒烟

## [v0.1.0] - 2026-09-04

cpx 自 cannbot-insight/proxy 独立成包（`packages/cpx`，git mv 保留历史）后的首个独立版本。独立前的变更见 `../insight/CHANGELOG.md`（proxy 相关条目：v1.81 捕获自动刷新、v1.83 `x_cannbay` schema 契约、v2.06 subagent 声明恢复等）。

### Added
- 【版本号体系】三段式 `0.1.0`，单一版本源 `src/version.ts`（与 cannbot-insight 的 `src/lib/version.ts` 同构；`package.json` version 不作展示版本；升版本策略：新增特性或修复严重 bug +0.0.1，小修小补不升）
  - `cpx --version | -v`：输出 `cpx v<版本> (<包路径>)` —— 多仓共存 / symlink 单指针切换时一条命令确认当前生效副本（替代 `readlink -f $(which cpx)`）
  - 启动横幅首行 `[cpx-cli] cpx v<版本> (<包路径>)`；`--help` 标题动态带版本号，与 `--version` 同源不漂移
  - README 命令参考补 `--version` 行
  - IT：`tests/cpx-version.test.ts` 3 用例（双 flag 输出、版本与单一源一致、help 标题同版本）
- 注：`cc-session-meta.ccVersion` 是 agent 侧（Claude Code）版本，与 cpx 包版本分属两个概念；捕获格式本身本次未动（受 `docs/cannbay-schema-spec.md` 契约约束）
