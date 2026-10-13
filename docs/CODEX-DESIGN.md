# Codex Proxy 适配 — 设计文档

## 目标

在现有 cpx proxy 框架上新增第三个 agent 框架适配：OpenAI Codex CLI。
产出的 jsonl 走 x_cannbay schema（cc-wire-round/cc-wire-input/cc-session-meta），
insight 原生导入即可消费，与 claude-code / opencode 两路形状对齐。

## Codex 特征（源码验证）

| 维度 | 值 |
|---|---|
| 协议 | OpenAI **Responses API**（`POST /v1/responses`，SSE 流） |
| wire_api | 仅 `"responses"`（`"chat"` 已移除，硬错误） |
| 配置文件 | `~/.codex/config.toml`（TOML） |
| proxy hook | `openai_base_url = "http://127.0.0.1:<port>"` 或自定义 `model_providers` 的 `base_url` |
| API key | `env_key` 指向环境变量名（如 `OPENAI_API_KEY`） |
| 请求体 | `{input: [...items], tools: [...], model: "...", stream: true}` |
| 响应 SSE | `response.created` → `response.output_item.added` → `response.output_text.delta` → `response.output_text.done` → `response.function_call_arguments.delta` → `response.function_call_arguments.done` → `response.output_item.done` → `response.completed` |
| input item 类型 | `message`（role + content[{type:"input_text",text}]）、`function_call`（name+arguments+call_id）、`function_call_output`（call_id+output） |
| output item 类型 | `message`（content[{type:"output_text",text}]）、`function_call`（name+arguments+call_id）、`reasoning`（summary/content） |
| 子代理 | `[agents]` config roles + multi-thread（与 claude 的 Task tool / opencode 的 task tool 机制不同） |
| skills | `.codex/skills/<name>/SKILL.md`（同 claude/opencode 约定） |
| session 存储 | SQLite state DB + `~/.codex/history.jsonl`（与 claude jsonl 不同，不走 claude 原生导入） |

## 与现有框架的差异（需要新代码的部分）

| 差异 | 影响 | 方案 |
|---|---|---|
| **第三个协议**（Responses API ≠ Anthropic ≠ Chat Completions） | `Protocol` type、reassembler、emitter 都需新增 | 新增 `Protocol = 'responses'`、`ResponsesApiReassembler`、`codex-emitter.ts` |
| **item-based 请求体**（`input` 不是 `messages`） | emitter 的 delta-emit 逻辑不同（input items ≠ messages array） | codex-emitter 自行解析 input items，映射到 user/assistant 行 |
| **function_call 独立 item**（不是 message 内 block） | tool_use 提取逻辑不同 | reassembler 把 function_call item → AnthropicContentBlock {type:"tool_use"} |
| **function_call_output 独立 item** | tool_result 提取逻辑不同 | emitter 把 function_call_output item → user 行的 tool_result block |
| **TOML 配置** | cpx-cli 的 profile 解析不同（TOML ≠ JSON） | cpx-cli 读 `~/.codex/config.toml`，提取 `openai_base_url` |
| **无 x-session-id / cc_is_subagent** | 子代理路由信号不同 | 已验证（见「线程模型」节）：spawn 任务文本 ↔ 线程首条非注入 user 消息逐字节匹配 |

## 架构

```
codex CLI
  │ POST /v1/responses (SSE)
  ▼
┌─ cpx proxy ────────────────────────────────────────────┐
│  server.ts          统一 HTTP 拦截/转发                  │
│  session-resolver   按 /v1/responses 路径 → protocol:'responses' │
│  stream-reassembler ┌ AnthropicReassembler             │
│                     ├ OpenAIReassembler                │
│                     └ ResponsesApiReassembler (新增)   │
│  codex-emitter.ts   (新增) responses → claude-format   │
│  normalize/         (既有) 布局归一                       │
│  writer.ts          (既有) 落盘 + x_cannbay             │
└────────────────────────────────────────────────────────┘
  ↓ norm/<sid>.jsonl (cc-wire-round, protocol:'responses')
insight 原生导入 → DB → UI
```

## 模块设计

### 1. Protocol type + session-resolver

```typescript
// types.ts
export type Protocol = 'anthropic' | 'openai' | 'responses';

// session-resolver.ts
export function protocolFromPath(urlPath: string): Protocol | null {
  if (urlPath.includes('/v1/responses')) return 'responses';     // ← 新增
  if (urlPath.includes('/v1/messages')) return 'anthropic';
  if (urlPath.includes('/v1/chat/completions')) return 'openai';
  return null;
}
```

### 2. ResponsesApiReassembler（stream-reassembler.ts）

