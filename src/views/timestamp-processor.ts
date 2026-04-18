import { MarkdownPostProcessorContext, Plugin, Notice, TFile } from "obsidian";
import { PLAYER_VIEW_TYPE, PodcastPlayerView, EpisodeInfo } from "./player-view";

const TS_RE = /#t=(\d+(?:\.\d+)?)/;

/**
 * 注册时间戳点击跳转——双保险策略：
 *
 * 1. **全局 DOM 捕获阶段监听**（capture: true）：
 *    在事件到达 Obsidian 内部处理器之前拦截，兼容 Live Preview + Reading View。
 *
 * 2. **Markdown Post Processor**：
 *    为 Reading View 中的时间戳链接添加样式类（视觉标识）。
 */
export function registerTimestampProcessor(plugin: Plugin): void {
	// === 策略 1：全局点击拦截（capture 阶段，最先执行） ===
	//
	// Obsidian 渲染模式下链接 DOM 不同：
	//   - Reading View / Callout Widget  -> <a data-href="#t=123">
	//   - Live Preview 列表/普通文本     -> <span class="cm-link"><span class="cm-underline">text</span></span>
	//     后者没有 data-href！URL 只在 CodeMirror 编辑器状态中。
	//
	// 策略：先尝试从 <a> 标签读 href；读不到就从 CM 编辑器源文本中解析。
	plugin.registerDomEvent(
		document,
		"click",
		(e: MouseEvent) => {
			const el = e.target as HTMLElement;
			if (!el) return;

			let seconds: number | null = null;

			// -- 路径 A：标准 <a> 标签（Reading View / Callout Widget）--
			const anchor = el.closest?.("a");
			if (anchor) {
				const href = anchor.getAttribute("data-href") || anchor.getAttribute("href") || "";
				const m = href.match(TS_RE);
				if (m) seconds = parseFloat(m[1]);
			}

			// -- 路径 B：Live Preview cm-link span（无 href 属性）--
			if (seconds === null) {
				const cmLink =
					el.closest?.(".cm-link") ||
					(el.classList?.contains("cm-underline") ? el.parentElement : null);
				if (cmLink) {
					seconds = extractSecondsFromCMEditor(cmLink, e);
				}
			}

			if (seconds === null || !Number.isFinite(seconds)) return;

			// 拦截 Obsidian 默认行为
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();

			// 确保播放器已加载音频后再跳转
			ensurePlayerLoadedAndSeek(plugin, seconds);
		},
		true // capture 阶段
	);

	// === 策略 2：Post Processor 添加样式类 + 触发双栏网格布局 ===
	let gridTimer: ReturnType<typeof setTimeout> | null = null;

	plugin.registerMarkdownPostProcessor(
		(el: HTMLElement, _ctx: MarkdownPostProcessorContext) => {
			// 时间戳链接样式（兼容 <a> 和 Live Preview 的 <span>）
			const links = el.querySelectorAll("a, .cm-link");
			for (const link of Array.from(links)) {
				const href =
					link.getAttribute("data-href") || link.getAttribute("href") || "";
				if (TS_RE.test(href)) {
					link.addClass("podcast-timestamp-link");
				}
			}

			// 双栏网格：deferred 文档级别扫描（debounce，等所有块都渲染完）
			const container = el.closest(".markdown-preview-view, .markdown-source-view");
			if (container && container.closest(".podcast-note")) {
				if (gridTimer) clearTimeout(gridTimer);
				gridTimer = setTimeout(() => {
					applyCardGridToContainer(container as HTMLElement);
					gridTimer = null;
				}, 200);
			}
		}
	);

	// 切换笔记时也需要重新应用
	plugin.registerEvent(
		plugin.app.workspace.on("active-leaf-change", () => {
			setTimeout(() => {
				const view = plugin.app.workspace.getActiveViewOfType(
					// @ts-expect-error — MarkdownView is available at runtime
					plugin.app.workspace.constructor
				);
				// 找当前活跃的 markdown 视图的容器
				const activeLeaf = plugin.app.workspace.activeLeaf;
				if (!activeLeaf) return;
				const containerEl = activeLeaf.view.containerEl;
				if (!containerEl) return;
				const previewView = containerEl.querySelector(
					".podcast-note .markdown-preview-view, .podcast-note .markdown-source-view"
				) || containerEl.querySelector(
					".markdown-preview-view.podcast-note, .markdown-source-view.podcast-note"
				);
				if (previewView) {
					applyCardGridToContainer(previewView as HTMLElement);
				}
			}, 300);
		})
	);
}

