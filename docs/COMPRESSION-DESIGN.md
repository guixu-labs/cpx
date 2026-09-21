# 捕获文件压缩（7z at rest）完整方案

## 0. 背景与决策结论

> **v0.2.0 起格式从 gzip 升级为 7z**（LZMA2）：jsonl 文本实测压缩率提升
> 30-50%，数据湖仓配额收益直接；代价是退出压缩耗时上升（-mx=9 下约
> 1-5MB/s/核，`CANNBOT_7Z_LEVEL` 可降级提速）与外部 7za 二进制依赖
> （`7zip-bin` npm 预编译随包，离线可用）。读侧三形态永续：明文 `.jsonl` /
> 存量 `.jsonl.gz` / 新 `.jsonl.7z`；存量 gz 上传时 staging 统一转 7z 出仓
> （同 sid 重传整体替换语义天然完成湖内迁移）。7z 档案为确定性产出
> （`-mtm=off -mta=off -mtc=off`，同内容同字节 → 重传幂等不破坏）。

三个诉求收敛为一个方案：**proxy 捕获落盘即压缩（7z）、insight 透明解压读取、
cannbay2 仓存 `.jsonl.7z`**。指纹压缩退役（对外可读性差）；标准 7-Zip 工具
（`7z e -so x.jsonl.7z`）任何机器可解且 bit 级无损。

| 决策点 | 结论 | 理由 |
|---|---|---|
| 压缩格式 | **7z/LZMA2**（`.jsonl.7z`） | 比率高 gzip 30-50%（数据湖配额收益）；`7zip-bin` npm 预编译 7za 随包（离线可用、零系统依赖）；确定性开关保证同内容同字节（重传幂等）；存量 `.jsonl.gz` 读侧永续可读 |
| 压缩时机 | **live 明文、会话关闭压缩** | live 会话 `tail -F`/增量刷新/断点续捕依赖 append；关闭时机确定（cpx-cli 退出路径） |
| insight 导入是否单分一路 | **不分离**，透明读层 | 格式契约相同（claude 信封 + x_cannbay），分离=复制整条管线违反单一 adapter 架构；压缩只是传输编码，属于 I/O 层不属于解析层 |
| 仓内形态 | `sessions/<sid>/<sid>.jsonl.7z` + meta 明文（存量 .jsonl.gz 读侧永续、重传时迁移） | 治理必须对明文做（清洗可审计），治理通过后再压缩出仓 |
| norm/ 镜像 | （已退役，历史条目） | norm 层已随 verbatim 直读退役；本行仅存档 |
| meta.json | **永远明文** | type/framework/version/producer/子代理关联全在 meta；仓列表与分类器零影响 |

## 1. 数据形态总览

```
本地（~/.cannbot-insight/proxy/）
  cpx-<sid>.jsonl.7z          主捕获（会话进行中为 cpx-<sid>.jsonl 明文，退出时压缩）—— insight 直读导入
  cpx-<sid>.meta.json         明文（cc-session-meta）
  <sid>/subagents/<sub>.jsonl.7z + <sub>.meta.json

cannbay2 仓（sessions/<sid>/）
  <sid>.jsonl.7z              治理后压缩件（存量 .jsonl.gz / 明文 .jsonl 永续可读，混合共存）
  <sid>.meta.json             明文
  subagents/<sub>.jsonl.7z + <sub>.meta.json
```

存量明文/存量 gz 文件**不做本地迁移**——读侧三形态都认；上传 staging 统一
ensure7z 出仓（存量 gz 借重传自然迁移到新格式），渐进收敛。

## 2. proxy 侧改动

### 2.1 writer.ts（压缩感知 I/O + 生命周期）

- `readCaptureText(file): string`：`.jsonl.7z` → 7za 解压；`.jsonl.gz` → gunzip（存量）；`.jsonl` → 直读。
  `resolveCapturePath(p)`：p 存在→p；`p+'.gz'` 存在→gz（DB sourcePath 指向
  明文但盘上已压缩的场景）；`p` 去掉 .gz 后存在→明文（resume 解压临时态）。
