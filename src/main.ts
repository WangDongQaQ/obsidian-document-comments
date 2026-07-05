import { Editor, MarkdownView, Notice, Platform, Plugin, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { Result } from "better-result";
import { EditorView } from "@codemirror/view";
import { commentField } from "./editor/state";
import { marginPlugin } from "./editor/margin";
import { commentConfig } from "./editor/config";
import { editorLayoutField } from "./editor/layout";
import { draftField, setDraft } from "./editor/draft";
import { addComment, insertCommentInFile } from "./editor/commands";
import {
	findSectionRange,
	highlightPostProcessor,
	offsetToLineCh,
	sourceOffsetAtViewportCenter,
} from "./reading/highlight";
import { ReadingDeps, ReadingMarginManager } from "./reading/margin";
import { COMMENTS_VIEW_TYPE, CommentsSidebarView, SidebarDeps } from "./ui/sidebar";
import { CommentModal } from "./ui/comment-modal";
import { DEFAULT_SETTINGS, DocCommentsSettings, DocCommentsSettingTab } from "./settings";
import { anchorRange, parseComments } from "./format/parse";
import { cssEscape } from "./util/css";

export default class DocCommentsPlugin extends Plugin {
	settings: DocCommentsSettings = { ...DEFAULT_SETTINGS };
	private readingManager: ReadingMarginManager | null = null;
	private scheduleReadingRefresh: () => void = () => {};
	/** True while the "All discussions" sidebar panel is mounted. */
	private sidebarOpen = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerEditorExtension([
			commentField,
			draftField,
			commentConfig.of({
				app: this.app,
				author: () => this.authorName(),
				showComments: () => this.settings.showComments,
				showResolved: () => this.settings.showResolved,
				sidebarOpen: () => this.sidebarOpen,
				openInSidebar: (id) => void this.revealComment(id),
				isMobile: () => Platform.isMobile,
			}),
			// Reflects dc-has / dc-highlights / dc-hide-resolved onto .cm-editor so the
			// stylesheet caps the text column without a :has() selector.
			editorLayoutField,
			// The floating margin column needs horizontal room mobile doesn't have, so
			// there we skip it entirely — comments live in the sidebar, highlights stay,
			// and new comments are composed in a modal (see startAddComment).
			...(Platform.isMobile ? [] : [marginPlugin]),
		]);

		// Reading view: a separate render path. Highlights come from a post-processor;
		// the margin column is managed per reading-view container.
		const readingDeps: ReadingDeps = {
			app: this.app,
			getAuthor: () => this.authorName(),
			showComments: () => this.settings.showComments,
			showResolved: () => this.settings.showResolved,
			sidebarOpen: () => this.sidebarOpen,
			openInSidebar: (id) => void this.revealComment(id),
			isMobile: () => Platform.isMobile,
		};
		this.readingManager = new ReadingMarginManager(readingDeps);
		this.scheduleReadingRefresh = debounce(() => this.readingManager?.refresh(), 50, true);

		// The "All discussions" sidebar panel (Notion-style). While it's open the
		// inline floating cards step aside; the in-text highlights stay.
		const sidebarDeps: SidebarDeps = {
			app: this.app,
			getAuthor: () => this.authorName(),
		};
		this.registerView(COMMENTS_VIEW_TYPE, (leaf) => new CommentsSidebarView(leaf, sidebarDeps));
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.showSidebar) void this.activateSidebar();
			else this.closeSidebar();
		});

		this.registerMarkdownPostProcessor((el, ctx) => {
			highlightPostProcessor(el, ctx);
			this.scheduleReadingRefresh();
		});
		// layout-change / active-leaf-change fire for panel creation/removal and tab
		// switching, so the inline column follows whether the sidebar owns comments.
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.syncSidebarOpen();
				this.scheduleReadingRefresh();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.syncSidebarOpen();
				this.scheduleReadingRefresh();
			}),
		);
		// resize fires while a dock collapses/expands — catches that case promptly
		// even if layout-change doesn't.
		this.registerEvent(this.app.workspace.on("resize", () => this.syncSidebarOpen()));
		this.registerEvent(this.app.vault.on("modify", () => this.scheduleReadingRefresh()));

		this.addCommand({
			id: "add-comment",
			name: "Add comment on selection",
			editorCallback: (editor) => this.startAddComment(editor),
		});

		this.addCommand({
			id: "toggle-comments",
			name: "Toggle comments",
			callback: () => void this.toggleComments(),
		});

		this.addCommand({
			id: "toggle-resolved",
			name: "Toggle resolved comments",
			callback: () => void this.toggleResolved(),
		});

		this.addCommand({
			id: "add-comment-reading",
			name: "Add comment on selection (reading view)",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || view.getMode() !== "preview") return false;
				if (!checking) this.startAddCommentReading(view);
				return true;
			},
		});

		this.addCommand({
			id: "open-comments-sidebar",
			name: "Open comments sidebar",
			callback: () => void this.setSidebarVisible(true),
		});

		this.addCommand({
			id: "toggle-comments-sidebar",
			name: "Toggle comments sidebar",
			callback: () => void this.setSidebarVisible(!this.isSidebarVisible()),
		});

		this.addCommand({
			id: "previous-comment",
			name: "Go to previous comment",
			// eslint-disable-next-line obsidianmd/commands/no-default-hotkeys -- User asked for Shift+Up/Down comment navigation.
			hotkeys: [{ modifiers: ["Shift"], key: "ArrowUp" }],
			callback: () => this.navigateComment("previous"),
		});

		this.addCommand({
			id: "next-comment",
			name: "Go to next comment",
			// eslint-disable-next-line obsidianmd/commands/no-default-hotkeys -- User asked for Shift+Up/Down comment navigation.
			hotkeys: [{ modifiers: ["Shift"], key: "ArrowDown" }],
			callback: () => this.navigateComment("next"),
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				if (!editor.getSelection()) return;
				menu.addItem((item) =>
					item
						.setTitle("Add comment")
						.setIcon("message-square")
						.onClick(() => this.startAddComment(editor)),
				);
			}),
		);

		this.addSettingTab(new DocCommentsSettingTab(this.app, this));
	}

	private startAddComment(editor: Editor): void {
		const view = editorView(editor);
		if (!view) {
			new Notice("Couldn't access the editor.");
			return;
		}
		const { from, to, empty } = view.state.selection.main;
		if (empty) {
			new Notice("Select some text to comment on.");
			return;
		}
		if (Platform.isMobile) {
			// No floating margin composer on mobile — collect the text in a modal,
			// then write through the same editor path so it's a single undo step.
			const quote = view.state.doc.sliceString(from, to);
			new CommentModal(this.app, quote, (text) => {
				const result = addComment(view, from, to, text, this.authorName());
				if (result.isErr()) new Notice(`Couldn't add the comment: ${result.error}`);
			}).open();
			return;
		}
		// Show a draft composer card in the margin (Notion-style) instead of a modal.
		view.dispatch({ effects: setDraft.of({ from, to }) });
	}

	/** Reading view has no editor surface, so map the rendered selection back to
	 *  source offsets (best-effort) and prompt for the comment text. */
	private startAddCommentReading(view: MarkdownView): void {
		const selection = activeWindow.getSelection();
		const selected = selection?.toString().trim() ?? "";
		if (!selection || selection.rangeCount === 0 || !selected) {
			new Notice("Select some text to comment on.");
			return;
		}
		const section = selection.anchorNode ? findSectionRange(selection.anchorNode) : null;
		if (!section) {
			new Notice("Couldn't locate that selection in the note.");
			return;
		}
		const idx = section.source.indexOf(selected);
		if (idx < 0) {
			new Notice("Couldn't map the selection to the Markdown — try plain text without formatting.");
			return;
		}
		const from = section.from + idx;
		const to = from + selected.length;
		if (Platform.isMobile) {
			// No margin composer on mobile — write straight to the file from a modal,
			// then refresh so the new highlight appears in the reading view.
			const file = view.file;
			if (!file) {
				new Notice("No file is open.");
				return;
			}
			new CommentModal(this.app, selected, (text) => {
				void this.insertReadingComment(file, from, to, text);
			}).open();
			return;
		}
		// Same inline draft composer as the editor (no modal).
		this.readingManager?.startDraft(view, from, to, selection.getRangeAt(0));
	}

	/** Mobile reading-view create: write to the file (no editor surface) and refresh.
	 *  insertCommentInFile already folds I/O + compute failures into the Result. */
	private async insertReadingComment(file: TFile, from: number, to: number, text: string): Promise<void> {
		(await insertCommentInFile(this.app, file, from, to, text, this.authorName())).match({
			ok: () => this.scheduleReadingRefresh(),
			err: (message) => new Notice(`Couldn't add the comment: ${message}`),
		});
	}

	private async toggleComments(): Promise<void> {
		this.settings.showComments = !this.settings.showComments;
		await this.saveSettings();
		this.refreshEditors();
		new Notice(this.settings.showComments ? "Comments shown" : "Comments hidden");
	}

	private async toggleResolved(): Promise<void> {
		this.settings.showResolved = !this.settings.showResolved;
		await this.saveSettings();
		this.refreshEditors();
		new Notice(this.settings.showResolved ? "Resolved comments shown" : "Resolved comments hidden");
	}

	async setSidebarVisible(show: boolean): Promise<void> {
		this.settings.showSidebar = show;
		await this.saveSettings();
		if (show) await this.activateSidebar();
		else this.closeSidebar();
		this.refreshEditors();
	}

	/** Force open editors + reading views (+ the sidebar) to re-evaluate live config. */
	refreshEditors(): void {
		this.app.workspace.getLeavesOfType("markdown").forEach((leaf: WorkspaceLeaf) => {
			editorViewFromLeaf(leaf)?.dispatch({});
		});
		this.scheduleReadingRefresh();
		this.sidebarView()?.requestRefresh();
	}

	/** Reveal the comments sidebar panel, creating it in the right split if needed. */
	private async activateSidebar(): Promise<void> {
		const { workspace } = this.app;
		const opened = await Result.tryPromise({
			try: async () => {
				let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(COMMENTS_VIEW_TYPE)[0] ?? null;
				if (!leaf) {
					leaf = workspace.getRightLeaf(false);
					if (!leaf) return;
					await leaf.setViewState({ type: COMMENTS_VIEW_TYPE, active: true });
				}
				await workspace.revealLeaf(leaf);
				this.syncSidebarOpen();
			},
			catch: (e) => (e instanceof Error ? e.message : "unknown error"),
		});
		if (opened.isErr()) new Notice(`Couldn't open the comments sidebar: ${opened.error}`);
	}

	private closeSidebar(): void {
		this.app.workspace.detachLeavesOfType(COMMENTS_VIEW_TYPE);
		this.syncSidebarOpen();
	}

	/** Open the sidebar and scroll it to a thread — the escape from a margin card too
	 *  tall to fit the column even when expanded. */
	private async revealComment(id: string): Promise<void> {
		await this.setSidebarVisible(true);
		await this.sidebarView()?.revealComment(id);
	}

	private navigateComment(direction: CommentDirection): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("Open a note to navigate comments.");
			return;
		}
		if (view.getMode() === "preview") {
			void this.navigateReadingComment(view, direction);
			return;
		}
		this.navigateEditorComment(view, direction);
	}

	private navigateEditorComment(view: MarkdownView, direction: CommentDirection): void {
		const cm = editorView(view.editor);
		if (!cm) return;
		const targets = commentTargets(cm.state.doc.toString());
		const target = pickTarget(targets, cm.state.selection.main.head, direction);
		if (!target) {
			new Notice("No comments in this note.");
			return;
		}
		cm.dispatch({
			selection: { anchor: target.pos },
			effects: EditorView.scrollIntoView(target.pos, { y: "center" }),
		});
		window.setTimeout(() => {
			const span = cm.contentDOM.querySelector(`.doc-comment-span[data-cid="${cssEscape(target.id)}"]`);
			if (span?.instanceOf(HTMLElement)) flashElement(span);
		}, 80);
	}

	private async navigateReadingComment(view: MarkdownView, direction: CommentDirection): Promise<void> {
		const file = view.file;
		if (!file) return;
		let doc: string;
		try {
			doc = await this.app.vault.read(file);
		} catch {
			new Notice("Couldn't read this note.");
			return;
		}
		const targets = commentTargets(doc);
		const current = sourceOffsetAtViewportCenter(view) ?? previewScrollOffset(view, doc);
		const target = pickTarget(targets, current, direction);
		if (!target) {
			new Notice("No comments in this note.");
			return;
		}
		scrollReadingTarget(view, doc, target);
	}

	/** The live sidebar view instance, if the panel is open. */
	private sidebarView(): CommentsSidebarView | null {
		const leaf = this.app.workspace.getLeavesOfType(COMMENTS_VIEW_TYPE)[0];
		return leaf?.view instanceof CommentsSidebarView ? leaf.view : null;
	}

	/** Recompute whether comments live in the sidebar and, when that changes,
	 *  refresh editors so the inline column steps aside / comes back. */
	private syncSidebarOpen(): void {
		const open = this.sidebarOwnsComments();
		if (open === this.sidebarOpen) return;
		this.sidebarOpen = open;
		this.refreshEditors();
	}

	private sidebarOwnsComments(): boolean {
		return this.settings.showSidebar && this.app.workspace.getLeavesOfType(COMMENTS_VIEW_TYPE).length > 0;
	}

	private isSidebarVisible(): boolean {
		const { workspace } = this.app;
		return workspace.getLeavesOfType(COMMENTS_VIEW_TYPE).some((leaf) => {
			// A collapsed dock flips `.collapsed` immediately; the DOM width animates,
			// so an offsetParent/size check alone lags a frame and misses the change.
			const root = leaf.getRoot();
			if (root === workspace.leftSplit && workspace.leftSplit.collapsed) return false;
			if (root === workspace.rightSplit && workspace.rightSplit.collapsed) return false;
			// Not in a collapsed dock — visible unless it's a hidden background tab.
			return leaf.view.containerEl.offsetParent !== null;
		});
	}

	onunload(): void {
		this.readingManager?.destroy();
	}

	private authorName(): string {
		return this.settings.author.trim() || "me";
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) as Partial<DocCommentsSettings> | null) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

