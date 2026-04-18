import { Editor, Plugin, Notice } from "obsidian";
import { getPlayerView } from "./timestamp-processor";

/**
 * 注册"标记当前时间戳"命令。
 *
 * 用户在听播客时按快捷键，会在笔记的 `## 🔖 我的标记` 区域
 * 插入一行可点击的时间戳 + 光标停在后面等待输入备注。
 *
 * 格式：`- [mm:ss](#t=sec) `
 */
export function registerBookmarkCommand(plugin: Plugin): void {
	plugin.addCommand({
		id: "bookmark-current-timestamp",
		name: "标记当前播放位置",
		hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "b" }],
		editorCallback: (editor: Editor) => {
			const player = getPlayerView(plugin);
			if (!player || !player.getEpisode()) {
				new Notice("⚠️ 播放器未加载播客，无法标记");
				return;
			}

			const seconds = player.getCurrentTime();
			const label = formatHMS(seconds);
			const sec = Math.max(0, Math.floor(seconds));
			const link = `[${label}](#t=${sec})`;
			const insertText = `- ${link} `;

			// 逐行查找 "## 🔖 我的标记"
			const lineCount = editor.lineCount();
			let headingLine = -1;
			for (let i = 0; i < lineCount; i++) {
				if (editor.getLine(i).startsWith("## 🔖 我的标记")) {
					headingLine = i;
					break;
				}
			}

			if (headingLine !== -1) {
				// 在标题后紧邻的位置插入：跳过已有标记项（- 开头），遇到其他内容就停
				let insertLine = headingLine + 1;
				while (insertLine < lineCount && editor.getLine(insertLine).startsWith("- ")) {
					insertLine++;
				}

				// 在 insertLine 处插入新行（原有内容往下推）
				editor.replaceRange(
					insertText + "\n",
					{ line: insertLine, ch: 0 }
				);

				// 光标移到新插入行的末尾（方便用户紧接着输入备注）
				editor.setCursor({ line: insertLine, ch: insertText.length });
			} else {
				// 没有标记区域，在光标位置插入
				const cursor = editor.getCursor();
				editor.replaceRange(insertText, cursor);
				editor.setCursor({
					line: cursor.line,
					ch: cursor.ch + insertText.length,
				});
			}

			new Notice(`🔖 已标记 ${label}`);
		},
	});
}

function formatHMS(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
