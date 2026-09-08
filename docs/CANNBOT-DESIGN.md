# CANNBot（cannbot CLI）cpx 捕获适配方案

## 1. 背景与结论

`cannbot`（gitcode `cann-dev/cannbot-cli`，npm 全局包，当前 1.1.2）是 opencode 的
CANN 生态 fork。现状：**`cpx cannbot` 零捕获**——cpx-cli 不认识该命令，流量直连
hicann.cn 网关，完全绕过 proxy。

结论：**适配是"接线"而非"新协议"**。cannbot 走 openai 兼容协议（wire 层与
opencode 同形），会话头约定也与 opencode 一致，proxy 的 server / 路由 / 会话解析
三层**零改动**；需要改的是 cpx-cli 编排（profile/provider/上游）+ emitter 的
框架标识 + insight 消费侧的 framework 归类与徽标。

## 2. cannbot 实测画像（二进制 strings 逆向证据）

| 维度 | 实证 | 适配含义 |
|---|---|---|
| 内核 | bun 编译的 opencode fork；内含 ModelsDev、`OPENCODE_CONFIG_CONTENT`（config tier 6，`--settings` 对位机制） | opencode 的注入机制直接可用 |
| 默认 provider | 内建 `cannbot`（**代码常量**，非注册表项）：baseURL `https://cannbot.hicann.cn/gateway/compatible-mode/v1`（常量 `h9`，两处出现），npm `@ai-sdk/openai-compatible` | wire 协议 = openai；上游是稳定常量，可硬编码兜底 |
| 认证 | `/connect` vkey → `cannbot.hicann.cn/cannbot/api/auth/authenticate`（MAC 绑定）→ `auth.set({providerID:'cannbot-cli'})` oauth；自定义 fetch 在请求时注入 `Authorization: Bearer <token>` + `x-api-vkey` 头 | 头部透传即可，proxy 无需感知凭据（STRIP 清单只剥 host/content-length/connection/transfer-encoding） |
| 会话头 | 非 `opencode` 前缀 provider 发 `X-Session-Id` + `x-parent-session-id`（子会话）+ `User-Agent: cannbot/<ver>` | Node 头名统一小写 → 现有 `x-session-id` 解析直接命中；UA 是 cannbot 与 opencode 的**唯一线上区分信号** |
| 其他 provider | 二进制注册表仍含 alibaba-cn 等（`id:"...",api:"..."` 形态可 strings 扫描） | `-m alibaba-cn/...` 场景沿用现有发现机制 |
| 全局配置 | `/connect` 写 `provider.cannbot.options.baseURL` 到全局 config | 证明 config 层 baseURL 对该 provider 生效（合并语义）——cpx 注入同理 |

## 3. proxy 现有架构与适配矩阵

```
cpx-cli（编排）                     server.ts（转发+捕获）           emitter（落盘格式）
  profile 识别 ─┐                     协议：路径推断                  anthropic → claude-emitter
  provider 覆盖 ├→ OPENCODE_CONFIG →  sid：header（x-session-id /    openai    → opencode-emitter
  上游发现     ─┘   _CONTENT 注入      x-claude-code-session-id）      responses → codex-emitter
  per-session proxy 端口              上游：/<providerId>/ 前缀路由    ↓ writer（jsonl + meta + x_cannbay）
                                      （PROVIDER_UPSTREAMS env）
```

三个 emitter 产出**同一** claude 信封 + x_cannbay 格式（spec §3），单个
claude-jsonl adapter 消费全部——新 agent 适配点固定为：**协议路由（server）×
框架标识（emitter meta/marker）× 编排接线（cpx-cli）**。

| 环节 | cannbot 现状 | 改动 |
|---|---|---|
| `protocolFromPath('/cannbot/chat/completions')` → openai | ✅ 现有正则命中 | 无 |
| `resolveSession`：`X-Session-Id` → `x-session-id` | ✅ 小写化命中，SAFE_SID 兼容 `ses_*` | 无 |
| 子会话 `x-parent-session-id` | ✅ opencode-emitter 既有路由 | 无 |
| 上游路由 `PROVIDER_UPSTREAMS['cannbot']` | ❌ cli 未提供 | cpx-cli |
| emitter meta `framework:'opencode'` | ❌ 写错框架 | emitter |
| insight `META_FRAMEWORK_MAP` / `MARKER_FRAMEWORK_MAP` | ❌ 无 cannbot 项 | insight |

## 4. 断点分析（为何现在不捕获）

1. **profile 误判**：`parseArgs` 的 basename 分支没有 `cannbot` → 落 `generic`，
   只注入 `OPENAI_BASE_URL`；opencode 系二进制忽略该变量（cpx-cli 自注已载明）
   → 流量直连网关，proxy 零流量。
