import { App, Plugin, PluginSettingTab, Setting, Notice, Modal, TextComponent, TFile, normalizePath, getAllTags, setIcon } from "obsidian";
import { parsePodcastUrl } from "./parsers";
import type { PodcastMetadata } from "./parsers/types";
import { transcribeAudio } from "./ai/whisper";
import { generateInsights, segmentsToPromptText } from "./ai/llm";
import { renderNote, renderFilename } from "./generators/markdown";
import { saveAudioToVault } from "./utils/audio";
import { getEpisodeId } from "./utils/episode-id";
import { getCachedTranscript, saveCachedTranscript, removeCachedTranscript } from "./utils/transcript-cache";
import { PodcastPlayerView, PLAYER_VIEW_TYPE } from "./views/player-view";
import type { EpisodeInfo } from "./views/player-view";
import { registerTimestampProcessor, activatePlayerView } from "./views/timestamp-processor";
import { registerBookmarkCommand } from "./views/bookmark-command";
import { renderCanvas } from "./generators/canvas";

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
	/** LLM 最大输出 token（默认 8000，长播客建议 16000） */
	llmMaxTokens: number;

	whisperProvider: "openai" | "siliconflow" | "volcengine" | "dashscope" | "custom";
	whisperApiKey: string;
	whisperBaseUrl: string;
	whisperModel: string;
	/** 火山引擎专用：Resource ID（如 volc.seedasr.auc） */
	whisperResourceId: string;
	/** 说话人识别（仅 volcengine / dashscope 支持） */
	whisperEnableDiarization: boolean;
	/** 预期说话人数（仅 dashscope 有效，0 = 自动判断） */
	whisperSpeakerCount: number;

	// --- 笔记输出配置 ---
	notesFolder: string;
	filenameTemplate: string;
	includeTranscript: boolean;

	// --- 音频下载与时间戳跳转 ---
	/** 下载音频到本地 Vault（开启后支持时间戳跳转与离线回听） */
	downloadAudioLocal: boolean;
	/** 在笔记顶部嵌入 Obsidian 原生播放器 */
	embedAudioPlayer: boolean;
	/** 首次启用下载开关时弹同步排除提醒的一次性标记 */
	hasShownAudioSyncTip: boolean;
	/** 生成笔记时同步生成 Canvas 脑图（默认关） */
	generateCanvas: boolean;
}

const DEFAULT_SETTINGS: PodcastNoteSettings = {
	llmProvider: "openai",
	llmProtocol: "openai",
	llmApiKey: "",
	llmBaseUrl: "https://api.openai.com/v1",
	llmModel: "gpt-4o-mini",
	llmMaxTokens: 20000,

	whisperProvider: "openai",
	whisperApiKey: "",
	whisperBaseUrl: "https://api.openai.com/v1",
	whisperModel: "whisper-1",
	whisperResourceId: "volc.seedasr.auc",
	whisperEnableDiarization: true,
	whisperSpeakerCount: 0,

	notesFolder: "Podcasts",
	filenameTemplate: "{{date}}-{{title}}",
	includeTranscript: true,

	downloadAudioLocal: false,
	embedAudioPlayer: true,
	hasShownAudioSyncTip: false,
	generateCanvas: false,
};

export default class PodcastNotePlugin extends Plugin {
	settings!: PodcastNoteSettings;

