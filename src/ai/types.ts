/**
 * 转录单段（segment）：一段带时间戳的文字。
 */
export interface TranscriptSegment {
	/** 开始时间（秒） */
	start: number;
	/** 结束时间（秒） */
	end: number;
	/** 文字内容 */
	text: string;
	/** 说话人标识（首版通常为空，后续支持 diarization） */
	speaker?: string;
}

/**
 * 转录结果。
 */
export interface TranscriptionResult {
	/** 完整的文字（所有 segment 拼接） */
	fullText: string;
	/** 带时间戳的分段 */
	segments: TranscriptSegment[];
	/** 识别出的语言 ISO 码（如 "zh"、"en"），可选 */
	language?: string;
	/** 音频总时长（秒），可选 */
	duration?: number;
}

/**
 * 转录服务商。
 * - openai: OpenAI Whisper 兼容接口（含硅基流动等）——multipart 上传，<25MB
 * - volcengine: 火山引擎豆包录音文件识别——传 URL，提交+轮询，无大小限制
 * - dashscope: 阿里云百炼 Paraformer——传 URL，提交+轮询，文件不超过 2GB
 */
export type WhisperProvider = "openai" | "volcengine" | "dashscope";

/**
 * Whisper 配置（来自插件 settings）。
 */
export interface WhisperConfig {
	/** 服务商类型 */
	provider: WhisperProvider;
	/** API Key（火山新版控制台为 X-Api-Key，其他为 Bearer） */
	apiKey: string;
	/** 模型名称（openai/dashscope 使用，火山固定为 bigmodel） */
	model?: string;
	/** OpenAI 兼容服务的 base URL（仅 openai 类型使用） */
	baseUrl?: string;
	/** 火山资源 ID，如 volc.seedasr.auc / volc.bigasr.auc */
	resourceId?: string;
}

/** OpenAI Whisper 单次上传上限 */
export const WHISPER_MAX_BYTES = 25 * 1024 * 1024;
