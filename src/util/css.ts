/**
 * `CSS.escape` with a small fallback for runtimes that lack it. Only quotes and
 * backslashes are escaped in the fallback, which is all our `[data-cid="…"]`
 * attribute selectors need.
 */
export const cssEscape = (value: string): string => {
	const css = (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS;
	return css?.escape ? css.escape(value) : value.replace(/["\\]/g, "\\$&");
};
