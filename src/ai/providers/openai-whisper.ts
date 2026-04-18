import { requestUrl } from "obsidian";
import {
	WHISPER_MAX_BYTES,
	type TranscriptSegment,
	type TranscriptionResult,
	type WhisperConfig,
} from "../types";
import { downloadAudio, guessExtension } from "../../utils/audio";

/**
 * OpenAI Whisper 兼容接口（含硅基流动、Groq 等）。
 *
 * 通过 multipart/form-data 上传音频文件，返回 verbose_json 获取带时间戳的 segments。
 * 受 25MB 单次上传限制。
 */
export async function transcribeOpenAI(
	audioUrl: string,
	config: WhisperConfig,
	language?: string
): Promise<TranscriptionResult> {
	if (!config.baseUrl) {
		throw new Error("OpenAI 兼容服务需要配置 Base URL");
	}
	if (!config.model) {
		throw new Error("OpenAI 兼容服务需要配置模型名");
	}

	const { buffer, contentType } = await downloadAudio(audioUrl);

	if (buffer.byteLength > WHISPER_MAX_BYTES) {
		const mb = (buffer.byteLength / 1024 / 1024).toFixed(1);
		throw new Error(
			`音频文件大小 ${mb}MB 超过 25MB 上限。建议改用火山引擎或通义 Paraformer（支持 URL 直接提交，无大小限制）。`
		);
	}

	const ext = guessExtension(contentType, audioUrl);
	const filename = `audio.${ext}`;

	const boundary = `----PodcastNote${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
	const multipartBody = buildMultipartBody(boundary, buffer, {
		filename,
		contentType,
		model: config.model,
		responseFormat: "verbose_json",
		language,
	});

	const endpoint = `${config.baseUrl.replace(/\/$/, "")}/audio/transcriptions`;

	const response = await requestUrl({
		url: endpoint,
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
		},
		body: multipartBody,
		throw: false,
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(
			`Whisper API 调用失败 (${response.status})：${(response.text || "").slice(0, 300)}`
		);
	}

	const data = response.json as {
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
 * 手动构造 multipart/form-data body（ArrayBuffer）。
 */
function buildMultipartBody(
	boundary: string,
	fileBuffer: ArrayBuffer,
	fields: {
		filename: string;
		contentType: string;
		model: string;
		responseFormat: string;
		language?: string;
	}
): ArrayBuffer {
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	const CRLF = "\r\n";

	const appendText = (s: string) => parts.push(encoder.encode(s));
	const appendField = (name: string, value: string) => {
		appendText(`--${boundary}${CRLF}`);
		appendText(`Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`);
		appendText(`${value}${CRLF}`);
	};

	appendField("model", fields.model);
	appendField("response_format", fields.responseFormat);
	if (fields.language) appendField("language", fields.language);

	appendText(`--${boundary}${CRLF}`);
	appendText(
		`Content-Disposition: form-data; name="file"; filename="${fields.filename}"${CRLF}`
	);
	appendText(`Content-Type: ${fields.contentType}${CRLF}${CRLF}`);
	parts.push(new Uint8Array(fileBuffer));
	appendText(CRLF);
	appendText(`--${boundary}--${CRLF}`);

	const totalLen = parts.reduce((sum, p) => sum + p.byteLength, 0);
	const merged = new Uint8Array(totalLen);
	let offset = 0;
	for (const p of parts) {
		merged.set(p, offset);
		offset += p.byteLength;
	}
	return merged.buffer;
}
