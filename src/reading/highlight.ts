import { MarkdownPostProcessorContext, type MarkdownView } from "obsidian";
import { ParsedComment } from "../format/types";
import { anchorRange, parseComments } from "../format/parse";

/** Rendered block element → its source range, so a Reading-view selection can be
 *  mapped back to markdown offsets (best-effort, used by "Add comment"). */
const sectionRanges = new WeakMap<HTMLElement, { from: number; source: string }>();

/** Walk up from a DOM node to the nearest rendered block we have source for. */
export const findSectionRange = (node: Node): { from: number; source: string } | null => {
	let el: HTMLElement | null = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
	while (el) {
		const range = sectionRanges.get(el);
		if (range) return range;
		el = el.parentElement;
	}
	return null;
};

export const sourceOffsetAtViewportCenter = (view: MarkdownView): number | null => {
	const scroller = view.containerEl.querySelector(".markdown-preview-view");
	if (!(scroller instanceof HTMLElement)) return null;
	const viewport = scroller.getBoundingClientRect();
	const center = viewport.top + viewport.height / 2;
	const section = scroller.querySelector(".markdown-preview-section");
	const root = section?.instanceOf(HTMLElement) ? section : scroller;
	const blocks = Array.from(root.children).filter((el): el is HTMLElement => el.instanceOf(HTMLElement));
	let best: { distance: number; offset: number } | null = null;

	for (const el of blocks) {
		const range = findSectionRange(el);
		if (!range) continue;
		const rect = el.getBoundingClientRect();
		if (rect.bottom < viewport.top || rect.top > viewport.bottom) continue;
		const distance = center < rect.top ? rect.top - center : center > rect.bottom ? center - rect.bottom : 0;
		const ratio = rect.height > 0 ? clamp((center - rect.top) / rect.height, 0, 1) : 0;
		const offset = range.from + Math.round(range.source.length * ratio);
		if (!best || distance < best.distance) best = { distance, offset };
	}

	return best?.offset ?? null;
};

export const offsetToLineCh = (text: string, offset: number): { line: number; ch: number } => {
	let line = 0;
	let lineStart = 0;
	const limit = Math.max(0, Math.min(offset, text.length));
	for (let i = 0; i < limit; i++) {
		if (text.charCodeAt(i) === 10) {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, ch: limit - lineStart };
};

// Parsing the whole file per rendered block would be wasteful, so cache the last
// parse keyed on the exact source text.
let cacheKey: string | null = null;
let cacheVal: ParsedComment[] = [];

const commentsFor = (text: string): ParsedComment[] => {
	if (text !== cacheKey) {
		cacheKey = text;
		cacheVal = parseComments(text);
	}
	return cacheVal;
};

/**
 * Reading-view post-processor: wraps each comment's anchored text in a
 * `.doc-comment-span[data-cid]` so the highlight shows in rendered output.
 * The `<!--c:-->` / `<!--co:-->` markers are HTML comments, already invisible.
 */
export const highlightPostProcessor = (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
	const info = ctx.getSectionInfo(el);
	if (!info) return;
	const { text, lineStart, lineEnd } = info;

	const lines = text.split("\n");
	const sectionFrom = offsetOfLine(lines, lineStart);
	const sectionTo = offsetOfLine(lines, lineEnd + 1);
	// Remember this block's source range for selection → markdown mapping.
	sectionRanges.set(el, { from: sectionFrom, source: text.slice(sectionFrom, sectionTo) });

	const comments = commentsFor(text);
	if (comments.length === 0) return;

	for (const c of comments) {
		const range = anchorRange(c);
		if (!range) continue;
		// Only act on comments whose anchor starts within this rendered section.
		if (range.from < sectionFrom || range.from >= sectionTo) continue;
		const quote = text.slice(range.from, range.to);
		if (quote.trim()) wrapFirstMatch(el, quote, c.id, c.status === "resolved");
	}
};

const offsetOfLine = (lines: string[], lineNo: number): number => {
	let offset = 0;
	for (let i = 0; i < lineNo && i < lines.length; i++) offset += lines[i].length + 1;
	return offset;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Wrap the first single-text-node occurrence of `needle` in a highlight span.
 *  Uses the element's own document so it works in pop-out windows too. */
const wrapFirstMatch = (root: HTMLElement, needle: string, id: string, resolved: boolean): boolean => {
	const doc = root.ownerDocument;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode() as Text | null;
	while (node) {
		const idx = node.data.indexOf(needle);
		if (idx >= 0 && !isInsideHighlight(node)) {
			const range = doc.createRange();
			range.setStart(node, idx);
			range.setEnd(node, idx + needle.length);
			const span = doc.createElement("span");
			span.className = resolved ? "doc-comment-span is-resolved" : "doc-comment-span";
			span.setAttribute("data-cid", id);
			try {
				range.surroundContents(span);
				return true;
			} catch {
				return false; // range crossed element boundaries — skip gracefully
			}
		}
		node = walker.nextNode() as Text | null;
	}
	return false;
};

const isInsideHighlight = (node: Node): boolean => {
	return !!(node.parentElement && node.parentElement.closest(".doc-comment-span"));
};
