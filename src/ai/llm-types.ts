/**
 * AI 提炼后的结构化产出，对应笔记模板里的各个 section。
 */
export interface PodcastInsights {
	/** 摘要：3-5 句话概括 */
	summary: string;
	/** 话题聚类：按讨论话题分组，每组包含核心观点 + 案例佐证 */
	topics: TopicCluster[];
	/** 行动建议：听完能做什么（可选，不是每期都有） */
	actionItems: ActionItem[];
	/** 延伸阅读/资源：播客中提到的书、文章、工具等 */
	resources: Resource[];
	/** 结构化大纲 */
	outline: OutlineNode[];
	/** 推荐的标签 */
	tags: string[];
}

/**
 * 话题聚类：一个讨论话题 = 核心观点 + 案例佐证。
 * 把播客按「聊了什么话题」来组织，概念和案例天然关联。
 */
export interface TopicCluster {
	/** 话题标题（如"第一性原理思维"） */
	title: string;
	/** 核心观点/概念的清晰解释 */
	insight: string;
	/** 佐证案例的标题（可选） */
	caseTitle?: string;
	/** 佐证案例内容（可选，不是每个话题都有案例） */
	caseContent?: string;
	/** 该话题在逐字稿中首次出现的时间戳（秒） */
	startSeconds?: number;
	/** 案例对应的时间戳（秒，可选） */
	caseStartSeconds?: number;
}

export interface ActionItem {
	/** 行动建议内容 */
	content: string;
	/** 时间戳（秒） */
	startSeconds?: number;
}

export interface Resource {
	/** 资源名称（如书名、工具名） */
	name: string;
	/** 类型 */
	type: "book" | "article" | "tool" | "podcast" | "other";
	/** 简短描述 */
	description?: string;
	/** 时间戳（秒） */
	startSeconds?: number;
}

/**
 * 大纲节点，支持嵌套。
 */
export interface OutlineNode {
	title: string;
	startSeconds?: number;
	children?: OutlineNode[];
}

/**
 * LLM 协议类型。
 * - openai: /chat/completions 标准格式（OpenAI / DeepSeek / 硕基流动 / MiniMax M2-her / 温度等）
 * - anthropic: /v1/messages 格式（Claude 官方 / MiniMax M2.7 等通过 Anthropic 协议的服务商）
 */
export type LlmProtocol = "openai" | "anthropic";

export interface LlmConfig {
	/** 协议类型，决定 endpoint/鉴权/序列化格式 */
	protocol: LlmProtocol;
	apiKey: string;
	baseUrl: string;
	model: string;
	/** 最大输出 token 数（默认 8000） */
	maxTokens?: number;
}

/**
 * Prompt 的输入上下文。
 */
export interface InsightContext {
	/** 节目名称 */
	podcastName: string;
	/** 单集标题 */
	episodeTitle: string;
	/** 单集简介（可选） */
	description?: string;
	/** 带时间戳的转录分段（原始格式最利于 LLM 理解） */
	transcriptWithTimestamps: string;
	/** 用户已有的标签列表，用于标签复用 */
	existingTags?: string[];
}
