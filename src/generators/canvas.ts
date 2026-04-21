import type { PodcastMetadata } from "../parsers/types";
import type { PodcastInsights } from "../ai/llm-types";
import { formatTimestamp } from "../ai/whisper";

interface CanvasNode {
	id: string;
	type: "text";
	x: number;
	y: number;
	width: number;
	height: number;
	text: string;
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

const TITLE_W = 520;
const THESIS_W = 420;
const TOPIC_W = 360;
const OUTLINE_W = 300;
const QUOTE_W = 280;
const V_GAP = 60;
const H_GAP = 24;
const OUTLINE_LEFT_PAD = 80;

let _nid = 0;
function nid() { return "n" + (++_nid); }
let _eid = 0;
function eid() { return "e" + (++_eid); }

function estimateH(text: string, width: number, min = 80): number {
	const charsPerLine = Math.max(10, Math.floor(width / 9));
	const lines = text.split("\n").reduce((s: number, l: string) =>
		s + Math.max(1, Math.ceil(l.length / charsPerLine)), 0);
	return Math.max(min, Math.min(lines * 26 + 32, 450));
}

/**
 * Render podcast insights as an Obsidian Canvas JSON string.
 *
 * Vertical tree layout:
 *
 *   [Title + Summary]  (cyan, wide, top)
 *        |                    \
 *   [Core Thesis] (purple)  [Outline 1]
 *    /    |    \             [Outline 2]
 * [T1]  [T2]  [T3]          [Outline 3]
 *
 * [Quote1]  [Quote2]  [Quote3]  (red, bottom)
 */
export function renderCanvas(meta: PodcastMetadata, insights: PodcastInsights): string {
	_nid = 0; _eid = 0;
	const nodes: CanvasNode[] = [];
	const edges: CanvasEdge[] = [];
	const CX = TITLE_W / 2;

	// Level 0: title + summary card (cyan)
	const titleText = [
		"## " + meta.title,
		meta.podcastName + "  \xB7  " + meta.publishDate + (meta.duration ? "  \xB7  " + meta.duration : ""),
		"",
		insights.summary,
	].join("\n");
	const titleH = estimateH(titleText, TITLE_W, 160);
	const titleId = nid();
	nodes.push({ id: titleId, type: "text", x: 0, y: 0, width: TITLE_W, height: titleH, text: titleText, color: "5" });
	let curY = titleH + V_GAP;

	// Level 1: core thesis (purple, centered)
	let thesisId: string | undefined;
	if (insights.coreThesis) {
		const thesisText = "**\uD83D\uDCA1 Core Thesis**\n\n" + insights.coreThesis;
		const thesisH = estimateH(thesisText, THESIS_W, 100);
		thesisId = nid();
		nodes.push({ id: thesisId, type: "text", x: CX - THESIS_W / 2, y: curY, width: THESIS_W, height: thesisH, text: thesisText, color: "6" });
		edges.push({ id: eid(), fromNode: titleId, toNode: thesisId });
		curY += thesisH + V_GAP;
	}

	// Outline column (right side of title)
	const OUTLINE_X = TITLE_W + OUTLINE_LEFT_PAD;
	let outlineY = titleH + V_GAP;
	for (const node of insights.outline) {
		const ts = node.startSeconds !== undefined ? " *(" + formatTimestamp(node.startSeconds) + ")*" : "";
		let text = "**" + node.title + "**" + ts;
		if (node.summary) text += "\n*" + node.summary + "*";
		if (node.children && node.children.length > 0) {
			for (const child of node.children) {
				const cts = child.startSeconds !== undefined ? " *(" + formatTimestamp(child.startSeconds) + ")*" : "";
				text += "\n- " + child.title + cts;
			}
		}
		const h = estimateH(text, OUTLINE_W, 70);
		const outlineId = nid();
		nodes.push({ id: outlineId, type: "text", x: OUTLINE_X, y: outlineY, width: OUTLINE_W, height: h, text });
		edges.push({ id: eid(), fromNode: titleId, toNode: outlineId });
		outlineY += h + H_GAP;
	}

	// Level 2: topics row (horizontal, centered, green)
	const topicFrom: string = thesisId !== undefined ? thesisId : titleId;
	if (insights.topics.length > 0) {
		const totalW = insights.topics.length * TOPIC_W + (insights.topics.length - 1) * H_GAP;
		const startX = CX - totalW / 2;
		let maxH = 0;
		for (let i = 0; i < insights.topics.length; i++) {
			const t = insights.topics[i];
			const ts = t.startSeconds !== undefined ? " *(" + formatTimestamp(t.startSeconds) + ")*" : "";
			let text = "**" + (i + 1) + ". " + t.title + "**" + ts + "\n\n" + t.insight;
			if (t.caseTitle && t.caseContent) {
				const cts = t.caseStartSeconds !== undefined ? " *(" + formatTimestamp(t.caseStartSeconds) + ")*" : "";
				text += "\n\n---\n" + t.caseTitle + cts + "\n" + t.caseContent;
			}
			const h = estimateH(text, TOPIC_W, 130);
			if (h > maxH) maxH = h;
			const topicId = nid();
			nodes.push({ id: topicId, type: "text", x: startX + i * (TOPIC_W + H_GAP), y: curY, width: TOPIC_W, height: h, text, color: "4" });
			edges.push({ id: eid(), fromNode: topicFrom, toNode: topicId });
		}
		curY += maxH + V_GAP * 2;
	}

	// Bottom: quotes row (horizontal, centered, red)
	if (insights.quotes.length > 0) {
		const totalW = insights.quotes.length * QUOTE_W + (insights.quotes.length - 1) * H_GAP;
		const startX = CX - totalW / 2;
		for (let i = 0; i < insights.quotes.length; i++) {
			const q = insights.quotes[i];
			const speaker = q.speaker ? "\n\n-- " + q.speaker : "";
			const ts = q.startSeconds !== undefined ? " *(" + formatTimestamp(q.startSeconds) + ")*" : "";
			const text = "> " + q.text + speaker + ts;
			const h = estimateH(text, QUOTE_W, 80);
			nodes.push({ id: nid(), type: "text", x: startX + i * (QUOTE_W + H_GAP), y: curY, width: QUOTE_W, height: h, text, color: "1" });
		}
	}

	return JSON.stringify({ nodes, edges } as CanvasDoc, null, 2);
}