	async onload() {
		await this.loadSettings();

		// === 注册播客播放器侧边栏 View ===
		this.registerView(PLAYER_VIEW_TYPE, (leaf) => new PodcastPlayerView(leaf));

		// === 注册时间戳点击跳转 ===
		registerTimestampProcessor(this);

		// === 注册用户标记命令 ===
		registerBookmarkCommand(this);

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

		// 打开/切换播放器面板
		this.addCommand({
			id: "toggle-player",
			name: "打开播客播放器",
			callback: () => {
				activatePlayerView(this);
			},
		});

		// 播放/暂停切换
		this.addCommand({
			id: "play-pause",
			name: "播放 / 暂停",
			callback: () => {
				const view = this.getPlayerView();
				if (view) view.togglePlay();
			},
		});

		// 快进/快退
		this.addCommand({
			id: "skip-forward",
			name: "快进 15 秒",
			callback: () => {
				const view = this.getPlayerView();
				if (view) view.seekTo(view.getCurrentTime() + 15);
			},
		});

		this.addCommand({
			id: "skip-backward",
			name: "后退 15 秒",
			callback: () => {
				const view = this.getPlayerView();
				if (view) view.seekTo(Math.max(0, view.getCurrentTime() - 15));
			},
		});

		// 重新生成当前笔记（复用缓存，只重跑 LLM）
		this.addCommand({
			id: "regenerate-note",
			name: "重新生成当前播客笔记（复用转录缓存）",
			callback: () => {
				this.regenerateCurrentNote();
			},
		});

		// 清除当前笔记的转录缓存
		this.addCommand({
			id: "clear-transcript-cache",
			name: "清除当前笔记的转录缓存",
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice("请先打开一篇播客笔记");
					return;
				}
				const fm = this.app.metadataCache.getFileCache(activeFile)?.frontmatter;
				if (!fm?.source) {
					new Notice("当前笔记没有播客元数据");
					return;
				}
				const meta: PodcastMetadata = {
					title: fm.title || activeFile.basename,
					podcastName: fm.podcast || "",
					publishDate: fm.date || "",
					audioUrl: fm.audio_url || "",
					sourceUrl: fm.source,
					platform: this.detectPlatform(fm.source),
				};
				await removeCachedTranscript(this.app.vault, getEpisodeId(meta));
				new Notice("✅ 转录缓存已清除，下次生成将重新调用 Whisper");
			},
		});

		// 为当前笔记按需生成 Canvas 脑图
		this.addCommand({
			id: "generate-canvas",
			name: "为当前播客笔记生成 Canvas 脑图",
			callback: () => {
				this.generateCanvasForCurrentNote();
			},
		});

		// 设置面板
		this.addSettingTab(new PodcastNoteSettingTab(this.app, this));

		// === 切换笔记时自动加载音频到播放器 ===
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				// 延迟等待 metadataCache 就绪
				setTimeout(() => this.autoLoadAudioForActiveNote(), 300);
			})
		);
	}

	/**
	 * 当切换到播客笔记时，自动将音频加载到播放器。
	 * 判断依据：frontmatter 中有 audio 或 audio_url 字段。
	 */
	private autoLoadAudioForActiveNote(): void {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;

		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		if (!fm) return;

		const localAudioPath = fm.audio as string | undefined;
		const remoteAudioUrl = fm.audio_url as string | undefined;
		if (!localAudioPath && !remoteAudioUrl) return;

		// 检查播放器是否已加载同一笔记
		const playerView = this.getPlayerView();
		if (playerView) {
			const currentEpisode = playerView.getEpisode();
			if (currentEpisode?.notePath === file.path) return; // 已加载，无需重复
		}

		// 有播放器就加载，没有就不主动创建（避免每次打开笔记都弹出播放器）
		if (playerView) {
			playerView.loadEpisode({
				title: (fm.title as string) || file.basename,
				podcastName: (fm.podcast as string) || "",
				sourceUrl: (fm.source as string) || "",
				localAudioPath,
				remoteAudioUrl,
				notePath: file.path,
			});
		}
	}

	onunload() {
		// 清理播放器 View
		this.app.workspace.detachLeavesOfType(PLAYER_VIEW_TYPE);
	}

	/** 获取播放器 View 实例 */
	getPlayerView(): PodcastPlayerView | null {
		const leaves = this.app.workspace.getLeavesOfType(PLAYER_VIEW_TYPE);
		if (leaves.length === 0) return null;
		return leaves[0].view as PodcastPlayerView;
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
	 * 2. （可选）下载音频到本地
	 * 3. 转录（优先读缓存，省钱）
	 * 4. LLM 生成结构化产出
	 * 5. 渲染 Markdown 并写入 Vault
	 */
	private async handlePodcastUrl(url: string): Promise<void> {
		if (!url) {
			new Notice("请输入播客链接");
			return;
		}

		const progress = new ProgressNotice([
			"解析播客页面",
			"下载音频到本地",
			"语音转录",
			"AI 提炼",
			"写入笔记",
			...(this.settings.generateCanvas ? ["生成脑图"] : []),
		]);

		// ========= 1. 解析元数据 =========
		progress.advance("📡 正在解析播客页面…");
		let meta;
		try {
			meta = await parsePodcastUrl(url);
		} catch (err) {
			progress.error("解析失败", err);
			return;
		}
		progress.detail(`已识别：${meta.podcastName} · ${meta.title}`);

		// ========= 2. 可选：下载音频到本地 =========
		let localAudioPath: string | undefined;
		if (this.settings.downloadAudioLocal) {
			progress.advance("⬇️ 正在下载音频到本地…");
			try {
				const folder = normalizePath(`${this.settings.notesFolder || "Podcasts"}/attachments`);
				const basename = getEpisodeId(meta);
				const saved = await saveAudioToVault(this.app.vault, folder, basename, meta.audioUrl);
				localAudioPath = saved.path;
				progress.detail(saved.reused ? `♻️ 音频已存在，复用` : `✅ 音频已保存`);
			} catch (err) {
				// 下载失败不阻断主流程，降级为纯文本时间戳
				const msg = err instanceof Error ? err.message : String(err);
				progress.detail(`⚠️ 音频下载失败，回退到远程播放：${msg}`);
				console.error("[Podvault] 音频下载失败:", err);
			}
		} else {
			progress.skip(); // 跳过"下载音频到本地"这一步
		}

		// ========= 3. 转录（优先读缓存） =========
		const episodeId = getEpisodeId(meta);
		const cached = await getCachedTranscript(this.app.vault, episodeId);
		let transcript;

		if (cached) {
			progress.advance("♻️ 已有转录缓存，跳过 Whisper");
			transcript = cached;
			progress.detail(`缓存命中（${transcript.segments.length} 段）`);
		} else {
			progress.advance("🎙️ 正在下载音频并转录（可能需要数分钟）…");
			try {
				transcript = await transcribeAudio(meta.audioUrl, {
					provider: this.mapWhisperProvider(this.settings.whisperProvider),
					apiKey: this.settings.whisperApiKey,
					baseUrl: this.settings.whisperBaseUrl,
					model: this.settings.whisperModel,
					resourceId: this.settings.whisperResourceId,
					enableSpeakerDiarization: this.supportsDiarization(this.settings.whisperProvider)
						? this.settings.whisperEnableDiarization
						: false,
					speakerCount:
						this.settings.whisperProvider === "dashscope" &&
						this.settings.whisperEnableDiarization
							? this.settings.whisperSpeakerCount
							: undefined,
				});
			} catch (err) {
				progress.error("转录失败", err);
				return;
			}
			// 保存到缓存
			try {
				await saveCachedTranscript(this.app.vault, episodeId, transcript);
			} catch (e) {
				console.warn("[Podvault] 缓存保存失败（不影响主流程）:", e);
			}
			progress.detail(`转录完成（${transcript.segments.length} 段）`);
		}

		// ========= 4. LLM 提炼 =========
		progress.advance("🧠 正在生成摘要、知识点、大纲…");
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
					maxTokens: this.settings.llmMaxTokens,
				}
			);
		} catch (err) {
			progress.error("AI 提炼失败", err);
			return;
		}

		// ========= 5. 写入笔记 =========
		progress.advance("📝 正在写入笔记…");
		try {
			const body = renderNote(meta, insights, transcript, {
				filenameTemplate: this.settings.filenameTemplate,
				includeTranscript: this.settings.includeTranscript,
				localAudioPath,
				embedAudioPlayer: this.settings.embedAudioPlayer,
				notesFolder: this.settings.notesFolder || "Podcasts",
				remoteAudioUrl: meta.audioUrl,
			});
			const file = await this.writeNote(meta, body);

			// ========= 6. 可选：生成 Canvas 脑图 =========
			if (this.settings.generateCanvas) {
				progress.advance("🗺️ 正在生成 Canvas 脑图…");
				try {
					const canvasContent = renderCanvas(meta, insights);
					const canvasPath = file.path.replace(/\.md$/, ".canvas");
					const existing = this.app.vault.getAbstractFileByPath(canvasPath);
					if (existing instanceof TFile) {
						await this.app.vault.modify(existing, canvasContent);
					} else {
						await this.app.vault.create(canvasPath, canvasContent);
					}
					// 在笔记顶部插入脑图链接
					const mdContent = await this.app.vault.read(file);
					const canvasBasename = canvasPath.split("/").pop()!;
					if (!mdContent.includes(canvasBasename)) {
						await this.app.vault.modify(file, insertCanvasLink(mdContent, canvasBasename));
					}
					progress.detail(`脑图已保存：${canvasPath}`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					progress.detail(`⚠️ 脑图生成失败（不影响主流程）：${msg}`);
					console.error("[Podvault] 脑图生成失败:", err);
				}
			}

			progress.finish(`🎉 笔记已生成：${file.path}`);

			// 打开笔记
			this.app.workspace.getLeaf(false).openFile(file);

			// 自动打开侧边栏播放器并加载音频
			const episodeInfo: EpisodeInfo = {
				title: meta.title,
				podcastName: meta.podcastName,
				sourceUrl: meta.sourceUrl,
				localAudioPath,
				remoteAudioUrl: meta.audioUrl,
				notePath: file.path,
			};
			const playerView = await activatePlayerView(this);
			if (playerView) {
				playerView.loadEpisode(episodeInfo);
			}
		} catch (err) {
			progress.error("笔记写入失败", err);
		}
	}

	/**
	 * 「重新生成」：读取当前笔记的 frontmatter + 缓存转录，只重跑 LLM，覆盖笔记内容。
	 * 适合 LLM 出错或想换模板/模型时使用。
	 */
	private async regenerateCurrentNote(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || activeFile.extension !== "md") {
			new Notice("请先打开一篇播客笔记");
			return;
		}

		// 读取 frontmatter
		const cache = this.app.metadataCache.getFileCache(activeFile);
		const fm = cache?.frontmatter;
		if (!fm || !fm.source) {
			new Notice("当前笔记没有播客元数据（缺少 source 字段）");
			return;
		}

		// 从 frontmatter 重建 PodcastMetadata
		const meta: PodcastMetadata = {
			title: fm.title || activeFile.basename,
			podcastName: fm.podcast || "",
			publishDate: fm.date || new Date().toISOString().slice(0, 10),
			duration: fm.duration,
			description: "",
			audioUrl: fm.audio_url || "",
			sourceUrl: fm.source,
			platform: this.detectPlatform(fm.source),
		};

		const episodeId = getEpisodeId(meta);
		const transcript = await getCachedTranscript(this.app.vault, episodeId);
		if (!transcript) {
			new Notice("未找到转录缓存。请先用「从播客链接生成笔记」完整生成一次。");
			return;
		}

		const progress = new ProgressNotice([
			"读取缓存",
			"AI 提炼",
			"覆盖笔记",
			...(this.settings.generateCanvas ? ["生成脑图"] : []),
		]);

		progress.advance("♻️ 已加载转录缓存");
		progress.detail(`${transcript.segments.length} 段，跳过 Whisper`);

		// LLM 重跑
		progress.advance("🧠 正在重新生成摘要、知识点、大纲…");
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
					maxTokens: this.settings.llmMaxTokens,
				}
			);
		} catch (err) {
			progress.error("AI 提炼失败", err);
			return;
		}

		// 覆写笔记
		progress.advance("📝 正在覆盖笔记…");
		try {
			const localAudioPath = fm.audio || undefined;
			const body = renderNote(meta, insights, transcript, {
				filenameTemplate: this.settings.filenameTemplate,
				includeTranscript: this.settings.includeTranscript,
				localAudioPath,
				embedAudioPlayer: this.settings.embedAudioPlayer,
				notesFolder: this.settings.notesFolder || "Podcasts",
				remoteAudioUrl: fm.audio_url || undefined,
			});
			await this.app.vault.modify(activeFile, body);

			// ========= 可选：同步生成 Canvas 脑图 =========
			if (this.settings.generateCanvas) {
				progress.advance("🗺️ 正在生成 Canvas 脑图…");
				try {
					const canvasContent = renderCanvas(meta, insights);
					const canvasPath = activeFile.path.replace(/\.md$/, ".canvas");
					const existing = this.app.vault.getAbstractFileByPath(canvasPath);
					if (existing instanceof TFile) {
						await this.app.vault.modify(existing, canvasContent);
					} else {
						await this.app.vault.create(canvasPath, canvasContent);
					}
					// 如果笔记中还没有脑图链接，插入一个
					const refreshed = await this.app.vault.read(activeFile);
					const canvasBasename = canvasPath.split("/").pop()!;
					if (!refreshed.includes(canvasBasename)) {
						await this.app.vault.modify(activeFile, insertCanvasLink(refreshed, canvasBasename));
					}
					progress.detail(`脑图已保存：${canvasPath}`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					progress.detail(`⚠️ 脑图生成失败（不影响主流程）：${msg}`);
					console.error("[Podvault] 脑图生成失败:", err);
				}
			}

			progress.finish(`🎉 笔记已重新生成：${activeFile.path}`);
		} catch (err) {
			progress.error("笔记写入失败", err);
		}
	}

	/**
	 * 为当前笔记按需生成 Canvas 脑图。
	 * 需要已有转录缓存；无缓存时提示用户先生成笔记。
	 */
	private async generateCanvasForCurrentNote(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || activeFile.extension !== "md") {
			new Notice("请先打开一篇播客笔记");
			return;
		}

		const cache = this.app.metadataCache.getFileCache(activeFile);
		const fm = cache?.frontmatter;
		if (!fm || !fm.source) {
			new Notice("当前笔记没有播客元数据（缺少 source 字段）");
			return;
		}

		const meta: PodcastMetadata = {
			title: fm.title || activeFile.basename,
			podcastName: fm.podcast || "",
			publishDate: fm.date || new Date().toISOString().slice(0, 10),
			duration: fm.duration,
			description: "",
			audioUrl: fm.audio_url || "",
			sourceUrl: fm.source,
			platform: this.detectPlatform(fm.source),
		};

		const episodeId = getEpisodeId(meta);
		const transcript = await getCachedTranscript(this.app.vault, episodeId);
		if (!transcript) {
			new Notice("未找到转录缓存，请先用「从播客链接生成笔记」完整生成一次。");
			return;
		}

		const progress = new ProgressNotice(["读取缓存", "AI 提炼", "生成脑图"]);
		progress.advance("♻️ 已加载转录缓存");
		progress.detail(`${transcript.segments.length} 段`);

		progress.advance("🧠 正在提炼知识点…");
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
					maxTokens: this.settings.llmMaxTokens,
				}
			);
		} catch (err) {
			progress.error("AI 提炼失败", err);
			return;
		}

		progress.advance("🗺️ 正在生成脑图…");
		try {
			const canvasContent = renderCanvas(meta, insights);
			const canvasPath = activeFile.path.replace(/\.md$/, ".canvas");
			const existing = this.app.vault.getAbstractFileByPath(canvasPath);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, canvasContent);
			} else {
				await this.app.vault.create(canvasPath, canvasContent);
			}
			// 在笔记顶部插入脑图链接（已有则跳过）
			const mdContent = await this.app.vault.read(activeFile);
			const canvasBasename = canvasPath.split("/").pop()!;
			if (!mdContent.includes(canvasBasename)) {
				await this.app.vault.modify(activeFile, insertCanvasLink(mdContent, canvasBasename));
			}
			progress.finish(`🎉 脑图已生成：${canvasPath}`);
			// 分栏打开 Canvas
			const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
			if (canvasFile instanceof TFile) {
				this.app.workspace.getLeaf("split").openFile(canvasFile);
			}
		} catch (err) {
			progress.error("脑图生成失败", err);
		}
	}

	/**
	 * 从 URL 推断平台类型
	 */
	private detectPlatform(url: string): PodcastMetadata["platform"] {
		if (/xiaoyuzhoufm\.com/.test(url)) return "xiaoyuzhou";
		if (/spotify\.com/.test(url)) return "spotify";
		return "unknown";
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
	 * 递归确保路径上的所有文件夹都存在。
	 * 支持 `A/B/C` 多级路径。
	 */
	private async ensureFolder(folderPath: string): Promise<void> {
		const folder = normalizePath(folderPath);
		if (await this.app.vault.adapter.exists(folder)) return;
		// 先确保父目录存在
		const parent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
		if (parent) await this.ensureFolder(parent);
		await this.app.vault.createFolder(folder);
	}

	/**
	 * 把笔记内容写入 Vault，自动确保文件夹存在并处理重名。
	 */
	private async writeNote(meta: Awaited<ReturnType<typeof parsePodcastUrl>>, body: string): Promise<TFile> {
		const folder = normalizePath(this.settings.notesFolder || "Podcasts");
		await this.ensureFolder(folder);

		const baseName = renderFilename(meta, this.settings.filenameTemplate);
		let finalPath = normalizePath(`${folder}/${baseName}.md`);
		let counter = 1;
		while (await this.app.vault.adapter.exists(finalPath)) {
			finalPath = normalizePath(`${folder}/${baseName} (${counter}).md`);
			counter++;
		}
		return this.app.vault.create(finalPath, body);
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

	/**
	 * OpenAI Whisper / 硅基流动 / 自定义（OpenAI 兼容）都不返回 speaker。
	 * 仅火山引擎和通义支持说话人识别。
	 */
	private supportsDiarization(
		uiProvider: PodcastNoteSettings["whisperProvider"]
	): boolean {
		return uiProvider === "volcengine" || uiProvider === "dashscope";
	}
}

/**
 * 在 Markdown 内容的 frontmatter 结尾处插入 Canvas 脑图链接。
 * 找到第二个 '---' 行，在其后插入链接行。
 */
function insertCanvasLink(mdContent: string, canvasBasename: string): string {
	const lines = mdContent.split("\n");
	let dashCount = 0;
	let insertAfterLine = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			dashCount++;
			if (dashCount === 2) {
				insertAfterLine = i + 1;
				break;
			}
		}
	}
	if (insertAfterLine === -1) {
		// 没有 frontmatter，直接前置
		return `[[${canvasBasename}|🗺️ 打开脑图]]\n\n${mdContent}`;
	}
	lines.splice(insertAfterLine, 0, "", `[[${canvasBasename}|🗺️ 打开脑图]]`);
	return lines.join("\n");
}

