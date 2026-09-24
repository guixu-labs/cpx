# cannbot-proxy（`cpx`）

## 项目介绍

LLM coding agent（Claude Code / opencode / CANNBot / Codex …）本质是黑盒：发给模型的完整上下文、system prompt 的增长、注入的 skills、子代理的 token 消耗、每轮真实延迟——既看不全也留不下来，行为难以复现。cannbot-proxy 在 agent 与模型 API 之间放一个透传捕获代理，把 wire 层发生的一切 verbatim 明文留存。

```
agent 子进程 ──HTTP──▶ cpx（per-session proxy）──透传──▶ 真实 upstream 模型 API
                          │
                          ▼ tee 流 + SSE 重组 + 密钥清洗
                ~/.cannbot-insight/proxy/cpx-<sid>.jsonl   ← 明文存档（单一事实源）
```

定位：**wire 级明文存档**——逐字节捕获真实请求与响应（含 SSE 重组），会话结束得到可审计、可复现、可离线分析的单文件事实源；作为 [cannbot-insight](../insight) 的采集端（扩展 claude-format JSONL，insight 零改动消费）；纯透传不干预（转发与无 cpx 时逐字节一致）；框架中立（三协议四框架同一格式契约）。

## 项目优势

- **一条命令拉起捕获栈**：`cpx claude` / `cpx opencode` / `cpx cannbot` / `cpx codex`，在原有命令前加 `cpx` 即可，其他使用完全无变化
- **捕获独立于 insight**：不需要 cannbot-insight 在运行；insight 在跑则捕获退出时自动导入并开浏览器，否则保留捕获文件待 insight Web UI 导入
- **零残留注入**：override 只活在 cpx 起的那个进程里（claude `--settings` / opencode `OPENCODE_CONFIG_CONTENT` / codex `-c`），退出即净，不碰任何全局配置
- **三协议支持**：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses API，各自独立的 emitter 与 SSE 重组器
- **子代理捕获**：claude / opencode 双路由，产物对齐 insight 原生 `subagents/` 布局
- **多 provider 透明路由**：自动发现 opencode 各 provider 的真实 upstream（二进制扫描 + 配置），按 `/<providerId>/` 前缀精确转发
- **Tab 补全安装即用**：npm 安装与 install.sh 自动装配 bash/zsh 补全（静态上下文零进程 ~3ms），无需任何手动启用
- **密钥永不落盘**：所有落盘数据经过 `redactor` 唯一咽喉清洗（结构层键名 + 字符串层厂家键形），已真机双链路验证 0 泄漏
- **7z at rest**：进行中明文追加（`tail -F` 可看），退出自动压缩为 `.jsonl.7z`（LZMA2，比率高 gzip 30-50%；确定性产出保重传幂等），resume 自动解压续捕；存量 `.jsonl.gz` 永续可读；**注入压缩**（dedup，默认关）：重注入的相同清单压成标记，只压捕获不改转发

## 安装

要求 Node.js ≥ 20。

**方式一：npm 一键安装（推荐）**

```bash
npm install -g cannbot-proxy
cpx claude -p "用一句话介绍自己"    # 冒烟验证；国内网络可加 --registry=https://registry.npmmirror.com
npm install -g context-cpx        # 同一工具的 Context 品牌变体（命令仍为 cpx，捕获目录 ~/.context-insight/proxy，与 cannbot-proxy 同 bin 名不可同机共装）
```

安装即自动装配 Tab 补全（bash 写入 `~/.local/share/bash-completion/completions/`；zsh 用户装配 `~/.zfunc/`），新开终端 `cpx <TAB>` 即可用。

**方式二：源码安装**

```bash
git clone <本仓地址> && cd cannbot-proxy
./install.sh
```

安装器幂等、可重跑，做四件事：