const editorView = (editor: Editor): EditorView | null => {
	const cm = (editor as unknown as { cm?: unknown }).cm;
	return cm instanceof EditorView ? cm : null;
};

const editorViewFromLeaf = (leaf: WorkspaceLeaf): EditorView | null => {
	return leaf.view instanceof MarkdownView ? editorView(leaf.view.editor) : null;
};

type CommentDirection = "previous" | "next";
type NavTarget = { id: string; pos: number };

const commentTargets = (doc: string): NavTarget[] =>
	parseComments(doc)
		.map((c) => {
			const range = anchorRange(c);
			return range ? { id: c.id, pos: range.from } : null;
		})
		.filter((target): target is NavTarget => target !== null)
		.sort((a, b) => a.pos - b.pos);

const pickTarget = <T extends { pos: number }>(
	targets: T[],
	current: number,
	direction: CommentDirection,
): T | null => {
	if (targets.length === 0) return null;
	if (direction === "next") return targets.find((target) => target.pos > current + 1) ?? targets[0];
	for (let i = targets.length - 1; i >= 0; i--) {
		if (targets[i].pos < current - 1) return targets[i];
	}
	return targets[targets.length - 1];
};

const previewScrollOffset = (view: MarkdownView, doc: string): number => {
	const scroller = view.containerEl.querySelector(".markdown-preview-view");
	if (!(scroller instanceof HTMLElement)) return 0;
	const max = scroller.scrollHeight - scroller.clientHeight;
	return max > 0 ? Math.round((scroller.scrollTop / max) * doc.length) : 0;
};

