# cpx E2E 测试套件

端到端测试框架（架构对齐 insight/opsbot 的 E2E 纪律，形态按 cpx 的真实栈
适配——cpx 无浏览器无 DB，它的「用户」是 agent 进程，它的「栈」是一次
真实的捕获会话）。设计原则一句话：**被测物必须是真实启动形态，唯一的
stub 是上游模型 API**。

## 真栈单层（与 insight 的映射）

| insight E2E | cpx 等价物 |
|---|---|
| 真构建 + `next start` | 真 wrapper：`bash cpx-cli` → tsx → 真源码（绝不 import 源码进测试进程） |
| 真库 e2e.db | 真文件系统捕获目录（`CONTEXT_PROXY_DIR` 隔离，绝写用户 `~/.context-insight`） |
| 真浏览器 | 真 agent 子进程（假 agent = 最小但真实的协议客户端：真 spawn 真 fetch 真 SSE drain） |
| 唯一 stub：不真打 LLM | 唯一 stub：上游模型 API（三协议剧本化应答 + 全量请求台账） |
| 播种即冒烟（真导入管道） | 捕获即产品：退出链整链锁（manifest → 压缩 → insight 导入契约） |
| browserConsole 验收门 | 契约哨兵 + 密钥零泄漏哨兵（见下） |
| teardown 端口回收不变量 | 泄漏进程不变量（run-tests.sh e2e 收尾 pgrep fail-fast） |

## harness/（六件套，spec 一律引用不自带）

```
harness/
├── constants.ts     # 单一事实源：wrapper 路径、env 契约名、三协议路由、
│                    #   sid 头锚——契约改名一处红
├── sandbox.ts       # 环境隔离五件套（cpx 版）：
│                    #   1. CONTEXT_PROXY_DIR → 一次性 tmp
│                    #   2. HOME → 一次性 tmp（claude/codex/opencode 配置读取面）
│                    #   3. 出口代理 env 剥净（proxy→upstream 跳恒直连本机桩）
│                    #   4. cpx 契约 env 重钉（insight 不可达防机会主义导入 +
│                    #      CONTEXT_NO_BROWSER 防弹窗；agent 端点发现变量默认剥除）
│                    #   5. bin/ 前置 PATH（假 agent / 假 npx / open 桩）
│                    #   外加 XDG 三目录（opencode/cannbot 配置面）
├── upstream-stub.ts # 假上游模型 API：sse/json/raw/stall 四类剧本 +
│                    #   请求台账（透传对账事实源）
├── fake-agent.ts    # 假 agent 工厂：claude（--settings 反解）/ codex
│                    #   （-c openai_base_url 反解）/ openai（env 直读）三标准件
├── capture.ts       # 捕获断言：三形态（明文/.7z/.gz）透明解压复用生产件
│                    #   readCaptureText + 两个验收哨兵（见下）
└── session.ts       # runCpx（wrapper 旅程）/ runCommand（安装态 bin 等
                     #   非 wrapper 入口）/ spawnProxy（proxy 层直起 IT）
```

## 验收哨兵（绿用例若违反产品承诺即判负）

1. **claude-jsonl 消费契约哨兵**（`assertClaudeJsonlContract`）：cpx 的全部
   价值出口是「insight 零改动消费」——每行可解析、user/assistant 形状齐备、
   扩展数据走 `(schema,version)` 声明的 x_lake 信封。生产者侧锁死（消费侧
   insight 的 claude-jsonl 适配器另有其测）。
2. **密钥零泄漏哨兵**（`assertNoSecrets`）：捕获全文（透明解压）对机密串
   零命中。必须与「上游台账收到了认证头」成对出现——只证其一不是完整证明
   （只证上游收到 = 没测 redactor；只证捕获没有 = 没测透传）。

## spec 清单（20 文件 / 59 用例，两代同架构）

**协议全链路旅程**（三协议各一条完整链路：注入面 → 路由面 → 转换面 → 消费面）
- `cpx-wire-anthropic.e2e.test.ts` — Anthropic Messages（流式 + 非流；sid 头路由）
- `cpx-wire-responses.e2e.test.ts` — OpenAI Responses（codex 通道；钉定路由）
- `cpx-reasoning-capture.e2e.test.ts` — OpenAI Chat（DeepSeek 思考流回归）

**产品承诺旅程**
- `cpx-passthrough-fidelity.e2e.test.ts` — 透传 byte 保真 + 密钥零泄漏
- `cpx-session-lifecycle.e2e.test.ts` — 退出收尾整链（manifest → 7z at-rest →
  governed 标记 → mock insight 导入契约）

**对话连续性与多会话**
- `cpx-multi-round.e2e.test.ts` — 多轮增量（回显不重落 / roundIndex 递增）、
  /resume 侧滚动（双 sid 双文件）、注入去重（[已压缩] 占位 + fingerprint）、
  title-gen 跳过（零捕获零残留）

**子代理旅程（三框架 + dsh，全部落到 <父sid>/subagents/ 同布局）**
- `cpx-subagent-claude.e2e.test.ts` — Agent 工具派发 → meta 回链；**异步回填序**
  （子代理 emit 先于父派发收集 → pendingSubMeta 挂起后补写——真实竞态的锁）
- `cpx-subagent-opencode.e2e.test.ts` — x-parent-session-id 声明式路由 +
  task 工具族派发回链