1. 安装依赖（`tsx` / `fzstd` / `undici` 到本仓 `node_modules`，独立于任何其他项目）
2. 把 `cpx` 以 **symlink** 落到 PATH（`/usr/local/bin` → `~/.local/bin` → `~/bin` 择优；`CPX_BINDIR` 可覆盖）
3. 必要时把 bin 目录写进 `~/.bashrc`（新开终端或 `source ~/.bashrc` 生效）
4. 装配 Tab 补全（与 npm 安装共用同一 postinstall 逻辑，bash/zsh 自动检测）

不想全局装也可以直接用 `./cpx-cli <agent-cmd>`。

## 快速入门

**第一步：冒烟验证（30 秒）**

```bash
cpx claude -p "用一句话介绍自己"
```

命令结束后观察输出：打印的捕获文件路径非空、`captured xxxKB` 字样出现，说明全链路（注入 → 拦截 → 透传 → 落盘）已通。也可以随时 `cpx list` 查看捕获清单：

```
captures dir : ~/.cannbot-insight/proxy
共 3 个会话 · 合计 2.4MB — 按时间降序

  TIME                 SID             SIZE       FRAMEWORK    PROTOCOL   SUB  STATE  FILE
  2026-08-31 10:00:01  a1b2c3…        512.3KB    claude-code  anthropic    2  live   cpx-a1b2c3….jsonl
  ...
```

**第二步：正式使用——在原有工作流前加 `cpx`**

```bash
cpx claude                      # 交互式（/exit 退出后自动压缩，insight 在运行则自动导入）
cpx opencode                    # opencode（无 -m 时自动覆盖 auth.json 全部已登录 provider + 项目级/全局 opencode.json[c] 自定义 provider）
cpx opencode run -m alibaba-cn/glm-5.2 "..."   # 或 -m 精确指定单个 provider
cpx cannbot                     # CANNBot（opencode 系 CANN fork，内建 cannbot provider）
cpx codex                       # Codex（ChatGPT 登录或 OPENAI_API_KEY 均可）
cpx -- aichat "..."             # 任意 OpenAI 兼容客户端
cpx --agent openai -- <cmd>     # 显式指定 profile
```

使用习惯零变化：参数、交互、TUI 全部透传，cpx 只在旁边静默记录。

**第三步：实时观察捕获（可选）**

会话进行中，捕获文件是明文追加的。开另一个终端：

```bash
tail -F ~/.cannbot-insight/proxy/*.jsonl     # 逐行看 wire 记录落盘
cpx status                                   # proxy 进程状态 + 最近捕获 + 压缩率
```

**第四步：进入分析**

- **insight 在运行**：agent 退出时自动导入（POST `/api/ingest/import-file`）并打开浏览器，直达 `http://localhost:21025/session/<sid>` 的 10 tab 分析面（轮次 / 上下文构成 / token / 延迟 / 子代理 / Full Context）
- **insight 未运行**：捕获保留在 `~/.cannbot-insight/proxy/`，之后在 insight Web UI「Import Session → JSONL」选该目录（支持扫描）或单选某个文件导入；`cpx list` 可随时浏览清单

**常用进阶**

```bash
cpx config dedup on            # 开启注入压缩（热生效，立即作用于进行中的会话）
cpx status --kill              # 清理无 sid 的孤儿 proxy 进程
```

**Tab 补全**

安装即自动装配；手动修复用 `cpx completion bash|zsh --install`。生效范围：子命令与常见 agent 命令、保留参数、`--agent` 补 profile、`config dedup` 补 on/off；agent 命令之后的参数属于 agent 自己的域，cpx 不越界补全（TAB 静默）。

**确认捕获没有破坏 agent**

cpx 对 agent 完全透明：转发请求与上游响应逐字节透传、密钥只影响落盘记录、注入退出即净。跑一次你熟悉的任务对比行为，即可放心常开。

## 命令参考