/**
 * 带进度条的持久通知，替代多个独立 Notice。
 * 显示：步骤列表 + 当前步骤高亮 + 已完成打钩 + 进度条。
 */
class ProgressNotice {
	private notice: Notice;
	private steps: string[];
	private currentStep = -1;
	private startTime: number;

	constructor(steps: string[]) {
		this.steps = steps;
		this.startTime = Date.now();
		this.notice = new Notice("", 0);
		this.notice.noticeEl.addClass("podcast-progress-notice");
		this.render();
	}

	/** 推进到下一步 */
	advance(message?: string) {
		this.currentStep++;
		this.render(message);
	}

	/** 跳过当前步骤（如"下载音频"被关闭时） */
	skip() {
		this.currentStep++;
	}

	/** 更新当前步骤的详细信息 */
	detail(text: string) {
		const el = this.notice.noticeEl;
		const detailEl = el.querySelector(".progress-detail");
		if (detailEl) detailEl.textContent = text;
	}

	/** 全部完成 */
	finish(message: string) {
		this.notice.hide();
		new Notice(message, 5000);
	}

	/** 出错终止 */
	error(prefix: string, err: unknown) {
		this.notice.hide();
		const msg = err instanceof Error ? err.message : String(err);
		new Notice(`${prefix}：${msg}`, 8000);
		console.error(`[Podvault] ${prefix}:`, err);
	}