Responses API SSE 事件流 → AnthropicContentBlock[] + usage。

```
事件处理：
  response.created              → 记 model、usage.input_tokens
  response.output_item.added    → 按 item.type 建块（message→text, function_call→tool_use）
  response.output_text.delta    → 累积 text
  response.function_call_arguments.delta → 累积 tool_use input JSON
  response.output_item.done     → 定型块（补 id/name/input）
  response.completed            → 取 usage.output_tokens、stop_reason

输出：{ model, stop_reason, content: AnthropicContentBlock[], usage }
```

### 3. codex-emitter.ts

独立的第三个 emitter（与 claude-emitter / opencode-emitter 同级）。

**输入**：`ProxyRecord`（protocol='responses'），request.body 是 Responses API 请求体。

**请求体结构**（真机 codex 0.161 → volcano 网关全量 dump 核实：无 `instructions` 字段，system prompt 由 input 前部的 developer 消息承载——基座提示词 + `<skills_instructions>` 两条，每请求逐字重发，主/子线程同构；`instructions` 字段是部分版本/网关的另一形态）：
```json
{
  "input": [
    {"type":"message","role":"developer","content":[{"type":"input_text","text":"You are a coding agent running in the Codex CLI..."}]},
    {"type":"message","role":"developer","content":[{"type":"input_text","text":"<skills_instructions>..."}]},
    {"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},
    {"type":"function_call","name":"shell","arguments":"{...}","call_id":"call_xxx"},
    {"type":"function_call_output","call_id":"call_xxx","output":"result text"}
  ],
  "tools": [{"type":"function","name":"shell","description":"...","parameters":{...}}],
  "model": "gpt-5",
  "instructions": "You are codex...",
  "stream": true
}
```

**emit 逻辑**：

| input item | claude jsonl 行 |
|---|---|
| `message` role=user | user 行（content = content blocks） |
| `message` role=assistant | 跳过（是 prior response，由 assistant 行覆盖） |
| `message` role=system/developer | 跳过（不进时间线——静态上下文非事件；developer 全文进 assistant 行 `system` 扩展字段，多条以 `\n\n` 连接） |
| `function_call` | 跳过（是 prior assistant 的 tool_use，由 assistant 行覆盖） |
| `function_call_output` | user 行 with tool_result block（tool_use_id = call_id） |

**assistant 行**（response）：
```json
{
  "type": "assistant",
  "message": {"role":"assistant","id":"<resp_id>","content":[reassembled blocks],"model":"...","usage":{...}},
  "timestamp": "...",
  "system": <系统提示词>,              // wire 双形态：body.instructions（部分版本/网关）优先；缺省取 input 里 developer 消息全文（0.161 真机唯一形态）
  "tools": body.tools,                  // verbatim
  "source": "codex-proxy",
  "x_cannbay": {"schema":"cc-wire-round","version":1,"data":{
    "protocol": "responses",
    "roundIndex": ...,
    "system": <系统提示词（同上行，wire 双形态归一）>,
    "tools": body.tools,
    "requestParams": {"model": body.model},
    "latencyMs": rec.latencyMs,
    "ttftMs": rec.ttftMs,
    "stopReason": rec.response.stop_reason,
    "status": rec.response.status
  }}
}
```

**delta-emit**：Responses API 的 `input` 数组是 append-only（每轮把上一轮的 input 全发回 + 新增），与 opencode 的 `messages` 相同模式。用 prevInputCount cursor 做 delta。

**session-meta**：
```json
{
  "x_cannbay": {"schema":"cc-session-meta","version":1,"data":{
    "producer": "cpx",
    "framework": "codex",
    "protocol": "responses",
    "sid": "..."
  }}
}
```

### 4. cpx-cli codex profile

```
cpx codex [args...]              # 启动 codex，注入 openai_base_url 指向 proxy
```

- 读 `~/.codex/config.toml`（如果存在）取 API key 环境变量名
- 设置 `OPENAI_BASE_URL` env 或 `openai_base_url` config → proxy port
- 启动 codex 子进程
- 退出后 normalize → 导入（与 claude/opencode 同款流程）

### 5. proxySourceMarker 扩展

```typescript
export function proxySourceMarker(protocol: Protocol): string {
  if (protocol === 'openai') return 'opencode-proxy';
  if (protocol === 'responses') return 'codex-proxy';   // ← 新增
  return 'claude-proxy';
}
```

### 6. server.ts dispatchEmit 扩展

