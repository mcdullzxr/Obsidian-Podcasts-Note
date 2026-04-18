import type { PodcastMetadata } from "../parsers/types";

/**
 * 去掉文件系统不允许的字符。
 */
export function sanitizeFilename(name: string): string {
	return name
		.replace(/[\\/:*?"<>|]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);
}

/**
 * 生成音频文件的稳定 basename（不含扩展名）。
 *
 * 优先规则：
 * 1. 小宇宙：从 sourceUrl `/episode/{id}` 提取 id
 * 2. 其他平台：`date-title` 经 sanitize
 */
export function getEpisodeId(meta: PodcastMetadata): string {
	// 小宇宙
	const xyz = meta.sourceUrl.match(/\/episode\/([a-zA-Z0-9]+)/);
	if (xyz && xyz[1]) return xyz[1];

	// 通用：date + title
	const raw = `${meta.publishDate}-${meta.title}`;
	return sanitizeFilename(raw) || "episode";
}
