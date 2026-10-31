# Changelog

## [v0.1.12] - 2026-10-27

> 更名说明：npm 包主体自本版起为 `context-cpx`（命令仍为 `cpx`，捕获目录 `~/.context-insight/proxy/`）；`cannbot-proxy` 转为同内容变体包。捕获格式契约与 insight ≥ v0.2.41 配套。

### Changed
- 【品牌主体更名】环境变量前缀 `CANNBOT_*` → `CONTEXT_*`（变体包保持旧前缀）；数据目录随 insight 迁移至 `~/.context-insight/`
- 【wire 扩展信封单轨】扩展信封键 `x_cannbay` 更名为 `x_lake`，仅写新键；旧键捕获由新版 insight 按无扩展导入
- 【文档更新】README 与设计文档按新品牌与现行为全面更新
- 按成员身份归档子代理捕获流：同一成员重启续跑不再裂成无归属新文件（与 insight 的桥接/时间线展示配套）
- 后台（异步）派发的子代理 meta 补齐派发 id/名称/类型：子代理先于父响应落盘时先记空值、派发到达后回填重写，桥接不再依赖兜底路径
- 【包瘦身】设计文档（docs/）不再随 npm 包发布，安装体积更小（运行时行为不变）

### Fixed
- 【旧键 meta 显示丢失】改名前落盘的本地捕获 meta 用旧信封键，`cpx list` 的框架/协议列与捕获退出的 governed 标记对旧捕获静默失效——meta 读侧统一走新旧双键兼容读（新键优先；捕获行扩展仍按单轨新键不回退）
- undici 6.28.1 → 6.29.1：闭环 CVE-2026-109869（7.5 High）/ CVE-2026-109924（5.9 Medium）

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [v0.1.13] - 2026-10-31

### Changed
- 【版本定版】版本号升至 0.1.13；README 安装路径适配独立仓库结构，注释勘误与子代理编号空值兜底

## [v0.1.11] - 2026-10-21

> 对齐说明：npm v0.1.10 为 0.2.38 撤回重发的换号版，未含 v0.1.9 的 codex 捕获修复；本版起 npm 产物与 git master 对齐。

### Added
- 【上游解析统一（镜像契约）】各族上游解析收编为单点 `agent-upstream.ts`，解析链与 agent 自身配置源优先级同构，启动日志逐路标注来源 `(source: …)`；claude 族补齐进程 env `ANTHROPIC_BASE_URL` 与 project 级 settings 两层，openai/generic 补齐 `OPENAI_BASE_URL` env 层，codex 补齐 config.toml 顶层 `openai_base_url`（采纳时剥尾部 `/v1`）
- 【anthropic 族 cpx 旋钮】`CANNBOT_PROXY_ANTHROPIC_UPSTREAM` 置顶 claude/dsh 解析链（与 openai 族既有旋钮对称）
- 【上游解析 IT 矩阵】13 用例 e2e：假 agent 按各族真实端点发现机制取址 → 真实 POST 会话 proxy → 命名假上游记录命中，锁定全部层级序

### Fixed
- 【claude 进程 env 上游被无视（客户案）】settings.json 无 env 段 + 进程 env `ANTHROPIC_BASE_URL` 的场景此前硬编码回退官方地址，代理转发到错误上游
- 【codex RESPONSES 旋钮被覆写】`CANNBOT_PROXY_RESPONSES_UPSTREAM` 此前被 chatgpt auth 检测以 `process.env` 突变覆盖（旋钮应为最高层）；突变本身移除，四路上游显式传参
- 【dsh 缺 cpx 旋钮】`CANNBOT_PROXY_ANTHROPIC_UPSTREAM` 此前对 dsh 不生效

### Changed
- 【dsh 子代理建链】dsh 子代理捕获写入 `<父sid>/subagents/` 布局（与 claude 一致），insight 零改动即可发现子代理
- 【dsh 捕获 profile】新增 `cpx dsh`：复用 anthropic 协议链路，会话按 dsh 专属头命名，框架标记为 dsh