```typescript
function dispatchEmit(rec: ProxyRecord): void {
  if (rec.protocol === 'anthropic') claudeEmit(rec);
  else if (rec.protocol === 'responses') codexEmit(rec);  // ← 新增
  else opencodeEmit(rec);
}
```

### 7. server.ts resolveUpstreamUrl 扩展

Responses API 请求转发到 OpenAI 上游（`https://api.openai.com/v1`）或自定义 provider base_url。

## 适配性设计

| 变化场景 | 是否需改代码 | 原因 |
|---|---|---|
| Responses API 加新事件类型 | 是 | reassembler 注册表加分支 |
| codex 配置改 config 格式 | 可能 | cpx-cli 的 config 读取要跟 |
| codex 改子代理机制（spawn 协议变化） | 可能 | 信号链见「线程模型」节；wire 变化由 dump 模式快速核实 |
| Responses API 加新 input/output item 类型 | 是 | emitter/reassembler 映射表加分支 |

## 技术选型

| 组件 | 选型 | 理由 |
|---|---|---|
| TOML 解析 | 手写轻量提取（不引入 toml 依赖） | 只需提取 `openai_base_url` / `env_key` 几个字段 |
| Responses API SSE 解析 | 同 AnthropicReassembler 模式（buffer + line + event dispatch） | 事件驱动，与现有 reassembler 同构 |
| output → AnthropicContentBlock 映射 | 手写 switch on item.type | 类型有限，不需通用映射框架 |

## 不做的事

- 不做 codex session DB 解析 —— 走 proxy 捕获即可（capture ≠ interpret）
- 不做 Responses API WebSocket transport —— 初版只处理 HTTP SSE
- 不做 codex skills 解析 —— skills 在 `.codex/skills/`，与 claude/opencode 同结构，由 insight adapter 消费

---

# 第二轮适配：网络场景矩阵 + 多线程捕获 + wire 完整度（2026-10）

初版覆盖了「全局梯子 + ChatGPT 登录」单一场景。第二轮把三个网络场景、
多子代理正确性、reasoning 完整度系统性补齐——四层设计，全部真机验证
（volcano 网关 + codex 0.161 + 2 子代理并行观测）。

## 0. 场景矩阵与判定

| # | 场景 | 机制 | 状态 |
|---|---|---|---|
| A | 全局梯子（shell 导出 HTTP(S)_PROXY）+ GPT | L1 egress 遵循 env | ✅ |
| A' | TUN 模式全局梯子 | OS 透明路由（无 env） | ✅ 天然工作 |
| B | 窗口/项目级梯子（脚本起终端） | env 继承 → L1 同 A | ✅ |
| C | 无梯子 + 自定义 provider 直连（volcano/deepseek…） | L2 provider 隧道 | ✅（初版完全不捕获） |
| D | 多子代理会话 | L3 线程模型 | ✅（初版计数器串扰必坏） |
| E | reasoning / usage 完整度 | L4 wire 补全 | ✅ |

## 1. L1 出口网络层（Egress）

两跳彻底解耦：**agent→proxy 恒回环直连，proxy→upstream 遵循环境代理**。

- proxy 出口（server.ts）：undici `EnvHttpProxyAgent` 替代单值 ProxyAgent ——
  按请求遵循 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`（`ALL_PROXY` 作 curl 风格兜底
  显式传入），无配置直连。一个机制覆盖 A/A'/B/C 四场景。
- agent 本地跳（cpx-cli spawn 处，全框架共享）：子进程 env 注入
  `NO_PROXY/no_proxy = localhost,127.0.0.1 + 用户既有值`（合并不覆盖）——
  梯子 env 全局时 reqwest/undici/curl 类客户端照单全收，不显式排除就会把
  本地跳丢给梯子。计算在 `cli/child-env.ts`（纯函数，cpx-cli 顶层跑 main()
  无法被 UT import）。

## 2. L2 上游路由层（Provider 隧道）

初版只覆盖 `openai_base_url`（ChatGPT 登录）与 `cpx_proxy` provider（API
key）——用户 config.toml 里有自定义 `[model_providers.*]`（网关/自建场景）
时流量直连网关，**cpx 一个字节都看不到**。隧道把 opencode 的
`PROVIDER_UPSTREAMS` 先例推广为路径保真方案：

```
发现（cli/codex-providers.ts）：解析 ~/.codex/config.toml 的
  [model_providers.<id>]（base_url/wire_api）+ 顶层 model_provider
注入：codex -c model_providers.<id>.base_url="<proxy>/<id><原path>"
  例：https://gw.example.com/v1 → http://127.0.0.1:<port>/volcano/v1
链路：codex POST /<id>/v1/responses → cpx 剥 /<id>/ 前缀
  → 转发 <原origin>/v1/responses —— 与直连字节级同构
