import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const EditorPrototype = Object.getPrototypeOf(CustomEditor.prototype) as any;

type Mode = "normal" | "insert" | "visual" | "visual-line";
type Operator = "delete" | "change" | "yank";
type RegisterType = "charwise" | "linewise";
type FindKind = "f" | "F" | "t" | "T";
type SegmentKind = "space" | "word" | "punct";

type VisualSelection =
	| { type: "charwise"; start: number; end: number }
	| { type: "linewise"; startLine: number; endLineExclusive: number };

interface Cursor {
	line: number;
	col: number;
}

interface RegisterValue {
	text: string;
	type: RegisterType;
}

interface PendingOperator {
	type: Operator;
	count: number;
}

interface PendingFind {
	kind: FindKind;
	count: number;
}

interface LastFind {
	kind: FindKind;
	char: string;
}

interface MotionResult {
	cursor: Cursor;
	inclusive?: boolean;
	linewise?: boolean;
}

interface FlatSegment {
	text: string;
	offset: number;
	line: number;
	col: number;
	kind: SegmentKind;
}

interface InternalState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

const APP_SHORTCUT_IDS = [
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.editor.external",
	"app.clipboard.pasteImage",
	"app.session.new",
	"app.session.tree",
	"app.session.fork",
	"app.session.resume",
	"app.session.togglePath",
	"app.session.toggleSort",
	"app.session.toggleNamedFilter",
	"app.session.rename",
	"app.session.delete",
	"app.session.deleteNoninvasive",
	"app.model.select",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.thinking.cycle",
	"app.thinking.toggle",
	"app.tools.expand",
	"app.message.followUp",
	"app.message.dequeue",
	"app.tree.foldOrUp",
	"app.tree.unfoldOrDown",
	"app.tree.editLabel",
	"app.tree.toggleLabelTimestamp",
] as const;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function compareCursor(a: Cursor, b: Cursor): number {
	if (a.line !== b.line) return a.line - b.line;
	return a.col - b.col;
}

function splitLines(text: string): string[] {
	const lines = text.split("\n");
	return lines.length > 0 ? lines : [""];
}

function cursorToOffset(lines: string[], cursor: Cursor): number {
	let offset = 0;
	for (let i = 0; i < cursor.line; i++) {
		offset += (lines[i] ?? "").length;
		if (i < lines.length - 1) offset += 1;
	}
	return offset + cursor.col;
}

function offsetToCursor(lines: string[], offset: number): Cursor {
	let remaining = clamp(offset, 0, lines.join("\n").length);
	for (let line = 0; line < lines.length; line++) {
		const current = lines[line] ?? "";
		if (remaining <= current.length) return { line, col: remaining };
		remaining -= current.length;
		if (line < lines.length - 1) {
			if (remaining === 0) return { line: line + 1, col: 0 };
			remaining -= 1;
		}
	}
	const lastLine = Math.max(0, lines.length - 1);
	return { line: lastLine, col: (lines[lastLine] ?? "").length };
}

function firstNonBlankCol(line: string): number {
	const match = line.match(/^[ \t]*/);
	return match ? match[0].length : 0;
}

function classifySegment(text: string): SegmentKind {
	if (/^\s$/u.test(text) || text === "\n") return "space";
	if (/^[\p{L}\p{N}_]$/u.test(text)) return "word";
	return "punct";
}

const GraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class VimEditor extends CustomEditor {
	private mode: Mode = "insert";
	private degraded = false;
	private register: RegisterValue = { text: "", type: "charwise" };
	private countBuffer = "";
	private pendingOperator: PendingOperator | null = null;
	private pendingFind: PendingFind | null = null;
	private lastFind: LastFind | null = null;
	private pendingG = false;
	private pendingGCount = 1;
	private pendingTextObject: { around: boolean; count: number } | null = null;
	private visualAnchor: Cursor | null = null;
	private preferredNormalCol: number | null = null;

	private internals(): any {
		return this as any;
	}

	private kb(): any {
		return this.internals().keybindings ?? { matches: () => false };
	}

	private editorState(): InternalState {
		return this.internals().state as InternalState;
	}

	private lines(): string[] {
		return this.editorState().lines;
	}

	private currentLineText(line = this.editorState().cursorLine): string {
		return this.lines()[line] ?? "";
	}

	private cursor(): Cursor {
		const state = this.editorState();
		return { line: state.cursorLine, col: state.cursorCol };
	}

	private segmentText(text: string): Array<{ segment: string; index: number }> {
		const segment = this.internals().segment;
		if (typeof segment === "function") {
			return [...segment.call(this, text)];
		}
		return [...GraphemeSegmenter.segment(text)].map((entry) => ({
			segment: entry.segment,
			index: entry.index,
		}));
	}

	private lineSegments(lineIndex: number): Array<{ segment: string; index: number }> {
		return this.segmentText(this.currentLineText(lineIndex));
	}

	private getLineLastCharCol(lineIndex: number): number {
		const segments = this.lineSegments(lineIndex);
		return segments.length > 0 ? (segments[segments.length - 1]?.index ?? 0) : 0;
	}

	private clampNormalCol(lineIndex: number, col: number): number {
		const line = this.currentLineText(lineIndex);
		if (line.length === 0) return 0;
		const segments = this.lineSegments(lineIndex);
		if (segments.length === 0) return 0;
		if (col >= line.length) return segments[segments.length - 1]?.index ?? 0;
		let result = segments[0]?.index ?? 0;
		for (const segment of segments) {
			if (segment.index > col) break;
			result = segment.index;
		}
		return result;
	}

	private currentCharLength(cursor = this.cursor()): number {
		const line = this.currentLineText(cursor.line);
		if (line.length === 0) return 0;
		const segments = this.lineSegments(cursor.line);
		for (const segment of segments) {
			if (segment.index === cursor.col) return segment.segment.length;
		}
		for (let i = segments.length - 1; i >= 0; i--) {
			const segment = segments[i];
			if (!segment) continue;
			if (segment.index <= cursor.col) return segment.segment.length;
		}
		return 1;
	}

	private nextCharCol(lineIndex: number, col: number): number | null {
		const segments = this.lineSegments(lineIndex);
		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i];
			if (!segment) continue;
			if (segment.index === col) return segments[i + 1]?.index ?? null;
			if (segment.index > col) return segment.index;
		}
		return null;
	}

	private prevCharCol(lineIndex: number, col: number): number | null {
		const segments = this.lineSegments(lineIndex);
		let previous: number | null = null;
		for (const segment of segments) {
			if (segment.index >= col) break;
			previous = segment.index;
		}
		return previous;
	}

	private cursorAfterCurrentChar(cursor = this.cursor()): Cursor {
		return { line: cursor.line, col: cursor.col + this.currentCharLength(cursor) };
	}

	private buildFlatSegments(): FlatSegment[] {
		const segments: FlatSegment[] = [];
		let baseOffset = 0;
		for (let lineIndex = 0; lineIndex < this.lines().length; lineIndex++) {
			const line = this.currentLineText(lineIndex);
			for (const segment of this.segmentText(line)) {
				segments.push({
					text: segment.segment,
					offset: baseOffset + segment.index,
					line: lineIndex,
					col: segment.index,
					kind: classifySegment(segment.segment),
				});
			}
			if (lineIndex < this.lines().length - 1) {
				segments.push({
					text: "\n",
					offset: baseOffset + line.length,
					line: lineIndex,
					col: line.length,
					kind: "space",
				});
				baseOffset += line.length + 1;
			} else {
				baseOffset += line.length;
			}
		}
		return segments;
	}

	private findSegmentIndexAtOrAfter(segments: FlatSegment[], offset: number): number {
		for (let i = 0; i < segments.length; i++) {
			if ((segments[i]?.offset ?? 0) >= offset) return i;
		}
		return -1;
	}

	private findSegmentIndexAtOffset(segments: FlatSegment[], offset: number): number {
		for (let i = 0; i < segments.length; i++) {
			if (segments[i]?.offset === offset) return i;
		}
		return -1;
	}

	private findSegmentIndexBefore(segments: FlatSegment[], offset: number): number {
		let result = -1;
		for (let i = 0; i < segments.length; i++) {
			if ((segments[i]?.offset ?? 0) >= offset) break;
			result = i;
		}
		return result;
	}

	private cursorFromSegment(segment: FlatSegment | undefined, fallback = this.cursor()): Cursor {
		if (!segment || segment.text === "\n") return fallback;
		return { line: segment.line, col: segment.col };
	}

	private setCursor(cursor: Cursor, keepPreferred = false): void {
		const state = this.editorState();
		state.cursorLine = clamp(cursor.line, 0, Math.max(0, this.lines().length - 1));
		state.cursorCol = this.mode === "insert"
			? clamp(cursor.col, 0, this.currentLineText(state.cursorLine).length)
			: this.clampNormalCol(state.cursorLine, cursor.col);
		this.internals().preferredVisualCol = null;
		if (!keepPreferred) this.preferredNormalCol = null;
	}

	private setInsertionCursor(cursor: Cursor): void {
		const state = this.editorState();
		state.cursorLine = clamp(cursor.line, 0, Math.max(0, this.lines().length - 1));
		state.cursorCol = clamp(cursor.col, 0, this.currentLineText(state.cursorLine).length);
		this.internals().preferredVisualCol = null;
		this.preferredNormalCol = null;
	}

	private requestRender(): void {
		this.tui.requestRender();
	}

	private degrade(scope: string, error: unknown): void {
		if (!this.degraded) {
			const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			console.error(`[vim-editor] ${scope} failed; falling back to the built-in editor behavior for this session.`);
			console.error(message);
		}
		this.degraded = true;
		this.mode = "insert";
		this.visualAnchor = null;
		this.resetPending();
	}

	private notifyChange(): void {
		this.onChange?.(this.getText());
		this.requestRender();
	}

	private cancelEditorAutocomplete(): void {
		EditorPrototype.cancelAutocomplete?.call(this);
	}

	private pushEditorUndoSnapshot(): void {
		EditorPrototype.pushUndoSnapshot?.call(this);
	}

	private undoEditor(): void {
		EditorPrototype.undo?.call(this);
	}

	private resetPending(): void {
		this.countBuffer = "";
		this.pendingOperator = null;
		this.pendingFind = null;
		this.pendingG = false;
		this.pendingGCount = 1;
		this.pendingTextObject = null;
	}

	private hasPendingState(): boolean {
		return Boolean(
			this.countBuffer ||
			this.pendingOperator ||
			this.pendingFind ||
			this.pendingG ||
			this.pendingTextObject,
		);
	}

	private getCount(defaultValue = 1): number {
		return this.countBuffer ? Math.max(1, parseInt(this.countBuffer, 10)) : defaultValue;
	}

	private takeCount(defaultValue = 1): number {
		const count = this.getCount(defaultValue);
		this.countBuffer = "";
		return count;
	}

	private beginMutation(): void {
		this.cancelEditorAutocomplete();
		this.internals().historyIndex = -1;
		this.internals().lastAction = null;
	}

	private setRegister(text: string, type: RegisterType): void {
		this.register = { text, type };
	}

	private replaceCharwiseRange(start: number, end: number, replacement: string, cursorOffset = start): void {
		const text = this.getText();
		const nextText = text.slice(0, start) + replacement + text.slice(end);
		const nextLines = splitLines(nextText);
		const nextCursor = offsetToCursor(nextLines, cursorOffset);
		const state = this.editorState();
		state.lines = nextLines;
		state.cursorLine = nextCursor.line;
		state.cursorCol = nextCursor.col;
		this.internals().scrollOffset = 0;
		this.notifyChange();
	}

	private replaceSelectedWithText(text: string): void {
		const selection = this.getVisualSelection();
		if (!selection) return;
		this.beginMutation();
		this.pushEditorUndoSnapshot();
		if (selection.type === "linewise") {
			const insertLines = splitLines(text);
			const nextLines = [
				...this.lines().slice(0, selection.startLine),
				...insertLines,
				...this.lines().slice(selection.endLineExclusive),
			];
			const state = this.editorState();
			state.lines = nextLines.length > 0 ? nextLines : [""];
			state.cursorLine = clamp(selection.startLine, 0, Math.max(0, state.lines.length - 1));
			state.cursorCol = state.lines[state.cursorLine] ? firstNonBlankCol(state.lines[state.cursorLine] ?? "") : 0;
			this.mode = "normal";
			this.visualAnchor = null;
			this.ensureNormalCursor();
			this.notifyChange();
			return;
		}
		this.replaceCharwiseRange(selection.start, selection.end, text, selection.start);
		this.mode = "normal";
		this.visualAnchor = null;
		this.ensureNormalCursor();
	}

	private deleteLinewise(startLine: number, endLineExclusive: number, operator: Exclude<Operator, "yank"> | "yank"): void {
		const removedLines = this.lines().slice(startLine, endLineExclusive);
		this.setRegister(removedLines.join("\n"), "linewise");
		if (operator === "yank") {
			this.mode = "normal";
			this.visualAnchor = null;
			this.requestRender();
			return;
		}

		this.beginMutation();
		this.pushEditorUndoSnapshot();
		const state = this.editorState();
		if (operator === "change") {
			const indent = removedLines.length > 0 ? (removedLines[0]?.match(/^[ \t]*/)?.[0] ?? "") : "";
			const nextLines = [
				...this.lines().slice(0, startLine),
				indent,
				...this.lines().slice(endLineExclusive),
			];
			state.lines = nextLines.length > 0 ? nextLines : [indent];
			state.cursorLine = clamp(startLine, 0, Math.max(0, state.lines.length - 1));
			state.cursorCol = indent.length;
			this.mode = "insert";
		} else {
			const nextLines = [...this.lines().slice(0, startLine), ...this.lines().slice(endLineExclusive)];
			state.lines = nextLines.length > 0 ? nextLines : [""];
			state.cursorLine = clamp(startLine, 0, Math.max(0, state.lines.length - 1));
			state.cursorCol = 0;
			this.mode = "normal";
			this.ensureNormalCursor();
		}
		this.visualAnchor = null;
		this.internals().scrollOffset = 0;
		this.notifyChange();
	}

	private applyCharwiseOperation(start: number, end: number, operator: Operator): void {
		if (end <= start) {
			if (operator === "change") this.enterInsert("i");
			return;
		}
		const deletedText = this.getText().slice(start, end);
		this.setRegister(deletedText, "charwise");
		if (operator === "yank") {
			this.mode = "normal";
			this.visualAnchor = null;
			this.requestRender();
			return;
		}
		this.beginMutation();
		this.pushEditorUndoSnapshot();
		this.replaceCharwiseRange(start, end, "", start);
		this.visualAnchor = null;
		if (operator === "change") {
			this.mode = "insert";
		} else {
			this.mode = "normal";
			this.ensureNormalCursor();
		}
	}

	private ensureNormalCursor(): void {
		if (this.mode === "insert") return;
		const state = this.editorState();
		state.cursorCol = this.clampNormalCol(state.cursorLine, state.cursorCol);
	}

	private enterNormalFromInsert(): void {
		this.cancelEditorAutocomplete();
		this.mode = "normal";
		this.visualAnchor = null;
		const state = this.editorState();
		const line = this.currentLineText(state.cursorLine);
		if (line.length > 0 && state.cursorCol > 0) {
			const previous = this.prevCharCol(state.cursorLine, state.cursorCol);
			state.cursorCol = previous ?? 0;
		} else {
			state.cursorCol = 0;
		}
		this.resetPending();
		this.ensureNormalCursor();
		this.requestRender();
	}

	private enterNormal(): void {
		this.mode = "normal";
		this.visualAnchor = null;
		this.resetPending();
		this.ensureNormalCursor();
		this.requestRender();
	}

	private enterInsert(command: "i" | "a" | "I" | "A" = "i"): void {
		this.resetPending();
		this.visualAnchor = null;
		const cursor = this.cursor();
		const line = this.currentLineText(cursor.line);
		if (command === "i") {
			this.setInsertionCursor(cursor);
		} else if (command === "a") {
			this.setInsertionCursor({
				line: cursor.line,
				col: line.length === 0 ? 0 : this.cursorAfterCurrentChar(cursor).col,
			});
		} else if (command === "I") {
			this.setInsertionCursor({ line: cursor.line, col: firstNonBlankCol(line) });
		} else if (command === "A") {
			this.setInsertionCursor({ line: cursor.line, col: line.length });
		}
		this.mode = "insert";
		this.requestRender();
	}

	private startVisual(linewise = false): void {
		this.resetPending();
		this.ensureNormalCursor();
		this.visualAnchor = this.cursor();
		this.mode = linewise ? "visual-line" : "visual";
		this.requestRender();
	}

	private swapVisualAnchor(): void {
		if (!this.visualAnchor) return;
		const current = this.cursor();
		this.setCursor(this.visualAnchor, true);
		this.visualAnchor = current;
		this.requestRender();
	}

	private getVisualSelection(): VisualSelection | null {
		if (!this.visualAnchor) return null;
		const cursor = this.cursor();
		if (this.mode === "visual-line") {
			const startLine = Math.min(this.visualAnchor.line, cursor.line);
			const endLineExclusive = Math.max(this.visualAnchor.line, cursor.line) + 1;
			return { type: "linewise", startLine, endLineExclusive };
		}
		if (this.mode !== "visual") return null;
		const anchorOffset = cursorToOffset(this.lines(), this.visualAnchor);
		const cursorOffset = cursorToOffset(this.lines(), cursor);
		if (compareCursor(this.visualAnchor, cursor) <= 0) {
			return {
				type: "charwise",
				start: anchorOffset,
				end: cursorOffset + this.currentCharLength(cursor),
			};
		}
		return {
			type: "charwise",
			start: cursorOffset,
			end: anchorOffset + this.currentCharLength(this.visualAnchor),
		};
	}

	private buildWordObject(around: boolean, count = 1): { start: number; end: number } | null {
		const lineIndex = this.cursor().line;
		const line = this.currentLineText(lineIndex);
		if (line.length === 0) return null;
		const lineOffset = cursorToOffset(this.lines(), { line: lineIndex, col: 0 });
		const segments = this.segmentText(line).map((segment) => ({
			segment: segment.segment,
			index: segment.index,
			kind: classifySegment(segment.segment),
		}));
		if (segments.length === 0) return null;
		let currentIndex = segments.findIndex((segment) => segment.index === this.cursor().col);
		if (currentIndex === -1) {
			currentIndex = segments.findIndex((segment) => segment.index > this.cursor().col);
			if (currentIndex === -1) currentIndex = segments.length - 1;
		}
		let focus = currentIndex;
		while (focus < segments.length && segments[focus]?.kind === "space") focus++;
		if (focus >= segments.length) {
			focus = currentIndex;
			while (focus >= 0 && segments[focus]?.kind === "space") focus--;
		}
		if (focus < 0 || focus >= segments.length) return null;
		const focusKind = segments[focus]?.kind;
		if (!focusKind || focusKind === "space") return null;
		let startIndex = focus;
		while (startIndex > 0 && segments[startIndex - 1]?.kind === focusKind) startIndex--;
		let endIndex = focus;
		while (endIndex + 1 < segments.length && segments[endIndex + 1]?.kind === focusKind) endIndex++;
		let remainingWords = Math.max(0, count - 1);
		let nextIndex = endIndex + 1;
		while (remainingWords > 0) {
			while (nextIndex < segments.length && segments[nextIndex]?.kind === "space") nextIndex++;
			if (nextIndex >= segments.length) break;
			const nextKind = segments[nextIndex]?.kind;
			if (!nextKind || nextKind === "space") break;
			endIndex = nextIndex;
			while (endIndex + 1 < segments.length && segments[endIndex + 1]?.kind === nextKind) endIndex++;
			nextIndex = endIndex + 1;
			remainingWords--;
		}

		let startCol = segments[startIndex]?.index ?? 0;
		let endCol = (segments[endIndex]?.index ?? 0) + (segments[endIndex]?.segment.length ?? 0);
		if (around) {
			let trailing = endIndex + 1;
			while (trailing < segments.length && segments[trailing]?.kind === "space") {
				endCol = (segments[trailing]?.index ?? endCol) + (segments[trailing]?.segment.length ?? 0);
				trailing++;
			}
			if (trailing === endIndex + 1) {
				let leading = startIndex - 1;
				while (leading >= 0 && segments[leading]?.kind === "space") {
					startCol = segments[leading]?.index ?? startCol;
					leading--;
				}
			}
		}
		return { start: lineOffset + startCol, end: lineOffset + endCol };
	}

	private moveLeft(count: number): MotionResult {
		let cursor = this.cursor();
		for (let i = 0; i < count; i++) {
			const previous = this.prevCharCol(cursor.line, cursor.col);
			if (previous === null) break;
			cursor = { line: cursor.line, col: previous };
		}
		return { cursor };
	}

	private moveRight(count: number): MotionResult {
		let cursor = this.cursor();
		for (let i = 0; i < count; i++) {
			const next = this.nextCharCol(cursor.line, cursor.col);
			if (next === null) break;
			cursor = { line: cursor.line, col: next };
		}
		return { cursor };
	}

	private moveVertical(delta: number, count: number): MotionResult {
		const current = this.cursor();
		const targetLine = clamp(current.line + delta * count, 0, Math.max(0, this.lines().length - 1));
		const desired = this.preferredNormalCol ?? current.col;
		this.preferredNormalCol = desired;
		const targetCol = this.currentLineText(targetLine).length === 0 ? 0 : this.clampNormalCol(targetLine, desired);
		return { cursor: { line: targetLine, col: targetCol }, linewise: Boolean(this.pendingOperator) };
	}

	private motionLineStart(): MotionResult {
		return { cursor: { line: this.cursor().line, col: 0 } };
	}

	private moveToFirstNonBlank(): MotionResult {
		return { cursor: { line: this.cursor().line, col: this.clampNormalCol(this.cursor().line, firstNonBlankCol(this.currentLineText())) } };
	}

	private motionLineEnd(): MotionResult {
		return { cursor: { line: this.cursor().line, col: this.getLineLastCharCol(this.cursor().line) }, inclusive: true };
	}

	private moveToFileEnd(count: number): MotionResult {
		const line = count > 1 ? clamp(count - 1, 0, Math.max(0, this.lines().length - 1)) : Math.max(0, this.lines().length - 1);
		const col = this.clampNormalCol(line, firstNonBlankCol(this.currentLineText(line)));
		return { cursor: { line, col }, linewise: Boolean(this.pendingOperator) };
	}

	private moveToFileStart(count: number): MotionResult {
		const line = count > 1 ? clamp(count - 1, 0, Math.max(0, this.lines().length - 1)) : 0;
		const col = this.clampNormalCol(line, firstNonBlankCol(this.currentLineText(line)));
		return { cursor: { line, col }, linewise: Boolean(this.pendingOperator) };
	}

	private moveWordForward(count: number): MotionResult {
		let cursor = this.cursor();
		for (let step = 0; step < count; step++) {
			const segments = this.buildFlatSegments();
			const offset = cursorToOffset(this.lines(), cursor);
			let index = this.findSegmentIndexAtOrAfter(segments, offset);
			if (index === -1) break;
			const current = segments[index];
			if (!current) break;
			if (current.kind !== "space") {
				while (index < segments.length && segments[index]?.kind === current.kind && segments[index]?.kind !== "space") index++;
			}
			while (index < segments.length && segments[index]?.kind === "space") index++;
			const target = segments[index];
			if (!target || target.text === "\n") break;
			cursor = { line: target.line, col: target.col };
		}
		return { cursor };
	}

	private moveWordBackward(count: number): MotionResult {
		let cursor = this.cursor();
		for (let step = 0; step < count; step++) {
			const segments = this.buildFlatSegments();
			const offset = cursorToOffset(this.lines(), cursor);
			let index = this.findSegmentIndexAtOffset(segments, offset);
			if (index === -1) index = this.findSegmentIndexBefore(segments, offset + 1);
			if (index === -1) break;
			const current = segments[index];
			if (current?.kind !== "space") {
				const previous = segments[index - 1];
				if (!previous || previous.kind !== current.kind) index--;
			}
			else {
				index--;
			}
			while (index >= 0 && segments[index]?.kind === "space") index--;
			if (index < 0) break;
			const kind = segments[index]?.kind;
			while (index > 0 && segments[index - 1]?.kind === kind && kind !== "space") index--;
			const target = segments[index];
			if (!target || target.text === "\n") break;
			cursor = { line: target.line, col: target.col };
		}
		return { cursor };
	}

	private moveWordEndForward(count: number): MotionResult {
		let cursor = this.cursor();
		for (let step = 0; step < count; step++) {
			const segments = this.buildFlatSegments();
			const offset = cursorToOffset(this.lines(), cursor);
			let index = this.findSegmentIndexAtOrAfter(segments, offset);
			if (index === -1) break;
			while (index < segments.length && segments[index]?.kind === "space") index++;
			if (index >= segments.length) break;
			const kind = segments[index]?.kind;
			while (index + 1 < segments.length && segments[index + 1]?.kind === kind && kind !== "space") index++;
			const target = segments[index];
			if (!target || target.text === "\n") break;
			cursor = { line: target.line, col: target.col };
		}
		return { cursor, inclusive: true };
	}

	private moveWordEndBackward(count: number): MotionResult {
		let cursor = this.cursor();
		for (let step = 0; step < count; step++) {
			const segments = this.buildFlatSegments();
			const offset = cursorToOffset(this.lines(), cursor);
			let index = this.findSegmentIndexBefore(segments, offset);
			while (index >= 0 && segments[index]?.kind === "space") index--;
			if (index < 0) break;
			const target = segments[index];
			if (!target || target.text === "\n") break;
			cursor = { line: target.line, col: target.col };
		}
		return { cursor, inclusive: true };
	}

	private findChar(kind: FindKind, char: string, count: number): MotionResult | null {
		const cursor = this.cursor();
		const line = this.currentLineText(cursor.line);
		if (!line || !char) return null;
		let found = -1;
		if (kind === "f" || kind === "t") {
			let searchFrom = this.cursorAfterCurrentChar(cursor).col;
			for (let i = 0; i < count; i++) {
				found = line.indexOf(char, searchFrom);
				if (found === -1) return null;
				searchFrom = found + 1;
			}
			if (kind === "t") {
				const previous = this.prevCharCol(cursor.line, found);
				if (previous === null) return null;
				return { cursor: { line: cursor.line, col: previous } };
			}
			return { cursor: { line: cursor.line, col: found }, inclusive: true };
		}

		let searchFrom = Math.max(0, cursor.col - 1);
		for (let i = 0; i < count; i++) {
			found = line.lastIndexOf(char, searchFrom);
			if (found === -1) return null;
			searchFrom = found - 1;
		}
		if (kind === "T") {
			const next = this.nextCharCol(cursor.line, found);
			if (next === null) return null;
			return { cursor: { line: cursor.line, col: next } };
		}
		return { cursor: { line: cursor.line, col: found }, inclusive: true };
	}

	private resolveRepeatedFind(reverse: boolean, count: number): MotionResult | null {
		if (!this.lastFind) return null;
		const kind = reverse
			? this.lastFind.kind === "f"
				? "F"
				: this.lastFind.kind === "F"
					? "f"
					: this.lastFind.kind === "t"
						? "T"
						: "t"
			: this.lastFind.kind;
		return this.findChar(kind, this.lastFind.char, count);
	}

	private resolveMotion(key: string, count: number): MotionResult | null {
		switch (key) {
			case "h": return this.moveLeft(count);
			case "j": return this.moveVertical(1, count);
			case "k": return this.moveVertical(-1, count);
			case "l": return this.moveRight(count);
			case "w": return this.moveWordForward(count);
			case "b": return this.moveWordBackward(count);
			case "e": return this.moveWordEndForward(count);
			case "0": return this.motionLineStart();
			case "^": return this.moveToFirstNonBlank();
			case "$": return this.motionLineEnd();
			case "G": return this.moveToFileEnd(count);
			case ";": return this.resolveRepeatedFind(false, count);
			case ",": return this.resolveRepeatedFind(true, count);
			default: return null;
		}
	}

	private applyMotion(result: MotionResult): void {
		this.setCursor(result.cursor, Boolean(result.linewise));
		if (!result.linewise) this.preferredNormalCol = null;
		this.requestRender();
	}

	private applyVisualTextObject(around: boolean, count = 1): boolean {
		const range = this.buildWordObject(around, count);
		if (!range) return false;
		const startCursor = offsetToCursor(this.lines(), range.start);
		const endCursor = offsetToCursor(this.lines(), Math.max(range.start, range.end - 1));
		this.visualAnchor = startCursor;
		this.mode = "visual";
		this.setCursor(endCursor);
		return true;
	}

	private applyOperatorMotion(result: MotionResult): void {
		const operator = this.pendingOperator;
		if (!operator) return;
		this.pendingOperator = null;
		const current = this.cursor();
		if (result.linewise) {
			const startLine = Math.min(current.line, result.cursor.line);
			const endLineExclusive = Math.max(current.line, result.cursor.line) + 1;
			this.deleteLinewise(startLine, endLineExclusive, operator.type);
			return;
		}
		let start = cursorToOffset(this.lines(), current);
		let end = cursorToOffset(this.lines(), result.cursor);
		if (compareCursor(result.cursor, current) > 0) {
			end = result.inclusive ? cursorToOffset(this.lines(), this.cursorAfterCurrentChar(result.cursor)) : end;
		} else if (compareCursor(result.cursor, current) < 0) {
			const swap = start;
			start = end;
			end = swap;
		} else {
			if (result.inclusive) end = start + this.currentCharLength(current);
		}
		this.applyCharwiseOperation(start, end, operator.type);
	}

	private changeWord(count: number): void {
		const current = this.cursor();
		const currentSegment = this.segmentText(this.currentLineText(current.line)).find((segment) => segment.index === current.col);
		if (!currentSegment) {
			this.enterInsert("i");
			return;
		}
		if (classifySegment(currentSegment.segment) === "space") {
			const motion = this.moveWordForward(count);
			this.pendingOperator = { type: "change", count: 1 };
			this.applyOperatorMotion(motion);
			return;
		}
		const target = this.moveWordEndForward(count);
		const start = cursorToOffset(this.lines(), current);
		const end = cursorToOffset(this.lines(), target.cursor) + this.currentCharLength(target.cursor);
		this.applyCharwiseOperation(Math.min(start, end), Math.max(start, end), "change");
	}

	private deleteForwardChars(count: number, change = false): void {
		const line = this.currentLineText();
		if (line.length === 0) {
			if (change) this.enterInsert("i");
			return;
		}
		let cursor = this.cursor();
		let end = cursorToOffset(this.lines(), cursor);
		for (let i = 0; i < count; i++) {
			end += this.currentCharLength(cursor);
			const nextCol = this.nextCharCol(cursor.line, cursor.col);
			if (nextCol === null) break;
			cursor = { line: cursor.line, col: nextCol };
		}
		this.applyCharwiseOperation(cursorToOffset(this.lines(), this.cursor()), end, change ? "change" : "delete");
	}

	private deleteBackwardChars(count: number): void {
		const line = this.currentLineText();
		if (line.length === 0) return;
		let startCursor = this.cursor();
		for (let i = 0; i < count; i++) {
			const previous = this.prevCharCol(startCursor.line, startCursor.col);
			if (previous === null) break;
			startCursor = { line: startCursor.line, col: previous };
		}
		this.applyCharwiseOperation(cursorToOffset(this.lines(), startCursor), cursorToOffset(this.lines(), this.cursor()), "delete");
	}

	private openLine(direction: "above" | "below"): void {
		this.beginMutation();
		this.pushEditorUndoSnapshot();
		const state = this.editorState();
		const currentLine = this.currentLineText();
		const indent = currentLine.match(/^[ \t]*/)?.[0] ?? "";
		const insertAt = direction === "above" ? state.cursorLine : state.cursorLine + 1;
		state.lines.splice(insertAt, 0, indent);
		state.cursorLine = insertAt;
		state.cursorCol = indent.length;
		this.mode = "insert";
		this.notifyChange();
	}

	private pasteRegister(after: boolean, count: number): void {
		if (!this.register.text && this.register.type === "charwise") return;
		const repeatedText = Array.from({ length: count }, () => this.register.text).join(this.register.type === "linewise" ? "\n" : "");
		this.beginMutation();
		this.pushEditorUndoSnapshot();
		const state = this.editorState();
		if (this.register.type === "linewise") {
			const insertLines = splitLines(repeatedText);
			const insertAt = after ? state.cursorLine + 1 : state.cursorLine;
			state.lines.splice(insertAt, 0, ...insertLines);
			state.cursorLine = clamp(insertAt, 0, Math.max(0, state.lines.length - 1));
			state.cursorCol = firstNonBlankCol(this.currentLineText(state.cursorLine));
			this.mode = "normal";
			this.ensureNormalCursor();
			this.notifyChange();
			return;
		}
		const insertOffset = cursorToOffset(
			this.lines(),
			after ? this.cursorAfterCurrentChar(this.cursor()) : this.cursor(),
		);
		this.replaceCharwiseRange(insertOffset, insertOffset, repeatedText, insertOffset);
		this.mode = "normal";
		const targetOffset = Math.max(insertOffset, insertOffset + repeatedText.length - 1);
		this.setCursor(offsetToCursor(this.lines(), targetOffset));
		this.ensureNormalCursor();
	}

	private modeLabel(): string {
		let label =
			this.mode === "insert"
				? "INSERT"
				: this.mode === "visual"
					? "VISUAL"
					: this.mode === "visual-line"
						? "VISUAL LINE"
						: "NORMAL";
		if (this.degraded) label += " SAFE";
		if (this.pendingOperator) label += ` ${this.pendingOperator.type.toUpperCase()}`;
		if (this.pendingG) label += " g";
		if (this.pendingFind) label += ` ${this.pendingFind.kind}`;
		if (this.pendingTextObject) label += this.pendingTextObject.around ? " a" : " i";
		if (this.countBuffer) label += ` ${this.countBuffer}`;
		return ` ${label} `;
	}

	private withModeLabel(lines: string[], width: number): string[] {
		if (lines.length === 0) return lines;
		const label = this.modeLabel();
		const last = lines.length - 1;
		lines[last] = truncateToWidth(lines[last] ?? "", Math.max(0, width - label.length), "") + label;
		return lines;
	}

	private renderStyledChunk(text: string, selections: Array<[number, number]>, cursorLocal: number | null): string {
		const segments = this.segmentText(text);
		if (segments.length === 0) {
			if (cursorLocal === 0) return "\x1b[1;7m \x1b[0m";
			if (selections.length > 0) return "\x1b[7m \x1b[0m";
			return "";
		}
		let rendered = "";
		for (const segment of segments) {
			const start = segment.index;
			const end = start + segment.segment.length;
			const selected = selections.some(([selStart, selEnd]) => start < selEnd && end > selStart);
			if (cursorLocal !== null && start === cursorLocal) {
				rendered += `\x1b[1;7m${segment.segment}\x1b[0m`;
			} else if (selected) {
				rendered += `\x1b[7m${segment.segment}\x1b[0m`;
			} else {
				rendered += segment.segment;
			}
		}
		if (cursorLocal !== null && cursorLocal === text.length) rendered += "\x1b[1;7m \x1b[0m";
		return rendered;
	}

	private selectionRangesForVisualLine(line: { logicalLine: number; startCol: number; length: number }): Array<[number, number]> {
		const selection = this.getVisualSelection();
		if (!selection) return [];
		if (selection.type === "linewise") {
			return line.logicalLine >= selection.startLine && line.logicalLine < selection.endLineExclusive
				? [[0, line.length]]
				: [];
		}
		const chunkStart = cursorToOffset(this.lines(), { line: line.logicalLine, col: line.startCol });
		const chunkEnd = chunkStart + line.length;
		const start = Math.max(selection.start, chunkStart);
		const end = Math.min(selection.end, chunkEnd);
		return end > start ? [[start - chunkStart, end - chunkStart]] : [];
	}

	override handleInput(data: string): void {
		if (this.degraded) {
			super.handleInput(data);
			return;
		}

		try {
			if (this.internals().onExtensionShortcut?.(data)) return;

		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.enterNormalFromInsert();
				return;
			}
			if (this.mode === "visual" || this.mode === "visual-line") {
				this.enterNormal();
				return;
			}
			if (this.hasPendingState()) {
				this.resetPending();
				this.requestRender();
				return;
			}
			super.handleInput(data);
			return;
		}

		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		if (this.pendingFind && data.length === 1 && data.charCodeAt(0) >= 32) {
			const find = this.pendingFind;
			this.pendingFind = null;
			const result = this.findChar(find.kind, data, find.count);
			if (!result) return;
			this.lastFind = { kind: find.kind, char: data };
			if (this.pendingOperator) {
				this.applyOperatorMotion(result);
			} else {
				this.applyMotion(result);
			}
			return;
		}

		if (this.pendingTextObject && data === "w") {
			const pending = this.pendingTextObject;
			this.pendingTextObject = null;
			if (this.pendingOperator) {
				const operator = this.pendingOperator;
				this.pendingOperator = null;
				const range = this.buildWordObject(pending.around, pending.count);
				if (!range) return;
				this.applyCharwiseOperation(range.start, range.end, operator.type);
				return;
			}
			if (this.mode === "visual" || this.mode === "visual-line") {
				this.applyVisualTextObject(pending.around, pending.count);
				return;
			}
		}

		if (/^[0-9]$/.test(data) && !(data === "0" && this.countBuffer === "")) {
			this.countBuffer += data;
			this.requestRender();
			return;
		}

		if (this.pendingG) {
			const count = this.pendingGCount;
			this.pendingG = false;
			this.pendingGCount = 1;
			let result: MotionResult | null = null;
			if (data === "g") result = this.moveToFileStart(count);
			else if (data === "e") result = this.moveWordEndBackward(count);
			if (!result) return;
			if (this.pendingOperator) this.applyOperatorMotion(result);
			else this.applyMotion(result);
			return;
		}

		const appHandled =
			this.kb().matches(data, "tui.input.submit") ||
			this.kb().matches(data, "tui.input.newLine") ||
			APP_SHORTCUT_IDS.some((id) => this.kb().matches(data, id));
		if (appHandled) {
			super.handleInput(data);
			return;
		}

		if (this.pendingOperator) {
			const operator = this.pendingOperator;
			const motionCount = operator.count * this.takeCount();
			if (data === "d" && operator.type === "delete") {
				this.pendingOperator = null;
				this.deleteLinewise(this.cursor().line, Math.min(this.lines().length, this.cursor().line + operator.count), "delete");
				return;
			}
			if (data === "c" && operator.type === "change") {
				this.pendingOperator = null;
				this.deleteLinewise(this.cursor().line, Math.min(this.lines().length, this.cursor().line + operator.count), "change");
				return;
			}
			if (data === "y" && operator.type === "yank") {
				this.pendingOperator = null;
				this.deleteLinewise(this.cursor().line, Math.min(this.lines().length, this.cursor().line + operator.count), "yank");
				return;
			}
			if (data === "i" || data === "a") {
				this.pendingTextObject = { around: data === "a", count: motionCount };
				this.requestRender();
				return;
			}
			if (data === "w" && operator.type === "change") {
				this.pendingOperator = null;
				this.changeWord(motionCount);
				return;
			}
			if (data === "g") {
				this.pendingG = true;
				this.pendingGCount = motionCount;
				this.requestRender();
				return;
			}
			if (data === "f" || data === "F" || data === "t" || data === "T") {
				this.pendingFind = { kind: data, count: motionCount };
				this.requestRender();
				return;
			}
			const motion = this.resolveMotion(data, motionCount);
			if (motion) {
				this.applyOperatorMotion(motion);
				return;
			}
			return;
		}

		if (this.mode === "visual" || this.mode === "visual-line") {
			const count = this.takeCount();
			if (data === "o") {
				this.swapVisualAnchor();
				return;
			}
			if (data === "v") {
				if (this.mode === "visual") this.enterNormal();
				else this.mode = "visual";
				this.requestRender();
				return;
			}
			if (data === "V") {
				if (this.mode === "visual-line") this.enterNormal();
				else this.mode = "visual-line";
				this.requestRender();
				return;
			}
			if (data === "i" || data === "a") {
				this.pendingTextObject = { around: data === "a", count };
				this.requestRender();
				return;
			}
			if (data === "g") {
				this.pendingG = true;
				this.pendingGCount = count;
				this.requestRender();
				return;
			}
			if (data === "f" || data === "F" || data === "t" || data === "T") {
				this.pendingFind = { kind: data, count };
				this.requestRender();
				return;
			}
			if (data === "d" || data === "x") {
				const selection = this.getVisualSelection();
				if (!selection) return;
				if (selection.type === "linewise") this.deleteLinewise(selection.startLine, selection.endLineExclusive, "delete");
				else this.applyCharwiseOperation(selection.start, selection.end, "delete");
				return;
			}
			if (data === "c") {
				const selection = this.getVisualSelection();
				if (!selection) return;
				if (selection.type === "linewise") this.deleteLinewise(selection.startLine, selection.endLineExclusive, "change");
				else this.applyCharwiseOperation(selection.start, selection.end, "change");
				return;
			}
			if (data === "y") {
				const selection = this.getVisualSelection();
				if (!selection) return;
				if (selection.type === "linewise") this.deleteLinewise(selection.startLine, selection.endLineExclusive, "yank");
				else this.applyCharwiseOperation(selection.start, selection.end, "yank");
				this.enterNormal();
				return;
			}
			if (data === "p" || data === "P") {
				this.replaceSelectedWithText(
					this.register.type === "linewise"
						? Array.from({ length: count }, () => this.register.text).join("\n")
						: Array.from({ length: count }, () => this.register.text).join(""),
				);
				return;
			}
			const motion = this.resolveMotion(data, count);
			if (motion) {
				this.applyMotion(motion);
				return;
			}
			return;
		}

		const count = this.takeCount();
		switch (data) {
			case "i": this.enterInsert("i"); return;
			case "a": this.enterInsert("a"); return;
			case "I": this.enterInsert("I"); return;
			case "A": this.enterInsert("A"); return;
			case "o": this.openLine("below"); return;
			case "O": this.openLine("above"); return;
			case "v": this.startVisual(false); return;
			case "V": this.startVisual(true); return;
			case "d": this.pendingOperator = { type: "delete", count }; this.requestRender(); return;
			case "c": this.pendingOperator = { type: "change", count }; this.requestRender(); return;
			case "y": this.pendingOperator = { type: "yank", count }; this.requestRender(); return;
			case "x": this.deleteForwardChars(count, false); return;
			case "X": this.deleteBackwardChars(count); return;
			case "s": this.deleteForwardChars(count, true); return;
			case "S": this.deleteLinewise(this.cursor().line, Math.min(this.lines().length, this.cursor().line + count), "change"); return;
			case "D": this.pendingOperator = { type: "delete", count: 1 }; this.applyOperatorMotion(this.motionLineEnd()); return;
			case "C": this.pendingOperator = { type: "change", count: 1 }; this.applyOperatorMotion(this.motionLineEnd()); return;
			case "Y": this.deleteLinewise(this.cursor().line, Math.min(this.lines().length, this.cursor().line + count), "yank"); return;
			case "p": this.pasteRegister(true, count); return;
			case "P": this.pasteRegister(false, count); return;
			case "u": this.undoEditor(); this.enterNormal(); return;
			case "g": this.pendingG = true; this.pendingGCount = count; this.requestRender(); return;
			case "f":
			case "F":
			case "t":
			case "T":
				this.pendingFind = { kind: data, count };
				this.requestRender();
				return;
		}

		const motion = this.resolveMotion(data, count);
		if (motion) {
			this.applyMotion(motion);
			return;
		}
		} catch (error) {
			this.degrade("handleInput", error);
			this.requestRender();
		}
	}

	override render(width: number): string[] {
		if (this.degraded) return this.withModeLabel(super.render(width), width);
		if (this.mode === "insert") return this.withModeLabel(super.render(width), width);

		try {

		const buildVisualLineMap = this.internals().buildVisualLineMap;
		const findCurrentVisualLine = this.internals().findCurrentVisualLine;
		if (typeof buildVisualLineMap !== "function" || typeof findCurrentVisualLine !== "function") {
			return this.withModeLabel(super.render(width), width);
		}

		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.getPaddingX(), maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
		this.internals().lastWidth = layoutWidth;
		const visualLines = buildVisualLineMap.call(this, layoutWidth) as Array<{
			logicalLine: number;
			startCol: number;
			length: number;
		}>;
		const lines = visualLines.length > 0 ? visualLines : [{ logicalLine: 0, startCol: 0, length: 0 }];
		const terminalRows = this.tui.terminal.rows;
		const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));
		let cursorLineIndex = findCurrentVisualLine.call(this, lines);
		if (cursorLineIndex < 0) cursorLineIndex = 0;

		if (cursorLineIndex < this.internals().scrollOffset) {
			this.internals().scrollOffset = cursorLineIndex;
		} else if (cursorLineIndex >= this.internals().scrollOffset + maxVisibleLines) {
			this.internals().scrollOffset = cursorLineIndex - maxVisibleLines + 1;
		}
		const maxScrollOffset = Math.max(0, lines.length - maxVisibleLines);
		this.internals().scrollOffset = clamp(this.internals().scrollOffset, 0, maxScrollOffset);
		const visibleLines = lines.slice(this.internals().scrollOffset, this.internals().scrollOffset + maxVisibleLines);

		const result: string[] = [];
		const horizontal = this.borderColor("─");
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;

		if (this.internals().scrollOffset > 0) {
			const indicator = `─── ↑ ${this.internals().scrollOffset} more `;
			const remaining = width - visibleWidth(indicator);
			result.push(this.borderColor(indicator + "─".repeat(Math.max(0, remaining))));
		} else {
			result.push(horizontal.repeat(width));
		}

		const cursor = this.cursor();
		for (const line of visibleLines) {
			const raw = this.currentLineText(line.logicalLine).slice(line.startCol, line.startCol + line.length);
			const cursorLocal =
				cursor.line === line.logicalLine &&
				(
					(line.length === 0 && line.startCol === 0) ||
					(cursor.col >= line.startCol && cursor.col < line.startCol + Math.max(1, line.length))
				)
					? Math.max(0, cursor.col - line.startCol)
					: null;
			const selections = this.selectionRangesForVisualLine(line);
			const displayText = this.renderStyledChunk(raw, selections, cursorLocal);
			const lineWidth = visibleWidth(displayText);
			const padding = " ".repeat(Math.max(0, contentWidth - lineWidth));
			result.push(`${leftPadding}${displayText}${padding}${rightPadding}`);
		}

		const linesBelow = lines.length - (this.internals().scrollOffset + visibleLines.length);
		if (linesBelow > 0) {
			const indicator = `─── ↓ ${linesBelow} more `;
			const remaining = width - visibleWidth(indicator);
			result.push(this.borderColor(indicator + "─".repeat(Math.max(0, remaining))));
		} else {
			result.push(horizontal.repeat(width));
		}

		return this.withModeLabel(result, width);
		} catch (error) {
			this.degrade("render", error);
			return this.withModeLabel(super.render(width), width);
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings));
	});
}