## [v0.1.9] - 2026-10-10

### Added
- 【codex 自定义 provider 隧道】`~/.codex/config.toml` 的 `[model_providers.*]` 自定义网关全部可捕获，转发与直连字节级同构
- 【codex 多子代理捕获】spawn 任务文本指纹路由，主 / 子线程独立文件，派发关联自动富化
- 【codex reasoning 完整度】thinking 块（OpenAI 规范与网关双命名）与 reasoning_tokens 计费通道全量捕获
- 【网络场景矩阵全覆盖】proxy 出口遵循 HTTP(S)_PROXY / NO_PROXY，agent→proxy 本地跳自动直连
- 【wire dump 排障模式】`CANNBOT_PROXY_DUMP_DIR` 原始双向落盘（敏感头打码），与捕获管线分离

### Changed
- 【insight 发现契约升级】自动导入目标从固定端口改为自动发现，多人服务器上各自对准自己的实例

### Fixed
- 【codex spawn 双形态未识别（0.162）】双形态归一识别，子代理独立成文件、meta 富化恢复，主文件零污染
- 【codex 系统提示词捕获缺失】developer 消息形态的系统提示词随捕获落盘，不再恒空
- 【codex 长会话压缩丢失】锚点验证 + 内容指纹重同步，上下文压缩边界零丢失
- 【codex 子代理首轮误路由】按请求到达序落盘，竞态时序下子代理首轮不再误入主线程

## [v0.1.8] - 2026-09-30

### Added
- 【压缩格式升级 gzip → 7z】压缩率提升 30-50%，存量 `.gz` 永续可读

### Changed
- 【信封双名（与 insight 同步）】扩展字段新键 x_lake 双写过渡，存量数据零迁移

### Fixed
- 【opencode 2.x 内建 provider upstream 失明】已登录的官方 provider 恢复正常转发
- 【opencode 2.x 捕获 0 字节】2.x 客户端-服务端架构下的注入失效已修复
- 【WSL 上跑测试弹出浏览器空页】测试期不再弹浏览器
- 【OpenAI 协议思考流捕获丢失】思考内容与正文一并捕获
- 【findProxyProcs 全布局失明】status / --kill / 清扫恢复正常
- 【空壳会话泄漏】信号退出不再残留 0 字节占位捕获

## [v0.1.7] - 2026-09-20

### Fixed
- 【wire 捕获 usage 记账缺失（GLM 类 anthropic 兼容网关）】此类网关把最终全量 usage 放 `message_delta`（`message_start` 只给占位 `input_tokens:0`），流重装器此前只抄 `output_tokens`——input/cache_read 全记 0，同会话 wire 捕获与原生 transcript 的 token 对账差数倍。现按非零数值字段合并（零值不覆盖，防病态 delta 抹掉 message_start 已有真值）；官方流行为不变

## [v0.1.6] - 2026-09-18

