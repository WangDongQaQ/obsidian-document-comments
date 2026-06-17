import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseComments, anchorRange, isAnchored } from "../src/format/parse";

const demo = readFileSync(new URL("../test-vault/Demo.md", import.meta.url), "utf8");

describe("demo vault note", () => {
	it("contains three well-formed, anchored comments in order", () => {
		const comments = parseComments(demo);
		expect(comments.map((c) => c.id)).toEqual(["k3f9", "a7b2", "zz1q"]);
		expect(comments.every(isAnchored)).toBe(true);
	});

	it("anchors and status are correct", () => {
		const comments = parseComments(demo);
		const k = comments.find((c) => c.id === "k3f9")!;
		expect(demo.slice(anchorRange(k)!.from, anchorRange(k)!.to)).toBe("ship on Friday");
		expect(k.thread).toHaveLength(2);
		expect(comments.find((c) => c.id === "zz1q")!.status).toBe("resolved");
	});
});
