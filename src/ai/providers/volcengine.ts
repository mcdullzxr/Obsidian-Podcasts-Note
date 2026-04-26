import { requestUrl } from "obsidian";
import type {
	TranscriptSegment,
	TranscriptionResult,
	WhisperConfig,
} from "../types";

/**
 * 火山引擎豆包录音文件识别（新版控制台）。
 *
 * 接口文档：https://www.volcengine.com/docs/6561/1354868
 *
 * 工作模式：
 * 1. 提交任务：POST /submit，服务端返回 task_id（在响应 header 里）
 * 2. 轮询查询：POST /query，直到 X-Api-Status-Code = 20000000
 *
 * 优势：
 * - 支持 URL 直接提交，不用下载到本地再上传
 * - 没有文件大小限制（适合播客长音频）
 * - 中文（含方言）识别质量顶级
 *
 * 鉴权（新版控制台）：X-Api-Key + X-Api-Resource-Id
 */

const SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";

const STATUS_SUCCESS = "20000000";
const STATUS_PROCESSING = "20000001";
const STATUS_QUEUED = "20000002";

/** 轮询间隔（毫秒）：先快后慢，避免占满配额 */
const POLL_INTERVALS_MS = [2000, 3000, 5000, 8000];
/** 最大轮询次数（总时长 ~10 分钟） */
const MAX_POLL_COUNT = 120;

export async function transcribeVolcengine(
	audioUrl: string,
	config: WhisperConfig
): Promise<TranscriptionResult> {
	if (!config.apiKey) {
		throw new Error("未配置火山 API Key");
	}
	if (!config.resourceId) {
		throw new Error("火山引擎需要配置 Resource ID（如 volc.seedasr.auc）");
	}

	const taskId = generateUuid();
	const format = inferFormat(audioUrl);

	// ==================== 1. 提交任务 ====================
	const submitRes = await requestUrl({
		url: SUBMIT_URL,
		method: "POST",
		headers: {
			"X-Api-Key": config.apiKey,
			"X-Api-Resource-Id": config.resourceId,
			"X-Api-Request-Id": taskId,
			"X-Api-Sequence": "-1",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			user: { uid: "obsidian-podvault" },
			audio: {
				format,
				url: audioUrl,
			},
			request: {
				model_name: "bigmodel",
				enable_itn: true,
				enable_punc: true,
				show_utterances: true,
				// 说话人识别：默认关，开启后 utterances[].additions.speaker 会返回说话人标识
				...(config.enableSpeakerDiarization
					? { enable_speaker_info: true }
					: {}),
			},
		}),
		throw: false,
	});

	const submitStatus = submitRes.headers["x-api-status-code"];
	if (submitStatus !== STATUS_SUCCESS) {
		const msg = submitRes.headers["x-api-message"] || submitRes.text?.slice(0, 300) || "未知错误";
		throw new Error(`火山任务提交失败 (${submitStatus})：${msg}`);
	}

	// ==================== 2. 轮询查询 ====================
	for (let i = 0; i < MAX_POLL_COUNT; i++) {
		await sleep(POLL_INTERVALS_MS[Math.min(i, POLL_INTERVALS_MS.length - 1)]);

		const queryRes = await requestUrl({
			url: QUERY_URL,
			method: "POST",
			headers: {
				"X-Api-Key": config.apiKey,
				"X-Api-Resource-Id": config.resourceId,
				"X-Api-Request-Id": taskId,
				"Content-Type": "application/json",
			},
			body: "{}",
			throw: false,
		});

		const status = queryRes.headers["x-api-status-code"];

		if (status === STATUS_SUCCESS) {
			return parseVolcResult(queryRes.json);
		}
		if (status === STATUS_PROCESSING || status === STATUS_QUEUED) {
			continue;
		}
		const msg = queryRes.headers["x-api-message"] || queryRes.text?.slice(0, 300) || "未知错误";
		throw new Error(`火山转录任务失败 (${status})：${msg}`);
	}

	throw new Error("火山转录超时（超过 10 分钟未完成）");
}

/**
 * 解析火山响应体为统一的 TranscriptionResult。
 *
 * 响应结构（简化）：
 * {
 *   "audio_info": { "duration": 3696 },
 *   "result": {
 *     "text": "完整文本...",
 *     "utterances": [
 *       { "start_time": 0, "end_time": 1705, "text": "这是字节跳动，", "definite": true, ... }
 *     ]
 *   }
 * }
 */
function parseVolcResult(data: unknown): TranscriptionResult {
	const root = (data as Record<string, unknown>) || {};
	const result = (root.result as Record<string, unknown>) || {};
	const audioInfo = (root.audio_info as Record<string, unknown>) || {};

	const utterances = (result.utterances as Array<Record<string, unknown>>) || [];
	const segments: TranscriptSegment[] = utterances.map((u) => ({
		start: toSeconds(u.start_time),
		end: toSeconds(u.end_time),
		text: String(u.text || "").trim(),
		speaker: extractSpeaker(u),
	}));

	const fullText =
		typeof result.text === "string" && result.text
			? result.text
			: segments.map((s) => s.text).join("");

	return {
		fullText: fullText.trim(),
		segments,
		language: "zh",
		duration: typeof audioInfo.duration === "number" ? audioInfo.duration / 1000 : undefined,
	};
}

/** 火山时间戳为毫秒，统一转秒 */
function toSeconds(v: unknown): number {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n / 1000 : 0;
}

/**
 * 从 utterance 中提取说话人标识，兼容多种返回格式。
 * - BigASR: utterances[].additions.speaker（字符串或数字）
 * - SeedASR: utterances[].speaker
 * - 其他字段兼容：user / speaker_id
 * 返回符合人类阅读习惯的格式：「发言人 1」（说话人小于 10）或「S<id>」。
 */
function extractSpeaker(u: Record<string, unknown>): string | undefined {
	const additions = (u.additions as Record<string, unknown>) || {};
	const raw =
		u.speaker ?? additions.speaker ?? u.speaker_id ?? additions.speaker_id ?? u.user;
	if (raw === undefined || raw === null || raw === "") return undefined;
	const s = String(raw).trim();
	if (!s) return undefined;
	// 纯数字 → 人语言标签
	if (/^\d+$/.test(s)) return `发言人 ${s}`;
	return s;
}

/** 从 URL 推断音频格式（火山必填 format 字段） */
function inferFormat(url: string): string {
	const m = url.split("?")[0].match(/\.(mp3|wav|m4a|ogg|aac|flac)$/i);
	if (!m) return "mp3";
	const ext = m[1].toLowerCase();
	// 火山支持的 format 值：raw / wav / mp3 / ogg；其他格式按 mp3 处理（多数 AAC/M4A 播客服务端能正确解码）
	if (ext === "wav" || ext === "mp3" || ext === "ogg") return ext;
	return "mp3";
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** 简单 UUID v4（不依赖 crypto，避免环境差异） */
function generateUuid(): string {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}
