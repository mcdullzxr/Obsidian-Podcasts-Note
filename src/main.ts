import { App, Plugin, PluginSettingTab, Setting, Notice, Modal, TextComponent, TFile, normalizePath, getAllTags } from "obsidian";
import { parsePodcastUrl } from "./parsers";
import { transcribeAudio } from "./ai/whisper";
import { generateInsights, segmentsToPromptText } from "./ai/llm";
import { renderNote, renderFilename } from "./generators/markdown";

/**
 * 插件设置项
 * 首版聚焦 BYOK：用户填自己的 API Key。
 */
interface PodcastNoteSettings {
	// --- AI 服务配置（BYOK）---
	llmProvider: "openai" | "deepseek" | "siliconflow" | "minimax" | "claude" | "custom";
	/** LLM 协议类型：openai 兼容 vs anthropic (Claude / MiniMax M2.7) */
	llmProtocol: "openai" | "anthropic";
	llmApiKey: string;
	llmBaseUrl: string;
	llmModel: string;

	whisperProvider: "openai" | "siliconflow" | "volcengine" | "dashscope" | "custom";
	whisperApiKey: string;
	whisperBaseUrl: string;
	whisperModel: string;
	/** 火山引擎专用：Resource ID（如 volc.seedasr.auc） */
	whisperResourceId: string;

	// --- 笔记输出配置 ---
	notesFolder: string;
	filenameTemplate: string;
	includeTranscript: boolean;
}

const DEFAULT_SETTINGS: PodcastNoteSettings = {
	llmProvider: "openai",
	llmProtocol: "openai",
	llmApiKey: "",
	llmBaseUrl: "https://api.openai.com/v1",
	llmModel: "gpt-4o-mini",

	whisperProvider: "openai",
	whisperApiKey: "",
	whisperBaseUrl: "https://api.openai.com/v1",
	whisperModel: "whisper-1",
	whisperResourceId: "volc.seedasr.auc",

	notesFolder: "Podcasts",
	filenameTemplate: "{{date}}-{{title}}",
	includeTranscript: true,
};

export default class PodcastNotePlugin extends Plugin {
	settings!: PodcastNoteSettings;

	async onload() {
		await this.loadSettings();

		// 左侧 ribbon 按钮
		this.addRibbonIcon("podcast", "从播客链接生成笔记", () => {
			new PodcastUrlModal(this.app, (url) => {
				this.handlePodcastUrl(url);
			}).open();
		});

		// 命令面板
		this.addCommand({
			id: "create-from-url",
			name: "从播客链接生成笔记",
			callback: () => {
				new PodcastUrlModal(this.app, (url) => {
					this.handlePodcastUrl(url);
				}).open();
			},
		});

		// 设置面板
		this.addSettingTab(new PodcastNoteSettingTab(this.app, this));
	}

