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
 * Whisper 配置（来自插件 settings）。
 */
export interface WhisperConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
}

/** OpenAI Whisper 单次上传上限 */
export const WHISPER_MAX_BYTES = 25 * 1024 * 1024;
