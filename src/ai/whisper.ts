import { requestUrl } from "obsidian";
import {
	WHISPER_MAX_BYTES,
	type TranscriptSegment,
	type TranscriptionResult,
	type WhisperConfig,
} from "./types";

/**
 * 下载音频文件为 ArrayBuffer。
 *
 * 使用 Obsidian 的 requestUrl 绕过 CORS，同时拿到 content-type 用于构造 multipart。
 */
export async function downloadAudio(audioUrl: string): Promise<{
	buffer: ArrayBuffer;
	contentType: string;
}> {
	const res = await requestUrl({
		url: audioUrl,
		method: "GET",
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
		},
	});
	if (res.status !== 200) {
		throw new Error(`音频下载失败，状态码：${res.status}`);
	}
	const contentType =
		res.headers["content-type"] || res.headers["Content-Type"] || "audio/mpeg";
	return { buffer: res.arrayBuffer, contentType };
}

/**
 * 从 Content-Type 或 URL 推断文件扩展名，用于 multipart 的 filename 字段。
 * Whisper API 通过扩展名判断格式。
 */
function inferExtension(contentType: string, url: string): string {
	const map: Record<string, string> = {
		"audio/mpeg": "mp3",
		"audio/mp3": "mp3",
		"audio/mp4": "m4a",
		"audio/x-m4a": "m4a",
		"audio/wav": "wav",
		"audio/x-wav": "wav",
		"audio/webm": "webm",
		"audio/ogg": "ogg",
		"audio/flac": "flac",
	};
	const lowerCt = contentType.split(";")[0].trim().toLowerCase();
	if (map[lowerCt]) return map[lowerCt];
	const urlExt = url.split("?")[0].match(/\.(mp3|m4a|wav|webm|ogg|flac)$/i)?.[1];
	return (urlExt || "mp3").toLowerCase();
}

/**
 * 调用 Whisper 兼容 API 转录音频。
 *
 * 使用 verbose_json 格式获取带时间戳的 segments。
 * 首版不做大文件分片，超过上限直接抛出错误提示用户。
 */
export async function transcribeAudio(
	audioUrl: string,
	config: WhisperConfig,
	language?: string
): Promise<TranscriptionResult> {
	if (!config.apiKey) {
		throw new Error("未配置 Whisper API Key，请到插件设置中填写");
	}

	const { buffer, contentType } = await downloadAudio(audioUrl);

	if (buffer.byteLength > WHISPER_MAX_BYTES) {
		const mb = (buffer.byteLength / 1024 / 1024).toFixed(1);
		throw new Error(
			`音频文件大小 ${mb}MB 超过 25MB 上限。建议：(1) 选择时长较短的单集；(2) 改用支持大文件的服务商（如硅基流动）；(3) 等待后续版本支持自动分片。`
		);
	}

	const ext = inferExtension(contentType, audioUrl);
	const filename = `audio.${ext}`;

	// 构造 multipart/form-data
	const form = new FormData();
	form.append("file", new Blob([buffer], { type: contentType }), filename);
	form.append("model", config.model);
	form.append("response_format", "verbose_json");
	if (language) form.append("language", language);

	const endpoint = `${config.baseUrl.replace(/\/$/, "")}/audio/transcriptions`;

	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
		},
		body: form,
	});

	if (!response.ok) {
		const errText = await response.text().catch(() => "");
		throw new Error(
			`Whisper API 调用失败 (${response.status})：${errText.slice(0, 300)}`
		);
	}

	const data = (await response.json()) as {
		text?: string;
		language?: string;
		duration?: number;
		segments?: Array<{ start: number; end: number; text: string }>;
	};

	const segments: TranscriptSegment[] = (data.segments || []).map((s) => ({
		start: s.start,
		end: s.end,
		text: (s.text || "").trim(),
	}));

	return {
		fullText: (data.text || segments.map((s) => s.text).join(" ")).trim(),
		segments,
		language: data.language,
		duration: data.duration,
	};
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
