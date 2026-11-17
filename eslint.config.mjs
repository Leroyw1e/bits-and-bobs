import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	globalIgnores(["node_modules", "main.js", "esbuild.config.mjs", "web/dist"]),
	...obsidianmd.configs.recommended,
	{
		// the shared-spreadsheet web page runs in a normal browser, not in Obsidian
		files: ["web/**/*.ts"],
		rules: {
			"obsidianmd/prefer-active-doc": "off",
			"obsidianmd/prefer-create-el": "off",
			"no-restricted-globals": "off",
		},
	},
	{
		languageOptions: {
			parserOptions: { projectService: { allowDefaultProject: ["eslint.config.*"] } },
		},
	},
]);
