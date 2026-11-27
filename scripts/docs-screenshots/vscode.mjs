// Starts VS Code with the extension of this repository, for capture.mjs.
import { _electron as electron } from "playwright-core";
import * as fs from "node:fs";
import * as path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
/** Scratch folder for the profile of the VS Code that is started. */
const work = process.env.SHOTS_WORK;
/** The example workspace, at the path that the pictures show. */
export const workspace = process.env.SHOTS_WORKSPACE;

const SETTINGS = {
    "workbench.colorTheme": "Default Dark Modern",
    "workbench.startupEditor": "none",
    "workbench.tips.enabled": false,
    "workbench.enableExperiments": false,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "workbench.layoutControl.enabled": false,
    "workbench.navigationControl.enabled": false,
    "window.commandCenter": false,
    "window.titleBarStyle": "custom",
    "window.menuBarVisibility": "compact",
    "chat.commandCenter.enabled": false,
    "chat.disableAIFeatures": true,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.autoUpdate": false,
    "extensions.ignoreRecommendations": true,
    "security.workspace.trust.enabled": false,
    "editor.minimap.enabled": false,
    "editor.stickyScroll.enabled": false,
    "editor.fontSize": 13,
    "terminal.integrated.fontSize": 13,
    "debug.showInStatusBar": "never",
    "git.enabled": false,
    "scm.showChangesSummary": false,
    // The dots on the dividers between the parts hide a while after the pointer stops. Always shown, so no timing.
    "workbench.sash.autoHideGrippers": false,
    "window.zoomLevel": 0,
};

export async function launch({ width = 1280, height = 800, settings = {}, scale = 2 } = {}) {
    const userData = path.join(work, "user-data");
    fs.rmSync(userData, { recursive: true, force: true });
    fs.mkdirSync(path.join(userData, "User"), { recursive: true });
    fs.writeFileSync(
        path.join(userData, "User", "settings.json"),
        JSON.stringify({ ...SETTINGS, ...settings }, null, 2),
    );
    // A terminal of VS Code sets variables that make the new VS Code start as plain Node.js.
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith("VSCODE_") && k !== "ELECTRON_RUN_AS_NODE"),
    );
    const app = await electron.launch({
        executablePath: process.env.VSCODE_BIN,
        args: [
            "--no-sandbox",
            "--disable-gpu",
            `--force-device-scale-factor=${scale}`,
            "--skip-welcome",
            "--skip-release-notes",
            "--disable-workspace-trust",
            "--disable-updates",
            "--disable-telemetry",
            "--disable-extensions",
            `--extensionDevelopmentPath=${repo}`,
            `--user-data-dir=${userData}`,
            `--extensions-dir=${path.join(work, "extensions")}`,
            workspace,
        ],
        env,
        timeout: 60000,
    });
    const page = await app.firstWindow();
    await app.evaluate(
        ({ BrowserWindow }, size) => {
            const w = BrowserWindow.getAllWindows()[0];
            w.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
        },
        { width, height },
    );
    await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
    return { app, page };
}
