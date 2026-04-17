# Podcast Note — Obsidian 播客笔记插件

把播客从"听过就忘"变成**可搜索、可关联、可复习**的知识资产。

粘贴小宇宙 / RSS / Spotify 链接 → AI 自动生成带时间戳的逐字稿、摘要、知识点卡片和结构化大纲，直接保存为 Obsidian 笔记。

## ✨ 功能

- 🎙️ 播客链接解析（小宇宙 / RSS / Spotify）
- 📝 AI 语音转录（带时间戳 + 说话人区分）
- 💡 AI 智能提炼（摘要 / 知识点 / 案例 / 大纲 / 标签）
- 📄 纯 Markdown 输出，卸载插件后笔记仍可用
- 🗺️ Canvas 脑图导出（计划中）
- 🔗 知识原子化 + 双链回溯（计划中）

## 🔑 BYOK：自带 API Key

本插件采用 **BYOK（Bring Your Own Key）** 模式：你需要自备 AI 服务 API Key。

**为什么？**
- 你的音频数据只经过你选择的 AI 服务商，不经过任何第三方
- 开发者 0 运营成本，可以专注做功能
- Obsidian 生态惯例（Smart Connections、Text Generator 等均采用）

**成本参考（60 分钟中文播客）：**

| 方案 | 成本 |
|---|---|
| OpenAI（Whisper + GPT-4o-mini） | ~¥2.7/期 |
| DeepSeek + 硅基流动 | ~¥1/期 以内 |

详细的 API Key 申请教程见 [docs/setup-guide.md](docs/setup-guide.md)（计划中）。

## 🚀 安装与开发

### 开发调试

```bash
# 1. 克隆到任意 Vault 的 .obsidian/plugins/ 目录下
cd /path/to/vault/.obsidian/plugins
git clone <this-repo> podcast-note
cd podcast-note

# 2. 安装依赖
npm install

# 3. 开发模式（监听文件变化自动重建）
npm run dev

# 4. 在 Obsidian 设置 → 社区插件 中启用 Podcast Note
```

### 生产构建

```bash
npm run build
```

生成的 `main.js`、`manifest.json`、`styles.css` 即为可发布文件。

## 📂 项目结构

```
obsidian-podcast-note/
├── src/
│   ├── main.ts              # 插件入口 + 设置面板
│   ├── parsers/             # 播客平台解析器（规划中）
│   ├── ai/                  # AI 转录与提炼（规划中）
│   ├── generators/          # 笔记生成（规划中）
│   └── utils/               # 工具函数
├── manifest.json
├── package.json
├── esbuild.config.mjs
├── tsconfig.json
├── styles.css
└── CLAUDE.md                # 项目设计文档
```

## 🗺️ 开发路线

- [x] Phase 0：项目初始化 + 设置面板
- [ ] Phase 1（MVP）：粘贴小宇宙/RSS 链接 → Whisper 转录 → AI 摘要/知识点/大纲 → 生成笔记
- [ ] Phase 2：Spotify 支持
- [ ] Phase 3：Canvas 脑图导出 + 知识原子化
- [ ] Phase 4：浏览器扩展剪藏
- [ ] Phase 5：播客库仪表盘 + 复习系统

## 📄 License

MIT
