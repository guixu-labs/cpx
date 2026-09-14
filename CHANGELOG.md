# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [Unreleased]

### Added
- 【工作流自动上传——agent 编排场景收尾闭环】用户零参数起会话（`cpx claude --autoupload`），工作流末尾加标准收尾片段，任务完成时 agent 自行执行 `cpx upload` 完成上传，信息各归其位：提交人=机器 `git config user.name`（**非交互路径同样自动兜底**，此前仅向导有默认值）、描述=agent 自述（`--desc`）、成败=agent 自报（`--opgen`）、范式目录=模板写死或白名单自选。配套三件机制：
  - **会话工牌**：cpx 启动 agent 时注入 `CPX_SESSION_ID` env 并沿进程树自动继承，agent 裸跑 `cpx upload` 精确命中本会话（并发机器不传错别人的）；claude 等按真实 sid 落盘的框架经 `.sids` 清单自动换算，定位链 = 显式 sid > env 工牌 > mtime 最新
  - **上传记忆（sidecar `cpx-<sid>.upload.json`）**：上传成功记录 {提交人/范式/opGen/描述/捕获逻辑字节}——退出路径 `--autoupload` 与手动补传统一复用：捕获无新增（按**解压后逻辑字节**比较，快照明文/终版压缩态可比）静默跳过不再弹向导，有新增免交互重传终版替换；带新信息 flag 则重传替换
  - **agent 自纠报错**：非交互缺/错范式目录时错误信息附完整白名单（数据仓顶层目录），执行方一次重试闭环
  - README 附标准收尾片段（贴到工作流末尾即接入）

## [v0.1.2] - 2026-09-12

### Changed
- 【CANNBay 上传直传化：`cpx upload` / `--autoupload` 不再需要 insight 安装或运行】上传链路（staging / 治理 / git push）内建到 cpx `src/cannbay/`（remote 解析 + LFS 免疫镜像 + 治理 + 编排），零 DB / 零 insight 依赖——cpx 捕获文件 + meta 本来就是 cpx 原生产物，staging 直取捕获目录；insight 降级为可选增强（在跑则 observe 预填 query/model 并顺带导入，不在跑完全不影响上传）。架构为**受控双实现**（两包约束下不抽共享包）：密钥清洗规则单一真身在 cpx redactor（insight 治理本就是它的 parity 锁移植件，复检熔断同源派生）；重复的只有 git 操作序列（镜像生命周期 / uploadFolder / LFS 免疫 / baseline 交换），由 parity IT 锁定与 insight 行为一致（治理文本同输入同输出、LFS 中和常量逐字一致、提交人提取同构、内置 push 凭据同源）。治理快路径同语义：cpx 退出压缩时的 `governed=true` 信任标记免解压直传；慢路径兜底复用 cpx 自家 redactor 清洗 + 复检熔断。镜像缓存目录与 insight 隔离（`~/.cannbot-insight/cannbay-cache-cpx`）；env（`CANNBAY2_REMOTE_URL/PUSH_URL` + `CANNBAY2_CPX_CACHE_DIR`）调用时惰性读取；git 错误日志脱敏（push 凭据 URL 不外泄）。insight 侧零改动（Web UI 上传照旧服务非 cpx 会话与自定义数据湖）

