import { requestUrl } from "obsidian";
import type { InsightContext, LlmConfig, OutlineNode, PodcastInsights, TopicCluster, ActionItem, Resource } from "./llm-types";

/**
 * 让 LLM 一次性返回全部结构化产出的 Prompt。
 * 采用严格 JSON 输出格式，便于后续笔记渲染。
 */
function buildSystemPrompt(): string {
	return [
		"你是一位专业的播客笔记整理助手，擅长从中文播客逐字稿中提炼可沉淀的知识。",
		"你的任务是把一期播客的逐字稿转化为结构化的知识笔记。",
		"",
		"你必须以严格的 JSON 格式输出，不要包含任何额外文字、注释或 Markdown 代码块标记。",
		"",
		"输出 JSON 结构：",
		"{",
		'  "summary": string, // 3-5 句话的摘要，聚焦"这期播客讲了什么、核心观点是什么"',
		'  "topics": [ // 按讨论话题分组的核心观点（重点！把概念和案例关联在一起）',
		"    {",
		'      "title": string, // 话题标题（如"第一性原理思维"）',
		'      "insight": string, // 核心观点或概念的清晰解释（1-3 句话）',
		'      "case_title": string | null, // 佐证案例的标题（没有案例时为 null）',
		'      "case_content": string | null, // 佐证案例的描述（1-2 句话，没有时为 null）',
		'      "start_seconds": number, // 该话题首次出现的时间戳（秒，整数）',
		'      "case_start_seconds": number | null // 案例出现的时间戳（没有时为 null）',
		"    }",
		"  ],",
		'  "action_items": [ // 听完可以做的事（可选，不是每期都有，没有就给空数组）',
		"    {",
		'      "content": string, // 具体的行动建议',
		'      "start_seconds": number',
		"    }",
		"  ],",
		'  "resources": [ // 播客中提到的书、文章、工具、播客等资源（可选，没有就给空数组）',
		"    {",
		'      "name": string, // 资源名称',
		'      "type": "book" | "article" | "tool" | "podcast" | "other",',
		'      "description": string | null, // 一句话描述，可选',
		'      "start_seconds": number',
		"    }",
		"  ],",
		'  "outline": [ // 结构化大纲，体现节目的话题分段',
		"    {",
		'      "title": string,',
		'      "start_seconds": number,',
		'      "children": [ { "title": string, "start_seconds": number } ] // 可选，最多两层',
		"    }",
		"  ],",
		'  "tags": string[] // 3-8 个主题标签，不要带 # 前缀',
		"}",
		"",
		"重要要求：",
		"1. topics 是核心输出。按播客讨论的话题来组织，每个话题包含「核心观点」和「佐证案例」。",
		"   概念和案例应该天然关联——不要把概念和案例割裂到不同数组里。",
		"2. 如果一个话题有多个案例，只保留最有代表性的那一个。",
		"3. 每个 start_seconds 必须是从逐字稿时间戳中提取的真实数字，不要编造。",
		"4. action_items：只提取节目中明确建议的行动，不要自己编造建议。没有就给空数组。",
		"5. resources：只提取节目中明确提到名字的资源，不要猜测或补充。没有就给空数组。",
		"6. 如果用户提供了已有标签列表，优先从已有标签中选择合适的，没有合适的再新建。",
		"7. 所有文本使用中文，保持简洁专业。",
		"8. 严禁输出 ```json 或 ``` 等代码块包裹，直接输出 JSON 对象。",
	].join("\n");
}

function buildUserPrompt(ctx: InsightContext): string {
	const parts: string[] = [];
	parts.push(`节目：${ctx.podcastName}`);
	parts.push(`单集：${ctx.episodeTitle}`);
	if (ctx.description) {
		parts.push(`简介：${ctx.description.slice(0, 500)}`);
	}
	if (ctx.existingTags && ctx.existingTags.length > 0) {
		parts.push(`用户 Vault 中已有的标签（请优先复用）：${ctx.existingTags.join(", ")}`);
	}
	parts.push("");
	parts.push("以下是带时间戳的逐字稿：");
	parts.push("----");
	parts.push(ctx.transcriptWithTimestamps);
	parts.push("----");
	parts.push("请按 system 要求输出 JSON。");
	return parts.join("\n");
}

