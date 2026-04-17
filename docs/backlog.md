# 待优化事项清单（Backlog）

> 更新时间：2026-04-18
> 说明：按优先级排序，明天从 P0 开始

---

## P0 — v0.2 追平通义基础体验

### 1. 音频下载 + 时间戳跳转 ⭐ 最优先
- [ ] 在 parser 里保留 audio URL，新增下载步骤
- [ ] 下载到 `Podcasts/attachments/{episodeId}.mp3`
- [ ] 用 `requestUrl` + `vault.createBinary` 实现
- [ ] 设置项：新增「下载音频到本地」开关（默认关，音频较大）
- [ ] Markdown 生成器：把 `[mm:ss]` 改成 `[mm:ss](audio.mp3#t=秒数)` 支持点击跳转
- [ ] 笔记顶部插入 `![[xxx.mp3]]` 嵌入播放器
- [ ] 提示用户音频大小（50-100MB 常见）

### 2. 发言人识别
- [ ] `TranscriptSegment` 类型新增 `speaker?: string` 字段
- [ ] 火山 provider：请求加 `enable_speaker_info: true`，解析 `speaker` 字段
- [ ] 通义 provider：请求加 `diarization_enabled: true` + `speaker_count`
- [ ] OpenAI Whisper 明确不支持，UI 上灰显该功能
- [ ] 逐字稿渲染：`**[12:34] 发言人1：** ...`
- [ ] （可选）让 LLM 根据内容猜测"发言人1 = 主持人 / 发言人2 = 嘉宾张三"

### 3. 章节速览（每章一句摘要）
- [ ] LLM prompt 增加 chapters 字段：`[{time, title, summary}]`
- [ ] Markdown 生成器新增「章节速览」段落
- [ ] 章节标题也带时间戳跳转链接

### 4. Q&A 卡片提取
- [ ] LLM prompt 增加 qas 字段：`[{question, answer, time}]`
- [ ] 适合访谈类播客，普通演讲类可为空
- [ ] Markdown 用 callout 渲染：`> [!question]` + `> [!answer]`

---

## P1 — v0.3 Obsidian 独占优势

### 5. 知识点原子笔记 + 双链
- [ ] 设置项：「知识点拆分为独立笔记」开关
- [ ] 每个 `[!abstract]` 知识点生成独立笔记到 `Podcasts/KnowledgePoints/`
- [ ] 主笔记里用 `[[双链]]` 引用
- [ ] 独立笔记里反向链接到源播客

### 6. 嘉宾/书籍作为双链实体
- [ ] `guests: ["[[张三]]", "[[李四]]"]` 格式
- [ ] LLM 识别"提到的书"，在笔记里用 `[[书名]]`
- [ ] 设置一个"实体汇总"目录

### 7. Dataview 仪表盘模板
- [ ] 提供 README 样例：播客列表、按月统计、标签云
- [ ] 提供"嘉宾最多的节目"、"热门话题"这类查询片段

---

## P2 — v0.4 惊艳功能

### 8. Chat with Episode
- [ ] 命令：在播客笔记上右键「和本期对话」
- [ ] 打开侧边栏，把逐字稿作为 context 灌给 LLM
- [ ] 支持流式返回

### 9. Mentioned Books / Tools 自动识别
- [ ] LLM prompt 增加 mentionedBooks / mentionedTools / mentionedPeople
- [ ] 在 frontmatter 里记录为数组
- [ ] 在笔记底部单独成段

### 10. 金句卡片导出为图片
- [ ] 选中某个 callout → 命令「导出为图片」
- [ ] 用 canvas 渲染成海报风格图
- [ ] 保存到 attachments 里

### 11. 自动关联 Vault 现有笔记
- [ ] 生成前调用 Obsidian 搜索 API 找相关笔记
- [ ] 在新笔记底部加「相关阅读」段落

---

## 技术债（T-Debt）

- [ ] `llm.ts` 拆 provider（第三个协议如 Gemini 加入时处理）
- [ ] `main.ts` 拆出 `settings-tab.ts`
- [ ] 引入 prompt eval/snapshot 测试
- [ ] 音频转录结果缓存（避免重跑烧钱）
- [ ] 音频下载后持久化转录结果到文件
- [ ] 错误提示改进（Notice + DevTools 都要清晰）

---

## 开发流程改进

- [ ] 写完 v0.2 后，回头用 [项目启动手册](./lessons-learned.md#三项目启动手册可复用-playbook) 复盘一次
- [ ] 每个大版本前先补一轮竞品调研（看看别人是否出了新功能）
- [ ] 引入 CHANGELOG.md（面向用户的版本日志）
- [ ] 发布到 Obsidian 社区插件市场前，先私测至少 1 周
