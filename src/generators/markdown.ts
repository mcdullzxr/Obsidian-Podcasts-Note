import type { PodcastMetadata } from "../parsers/types";
import type { PodcastInsights, InsightItem, OutlineNode } from "../ai/llm-types";
import type { TranscriptionResult, TranscriptSegment } from "../ai/types";

/**
 * 生成笔记时用到的配置。
 */
export interface NoteOptions {
	filenameTemplate: string;
	includeTranscript: boolean;
}

/**
 * 渲染整篇 Markdown 笔记。
 *
 * 按 CLAUDE.md 约定的结构：
 *   Frontmatter → 摘要 → 知识点 → 案例 → 大纲 → 逐字稿
 */
export function renderNote(
	meta: PodcastMetadata,
	insights: PodcastInsights,
	transcript: TranscriptionResult | null,
	opts: NoteOptions
): string {
	const lines: string[] = [];

	// ===== Frontmatter =====
	lines.push("---");
	lines.push(`title: "${escapeYaml(meta.title)}"`);
	lines.push(`podcast: "${escapeYaml(meta.podcastName)}"`);
	lines.push(`date: ${meta.publishDate}`);
	lines.push(`source: "${meta.sourceUrl}"`);
	if (meta.duration) lines.push(`duration: "${meta.duration}"`);
	lines.push(`tags: [${["播客", ...insights.tags].map(yamlTag).join(", ")}]`);
	lines.push(`created: ${new Date().toISOString().slice(0, 10)}`);
	lines.push("---");
	lines.push("");

	// ===== 摘要 =====
	lines.push("## 📋 摘要");
	lines.push("");
	lines.push(insights.summary || "（暂无摘要）");
	lines.push("");

	// ===== 知识点 =====
	if (insights.knowledgePoints.length > 0) {
		lines.push("## 💡 知识点");
		lines.push("");
		for (const item of insights.knowledgePoints) {
			lines.push(...renderCallout("abstract", item));
			lines.push("");
		}
	}

	// ===== 案例 =====
	if (insights.cases.length > 0) {
		lines.push("## 📖 案例");
		lines.push("");
		for (const item of insights.cases) {
			lines.push(...renderCallout("example", item));
			lines.push("");
		}
	}

	// ===== 大纲 =====
	if (insights.outline.length > 0) {
		lines.push("## 🗺️ 内容大纲");
		lines.push("");
		lines.push(...renderOutline(insights.outline, 0));
		lines.push("");
	}

	// ===== 逐字稿 =====
	if (opts.includeTranscript && transcript && transcript.segments.length > 0) {
		lines.push("## 📝 逐字稿");
		lines.push("");
		lines.push(...renderTranscript(transcript.segments));
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

function renderCallout(type: "abstract" | "example", item: InsightItem): string[] {
	const out: string[] = [];
	out.push(`> [!${type}] ${item.title}`);
	for (const line of item.content.split("\n")) {
		out.push(`> ${line}`);
	}
	if (item.startSeconds !== undefined) {
		out.push(`> ⏱️ ${formatHMS(item.startSeconds)}`);
	}
	return out;
}

function renderOutline(nodes: OutlineNode[], depth: number): string[] {
	const out: string[] = [];
	const indent = "  ".repeat(depth);
	for (const node of nodes) {
		const ts = node.startSeconds !== undefined ? ` (${formatHMS(node.startSeconds)})` : "";
		out.push(`${indent}- ${node.title}${ts}`);
		if (node.children && node.children.length > 0) {
			out.push(...renderOutline(node.children, depth + 1));
		}
	}
	return out;
}

/**
 * 渲染逐字稿：合并相邻短段，避免每 3 秒一行。
 */
function renderTranscript(segments: TranscriptSegment[]): string[] {
	const out: string[] = [];
	const mergeGapSec = 12;
	let bucketStart = segments[0].start;
	let bucketSpeaker = segments[0].speaker;
	let bucketText = "";

	const flush = () => {
		if (!bucketText.trim()) return;
		const ts = formatHMS(bucketStart);
		const speaker = bucketSpeaker ? `${bucketSpeaker}：` : "";
		out.push(`**[${ts}]** ${speaker}${bucketText.trim()}`);
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
