import { requestUrl, normalizePath, type Vault } from "obsidian";

/**
 * 递归确保多级文件夹存在。
 */
async function ensureFolderExists(vault: Vault, folderPath: string): Promise<void> {
	const folder = normalizePath(folderPath);
	if (await vault.adapter.exists(folder)) return;
	const parent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
	if (parent) await ensureFolderExists(vault, parent);
	await vault.createFolder(folder);
}

/**
 * 音频下载结果。
 */
export interface DownloadedAudio {
	buffer: ArrayBuffer;
	contentType: string;
	ext: string; // 不含点，如 "mp3"
}

/**
 * 下载远程音频到内存 ArrayBuffer。
 *
 * 通过 Obsidian 的 requestUrl 避免 CORS；带一个浏览器 UA 以通过部分 CDN 的反爬。
 */
export async function downloadAudio(audioUrl: string): Promise<DownloadedAudio> {
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
	return {
		buffer: res.arrayBuffer,
		contentType,
		ext: guessExtension(contentType, audioUrl),
	};
}

/**
 * 从 Content-Type 或 URL 后缀猜扩展名，兜底 mp3。
 */
export function guessExtension(contentType: string, url: string): string {
	const map: Record<string, string> = {
		"audio/mpeg": "mp3",
		"audio/mp3": "mp3",
		"audio/mp4": "m4a",
		"audio/x-m4a": "m4a",
		"audio/aac": "aac",
		"audio/wav": "wav",
		"audio/x-wav": "wav",
		"audio/webm": "webm",
		"audio/ogg": "ogg",
		"audio/flac": "flac",
	};
	const lowerCt = (contentType || "").split(";")[0].trim().toLowerCase();
	if (map[lowerCt]) return map[lowerCt];
	const urlExt = url.split("?")[0].match(/\.(mp3|m4a|aac|wav|webm|ogg|flac)$/i)?.[1];
	return (urlExt || "mp3").toLowerCase();
}

/**
 * 把音频保存到 Vault 指定路径（相对 Vault 根）。
 * - 目录不存在会自动创建
 * - 同名文件已存在则直接跳过下载（天然缓存）
 *
 * @returns 最终相对 Vault 的路径（归一化）
 */
export async function saveAudioToVault(
	vault: Vault,
	folder: string,
	basename: string,
	audioUrl: string
): Promise<{ path: string; reused: boolean; buffer?: ArrayBuffer; contentType?: string }> {
	const normalizedFolder = normalizePath(folder);
	await ensureFolderExists(vault, normalizedFolder);

	// 先看是否已经存在（尝试常见扩展名优先匹配 mp3/m4a）
	for (const ext of ["mp3", "m4a", "aac", "wav", "webm", "ogg", "flac"]) {
		const candidate = normalizePath(`${normalizedFolder}/${basename}.${ext}`);
		if (await vault.adapter.exists(candidate)) {
			return { path: candidate, reused: true };
		}
	}

	const downloaded = await downloadAudio(audioUrl);
	const finalPath = normalizePath(`${normalizedFolder}/${basename}.${downloaded.ext}`);
	await vault.createBinary(finalPath, downloaded.buffer);
	return {
		path: finalPath,
		reused: false,
		buffer: downloaded.buffer,
		contentType: downloaded.contentType,
	};
}
