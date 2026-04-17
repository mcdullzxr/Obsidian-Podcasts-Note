/**
 * 播客元数据的统一接口。
 *
 * 不同平台（小宇宙、Spotify、RSS）的解析器产出统一结构，
 * 方便下游的转录、AI 提炼、笔记生成模块按同一契约工作。
 */
export interface PodcastMetadata {
	/** 单集标题 */
	title: string;
	/** 节目名称（如"随机波动"） */
	podcastName: string;
	/** 发布日期 ISO 字符串（YYYY-MM-DD） */
	publishDate: string;
	/** 时长（格式化字符串，如 "01:23:45"），可选 */
	duration?: string;
	/** 单集简介/Shownotes（HTML 会被转换成纯文本） */
	description?: string;
	/** 音频文件直链（.mp3 等），转录必需 */
	audioUrl: string;
	/** 封面图 URL */
	coverUrl?: string;
	/** 原始页面链接 */
	sourceUrl: string;
	/** 识别出的平台来源 */
	platform: "xiaoyuzhou" | "spotify" | "rss" | "unknown";
}

/**
 * 播客解析器接口。每个平台实现一个。
 */
export interface PodcastParser {
	/** 判断给定 URL 是否归属本平台 */
	canParse(url: string): boolean;
	/** 解析并返回统一元数据 */
	parse(url: string): Promise<PodcastMetadata>;
}