/**
 * 去除常见的 ```json 包裹，容错一些模型不守规矩的场景。
 */
function stripCodeFence(input: string): string {
	let s = input.trim();
	if (s.startsWith("```")) {
		s = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
	}
	return s;
}

/**
 * 尝试修复被截断的 JSON（LLM 因 max_tokens 限制没写完）。
 *
 * 策略：从尾部向前找到最后一个完整的 value 边界，
 * 然后补上缺失的 ] 和 }，让 JSON.parse 能通过。
 */
function repairTruncatedJson(raw: string): string {
	let s = raw.trim();

	// 1. 去掉尾部不完整的 string（引号没闭合）
	//    找最后一个 " ，检查其前面的内容是否平衡
	//    简单策略：去掉最后一个未闭合的 key-value 对
	const lastQuote = s.lastIndexOf('"');
	if (lastQuote > 0) {
		// 检查引号是否成对：从 lastQuote 往前数连续 \ 的个数
		let backslashes = 0;
		for (let i = lastQuote - 1; i >= 0 && s[i] === '\\'; i--) backslashes++;
		if (backslashes % 2 === 1) {
			// 转义的引号，再往前找
			s = s.slice(0, lastQuote);
		}
	}

	// 2. 去掉尾部不完整的 token（没写完的 key 或 value）
	//    从后往前找到最后一个结构性字符 , ] } " 之一
	const structural = /[,\]\}"]/;
	while (s.length > 0 && !structural.test(s[s.length - 1])) {
		s = s.slice(0, -1);
	}

	// 3. 如果尾部是逗号或冒号，去掉（不完整的下一个 entry）
	while (s.endsWith(',') || s.endsWith(':')) {
		s = s.slice(0, -1).trimEnd();
	}

	// 4. 计算缺失的括号，从后往前补齐
	const opens: string[] = [];
	let inString = false;
	let escape = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (escape) { escape = false; continue; }
		if (ch === '\\' && inString) { escape = true; continue; }
		if (ch === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (ch === '{' || ch === '[') opens.push(ch);
		if (ch === '}' || ch === ']') opens.pop();
	}

	// 如果还在字符串里面，先补一个引号
	if (inString) s += '"';

	// 反向补齐括号
	for (let i = opens.length - 1; i >= 0; i--) {
		s += opens[i] === '{' ? '}' : ']';
	}

	return s;
}

/**
 * 把 LLM 返回的原始 JSON 映射为内部 PodcastInsights 结构。
 */
