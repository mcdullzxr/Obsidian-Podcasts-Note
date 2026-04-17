/**
 * AI 提炼后的结构化产出，对应笔记模板里的各个 section。
 */
export interface PodcastInsights {
	/** 摘要：3-5 句话概括 */
	summary: string;
	/** 知识点（概念、名词、原理、框架等） */
	knowledgePoints: InsightItem[];
	/** 有趣的案例、故事 */
	cases: InsightItem[];
	/** 结构化大纲 */
	outline: OutlineNode[];
	/** 推荐的标签 */
	tags: string[];
}

export interface InsightItem {
	/** 小标题（如概念名） */
	title: string;
	/** 内容描述 */
	content: string;
	/** 开始时间戳（秒），用于在笔记里标注 ⏱️ */
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

export interface LlmConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
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