### Added
- 【补全热路径分层：静态 ~3ms / 动态 sid ~150ms（原 ~570ms）】静态上下文（首词子命令/agent 命令/保留参数、--agent profile、config on/off、status/upload flag 表）在补全脚本**生成时**从 TS 常量内嵌为 bash 纯内建路由——零进程零 node 冷启；只有真正需要 fs 扫描的 sid 动态场景（upload/normalize）才起 node。node 侧也不再生效 tsx 运行时转换整个 CLI 导入图——postinstall 用 tsx 自带的 esbuild 预编译微型 bundle（`dist/cpx-complete.mjs`，6KB，仅 node 内置依赖），bundle 缺失回退 `cpx __complete` 慢路径（功能不丢）。补全引擎独立入口 `runCompleteMain`（cpx 分发与 bundle 共用）；每次安装/升级 postinstall 重建 bundle 并重写补全脚本（绝对路径保鲜；静态表单一来源不漂移）
- 【Tab 补全自动装配——安装即用，无需手动启用】npm 包新增 postinstall 钩子（`scripts/postinstall.mjs`，复用 `bin/cpx.mjs` 真身安装，脚本文本单一来源）：bash 写用户级 bash-completion 自动加载目录（`~/.local/share/bash-completion/completions/cpx`）；zsh 仅在实际是 zsh 用户时装配 `~/.zfunc/_cpx` 并幂等追加 .zshrc fpath/compinit。独立安装 `install.sh` 末尾同一钩子。全程 best-effort：补全装不上绝不阻断安装。手动修复仍可用 `cpx completion bash|zsh --install`
- 【`cpx completion [bash|zsh] [--install]` —— Tab 补全】`cpx <TAB>` 补子命令/常见 agent 命令/保留参数；`cpx upload <TAB>` / `cpx normalize <TAB>` **动态补真实会话 sid**（扫捕获目录，新 → 旧，明文/压缩同 stem 去重、空占位排除）；`--agent <TAB>` 补 profile；`cpx config dedup <TAB>` 补 on/off；`cpx status <TAB>` 补 --kill/--all；`cpx upload --<TAB>` 补上传 flag；`--opgen <TAB>` 补 success/failure。实现走 kubectl/npm 同款模式：shell 脚本只做转发，候选逻辑全部在 `cpx __complete` 隐藏命令内单一实现（跨 shell 一致）；`--install` 落盘 bash-completion/`~/.zfunc` 自动加载目录。agent 命令之后的参数域不越界补全且 TAB 静默（无文件名兜底噪音；opencode 等有自己的补全）
- 【`cpx <agent> --autoupload`：会话结束自动上传 CANNBay】六框架通用保留参数（任意位置拦截消费，**绝不透传 agent**——否则 agent 把它当自己的参数打印帮助即退、零捕获闪退）；会话结束 → 压缩 → 自动导入 → 复用 `cpx upload` 链路上传。TTY 下向导收集必选信息；非交互须 `--submitter/--category` 补齐（缺则指路 `cpx upload <sid>` 补传，进程退出码仍 0——捕获优先不因上传失败误报）。向导 readline 容错死 tty（SIGHUP 陪跑后的退出路径 EIO 不崩收尾）
- 【`cpx upload [sid]` —— CANNBay 补传】六框架（claude/opencode/cannbot/codex/openai/generic）通用：确保会话已导入 insight（已导入直查预填，未导入自动 import-file 兜底）→ 收集必选信息 → `POST /api/ingest/cannbay2 {action:'upload'}`。上传链路（治理清洗/归档轮转/LFS 免疫/git push）复用 insight cannbay2 库，cpx 零重实现。必选信息交互双轨：**TTY 向导**（提交人回车取 `git config user.name` 预填、范式目录编号选择回车取第 1、算子生成结果可跳过、内容描述预填会话首问、baseline y/N——连按回车即完成）与**非交互 flag**（`--submitter/--category` 必给，`--desc/--opgen/--baseline` 可选；管道/脚本场景）。缺省 sid = mtime 最新捕获；sid 容忍 `cpx-` 前缀；insight 未运行明确指路退出（不代起）；governance 422 拒绝原因透传、捕获保留本地零丢失；description 行协议与 Web UI UploadToCannbayDialog 同构（首行「提交人:」供后端 extractSubmitter 提取）

### Fixed
- 【ssh/终端挂断（SIGHUP）裸死不收尾——ses 9fd46cc3 根因修复】cpx-cli 此前只有 SIGINT/SIGTERM handler，SIGHUP 无 handler → Node 默认直接裸死，零清理：捕获留明文、.sids/占位文件残留、**永不压缩**（实测 ssh 掉线杀 cpx、孤儿 claude 后续退出无人收尾；用户 Ctrl+C 的是孤儿 claude，其 cpx 早已死亡）。修复两层：
  - `process.on('SIGHUP')` handler，**只"不死"不做其他动作**——main() 本就在 await agent 退出，挂断后两种形态都收敛到完整收尾（压缩→导入）：agent 随挂断而死 → child.on('exit') 立即触发；agent 扛过挂断（claude bg-pty-host，断线可重连）→ cpx 同步存活陪跑、会话继续捕获，agent 最终退出时（哪怕数小时后）仍走完整收尾——不主动杀 agent，保住断线重连工作流。注意：SIGHUP 是内核向整个前台进程组投递的信号（raw mode 的 ISIG 屏蔽不了它，与按键 Ctrl+C 不同）；tsx wrapper 链的监管进程无 handler 仍会死（生产同款、无碍——脚本真身与 agent 互为直系父子，收尾链路不受影响）
  - **stdout/stderr EIO 硬化**（真实 PTY 挂断复测发现的第二层 bug）：挂断后 tty slave 已死，任何日志写入收到 EIO——与 EPIPE 不同，Node 对 stdout 的 EIO 默认不忽略，会以 uncaught error 崩掉孤儿态收尾（仅加 SIGHUP handler 时 handler 自己的 log() 就足以触发自杀）。装 noop error 监听吞掉，保证压缩→导入全程不被日志写崩
  - 验证（真实 PTY 挂断三组对照复测：setsid + 控制终端 + 关 master，与 sshd 断开同机制，未入仓）：修复前=裸死+明文/.sids 残留（完整复现 ses 9fd46cc3 现场）→ 仅 handler=死于 EIO → handler+EIO 硬化=挂断后存活陪跑、agent 最终退出后完整收尾（压缩 .jsonl.gz、明文/.sids 清理、自然退出）。cpx 全量 133/133 通过

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