const scrollReadingTarget = (view: MarkdownView, doc: string, target: NavTarget): void => {
	const span = view.containerEl.querySelector(`.doc-comment-span[data-cid="${cssEscape(target.id)}"]`);
	if (span instanceof HTMLElement) {
		span.scrollIntoView({ block: "center", behavior: "smooth" });
		flashElement(span);
		return;
	}

	const loc = offsetToLineCh(doc, target.pos);
	const scroller = view.containerEl.querySelector(".markdown-preview-view");
	const before = scroller instanceof HTMLElement ? scroller.scrollTop : null;
	view.setEphemeralState({ ...view.getEphemeralState(), line: loc.line });
	try {
		view.editor.scrollIntoView({ from: loc, to: loc }, true);
	} catch {
		// Preview mode may not expose a live editor facade.
	}
	if (scroller instanceof HTMLElement && before != null) {
		window.setTimeout(() => {
			if (Math.abs(scroller.scrollTop - before) > 2) return;
			const max = scroller.scrollHeight - scroller.clientHeight;
			if (max > 0) scroller.scrollTo({ top: (target.pos / Math.max(doc.length, 1)) * max, behavior: "smooth" });
		}, 40);
	}

	let flashed = false;
	const retry = (): void => {
		if (flashed) return;
		const rendered = view.containerEl.querySelector(`.doc-comment-span[data-cid="${cssEscape(target.id)}"]`);
		if (!(rendered instanceof HTMLElement)) return;
		rendered.scrollIntoView({ block: "center", behavior: "smooth" });
		flashElement(rendered);
		flashed = true;
	};
	window.setTimeout(retry, 220);
	window.setTimeout(retry, 650);
};

const flashElement = (el: HTMLElement): void => {
	el.addClass("dc-flash");
	window.setTimeout(() => el.removeClass("dc-flash"), 900);
};
