import { ItemView, WorkspaceLeaf, TFile, setIcon } from "obsidian";

export const PLAYER_VIEW_TYPE = "podcast-player";

/** 当前正在播放的剧集信息 */
export interface EpisodeInfo {
	title: string;
	podcastName: string;
	sourceUrl: string;
	/** 本地音频文件相对 Vault 根的路径（可选） */
	localAudioPath?: string;
	/** 远程音频 URL（可选） */
	remoteAudioUrl?: string;
	/** 对应的笔记文件路径（可选） */
	notePath?: string;
}

/**
 * 播客播放器侧边栏 View。
 *
 * 支持双源播放：
 *   1. 本地文件存在 → 用 vault adapter 获取资源路径
 *   2. 否则回退到远程 URL
 *
 * 通过 `loadEpisode()` 加载剧集，`seekTo()` 跳转到指定时间。
 */
export class PodcastPlayerView extends ItemView {
	private audioEl!: HTMLAudioElement;
	private progressBar!: HTMLInputElement;
	private currentTimeEl!: HTMLSpanElement;
	private durationEl!: HTMLSpanElement;
	private titleEl!: HTMLDivElement;
	private subtitleEl!: HTMLDivElement;
	private playBtn!: HTMLButtonElement;
	private sourceIndicator!: HTMLSpanElement;

	private episode: EpisodeInfo | null = null;

	getViewType(): string {
		return PLAYER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "播客播放器";
	}

	getIcon(): string {
		return "podcast";
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("podcast-player-container");

		// === 标题区 ===
		const header = container.createDiv({ cls: "podcast-player-header" });
		this.titleEl = header.createDiv({ cls: "podcast-player-title" });
		this.titleEl.textContent = "未加载播客";
		this.subtitleEl = header.createDiv({ cls: "podcast-player-subtitle" });

		// === 音频元素 ===
		this.audioEl = container.createEl("audio");
		this.audioEl.preload = "metadata";

		// === 进度条区 ===
		const progressRow = container.createDiv({ cls: "podcast-player-progress" });
		this.currentTimeEl = progressRow.createSpan({ cls: "podcast-player-time" });
		this.currentTimeEl.textContent = "00:00";
		this.progressBar = progressRow.createEl("input", {
			type: "range",
			cls: "podcast-player-slider",
		});
		this.progressBar.min = "0";
		this.progressBar.max = "0";
		this.progressBar.value = "0";
		this.progressBar.step = "1";
		this.durationEl = progressRow.createSpan({ cls: "podcast-player-time" });
		this.durationEl.textContent = "00:00";

		// === 控制按钮区 ===
		const controls = container.createDiv({ cls: "podcast-player-controls" });

		const skipBackBtn = controls.createEl("button", {
			cls: "podcast-player-btn",
			attr: { "aria-label": "后退 15 秒" },
		});
		setIcon(skipBackBtn, "skip-back");

		this.playBtn = controls.createEl("button", {
			cls: "podcast-player-btn podcast-player-btn-play",
			attr: { "aria-label": "播放" },
		});
		setIcon(this.playBtn, "play");

		const skipForwardBtn = controls.createEl("button", {
			cls: "podcast-player-btn",
			attr: { "aria-label": "快进 15 秒" },
		});
		setIcon(skipForwardBtn, "skip-forward");

		// 播放速度
		const speedBtn = controls.createEl("button", {
			cls: "podcast-player-btn podcast-player-speed",
			attr: { "aria-label": "播放速度" },
		});
		speedBtn.textContent = "1×";

		// === 底部信息 ===
		const footer = container.createDiv({ cls: "podcast-player-footer" });
		this.sourceIndicator = footer.createSpan({ cls: "podcast-player-source" });

		// === 事件绑定 ===
		this.playBtn.addEventListener("click", () => this.togglePlay());
		skipBackBtn.addEventListener("click", () => this.skip(-15));
		skipForwardBtn.addEventListener("click", () => this.skip(15));

		const speeds = [1, 1.25, 1.5, 1.75, 2, 0.75];
		let speedIdx = 0;
		speedBtn.addEventListener("click", () => {
			speedIdx = (speedIdx + 1) % speeds.length;
			this.audioEl.playbackRate = speeds[speedIdx];
			speedBtn.textContent = `${speeds[speedIdx]}×`;
		});

		this.progressBar.addEventListener("input", () => {
			const val = Number(this.progressBar.value);
			if (Number.isFinite(val)) {
				this.audioEl.currentTime = val;
			}
		});

		this.audioEl.addEventListener("timeupdate", () => {
			if (!this.progressBar.matches(":active")) {
				this.progressBar.value = String(Math.floor(this.audioEl.currentTime));
			}
			this.currentTimeEl.textContent = formatHMS(this.audioEl.currentTime);
		});

		this.audioEl.addEventListener("loadedmetadata", () => {
			const dur = Math.floor(this.audioEl.duration);
			this.progressBar.max = String(dur);
			this.durationEl.textContent = formatHMS(dur);
		});

		this.audioEl.addEventListener("play", () => {
			this.playBtn.empty();
			setIcon(this.playBtn, "pause");
			this.playBtn.setAttribute("aria-label", "暂停");
		});

		this.audioEl.addEventListener("pause", () => {
			this.playBtn.empty();
			setIcon(this.playBtn, "play");
			this.playBtn.setAttribute("aria-label", "播放");
		});

		this.audioEl.addEventListener("ended", () => {
			this.playBtn.empty();
			setIcon(this.playBtn, "play");
		});
	}