function normalizeInsights(raw: unknown): PodcastInsights {
	const r = (raw || {}) as Record<string, unknown>;
	const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

	/**
	 * 从 LLM 返回的字段中宽容地解析秒数。
	 * LLM 可能返回 number (754) 或 string ("754")，都要接受。
	 */
	const parseSec = (...candidates: unknown[]): number | undefined => {
		for (const v of candidates) {
			if (typeof v === "number" && Number.isFinite(v)) return v;
			if (typeof v === "string") {
				const n = Number(v);
				if (Number.isFinite(n)) return n;
			}
		}
		return undefined;
	};

	const mapTopic = (x: Record<string, unknown>): TopicCluster => ({
		title: String(x.title || "").trim(),
		insight: String(x.insight || "").trim(),
		caseTitle: x.case_title ? String(x.case_title).trim() : (x.caseTitle ? String(x.caseTitle).trim() : undefined),
		caseContent: x.case_content ? String(x.case_content).trim() : (x.caseContent ? String(x.caseContent).trim() : undefined),
		startSeconds: parseSec(x.start_seconds, x.startSeconds),
		caseStartSeconds: parseSec(x.case_start_seconds, x.caseStartSeconds),
	});

	const mapAction = (x: Record<string, unknown>): ActionItem => ({
		content: String(x.content || "").trim(),
		startSeconds: parseSec(x.start_seconds, x.startSeconds),
	});

	const mapResource = (x: Record<string, unknown>): Resource => ({
		name: String(x.name || "").trim(),
		type: (["book", "article", "tool", "podcast", "other"].includes(String(x.type))
			? String(x.type) : "other") as Resource["type"],
		description: x.description ? String(x.description).trim() : undefined,
		startSeconds: parseSec(x.start_seconds, x.startSeconds),
	});

	const mapOutline = (x: Record<string, unknown>): OutlineNode => ({
		title: String(x.title || "").trim(),
		startSeconds: parseSec(x.start_seconds, x.startSeconds),
		children: arr<Record<string, unknown>>(x.children).map(mapOutline),
	});

	return {
		summary: String(r.summary || "").trim(),
		topics: arr<Record<string, unknown>>(r.topics)
			.map(mapTopic)
			.filter((it) => it.title && it.insight),
		actionItems: arr<Record<string, unknown>>(r.action_items || r.actionItems)
			.map(mapAction)
			.filter((it) => it.content),
		resources: arr<Record<string, unknown>>(r.resources)
			.map(mapResource)
			.filter((it) => it.name),
		outline: arr<Record<string, unknown>>(r.outline).map(mapOutline),
		tags: arr<string>(r.tags).map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean),
	};
}

/**
 * 解析 chat completions 的完整 endpoint。
 *
 * 规则：
 * - 如果用户填的 base URL 已经是完整路径（含 /chat/completions 或 /chatcompletion*），直接使用
 * - 如果是 MiniMax 的 endpoint（api.minimaxi.com 且只到 /v1），拼接 MiniMax 专用路径
 * - 其他情况按 OpenAI 标准拼接 /chat/completions
 */
function resolveChatEndpoint(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/$/, "");
	if (/\/(chat\/completions|chatcompletion_v2|chatcompletion_pro)$/i.test(trimmed)) {
		return trimmed;
	}
	// MiniMax 国内版的 OpenAI 兼容路径是 /text/chatcompletion_v2
	if (/api\.minimaxi?\.com\/v1$/i.test(trimmed)) {
		return `${trimmed}/text/chatcompletion_v2`;
	}
	return `${trimmed}/chat/completions`;
}

/**
 * 调用 LLM 生成结构化产出。按协议分发到 OpenAI 或 Anthropic 实现。
 */
export async function generateInsights(
	ctx: InsightContext,
	config: LlmConfig
): Promise<PodcastInsights> {
	if (!config.apiKey) {
		throw new Error("未配置 LLM API Key，请到插件设置中填写");
	}

	const rawContent =
		config.protocol === "anthropic"
			? await callAnthropic(ctx, config)
			: await callOpenAI(ctx, config);

	let parsed: unknown;
	const cleaned = stripCodeFence(rawContent);
	try {
		parsed = JSON.parse(cleaned);
	} catch (_firstErr) {
		// 尝试修复被截断的 JSON（常见于 max_tokens 不够的场景）
		try {
			const repaired = repairTruncatedJson(cleaned);
			parsed = JSON.parse(repaired);
			console.warn("[Podcast] LLM JSON 被截断，已自动修复");
		} catch (_repairErr) {
			throw new Error(
				`LLM 返回的不是合法 JSON（可能输出被截断，请在设置中增大 max_tokens 或缩短播客时长）。前 200 字符：${rawContent.slice(0, 200)}…`
			);
		}
	}

	return normalizeInsights(parsed);
}

/**
 * OpenAI 兼容 Chat Completions 调用，返回 message.content 字符串。
 */
