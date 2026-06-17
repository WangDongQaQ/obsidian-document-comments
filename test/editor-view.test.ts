// @vitest-environment happy-dom
//
// Regression test for the editor extensions in a *live* EditorView. This is the
// only test that exercises StateField `provide` evaluation — which newer
// CodeMirror runs eagerly inside StateField.define — so it catches load-order
// bugs (e.g. a `provide` referencing a const declared later, a temporal-dead-zone
// crash) that pure-state and format tests miss. It fails outright if any editor
// extension throws while a note is opened.
import { describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { commentField } from "../src/editor/state";
import { draftField } from "../src/editor/draft";

const open = (doc: string): void => {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const view = new EditorView({
		state: EditorState.create({ doc, extensions: [commentField, draftField] }),
		parent,
	});
	// A change forces the height map + decoration spans to rebuild — the path
	// that crashed in Obsidian.
	view.dispatch({ changes: { from: 0, insert: "x" } });
	view.requestMeasure();
	view.destroy();
};

describe("editor extensions open every note without crashing", () => {
	test("plain note with no comments", () => {
		expect(() => open("Just plain text.\nNo comments here.\n")).not.toThrow();
	});

	test("note with a single comment", () => {
		const doc = [
			"Ship on <!--c:aaa-->Friday<!--/c:aaa--> regardless.",
			'<!--co:aaa by:me at:2026-06-17T00:00:00.000Z status:open quote:"Friday"',
			"me: sounds good",
			"-->",
			"",
		].join("\n");
		expect(() => open(doc)).not.toThrow();
	});

	test("note with overlapping / nested comments", () => {
		const doc = [
			"Already <!--c:zz1q--><!--c:xoua6-->resolved<!--/c:xoua6--><!--/c:zz1q--> here.",
			'<!--co:zz1q by:me at:2026-06-17T00:00:00.000Z status:resolved quote:"resolved"',
			"me: handled",
			"-->",
			'<!--co:xoua6 by:me at:2026-06-17T00:00:01.000Z status:open quote:"resolved"',
			"me: yooooo",
			"-->",
			"",
		].join("\n");
		expect(() => open(doc)).not.toThrow();
	});
});