```

- **路径保真**：注入 base_url 保留原 base_url 的 path 部分，codex 追加的
  `/responses`（或 chat wire 的 `/chat/completions`）落在同一逻辑路径上；
  upstream 表只存 origin（proxy 重新拼被剥的路径）。
- **三层注入优先级**（buildLaunch codex 分支）：provider 表非空 → 隧道全部
  provider + 补 `openai_base_url` 覆盖（中途切回内置 openai 也能捕获）；
  无表 + `OPENAI_API_KEY` → cpx_proxy provider（不变）；无表无 key →
  ChatGPT 登录（不变）。注入的 `-c` 排在 agentArgs 前，用户自己的 `-c`
  恒可覆盖。
- **API key 永不进 cpx**：auth 走 env_key 透传 + header 原样转发。
- 非裸 key 的 provider id（引号/斜杠）不能成为路径段——跳过该 provider
  （直连不捕获）而不是产生坏路由。
- wire_api=chat 的 provider：路径含 `/chat/completions` → protocol='openai'
  → opencode-emitter 消费（同 wire 形状复用，无需 codex 侧代码）。

## 3. L3 线程模型（多子代理捕获）

codex 主线程与每个子代理是**独立 Responses-API 线程**，共用同一 proxy 端口、
同一 sid、无 header 信号。请求全量重发 input——**每线程独立游标**是正确性
前提（旧实现 `contextKey='main'` 硬编码：主线程游标吞掉子代理 input、
roundIndex 全乱）。

长会话下 input **并非 append-only**（20 分钟真机会话证伪）：上下文窗口
填满后 codex（`x-codex-beta-features: remote_compaction_v2`）把线程 input
**重建**为少量条目——实测 106→5（子代理）、114→5（主线程），且条目顺序
不保持。纯位置游标在此场景静默丢失压缩摘要与新增指令。游标因此带**锚点
验证**（末位 item 的内容哈希）：append-only 走 O(delta) 快路径（send_input
同文重发仍逐字落盘，不做内容去重）；锚点失配（截断/重写）进入**内容指纹
multiset 重同步**——只发从未见过的内容，重建时重注入的静态注入/任务文本
不重复，压缩摘要（"Another language model started…"）与后续指令如实落盘。
roundIndex 跨压缩连续（压缩是线程内事件，不重置轮次）。

路由信号链（真机核实，native rollout + proxy dump 双向验证）：

```
主线程响应含 spawn_agent tool_use（任务文本双形态，见下）─登记─▶ 派发表
请求 input 的「首条非注入 user 消息」逐字节命中派发表 ─路由─▶ 子代理上下文
主线程后续请求 input 的 function_call_output（{agent_id,nickname}）─回填─▶ 子代理 meta 重写
未命中任何派发表 ──▶ main（首个请求天然 main）
```

- spawn 任务文本的 wire 双形态（0.161/0.162 真机核实）：0.161 模型直传
  `input.message`；0.162 模型从工具错误中学习（先试 message+items 双参被拒
  "Provide either message or items"、再试 reasoning_effort 被网关拒），最终
  只传 `fork_context`+`items`——items 内是**纯文本项** `{type:'text', text}`
  （四个子代理实测一致），任务文本 = 首条非注入文本。`spawnTaskOf` 双形态
  归一（items 内纯文本项与 message 项都认——后者防御性，与线程 input 同构）。
  真机核实：items[0].text 与子代理线程身份**逐字节一致**，路由等价性成立。
- 每个 spawn call_id 都映射到任务文本（**先于**任务去重守卫）：0.162 的失败
  重试链里，首个 message 形态失败调用注册任务文本，items 形态成功调用才带回
  agent_id 输出——不映射成功 call 的 id，富化永远查不到（真机 0.162 首测：
  4 个子代理 meta 富化全 null，insight 的 agentId 连接键失效、泳道 0 turns）。
  真机缺陷链警示：只认 message 形态时，纯 items spawn 不注册 → 子代理线程
  身份匹配不上 → 误路由进主线程文件，双流共享一个游标 → 锚点失配 → resync
  重复发射主线程条目（实测 39 请求的子代理污染主文件至 6102 行）。

- 真机核实的线程结构：子代理 user 序列 =
  `[<environment_context> 注入, 任务文本(=spawn message 逐字节)]`；主线程 =
  `[<environment_context>, 用户 prompt, <subagent_notification>…]`。
  静态注入前缀（environment_context/user_instructions/codex_internal_context/
  # AGENTS.md）做 identity 跳过——与 insight 侧注入分类同一指纹。
- 顺序保证（真机竞态修正）：emit 按**请求到达序**而非响应完成序落盘
  （`ordered-dispatch.ts`）。codex 从流中渐次完成的 tool_use 提前拉起子代理
  ——子代理首轮请求可先于派发轮的长流式响应**到达并完成**，完成序 emit 会
  把子代理首轮排到派发登记之前、误路由进主线程文件（实测 20 分钟会话：
  seq 0003/0004 两轮子代理首轮先于 spawn 轮 seq 0002 落盘）。到达序对全部
  emitter 依赖因果安全：派发登记（派生请求必然晚于其来源请求到达）、每线程
  轮次序（线程内串行请求）、spawn 输出富化（顺序无关重写）。被弃请求
  （502/无 body）提交 null 墓碑推进序列，绝不卡死后续记录。
- `send_input` 的后续输入是子代理 input 里的新 user item——逐字捕获（真机
  观测到 codex 用同文重发任务，捕获侧如实记录，路由取首条不受影响）。
- 子代理文件落 `<sid>/subagents/<subId>.jsonl + .meta.json`（claude 约定
  布局，insight `listSubagentSessions` 零改动消费）。meta 形状与 claude-emitter
  对齐（toolUseId/name/agentType 顶层 + cc-subagent-meta），codex 增量字段
  `agentId`/`nickname`（additive）。nickname 晚到（spawn 输出在主线程下一轮
  input 里）——首写用任务首行占位，富化到达后整文件重写。
- 同任务文本多次 spawn 理论上可哈希冲突——与 claude-emitter 同款语义，接受。

## 4. L4 wire 完整度（reasoning / usage）

真机发现网关与 OpenAI 规范的 **reasoning 事件双命名**，两族都认：

| 事件/字段 | OpenAI 规范 | 网关（volcano/deepseek 实测） |
|---|---|---|
| 思考增量 | `response.reasoning_summary_text.delta` | `response.reasoning_text.delta` |
| 思考全文 | `output_item.done` 的 `summary[].summary_text` | `response.reasoning_text.done` + `output_item.done` 的 `content[].reasoning_text` |

- reasoning item → `{type:'thinking'}` 块（output_index 顺序天然置首）。
- usage 补全：`output_tokens_details.reasoning_tokens`（AnthropicUsage 的
  OpenAI 协议思考计费通道，opencode 路径同族）、
  `input_tokens_details.cached_tokens` → cache_read_input_tokens。
- function_call 的 `argsPartial` 兜底：流中断（无 output_item.done）时从
  已累积的 arguments delta 尽力恢复 input。
- 非流式 responses JSON（`reassembleResponsesJson`）：`output[]` 三类 item
  同构解析（codex 默认流式，此为兜底路径）。

## 5. 观测与排障：dump 模式

`CANNBOT_PROXY_DUMP_DIR=/path` 开启原始 wire 双向落盘：每调用一对
`<seq>-request.json`（headers 敏感项打码）+ `<seq>-response.txt`（8MB 截断）。
与捕获管线（PROXY_DIR）完全分离——回答 wire 格式问题的调试工具（本轮
reasoning 双命名即由它发现），不参与任何 emitter 消费。

## 验证记录（真机）

- volcano 网关 + codex 0.161 + 2 子代理并行：三线程隔离、每线程独立
  roundIndex（main r0-r5 / sub r0-r2）、spawn/send_input/wait_agent/
  close_agent/notification 全链路捕获、meta 富化（Helmholtz/Plato/Mencius
  nickname + agentId + callId）。
- reasoning：thinking 块 + reasoning_tokens（91/191 等实测值）。
- 存量回归：cpx ut 全绿（新增 codex-providers/codex-emitter/reassembler
  reasoning 三组 40 用例）；opencode-providers 1 例环境相关存量失败
  （HEAD 复现，与本轮无关）。
- 长会话压力验证（2026-10，修复驱动的第三轮真机）：会话 A（20 分 22 秒，
  1.6M tokens，3 子代理 49/55/11 轮，146 请求 = 146 assistant 行对账，
  resume_agent/send_input 首次实测捕获）与会话 B（14 分 33 秒，3.8M tokens，
  单线程 62 轮、exec_command×90）。两轮分别暴露压缩丢失与完成序竞态；修复
  后以 wire dump 回放验证：压缩摘要恢复（A +2 / B +1 user 行）、子代理首轮
  回归正确线程、到达序与完成序提交的产物规范化后逐行一致。附带佐证：会话
  B 中 codex 自审源码独立指出了同一游标缺陷（P0 级）。
