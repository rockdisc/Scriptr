import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("scriptrDesktop", {
    isDesktop: true,
    openMarkdown: () => ipcRenderer.invoke("desktop:open-markdown"),
    saveMarkdown: (path, markdown) => ipcRenderer.invoke("desktop:save-markdown", { path, markdown }),
    saveMarkdownAs: (defaultName, markdown) => ipcRenderer.invoke("desktop:save-markdown-as", { defaultName, markdown }),
    exportMarkdown: (defaultName, markdown) => ipcRenderer.invoke("desktop:export-markdown", { defaultName, markdown }),
});
//# sourceMappingURL=preload.js.map