- `cpx-subagent-codex.e2e.test.ts` — spawn_agent 派发（message 直传形态）→
  function_call_output 富化（agentId/nickname 重写）→ 父守卫；**压缩 resync**
  （append-only 锚失配 → multiset 差分，摘要有/历史无/零重复）
- `cpx-dsh-journey.e2e.test.ts` — wire 自描述框架标签（body.dsh_session_log，
  与注入契约无关的识别机制）+ body 血缘路由 + descriptor 事件 → meta

**provider 隧道**
- `cpx-opencode-wire.e2e.test.ts` — opencode 全链路（注入反解 → /<pid>/ 前缀
  隧道 → 剥前缀直达上游 → 捕获）；cannbot UA 分流（协议≠框架）

**韧性与边界**
- `cpx-resilience.e2e.test.ts` — 上游 5xx 透传零吞、SIGINT 收尾（130 +
  dropSessionScratch + `cpx status` 活/死观测）、1MB 大体量双向保真、gzip
  请求体（转发字节不动 + 捕获透明解压，两半各证一半）、并发到达序
  （落盘序=到达序≠完成序——ordered-dispatch 核心承诺）、陈旧占位启动清扫
  （0 字节 + 无伴生 meta 才算占位；带 meta 的是真实会话产物，绝不误删）

**注入与解析契约**
- `cpx-upstream-resolution.e2e.test.ts` — 全框架上游解析镜像契约（13 用例）
- `cpx-standalone.e2e.test.ts` — opencode 2.x --standalone 探测注入（7 形态）
- `cpx-custom-provider.e2e.test.ts` — 自定义 provider 捕获
- `cpx-project-provider.e2e.test.ts` — 项目级 provider 捕获

**CLI 面**
- `cpx-cli-surface.e2e.test.ts` — --version/--help（版本单源）、completion
  （bash 词表 + __complete 候选）、list（framework/protocol 列 + at-rest）、
  config dedup on 联动（热开关走文件——与 multi-round 的 env override 互为
  另一半）

**基础设施层**
- `cpx-hoist-tsx.e2e.test.ts` — npm 安装 hoist 布局的 tsx 启动链
- `cpx-nonstream-stall.e2e.test.ts` — 非流失败墓碑（proxy 直起层）
- `cannbot-pack.e2e.test.ts` — npm pack 产物品牌审计（无进程，不涉 harness）

## 已知陷阱（新 spec 前必读）

- **responses 转发剥 `/v1`**：proxy 转发 responses 协议时剥路径前缀 `/v1`
  还原 codex 直连 `base + /responses` 字节形态——上游桩的路由键是
  `/responses` 不是 `/v1/responses`。
- **vitest worker 死锁**：进程内起的 HTTP 监听器（桩/命名上游）必须配
  **async** spawn 跑 cpx——spawnSync 阻塞 worker 事件循环，监听器无法
  accept（结构性死锁）。harness `runCpx` 恒 async。
- **at-rest 压缩**：cpx 退出后捕获是 `.jsonl.7z`（明文已删）——断言读取
  一律走 `readCaptureLines`/`readCaptureText`（三形态透明解压），别裸读
  `.jsonl`。
- **claude 注入走 argv 不走 env**：cpx 用 `--settings '{"env":…}'` 注入
  （进程作用域，不碰用户 settings 文件）——假 claude agent 必须从 argv
  反解（这本身就是注入契约的断言面）。
- **codex 注入走 `-c`**：ChatGPT 登录分支注入 `-c openai_base_url="…/v1"`；
  沙箱剥除 `OPENAI_API_KEY` 保证确定性落在该分支。
- **占位文件**：proxy 启动即预创建钉定 sid 的 0 字节占位；流量全走头路由
  时退出会清掉——断言「钉定文件不存在」是头路由的反向证明。
- **provider 隧道路由键不带 `/v1`**：opencode/cannbot 隧道剥 `/<pid>/` 前缀后
  转发 `PROVIDER_UPSTREAMS[pid] + path`——桩路由键取决于配置 baseURL 的
  形态（`stub` 根 → `/chat/completions`；`stub + /v1` → `/v1/chat/...`）。
  同理 agent 侧拼 URL 时注入的 baseURL **尾斜杠不可剥**（SDK 相对拼接语义）。
- **probeHelp 探测噪声**：opencode/cannbot profile 启动时 cpx 会跑
  `agentCmd --help` 探测子命令面——假 agent 在探测期（无注入 env）必须秒退
  且**别把「注入缺席」标记写进响应落盘文件**（harness 走独立 `.noinject` 落盘），
  否则会污染透传对账。睡眠型 agent 尤其要 `[ -z "$注入变量" ] && exit 0`。
- **全量并行的 status 断言**：spec 文件并行时多会话代理共存是常态——
  `cpx status` 的进程计数断言会漂移，只能做 **sid 定向断言**（本会话 sid
  在场/退场）。泄漏判定只归套件收尾的 pgrep 不变量。
- **泄漏进程不变量的边界**：e2e 收尾 pgrep 锚定本仓 `src/server.ts` 全路径。
  用同一 checkout 正在跑真实捕获会话时跑 e2e 会误报——先停会话再跑套件。
- **排障现场**：`CPX_E2E_KEEP=1` 保留沙箱目录（临时路径打印在失败信息里）。

## 运行

```bash
npm test        # ut + e2e 一条命令全覆盖（提交前门禁）
npm run test:ut # 快速回路（无进程开销）
npm run test:e2e
```

e2e 层结束后 run-tests.sh 自查泄漏代理进程（fail-fast）。CI/本地同一条
命令，无环境分叉。
