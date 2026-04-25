import { markdown as markdownExtension } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import {
  ChangeEvent,
  FocusEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { commentDecorations } from "./commentDecorations";
import {
  deleteComment,
  exportCleanMarkdown,
  findNearestWordRange,
  getSpeechMetrics,
  insertSelectionComment,
  insertSelectionCommentByVisibleRange,
  parseComments,
  replaceComment,
} from "./markdownComments";
import { blockPlainText, createReaderBlocks, replaceBlockMarkdown, replaceBlockText } from "./markdownPreview";
import type {
  CommentCategory,
  BrowserDraft,
  FilePickerWindow,
  FileSystemFileHandleLike,
  ReaderBlock,
  ScriptrDesktopWindow,
  SpeechSnapshot,
} from "./types";

const starterMarkdown = `# My Script

Good evening everyone.

Today I want to talk about an idea that matters, why it matters, and what we can do next.
`;

type Settings = {
  wpm: number;
  showEditor: boolean;
  showReader: boolean;
  cleanComments: boolean;
  version: number;
};

const settingsVersion = 2;
const defaultSettings: Settings = {
  wpm: 140,
  showEditor: true,
  showReader: true,
  cleanComments: true,
  version: settingsVersion,
};

const settingsKey = "scriptr-settings";
const legacySettingsKey = "speech-writer-settings";
const snapshotKeyPrefix = "scriptr-snapshots";
const legacySnapshotKeyPrefix = "speech-writer-snapshots";
const draftHistoryKey = "scriptr-browser-drafts";
const splitRatioKey = "scriptr-split-ratio";
const commentCategories: CommentCategory[] = ["blocking", "voice", "change position", "note"];
const markdownEditorExtension = markdownExtension();

type RehearsalMode = "countdown" | "stopwatch";
type SidebarPanel = "comments" | "outline" | "snapshots" | "history";
type PrimaryView = "editor" | "preview" | "split";
type CommentFilter = "open" | "resolved" | "all";

type RehearsalState = {
  open: boolean;
  mode: RehearsalMode;
  targetMinutes: number;
  running: boolean;
  elapsedSeconds: number;
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(settingsKey) ?? localStorage.getItem(legacySettingsKey);
    if (!raw) return defaultSettings;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const migrated = {
      ...defaultSettings,
      ...parsed,
      version: settingsVersion,
    };

    if ((parsed.version ?? 0) < settingsVersion) {
      migrated.cleanComments = true;
    }

    return migrated;
  } catch {
    return defaultSettings;
  }
}

function getSnapshotsKey(fileName: string, documentHash: string) {
  return `${snapshotKeyPrefix}:${fileName}:${documentHash}`;
}