| 命令 | 说明 |
|------|------|
| `cpx <agent-cmd> [args...]` | 拉起捕获栈并运行 agent（命令名自动识别 profile） |
| `cpx --agent <profile> -- <cmd>` | 显式指定 profile（`claude`/`opencode`/`cannbot`/`codex`/`openai`/`generic`） |
| `cpx list` | 捕获会话清单：sid / 大小 / 框架 / 子代理数 / 压缩状态 |
| `cpx status [--kill [--all]]` | insight/proxy 进程状态 + 最近捕获 + 压缩率；`--kill` 清理孤儿 proxy，`--all` 连活跃会话一起清 |
| `cpx config [dedup on\|off]` | 查看/配置注入压缩（默认 off，热生效，只压缩捕获记录不改转发） |
| `cpx completion [bash\|zsh] [--install]` | 打印/安装 Tab 补全脚本（安装时已自动装配，此处为手动修复入口） |
| `cpx --version \| -v` | 版本号 + 生效代码路径（多仓共存时确认当前副本）；版本源在 `src/version.ts` |

> **cpx 保留参数**（任意位置被 cpx 拦截消费，绝不透传 agent）：`--agent` 及若干历史保留 flag（`--autoupload` `--submitter` `--category` `--desc` `--opgen` `--baseline`，静默拦截防误传 agent）；其余参数原样转发给 agent。

## 数据落点与格式

```
~/.cannbot-insight/proxy/
├── cpx-<sid>.jsonl(.gz)      verbatim 主捕获（单一事实源；sid = agent 真实 session id）—— insight 直接导入这个
├── cpx-<sid>.meta.json       会话级声明（cc-session-meta：framework/protocol/version）
└── <sid>/subagents/          子代理 verbatim 捕获 + meta.json（toolUseId 桥接）
```

insight 导入与长期 serving 均直读 verbatim（`.jsonl.7z` / `.jsonl.gz` 透明解压、`cpx-` 前缀自动剥）。盘上历史 norm/ 件不受影响（不迁移不删除）。

每行是**扩展 claude-format**：claude 原生信封（`type`/`timestamp`/`message`）冻结，扩展数据进带 `(schema, version)` 声明的扩展命名空间（见 docs 下的格式契约文档）——wire 轮次（latency/ttft/请求参数）、输入标记、会话 meta、子代理 meta。格式契约详见 （格式契约文档，位于 docs/ 下）。

## 导入分析

导入是 **cannbot-insight 自身的职责**（proxy 不启动 insight）：

- insight 在运行时，捕获退出即自动导入（POST `/api/ingest/import-file`）并打开浏览器
- 手动导入：insight Web UI「Import Session → JSONL」选 `~/.cannbot-insight/proxy/` 目录（支持扫描）或单选某个文件

## 密钥安全

API key / 凭据永不落盘。headers 本就不落盘；清洗的是**内容级泄漏面**——对话内容里的键回显（`env` 输出、粘贴的配置）、URL query 带键、`Bearer` 凭据等，在唯一落盘咽喉 `dispatchEmit()` 统一打码（`前4…后4`，排障可辨厂家）；敏感键名全等 + 厂家键形正则双识别，`max_tokens` 等正常字段零误伤。

## 配置

用户可覆盖的环境变量：

| 变量 | 默认 | 说明 |
|------|------|------|
| `CANNBOT_PROXY_DIR` | `~/.cannbot-insight/proxy` | 捕获目录 |
| `CANNBOT_PROXY_OPENAI_UPSTREAM` | `https://api.openai.com` | 二进制扫描不到的 provider 的兜底 upstream |
| `CANNBOT_CPX_INSIGHT_BASE` | `http://localhost:21025` | insight 服务地址（自动导入；测试用 mock insight 覆写） |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | - | 用户 HTTP 代理（clash/v2ray 等），显式配置 undici ProxyAgent |

运行时配置存于 `~/.cannbot-insight/cpx-config.json`（`cpx config` 管理）：`dedupInjection`（注入压缩，默认关闭）。`CANNBOT_PROXY_*` 其余变量（PORT / SESSION_ID / PROVIDER_UPSTREAMS / …）由 cpx-cli 内部使用，无需手动设置。

## 仓结构

