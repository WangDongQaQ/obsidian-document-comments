import { App, Debouncer, ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
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
	computeSetResolved,
	computeToggleReaction,
} from "../editor/edits";
import { cssEscape } from "../util/css";

export const COMMENTS_VIEW_TYPE = "document-comments-sidebar";

export type SidebarDeps = {
	app: App;
	getAuthor: () => string;
	showComments: () => boolean;
	showResolved: () => boolean;
	/** Flip the master comment toggle (mirrors the command/ribbon). */
	toggleComments: () => void;
	/** Flip the resolved-comments filter. */
	toggleResolved: () => void;
	/** Tell the plugin the panel mounted/unmounted, so the inline column can
	 *  step aside (while open) or come back (once closed). */
	onMountedChange: (open: boolean) => void;
};

/**
 * The "All discussions" panel: a dedicated side view listing every comment in
 * the active note as Notion-style cards. While it's open the inline floating
 * cards step aside (the plugin reads `onMountedChange`); the in-text highlights
 * stay. Edits route through the open editor when there is one (so they join its
 * undo history), else through `vault.process`.
 */
export class CommentsSidebarView extends ItemView {
	private listEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private titleEl!: HTMLElement;
	private countEl!: HTMLElement;
	private cards = new Map<string, Card>();
	private file: TFile | null = null;
	private cb: CardCallbacks;
	private scheduleRefresh: Debouncer<[], void>;
	private commentsToggleAction: HTMLElement | null = null;
	private resolvedToggleAction: HTMLElement | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private deps: SidebarDeps,
	) {
		super(leaf);
		this.scheduleRefresh = debounce(() => void this.refresh(), 60, true);
		this.cb = {
			getAuthor: () => deps.getAuthor(),
			onHover: (id, active) => this.markDocHighlight(id, active),
			onClickAnchor: (id) => this.revealAnchor(id),
			onResize: () => {
				/* the panel uses normal flow — cards reflow on their own */
			},
			reply: (id, text) =>
				void this.edit((doc) =>
					computeAppendReply(doc, id, {
						createdAt: new Date().toISOString(),
						author: deps.getAuthor(),
						text,
					}),
				),
			setResolved: (id, resolved) => void this.edit((doc) => computeSetResolved(doc, id, resolved)),
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
		return "message-square";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("dc-sidebar-view");

		const header = root.createDiv("dc-sidebar__header");
		this.titleEl = header.createSpan("dc-sidebar__title");
		this.countEl = header.createSpan("dc-sidebar__count");

		this.listEl = root.createDiv("dc-sidebar");
		this.emptyEl = root.createDiv("dc-sidebar__empty");

		this.resolvedToggleAction = this.addAction("badge-check", "Show resolved comments", () =>
			this.deps.toggleResolved(),
		);
		this.commentsToggleAction = this.addAction("eye", "Hide comments in document", () =>
			this.deps.toggleComments(),
		);

		// Follow the active note, its content, and external edits.
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleRefresh()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleRefresh()));
		this.registerEvent(this.app.workspace.on("editor-change", () => this.scheduleRefresh()));
		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				if (this.file && f.path === this.file.path) this.scheduleRefresh();
			}),
		);

		this.deps.onMountedChange(true);
		await this.refresh();
	}

	async onClose(): Promise<void> {
		for (const card of this.cards.values()) card.el.remove();
		this.cards.clear();
		this.deps.onMountedChange(false);
	}

	/** Public hook so the plugin can re-render after a settings toggle. */
	requestRefresh(): void {
		this.scheduleRefresh();
	}

	private async refresh(text?: string): Promise<void> {
		this.file = this.resolveFile();
		this.updateActions();

		const file = this.file;
		if (!file) {
			this.renderComments([]);
			this.setHeader(null, 0);
			this.setEmpty("Open a note to see its comments.");
			return;
		}

		let data: string;
		try {
			data = text ?? (await this.currentText(file));
		} catch {
			this.renderComments([]);
			this.setHeader(file.basename, 0);
			this.setEmpty("Couldn't read this note.");
			return;
		}

		const comments = parseComments(data).filter((c) => c.body);
		this.renderComments(comments);
		this.listEl.toggleClass("dc-hide-resolved", !this.deps.showResolved());

		const visible = this.deps.showResolved()
			? comments.length
			: comments.filter((c) => c.status !== "resolved").length;
		this.setHeader(file.basename, visible);
		if (comments.length === 0) this.setEmpty("No comments in this note yet.");
		else if (visible === 0) this.setEmpty("Only resolved comments here — show them with the badge button above.");
		else this.setEmpty(null);
	}

	private renderComments(comments: ParsedComment[]): void {
		const present = new Set(comments.map((c) => c.id));
		for (const [id, card] of this.cards) {
			if (!present.has(id)) {
				card.el.remove();
				this.cards.delete(id);
			}
		}
		for (const c of comments) {
			const existing = this.cards.get(c.id);
			if (!existing) {
				this.cards.set(c.id, new Card(c, this.cb));
			} else if (existing.signature !== cardSignature(c)) {
				existing.update(c);
			}
		}
		// Re-order the DOM to match document order — but only touch it when the
		// order actually differs, so an open composer doesn't lose focus on every
		// content refresh.
		const desired = comments.map((c) => this.cards.get(c.id)!.el);
		const current = Array.from(this.listEl.children);
		const sameOrder = desired.length === current.length && desired.every((el, i) => el === current[i]);
		if (!sameOrder) for (const el of desired) this.listEl.appendChild(el);
	}

	private setHeader(name: string | null, count: number): void {
		this.titleEl.setText(name ?? "Comments");
		this.countEl.setText(name ? String(count) : "");
	}

	private setEmpty(message: string | null): void {
		this.emptyEl.toggleClass("is-hidden", message === null);
		this.emptyEl.setText(message ?? "");
	}

	private updateActions(): void {
		if (this.commentsToggleAction) {
			const on = this.deps.showComments();
			setIcon(this.commentsToggleAction, on ? "eye" : "eye-off");
			this.commentsToggleAction.setAttribute(
				"aria-label",
				on ? "Hide comments in document" : "Show comments in document",
			);
		}
		if (this.resolvedToggleAction) {
			const on = this.deps.showResolved();
			setIcon(this.resolvedToggleAction, on ? "badge-check" : "badge");
			this.resolvedToggleAction.setAttribute(
				"aria-label",
				on ? "Hide resolved comments" : "Show resolved comments",
			);
		}
	}

	// ── Edits ──────────────────────────────────────────────────────────────
	/** Apply a computed change set to the active note. Prefer the open editor
	 *  (keeps edits in its undo history and in sync with unsaved changes);
	 *  fall back to a direct file write for notes only shown in reading view. */
	private async edit(compute: (doc: string) => Change[] | null): Promise<void> {
		const file = this.file;
		if (!file) return;
		const cm = this.editorViewForFile(file);
		if (cm) {
			const changes = compute(cm.state.doc.toString());
			if (changes) cm.dispatch({ changes });
			await this.refresh();
			return;
		}
		try {
			const newData = await this.app.vault.process(file, (data) => {
				const changes = compute(data);
				return changes ? applyChanges(data, changes) : data;
			});
			await this.refresh(newData);
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown error";
			new Notice(`Couldn't save the comment: ${message}`);
		}
	}

	// ── Document interplay ─────────────────────────────────────────────────
	private revealAnchor(id: string): void {
		const file = this.file;
		if (!file) return;
		const view = this.markdownViewForFile(file);
		if (!view) return;
		if (view.getMode() === "preview") {
			const span = view.containerEl.querySelector(`.doc-comment-span[data-cid="${cssEscape(id)}"]`);
			if (span instanceof HTMLElement) {
				span.scrollIntoView({ block: "center", behavior: "smooth" });
				this.flash(span);
			}
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
		}, 50);
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

	// ── Resolving the active note + its live text ──────────────────────────
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
			if (v instanceof MarkdownView && v.file === file && v.getMode() !== "preview") {
				const cm = (v.editor as unknown as { cm?: unknown }).cm;
				if (cm instanceof EditorView) return cm;
			}
		}
		return null;
	}

	private markdownViewForFile(file: TFile): MarkdownView | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.file === file) return v;
		}
		return null;
	}
}