- `compressCaptureFile(file)`：7za 压缩 → 写 `.7z` → 删明文与同 stem 存量 `.gz`（防双压缩态分叉）。幂等（已压缩态跳过）。
- **resume 生命周期**（关键边界）：`--continue` 复用 sid 时，writer 首次 append
  前若 `cpx-<sid>.jsonl.7z`（或存量 `.jsonl.gz`）存在 → `ensureWritableCapture`
  解压回明文（scratch
  态，删除 .gz 防双份）→ 本次运行明文追加 → 退出时重新压缩。live-append 语义
  完整保留。
- meta 读写不变（明文）。

### 2.2 cpx-cli（退出路径排序）

```
agent 退出 → proxy flush → 读 .sids 清单
  → 对每个产物文件：compressCaptureFile（明文→.7z）
  → triggerIngest（filePath = verbatim .7z 路径 → DB sourcePath 稳定指向 .7z）
  → 清单清理（.sids 删除）
```

压缩在导入**前**：sourcePath 一次定型为 `.7z`，无后续改名悬挂。
（norm/ 镜像层已退役：退出路径直读 verbatim 导入——adapter 双形态透明解压 +
`cpx-` 前缀剥除，verbatim 与 norm 内容逐行相同，双份落盘属纯冗余；
`cpx normalize` 保留为兼容命令。）
- `cpx status`：dedupStats / recent captures 遍历与读内容走 `readCaptureText`
  （.jsonl / .jsonl.7z / .jsonl.gz 都列出）。
- `cpx normalize <sid>`（已退役为兼容命令）：候选路径顺序 `.7z`、`.gz`、明文，
  `<sid>.jsonl`、`cpx-<sid>.jsonl`。
- 异常退出（crash 无清理）：文件留明文——合法形态，下次 cpx 退出路径或手动
  `cpx normalize` 不覆盖，不强制。

### 2.3 normalize/

读侧 `readCaptureText`；输出写 `.jsonl.7z`（布局归一职责不变，仅编码变化）。
`normalizeAll` 遍历同时匹配三形态扩展名。

## 3. insight 侧改动（不分离导入路径，单点读层）

### 3.1 核心改造：`parseJsonlLines`（claude-jsonl.ts:226）

全部捕获读取已经/将收口到这一个函数：内部改用
`readCaptureText(resolveCapturePath(filePath))`。直接消费方清单：

| 文件 | 用途 | 改造 |
|---|---|---|
| `claude-jsonl.ts` parseJsonlLines | 导入管线 + extractVersion | 单点改 |
| `proxy-classify.ts` | 统一分类器（经 parseJsonlLines） | 自动覆盖 |
| `claude-jsonl-full-context.ts` | Full Context / requestParams / wire enrichment（经 parseJsonlLines） | 自动覆盖 |
| `wire-rounds/route.ts` | wire 轮次（经 parseJsonlLines） | 自动覆盖 |
| `data-service.ts` | importSession / deltaRefresh / extractClaudeVersion | 自动覆盖（extractVersion 走 parseJsonlLines）；空占位文件存在性检查改 `resolveCapturePath` |
| `cannbay2/index.ts` patchXCannbayColumns | 物化件读行 | 改走 readCaptureText |

原生 claude（`~/.claude/projects/**`，明文、我们不控制其 writer）：reader 直通，
**零影响**。这就是不分离导入路径的原因——格式契约一致，编码差异消化在 I/O 单点。

### 3.2 live 场景

live 会话盘上是明文（增长中）；本会话 sourcePath 在退出导入时才落库（=.gz），
不与 live 态冲突。跨运行 resume：sourcePath=.gz 但盘上是 resume 解压的明文
scratch → `resolveCapturePath` 第三分支命中，增量刷新照常读明文增长文件。

