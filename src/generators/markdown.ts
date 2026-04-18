import type { PodcastMetadata } from "../parsers/types";
import type { PodcastInsights, TopicCluster, OutlineNode } from "../ai/llm-types";
import type { TranscriptionResult, TranscriptSegment } from "../ai/types";

/**
 * 生成笔记时用到的配置。
 */
export interface NoteOptions {
	filenameTemplate: string;
	includeTranscript: boolean;

	/**
	 * 下载到本地的音频文件相对 Vault 根的完整路径（如 `Podcasts/attachments/xxx.mp3`）。
	 * 传入后会把路径写入 frontmatter，供播放器定位本地文件。
	 */
	localAudioPath?: string;
	/** 是否在笔记顶部嵌入 `![[xxx.mp3]]` 播放器（仅在 localAudioPath 存在时有效） */
	embedAudioPlayer?: boolean;
	/** 笔记保存目录（用于计算音频相对于笔记的链接路径，默认 Podcasts） */
	notesFolder?: string;
	/** 远程音频 URL（写入 frontmatter，供播放器回退使用） */
	remoteAudioUrl?: string;
}

/**
 * 渲染整篇 Markdown 笔记。
 *
 * 按 CLAUDE.md 约定的结构：
 *   Frontmatter → 顶部音频入口 → 摘要 → 知识点 → 案例 → 大纲 → 逐字稿
 */
