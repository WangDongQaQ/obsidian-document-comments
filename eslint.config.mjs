import obsidianmd from "eslint-plugin-obsidianmd";

export default [
	{
		ignores: ["main.js", "node_modules/", "esbuild.config.mjs", "test/**"],
	},
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
];
