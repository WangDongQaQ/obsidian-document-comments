import { Facet } from "@codemirror/state";

export type CommentConfig = {
	/** Current author handle, read live so settings changes take effect. */
	author: () => string;
	/** Whether the margin column is shown at all (Notion-style toggle). */
	showComments: () => boolean;
	/** Whether resolved comments still show a card in the margin. */
	showResolved: () => boolean;
	/** Whether the comments sidebar panel is open. While it is, the inline
	 *  floating cards step aside (comments live in the panel) but the in-text
	 *  highlights stay. */
	sidebarOpen: () => boolean;
};

const DEFAULT: CommentConfig = {
	author: () => "me",
	showComments: () => true,
	showResolved: () => true,
	sidebarOpen: () => false,
};

export const commentConfig = Facet.define<CommentConfig, CommentConfig>({
	combine: (values) => values[0] ?? DEFAULT,
});
