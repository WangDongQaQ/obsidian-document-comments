import { Menu, setIcon } from "obsidian";
import { ParsedComment } from "../format/types";
import { isAnchored } from "../format/parse";

const QUICK_EMOJI = ["👍", "❤️", "😄", "🎉", "😮", "👀", "🙏"];

export type CardCallbacks = {
	getAuthor: () => string;
	onHover: (id: string, active: boolean) => void;
	onClickAnchor: (id: string) => void;
	/** The card changed height (open/close, edit, react) — re-run the stacking pass. */
	onResize: () => void;
	reply: (id: string, text: string) => void;
	setResolved: (id: string, resolved: boolean) => void;
	remove: (id: string) => void;
	editEntry: (id: string, index: number, text: string) => void;
	deleteEntry: (id: string, index: number) => void;
	toggleReaction: (id: string, emoji: string) => void;
};

/** A single margin comment card with the full Notion-style interaction set. */
export class Card {
	readonly el: HTMLElement;
	private comment: ParsedComment;
	private open = false;
	private editingIndex = -1;
	private draft = "";

	constructor(
		comment: ParsedComment,
		private cb: CardCallbacks,
	) {
		this.comment = comment;
		this.el = createDiv("doc-comment-card");
		this.el.addEventListener("mouseenter", () => this.cb.onHover(this.id, true));
		this.el.addEventListener("mouseleave", () => this.cb.onHover(this.id, false));
		this.el.addEventListener("mousedown", (e) => {
			const target = e.target as HTMLElement;
			if (target.closest("button, textarea, .dc-reaction, .dc-pop")) return;
			this.cb.onClickAnchor(this.id);
			this.setOpen(true);
		});
		this.render();
	}

	get id(): string {
		return this.comment.id;
	}

	get signature(): string {
		return cardSignature(this.comment);
	}

	update(comment: ParsedComment): void {
		this.comment = comment;
		this.editingIndex = -1; // any edit has now landed
		this.render();
	}

	setActive(active: boolean): void {
		this.el.toggleClass("is-active", active);
	}

	private setOpen(open: boolean): void {
		if (this.open === open) return;
		this.open = open;
		this.render();
		this.cb.onResize();
		if (open) {
			this.el.ownerDocument.addEventListener("mousedown", this.onDocMouseDown, true);
			this.focusComposer();
		} else {
			this.el.ownerDocument.removeEventListener("mousedown", this.onDocMouseDown, true);
		}
	}

	private onDocMouseDown = (e: MouseEvent): void => {
		if (!this.el.contains(e.target as Node)) this.setOpen(false);
	};

	private render(): void {
		const c = this.comment;
		this.el.empty();
		this.el.toggleClass("is-resolved", c.status === "resolved");
		this.el.toggleClass("is-open", this.open);

		const thread = this.el.createDiv("dc-thread");
		c.thread.forEach((entry, i) => this.renderEntry(thread, entry, i));

		if (this.open) this.renderComposer();
	}

	private renderEntry(
		parent: HTMLElement,
		entry: { author: string; timestamp?: string; text: string },
		i: number,
	): void {
		const row = parent.createDiv("dc-entry");

		const bar = row.createDiv("dc-entry__bar");
		this.iconButton(bar, "smile-plus", "React", (e) => this.openReactionPicker(e.currentTarget as HTMLElement));
		if (i === 0) {
			const resolved = this.comment.status === "resolved";
			this.iconButton(bar, resolved ? "rotate-ccw" : "check", resolved ? "Reopen" : "Resolve", () =>
				this.cb.setResolved(this.id, !resolved),
			);
		}
		this.iconButton(bar, "more-horizontal", "More", (e) => this.openMoreMenu(e, i));

		const head = row.createDiv("dc-entry__head");
		head.createSpan({ cls: "dc-entry__author", text: entry.author || "—" });
		const time = formatRelativeTime(entry.timestamp ?? (i === 0 ? this.comment.createdAt : undefined));
		if (time) head.createSpan({ cls: "dc-entry__time", text: time });

		if (this.editingIndex === i) {
			this.renderEditor(row, entry.text, i);
		} else {
			row.createDiv({ cls: "dc-entry__text", text: entry.text });
		}

		if (i === 0 && this.comment.reactions.length > 0) this.renderReactions(row);
	}

	private renderReactions(parent: HTMLElement): void {
		const me = this.cb.getAuthor();
		const wrap = parent.createDiv("dc-entry__reactions");
		for (const r of this.comment.reactions) {
			const chip = wrap.createEl("button", { cls: "dc-reaction" });
			chip.toggleClass("is-mine", r.authors.includes(me));
			chip.createSpan({ cls: "dc-reaction__emoji", text: r.emoji });
			chip.createSpan({ cls: "dc-reaction__count", text: String(r.authors.length) });
			chip.setAttribute("aria-label", r.authors.join(", "));
			chip.addEventListener("click", (e) => {
				e.stopPropagation();
				this.cb.toggleReaction(this.id, r.emoji);
			});
		}
	}