## 4. cannbay2 侧改动

### 4.1 上传（stageSessionFiles → governStagedSession → uploadFolder）

```
源（.jsonl / .jsonl.7z / .jsonl.gz，含 subagents）
  → staging 拷贝并解压为明文 .jsonl（meta 明文直拷）
  → 治理（governText 明文清洗 + 复检）           ← 可审计性保持在明文域
  → 压缩 staging .jsonl → .jsonl.7z（删明文）
  → 大小检查按压缩后字节（atomgit 限的是这个）
  → push（仓内 .jsonl.7z；存量 gz 源 staging ensure7z 迁移）
```

- 白名单：`.jsonl` / `.json` / **`.jsonl.7z`** / `.jsonl.gz`（存量直传）。
- 直传源（native claude / 旧明文捕获）：拷贝后同样走"治理→压缩"，出仓统一 gz。

### 4.2 物化与导入（materializeSession → importCannbay2Session）

- ls-tree 映射：`<sid>.jsonl.7z|.gz` → `materialized/<sid>.jsonl.同扩展名`（subagents 同）；
  主文件存在性检查同时接受两种后缀；旧明文仓件照旧物化为 `.jsonl`。
- importCannbay2Session → importSession → parseJsonlLines 透明解压。
- patchXCannbayColumns 读行改 readCaptureText。
- list / readSessionMetas / type 列：meta 明文，零改动。

## 5. 指纹压缩回退（commit 5735dc9b 外科手术）

保留：subagents 随行 `cpx-` 前缀修复、提交人网关。
移除：`compactWireRedundancy` 及调用、大会话压缩 IT、README 压缩句、超限报错
文案还原。**仓上已存在的指纹压缩件不迁移**（合法 jsonl，读方兼容；未来该 sid
重传覆盖为 .gz 自然收敛）。

## 6. 测试方案

- **writer 单测**：压缩/解压往返 bit 级一致；resume 生命周期（gz→明文追加→再 gz）；
  resolveCapturePath 三分支。
- **insight IT**：.gz fixture → importSession（turns/usage/subagent/Full Context
  全量）；.gz 走分类器（meta 路径 + 行级路径）；sourcePath=.gz 的 wire-rounds；
  明文 fixture 回归不变。
- **cannbay2 IT**：压缩源上传 → 仓内 `.jsonl.7z`（白名单过）→ 治理仍拦密钥
  （明文域清洗可验证：下载解压重跑 governText 零残留）→ 物化 → 导入对账；
  旧明文仓件混合共存导入。
- **cpx 退出链路**：模拟产物压缩→normalize→import 顺序（单测编排函数）。

## 7. 改动清单

| 层 | 文件 | 改动 |
|---|---|---|
| proxy | `writer.ts` | readCaptureText / resolveCapturePath / compressCaptureFile / ensureWritableCapture |
| proxy | `cli/cpx-cli.ts` | 退出路径排序（压缩→normalize→import）；status/normalize .gz 支持 |
| proxy | `normalize/` | 读写 .gz |
| insight | `claude-jsonl.ts` | parseJsonlLines 压缩感知（单点） |
| insight | `data-service.ts` | 空占位存在性检查 resolveCapturePath |
| insight | `cannbay2/index.ts` | 回退指纹压缩；staging 解压→治理→压缩；白名单；patch 读行；大小检查 |
| insight | `cannbay2/mirror.ts` | materialize 双后缀映射 |
| 文档 | spec §2 布局 + README ×2 | .jsonl.7z 形态声明（"压缩是传输编码，信封与 x_cannbay 契约不变"；存量 .gz 永续可读） |
| 版本 | 1.92 → 1.93 | 特性 |

零改动：claude-jsonl adapter 解析逻辑、分类器判定、Full Context 解析、核心
管线、meta 契约、原生 claude 路径。
