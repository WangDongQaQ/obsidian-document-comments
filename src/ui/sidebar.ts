import { App, Debouncer, ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { Result } from "better-result";
import { EditorView } from "@codemirror/view";
import { ParsedComment } from "../format/types";
import { anchorRange, parseComments } from "../format/parse";
import { Card, CardCallbacks, cardSignature } from "./card";
import {
	Change,
	applyChanges,
	computeAppendReply,
	computeDeleteComment,
	computeDeleteEntry,
	computeEditEntry,
	computeToggleReaction,
} from "../editor/edits";
import { cssEscape } from "../util/css";
import { offsetToLineCh, sourceOffsetAtViewportCenter } from "../reading/highlight";

export const COMMENTS_VIEW_TYPE = "aspen-document-comments-sidebar";

export type SidebarDeps = {
	app: App;
	getAuthor: () => string;
};

const CARD_GAP = 8;
const EDGE_PAD = 8;

/**
 * A right-sidebar margin: cards are positioned against the active note's viewport,
 * while off-screen comments collapse into jump bars.
 */
export class CommentsSidebarView extends ItemView {
	private trackEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private titleEl!: HTMLElement;
	private topBar!: HTMLButtonElement;
	private bottomBar!: HTMLButtonElement;
	private cards = new Map<string, Card>();
	private comments: ParsedComment[] = [];
	private file: TFile | null = null;
	private aboveIds: string[] = [];
	private belowIds: string[] = [];
	private boundScroller: HTMLElement | null = null;
	private cb: CardCallbacks;
	private scheduleRefresh: Debouncer<[], void>;
	private schedulePosition: Debouncer<[], void>;
	private resizeObserver: ResizeObserver | null = null;
	private animFrames = 0;
	private animatingLoop = false;

	constructor(
		leaf: WorkspaceLeaf,
		private deps: SidebarDeps,
	) {
		super(leaf);
		this.scheduleRefresh = debounce(() => void this.refresh(), 60, true);
		this.schedulePosition = debounce(() => this.position(), 16, true);
		this.cb = {
			getAuthor: () => deps.getAuthor(),
			onHover: (id, active) => this.markDocHighlight(id, active),
			onClickAnchor: (id) => void this.revealAnchor(id),
			onResize: () => this.position(),
			animateLayout: () => this.animateLayout(),
			revealComposer: (id) => this.revealComposer(id),
			reply: (id, text) =>
				void this.edit((doc) =>
					computeAppendReply(doc, id, {
						createdAt: new Date().toISOString(),
						author: deps.getAuthor(),
						text,
					}),
				),
			// ponytail: Card still expects the callback; no resolve UI calls it.
			setResolved: () => {},
			remove: (id) => void this.edit((doc) => computeDeleteComment(doc, id)),
			editEntry: (id, index, text) => void this.edit((doc) => computeEditEntry(doc, id, index, text)),
			deleteEntry: (id, index) => void this.edit((doc) => computeDeleteEntry(doc, id, index)),
			toggleReaction: (id, emoji) =>
				void this.edit((doc) => computeToggleReaction(doc, id, emoji, deps.getAuthor())),
		};
	}

	getViewType(): string {
		return COMMENTS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Comments";
	}

	getIcon(): string {
		return "messages-square";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("dc-sidebar-view");

		const header = root.createDiv("dc-sidebar__header dc-sidebar__header--simple");
		this.titleEl = header.createDiv("dc-sidebar__title");

		const viewport = root.createDiv("dc-follow-sidebar");
		this.topBar = viewport.createEl("button", { cls: "dc-sidebar-edge dc-sidebar-edge--top is-hidden" });
		this.trackEl = viewport.createDiv("dc-sidebar-track");
		this.emptyEl = viewport.createDiv("dc-sidebar__empty");
		this.bottomBar = viewport.createEl("button", { cls: "dc-sidebar-edge dc-sidebar-edge--bottom is-hidden" });
		this.topBar.addEventListener("click", () => this.jumpCollapsed("above"));
		this.bottomBar.addEventListener("click", () => this.jumpCollapsed("below"));

		this.resizeObserver = new ResizeObserver(() => this.position());
		this.resizeObserver.observe(viewport);

		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleRefresh()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleRefresh()));
		this.registerEvent(this.app.workspace.on("editor-change", () => this.scheduleRefresh()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleRefresh()));
		this.registerEvent(this.app.workspace.on("resize", () => this.schedulePosition()));
		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				if (this.file && f.path === this.file.path) this.scheduleRefresh();
			}),
		);

		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.unbindDocumentScroll();
		this.resizeObserver?.disconnect();
		for (const card of this.cards.values()) {
			card.destroy();
			card.el.remove();
		}
		this.cards.clear();
	}

	requestRefresh(): void {
		this.scheduleRefresh();
	}

	async revealComment(id: string): Promise<void> {
		await this.refresh();
		await this.revealAnchor(id);
		window.setTimeout(() => {
			const card = this.cards.get(id);
			if (!card) return;
			card.el.addClass("dc-flash");
			window.setTimeout(() => card.el.removeClass("dc-flash"), 1000);
		}, 260);
	}

	private revealComposer(id: string): void {
		const card = this.cards.get(id);
		if (!card) return;
		window.requestAnimationFrame(() => {
			const box = card.el.querySelector(".dc-field--composer");
			if (!(box instanceof HTMLElement)) return;
			const b = box.getBoundingClientRect();
			const t = this.trackEl.getBoundingClientRect();
			const delta = b.bottom > t.bottom ? b.bottom - t.bottom + 12 : b.top < t.top ? b.top - t.top - 12 : 0;
			if (delta && this.boundScroller) this.boundScroller.scrollTop += delta;
		});
	}

	private async refresh(text?: string): Promise<void> {
		this.file = this.resolveFile();

		const file = this.file;
		if (!file) {
			this.comments = [];
			this.renderComments([]);
			this.titleEl.setText("Comments");
			this.setEmpty("Open a note to see its comments.");
			this.position();
			return;
		}

		let data: string;
		try {
			data = text ?? (await this.currentText(file));
		} catch {
			this.comments = [];
			this.renderComments([]);
			this.titleEl.setText(file.basename);
			this.setEmpty("Couldn't read this note.");
			this.position();
			return;
		}

		this.comments = parseComments(data).filter((c) => c.body);
		this.titleEl.setText(`${file.basename} - ${this.comments.length}`);
		this.renderComments(this.comments);
		this.setEmpty(this.comments.length === 0 ? "No comments in this note yet." : null);
		this.bindDocumentScroll();
		this.position();
	}

	private renderComments(comments: ParsedComment[]): void {
		const present = new Set(comments.map((c) => c.id));
		for (const [id, card] of this.cards) {
			if (!present.has(id)) {
				card.destroy();
				card.el.remove();
				this.cards.delete(id);
			}
		}
		const cardView = { app: this.app, sourcePath: () => this.file?.path ?? "", collapsible: true };
		for (const c of comments) {
			const existing = this.cards.get(c.id);
			if (!existing) {
				const card = new Card(c, this.cb, cardView);
				this.cards.set(c.id, card);
				this.trackEl.appendChild(card.el);
			} else if (existing.signature !== cardSignature(c)) {
				existing.update(c);
			}
		}
		const desired = comments.map((c) => this.cards.get(c.id)!.el);
		const current = Array.from(this.trackEl.children).filter((el) => el.classList.contains("doc-comment-card"));
		const sameOrder = desired.length === current.length && desired.every((el, i) => el === current[i]);
		if (!sameOrder) for (const el of desired) this.trackEl.appendChild(el);
	}

	private position(): void {
		if (!this.trackEl.isConnected) return;
		this.bindDocumentScroll();
		const box = this.trackEl.getBoundingClientRect();
		const height = this.trackEl.clientHeight;
		const placements: Array<{ id: string; el: HTMLElement; top: number }> = [];
		const centerOffset = this.readingCenterOffset();
		this.aboveIds = [];
		this.belowIds = [];

		for (const [order, c] of this.comments.entries()) {
			const card = this.cards.get(c.id);
			if (!card) continue;
			const top = this.anchorTop(c);
			if (top == null) {
				const pos = this.commentSourcePos(c) ?? order;
				if (centerOffset != null && pos < centerOffset) this.aboveIds.push(c.id);
				else this.belowIds.push(c.id);
				card.el.addClass("dc-sidebar-offscreen");
				continue;
			}
			const y = top - box.top;
			if (y < 0) {
				this.aboveIds.push(c.id);
				card.el.addClass("dc-sidebar-offscreen");
			} else if (y > height) {
				this.belowIds.push(c.id);
				card.el.addClass("dc-sidebar-offscreen");
			} else {
				card.el.removeClass("dc-sidebar-offscreen");
				placements.push({ id: c.id, el: card.el, top: y });
			}
		}

		placements.sort((a, b) => a.top - b.top);
		let cursor = EDGE_PAD;
		for (const p of placements) {
			const y = Math.max(p.top, cursor);
			p.el.setCssStyles({ top: `${y}px` });
			p.el.toggleClass("is-edge-top", y < EDGE_PAD + 16);
			p.el.toggleClass("is-edge-bottom", y + p.el.offsetHeight > height - EDGE_PAD - 16);
			cursor = y + p.el.offsetHeight + CARD_GAP;
		}
		this.paintEdgeBars();
	}

	private anchorTop(c: ParsedComment): number | null {
		const file = this.file;
		if (!file) return null;
		const view = this.markdownViewForFile(file);
		if (!view) return null;
		if (view.getMode() === "preview") {
			const span = view.containerEl.querySelector(`.doc-comment-span[data-cid="${cssEscape(c.id)}"]`);
			return span instanceof HTMLElement ? span.getBoundingClientRect().top : null;
		}
		const cm = this.editorViewForFile(file);
		if (!cm) return null;
		const r = anchorRange(c);
		const pos = r ? r.from : c.body?.from;
		if (pos == null) return null;
		return cm.coordsAtPos(pos)?.top ?? null;
	}

	private paintEdgeBars(): void {
		this.topBar.toggleClass("is-hidden", this.aboveIds.length === 0);
		this.bottomBar.toggleClass("is-hidden", this.belowIds.length === 0);
		this.topBar.setText(String(this.aboveIds.length));
		this.bottomBar.setText(String(this.belowIds.length));
		this.topBar.setAttribute("aria-label", `Jump to ${this.aboveIds.length} hidden comments above`);
		this.bottomBar.setAttribute("aria-label", `Jump to ${this.belowIds.length} hidden comments below`);
	}

	private jumpCollapsed(direction: "above" | "below"): void {
		const id = direction === "above" ? this.aboveIds[this.aboveIds.length - 1] : this.belowIds[0];
		if (id) void this.revealAnchor(id);
	}

	private setEmpty(message: string | null): void {
		this.emptyEl.toggleClass("is-hidden", message === null);
		this.emptyEl.setText(message ?? "");
	}

	private async edit(compute: (doc: string) => Result<Change[], string>): Promise<void> {
		const file = this.file;
		if (!file) return;
		const cm = this.editorViewForFile(file);
		if (cm) {
			compute(cm.state.doc.toString()).match({
				ok: (changes) => {
					cm.dispatch({ changes });
					void this.refresh();
				},
				err: (message) => new Notice(`Couldn't save the comment: ${message}`),
			});
			return;
		}
		let computeError: string | undefined;
		const io = await Result.tryPromise({
			try: () =>
				this.app.vault.process(file, (data) => {
					const result = compute(data);
					if (result.isErr()) {
						computeError = result.error;
						return data;
					}
					return applyChanges(data, result.value);
				}),
			catch: (e) => (e instanceof Error ? e.message : "unknown error"),
		});
		const outcome: Result<string, string> = computeError ? Result.err(computeError) : io;
		outcome.match({
			ok: (newData) => void this.refresh(newData),
			err: (message) => new Notice(`Couldn't save the comment: ${message}`),
		});
	}

	private async revealAnchor(id: string): Promise<void> {
		const file = this.file;
		if (!file) return;
		const view = this.markdownViewForFile(file);
		if (!view) return;
		if (view.getMode() === "preview") {
			if (this.revealPreviewSpan(view, id)) return;
			let doc: string;
			try {
				doc = await this.currentText(file);
			} catch {
				return;
			}
			const c = this.comments.find((x) => x.id === id) ?? parseComments(doc).find((x) => x.id === id);
			const pos = c ? this.commentSourcePos(c) : null;
			if (pos == null) return;
			this.scrollPreviewToOffset(view, doc, pos);
			this.retryPreviewSpan(view, id);
			return;
		}
		const cm = this.editorViewForFile(file);
		if (!cm) return;
		const c = parseComments(cm.state.doc.toString()).find((x) => x.id === id);
		if (!c) return;
		const r = anchorRange(c);
		const pos = r ? r.from : c.body?.from;
		if (pos == null) return;
		cm.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
		window.setTimeout(() => {
			const span = cm.contentDOM.querySelector(`.doc-comment-span[data-cid="${cssEscape(id)}"]`);
			if (span instanceof HTMLElement) this.flash(span);
			this.position();
		}, 80);
	}

	private revealPreviewSpan(view: MarkdownView, id: string): boolean {
		const span = view.containerEl.querySelector(`.doc-comment-span[data-cid="${cssEscape(id)}"]`);
		if (!(span instanceof HTMLElement)) return false;
		span.scrollIntoView({ block: "center", behavior: "smooth" });
		this.flash(span);
		window.setTimeout(() => this.position(), 220);
		return true;
	}

	private retryPreviewSpan(view: MarkdownView, id: string): void {
		let done = false;
		const retry = (): void => {
			if (done) return;
			done = this.revealPreviewSpan(view, id);
			if (!done) this.position();
		};
		window.setTimeout(retry, 220);
		window.setTimeout(retry, 650);
	}

	private scrollPreviewToOffset(view: MarkdownView, doc: string, offset: number): void {
		const loc = offsetToLineCh(doc, offset);
		const scroller = this.documentScroller();
		const before = scroller?.scrollTop;
		view.setEphemeralState({ ...view.getEphemeralState(), line: loc.line });
		try {
			view.editor.scrollIntoView({ from: loc, to: loc }, true);
		} catch {
			// Some Obsidian builds don't wire the editor facade in preview mode.
		}
		if (!scroller || before == null) return;
		window.setTimeout(() => {
			if (Math.abs(scroller.scrollTop - before) > 2) return;
			const max = scroller.scrollHeight - scroller.clientHeight;
			if (max > 0) scroller.scrollTo({ top: (offset / Math.max(doc.length, 1)) * max, behavior: "smooth" });
		}, 40);
	}

	private commentSourcePos(c: ParsedComment): number | null {
		const r = anchorRange(c);
		return r ? r.from : (c.body?.from ?? null);
	}

	private readingCenterOffset(): number | null {
		const file = this.file;
		if (!file) return null;
		const view = this.markdownViewForFile(file);
		return view?.getMode() === "preview" ? sourceOffsetAtViewportCenter(view) : null;
	}

	private markDocHighlight(id: string, active: boolean): void {
		const file = this.file;
		if (!file) return;
		const view = this.markdownViewForFile(file);
		if (!view) return;
		view.containerEl
			.querySelectorAll(`.doc-comment-span[data-cid="${cssEscape(id)}"]`)
			.forEach((s) => s.classList.toggle("is-active", active));
	}

	private flash(span: HTMLElement): void {
		span.addClass("dc-flash");
		window.setTimeout(() => span.removeClass("dc-flash"), 900);
	}

	private animateLayout(): void {
		this.animFrames = 14;
		this.position();
		if (this.animatingLoop) return;
		this.animatingLoop = true;
		const tick = (): void => {
			this.position();
			if (this.animFrames-- > 0) window.requestAnimationFrame(tick);
			else this.animatingLoop = false;
		};
		window.requestAnimationFrame(tick);
	}

	private bindDocumentScroll(): void {
		const next = this.documentScroller();
		if (next === this.boundScroller) return;
		this.unbindDocumentScroll();
		this.boundScroller = next;
		this.boundScroller?.addEventListener("scroll", this.onDocumentScroll, { passive: true });
	}

	private unbindDocumentScroll(): void {
		this.boundScroller?.removeEventListener("scroll", this.onDocumentScroll);
		this.boundScroller = null;
	}

	private onDocumentScroll = (): void => {
		this.schedulePosition();
	};

	private documentScroller(): HTMLElement | null {
		const file = this.file;
		if (!file) return null;
		const view = this.markdownViewForFile(file);
		if (!view) return null;
		if (view.getMode() === "preview") {
			const scroller = view.containerEl.querySelector(".markdown-preview-view");
			return scroller instanceof HTMLElement ? scroller : null;
		}
		return this.editorViewForFile(file)?.scrollDOM ?? null;
	}

	private resolveFile(): TFile | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file) return active.file;
		const recent = this.app.workspace.getMostRecentLeaf();
		if (recent?.view instanceof MarkdownView && recent.view.file) return recent.view.file;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.file) return v.file;
		}
		return null;
	}

	private async currentText(file: TFile): Promise<string> {
		const cm = this.editorViewForFile(file);
		if (cm) return cm.state.doc.toString();
		return this.app.vault.read(file);
	}

	private editorViewForFile(file: TFile): EditorView | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.file?.path === file.path && v.getMode() !== "preview") {
				const cm = (v.editor as unknown as { cm?: unknown }).cm;
				if (cm instanceof EditorView) return cm;
			}
		}
		return null;
	}

	private markdownViewForFile(file: TFile): MarkdownView | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.file?.path === file.path) return v;
		}
		return null;
	}
}