### Fixed
- 【项目级 provider 发现缺失——opencode 捕获 0 字节（客户现场 huoshan-ai-gateway 回归）】provider 发现链此前只有三个来源（`-m` / auth.json / 全局配置根 `~/.config/opencode`、`~/.config/cannbot`），项目级 `.opencode/opencode.json[c]` 从未被扫描：用户模型走项目级配置定义的 provider（huoshan-ai-gateway → volceapi）时，baseURL 未被重定向、opencode 直连上游、proxy 颗粒无收。修复 `opencodeConfigRoots`：新增 `opencodeProjectConfigRoots`（从 cwd 逐层向上到最近的 git 目录，每层产出 `<dir>` 与 `<dir>/.opencode` 两个候选根，覆盖 opencode 文档「先在 cwd 找、再向上到 git 根」的遍历语义），并排在全局配置根之前（项目配置优先级高于全局，与 opencode 合并语义一致）；启动报错指引同步补项目级配置路径。IT：`tests/e2e/cpx-project-provider.e2e.test.ts`（cwd 设为项目目录，验证 `.opencode/opencode.json` 的 provider 被注入 baseURL 重定向、upstream 从项目配置本体解析）+ `tests/ut/opencode-providers.test.ts` 项目级发现/遍历/优先级单测
- 【`cpx` npm bin 启动器 cwd 错位】`bin/cpx.mjs` 原以 `cwd: PKG_DIR` 起 cpx-cli——`cpx <agent>` 实际在包安装目录（而非用户项目目录）启动 agent，`process.cwd()` 失真，项目级配置发现/agent 工作目录双双错位。修复：去掉 `cwd` 覆盖（继承用户 cwd），tsx loader 改 `file:` URL 绝对路径、入口脚本改 `PKG_DIR` 绝对路径（两者都不再依赖 cwd 解析）；tsx loader 定位用 `createRequire(import.meta.url).resolve('tsx')` 从 bin 自身做标准模块解析（与 postinstall 解析 esbuild 同款）——`npm i -g` 嵌套、装进用户项目/`npx` 时的 hoist 提升两种布局都能命中，不再硬编码 `PKG_DIR/node_modules/tsx/dist/loader.mjs`（hoist 布局下该路径不存在，启动即 `ERR_MODULE_NOT_FOUND`）。**会话代理启动同步收口（同类硬编码）**：`cpx-cli.ts` 起 `src/server.ts` 原用 `<pkg>/node_modules/.bin/tsx` 硬编码——hoist 布局下同样 miss，回落 `npx tsx` 经实测**不从用户项目解析提升的 tsx 而是从 registry 现场下载**（网络依赖、慢、离线即挂）；改为同一纪律（`resolveTsxLoader` 共用 helper，`node --import <loader> server.ts`），npx 仅作解析失败兜底。IT：`tests/ut/tsx-launcher.test.ts`（嵌套/hoist/缺失三布局解析语义）+ `tests/e2e/cpx-hoist-tsx.e2e.test.ts`（hoist 布局真跑：bin 起 CLI、代理真启动（假 agent 收到 proxy 地址）、PATH 前置假 npx 落盘标记断言回退从未触发、干净退出；还原旧实现该 IT 红）

## [v0.1.4] - 2026-09-16

### Added
- 【双名发布：context 品牌变体（bin 保持 `cpx`）】同一套代码打包期品牌变换——数据目录默认值与显示名随之翻转（与 context-insight 配对），格式契约与环境变量名保留不变（两品牌数据互通）；同 bin 名同机不可共装

## [v0.1.3] - 2026-09-14

### Removed
- 【`cpx normalize` 命令与 norm/ 规范层移除】norm/ 镜像层与 verbatim 逐行相同（冗余副本，insight 直读 verbatim 导入与 serving，零消费方）——彻底清理：删除 `src/normalize/` 模块与 normalizer 测试，Tab 补全同步摘除；盘上存量 norm/ 件不受影响

## [v0.1.2] - 2026-09-12