	private renderEditor(row: HTMLElement, text: string, index: number): void {
		const box = row.createDiv("dc-field dc-field--edit");
		const ta = box.createEl("textarea", { cls: "dc-field__input" });
		ta.value = text;
		autogrow(ta);
		ta.addEventListener("input", () => autogrow(ta));
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Escape") this.cancelEdit();
			else if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.commitEdit(index, ta.value);
			}
		});
		const actions = box.createDiv("dc-field__actions");
		this.roundButton(actions, "x", "Cancel", "dc-round--cancel", () => this.cancelEdit());
		this.roundButton(actions, "check", "Save", "dc-round--confirm", () => this.commitEdit(index, ta.value));
		window.setTimeout(() => {
			ta.focus();
			ta.setSelectionRange(ta.value.length, ta.value.length);
		}, 0);
	}

	private roundButton(parent: HTMLElement, icon: string, label: string, variant: string, onClick: () => void): void {
		const btn = parent.createEl("button", { cls: `dc-round ${variant}`, attr: { "aria-label": label } });
		setIcon(btn, icon);
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			onClick();
		});
	}

	private renderComposer(): void {
		const box = this.el.createDiv("dc-field dc-field--composer");
		const ta = box.createEl("textarea", {
			cls: "dc-field__input",
			attr: { placeholder: "Reply…", rows: "1" },
		});
		ta.value = this.draft;
		autogrow(ta);
		ta.addEventListener("input", () => {
			this.draft = ta.value;
			autogrow(ta);
		});
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.submitReply();
			}
		});
		const actions = box.createDiv("dc-field__actions");
		this.roundButton(actions, "arrow-up", "Send", "dc-round--confirm", () => this.submitReply());
	}

	private submitReply(): void {
		const ta = this.el.querySelector(".dc-field--composer .dc-field__input");
		if (!(ta instanceof HTMLTextAreaElement)) return;
		const text = ta.value.trim();
		if (!text) return;
		this.draft = "";
		this.cb.reply(this.id, text);
	}

	private commitEdit(index: number, value: string): void {
		const text = value.trim();
		if (text) this.cb.editEntry(this.id, index, text);
		else this.cancelEdit();
	}

	private cancelEdit(): void {
		this.editingIndex = -1;
		this.render();
		this.cb.onResize();
	}

	private startEdit(index: number): void {
		this.editingIndex = index;
		this.render();
		this.cb.onResize();
	}

	private openMoreMenu(e: MouseEvent, index: number): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Edit")
				.setIcon("pencil")
				.onClick(() => this.startEdit(index)),
		);
		menu.addItem((item) =>
			item
				.setTitle(index === 0 ? "Delete comment" : "Delete reply")
				.setIcon("trash")
				.onClick(() => (index === 0 ? this.cb.remove(this.id) : this.cb.deleteEntry(this.id, index))),
		);
		menu.showAtMouseEvent(e);
	}

	private openReactionPicker(anchor: HTMLElement): void {
		const doc = this.el.ownerDocument;
		doc.querySelectorAll(".dc-pop").forEach((p) => p.remove());
		const pop = doc.body.createDiv("dc-pop");
		for (const emoji of QUICK_EMOJI) {
			const btn = pop.createEl("button", { cls: "dc-pop__emoji", text: emoji });
			btn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				pop.remove();
				this.cb.toggleReaction(this.id, emoji);
			});
		}
		// Right-align the popover with the button so it grows left, not off-page.
		const rect = anchor.getBoundingClientRect();
		const left = Math.max(8, rect.right - pop.offsetWidth);
		pop.setCssStyles({ top: `${rect.bottom + 4}px`, left: `${left}px` });
		const close = (ev: MouseEvent) => {
			if (!pop.contains(ev.target as Node)) {
				pop.remove();
				doc.removeEventListener("mousedown", close, true);
			}
		};
		window.setTimeout(() => doc.addEventListener("mousedown", close, true), 0);
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void): void {
		const btn = parent.createEl("button", { cls: "dc-act", attr: { "aria-label": label } });
		setIcon(btn, icon);
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			onClick(e);
		});
	}

	private focusComposer(): void {
		window.setTimeout(() => {
			const ta = this.el.querySelector(".dc-composer__input");
			if (ta instanceof HTMLTextAreaElement) ta.focus();
		}, 0);
	}
}

/** Content signature, independent of document position — drives margin diffing. */
export const cardSignature = (c: ParsedComment): string => {
	return JSON.stringify([c.status, c.author, c.createdAt, c.thread, c.reactions, isAnchored(c)]);
};

const autogrow = (ta: HTMLTextAreaElement): void => {
	ta.setCssStyles({ height: "auto" });
	ta.setCssStyles({ height: `${ta.scrollHeight}px` });
};

const formatRelativeTime = (iso?: string): string => {
	if (!iso) return "";
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";
	const diff = Date.now() - then;
	const sec = Math.round(diff / 1000);
	if (sec < 45) return "just now";
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h`;
	const day = Math.round(hr / 24);
	if (day < 7) return `${day}d`;
	return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