export function renderNote(
	meta: PodcastMetadata,
	insights: PodcastInsights,
	transcript: TranscriptionResult | null,
	opts: NoteOptions
): string {
	const lines: string[] = [];

	const audioBasename = opts.localAudioPath
		? opts.localAudioPath.split("/").pop() || ""
		: "";

	// ===== Frontmatter =====
	lines.push("---");
	lines.push(`title: "${escapeYaml(meta.title)}"`);
	lines.push(`podcast: "${escapeYaml(meta.podcastName)}"`);
	lines.push(`date: ${meta.publishDate}`);
	lines.push(`source: "${meta.sourceUrl}"`);
	if (opts.localAudioPath) {
		lines.push(`audio: "${opts.localAudioPath}"`);
	}
	if (opts.remoteAudioUrl) {
		lines.push(`audio_url: "${opts.remoteAudioUrl}"`);
	}
	if (meta.duration) lines.push(`duration: "${meta.duration}"`);
	lines.push(`tags: [${["播客", ...insights.tags].map(yamlTag).join(", ")}]`);
	lines.push(`cssclasses: [podcast-note]`);
	lines.push(`created: ${new Date().toISOString().slice(0, 10)}`);
	lines.push("---");
	lines.push("");

	// ===== 顶部音频入口 =====
	if (opts.localAudioPath && opts.embedAudioPlayer !== false) {
		// Obsidian 嵌入语法：仅需文件名
		lines.push(`![[${audioBasename}]]`);
		lines.push("");
	} else if (!opts.localAudioPath && meta.sourceUrl) {
		lines.push(`> 🎧 [在${platformLabel(meta.platform)}收听原节目](${meta.sourceUrl})`);
		lines.push("");
	}

	// ===== 元信息条（标签徽章 + 时长 + 节目名） =====
	const infoParts: string[] = [];
	if (meta.duration) infoParts.push(`⏱ ${meta.duration}`);
	infoParts.push(`🎙 ${meta.podcastName}`);
	if (insights.tags.length > 0) {
		infoParts.push(insights.tags.map((t) => `\`${t}\``).join(" "));
	}
	lines.push(infoParts.join("  ·  "));
	lines.push("");

	// ===== 摘要 =====
	lines.push("## 📋 摘要");
	lines.push("");
	lines.push(insights.summary || "（暂无摘要）");
	lines.push("");

	// ===== 核心观点（话题聚类） =====
	if (insights.topics.length > 0) {
		lines.push("## 💡 核心观点");
		lines.push("");
		for (const topic of insights.topics) {
			lines.push(...renderTopic(topic));
			lines.push("");
		}
	}

	// ===== 行动建议（可选） =====
	if (insights.actionItems.length > 0) {
		lines.push("## ✅ 行动建议");
		lines.push("");
		for (const item of insights.actionItems) {
			const ts = item.startSeconds !== undefined ? ` ${tsLink(item.startSeconds)}` : "";
			lines.push(`- [ ] ${item.content}${ts}`);
		}
		lines.push("");
	}

	// ===== 延伸阅读/资源（可选） =====
	if (insights.resources.length > 0) {
		lines.push("## 📚 延伸阅读");
		lines.push("");
		for (const res of insights.resources) {
			const icon = resourceIcon(res.type);
			const desc = res.description ? ` — ${res.description}` : "";
			const ts = res.startSeconds !== undefined ? ` ${tsLink(res.startSeconds)}` : "";
			lines.push(`- ${icon} **${res.name}**${desc}${ts}`);
		}
		lines.push("");
	}

	// ===== 大纲 =====
	if (insights.outline.length > 0) {
		lines.push("## 🗺️ 内容大纲");
		lines.push("");
		lines.push(...renderOutline(insights.outline, 0));
		lines.push("");
	}

	// ===== 我的标记（空占位，供用户手动添加） =====
	lines.push("## 🔖 我的标记");
	lines.push("");

	// ===== 逐字稿（默认折叠） =====
	if (opts.includeTranscript && transcript && transcript.segments.length > 0) {
		lines.push("> [!note]- 📝 逐字稿（点击展开）");
		lines.push(">");
		const transcriptLines = renderTranscript(transcript.segments);
		for (const tl of transcriptLines) {
			lines.push(tl ? `> ${tl}` : ">");
		}
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * 按模板生成文件名（不含扩展名）。
 * 支持变量：{{date}}、{{title}}、{{podcast}}。
 */
export function renderFilename(meta: PodcastMetadata, template: string): string {
	const raw = template
		.replace(/\{\{\s*date\s*\}\}/g, meta.publishDate)
		.replace(/\{\{\s*title\s*\}\}/g, meta.title)
		.replace(/\{\{\s*podcast\s*\}\}/g, meta.podcastName);
	return sanitizeFilename(raw);
}

/**
 * 生成时间戳链接（解耦格式）：
 * `[mm:ss](#t=秒)` — 只带时间不带路径。
 * 播放器运行时自动匹配当前笔记对应的音频源。
 */
function tsLink(seconds: number): string {
	const label = formatHMS(seconds);
	const sec = Math.max(0, Math.floor(seconds));
	return `[${label}](#t=${sec})`;
}

/**
 * 渲染一个话题聚类：核心观点 + 案例佐证（如果有）。
 */
function renderTopic(topic: TopicCluster): string[] {
	const out: string[] = [];

	// 核心观点 callout
	out.push(`> [!abstract] ${topic.title}`);
	for (const line of topic.insight.split("\n")) {
		out.push(`> ${line}`);
	}
	if (topic.startSeconds !== undefined) {
		out.push(`> ⏱️ ${tsLink(topic.startSeconds)}`);
	}

	// 案例佐证 callout（紧跟在观点后面）
	if (topic.caseContent) {
		out.push("");
		out.push(`> [!example] ${topic.caseTitle || "案例"}`);
		for (const line of topic.caseContent.split("\n")) {
			out.push(`> ${line}`);
		}
		if (topic.caseStartSeconds !== undefined) {
			out.push(`> ⏱️ ${tsLink(topic.caseStartSeconds)}`);
		}
	}

	return out;
}

const RESOURCE_ICONS: Record<string, string> = {
	book: "📖",
	article: "📄",
	tool: "🔧",
	podcast: "🎙️",
	other: "🔗",
};

function resourceIcon(type: string): string {
	return RESOURCE_ICONS[type] || "🔗";
}

function renderOutline(nodes: OutlineNode[], depth: number): string[] {
	const out: string[] = [];
	const indent = "  ".repeat(depth);
	for (const node of nodes) {
		const ts =
			node.startSeconds !== undefined ? ` (${tsLink(node.startSeconds)})` : "";
		out.push(`${indent}- ${node.title}${ts}`);
		if (node.children && node.children.length > 0) {
			out.push(...renderOutline(node.children, depth + 1));
		}
	}
	return out;
}

/**
 * 渲染逐字稿：合并相邻短段，避免每 3 秒一行；时间戳可点击跳转。
 */
function renderTranscript(segments: TranscriptSegment[]): string[] {
	const out: string[] = [];
	const mergeGapSec = 12;
	let bucketStart = segments[0].start;
	let bucketSpeaker = segments[0].speaker;
	let bucketText = "";

	const flush = () => {
		if (!bucketText.trim()) return;
		const speaker = bucketSpeaker ? `${bucketSpeaker}：` : "";
		out.push(`**${tsLink(bucketStart)}** ${speaker}${bucketText.trim()}`);
		out.push("");
	};

	for (const seg of segments) {
		const shouldFlush =
			bucketText &&
			(seg.start - bucketStart > mergeGapSec || seg.speaker !== bucketSpeaker);
		if (shouldFlush) {
			flush();
			bucketStart = seg.start;
			bucketSpeaker = seg.speaker;
			bucketText = seg.text;
		} else {
			bucketText += (bucketText ? " " : "") + seg.text;
		}
	}
	flush();
	return out;
}

function formatHMS(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function escapeYaml(input: string): string {
	return input.replace(/"/g, '\\"');
}

function yamlTag(tag: string): string {
	// YAML 里带特殊字符的 tag 用引号包起来更安全
	if (/[\s:,\[\]{}#&*!|>'"%@`]/.test(tag)) {
		return `"${escapeYaml(tag)}"`;
	}
	return tag;
}

function platformLabel(platform: string): string {
	switch (platform) {
		case "xiaoyuzhou":
			return "小宇宙";
		case "spotify":
			return "Spotify";
		case "rss":
			return "原站";
		default:
			return "原站";
	}
}

/**
 * 去掉文件系统不支持的字符。
 */
function sanitizeFilename(name: string): string {
	return name
		.replace(/[\\/:*?"<>|]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);
}