	private render(message?: string) {
		const el = this.notice.noticeEl;
		el.empty();

		// 标题
		const titleEl = el.createEl("div", { cls: "progress-title" });
		titleEl.textContent = "Podvault 生成中…";

		// 进度条
		const barOuter = el.createEl("div", { cls: "progress-bar-outer" });
		const barInner = barOuter.createEl("div", { cls: "progress-bar-inner" });
		const pct = Math.min(100, Math.round(((this.currentStep + 1) / this.steps.length) * 100));
		barInner.style.width = `${pct}%`;

		// 步骤列表
		const listEl = el.createEl("div", { cls: "progress-steps" });
		for (let i = 0; i < this.steps.length; i++) {
			const stepEl = listEl.createEl("div", { cls: "progress-step" });
			if (i < this.currentStep) {
				stepEl.addClass("step-done");
				stepEl.textContent = `✅ ${this.steps[i]}`;
			} else if (i === this.currentStep) {
				stepEl.addClass("step-active");
				stepEl.textContent = `⏳ ${message || this.steps[i]}`;
			} else {
				stepEl.addClass("step-pending");
				stepEl.textContent = `○ ${this.steps[i]}`;
			}
		}

		// 详细信息区
		el.createEl("div", { cls: "progress-detail" });

		// 耗时
		const elapsed = Math.round((Date.now() - this.startTime) / 1000);
		const timeEl = el.createEl("div", { cls: "progress-time" });
		timeEl.textContent = `已用时 ${elapsed}s`;
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

		containerEl.createEl("h2", { text: "Podvault 设置" });
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

		new Setting(containerEl)
			.setName("最大输出 Token")
			.setDesc("LLM 单次回复的最大 token 数。长播客（>60 分钟）建议设为 16000。")
			.addText((text) =>
				text
					.setPlaceholder("8000")
					.setValue(String(this.plugin.settings.llmMaxTokens))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (Number.isFinite(n) && n > 0) {
							this.plugin.settings.llmMaxTokens = n;
							await this.plugin.saveSettings();
						}
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

		// 说话人识别：仅火山 / 通义支持；OpenAI Whisper / 硅基流动 / 自定义不支持
		if (
			this.plugin.settings.whisperProvider === "volcengine" ||
			this.plugin.settings.whisperProvider === "dashscope"
		) {
			new Setting(containerEl)
				.setName("识别说话人")
				.setDesc(
					"逐字稿中标注「发言人 1 / 发言人 2」等，适合多人对话类播客。"
				)
				.addToggle((t) =>
					t
						.setValue(this.plugin.settings.whisperEnableDiarization)
						.onChange(async (value) => {
							this.plugin.settings.whisperEnableDiarization = value;
							await this.plugin.saveSettings();
							this.display();
						})
				);

			// 仅 DashScope 支持 speaker_count；0 = 自动
			if (
				this.plugin.settings.whisperProvider === "dashscope" &&
				this.plugin.settings.whisperEnableDiarization
			) {
				new Setting(containerEl)
					.setName("预期说话人数")
					.setDesc("0 或留空表示由模型自动判断；若已知人数（如 2 人对谈），填具体数字可提升准确率。")
					.addText((text) =>
						text
							.setPlaceholder("0")
							.setValue(String(this.plugin.settings.whisperSpeakerCount || 0))
							.onChange(async (value) => {
								const n = parseInt(value.trim(), 10);
								this.plugin.settings.whisperSpeakerCount =
									Number.isFinite(n) && n > 0 ? n : 0;
								await this.plugin.saveSettings();
							})
					);
			}
		} else {
			// 针对不支持的 provider 显示灰色提示
			const tipEl = containerEl.createEl("div", {
				cls: "setting-item-description",
			});
			tipEl.style.paddingLeft = "8px";
			tipEl.style.marginTop = "-4px";
			tipEl.style.opacity = "0.6";
			tipEl.textContent = "ℹ️ 说话人识别仅火山引擎 / 通义 DashScope 支持，当前服务商不可用。";
		}

		// ============ 笔记输出 ============
		containerEl.createEl("h3", { text: "笔记输出" });

		new Setting(containerEl)
			.setName("笔记保存路径")
			.setDesc("相对 Vault 根目录的文件夹路径，支持多级（如 知识管理/播客笔记）。")
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

		new Setting(containerEl)
			.setName("同步生成 Canvas 脑图")
			.setDesc("生成笔记时同步生成同名 .canvas 脑图文件，并在笔记顶部插入链接。也可通过命令「为当前播客笔记生成 Canvas 脑图」按需生成。")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.generateCanvas).onChange(async (value) => {
					this.plugin.settings.generateCanvas = value;
					await this.plugin.saveSettings();
				})
			);

