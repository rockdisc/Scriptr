import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("scriptrDesktop", {
  isDesktop: true,
  openMarkdown: () => ipcRenderer.invoke("desktop:open-markdown"),
  saveMarkdown: (path: string, markdown: string) =>
    ipcRenderer.invoke("desktop:save-markdown", { path, markdown }),
  saveMarkdownAs: (defaultName: string, markdown: string) =>
    ipcRenderer.invoke("desktop:save-markdown-as", { defaultName, markdown }),
  exportMarkdown: (defaultName: string, markdown: string) =>
    ipcRenderer.invoke("desktop:export-markdown", { defaultName, markdown }),
});
