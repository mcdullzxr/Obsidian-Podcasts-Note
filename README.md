# Podcast Note — Obsidian 播客笔记插件

把播客从"听过就忘"变成**可搜索、可关联、可复习**的知识资产。

粘贴小宇宙链接 → AI 自动转录 → 生成带时间戳的知识点、案例、大纲、逐字稿，直接存入 Obsidian。

> **早期版本**：当前处于开发测试阶段，欢迎试用反馈。

---

## ✨ 已实现功能

### 🎙️ 播客解析与转录

- **小宇宙**完整支持：自动提取剧集标题、封面、嘉宾、音频链接
- AI 语音转录，支持三家服务商（见下方配置说明）
- 说话人识别（Speaker Diarization），区分主持人与嘉宾
- **转录结果本地缓存**：重新生成笔记时跳过转录，省约 80% 费用

### 💡 AI 智能提炼

LLM 一次性生成以下结构化内容，全部带精确时间戳：

| 产出 | 说明 |
|------|------|
| **摘要** | 3-5 句话概括全期核心 |
| **核心论点** | 一句话总结（整期播客最想传达的观点） |
| **话题聚类** | 按逻辑递进排列（不按时间），每个话题含核心观点 + 案例佐证 |
| **逻辑脉络** | 话题之间的因果/递进关系（如"问题 → 定义 → 案例 → 方法"） |
| **金句** | 2-3 句逐字稿原话，带时间戳 |
| **反思问题** | 引导深度思考（布鲁姆认知的分析/评价层） |
| **关联思考** | 跨领域知识关联提示 |
| **行动建议** | 节目中明确提到的可执行行动 |
| **延伸资源** | 节目提到的书、工具、文章等 |
| **结构化大纲** | 按章节分段，最多两层嵌套 |
| **标签** | 3-8 个主题标签，优先复用 Vault 中已有标签 |

### 🎵 内置播客播放器

侧边栏播放器，无需切换到播客 App：

- **双源播放**：优先本地文件，自动降级到远程 URL
- **速度控制**：1× / 1.25× / 1.5× / 1.75× / 2× / 0.75× 循环切换
- **后退 / 快进 15 秒**快捷按钮
- 切换笔记时**自动加载**对应播客
- 离线保护：笔记同时存储本地路径和远程 URL

### ⏱️ 时间戳交互

- 笔记中所有知识点、案例、金句均附带**可点击时间戳**
- 点击时间戳 → 播放器**立即跳转**到对应位置
- 兼容 Reading View 和 Live Preview 两种编辑模式

### 🔖 边听边标记

- 快捷键 `Ctrl+Shift+B` 插入当前播放时间戳到笔记
- 自动定位到 `## 🔖 我的标记` 区域，无需手动找位置
- 光标停在时间戳后，立即输入备注，不打断听播客的心流

### 🗺️ Canvas 脑图导出

- 一键将播客知识提炼导出为 Obsidian Canvas 脑图
- 三列布局：元数据 · 话题聚类（含案例）· 结构大纲

---

## 🔑 BYOK：自带 API Key

本插件采用 **BYOK（Bring Your Own Key）** 模式，你需要自备 AI 服务的 API Key。

**为什么这样设计？**
- 音频文件只经过你选择的 AI 服务商，不经过任何第三方服务器
- 你完全掌控成本和隐私
- Obsidian 生态惯例（Smart Connections、Text Generator 等均采用）

### 转录服务商（三选一）

| 服务商 | 模型 | 说话人识别 | 文件大小限制 | 参考成本（60分钟） |
|--------|------|:---------:|:----------:|-----------------|
| **OpenAI / 硅基流动** | Whisper v3 | ✗ | < 25 MB | ~¥2.6 |
| **火山引擎豆包** | Seed ASR | ✅ | 无限制 | ~¥0.3–0.7 |
| **阿里云百炼** | Paraformer | ✅ | < 2 GB | ~¥0.4–1.0 |

> 推荐：中短播客用 OpenAI / 硅基流动；超长播客（>1 小时）或需要说话人区分时用火山引擎或阿里云百炼。

### LLM 服务商（任选）

支持所有 **OpenAI 兼容接口**，以及 **Anthropic（Claude）原生协议**：

