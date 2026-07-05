// @vitest-environment happy-dom
//
// The Reading-view post-processor wraps each comment's anchored text in a
// `.doc-comment-span` so the highlight shows in rendered output. This covers the
// table case specifically: Live Preview can't highlight inside a table (Obsidian
// replaces it with a nested-editor widget our mark decoration can't reach), but
// Reading view walks the rendered DOM and *can*.
import { describe, expect, test } from "vitest";
import type { MarkdownPostProcessorContext, MarkdownView } from "obsidian";
import { highlightPostProcessor, offsetToLineCh, sourceOffsetAtViewportCenter } from "../src/reading/highlight";

// Minimal context: report the block's source + line span, like Obsidian does.
const ctxFor = (text: string, lineStart: number, lineEnd: number): MarkdownPostProcessorContext =>
	({ getSectionInfo: () => ({ text, lineStart, lineEnd }) }) as unknown as MarkdownPostProcessorContext;

Object.defineProperty(Node.prototype, "instanceOf", {
	value(this: Node, type: { new (): unknown }) {
		return this instanceof type;
	},
	configurable: true,
});

describe("reading-view highlight post-processor", () => {
	test("wraps a comment anchor in a paragraph", () => {
		const doc = [
			"We ship on <!--c:p1-->Friday<!--/c:p1--> regardless.",
			'<!--co:p1 by:me at:2026-01-01T00:00:00.000Z status:open quote:"Friday"',
			"me: ok",
			"-->",
			"",
		].join("\n");
		const el = document.createElement("p");
		el.textContent = "We ship on Friday regardless.";
		highlightPostProcessor(el, ctxFor(doc, 0, 0));
		expect(el.querySelector(".doc-comment-span[data-cid='p1']")?.textContent).toBe("Friday");
	});

	test("wraps a comment anchor that lands inside a table cell", () => {
		const doc = [
			"| Day | Note |",
			"| --- | --- |",
			"| <!--c:t1-->Friday<!--/c:t1--> | ship |",
			'<!--co:t1 by:me at:2026-01-01T00:00:00.000Z status:open quote:"Friday"',
			"me: ok",
			"-->",
			"",
		].join("\n");
		// Rendered table DOM — the HTML-comment markers are invisible in output.
		const el = document.createElement("div");
		el.innerHTML = "<table><tbody><tr><td>Friday</td><td>ship</td></tr></tbody></table>";
		highlightPostProcessor(el, ctxFor(doc, 0, 2));
		const span = el.querySelector(".doc-comment-span[data-cid='t1']");
		expect(span?.textContent).toBe("Friday");
		// …and it lands in the right cell, not elsewhere in the table.
		expect(span?.closest("td")?.textContent).toBe("Friday");
	});

	test("maps the reading viewport center back to a source offset", () => {
		const doc = ["Top block", "", "Middle block", "", "Bottom block"].join("\n");
		const root = document.createElement("div");
		const scroller = document.createElement("div");
		scroller.className = "markdown-preview-view";
		const section = document.createElement("div");
		const top = document.createElement("div");
		const middle = document.createElement("div");
		const bottom = document.createElement("div");
		section.className = "markdown-preview-section";
		scroller.appendChild(section);
		section.append(top, middle, bottom);
		top.textContent = "Top block";
		middle.textContent = "Middle block";
		bottom.textContent = "Bottom block";
		root.appendChild(scroller);
		document.body.appendChild(root);

		setRect(scroller, 0, 200);
		setRect(top, 0, 40);
		setRect(middle, 80, 140);
		setRect(bottom, 180, 220);
		Object.defineProperty(scroller, "clientHeight", { value: 200 });

		highlightPostProcessor(top, ctxFor(doc, 0, 0));
		highlightPostProcessor(middle, ctxFor(doc, 2, 2));
		highlightPostProcessor(bottom, ctxFor(doc, 4, 4));

		const view = { containerEl: root } as unknown as MarkdownView;
		expect(sourceOffsetAtViewportCenter(view)).toBeGreaterThanOrEqual(doc.indexOf("Middle"));
		root.remove();
	});

	test("converts source offsets to line/ch pairs", () => {
		expect(offsetToLineCh("aa\nbbb\nc", 5)).toEqual({ line: 1, ch: 2 });
	});
});

const setRect = (el: HTMLElement, top: number, bottom: number): void => {
	el.getBoundingClientRect = () =>
		({
			x: 0,
			y: top,
			top,
			right: 0,
			bottom,
			left: 0,
			width: 0,
			height: bottom - top,
			toJSON: () => ({}),
		}) as DOMRect;
};