### Added
- 【补全热路径分层：静态上下文 ~3ms（原 ~570ms）】静态候选（首词子命令/agent 命令/保留参数、--agent profile、config on/off）在补全脚本**生成时**从 TS 常量内嵌为 bash 纯内建路由——零进程零 node 冷启。node 侧不再走 tsx 运行时转换整个 CLI 导入图——postinstall 用 tsx 自带的 esbuild 预编译微型 bundle（`dist/cpx-complete.mjs`），bundle 缺失回退 `cpx __complete` 慢路径（功能不丢）。补全引擎独立入口 `runCompleteMain`（cpx 分发与 bundle 共用）；每次安装/升级 postinstall 重建 bundle 并重写补全脚本（绝对路径保鲜；静态表单一来源不漂移）
- 【Tab 补全自动装配——安装即用，无需手动启用】npm 包新增 postinstall 钩子（`scripts/postinstall.mjs`，复用 `bin/cpx.mjs` 实际安装逻辑，脚本文本单一来源）：bash 写用户级 bash-completion 自动加载目录（`~/.local/share/bash-completion/completions/cpx`）；zsh 仅在实际是 zsh 用户时装配 `~/.zfunc/_cpx` 并幂等追加 .zshrc fpath/compinit。独立安装 `install.sh` 末尾同一钩子。全程 best-effort：补全装不上绝不阻断安装。手动修复仍可用 `cpx completion bash|zsh --install`
- 【`cpx completion [bash|zsh] [--install]` —— Tab 补全】`cpx <TAB>` 补子命令/常见 agent 命令/保留参数；`--agent <TAB>` 补 profile；`cpx config dedup <TAB>` 补 on/off；`cpx status <TAB>` 补 --kill/--all。实现走 kubectl/npm 同款模式：shell 脚本只做转发，候选逻辑全部在 `cpx __complete` 隐藏命令内单一实现（跨 shell 一致）；`--install` 落盘 bash-completion/`~/.zfunc` 自动加载目录。agent 命令之后的参数域不越界补全且 TAB 静默（无文件名兜底噪音；opencode 等有自己的补全）

### Fixed
- 【ssh/终端挂断（SIGHUP）裸死不收尾——ses 9fd46cc3 根因修复】cpx-cli 此前只有 SIGINT/SIGTERM handler，SIGHUP 无 handler → Node 默认直接裸死，零清理：捕获留明文、.sids/占位文件残留、**永不压缩**（实测 ssh 掉线杀 cpx、孤儿 claude 后续退出无人收尾；用户 Ctrl+C 的是孤儿 claude，其 cpx 早已死亡）。修复两层：
  - `process.on('SIGHUP')` handler，**只"不死"不做其他动作**——main() 本就在 await agent 退出，挂断后两种形态都收敛到完整收尾（压缩→导入）：agent 随挂断而死 → child.on('exit') 立即触发；agent 扛过挂断（claude bg-pty-host，断线可重连）→ cpx 同步存活陪跑、会话继续捕获，agent 最终退出时（哪怕数小时后）仍走完整收尾——不主动杀 agent，保住断线重连工作流。注意：SIGHUP 是内核向整个前台进程组投递的信号（raw mode 的 ISIG 屏蔽不了它，与按键 Ctrl+C 不同）；tsx wrapper 链的监管进程无 handler 仍会死（生产同款、无碍——脚本本体与 agent 互为直系父子，收尾链路不受影响）
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

cpx 自 cannbot-insight/proxy 独立成包（`packages/cpx`，git mv 保留历史）后的首个独立版本。独立前的变更见 `../insight/CHANGELOG.md`（proxy 相关条目：v1.81 捕获自动刷新、v1.83 捕获格式契约、v2.06 subagent 声明恢复等）。

### Added
- 【版本号体系】三段式 `0.1.0`，单一版本源 `src/version.ts`（与 cannbot-insight 的 `src/lib/version.ts` 同构；`package.json` version 不作展示版本；升版本策略：新增特性或修复严重 bug +0.0.1，小修小补不升）
  - `cpx --version | -v`：输出 `cpx v<版本> (<包路径>)` —— 多仓共存 / symlink 单指针切换时一条命令确认当前生效副本（替代 `readlink -f $(which cpx)`）
  - 启动横幅首行 `[cpx-cli] cpx v<版本> (<包路径>)`；`--help` 标题动态带版本号，与 `--version` 同源不漂移
  - README 命令参考补 `--version` 行
  - IT：`tests/cpx-version.test.ts` 3 用例（双 flag 输出、版本与单一源一致、help 标题同版本）
- 注：`cc-session-meta.ccVersion` 是 agent 侧（Claude Code）版本，与 cpx 包版本分属两个概念；捕获格式本身本次未动（受格式契约文档约束）