	onunload() {
		// 清理逻辑（目前无需清理资源）
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * 处理播客链接的主流程入口。
	 * 1. 解析元数据
	 * 2. 下载音频 + Whisper 转录
	 * 3. LLM 生成结构化产出
	 * 4. 渲染 Markdown 并写入 Vault
	 */
	private async handlePodcastUrl(url: string): Promise<void> {
		if (!url) {
			new Notice("请输入播客链接");
			return;
		}

		// ========= 1. 解析元数据 =========
		const step1 = new Notice("📡 正在解析播客页面…", 0);
		let meta;
		try {
			meta = await parsePodcastUrl(url);
		} catch (err) {
			step1.hide();
			this.notifyError("解析失败", err);
			return;
		}
		step1.hide();
		new Notice(`✅ 已识别：${meta.podcastName} · ${meta.title}`, 3000);

		// ========= 2. 转录 =========
		const step2 = new Notice("🎙️ 正在下载音频并转录（可能需要数分钟）…", 0);
		let transcript;
		try {
			transcript = await transcribeAudio(meta.audioUrl, {
				provider: this.mapWhisperProvider(this.settings.whisperProvider),
				apiKey: this.settings.whisperApiKey,
				baseUrl: this.settings.whisperBaseUrl,
				model: this.settings.whisperModel,
				resourceId: this.settings.whisperResourceId,
			});
		} catch (err) {
			step2.hide();
			this.notifyError("转录失败", err);
			return;
		}
		step2.hide();
		new Notice(`✅ 转录完成（${transcript.segments.length} 段）`, 3000);

		// ========= 3. LLM 提炼 =========
		const step3 = new Notice("🧠 正在生成摘要、知识点、大纲…", 0);
		let insights;
		try {
			insights = await generateInsights(
				{
					podcastName: meta.podcastName,
					episodeTitle: meta.title,
					description: meta.description,
					transcriptWithTimestamps: segmentsToPromptText(transcript.segments),
					existingTags: this.collectExistingTags(),
				},
				{
					protocol: this.settings.llmProtocol,
					apiKey: this.settings.llmApiKey,
					baseUrl: this.settings.llmBaseUrl,
					model: this.settings.llmModel,
				}
			);
		} catch (err) {
			step3.hide();
			this.notifyError("AI 提炼失败", err);
			return;
		}
		step3.hide();

		// ========= 4. 写入笔记 =========
		try {
			const body = renderNote(meta, insights, transcript, {
				filenameTemplate: this.settings.filenameTemplate,
				includeTranscript: this.settings.includeTranscript,
			});
			const file = await this.writeNote(meta, body);
			new Notice(`🎉 笔记已生成：${file.path}`, 5000);
			this.app.workspace.getLeaf(false).openFile(file);
		} catch (err) {
			this.notifyError("笔记写入失败", err);
		}
	}

	/**
	 * 收集 Vault 中所有已有的标签，用于 LLM 标签复用。
	 */
	private collectExistingTags(): string[] {
		const tagSet = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const tags = getAllTags(cache) || [];
			for (const t of tags) tagSet.add(t.replace(/^#/, ""));
		}
		return Array.from(tagSet).sort();
	}

	/**
	 * 把笔记内容写入 Vault，自动确保文件夹存在并处理重名。
	 */
	private async writeNote(meta: Awaited<ReturnType<typeof parsePodcastUrl>>, body: string): Promise<TFile> {
		const folder = normalizePath(this.settings.notesFolder || "Podcasts");
		if (!(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder);
		}

		const baseName = renderFilename(meta, this.settings.filenameTemplate);
		let finalPath = normalizePath(`${folder}/${baseName}.md`);
		let counter = 1;
		while (await this.app.vault.adapter.exists(finalPath)) {
			finalPath = normalizePath(`${folder}/${baseName} (${counter}).md`);
			counter++;
		}
		return this.app.vault.create(finalPath, body);
	}

	private notifyError(prefix: string, err: unknown): void {
		const msg = err instanceof Error ? err.message : String(err);
		new Notice(`${prefix}：${msg}`, 8000);
		console.error(`[Podcast Note] ${prefix}:`, err);
	}

	/**
	 * 把 UI 层的 provider 选项映射到 whisper dispatcher 支持的三种类型。
	 * openai / siliconflow / custom 共用 OpenAI 兼容路径。
	 */
	private mapWhisperProvider(
		uiProvider: PodcastNoteSettings["whisperProvider"]
	): "openai" | "volcengine" | "dashscope" {
		if (uiProvider === "volcengine") return "volcengine";
		if (uiProvider === "dashscope") return "dashscope";
		return "openai";
	}
}

/**
 * 粘贴链接的输入弹窗
 */
class PodcastUrlModal extends Modal {
	private onSubmit: (url: string) => void;
	private inputEl!: HTMLInputElement;

	constructor(app: App, onSubmit: (url: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "粘贴播客链接" });
		contentEl.createEl("p", {
			text: "支持小宇宙、Spotify、泛用 RSS 播客链接。",
			cls: "setting-item-description",
		});

		const input = new TextComponent(contentEl);
		input.setPlaceholder("https://www.xiaoyuzhoufm.com/episode/...");
		input.inputEl.style.width = "100%";
		this.inputEl = input.inputEl;

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		buttonRow.style.marginTop = "12px";
		buttonRow.style.display = "flex";
		buttonRow.style.justifyContent = "flex-end";
		buttonRow.style.gap = "8px";

		const cancelBtn = buttonRow.createEl("button", { text: "取消" });
		cancelBtn.addEventListener("click", () => this.close());

		const submitBtn = buttonRow.createEl("button", { text: "生成", cls: "mod-cta" });
		submitBtn.addEventListener("click", () => {
			const url = this.inputEl.value.trim();
			this.close();
			this.onSubmit(url);
		});

		// 允许回车提交
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				submitBtn.click();
			}
		});

		// 自动聚焦
		setTimeout(() => this.inputEl.focus(), 10);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * 设置页（BYOK 配置 + 笔记输出配置）
 */
class PodcastNoteSettingTab extends PluginSettingTab {
	plugin: PodcastNotePlugin;