2. **provider 覆盖缺项**：即使强制 `--agent opencode`，覆盖列表来自 opencode 的
   auth.json（本机 alibaba-cn/zhipuai-coding-plan），不含内建 `cannbot` provider。
3. **上游发现盲区**：`discoverProviderUpstreams` 扫 `id/api` 注册表形态；cannbot
   网关是代码常量，扫不到 → 即便覆盖也会错误转发到 api.openai.com 默认值。

## 5. 适配方案

### 5.1 cpx-cli（编排层，3 处）

1. **profile**：`parseArgs` 增加 `base === 'cannbot' → 'cannbot'`（独立
   AgentProfile，复用 opencode 的启动机制）。无 auth.json 前置校验——cannbot
   provider 是内建的，必然可覆盖。
2. **provider 覆盖列表**：`cannbot` = 内建 `cannbot` ∪ opencode auth.json 项
   （`-m alibaba-cn/...` 场景）。baseURL 注入同 opencode（`/<providerId>/` 前缀）。
3. **上游发现**（`cannbot` provider 专用链，其他 provider 仍走二进制扫描）：
   `读全局 config provider.cannbot.options.baseURL`（候选 `~/.config/cannbot/opencode.json`、
   `~/.config/opencode/opencode.json`，覆盖私有化网关部署）→ 兜底硬编码
   `https://cannbot.hicann.cn/gateway/compatible-mode/v1`（代码常量，二进制双处验证）。

### 5.2 server / session-resolver / writer：零改动（§3 矩阵论证）

### 5.3 opencode-emitter（框架标识，UA 驱动）

- **识别**：`rec.userAgent` 以 `cannbot/` 开头（UA 是线上唯一区分信号）→
  `isCannbot` 分支；不影响既有 opencode 路径（红线：native 路径逐字节不变）。
- **cc-session-meta**：`framework: 'cannbot'`，`ccVersion: <UA 提取的 cannbot 版本>`
  （现 regex `^opencode\/` 扩为按 UA 前缀取各自版本）。
- **source marker**：`proxySourceMarker` 增加参数或旁路——cannbot 记录写
  `'cannbot-proxy'`（legacy 通道值，spec §6 双轨；读方 marker map 同步）。
- **wire 协议字段**：`cc-wire-round.protocol` 保持 `'openai'`（协议≠框架，
  spec 该字段语义是线路协议，不需要新值、不升版本）。
- **title-gen 过滤**：沿用 `system` 文本含 `title generator` 判定（fork 大概率
  保留原文；实现后首轮真机验证，见 §8 风险）。

### 5.4 insight 消费侧

- `src/lib/ingest/proxy-classify.ts`：`META_FRAMEWORK_MAP` 增
  `'cannbot' → 'cannbot'`；`MARKER_FRAMEWORK_MAP` 增
  `'cannbot-proxy' → 'cannbot'`（未列举的 `*-proxy` 现默认 claude-code，cannbot
  必须显式列出，否则 marker 兜底路径误判）。
- 徽标（framework='cannbot' 的显示）：`SessionList.tsx`、`LocalFileImport.tsx`
  （CANNBay type 列 + 导入完成态）、`ImportHistory.tsx`（knownFramework）、
  cannbay2 type 列 —— 新增 CANNBot 徽标（variant 建议 `purple` 或 `green`，
  与 OpenCode 蓝 / Claude 橙区分）。
- version 徽标逻辑（`-proxy` 后缀）框架无关，沿用。
- 语义面板（Skills 覆盖度 / agent-content 等按 framework 定位的 API）：cannbot
  首期降级为空面板（其 skill 目录约定未考证）；context-window 经
  `context-windows.json` 可配，兜底默认。

**决策点（已选推荐项）**：framework 用独立值 `'cannbot'`（对位 opencode/
claude-code/codex 三值并列，type 全链路可见、可徽标化）而非归并为 'opencode'
——后者零 insight 改动但 type 列显示错（用户核心诉求是 type 可见性），且后续
无法区分 CANN 旗舰 agent 的行为画像。

### 5.5 normalize 层：零改动（布局归一与框架无关，红线：内容解释在 insight 侧）

## 6. schema spec 合规清单（docs/cannbay-schema-spec.md）

