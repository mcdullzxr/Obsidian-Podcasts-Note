import { transcribeOpenAI } from "./providers/openai-whisper";
import { transcribeVolcengine } from "./providers/volcengine";
import { transcribeDashScope } from "./providers/dashscope";
import type { TranscriptionResult, WhisperConfig } from "./types";

/**
 * 统一转录入口：按 provider 分发到对应实现。
 *
 * - openai: OpenAI 兼容接口（含硅基流动），multipart 上传，<25MB
 * - volcengine: 火山引擎豆包，URL 提交 + 轮询，无大小限制
 * - dashscope: 阿里云百炼 Paraformer，URL 提交 + 轮询，<2GB/<12h
 */
export async function transcribeAudio(
	audioUrl: string,
	config: WhisperConfig,
	language?: string
): Promise<TranscriptionResult> {
	if (!config.apiKey) {
		throw new Error("未配置 API Key，请到插件设置中填写");
	}

	switch (config.provider) {
		case "volcengine":
			return transcribeVolcengine(audioUrl, config);
		case "dashscope":
			return transcribeDashScope(audioUrl, config);
		case "openai":
		default:
			return transcribeOpenAI(audioUrl, config, language);
	}
}

/**
 * 把秒数格式化为 hh:mm:ss 或 mm:ss（时长 < 1 小时时省略小时位）。
 */
export function formatTimestamp(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
