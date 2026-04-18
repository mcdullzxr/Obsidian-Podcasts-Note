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
				const cursor = editor.getCursor();

				// 判断光标是否已在书签区域内（标题行之后、下一个非书签内容之前）
				let sectionEnd = headingLine + 1;
				while (sectionEnd < lineCount) {
					const line = editor.getLine(sectionEnd);
					if (line.startsWith("- ")) { sectionEnd++; continue; }
					if (line.trim() === "") { sectionEnd++; continue; } // 空行也算区域内
					break;
				}

				const cursorInSection = cursor.line > headingLine && cursor.line < sectionEnd;

				if (cursorInSection) {
					// 光标在书签区域内——就地插入
					const currentLine = editor.getLine(cursor.line);
					if (currentLine.trim() === "" || currentLine.trim() === "-") {
						// 当前行是空行或空列表续写 → 直接替换这一行
						editor.setLine(cursor.line, insertText);
						editor.setCursor({ line: cursor.line, ch: insertText.length });
					} else {
						// 当前行有内容 → 在行末追加新行
						const lineEnd = currentLine.length;
						editor.replaceRange("\n" + insertText, { line: cursor.line, ch: lineEnd });
						editor.setCursor({ line: cursor.line + 1, ch: insertText.length });
					}
				} else {
					// 光标不在书签区域 → 追加到最后一个书签行末尾
					let insertAfterLine = headingLine;
					let nextLine = headingLine + 1;
					while (nextLine < lineCount && editor.getLine(nextLine).startsWith("- ")) {
						insertAfterLine = nextLine;
						nextLine++;
					}
					const lineEnd = editor.getLine(insertAfterLine).length;
					editor.replaceRange("\n" + insertText, { line: insertAfterLine, ch: lineEnd });
					editor.setCursor({ line: insertAfterLine + 1, ch: insertText.length });
				}
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
