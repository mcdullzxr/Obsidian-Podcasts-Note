import type { PodcastMetadata, PodcastParser } from "./types";
import { XiaoyuzhouParser } from "./xiaoyuzhou";

/**
 * 解析器注册表。新平台加解析器后在此注册即可。
 */
const parsers: PodcastParser[] = [new XiaoyuzhouParser()];

/**
 * 根据 URL 自动选择解析器并提取元数据。
 */
export async function parsePodcastUrl(url: string): Promise<PodcastMetadata> {
	const parser = parsers.find((p) => p.canParse(url));
	if (!parser) {
		throw new Error(
			"未识别的播客平台。目前仅支持小宇宙（https://www.xiaoyuzhoufm.com/episode/...）。"
		);
	}
	return parser.parse(url);
}

export type { PodcastMetadata, PodcastParser } from "./types";
