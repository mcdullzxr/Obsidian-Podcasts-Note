import { requestUrl } from "obsidian";
import type { PodcastMetadata, PodcastParser } from "./types";

/**
 * 小宇宙播客解析器。
 *
 * 小宇宙单集页面 URL 形如 https://www.xiaoyuzhoufm.com/episode/xxx
 * 页面是 Next.js SSR，HTML 内嵌 __NEXT_DATA__ JSON 提供完整结构化数据，
 * 同时包含标准 OpenGraph meta 标签。
 *
 * 解析顺序：
 *  1. __NEXT_DATA__（最全，首选）
 *  2. OpenGraph meta（降级兜底）
 */
export class XiaoyuzhouParser implements PodcastParser {
	canParse(url: string): boolean {
		return /^https?:\/\/(www\.)?xiaoyuzhoufm\.com\/episode\//i.test(url);
	}

	async parse(url: string): Promise<PodcastMetadata> {
		const response = await requestUrl({
			url,
			method: "GET",
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
			},
		});

		if (response.status !== 200) {
			throw new Error(`小宇宙页面请求失败，状态码：${response.status}`);
		}

		const html = response.text;

		// 优先尝试 __NEXT_DATA__
		const fromNextData = this.tryParseNextData(html, url);
		if (fromNextData) return fromNextData;

		// 降级到 OpenGraph
		const fromOg = this.tryParseOpenGraph(html, url);
		if (fromOg) return fromOg;

		throw new Error("无法从小宇宙页面提取播客信息，页面结构可能已变更");
	}

	/**
	 * 尝试解析 Next.js 注入的 __NEXT_DATA__。
	 * 结构大致：props.pageProps.episode { title, podcast { title }, pubDate, duration, description, enclosure { url }, image { picUrl } }
	 * 不同版本字段名可能有差异，所以做了较多兼容处理。
	 */
	private tryParseNextData(html: string, url: string): PodcastMetadata | null {
		const match = html.match(
			/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
		);
		if (!match) return null;

		try {
			const data = JSON.parse(match[1]);
			const episode =
				data?.props?.pageProps?.episode ||
				data?.props?.pageProps?.data?.episode ||
				null;
			if (!episode) return null;

			const audioUrl: string =
				episode.enclosure?.url ||
				episode.media?.source?.url ||
				episode.audio?.url ||
				"";
			if (!audioUrl) return null;

			const podcastName: string =
				episode.podcast?.title ||
				episode.podcast?.name ||
				episode.podcastTitle ||
				"未知节目";

			return {
				title: episode.title || "未命名单集",
				podcastName,
				publishDate: this.formatDate(episode.pubDate || episode.publishDate),
				duration: this.formatDuration(episode.duration),
				description: this.stripHtml(episode.description || episode.shownotes || ""),
				audioUrl,
				coverUrl:
					episode.image?.picUrl ||
					episode.image?.url ||
					episode.podcast?.image?.picUrl ||
					undefined,
				sourceUrl: url,
				platform: "xiaoyuzhou",
			};
		} catch {
			return null;
		}
	}

	/**
	 * OpenGraph 降级方案。
	 * 小宇宙页面一般有 og:title / og:description / og:image / og:audio 等标签。
	 */
	private tryParseOpenGraph(html: string, url: string): PodcastMetadata | null {
		const pickMeta = (property: string): string | undefined => {
			const re = new RegExp(
				`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`,
				"i"
			);
			const r = html.match(re);
			if (r) return r[1];
			// 有些页面属性顺序相反
			const re2 = new RegExp(
				`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`,
				"i"
			);
			const r2 = html.match(re2);
			return r2?.[1];
		};

		const audioUrl = pickMeta("og:audio") || pickMeta("twitter:player:stream");
		if (!audioUrl) return null;

		return {
			title: pickMeta("og:title") || "未命名单集",
			podcastName: pickMeta("og:site_name") || "小宇宙",
			publishDate: this.formatDate(pickMeta("article:published_time")),
			description: pickMeta("og:description") || "",
			audioUrl,
			coverUrl: pickMeta("og:image"),
			sourceUrl: url,
			platform: "xiaoyuzhou",
		};
	}

	private formatDate(input?: string | number | Date): string {
		if (!input) return new Date().toISOString().slice(0, 10);
		const d = new Date(input);
		if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
		return d.toISOString().slice(0, 10);
	}

	/**
	 * 小宇宙返回的 duration 可能是秒数（number）或字符串。
	 */
	private formatDuration(input?: number | string): string | undefined {
		if (input === undefined || input === null) return undefined;
		const totalSeconds =
			typeof input === "number" ? Math.floor(input) : this.parseHms(String(input));
		if (!totalSeconds || totalSeconds <= 0) return undefined;
		const h = Math.floor(totalSeconds / 3600);
		const m = Math.floor((totalSeconds % 3600) / 60);
		const s = totalSeconds % 60;
		const pad = (n: number) => n.toString().padStart(2, "0");
		return `${pad(h)}:${pad(m)}:${pad(s)}`;
	}

	private parseHms(input: string): number {
		// 尝试解析 "hh:mm:ss" / "mm:ss" / 纯数字
		if (/^\d+$/.test(input)) return parseInt(input, 10);
		const parts = input.split(":").map((p) => parseInt(p, 10));
		if (parts.some(isNaN)) return 0;
		if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
		if (parts.length === 2) return parts[0] * 60 + parts[1];
		return 0;
	}

	private stripHtml(html: string): string {
		return html
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<[^>]+>/g, "")
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/\s+/g, " ")
			.trim();
	}
}
