import * as esbuild from "esbuild";
import * as fs from "fs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");
const tcfCli = process.argv.includes("--tcf-cli");
const outfile = process.env.TCF_OUT_FILE ?? "out/extension.js";

// The lines below are the begin and end patterns of the watch task in
// .vscode/tasks.json. The end line comes once all contexts are built.
let readyBuilds = 0;
let running = 0;
const watchPlugins = () =>
    watch
        ? [
              {
                  name: "watch-ready",
                  setup(build) {
                      let ready = false;
                      build.onStart(() => {
                          if (running++ === 0 && readyBuilds === (tests || tcfCli ? 1 : 3)) {
                              console.log("Build started.");
                          }
                      });
                      build.onEnd(() => {
                          running--;
                          if (!ready) {
                              ready = true;
                              readyBuilds++;
                          }
                          if (running === 0 && readyBuilds === (tests || tcfCli ? 1 : 3)) {
                              console.log("Build complete; watching for changes.");
                          }
                      });
                  },
              },
          ]
        : [];

const common = {
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    external: ["vscode"],
    // jsonc-parser's UMD build uses require() calls esbuild cannot follow.
    mainFields: ["module", "main"],
    logLevel: "info",
};

if (tests) {
    // Drop bundles of deleted tests, node --test would still run them.
    fs.rmSync("out/test", { recursive: true, force: true });
}

const tcfCliContexts = tcfCli
    ? [
          await esbuild.context({
              ...common,
              entryPoints: ["scripts/tcf-cli.ts"],
              plugins: watchPlugins(),
              outfile: "out/tcf-cli.js",
              sourcemap: true,
              logLevel: "warning",
          }),
      ]
    : [];

const contexts = tests
    ? [
          await esbuild.context({
              ...common,
              entryPoints: ["src/test/**/*.test.ts"],
              plugins: watchPlugins(),
              outdir: "out/test",
              sourcemap: true,
              logLevel: "warning",
          }),
      ]
    : tcfCli
      ? tcfCliContexts
      : [
            await esbuild.context({
                ...common,
                entryPoints: ["src/extension.ts"],
                plugins: watchPlugins(),
                outfile,
                sourcemap: !production,
                minify: production,
            }),
            // The Target Memory webview, also writes out/target-memory.css.
            await esbuild.context({
                entryPoints: ["src/webview/targetMemory/index.tsx"],
                plugins: watchPlugins(),
                bundle: true,
                format: "iife",
                platform: "browser",
                target: "es2022",
                outfile: "out/target-memory.js",
                jsx: "automatic",
                loader: { ".ttf": "dataurl" },
                define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
                sourcemap: !production,
                minify: production,
                logLevel: "info",
            }),
            // The launch settings form, also writes out/webview/launchSettings.css.
            await esbuild.context({
                ...common,
                format: "iife",
                platform: "browser",
                target: "es2022",
                plugins: watchPlugins(),
                entryPoints: [
                    "src/launchSettings/webview/launchSettings.ts",
                    "src/launchSettings/webview/launchSettings.css",
                ],
                outdir: "out/webview",
                loader: { ".ttf": "dataurl" },
                sourcemap: !production,
                minify: production,
            }),
        ];

if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
