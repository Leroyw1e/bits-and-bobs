import esbuild from "esbuild";
await esbuild.build({
  entryPoints: ["src/main.ts"], bundle: true, outfile: "main.js", format: "cjs", target: "es2020", platform: "browser",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"], minify: true, logLevel: "info",
});