	constructor(app: App, plugin: PodcastNotePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Podcast Note 设置" });
		containerEl.createEl("p", {
			text: "本插件采用 BYOK（Bring Your Own Key）模式：您需要提供自己的 AI 服务 API Key。插件不会上传或代理任何数据。",
			cls: "setting-item-description",
		});

		// ============ LLM 配置 ============
		containerEl.createEl("h3", { text: "大语言模型（摘要 / 知识点 / 大纲）" });

		new Setting(containerEl)
			.setName("LLM 服务商")
			.setDesc("选择你使用的 AI 服务商。DeepSeek、硅基流动成本低；MiniMax Token Plan 走 Anthropic 协议。")
			.addDropdown((dd) =>
				dd
					.addOption("openai", "OpenAI")
					.addOption("deepseek", "DeepSeek")
					.addOption("siliconflow", "硅基流动")
					.addOption("minimax", "MiniMax（Token Plan / Anthropic）")
					.addOption("claude", "Claude 官方")
					.addOption("custom", "自定义（OpenAI 兼容）")
					.setValue(this.plugin.settings.llmProvider)
					.onChange(async (value) => {
						this.plugin.settings.llmProvider = value as PodcastNoteSettings["llmProvider"];
						this.applyProviderDefaults("llm", value);
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("LLM 协议")
			.setDesc(
				"OpenAI 兼容: 大多数服务商（OpenAI / DeepSeek / 硅基流动 / 自定义）。Anthropic: Claude 官方、MiniMax M2.7 / M2.5 / M2.1 / M2。"
			)
			.addDropdown((dd) =>
				dd
					.addOption("openai", "OpenAI 兼容（/chat/completions）")
					.addOption("anthropic", "Anthropic（/v1/messages）")
					.setValue(this.plugin.settings.llmProtocol)
					.onChange(async (value) => {
						this.plugin.settings.llmProtocol = value as PodcastNoteSettings["llmProtocol"];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("LLM API Key")
			.setDesc("请妥善保管，不要分享给他人。")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.llmApiKey)
					.onChange(async (value) => {
						this.plugin.settings.llmApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("LLM Base URL")
			.setDesc("OpenAI 兼容 API 的基础地址。")
			.addText((text) =>
				text
					.setPlaceholder("https://api.openai.com/v1")
					.setValue(this.plugin.settings.llmBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.llmBaseUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("LLM 模型")
			.setDesc("推荐 gpt-4o-mini / deepseek-chat 等性价比高的模型。")
			.addText((text) =>
				text
					.setPlaceholder("gpt-4o-mini")
					.setValue(this.plugin.settings.llmModel)
					.onChange(async (value) => {
						this.plugin.settings.llmModel = value.trim();
						await this.plugin.saveSettings();
					})
			);

		// ============ Whisper 配置 ============
		containerEl.createEl("h3", { text: "语音转录" });

		new Setting(containerEl)
			.setName("转录服务商")
			.setDesc(
				"火山引擎 / 通义（DashScope）支持 URL 直接提交，无大小限制，推荐用于长播客。"
			)
			.addDropdown((dd) =>
				dd
					.addOption("volcengine", "火山引擎（豆包）")
					.addOption("dashscope", "通义（阿里云 Paraformer）")
					.addOption("siliconflow", "硅基流动")
					.addOption("openai", "OpenAI Whisper")
					.addOption("custom", "自定义（OpenAI 兼容）")
					.setValue(this.plugin.settings.whisperProvider)
					.onChange(async (value) => {
						this.plugin.settings.whisperProvider =
							value as PodcastNoteSettings["whisperProvider"];
						this.applyProviderDefaults("whisper", value);
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Whisper API Key")
			.setDesc(
				this.plugin.settings.whisperProvider === "volcengine"
					? "火山新版控制台的 API Key（以 X-Api-Key 方式鉴权）。"
					: this.plugin.settings.whisperProvider === "dashscope"
						? "阿里云百炼（DashScope）的 API Key。"
						: "OpenAI 兼容服务的 API Key。"
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.whisperApiKey)
					.onChange(async (value) => {
						this.plugin.settings.whisperApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		// 仅火山显示 Resource ID
		if (this.plugin.settings.whisperProvider === "volcengine") {
			new Setting(containerEl)
				.setName("火山 Resource ID")
				.setDesc(
					"volc.seedasr.auc = 豆包 2.0（推荐，效果更好）；volc.bigasr.auc = 豆包 1.0。"
				)
				.addText((text) =>
					text
						.setPlaceholder("volc.seedasr.auc")
						.setValue(this.plugin.settings.whisperResourceId)
						.onChange(async (value) => {
							this.plugin.settings.whisperResourceId =
								value.trim() || "volc.seedasr.auc";
							await this.plugin.saveSettings();
						})
				);
		}

		// 仅 OpenAI 兼容模式显示 Base URL
		if (
			this.plugin.settings.whisperProvider === "openai" ||
			this.plugin.settings.whisperProvider === "siliconflow" ||
			this.plugin.settings.whisperProvider === "custom"
		) {
			new Setting(containerEl)
				.setName("Whisper Base URL")
				.addText((text) =>
					text
						.setPlaceholder("https://api.openai.com/v1")
						.setValue(this.plugin.settings.whisperBaseUrl)
						.onChange(async (value) => {
							this.plugin.settings.whisperBaseUrl = value.trim();
							await this.plugin.saveSettings();
						})
				);
		}

		// 火山固定为 bigmodel，不需要模型字段
		if (this.plugin.settings.whisperProvider !== "volcengine") {
			new Setting(containerEl)
				.setName("Whisper 模型")
				.setDesc(
					this.plugin.settings.whisperProvider === "dashscope"
						? "推荐 paraformer-v2（支持中文多方言 + 英日韩）。"
						: "OpenAI: whisper-1；硅基流动: FunAudioLLM/SenseVoiceSmall"
				)
				.addText((text) =>
					text
						.setPlaceholder("whisper-1")
						.setValue(this.plugin.settings.whisperModel)
						.onChange(async (value) => {
							this.plugin.settings.whisperModel = value.trim();
							await this.plugin.saveSettings();
						})
				);
		}

		// ============ 笔记输出 ============
		containerEl.createEl("h3", { text: "笔记输出" });

		new Setting(containerEl)
			.setName("笔记保存路径")
			.setDesc("相对 Vault 根目录的文件夹路径。")
			.addText((text) =>
				text
					.setPlaceholder("Podcasts")
					.setValue(this.plugin.settings.notesFolder)
					.onChange(async (value) => {
						this.plugin.settings.notesFolder = value.trim() || "Podcasts";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("文件名模板")
			.setDesc("可用变量：{{date}}、{{title}}、{{podcast}}。")
			.addText((text) =>
				text
					.setPlaceholder("{{date}}-{{title}}")
					.setValue(this.plugin.settings.filenameTemplate)
					.onChange(async (value) => {
						this.plugin.settings.filenameTemplate = value.trim() || "{{date}}-{{title}}";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("在笔记中包含逐字稿")
			.setDesc("关闭后仅生成摘要/知识点/大纲。")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.includeTranscript).onChange(async (value) => {
					this.plugin.settings.includeTranscript = value;
					await this.plugin.saveSettings();
				})
			);
	}

	/**
	 * 根据服务商切换默认 Base URL / 模型，减少用户手动配置。
	 */
	private applyProviderDefaults(kind: "llm" | "whisper", provider: string): void {
		const s = this.plugin.settings;
		if (kind === "llm") {
			switch (provider) {
				case "openai":
					s.llmProtocol = "openai";
					s.llmBaseUrl = "https://api.openai.com/v1";
					s.llmModel = "gpt-4o-mini";
					break;
				case "deepseek":
					s.llmProtocol = "openai";
					s.llmBaseUrl = "https://api.deepseek.com/v1";
					s.llmModel = "deepseek-chat";
					break;
				case "siliconflow":
					s.llmProtocol = "openai";
					s.llmBaseUrl = "https://api.siliconflow.cn/v1";
					s.llmModel = "Qwen/Qwen2.5-7B-Instruct";
					break;
				case "minimax":
					// MiniMax Token Plan 主推 Anthropic 协议 + MiniMax-M2.7
					s.llmProtocol = "anthropic";
					s.llmBaseUrl = "https://api.minimaxi.com/anthropic";
					s.llmModel = "MiniMax-M2.7";
					break;
				case "claude":
					s.llmProtocol = "anthropic";
					s.llmBaseUrl = "https://api.anthropic.com";
					s.llmModel = "claude-3-5-sonnet-latest";
					break;
			}
		} else {
			switch (provider) {
				case "openai":
					s.whisperBaseUrl = "https://api.openai.com/v1";
					s.whisperModel = "whisper-1";
					break;
				case "siliconflow":
					s.whisperBaseUrl = "https://api.siliconflow.cn/v1";
					s.whisperModel = "FunAudioLLM/SenseVoiceSmall";
					break;
				case "volcengine":
					// 火山不需要 baseUrl/model，由 provider 实现固定
					s.whisperResourceId = s.whisperResourceId || "volc.seedasr.auc";
					break;
				case "dashscope":
					// DashScope 端点固定，只需 Key + 模型
					s.whisperModel = "paraformer-v2";
					break;
			}
		}
	}
}
