# 经验沉淀：从返工中学到的

> 归档时间：2026-04-17
> 上下文：MVP 开发期间踩了 4 个大坑（CORS、Whisper 413、LLM 404、MiniMax 协议不对）

---

## 一、本次返工回顾

| # | 问题 | 根因 | 浪费的工作量 |
|---|------|------|------------|
| 1 | `Failed to fetch` | 在 Obsidian 里用原生 `fetch` 会被 CORS 拦 | 1 次排查 + 1 次改造 |
| 2 | Whisper 413 | 用错了服务商（MiniMax 根本没有转录服务） | 从单 provider 重构为多 provider dispatcher |
| 3 | LLM 404 | MiniMax 端点路径不是 `/v1/chat/completions` | 加 `resolveChatEndpoint` 兜底 |
| 4 | MiniMax M2.7 还是 404 | M2.7 系列根本不走 OpenAI 协议，用 Anthropic 协议 | 再次重构，加协议字段 + 分支实现 |

**规律：四个坑都可以在编码前 30 分钟 API 调研里避免。**

---

## 二、可沉淀的工程经验

### 1. **API 调研前置化**（最重要）

动手写代码前，必须先完成一张「API 兼容矩阵」：

| 服务商 | 有转录吗 | 有 LLM 吗 | LLM 协议 | 端点格式 | 鉴权方式 | 关键坑 |
|--------|---------|----------|---------|---------|---------|-------|
| OpenAI | ✅ Whisper | ✅ | OpenAI | `/v1/chat/completions` | Bearer | — |
| MiniMax | ❌ | ✅ | **Anthropic**（M2.7）/ OpenAI（M2-her）| `/anthropic/v1/messages` | `x-api-key` | 协议/端点都和别人不一样 |
| 火山 SeedASR | ✅ | — | — | 异步 submit+query | `X-Api-Key` | 要轮询 |
| 通义 Paraformer | ✅ | — | — | 异步 submit+poll+fetch | Bearer | 三步走 |

**做完这张表再动手，不会出现 MVP 写完又返工的情况。**

### 2. **默认遵循"有抽象层"的架构**

多 provider 场景下，一开始就该用 dispatcher 模式：

```
dispatcher.ts  → 按 config.provider 分发
providers/
  ├─ openai.ts
  ├─ anthropic.ts
  └─ volcengine.ts
```

**不要先"写死一个 provider 再重构"**——前两次重构都是因为这个。

### 3. **BYOK 产品的铁律**

- 别假设"我的 key 能用 → 别人的 key 也能用"：套餐/协议/端点都可能不同
- UI 里要把**协议**独立成选项，不要和"服务商"耦合（同一服务商可能有多套协议）
- 默认值要**可覆盖**，不要写死

### 4. **Obsidian 插件专属经验**

- 所有 HTTP 请求用 `requestUrl`，绝不用 `fetch`（CORS 只有在桌面版没法 workaround）
- 二进制用 `vault.createBinary`，文本用 `vault.create`
- 设置项改变要 `await this.plugin.saveSettings()`，UI 需要刷新用 `this.display()`
- `Notice` 仅用于通知，错误用 `console.error` 才能在 DevTools 里看到 stack

### 5. **错误信息暴露到终端**

每次调用第三方 API 失败时，一定要把 `response.status + response.text.slice(0, 300)` 抛出来。调试时省 5 倍时间。

---

## 三、下次项目的启动清单（Checklist）

在写第一行代码之前：

- [ ] **产品调研**：同类竞品至少看 3 家，列出功能差异表
- [ ] **API 调研表**：所有要集成的第三方服务，列清楚协议/端点/鉴权/限流/价格
- [ ] **最小架构图**：至少画一个"谁调谁"的框图
- [ ] **数据结构**：核心类型（TranscriptSegment、PodcastMeta、LlmConfig）先写 TS interface
- [ ] **目录结构**：按"职责"分，不按"功能"分（parsers/ ai/ generators/ 而不是 xiaoyuzhou/ minimax/）
- [ ] **扩展点预埋**：即使只接一家，也要留 provider 抽象——多加 30 分钟，省一天重构

---

## 四、关于"是否要完美规划再动手"的平衡

**不是所有事都要提前想清楚**，但要区分：

| 类型 | 做法 |
|------|------|
| **外部依赖**（API、协议、鉴权）| 必须前置调研，返工成本高 |
| **内部实现**（算法、UI 细节）| 可以边做边改，返工成本低 |
| **架构骨架**（目录、抽象层）| 轻量前置，预留扩展点 |
| **业务逻辑**（prompt、模板）| 快速迭代，不需要规划 |

**原则：高返工成本的事前置，低返工成本的事快速试错。**

---

## 五、本项目的遗留技术债

- `llm.ts` 里 OpenAI 和 Anthropic 两个分支内联了，后面如果加第三个协议（Gemini）应该拆 provider
- `main.ts` 越来越长，建议后面把设置 UI 单独抽成 `settings-tab.ts`
- 没有 eval/自动化测试，prompt 改动靠肉眼
- 没有音频缓存策略，同一期节目重试会重复转录（烧钱）

---

## 六、给未来的自己

> 下次做 BYOK 类产品，先花半天做"API 兼容矩阵"，再花半小时画"provider 抽象"的目录结构，然后再写代码。
> 这一个小时的投入，能省掉两轮重构。