function loadSnapshots(key: string, _version: number): SpeechSnapshot[] {
  try {
    const legacyKey = key.replace(snapshotKeyPrefix, legacySnapshotKeyPrefix);
    const raw = localStorage.getItem(key) ?? localStorage.getItem(legacyKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSnapshots(key: string, snapshots: SpeechSnapshot[]) {
  localStorage.setItem(key, JSON.stringify(snapshots));
}

function loadBrowserDrafts(_version: number): BrowserDraft[] {
  try {
    const raw = localStorage.getItem(draftHistoryKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((draft): draft is BrowserDraft => Boolean(draft?.id && draft?.fileName && typeof draft?.markdown === "string"))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  } catch {
    return [];
  }
}

function saveBrowserDrafts(drafts: BrowserDraft[]) {
  localStorage.setItem(draftHistoryKey, JSON.stringify(drafts));
}

function hashDocument(markdown: string) {
  let hash = 2166136261;
  for (let index = 0; index < markdown.length; index += 1) {
    hash ^= markdown.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getDraftId(fileName: string, documentHash: string) {
  return `${fileName.trim().toLowerCase() || "untitled.md"}:${documentHash}`;
}

function categoryClass(category: CommentCategory) {
  return `category-${category.replace(/\s+/g, "-")}`;
}

function shortcutCategory(code: string): CommentCategory | null {
  if (code === "KeyC") return "note";
  if (code === "KeyB") return "blocking";
  if (code === "KeyV") return "voice";
  if (code === "KeyP") return "change position";
  return null;
}

function isFormField(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return Boolean(element.closest("input, textarea, select, [data-shortcut-lock]"));
}

export function App() {
  const topbarRef = useRef<HTMLElement>(null);
  const [markdown, setMarkdown] = useState(starterMarkdown);
  const [fileName, setFileName] = useState("untitled.md");
  const [documentHash, setDocumentHash] = useState(() => hashDocument(starterMarkdown));
  const [fileHandle, setFileHandle] = useState<FileSystemFileHandleLike | null>(null);
  const [desktopPath, setDesktopPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Ready. Your files stay on your device.");
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [selection, setSelection] = useState({ from: starterMarkdown.length, to: starterMarkdown.length });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rehearsalSetupOpen, setRehearsalSetupOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [activeSidebar, setActiveSidebar] = useState<SidebarPanel | null>(null);
  const [commentFilter, setCommentFilter] = useState<CommentFilter>("open");
  const [focusMode, setFocusMode] = useState(false);
  const [splitRatio, setSplitRatio] = useState(() => {
    const raw = localStorage.getItem(splitRatioKey);
    const parsed = raw ? Number(raw) : 0.56;
    return Number.isFinite(parsed) ? Math.min(0.75, Math.max(0.25, parsed)) : 0.56;
  });
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  const [draftVersion, setDraftVersion] = useState(0);
  const [rehearsal, setRehearsal] = useState<RehearsalState>({
    open: false,
    mode: "countdown",
    targetMinutes: 5,
    running: false,
    elapsedSeconds: 0,
  });
  const importRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const commentRefs = useRef<Record<string, HTMLElement | null>>({});
  const readerBlockRefs = useRef<Record<string, HTMLElement | null>>({});
  const splitDragRef = useRef<{ pointerId: number } | null>(null);
  const pendingFocusSource = useRef<number | null>(null);
  const readerCaretSource = useRef<number | null>(null);
  const readerSelectionSource = useRef<{ start: number; end: number } | null>(null);
  const lastCommentSource = useRef<"editor" | "preview" | null>(null);

  const comments = parseComments(markdown);
  const readerBlocks = createReaderBlocks(markdown);
  const metrics = getSpeechMetrics(markdown, settings.wpm);
  const outlineItems = readerBlocks
    .filter((block) => block.kind === "heading")
    .map((block) => ({
      id: block.id,
      level: block.level ?? 1,
      title: blockPlainText(block).trim() || "Untitled heading",
    }));
  const snapshotsKey = getSnapshotsKey(fileName, documentHash);
  const snapshots = loadSnapshots(snapshotsKey, snapshotVersion);
  const browserDrafts = loadBrowserDrafts(draftVersion);
  const desktop = (window as ScriptrDesktopWindow).scriptrDesktop;
  const supportsDirectFiles = "showOpenFilePicker" in window && "showSaveFilePicker" in window;
  const supportLabel = desktop?.isDesktop
    ? "Offline desktop file access"
    : supportsDirectFiles
    ? "Direct browser file access"
    : "Import/export fallback";
  const primaryView: PrimaryView = settings.showEditor && settings.showReader
    ? "split"
    : settings.showEditor
    ? "editor"
    : "preview";
  const visibleEditor = focusMode ? primaryView !== "preview" : settings.showEditor;
  const visibleReader = focusMode ? primaryView !== "editor" : settings.showReader;
  const visibleSidebar = focusMode ? null : activeSidebar;
  const splitGridColumns = `${Math.round(splitRatio * 1000)}fr 8px ${Math.round((1 - splitRatio) * 1000)}fr`;
  const contentStageStyle = visibleEditor && visibleReader
    ? { gridTemplateColumns: splitGridColumns }
    : undefined;
  const fileStem = fileName.replace(/\.(md|markdown|txt)$/i, "") || "untitled";
  const editorPanelLabel = `Markdown editor for ${fileName}`;
  const previewPanelLabel = "Live Preview editor";
  const utilitySummary = useMemo(() => ({
    comments: comments.length,
    outline: outlineItems.length,
    history: browserDrafts.length,
    snapshots: snapshots.length,
  }), [browserDrafts.length, comments.length, outlineItems.length, snapshots.length]);
  const visibleCommentCount = useMemo(
    () => comments.filter((comment) => comment.status === "open").length,
    [comments],
  );
  const filteredComments = useMemo(() => {
    if (commentFilter === "all") return comments;
    return comments.filter((comment) => comment.status === commentFilter);
  }, [commentFilter, comments]);
  const editorClickExtension = useMemo(
    () =>
      EditorView.domEventHandlers({
        click(event, view) {
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (position == null) return false;

          const comment = comments
            .filter(
              (item) =>
                item.anchorStart != null &&
                item.anchorEnd != null &&
                position >= item.anchorStart &&
                position <= item.anchorEnd,
            )
            .sort((a, b) => {
              const aSize = (a.anchorEnd ?? 0) - (a.anchorStart ?? 0);
              const bSize = (b.anchorEnd ?? 0) - (b.anchorStart ?? 0);
              return aSize - bSize;
            })[0];

          if (!comment) return false;

          setActiveCommentId(comment.id);
          setActiveSidebar("comments");
          if (commentFilter !== "all" && comment.status !== commentFilter) {
            setCommentFilter(comment.status);
          }

          return false;
        },
      }),
    [commentFilter, comments],
  );
  const editorExtensions = useMemo(
    () => [
      markdownEditorExtension,
      EditorView.lineWrapping,
      commentDecorations(activeCommentId, settings.cleanComments),
      editorClickExtension,
    ],
    [activeCommentId, editorClickExtension, settings.cleanComments],
  );

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.altKey || isFormField(event.target)) return;

      const category = shortcutCategory(event.code);
      if (!category) return;

      event.preventDefault();
      addContextComment(category);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [markdown, selection]);

  useEffect(() => {
    if (!activeCommentId) return;
    commentRefs.current[activeCommentId]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeCommentId]);

  useEffect(() => {
    localStorage.setItem(settingsKey, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(splitRatioKey, splitRatio.toFixed(3));
  }, [splitRatio]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const draft: BrowserDraft = {
        id: getDraftId(fileName, documentHash),
        fileName,
        markdown,
        updatedAt: new Date().toISOString(),
        wordCount: metrics.words,
        commentCount: comments.length,
      };
      const nextDrafts = [draft, ...loadBrowserDrafts(draftVersion).filter((item) => item.id !== draft.id)];
      saveBrowserDrafts(nextDrafts);
      setDraftVersion((version) => version + 1);
    }, 600);

    return () => window.clearTimeout(timeout);
  }, [markdown, fileName, documentHash, metrics.words, comments.length]);

  useEffect(() => {
    if (!rehearsal.open || !rehearsal.running) return;

    const timer = window.setInterval(() => {
      setRehearsal((current) => ({
        ...current,
        elapsedSeconds: current.elapsedSeconds + 1,
      }));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [rehearsal.open, rehearsal.running]);

  useEffect(() => {
    const target = pendingFocusSource.current;
    requestAnimationFrame(() => {
      if (target != null) {
        pendingFocusSource.current = null;
        focusReaderSurfaceAtSource(target);
        return;
      }

      if (lastCommentSource.current !== "preview" || !readerSelectionSource.current) {
        return;
      }

      const { start, end } = readerSelectionSource.current;
      setReaderSelectionBySource(start, end);
    });
  }, [markdown]);

  useLayoutEffect(() => {
    const element = topbarRef.current;
    if (!element) return;

    const root = document.documentElement;
    const updateTopbarOffset = () => {
      const rect = element.getBoundingClientRect();
      const topInset = rect.top;
      const gutter = 4;
      root.style.setProperty("--topbar-height", `${Math.ceil(rect.height)}px`);
      root.style.setProperty("--chrome-offset", `${Math.ceil(topInset + rect.height + gutter)}px`);
      root.style.setProperty("--panel-overlay-top", `${Math.ceil(topInset + rect.height + gutter)}px`);
    };

    updateTopbarOffset();
    const observer = new ResizeObserver(updateTopbarOffset);
    observer.observe(element);
    window.addEventListener("resize", updateTopbarOffset);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateTopbarOffset);
    };
  }, []);

  function updateMarkdown(value: string) {
    setMarkdown(value);
    setDirty(true);
  }

  function updateSettings(patch: Partial<Settings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  function setPrimaryView(view: PrimaryView) {
    if (view === "editor") {
      updateSettings({ showEditor: true, showReader: false });
      return;
    }

    if (view === "preview") {
      updateSettings({ showEditor: false, showReader: true });
      return;
    }

    updateSettings({ showEditor: true, showReader: true });
  }

  function toggleSidebar(panel: SidebarPanel) {
    setActiveSidebar((current) => (current === panel ? null : panel));
  }

  function renameFile(nextName: string) {
    const normalized = nextName.trim() || "untitled.md";
    if (normalized === fileName) return;
    setFileName(normalized);
    setDirty(true);
    setStatus(`Renamed document to ${normalized}.`);
  }

  async function openFile() {
    if (desktop?.isDesktop) {
      try {
        const file = await desktop.openMarkdown();
        if (!file) return;
        setMarkdown(file.markdown);
        setFileName(file.fileName);
        setDocumentHash(hashDocument(file.markdown));
        setFileHandle(null);
        setDesktopPath(file.path);
        setDirty(false);
        setStatus(`Opened ${file.fileName}.`);
      } catch {
        setStatus("Desktop open failed.");
      }
      return;
    }

    if (supportsDirectFiles) {
      try {
        const [handle] = await (window as FilePickerWindow).showOpenFilePicker?.({
          types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
          multiple: false,
        })!;
        const file = await handle.getFile();
        const text = await file.text();
        setMarkdown(text);
        setFileName(file.name);
        setDocumentHash(hashDocument(text));
        setFileHandle(handle);
        setDesktopPath(null);
        setDirty(false);
        setStatus(`Opened ${file.name}.`);
        return;
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setStatus("Direct open failed. Use import instead.");
      }
    }

    importRef.current?.click();
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    setMarkdown(text);
    setFileName(file.name);
    setDocumentHash(hashDocument(text));
    setFileHandle(null);
    setDesktopPath(null);
    setDirty(false);
    setStatus(`Imported ${file.name}. Use Export to save changes in this browser.`);
    event.target.value = "";
  }

  async function saveFile() {
    if (desktop?.isDesktop) {
      if (desktopPath) {
        try {
          await desktop.saveMarkdown(desktopPath, markdown);
          setDirty(false);
          setStatus(`Saved ${fileName}.`);
        } catch {
          setStatus("Desktop save failed.");
        }
        return;
      }

      await saveAsFile();
      return;
    }

    if (fileHandle) {
      const writable = await fileHandle.createWritable();
      await writable.write(markdown);
      await writable.close();
      setDirty(false);
      setStatus(`Saved ${fileName}.`);
      return;
    }

    await saveAsFile();
  }

  async function saveAsFile() {
    if (desktop?.isDesktop) {
      try {
        const result = await desktop.saveMarkdownAs(fileName, markdown);
        if (!result) return;
        setDesktopPath(result.path);
        setFileHandle(null);
        setFileName(result.fileName);
        setDirty(false);
        setStatus(`Saved ${result.fileName}.`);
      } catch {
        setStatus("Desktop save failed.");
      }
      return;
    }

    if (supportsDirectFiles) {
      try {
        const handle = await (window as FilePickerWindow).showSaveFilePicker?.({
          suggestedName: fileName.endsWith(".md") ? fileName : `${fileName}.md`,
          types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
        })!;
        const writable = await handle.createWritable();
        await writable.write(markdown);
        await writable.close();
        setFileHandle(handle);
        setDesktopPath(null);
        setFileName(handle.name);
        setDirty(false);
        setStatus(`Saved ${handle.name}.`);
        return;
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setStatus("Direct save failed. Downloading a Markdown copy instead.");
      }
    }

    downloadMarkdown();
  }

  function downloadMarkdown() {
    const downloadName = fileName.endsWith(".md") ? fileName : `${fileName}.md`;
    downloadText(markdown, downloadName);
    setDirty(false);
    setStatus(`Downloaded ${downloadName}.`);
  }

  function downloadCleanMarkdown() {
    const clean = exportCleanMarkdown(markdown);
    const downloadName = fileStem || "scriptr";
    if (desktop?.isDesktop) {
      desktop.exportMarkdown(`${downloadName}.clean.md`, `${clean}\n`).then((result) => {
        if (result) setStatus(`Exported clean Markdown to ${result.fileName}.`);
      }).catch(() => setStatus("Desktop clean export failed."));
      return;
    }
    downloadText(`${clean}\n`, `${downloadName}.clean.md`);
    setStatus("Exported clean Markdown without Scriptr comments.");
  }

  function downloadText(content: string, downloadName: string) {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = downloadName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function newSpeech() {
    if (dirty && !window.confirm("Discard unsaved changes and start a new document?")) return;
    setMarkdown(starterMarkdown);
    setFileName("untitled.md");
    setDocumentHash(hashDocument(starterMarkdown));
    setFileHandle(null);
    setDesktopPath(null);
    setDirty(false);
    setActiveCommentId(null);
    setStatus("Started a new document.");
  }

  function addContextComment(category: CommentCategory = "note") {
    const text = window.prompt("Comment");
    if (!text) return;

    const readerRange = getReaderActiveRange();
    if (readerRange) {
      const result = insertSelectionCommentByVisibleRange(
        markdown,
        readerRange.start,
        readerRange.end,
        text,
        category,
      );
      updateMarkdown(result.markdown);
      setActiveCommentId(result.id);
      setStatus(`Added ${category} Live Preview selection comment.`);
      return;
    }

    const selected =
      selection.from === selection.to
          ? findNearestWordRange(markdown, selection.to)
          : { start: selection.from, end: selection.to };

    if (!selected) {
      setStatus("No nearby word found to comment.");
      return;
    }

    const result = insertSelectionComment(markdown, selected.start, selected.end, text, category);
    updateMarkdown(result.markdown);
    setActiveCommentId(result.id);
    setStatus(`Added ${category} comment.`);
  }

  function editComment(id: string, text: string) {
    updateMarkdown(replaceComment(markdown, id, { text }));
  }

  function changeCommentCategory(id: string, category: CommentCategory) {
    updateMarkdown(replaceComment(markdown, id, { category }));
    setStatus(`Changed comment category to ${category}.`);
  }

  function toggleResolved(id: string) {
    const comment = comments.find((item) => item.id === id);
    if (!comment) return;
    updateMarkdown(
      replaceComment(markdown, id, {
        status: comment.status === "resolved" ? "open" : "resolved",
      }),
    );
  }

  function removeComment(id: string) {
    if (!window.confirm("Delete this comment and its selection markers?")) return;
    updateMarkdown(deleteComment(markdown, id));
    setActiveCommentId(null);
  }

  function focusReaderBlock(id: string) {
    if (!settings.showReader) {
      updateSettings({ showReader: true });
    }
    requestAnimationFrame(() => {
      const block = readerBlockRefs.current[id];
      block?.scrollIntoView({ behavior: "smooth", block: "center" });
      focusReaderSurfaceAtSource(Number(block?.dataset.textStart ?? 0));
    });
  }

  function createSnapshot() {
    const title = window.prompt("Snapshot title", `${fileName} ${new Date().toLocaleString()}`);
    if (!title) return;

    const next: SpeechSnapshot = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      timestamp: new Date().toISOString(),
      markdown,
      wordCount: metrics.words,
      commentCount: comments.length,
    };
    saveSnapshots(snapshotsKey, [next, ...snapshots]);
    setSnapshotVersion((version) => version + 1);
    setStatus(`Created snapshot "${title}".`);
  }

  function restoreSnapshot(snapshot: SpeechSnapshot) {
    if (dirty && !window.confirm("Restore this snapshot and replace current unsaved content?")) return;
    setMarkdown(snapshot.markdown);
    setFileHandle(null);
    setDesktopPath(null);
    setDirty(true);
    setActiveCommentId(null);
    setStatus(`Restored snapshot "${snapshot.title}".`);
  }

  function deleteSnapshot(id: string) {
    if (!window.confirm("Delete this local snapshot?")) return;
    saveSnapshots(snapshotsKey, snapshots.filter((snapshot) => snapshot.id !== id));
    setSnapshotVersion((version) => version + 1);
    setStatus("Deleted snapshot.");
  }

  function downloadSnapshot(snapshot: SpeechSnapshot) {
    const safeTitle = snapshot.title.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "snapshot";
    downloadText(snapshot.markdown, `${safeTitle}.md`);
    setStatus(`Downloaded snapshot "${snapshot.title}".`);
  }

  function restoreBrowserDraft(draft: BrowserDraft) {
    if (dirty && !window.confirm("Restore this browser draft and replace current unsaved content?")) return;
    setMarkdown(draft.markdown);
    setFileName(draft.fileName);
    setDocumentHash(draft.id.split(":").at(-1) || hashDocument(draft.markdown));
    setFileHandle(null);
    setDesktopPath(null);
    setDirty(true);
    setActiveCommentId(null);
    setStatus(`Restored browser draft for ${draft.fileName}.`);
  }

  function deleteBrowserDraft(id: string) {
    if (!window.confirm("Delete this browser draft?")) return;
    saveBrowserDrafts(browserDrafts.filter((draft) => draft.id !== id));
    setDraftVersion((version) => version + 1);
    setStatus("Deleted browser draft.");
  }

  function downloadBrowserDraft(draft: BrowserDraft) {
    const downloadName = draft.fileName.endsWith(".md") ? draft.fileName : `${draft.fileName}.md`;
    downloadText(draft.markdown, downloadName);
    setStatus(`Downloaded browser draft ${downloadName}.`);
  }

  function startRehearsal() {
    setRehearsal((current) => ({ ...current, open: true, running: true, elapsedSeconds: 0 }));
    setRehearsalSetupOpen(false);
  }

  function exitRehearsal() {
    blurActiveEditable();
    setRehearsal((current) => ({ ...current, open: false, running: false, elapsedSeconds: 0 }));
  }

  function toggleRehearsalPaused() {
    if (!rehearsal.running) {
      blurActiveEditable();
    }

    setRehearsal((current) => ({ ...current, running: !current.running }));
  }

  function blurActiveEditable() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.isContentEditable) {
      active.blur();
    }
  }

  function handlePreviewInput(block: ReaderBlock, element: HTMLElement, announce = false) {
    rememberPreviewSelection(block, element);
    const normalized = normalizeReaderText(element.innerText);
    if (normalized === blockPlainText(block)) return;
    updateMarkdown(replaceBlockText(markdown, block, normalized));
    if (announce) {
      setStatus("Updated Markdown from Live Preview.");
    }
  }

  function handleReaderKeyDown(event: ReactKeyboardEvent<HTMLElement>, block: ReaderBlock) {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
      return;
    }

    event.preventDefault();
    const element = event.currentTarget;
    rememberPreviewSelection(block, element);
    const value = normalizeReaderText(element.innerText);
    const offset = getCaretOffset(element);

    if (block.listMarker) {
      const result = insertListBreak(block, value, offset);
      updateMarkdown(result.markdown);
      pendingFocusSource.current = result.nextSource;
      setStatus("Inserted new list item from Live Preview.");
      return;
    }

    const before = value.slice(0, offset);
    const after = value.slice(offset);
    const replacement = `${before}\n\n${after}`;
    updateMarkdown(replaceBlockText(markdown, block, replacement));
    pendingFocusSource.current = block.textStart + before.length + 2;
    setStatus("Inserted new paragraph from Live Preview.");
  }

  function getReaderActiveRange() {
    const selectionObject = window.getSelection();
    if (!selectionObject || selectionObject.rangeCount === 0) {
      return null;
    }

    const root = previewRef.current;
    const range = selectionObject.getRangeAt(0);
    if (!root || !root.contains(range.commonAncestorContainer)) return null;

    const start = pointToSource(range.startContainer, range.startOffset);
    const end = pointToSource(range.endContainer, range.endOffset);
    const source = start ?? end;
    if (source == null) return null;

    lastCommentSource.current = "preview";
    if (selectionObject.isCollapsed || start === end) {
      return findNearestWordRange(markdown, source);
    }

    if (start == null || end == null) return null;

    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
    };
  }

  function pointToSource(node: Node, offset: number) {
    const element =
      node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null);
    const span = element?.closest<HTMLElement>("[data-source-start][data-source-end]");
    if (!span) return null;

    const start = Number(span.dataset.sourceStart);
    const end = Number(span.dataset.sourceEnd);
    const sourceOffset = Math.min(offset, end - start);
    return start + sourceOffset;
  }

  function getReaderCaretSource() {
    const selectionObject = window.getSelection();
    const root = previewRef.current;
    if (selectionObject && selectionObject.rangeCount > 0 && root) {
      const range = selectionObject.getRangeAt(0);
      if (root.contains(range.commonAncestorContainer)) {
        const source = pointToSource(range.startContainer, range.startOffset);
        if (source != null) return source;
      }
    }

    return readerCaretSource.current;
  }

  function rememberPreviewSelection(block?: ReaderBlock, element?: HTMLElement) {
    const selectionObject = window.getSelection();
    const root = previewRef.current;
    if (!selectionObject || selectionObject.rangeCount === 0 || !root) return;

    const range = selectionObject.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;

    const startBlock = getSelectionReaderBlock(range.startContainer) ?? block;
    const endBlock = getSelectionReaderBlock(range.endContainer) ?? block;
    if (!startBlock || !endBlock) return;

    const startElement = readerBlockRefs.current[startBlock.id] ?? element;
    const endElement = readerBlockRefs.current[endBlock.id] ?? element;
    if (!startElement || !endElement) return;

    const startOffset = getCaretOffsetWithin(startElement, range.startContainer, range.startOffset);
    const endOffset = getCaretOffsetWithin(endElement, range.endContainer, range.endOffset);
    const start = startBlock.textStart + startOffset;
    const end = endBlock.textStart + endOffset;

    readerCaretSource.current = end;
    readerSelectionSource.current = { start, end };
    lastCommentSource.current = "preview";
  }

  function renderReaderDocument() {
    return (
      <article
        ref={previewRef}
        className="speech-preview"
        aria-label={previewPanelLabel}
      >
        {readerBlocks.map((block) => renderReaderBlockNode(block))}
      </article>
    );
  }

  function renderReaderBlockNode(block: ReaderBlock) {
    if (block.kind === "heading") {
      return renderHeading(block, renderInlines(block));
    }

    if (block.kind === "unordered-list" || block.kind === "ordered-list") {
      const List = block.kind === "ordered-list" ? "ol" : "ul";
      return (
        <List key={block.id} className="reader-list" data-list-id={block.id}>
          {block.listItems?.map((item) => (
            <li
              key={item.id}
              ref={(element) => {
                readerBlockRefs.current[item.id] = element;
              }}
              className="reader-node reader-list-item"
              data-block-id={item.id}
              data-text-start={item.textStart}
              contentEditable
              suppressContentEditableWarning
              onFocus={(event) => rememberPreviewSelection(item, event.currentTarget)}
              onMouseUp={(event) => rememberPreviewSelection(item, event.currentTarget)}
              onKeyUp={(event) => rememberPreviewSelection(item, event.currentTarget)}
              onInput={(event: FormEvent<HTMLElement>) => handlePreviewInput(item, event.currentTarget)}
              onBlur={(event) => handlePreviewInput(item, event.currentTarget, true)}
              onKeyDown={(event) => handleReaderKeyDown(event, item)}
            >
              {renderInlines(item)}
            </li>
          ))}
        </List>
      );
    }

    return (
      <p
        key={block.id}
        ref={(element) => {
          readerBlockRefs.current[block.id] = element;
        }}
        className="reader-node"
        data-block-id={block.id}
        data-text-start={block.textStart}
        contentEditable
        suppressContentEditableWarning
        onFocus={(event) => rememberPreviewSelection(block, event.currentTarget)}
        onMouseUp={(event) => rememberPreviewSelection(block, event.currentTarget)}
        onKeyUp={(event) => rememberPreviewSelection(block, event.currentTarget)}
        onInput={(event: FormEvent<HTMLElement>) => handlePreviewInput(block, event.currentTarget)}
        onBlur={(event) => handlePreviewInput(block, event.currentTarget, true)}
        onKeyDown={(event) => handleReaderKeyDown(event, block)}
      >
        {renderInlines(block)}
      </p>
    );
  }

  function renderSidebarPanel() {
    if (visibleSidebar === "outline") {
      return (
        <aside className="utility-panel" aria-label="Outline">
          <div className="panel-title">
            <span>Outline</span>
            <button className="ghost-button" onClick={() => setActiveSidebar(null)}>Close</button>
          </div>
          {outlineItems.length === 0 ? (
            <p className="empty">No headings yet. Add #, ##, or ### headings to build an outline.</p>
          ) : (
            <nav className="outline-list">
              {outlineItems.map((item) => (
                <button
                  key={item.id}
                  className={`outline-item outline-level-${Math.min(3, item.level)}`}
                  onClick={() => focusReaderBlock(item.id)}
                >
                  {item.title}
                </button>
              ))}
            </nav>
          )}
        </aside>
      );
    }

    if (visibleSidebar === "comments") {
      return (
        <aside className="utility-panel comments-panel" aria-label="Comments">
          <div className="panel-title">
            <span>Comments</span>
            <button className="ghost-button" onClick={() => setActiveSidebar(null)}>Close</button>
          </div>
          <div className="comment-filter" aria-label="Comment filter">
            {(["open", "resolved", "all"] as CommentFilter[]).map((filter) => (
              <button
                key={filter}
                className={commentFilter === filter ? "ghost-button active" : "ghost-button"}
                onClick={() => setCommentFilter(filter)}
              >
                {filter[0].toUpperCase() + filter.slice(1)}
              </button>
            ))}
          </div>
          {comments.length === 0 ? (
            <p className="empty">No comments yet. Select text or place your cursor near a word, then press Option/Alt-C.</p>
          ) : filteredComments.length === 0 ? (
            <p className="empty">No {commentFilter} comments.</p>
          ) : (
            filteredComments.map((comment) => (
              <article
                key={comment.id}
                ref={(element) => {
                  commentRefs.current[comment.id] = element;
                }}
                className={`comment-card ${comment.status} ${categoryClass(comment.category)} ${
                  activeCommentId === comment.id ? "active" : ""
                }`}
                onClick={() => setActiveCommentId(comment.id)}
              >
                <div className="comment-meta">
                  <span>{comment.anchor}</span>
                  <span className={`category-chip ${categoryClass(comment.category)}`}>{comment.category}</span>
                  <span>{comment.status}</span>
                </div>
                <label className="category-select">
                  Category
                  <select
                    value={comment.category}
                    onChange={(event) => changeCommentCategory(comment.id, event.target.value as CommentCategory)}
                  >
                    {commentCategories.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </label>
                <textarea
                  value={comment.text}
                  onChange={(event) => editComment(comment.id, event.target.value)}
                  aria-label={`Edit comment ${comment.id}`}
                />
                <div className="comment-actions">
                  <button onClick={() => toggleResolved(comment.id)}>
                    {comment.status === "resolved" ? "Reopen" : "Resolve"}
                  </button>
                  <button className="danger" onClick={() => removeComment(comment.id)}>
                    Delete
                  </button>
                </div>
              </article>
            ))
          )}
        </aside>
      );
    }

    if (visibleSidebar === "snapshots") {
      return (
        <aside className="utility-panel snapshots-panel" aria-label="Snapshots">
          <div className="panel-title">
            <span>Snapshots</span>
            <button className="ghost-button" onClick={() => setActiveSidebar(null)}>Close</button>
          </div>
          <div className="snapshot-list">
            <button onClick={createSnapshot}>Create Snapshot</button>
            {snapshots.length === 0 ? (
              <p className="empty">No local snapshots for this file/version yet.</p>
            ) : (
              snapshots.map((snapshot) => (
                <article key={snapshot.id} className="snapshot-card">
                  <div>
                    <strong>{snapshot.title}</strong>
                    <span>
                      {new Date(snapshot.timestamp).toLocaleString()} - {snapshot.wordCount} words -{" "}
                      {snapshot.commentCount} comments
                    </span>
                  </div>
                  <div className="snapshot-actions">
                    <button onClick={() => restoreSnapshot(snapshot)}>Restore</button>
                    <button onClick={() => downloadSnapshot(snapshot)}>Download</button>
                    <button className="danger" onClick={() => deleteSnapshot(snapshot.id)}>Delete</button>
                  </div>
                </article>
              ))
            )}
          </div>
        </aside>
      );
    }

    if (visibleSidebar === "history") {
      return (
        <aside className="utility-panel history-panel" aria-label="Browser autosave history">
          <div className="panel-title">
            <span>History</span>
            <button className="ghost-button" onClick={() => setActiveSidebar(null)}>Close</button>
          </div>
          <div className="snapshot-list">
            {browserDrafts.length === 0 ? (
              <p className="empty">No browser autosaves yet. Edits are saved here automatically.</p>
            ) : (
              browserDrafts.map((draft) => (
                <article key={draft.id} className="snapshot-card">
                  <div>
                    <strong>{draft.fileName}</strong>
                    <span>
                      {new Date(draft.updatedAt).toLocaleString()} - {draft.wordCount} words -{" "}
                      {draft.commentCount} comments
                    </span>
                  </div>
                  <div className="snapshot-actions">
                    <button onClick={() => restoreBrowserDraft(draft)}>Restore</button>
                    <button onClick={() => downloadBrowserDraft(draft)}>Download</button>
                    <button className="danger" onClick={() => deleteBrowserDraft(draft.id)}>Delete</button>
                  </div>
                </article>
              ))
            )}
          </div>
        </aside>
      );
    }

    return null;
  }

  function renderHeading(
    block: ReaderBlock,
    children: ReactNode,
  ) {
    const props = {
      key: block.id,
      className: "reader-node",
      "data-block-id": block.id,
      "data-text-start": block.textStart,
      ref: (element: HTMLElement | null) => {
        readerBlockRefs.current[block.id] = element;
      },
      contentEditable: true,
      suppressContentEditableWarning: true,
      onFocus: (event: FocusEvent<HTMLElement>) => rememberPreviewSelection(block, event.currentTarget),
      onMouseUp: (event: ReactMouseEvent<HTMLElement>) => rememberPreviewSelection(block, event.currentTarget),
      onKeyUp: (event: ReactKeyboardEvent<HTMLElement>) => rememberPreviewSelection(block, event.currentTarget),
      onInput: (event: FormEvent<HTMLElement>) => handlePreviewInput(block, event.currentTarget),
      onBlur: (event: FocusEvent<HTMLElement>) => handlePreviewInput(block, event.currentTarget, true),
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => handleReaderKeyDown(event, block),
    };

    switch (block.level) {
      case 2:
        return <h2 {...props}>{children}</h2>;
      case 3:
        return <h3 {...props}>{children}</h3>;
      case 4:
        return <h4 {...props}>{children}</h4>;
      case 5:
        return <h5 {...props}>{children}</h5>;
      case 6:
        return <h6 {...props}>{children}</h6>;
      default:
        return <h1 {...props}>{children}</h1>;
    }
  }

  function renderInlines(block: ReaderBlock) {
    return block.inlines.map((inline, index) => (
      <span
        key={`${inline.start}-${inline.end}-${index}`}
        className={`reader-inline ${inline.commentId ? `comment-highlight ${categoryClass(inline.commentCategory ?? "note")}` : ""} ${
          inline.commentId === activeCommentId ? "active-highlight" : ""
        }`}
        data-source-start={inline.start}
        data-source-end={inline.end}
        data-comment-id={inline.commentId}
        onClick={(event) => {
          const id = event.currentTarget.dataset.commentId;
          if (!id) return;
          const comment = comments.find((item) => item.id === id);
          setActiveCommentId(id);
          setActiveSidebar("comments");
          if (comment && commentFilter !== "all" && comment.status !== commentFilter) {
            setCommentFilter(comment.status);
          }
        }}
      >
        {inline.text}
      </span>
    ));
  }

  function normalizeReaderText(value: string) {
    return value.replace(/\u00a0/g, " ").replace(/\n+$/g, "");
  }

  function getCaretOffset(element: HTMLElement) {
    const selectionObject = window.getSelection();
    if (!selectionObject || selectionObject.rangeCount === 0) return element.innerText.length;

    const range = selectionObject.getRangeAt(0);
    if (!element.contains(range.startContainer)) return element.innerText.length;

    const prefix = range.cloneRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(range.startContainer, range.startOffset);
    return prefix.toString().length;
  }

  function getCaretOffsetWithin(element: HTMLElement, node: Node, offset: number) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.setEnd(node, offset);
    return range.toString().length;
  }

  function flattenReaderBlocks(blocks: ReaderBlock[]) {
    return blocks.flatMap((block) => block.listItems?.length ? block.listItems : [block]);
  }

  function getSelectionReaderBlock(node: Node | null) {
    const element =
      node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null);
    const blockElement = element?.closest<HTMLElement>("[data-block-id]");
    const blockId = blockElement?.dataset.blockId;
    if (!blockId) return null;
    return flattenReaderBlocks(readerBlocks).find((block) => block.id === blockId) ?? null;
  }

  function focusReaderSurfaceAtSource(source: number) {
    setReaderSelectionBySource(source, source);
  }

  function setReaderSelectionBySource(start: number, end: number) {
    const root = previewRef.current;
    if (!root) return;

    const startPoint = findReaderPoint(start);
    const endPoint = findReaderPoint(end);
    if (!startPoint || !endPoint) return;

    const selectionObject = window.getSelection();
    if (!selectionObject) return;

    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    const focusElement = startPoint.node instanceof HTMLElement
      ? startPoint.node.closest<HTMLElement>("[contenteditable='true']")
      : startPoint.node.parentElement?.closest<HTMLElement>("[contenteditable='true']");
    focusElement?.focus();
    selectionObject.removeAllRanges();
    selectionObject.addRange(range);
    readerCaretSource.current = end;
    readerSelectionSource.current = { start, end };
  }

  function insertListBreak(block: ReaderBlock, value: string, offset: number) {
    const parent = readerBlocks.find((candidate) => candidate.listItems?.some((item) => item.id === block.id));
    if (!parent?.listItems) {
      const before = value.slice(0, offset);
      const after = value.slice(offset);
      const replacement = `${before}\n${block.listMarker}${after}`;
      return {
        markdown: replaceBlockText(markdown, block, replacement),
        nextSource: block.textStart + before.length + (block.listMarker?.length ?? 0) + 1,
      };
    }

    const index = parent.listItems.findIndex((item) => item.id === block.id);
    const currentRaw = markdown.slice(block.textStart, block.textEnd);
    const rawSplitOffset = Math.max(0, Math.min(currentRaw.length, sourceOffsetForVisibleOffset(block, offset) - block.textStart));
    const beforeRaw = currentRaw.slice(0, rawSplitOffset);
    const afterRaw = currentRaw.slice(rawSplitOffset);
    const rawBodies = parent.listItems.map((item) => markdown.slice(item.textStart, item.textEnd));
    rawBodies.splice(index, 1, beforeRaw);
    rawBodies.splice(index + 1, 0, afterRaw);

    let cursor = 0;
    let nextSource = parent.start;
    const raw = rawBodies.map((body, itemIndex) => {
      const marker = parent.kind === "ordered-list" ? `${itemIndex + 1}. ` : parent.listItems?.[Math.min(itemIndex, parent.listItems.length - 1)]?.listMarker ?? block.listMarker ?? "- ";
      if (itemIndex === index + 1) {
        nextSource = parent.start + cursor + marker.length;
      }
      const line = `${marker}${body}`;
      cursor += line.length + 1;
      return line;
    }).join("\n");

    return {
      markdown: replaceBlockMarkdown(markdown, parent, raw),
      nextSource,
    };
  }

  function sourceOffsetForVisibleOffset(block: ReaderBlock, visibleOffset: number) {
    let remaining = visibleOffset;
    for (const inline of block.inlines) {
      if (remaining <= inline.text.length) {
        return inline.start + Math.min(remaining, inline.end - inline.start);
      }
      remaining -= inline.text.length;
    }
    return block.textEnd;
  }

  function findReaderPoint(source: number) {
    const root = previewRef.current;
    if (!root) return null;

    const spans = root.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]");
    for (const span of spans) {
      const start = Number(span.dataset.sourceStart);
      const end = Number(span.dataset.sourceEnd);
      if (source < start || source > end) continue;
      const textNode = span.firstChild;
      if (!textNode) return { node: span, offset: 0 };
      return { node: textNode, offset: Math.min(source - start, textNode.textContent?.length ?? 0) };
    }

    const lastSpan = spans.item(spans.length - 1);
    if (!lastSpan) return null;
    const textNode = lastSpan.firstChild;
    const fallbackOffset = textNode?.textContent?.length ?? lastSpan.textContent?.length ?? 0;
    return { node: textNode ?? lastSpan, offset: fallbackOffset };
  }

  function renderRehearsalBlock(block: ReaderBlock) {
    if (block.kind === "heading") {
      const text = blockPlainText(block);
      switch (block.level) {
        case 2:
          return <h2 key={block.id}>{text}</h2>;
        case 3:
          return <h3 key={block.id}>{text}</h3>;
        case 4:
          return <h4 key={block.id}>{text}</h4>;
        case 5:
          return <h5 key={block.id}>{text}</h5>;
        case 6:
          return <h6 key={block.id}>{text}</h6>;
        default:
          return <h1 key={block.id}>{text}</h1>;
      }
    }

    if (block.kind === "unordered-list" || block.kind === "ordered-list") {
      const List = block.kind === "ordered-list" ? "ol" : "ul";
      return (
        <List key={block.id}>
          {block.listItems?.map((item) => <li key={item.id}>{blockPlainText(item)}</li>)}
        </List>
      );
    }

    return <p key={block.id}>{blockPlainText(block)}</p>;
  }

  const targetSeconds = Math.max(1, Math.round(rehearsal.targetMinutes * 60));
  const remainingSeconds = targetSeconds - rehearsal.elapsedSeconds;
  const rehearsalWarning =
    rehearsal.mode === "countdown" && remainingSeconds <= 60 && remainingSeconds > 30
      ? "1:00 remaining"
      : rehearsal.mode === "countdown" && remainingSeconds <= 30 && remainingSeconds > 0
        ? "0:30 remaining"
        : rehearsal.mode === "countdown" && remainingSeconds <= 0
          ? "Target time reached"
          : "";

  if (rehearsal.open) {
    return (
      <main className="rehearsal-shell">
        <div className="rehearsal-topbar">
          <strong>Rehearsal Mode</strong>
          <span>
            {rehearsal.running
              ? rehearsal.mode === "countdown"
                ? "Countdown running with hidden timer"
                : "Stopwatch running with hidden timer"
              : "Paused for editing"}
          </span>
          <div className="rehearsal-controls">
            <button onClick={toggleRehearsalPaused}>
              {rehearsal.running ? "Pause" : "Resume"}
            </button>
            <button onClick={exitRehearsal}>Exit</button>
          </div>
        </div>
        {rehearsalWarning && <div className="rehearsal-warning">{rehearsalWarning}</div>}
        <article
          className={`rehearsal-reader ${rehearsal.running ? "" : "rehearsal-editor"}`}
          aria-label={rehearsal.running ? "Rehearsal live preview" : "Paused rehearsal editor"}
        >
          {rehearsal.running ? readerBlocks.map(renderRehearsalBlock) : renderReaderDocument()}
        </article>
      </main>
    );
  }

  return (
    <main className={`app-shell ${focusMode ? "focus-mode" : ""}`}>
      <header ref={topbarRef} className="topbar">
        <div className="topbar-brand">
          <div>
            <p className="eyebrow">Local-first Markdown writing</p>
            <input
              className="file-name-input"
              aria-label="Current file name"
              value={fileName}
              onChange={(event) => renameFile(event.target.value)}
            />
          </div>
          <div className="topbar-meta">
            <span className="file-chip">{dirty ? "unsaved" : "saved"}</span>
            <span>{metrics.words} words</span>
            <span>{metrics.label} at {settings.wpm} wpm</span>
            <span>{supportLabel}</span>
          </div>
        </div>

        <div className="topbar-controls">
          <div className="toolbar-group" aria-label="Primary actions">
            <button onClick={newSpeech}>New</button>
            <button onClick={openFile}>Open</button>
            <button onClick={saveFile}>Save</button>
            <button onClick={saveAsFile}>Export</button>
            <button onClick={downloadCleanMarkdown}>Clean Export</button>
          </div>

          <div className="toolbar-group toolbar-group-compact" aria-label="View controls">
            <button
              className={primaryView === "editor" ? "ghost-button active" : "ghost-button"}
              onClick={() => setPrimaryView("editor")}
            >
              Editor
            </button>
            <button
              className={primaryView === "split" ? "ghost-button active" : "ghost-button"}
              onClick={() => setPrimaryView("split")}
            >
              Split
            </button>
            <button
              className={primaryView === "preview" ? "ghost-button active" : "ghost-button"}
              onClick={() => setPrimaryView("preview")}
            >
              Live Preview
            </button>
            <button
              className={focusMode ? "ghost-button active" : "ghost-button"}
              onClick={() => setFocusMode((current) => !current)}
            >
              Focus
            </button>
          </div>

          <div className="toolbar-group toolbar-group-compact" aria-label="Utility actions">
            <button
              onClick={() => addContextComment()}
              title="Shortcuts: Option/Alt-C note, B blocking, V voice, P position"
            >
              Comment ({utilitySummary.comments}) <kbd>⌥C</kbd>
            </button>
            <button
              className={visibleSidebar === "comments" ? "ghost-button active" : "ghost-button"}
              onClick={() => toggleSidebar("comments")}
            >
              Comments ({visibleCommentCount})
            </button>
            <button
              className={settings.cleanComments ? "ghost-button active" : "ghost-button"}
              onClick={() => updateSettings({ cleanComments: !settings.cleanComments })}
            >
              Clean comments
            </button>
            <button
              className={visibleSidebar === "outline" ? "ghost-button active" : "ghost-button"}
              onClick={() => toggleSidebar("outline")}
            >
              Outline ({utilitySummary.outline})
            </button>
            <button
              className={visibleSidebar === "history" ? "ghost-button active" : "ghost-button"}
              onClick={() => toggleSidebar("history")}
            >
              History ({utilitySummary.history})
            </button>
            <button
              className={visibleSidebar === "snapshots" ? "ghost-button active" : "ghost-button"}
              onClick={() => toggleSidebar("snapshots")}
            >
              Snapshots ({utilitySummary.snapshots})
            </button>
            <button className={settingsOpen ? "ghost-button active" : "ghost-button"} onClick={() => setSettingsOpen((open) => !open)}>Settings</button>
            <button className={rehearsalSetupOpen ? "ghost-button active" : "ghost-button"} onClick={() => setRehearsalSetupOpen((open) => !open)}>Rehearsal</button>
          </div>
        </div>

        <div className="status-line" aria-live="polite">{status}</div>
        <input ref={importRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={importFile} hidden />
      </header>

      {settingsOpen && (
        <section className="settings-panel" aria-label="Settings">
          <label>
            WPM
            <input
              type="number"
              min="1"
              max="400"
              value={settings.wpm}
              onChange={(event) => updateSettings({ wpm: Number(event.target.value) || 140 })}
            />
          </label>
          <label>
            Default view
            <select value={primaryView} onChange={(event) => setPrimaryView(event.target.value as PrimaryView)}>
              <option value="editor">Editor</option>
              <option value="split">Split</option>
              <option value="preview">Live Preview</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={focusMode}
              onChange={(event) => setFocusMode(event.target.checked)}
            />
            Focus mode
          </label>
          <label>
            Utility panel
            <select value={activeSidebar ?? "none"} onChange={(event) => setActiveSidebar(event.target.value === "none" ? null : event.target.value as SidebarPanel)}>
              <option value="none">Hidden</option>
              <option value="comments">Comments</option>
              <option value="outline">Outline</option>
              <option value="history">History</option>
              <option value="snapshots">Snapshots</option>
            </select>
          </label>
        </section>
      )}

      {rehearsalSetupOpen && (
        <section className="settings-panel" aria-label="Rehearsal setup">
          <label>
            Mode
            <select
              value={rehearsal.mode}
              onChange={(event) =>
                setRehearsal((current) => ({
                  ...current,
                  mode: event.target.value as RehearsalMode,
                }))
              }
            >
              <option value="countdown">Countdown</option>
              <option value="stopwatch">Stopwatch</option>
            </select>
          </label>
          {rehearsal.mode === "countdown" && (
            <label>
              Target minutes
              <input
                type="number"
                min="1"
                max="240"
                value={rehearsal.targetMinutes}
                onChange={(event) =>
                  setRehearsal((current) => ({
                    ...current,
                    targetMinutes: Number(event.target.value) || 1,
                  }))
                }
              />
            </label>
          )}
          <span className="setup-hint">
            {rehearsal.mode === "countdown"
              ? "Exact time is hidden; warnings appear at 1:00 and 0:30."
              : "Exact time is hidden; no remaining-time warnings are shown."}
          </span>
          <button onClick={startRehearsal}>Start</button>
        </section>
      )}

      <section className="workspace">
        <div
          className={`content-stage ${visibleEditor && visibleReader ? "is-split" : "is-single"}`}
          style={contentStageStyle}
        >
          {visibleEditor && <section className="panel editor-panel">
            <div className="panel-title">
              <span>Markdown</span>
            </div>
            <CodeMirror
              value={markdown}
              extensions={editorExtensions}
              basicSetup={{
                foldGutter: false,
                highlightActiveLine: false,
                highlightActiveLineGutter: false,
              }}
              onChange={updateMarkdown}
              onUpdate={(update) => {
                const range = update.state.selection.main;
                lastCommentSource.current = "editor";
                readerCaretSource.current = null;
                setSelection({ from: range.from, to: range.to });
              }}
              className="markdown-editor"
              aria-label={editorPanelLabel}
            />
          </section>}

          {visibleEditor && visibleReader && <div
            className="splitter"
            role="separator"
            aria-label="Resize editor and preview panels"
            aria-orientation="vertical"
            onPointerDown={(event) => {
              splitDragRef.current = { pointerId: event.pointerId };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!splitDragRef.current || splitDragRef.current.pointerId !== event.pointerId) return;
              const stage = event.currentTarget.parentElement;
              if (!stage) return;
              const rect = stage.getBoundingClientRect();
              const nextRatio = (event.clientX - rect.left) / rect.width;
              setSplitRatio(Math.min(0.75, Math.max(0.25, nextRatio)));
            }}
            onPointerUp={(event) => {
              if (splitDragRef.current?.pointerId === event.pointerId) {
                splitDragRef.current = null;
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
          />}

          {visibleReader && <section className="panel preview-panel" aria-label="Live Preview">
            <div className="panel-title">
              <span>Live Preview</span>
            </div>
            {renderReaderDocument()}
          </section>}
        </div>

        {visibleSidebar && renderSidebarPanel()}
      </section>
    </main>
  );
}
