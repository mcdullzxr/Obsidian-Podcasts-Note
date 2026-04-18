import { Vault, normalizePath } from "obsidian";
import type { TranscriptionResult } from "../ai/types";

/**
 * 转录缓存管理。
 *
 * 缓存文件存放在 `.podcast-cache/` 隐藏目录下（不会出现在 Obsidian 笔记列表中），
 * 文件名为 `{episodeId}.json`，内容是 TranscriptionResult 的 JSON 序列化。
 *
 * 好处：
 * - 避免重复调用 Whisper（省 ~80% 费用）
 * - LLM 提炼失败时重试只需跑 LLM，不需要重新转录
 * - 支持「重新生成」功能：只重跑 LLM，复用转录
 */

const CACHE_DIR = ".podcast-cache";

function cachePath(episodeId: string): string {
	return normalizePath(`${CACHE_DIR}/${episodeId}.json`);
}

/**
 * 查询是否有缓存的转录结果。
 */
export async function getCachedTranscript(
	vault: Vault,
	episodeId: string
): Promise<TranscriptionResult | null> {
	const path = cachePath(episodeId);
	try {
		if (!(await vault.adapter.exists(path))) return null;
		const raw = await vault.adapter.read(path);
		const data = JSON.parse(raw) as TranscriptionResult;
		// 简单校验
		if (!data.segments || !Array.isArray(data.segments)) return null;
		return data;
	} catch {
		return null;
	}
}

/**
 * 保存转录结果到缓存。
 */
export async function saveCachedTranscript(
	vault: Vault,
	episodeId: string,
	transcript: TranscriptionResult
): Promise<void> {
	const dir = normalizePath(CACHE_DIR);
	if (!(await vault.adapter.exists(dir))) {
		await vault.adapter.mkdir(dir);
	}
	const path = cachePath(episodeId);
	await vault.adapter.write(path, JSON.stringify(transcript));
}

/**
 * 删除某个 episode 的缓存（如需重新转录）。
 */
export async function removeCachedTranscript(
	vault: Vault,
	episodeId: string
): Promise<void> {
	const path = cachePath(episodeId);
	try {
		if (await vault.adapter.exists(path)) {
			await vault.adapter.remove(path);
		}
	} catch {
		// ignore
	}
}
