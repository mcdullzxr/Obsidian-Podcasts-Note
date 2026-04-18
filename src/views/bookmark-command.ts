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
				// 找标题后面第一个可插入的位置：跳过空行，在下一个 ## 标题之前或文末
				let insertLine = headingLine + 1;
				// 跳过标题后紧跟的空行
				while (insertLine < lineCount && editor.getLine(insertLine).trim() === "") {
					insertLine++;
				}
				// 继续找到现有标记的末尾（以 - 开头的行）
				while (insertLine < lineCount) {
					const line = editor.getLine(insertLine);
					if (line.startsWith("## ")) break; // 到达下一个标题
					if (line.trim() === "" && insertLine + 1 < lineCount && editor.getLine(insertLine + 1).startsWith("## ")) break;
					insertLine++;
				}

				// 在 insertLine 之前插入新行
				const before = insertLine > 0 ? editor.getLine(insertLine - 1) : "";
				const needBlankBefore = before.trim() !== "" && !before.startsWith("- ");

				const textToInsert = (needBlankBefore ? "\n" : "") + insertText + "\n";
				editor.replaceRange(
					textToInsert,
					{ line: insertLine, ch: 0 }
				);

				// 光标移到新插入行的末尾
				const cursorLine = insertLine + (needBlankBefore ? 1 : 0);
				editor.setCursor({ line: cursorLine, ch: insertText.length });
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