| 服务商 | 协议 | 参考成本（每期摘要） |
|--------|------|-------------------|
| OpenAI（GPT-4o-mini） | OpenAI | ~¥0.1 |
| DeepSeek | OpenAI | ~¥0.01 |
| 硅基流动 | OpenAI | ~¥0.08 |
| Anthropic（Claude） | Anthropic | ~¥0.2–0.3 |
| 自定义端点（本地部署等） | OpenAI | — |

**综合成本参考（60 分钟中文播客）：**

| 方案 | 费用 |
|------|------|
| OpenAI Whisper + GPT-4o-mini | ~¥2.7 / 期 |
| 硅基流动 Whisper + DeepSeek | ~¥1 / 期以内 |
| 重新生成笔记（复用缓存转录） | ~¥0.01–0.1 / 次 |

---

## 🚀 安装

### 手动安装（当前方式）

```bash
# 1. 克隆到你的 Vault 插件目录
cd /path/to/vault/.obsidian/plugins
git clone https://github.com/your-username/podcast-note
cd podcast-note

# 2. 安装依赖并构建
npm install
npm run build

# 3. 在 Obsidian 设置 → 社区插件 → 已安装插件 中启用 Podcast Note
```

### 开发模式

```bash
npm run dev   # 监听文件变化，自动重建
```

生成的 `main.js`、`manifest.json`、`styles.css` 即为可发布文件。

---

## ⚙️ 配置

插件安装后，进入 **Obsidian 设置 → Podcast Note** 完成以下配置：

1. **转录服务商**：选择 OpenAI / 火山引擎 / 阿里云百炼，填入对应 API Key
2. **LLM 服务商**：填入 API Key、Base URL、模型名称
3. **笔记保存路径**：默认 `Podcasts/`，可自定义
4. **音频下载**（可选）：开启后将音频文件下载到本地，支持离线播放

---

## 📂 项目结构

```
podcast-note/
├── src/
│   ├── main.ts                    # 插件入口、设置面板、命令注册
│   ├── parsers/
│   │   ├── index.ts               # 解析器路由
│   │   ├── types.ts               # PodcastMetadata 类型定义
│   │   └── xiaoyuzhou.ts          # 小宇宙解析器
│   ├── ai/
│   │   ├── types.ts               # 转录类型（TranscriptSegment 等）
│   │   ├── llm-types.ts           # LLM 输出类型（PodcastInsights 等）
│   │   ├── whisper.ts             # 转录统一入口
│   │   ├── llm.ts                 # LLM 提炼（Prompt + 调用）
│   │   └── providers/
│   │       ├── openai-whisper.ts  # OpenAI 兼容转录
│   │       ├── volcengine.ts      # 火山引擎转录
│   │       └── dashscope.ts       # 阿里云百炼转录
│   ├── generators/
│   │   ├── markdown.ts            # Markdown 笔记生成
│   │   └── canvas.ts              # Canvas 脑图生成
│   ├── utils/
│   │   ├── audio.ts               # 音频下载与处理
│   │   ├── episode-id.ts          # 剧集 ID 生成（缓存 key）
│   │   └── transcript-cache.ts    # 转录本地缓存
│   └── views/
│       ├── player-view.ts         # 播客播放器侧边栏
│       ├── timestamp-processor.ts # 时间戳点击跳转
│       └── bookmark-command.ts    # 快捷键标记时间戳
├── manifest.json
├── package.json
├── esbuild.config.mjs
├── tsconfig.json
└── styles.css
```

---

## 🗺️ 开发路线

- [x] 小宇宙链接解析
- [x] OpenAI / 火山引擎 / 阿里云百炼 转录
- [x] LLM 结构化提炼（知识点 / 案例 / 大纲 / 金句等）
- [x] 转录本地缓存
- [x] Markdown 笔记生成（带 YAML Frontmatter）
- [x] Canvas 脑图导出
- [x] 播放器侧边栏（双源 / 速度控制 / 自动加载）
- [x] 时间戳点击跳转
- [x] 快捷键边听边标记
- [ ] RSS 泛用播客支持
- [ ] Spotify 支持
- [ ] 知识原子化 + 双链回溯
- [ ] 浏览器扩展剪藏
- [ ] 播客库仪表盘

---

## 📄 License

MIT