| 条款 | 要求 | 本方案 |
|---|---|---|
| §1 信封冻结 | type/timestamp/message 不碰 | ✅ 复用 claude 信封 |
| §1 加可选字段不升版本 | framework 是开放字符串（§4.4 示例即 `"..."`） | ✅ `'cannbot'` 新值不升 version；spec §4.4 注记补充 |
| §2 物理布局 | `sessions/<sid>/` + `cpx-` 前缀捕获 | ✅ writer 原样 |
| §3 单一归属/声明式分发 | 扩展进 `x_cannbay` 口袋 | ✅ 全部复用既有 payload（cc-wire-round/cc-wire-input/cc-session-meta），**零新 schema** |
| §4.1 protocol | `'anthropic'\|'openai'` 线路协议 | ✅ cannbot = openai，不加值 |
| §4.4 producer=cpx | framework/ccVersion 权威 | ✅ `framework:'cannbot'`、`ccVersion:'1.1.2'` |
| §6 双轨 | legacy 顶层 `source` 同值并存 | ✅ `source:'cannbot-proxy'`（新 marker 值，读方 map 同步） |
| §1 形状校验测试 | payload 改动配套 | ✅ 新增 cannbot-producer 形状锁（§7） |

## 7. 测试方案

- **proxy 单测**（proxy/tests，仿 opencode-emitter.test.ts）：
  - UA `cannbot/1.1.2` 的 openai 协议记录 → meta `framework:'cannbot'` +
    `ccVersion:'1.1.2'` + 行 `source:'cannbot-proxy'`；UA `opencode/1.18` 路径
    逐字节不变（回归锁）。
  - session-resolver：`X-Session-Id` 头（大小写原样传入）→ sid 解析命中（已有
    用例组补一条大小写变体）。
  - cpx-cli：导出 `parseArgs`/provider 解析/上游解析做纯函数单测
    （`cannbot` → profile + provider 集含 `cannbot` + 上游链 config→常量）。
- **schema 形状锁**（tests/cannbay-schema.test.ts ⑥ 对位）：cannbot-producer
  形状锁（meta 双值 + wire-round 字段齐全性）。
- **insight IT**（闭环）：合成 cannbot 捕获 fixture（UA/头/网关形态）→ 导入 →
  `Session.framework='cannbot'`、`version='1.1.2-proxy'` 形态（版本徽标规则）、
  subagent 桥接、type 列可见；上传 cannbay2 → 列表 type=CANNBot。
- **真机验证**（一次性，需已 /connect 的 cannbot）：`cpx cannbot` 跑一轮对话 →
  捕获文件非空、meta 正确、insight 在跑则退出即自动导入（否则保留捕获，insight UI 导入）、
  全链路面板；同时验证 title-gen
  过滤与 config 合并语义（§8 风险 1/2）。

## 8. 风险与开放问题

| 风险 | 应对 |
|---|---|
| config 层 baseURL 覆盖对内建 cannbot provider 的合并语义未经真机验证（高置信：`/connect` 自己就写该路径） | 真机验证步骤置前；失败则 fallback 方案 B——cpx 预写临时全局 config（退出还原） |
| title-gen 判定依赖 opencode 原文 "title generator"；fork 改写则侧call 混入捕获 | 首轮真机检查 title 请求形态，必要时按 UA/短上下文特征补过滤 |
| 用户在 cannbot 里 `-m opencode/xxx`（providerID 以 opencode 开头）→ 头切换为 `x-opencode-session`，sid 退化为 pinned 占位 id | 可接受（仍捕获，sid 非真实）；文档注明 |
| 网关自定义 fetch 未来改为 URL 带 vkey | 头透传已验证；若变，redactor/governance 关口兜底（密钥形态覆盖） |
| 网关 URL 变更 | 优先级链第一环 = 用户全局 config，可自助改；硬编码仅兜底 |

## 9. 改动清单

| 层 | 文件 | 改动 |
|---|---|---|
| cpx-cli | `proxy/src/cli/cpx-cli.ts` | profile `cannbot`；provider 集；上游解析链 |
| emitter | `proxy/src/opencode-emitter.ts` | UA 驱动 cannbot 分支（meta/marker/ccVersion） |
| marker | `proxy/src/claude-emitter.ts` | `proxySourceMarker` 支持 cannbot |
| insight | `src/lib/ingest/proxy-classify.ts` | 两个 map 各增一项 |
| insight UI | `SessionList` / `LocalFileImport` / `ImportHistory` | CANNBot 徽标 |
| 文档 | `docs/cannbay-schema-spec.md` §4.4 注记、README ×2 | framework 值、cpx cannbot 用法 |
| 版本 | `src/lib/version.ts` +0.01 | 新特性 |
| 测试 | proxy/tests + tests/cannbay-schema.test.ts + insight IT | §7 四项 |

零改动：`server.ts` / `session-resolver.ts` / `writer.ts` / `normalize/` /
claude-jsonl adapter / 核心管线（红线全数保持）。
