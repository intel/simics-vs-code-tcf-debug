import { defineConfig } from "vitepress";

// The Pages workflow sets DOCS_BASE: the site is served from /<repository>/ there.
const basePath = process.env.DOCS_BASE ?? "";

export default defineConfig({
    base: basePath.endsWith("/") ? basePath : `${basePath}/`,
    lang: "en-US",
    title: "Simics Target Debug",
    description: "Debug targets in VS Code through a TCF agent, such as the Simics TCF agent.",
    themeConfig: {
        search: { provider: "local" },
        nav: [
            { text: "Getting started", link: "/getting-started" },
            { text: "Debugging", link: "/debugging/call-stack" },
            { text: "Configuration", link: "/configuration/launch-configurations" },
        ],
        sidebar: [
            {
                text: "Introduction",
                items: [{ text: "Getting started", link: "/getting-started" }],
            },
            {
                text: "Debugging",
                items: [
                    { text: "Call stack", link: "/debugging/call-stack" },
                    { text: "Variables and expressions", link: "/debugging/variables" },
                    { text: "Stepping", link: "/debugging/stepping" },
                    { text: "Breakpoints", link: "/debugging/breakpoints" },
                    { text: "Disassembly", link: "/debugging/disassembly" },
                    { text: "Target Memory", link: "/debugging/target-memory" },
                    { text: "Simics console", link: "/debugging/simics-console" },
                    { text: "Snapshots", link: "/debugging/snapshots" },
                ],
            },
            {
                text: "Configuration",
                items: [
                    { text: "Launch configurations", link: "/configuration/launch-configurations" },
                    { text: "Symbol files", link: "/configuration/symbol-files" },
                    { text: "Path mapping", link: "/configuration/path-mapping" },
                    { text: "Selecting contexts", link: "/configuration/contexts" },
                    { text: "Settings", link: "/configuration/settings" },
                ],
            },
            {
                text: "Reference",
                items: [
                    { text: "TCF services", link: "/reference/tcf-services" },
                    { text: "Limitations", link: "/reference/limitations" },
                ],
            },
        ],
        socialLinks: [{ icon: "github", link: "https://github.com/intel/simics-vs-code-tcf-debug" }],
    },
});
