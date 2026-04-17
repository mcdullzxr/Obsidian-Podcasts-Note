import { App, Plugin, PluginSettingTab, Setting, Notice, Modal, TextComponent } from "obsidian";

/**
 * 插件设置项
 * 首版聚焦 BYOK：用户填自己的 API Key。
 */
interface PodcastNoteSettings {
	// --- AI 服务配置（BYOK）---
	llmProvider: "openai" | "deepseek" | "siliconflow" | "custom";
	llmApiKey: string;
	llmBaseUrl: string;
	llmModel: string;

	whisperProvider: "openai" | "siliconflow" | "custom";
	whisperApiKey: string;
	whisperBaseUrl: string;
	whisperModel: string;

	// --- 笔记输出配置 ---
	notesFolder: string;
	filenameTemplate: string;
	includeTranscript: boolean;
}

const DEFAULT_SETTINGS: PodcastNoteSettings = {
	llmProvider: "openai",
	llmApiKey: "",
	llmBaseUrl: "https://api.openai.com/v1",
	llmModel: "gpt-4o-mini",

	whisperProvider: "openai",
	whisperApiKey: "",
	whisperBaseUrl: "https://api.openai.com/v1",
	whisperModel: "whisper-1",

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
	 * 处理播客链接的主流程入口（骨架）。
	 * 实际的解析、转录、AI 提炼将在后续迭代中实现。
	 */
	private async handlePodcastUrl(url: string): Promise<void> {
		if (!url) {
			new Notice("请输入播客链接");
			return;
		}
		new Notice(`收到链接：${url}\n解析与转录功能待实现`);
		// TODO:
		// 1. parsers/ 识别平台并提取元数据
		// 2. ai/whisper 下载音频并转录
		// 3. ai/llm 生成摘要、知识点、大纲
		// 4. generators/markdown 写入 Vault
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
			.setDesc("选择你使用的 AI 服务商。DeepSeek、硅基流动等国内服务成本更低。")
			.addDropdown((dd) =>
				dd
					.addOption("openai", "OpenAI")
					.addOption("deepseek", "DeepSeek")
					.addOption("siliconflow", "硅基流动")
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
		containerEl.createEl("h3", { text: "语音转录（Whisper）" });

		new Setting(containerEl)
			.setName("转录服务商")
			.setDesc("可与 LLM 使用不同服务商。硅基流动提供 Whisper 免费/低价选项。")
			.addDropdown((dd) =>
				dd
					.addOption("openai", "OpenAI Whisper")
					.addOption("siliconflow", "硅基流动")
					.addOption("custom", "自定义")
					.setValue(this.plugin.settings.whisperProvider)
					.onChange(async (value) => {
						this.plugin.settings.whisperProvider = value as PodcastNoteSettings["whisperProvider"];
						this.applyProviderDefaults("whisper", value);
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Whisper API Key")
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

		new Setting(containerEl)
			.setName("Whisper 模型")
			.addText((text) =>
				text
					.setPlaceholder("whisper-1")
					.setValue(this.plugin.settings.whisperModel)
					.onChange(async (value) => {
						this.plugin.settings.whisperModel = value.trim();
						await this.plugin.saveSettings();
					})
			);

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
					s.llmBaseUrl = "https://api.openai.com/v1";
					s.llmModel = "gpt-4o-mini";
					break;
				case "deepseek":
					s.llmBaseUrl = "https://api.deepseek.com/v1";
					s.llmModel = "deepseek-chat";
					break;
				case "siliconflow":
					s.llmBaseUrl = "https://api.siliconflow.cn/v1";
					s.llmModel = "Qwen/Qwen2.5-7B-Instruct";
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
			}
		}
	}
}