/**
 * 在整个文档容器中找到连续的同类型 callout，包进 grid div。
 * 在文档级别操作，解决 post-processor 只能看到单个块的问题。
 */
function applyCardGridToContainer(container: HTMLElement): void {
	// 移除之前创建的 grid wrapper（避免重复包裹）
	const oldGrids = container.querySelectorAll(".podcast-card-grid");
	for (const oldGrid of Array.from(oldGrids)) {
		// 把子元素还原到原位
		const parent = oldGrid.parentNode;
		if (parent) {
			while (oldGrid.firstChild) {
				parent.insertBefore(oldGrid.firstChild, oldGrid);
			}
			parent.removeChild(oldGrid);
		}
	}

	// 找所有 callout section（Obsidian 把每个 callout 放在 .markdown-preview-section 里）
	const allSections = Array.from(
		container.querySelectorAll(".markdown-preview-section")
	);

	// 按类型分组连续的 callout sections
	let currentType: string | null = null;
	let group: HTMLElement[] = [];

	const flushGroup = () => {
		if (group.length >= 2) {
			const gridDiv = document.createElement("div");
			gridDiv.addClass("podcast-card-grid");
			// 在第一个元素前插入 grid container
			group[0].parentNode?.insertBefore(gridDiv, group[0]);
			for (const section of group) {
				gridDiv.appendChild(section);
			}
		}
		group = [];
		currentType = null;
	};

	for (const section of allSections) {
		const callout = section.querySelector(
			'.callout[data-callout="abstract"], .callout[data-callout="example"]'
		);
		if (callout) {
			const type = callout.getAttribute("data-callout");
			if (type !== currentType) {
				flushGroup();
				currentType = type;
			}
			group.push(section as HTMLElement);
		} else {
			flushGroup();
		}
	}
	flushGroup();
}

/**
 * 确保播放器已激活并加载了音频，然后跳转到指定秒数。
 * 如果播放器未加载音频，自动从当前笔记的 frontmatter 读取音频信息。
 */
async function ensurePlayerLoadedAndSeek(plugin: Plugin, seconds: number): Promise<void> {
	let view = getPlayerView(plugin);
	if (!view) {
		view = await activatePlayerView(plugin);
	}
	if (!view) {
		new Notice("无法打开播客播放器");
		return;
	}

	// 如果播放器已有音频，直接跳转
	if (view.getEpisode()) {
		view.seekTo(seconds);
		return;
	}

	// 播放器没有加载音频 → 从当前笔记 frontmatter 读取并加载
	const episodeInfo = readEpisodeFromActiveNote(plugin);
	if (!episodeInfo) {
		new Notice("当前笔记缺少音频信息（需要 frontmatter 中的 audio 或 audio_url）");
		return;
	}
	await view.loadEpisode(episodeInfo);
	view.seekTo(seconds);
}

/**
 * 从当前活跃笔记的 frontmatter 中提取播客音频信息。
 */
function readEpisodeFromActiveNote(plugin: Plugin): EpisodeInfo | null {
	const file = plugin.app.workspace.getActiveFile();
	if (!file) return null;

	const cache = plugin.app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;
	if (!fm) return null;

	// 至少需要一个音频来源
	const localAudioPath = fm.audio as string | undefined;
	const remoteAudioUrl = fm.audio_url as string | undefined;
	if (!localAudioPath && !remoteAudioUrl) return null;

	return {
		title: (fm.title as string) || file.basename,
		podcastName: (fm.podcast as string) || "",
		sourceUrl: (fm.source as string) || "",
		localAudioPath,
		remoteAudioUrl,
		notePath: file.path,
	};
}

/**
 * 获取已激活的播放器 View 实例（可能为 null）。
 */