```
├── cpx-cli                  # PATH wrapper（自解析位置，优先本仓 node_modules/.bin/tsx）
├── bin/cpx.mjs              # npm bin 启动器（node --import tsx 起 TS 源码）
├── install.sh               # 独立安装器
├── scripts/
│   ├── postinstall.mjs      # 安装钩子：Tab 补全自动装配
│   └── pack-context.mjs     # context 品牌变体打包（staging 变换 + npm pack）
├── docs/                    # 设计文档
│   ├── DESIGN.md            #   总体设计（架构 / 决策 / 边界）
│   ├── OPENCODE-DESIGN.md   #   opencode 适配（wire 实证 / provider 发现 / 前缀路由）
│   ├── CANNBOT-DESIGN.md    #   CANNBot（cannbot CLI）适配
│   ├── CODEX-DESIGN.md      #   Codex（Responses API）适配
│   └── COMPRESSION-DESIGN.md#   捕获文件 7z at rest
├── src/
│   ├── server.ts            # 捕获代理 server（路由 / 透传 / tee / dispatchEmit 咽喉）
│   ├── cli/cpx-cli.ts       # cpx 编排器（profile / 注入 / 退出路径）
│   ├── cli/cpx-args.ts      # 参数解析（cpx 保留参数拦截，绝不透传 agent）
│   ├── cli/cpx-complete.ts  # Tab 补全引擎（候选逻辑 / 脚本生成）
│   ├── session-resolver.ts  # sid 归因（header > env pinned > 指纹）
│   ├── stream-reassembler.ts# 三协议 SSE 重组器
│   ├── request-body-decoder.ts # gzip/zstd 请求体解码
│   ├── claude-emitter.ts    # anthropic wire → 扩展 claude-format
│   ├── opencode-emitter.ts  # openai wire → 扩展 claude-format（含 cannbot 分流）
│   ├── codex-emitter.ts     # responses wire → 扩展 claude-format
│   ├── writer.ts            # 落盘 + gzip 生命周期 + meta
│   ├── redactor.ts          # 密钥清洗
│   ├── opencode-context-parser.ts # opencode system 三段解析（独立工具）
│   ├── types.ts
└── tests/                   # 自包含测试（vitest，无 insight/Prisma 依赖）
```

## 测试

```bash
npm run test        # vitest run — 全部测试
```

proxy 测试自包含：只验证 emitter/writer/redactor 等模块的 JSON 输出契约，不依赖 cannbot-insight / Prisma——两侧仅靠 claude-format 格式契约耦合，可独立演进。

## 架构原则

- **捕获层不感知 insight**：server / emitters / writer 只写 verbatim；框架行为的解释（task-notification 摘要、skill 注入分类等）一律在 insight 的 adapter
- **三个 emitter 互不复用转换逻辑**：三种 wire 格式在所有相关维度上都不同，独立实现保持框架真隔离；仅共享中立基础设施（writer / reassembler）
- **capture ≠ interpret**：jsonl 是单一数据源、可随时用新逻辑重解析（如 opencode system 三段拆分由独立 parser 拥有）
- **先写盘后 `res.end()`**：防 agent 秒退 + cpx 杀 proxy 的竞态导致记录丢失

## 已知边界

- **per-message token 是估算**：总量是模型自报真实值；per-message 拆分是 insight 的 char/3.5 估算
- **同任务多次 spawn 会合并**：claude 子代理按 task-prompt 哈希分组，同 session 内相同 prompt 二次 spawn 会并到同一 subagent_session_id
- **model 路由 / key 池**：当前版本只透传捕获，不做 model 映射 / 多 key 路由（CCR 核心能力，留待后续）
- **存量捕获不回洗**：redact 上线之前生成的 jsonl 不做追溯清洗，需要干净副本就重跑会话
- **路径前缀路由依赖 SDK 行为**：opencode/ai-sdk 保留 baseURL 路径前缀（实测 1.17.x）；升级后若剥离前缀会落到单一 upstream 回退