		// ============ 音频下载 ============
		containerEl.createEl("h3", { text: "音频下载（可选）" });

		containerEl.createEl("p", {
			text: "关闭时，侧边栏播放器通过远程 URL 在线播放，时间戳跳转同样可用。开启后，音频会下载到 {笔记保存路径}/attachments/ 目录，支持离线回听，并可在笔记顶部嵌入 Obsidian 原生播放器。建议在同步工具（Obsidian Sync / iCloud / Git .gitignore）中排除 attachments/ 以避免占用同步空间。",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("下载音频到本地")
			.setDesc("关闭（默认）：侧边栏播放器在线播放，时间戳可用；开启：额外支持离线回听 + 原生嵌入播放器。单集常见 50-100MB。")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.downloadAudioLocal).onChange(async (value) => {
					this.plugin.settings.downloadAudioLocal = value;
					await this.plugin.saveSettings();

					// 首次开启时弹一次性提醒
					if (value && !this.plugin.settings.hasShownAudioSyncTip) {
						this.plugin.settings.hasShownAudioSyncTip = true;
						await this.plugin.saveSettings();
						new Notice(
							`💡 建议在 Obsidian Sync / iCloud / Git 中排除 ${this.plugin.settings.notesFolder}/attachments/ 目录，避免占用同步空间。`,
							10000
						);
					}
				})
			);

		new Setting(containerEl)
			.setName("在笔记顶部嵌入原生播放器")
			.setDesc("仅当「下载音频到本地」开启时生效。嵌入 Obsidian 原生 ![[audio]] 播放器。侧边栏播放器始终可用，不受此开关影响。")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.embedAudioPlayer).onChange(async (value) => {
					this.plugin.settings.embedAudioPlayer = value;
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