export function getPlayerView(plugin: Plugin): PodcastPlayerView | null {
	const leaves = plugin.app.workspace.getLeavesOfType(PLAYER_VIEW_TYPE);
	if (leaves.length === 0) return null;
	return leaves[0].view as PodcastPlayerView;
}

/**
 * 激活（或创建）播放器侧边栏。
 */
export async function activatePlayerView(
	plugin: Plugin
): Promise<PodcastPlayerView | null> {
	const { workspace } = plugin.app;

	let leaf = workspace.getLeavesOfType(PLAYER_VIEW_TYPE)[0];
	if (!leaf) {
		// 在右侧边栏创建
		const rightLeaf = workspace.getRightLeaf(false);
		if (!rightLeaf) return null;
		await rightLeaf.setViewState({
			type: PLAYER_VIEW_TYPE,
			active: true,
		});
		leaf = rightLeaf;
	}

	workspace.revealLeaf(leaf);
	return leaf.view as PodcastPlayerView;
}

/**
 * Live Preview 模式下 [12:34](#t=754) 被渲染为：
 *   <span class="cm-link"><span class="cm-underline">12:34</span></span>
 * 没有 data-href！
 *
 * 可靠策略：直接从显示文本（如 "12:34" / "01:12:34"）反推秒数。
 * 因为 tsLink() 生成的 label 就是 formatHMS(seconds)，所以可以无损还原。
 *
 * 如果文本不像时间戳格式则回退到 CM EditorView API（不保证可用）。
 */
function extractSecondsFromCMEditor(
	cmLinkEl: Element,
	clickEvent: MouseEvent
): number | null {
	// 策略 1：从显示文本解析时间（最可靠）
	const text = (cmLinkEl.textContent || "").trim();
	const parsed = parseTimeLabel(text);
	if (parsed !== null) return parsed;

	// 策略 2：回退到 CM EditorView API（可能不可用）
	return extractSecondsFromCMState(cmLinkEl, clickEvent);
}

/**
 * 解析 "mm:ss" 或 "hh:mm:ss" 格式的时间标签为秒数。
 */
function parseTimeLabel(text: string): number | null {
	// 匹配 mm:ss 或 hh:mm:ss
	const m = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
	if (!m) return null;

	if (m[3] !== undefined) {
		// hh:mm:ss
		return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
	}
	// mm:ss
	return parseInt(m[1]) * 60 + parseInt(m[2]);
}

/**
 * 通过 CodeMirror EditorView 从编辑器源文本中提取 #t= 的秒数值。
 * 这是备用方案，依赖 Obsidian 内部未公开的 cmView 引用。
 */
function extractSecondsFromCMState(
	cmLinkEl: Element,
	clickEvent: MouseEvent
): number | null {
	const cmEditorEl = cmLinkEl.closest(".cm-editor");
	if (!cmEditorEl) return null;

	// Obsidian 在 .cm-editor 上挂载 cmView 引用
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const editorView = (cmEditorEl as any)?.cmView?.view;
	if (!editorView?.posAtCoords || !editorView.state?.doc?.lineAt) return null;

	const pos = editorView.posAtCoords({ x: clickEvent.clientX, y: clickEvent.clientY });
	if (pos === null || pos === undefined) return null;

	const line = editorView.state.doc.lineAt(pos);
	if (!line) return null;

	// 行内可能有多个时间戳链接，找离点击位置最近的那个
	const lineText: string = line.text;
	const lineFrom: number = line.from;
	const allMatches: Array<{ seconds: number; center: number }> = [];
	const re = /\[([^\]]*)\]\(#t=(\d+(?:\.\d+)?)\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(lineText)) !== null) {
		allMatches.push({
			seconds: parseFloat(m[2]),
			center: lineFrom + m.index + m[0].length / 2,
		});
	}

	if (allMatches.length === 0) return null;
	if (allMatches.length === 1) return allMatches[0].seconds;

	// 多个匹配时选最近的
	let best = allMatches[0];
	let bestDist = Math.abs(pos - best.center);
	for (let i = 1; i < allMatches.length; i++) {
		const dist = Math.abs(pos - allMatches[i].center);
		if (dist < bestDist) {
			best = allMatches[i];
			bestDist = dist;
		}
	}
	return best.seconds;
}
