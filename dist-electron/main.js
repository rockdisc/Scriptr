import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 900,
        minWidth: 960,
        minHeight: 640,
        title: "Scriptr",
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            preload: path.join(__dirname, "preload.js"),
        },
    });
    if (isDev) {
        mainWindow.loadURL("http://127.0.0.1:5173");
        mainWindow.webContents.openDevTools({ mode: "detach" });
        return;
    }
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
}
function markdownFilters() {
    return [
        { name: "Markdown", extensions: ["md", "markdown", "txt"] },
        { name: "All Files", extensions: ["*"] },
    ];
}
function defaultMarkdownName(name) {
    const fallback = "untitled.md";
    if (!name)
        return fallback;
    return /\.(md|markdown|txt)$/i.test(name) ? name : `${name}.md`;
}
function fileNameFromPath(filePath) {
    return path.basename(filePath);
}
ipcMain.handle("desktop:open-markdown", async () => {
    const result = await dialog.showOpenDialog({
        title: "Open Markdown",
        properties: ["openFile"],
        filters: markdownFilters(),
    });
    if (result.canceled || result.filePaths.length === 0)
        return null;
    const filePath = result.filePaths[0];
    const markdown = await readFile(filePath, "utf8");
    return {
        fileName: fileNameFromPath(filePath),
        path: filePath,
        markdown,
    };
});
ipcMain.handle("desktop:save-markdown", async (_event, payload) => {
    if (!payload.path || typeof payload.markdown !== "string") {
        throw new Error("Missing path or Markdown content.");
    }
    await writeFile(payload.path, payload.markdown, "utf8");
});
ipcMain.handle("desktop:save-markdown-as", async (_event, payload) => {
    if (typeof payload.markdown !== "string") {
        throw new Error("Missing Markdown content.");
    }
    const result = await dialog.showSaveDialog({
        title: "Save Markdown",
        defaultPath: defaultMarkdownName(payload.defaultName),
        filters: markdownFilters(),
    });
    if (result.canceled || !result.filePath)
        return null;
    await writeFile(result.filePath, payload.markdown, "utf8");
    return {
        fileName: fileNameFromPath(result.filePath),
        path: result.filePath,
    };
});
ipcMain.handle("desktop:export-markdown", async (_event, payload) => {
    if (typeof payload.markdown !== "string") {
        throw new Error("Missing Markdown content.");
    }
    const result = await dialog.showSaveDialog({
        title: "Export Markdown",
        defaultPath: defaultMarkdownName(payload.defaultName),
        filters: markdownFilters(),
    });
    if (result.canceled || !result.filePath)
        return null;
    await writeFile(result.filePath, payload.markdown, "utf8");
    return {
        fileName: fileNameFromPath(result.filePath),
        path: result.filePath,
    };
});
app.whenReady().then(() => {
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        app.quit();
});
//# sourceMappingURL=main.js.map