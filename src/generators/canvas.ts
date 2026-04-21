import type { PodcastMetadata } from "../parsers/types";
import type { PodcastInsights } from "../ai/llm-types";
import { formatTimestamp } from "../ai/whisper";

/**
 * Obsidian Canvas JSON 节点（text 类型）。
 * spec: https://jsoncanvas.org
 */
interface CanvasNode {
	id: string;
	type: "text";
	x: number;
	y: number;
	width: number;
	height: number;
	text: string;
	/** 颜色（"1"=红 "2"=橙 "3"=黄 "4"=绿 "5"=青 "6"=紫） */
	color?: string;
}

interface CanvasEdge {
	id: string;
	fromNode: string;
	toNode: string;
	label?: string;
}

interface CanvasDoc {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
}

// ===== 布局常量 =====
const COL_META_X = 0;
const COL_TOPIC_X = 460;
const COL_OUTLINE_X = 960;
const META_W = 380;
const TOPIC_W = 420;
const OUTLINE_W = 300;
const GAP_Y = 24;

let _nid = 0;
function nid() { return `n${++_nid}`; }

let _eid = 0;
function eid() { return `e${++_eid}`; }

/**
 * 粗略估算文本节点高度（基于字符数和节点宽度）。
 * 每行约 9px/字符，每行高度 26px，顶部 padding 约 28px。
 */
function estimateH(text: string, width: number, min = 80): number {
	const charsPerLine = Math.max(10, Math.floor(width / 9));
	const lines = text
		.split("\n")
		.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
	return Math.max(min, Math.min(lines * 26 + 28, 420));
}

/**
 * 生成 Obsidian Canvas JSON 字符串。
 *
 * 布局（三列）：
 * - 左列：标题 / 摘要 / 核心论点（由上到下）
 * - 中列：话题节点（含案例内嵌在同一节点）
 * - 右列：大纲顶级节点（子章节内嵌为 bullet）
 * - 底部：金句横排
 *
 * 连线：标题 → 摘要 → 核心论点；标题 → 每个话题；标题 → 每个大纲节点。
 */
export function renderCanvas(
	meta: PodcastMetadata,
	insights: PodcastInsights
): string {
	_nid = 0;
	_eid = 0;
	const nodes: CanvasNode[] = [];
	const edges: CanvasEdge[] = [];

	// ===== 左列：元信息 =====
	let metaY = 0;

	// 标题节点（青色 "5"）
	const titleText = [
		`## ${meta.title}`,
		`🎙 ${meta.podcastName}  ·  ${meta.publishDate}${meta.duration ? `  ·  ⏱ ${meta.duration}` : ""}`,
	].join("\n");
	const titleH = 100;
	const titleId = nid();
	nodes.push({ id: titleId, type: "text", x: COL_META_X, y: metaY, width: META_W, height: titleH, text: titleText, color: "5" });
	metaY += titleH + GAP_Y;

	// 摘要节点
	const summaryText = `**📋 摘要**\n\n${insights.summary}`;
	const summaryH = estimateH(summaryText, META_W, 100);
	const summaryId = nid();
	nodes.push({ id: summaryId, type: "text", x: COL_META_X, y: metaY, width: META_W, height: summaryH, text: summaryText });
	edges.push({ id: eid(), fromNode: titleId, toNode: summaryId });
	metaY += summaryH + GAP_Y;

	// 核心论点节点（紫色 "6"）
	if (insights.coreThesis) {
		const thesisText = `**💡 核心论点**\n\n${insights.coreThesis}`;
		const thesisH = estimateH(thesisText, META_W, 80);
		const thesisId = nid();
		nodes.push({ id: thesisId, type: "text", x: COL_META_X, y: metaY, width: META_W, height: thesisH, text: thesisText, color: "6" });
		edges.push({ id: eid(), fromNode: summaryId, toNode: thesisId });
		metaY += thesisH + GAP_Y;
	}

	// ===== 中列：话题 =====
	let topicY = 0;
	for (let i = 0; i < insights.topics.length; i++) {
		const t = insights.topics[i];
		const ts = t.startSeconds !== undefined ? ` *(${formatTimestamp(t.startSeconds)})*` : "";
		let text = `**${i + 1}. ${t.title}**${ts}\n\n${t.insight}`;
		if (t.caseTitle && t.caseContent) {
			const cts = t.caseStartSeconds !== undefined ? ` *(${formatTimestamp(t.caseStartSeconds)})*` : "";
			text += `\n\n---\n📌 **案例：${t.caseTitle}**${cts}\n${t.caseContent}`;
		}
		const h = estimateH(text, TOPIC_W, 120);
		const topicId = nid();
		nodes.push({ id: topicId, type: "text", x: COL_TOPIC_X, y: topicY, width: TOPIC_W, height: h, text, color: "4" });
		edges.push({ id: eid(), fromNode: titleId, toNode: topicId });
		topicY += h + GAP_Y;
	}

	// ===== 右列：大纲 =====
	let outlineY = 0;
	for (const node of insights.outline) {
		const ts = node.startSeconds !== undefined ? ` *(${formatTimestamp(node.startSeconds)})*` : "";
		let text = `**${node.title}**${ts}`;
		if (node.summary) text += `\n*${node.summary}*`;
		if (node.children && node.children.length > 0) {
			for (const child of node.children) {
				const cts = child.startSeconds !== undefined ? ` *(${formatTimestamp(child.startSeconds)})*` : "";
				text += `\n- ${child.title}${cts}`;
			}
		}
		const h = estimateH(text, OUTLINE_W, 70);
		const outlineId = nid();
		nodes.push({ id: outlineId, type: "text", x: COL_OUTLINE_X, y: outlineY, width: OUTLINE_W, height: h, text });
		edges.push({ id: eid(), fromNode: titleId, toNode: outlineId });
		outlineY += h + GAP_Y;
	}

	// ===== 底部：金句横排（红色 "1"） =====
	const bottomY = Math.max(metaY, topicY, outlineY) + 80;
	const QUOTE_W = 300;
	let quoteX = COL_META_X;
	for (const q of insights.quotes) {
		const speaker = q.speaker ? `\n\n—— ${q.speaker}` : "";
		const ts = q.startSeconds !== undefined ? ` *(${formatTimestamp(q.startSeconds)})*` : "";
		const text = `> "${q.text}"${speaker}${ts}`;
		const h = estimateH(text, QUOTE_W, 80);
		nodes.push({ id: nid(), type: "text", x: quoteX, y: bottomY, width: QUOTE_W, height: h, text, color: "1" });
		quoteX += QUOTE_W + GAP_Y;
	}

	return JSON.stringify({ nodes, edges } as CanvasDoc, null, 2);
}
