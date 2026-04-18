import { MarkdownPostProcessorContext, Plugin, Notice } from "obsidian";
import { PLAYER_VIEW_TYPE, PodcastPlayerView } from "./player-view";

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
	plugin.registerDomEvent(
		document,
		"click",
		(e: MouseEvent) => {
			const target = (e.target as HTMLElement)?.closest?.("a");
			if (!target) return;

			const href =
				target.getAttribute("data-href") || target.getAttribute("href") || "";
			const match = href.match(TS_RE);
			if (!match) return;

			const seconds = parseFloat(match[1]);
			if (!Number.isFinite(seconds)) return;

			// 拦截 Obsidian 默认行为
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();

			const playerView = getPlayerView(plugin);
			if (!playerView) {
				activatePlayerView(plugin).then((view) => {
					if (view) {
						view.seekTo(seconds);
					} else {
						new Notice("⚠️ 请先打开播客播放器并加载一期播客");
					}
				});
				return;
			}
			playerView.seekTo(seconds);
		},
		true // ← capture 阶段，在 Obsidian 处理之前拦截
	);

	// === 策略 2：Post Processor 添加样式类 + 触发双栏网格布局 ===
	let gridTimer: ReturnType<typeof setTimeout> | null = null;

	plugin.registerMarkdownPostProcessor(
		(el: HTMLElement, _ctx: MarkdownPostProcessorContext) => {
			// 时间戳链接样式
			const links = el.querySelectorAll("a");
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