async function callOpenAI(ctx: InsightContext, config: LlmConfig): Promise<string> {
	const endpoint = resolveChatEndpoint(config.baseUrl);

	const body: Record<string, unknown> = {
		model: config.model,
		temperature: 0.3,
		max_tokens: config.maxTokens || 8000,
		response_format: { type: "json_object" },
		messages: [
			{ role: "system", content: buildSystemPrompt() },
			{ role: "user", content: buildUserPrompt(ctx) },
		],
	};

	const response = await requestUrl({
		url: endpoint,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.apiKey}`,
		},
		body: JSON.stringify(body),
		throw: false,
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(
			`LLM API 调用失败 (${response.status})：${(response.text || "").slice(0, 300)}`
		);
	}

	const data = response.json as {
		choices?: Array<{ message?: { content?: string } }>;
	};

	const content = data.choices?.[0]?.message?.content;
	if (!content) throw new Error("LLM 返回为空");
	return content;
}

/**
 * Anthropic Messages API 调用（Claude 官方 / MiniMax Token Plan）。
 *
 * 关键差异：
 * - endpoint: {baseUrl}/v1/messages
 * - 鉴权：x-api-key + anthropic-version，不是 Bearer
 * - system 是顶层字段，不是 messages 里的角色
 * - 返回：content 是数组，首个 text block 的 .text 字段是正文
 * - 没有 response_format，靠 prompt 约束 JSON
 */
async function callAnthropic(ctx: InsightContext, config: LlmConfig): Promise<string> {
	const endpoint = resolveAnthropicEndpoint(config.baseUrl);

	const body = {
		model: config.model,
		max_tokens: config.maxTokens || 8000,
		temperature: 0.3,
		system: buildSystemPrompt() + "\n\n请记住：只输出一个 JSON 对象，不要任何前后缀说明。",
		messages: [
			{ role: "user", content: buildUserPrompt(ctx) },
		],
	};

	const response = await requestUrl({
		url: endpoint,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": config.apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify(body),
		throw: false,
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(
			`LLM API 调用失败 (${response.status})：${(response.text || "").slice(0, 300)}`
		);
	}

	const data = response.json as {
		content?: Array<{ type?: string; text?: string }>;
	};

	// 取第一个 type === "text" 的 block 的文本。MiniMax M2.7 可能会有 thinking block 在前，要跳过。
	const textBlock = (data.content || []).find((b) => b.type === "text" && b.text);
	const content = textBlock?.text;
	if (!content) throw new Error("LLM 返回为空（未找到 text block）");
	return content;
}

/**
 * Anthropic endpoint 解析。
 * - 如果用户填的 base URL 已经以 /v1/messages 结尾，直接用
 * - 否则拼 /v1/messages
 *
 * 示例：
 *   https://api.anthropic.com → https://api.anthropic.com/v1/messages
 *   https://api.minimaxi.com/anthropic → https://api.minimaxi.com/anthropic/v1/messages
 */
function resolveAnthropicEndpoint(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/$/, "");
	if (/\/v1\/messages$/i.test(trimmed)) return trimmed;
	return `${trimmed}/v1/messages`;
}

/**
 * 把转录 segments 压成紧凑的 "[mm:ss] 文本" 列表，供 Prompt 使用。
 * 太长的转录可能超 LLM 上下文，这里合并相邻短句减少 token 数。
 */
export function segmentsToPromptText(
	segments: Array<{ start: number; text: string }>,
	mergeThresholdSeconds = 8
): string {
	if (segments.length === 0) return "";
	const lines: string[] = [];
	let bucketStart = segments[0].start;
	let bucketText = "";
	for (const seg of segments) {
		if (seg.start - bucketStart > mergeThresholdSeconds && bucketText) {
			lines.push(`[${formatMMSS(bucketStart)}] ${bucketText.trim()}`);
			bucketStart = seg.start;
			bucketText = seg.text;
		} else {
			bucketText += (bucketText ? " " : "") + seg.text;
		}
	}
	if (bucketText.trim()) {
		lines.push(`[${formatMMSS(bucketStart)}] ${bucketText.trim()}`);
	}
	return lines.join("\n");
}

function formatMMSS(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