	async onClose(): Promise<void> {
		if (this.audioEl) {
			this.audioEl.pause();
			this.audioEl.src = "";
		}
	}

	// ==================== 公开 API ====================

	/**
	 * 加载剧集到播放器。自动选择本地或远程音频源。
	 */
	async loadEpisode(info: EpisodeInfo): Promise<void> {
		this.episode = info;
		this.titleEl.textContent = info.title;
		this.subtitleEl.textContent = info.podcastName;

		// 优先本地文件
		let audioSrc: string | null = null;
		let sourceLabel = "";

		if (info.localAudioPath) {
			const file = this.app.vault.getAbstractFileByPath(info.localAudioPath);
			if (file instanceof TFile) {
				audioSrc = this.app.vault.getResourcePath(file);
				sourceLabel = "📁 本地文件";
			}
		}

		if (!audioSrc && info.remoteAudioUrl) {
			audioSrc = info.remoteAudioUrl;
			sourceLabel = "🌐 在线播放";
		}

		if (!audioSrc) {
			this.sourceIndicator.textContent = "⚠️ 无可用音频源";
			return;
		}

		this.sourceIndicator.textContent = sourceLabel;
		this.audioEl.src = audioSrc;
		this.audioEl.load();
	}

	/**
	 * 跳转到指定秒数并自动播放。
	 */
	seekTo(seconds: number): void {
		if (!this.audioEl.src) return;

		const doSeek = () => {
			this.audioEl.currentTime = Math.max(0, seconds);
			this.audioEl.play();
		};

		// 如果音频还没加载完 metadata，等加载后再跳转
		if (this.audioEl.readyState >= HTMLMediaElement.HAVE_METADATA) {
			doSeek();
		} else {
			this.audioEl.addEventListener("loadedmetadata", doSeek, { once: true });
			this.audioEl.load();
		}
	}

	/**
	 * 获取当前播放时间（秒）。
	 */
	getCurrentTime(): number {
		return this.audioEl ? this.audioEl.currentTime : 0;
	}

	/**
	 * 判断当前是否正在播放。
	 */
	isPlaying(): boolean {
		return this.audioEl ? !this.audioEl.paused : false;
	}

	/**
	 * 获取当前加载的剧集信息。
	 */
	getEpisode(): EpisodeInfo | null {
		return this.episode;
	}

	// ==================== 私有方法 ====================

	togglePlay(): void {
		if (!this.audioEl.src) return;
		if (this.audioEl.paused) {
			this.audioEl.play();
		} else {
			this.audioEl.pause();
		}
	}

	private skip(seconds: number): void {
		if (!this.audioEl.src) return;
		this.audioEl.currentTime = Math.max(0, this.audioEl.currentTime + seconds);
	}
}

function formatHMS(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
