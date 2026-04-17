import { requestUrl } from "obsidian";
import type {
	TranscriptSegment,
	TranscriptionResult,
	WhisperConfig,
} from "../types";

/**
 * 阿里云百炼 Paraformer 录音文件识别 (DashScope)。
 *
 * 接口文档：https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-restful-api
 *
 * 工作模式：
 * 1. 提交任务：POST /services/audio/asr/transcription，返回 task_id
 * 2. 轮询任务：POST /tasks/{task_id}，直到 task_status = SUCCEEDED
 * 3. 下载结果：结果 JSON 保存在 transcription_url，需要 GET 拉取
 *
 * 优势：文件支持最大 2GB、时长 12 小时，URL 直接提交。
 * 推荐模型：paraformer-v2
 */

const SUBMIT_URL = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";
const QUERY_URL_PREFIX = "https://dashscope.aliyuncs.com/api/v1/tasks/";

const POLL_INTERVALS_MS = [3000, 5000, 5000, 10000];
const MAX_POLL_COUNT = 120; // ~ 15min 上限

export async function transcribeDashScope(
	audioUrl: string,
	config: WhisperConfig
): Promise<TranscriptionResult> {
	if (!config.apiKey) {
		throw new Error("未配置 DashScope API Key");
	}
	const model = config.model || "paraformer-v2";

	// ==================== 1. 提交任务 ====================
	const submitRes = await requestUrl({
		url: SUBMIT_URL,
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			"Content-Type": "application/json",
			"X-DashScope-Async": "enable",
		},
		body: JSON.stringify({
			model,
			input: { file_urls: [audioUrl] },
			parameters: {
				channel_id: [0],
				language_hints: ["zh", "en"],
			},
		}),
		throw: false,
	});

	if (submitRes.status < 200 || submitRes.status >= 300) {
		throw new Error(
			`DashScope 任务提交失败 (${submitRes.status})：${(submitRes.text || "").slice(0, 300)}`
		);
	}

	const submitJson = submitRes.json as {
		output?: { task_id?: string; task_status?: string };
		code?: string;
		message?: string;
	};
	const taskId = submitJson.output?.task_id;
	if (!taskId) {
		throw new Error(`DashScope 未返回 task_id：${JSON.stringify(submitJson).slice(0, 300)}`);
	}

	// ==================== 2. 轮询任务 ====================
	let transcriptionUrl: string | null = null;
	for (let i = 0; i < MAX_POLL_COUNT; i++) {
		await sleep(POLL_INTERVALS_MS[Math.min(i, POLL_INTERVALS_MS.length - 1)]);

		const queryRes = await requestUrl({
			url: `${QUERY_URL_PREFIX}${taskId}`,
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
			},
			body: "{}",
			throw: false,
		});

		if (queryRes.status < 200 || queryRes.status >= 300) {
			throw new Error(
				`DashScope 查询失败 (${queryRes.status})：${(queryRes.text || "").slice(0, 300)}`
			);
		}

		const queryJson = queryRes.json as {
			output?: {
				task_status?: string;
				results?: Array<{
					subtask_status?: string;
					transcription_url?: string;
					code?: string;
					message?: string;
				}>;
			};
		};
		const status = queryJson.output?.task_status;

		if (status === "SUCCEEDED") {
			const first = queryJson.output?.results?.[0];
			if (!first || first.subtask_status !== "SUCCEEDED") {
				throw new Error(
					`DashScope 子任务失败：${first?.code || ""} ${first?.message || ""}`
				);
			}
			transcriptionUrl = first.transcription_url || null;
			break;
		}
		if (status === "FAILED" || status === "CANCELED") {
			throw new Error(`DashScope 任务状态异常：${status}`);
		}
		// PENDING / RUNNING 继续轮询
	}

	if (!transcriptionUrl) {
		throw new Error("DashScope 转录超时（超过 15 分钟未完成）");
	}

	// ==================== 3. 下载结果 JSON ====================
	const resultRes = await requestUrl({
		url: transcriptionUrl,
		method: "GET",
		throw: false,
	});
	if (resultRes.status < 200 || resultRes.status >= 300) {
		throw new Error(`下载 DashScope 识别结果失败 (${resultRes.status})`);
	}
	return parseDashScopeResult(resultRes.json);
}

/**
 * 解析 DashScope 结果 JSON。
 *
 * 结构（精简）：
 * {
 *   "original_duration": 123456,         // ms
 *   "transcripts": [
 *     {
 *       "channel_id": 0,
 *       "text": "完整文本...",
 *       "sentences": [
 *         { "begin_time": 0, "end_time": 1705, "text": "这是字节跳动，", "speaker_id": 0 }
 *       ]
 *     }
 *   ]
 * }
 */
function parseDashScopeResult(data: unknown): TranscriptionResult {
	const root = (data as Record<string, unknown>) || {};
	const transcripts = (root.transcripts as Array<Record<string, unknown>>) || [];
	const primary = transcripts[0] || {};

	const sentences = (primary.sentences as Array<Record<string, unknown>>) || [];
	const segments: TranscriptSegment[] = sentences.map((s) => ({
		start: toSeconds(s.begin_time),
		end: toSeconds(s.end_time),
		text: String(s.text || "").trim(),
		speaker: s.speaker_id != null ? `S${s.speaker_id}` : undefined,
	}));

	const fullText =
		typeof primary.text === "string" && primary.text
			? primary.text
			: segments.map((s) => s.text).join("");

	return {
		fullText: fullText.trim(),
		segments,
		language: "zh",
		duration:
			typeof root.original_duration === "number"
				? root.original_duration / 1000
				: undefined,
	};
}

function toSeconds(v: unknown): number {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n / 1000 : 0;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
