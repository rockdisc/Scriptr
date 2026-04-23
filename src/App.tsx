import { markdown as markdownExtension } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import {
  ChangeEvent,
  FocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
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
import { blockPlainText, createReaderBlocks, replaceBlockText } from "./markdownPreview";
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
  showComments: boolean;
  showOutline: boolean;
  showSnapshots: boolean;
  showHistory: boolean;
};

const defaultSettings: Settings = {
  wpm: 140,
  showEditor: true,
  showReader: true,
  showComments: true,
  showOutline: false,
  showSnapshots: false,
  showHistory: false,
};

const settingsKey = "scriptr-settings";
const legacySettingsKey = "speech-writer-settings";
const snapshotKeyPrefix = "scriptr-snapshots";
const legacySnapshotKeyPrefix = "speech-writer-snapshots";
const draftHistoryKey = "scriptr-browser-drafts";
const commentCategories: CommentCategory[] = ["blocking", "voice", "change position", "note"];

type RehearsalMode = "countdown" | "stopwatch";

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
    return { ...defaultSettings, ...JSON.parse(raw) };
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
  const pendingFocusSource = useRef<number | null>(null);
  const readerCaretSource = useRef<number | null>(null);
  const lastCommentSource = useRef<"editor" | "reader" | null>(null);

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
    if (target == null) return;
    pendingFocusSource.current = null;

    requestAnimationFrame(() => {
      const focusBlock = createReaderBlocks(markdown).find(
        (block) =>
          (block.textStart <= target && target <= block.textEnd) ||
          block.listItems?.some((item) => item.textStart <= target && target <= item.textEnd),
      );
      const item =
        focusBlock?.listItems?.find((candidate) => candidate.textStart <= target && target <= candidate.textEnd) ??
        focusBlock;
      readerBlockRefs.current[item?.id ?? ""]?.focus();
    });
  }, [markdown]);

  function updateMarkdown(value: string) {
    setMarkdown(value);
    setDirty(true);
  }

  function updateSettings(patch: Partial<Settings>) {
    setSettings((current) => ({ ...current, ...patch }));
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
    const downloadName = fileName.replace(/\.(md|markdown|txt)$/i, "") || "scriptr";
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
      setStatus(`Added ${category} reader selection comment.`);
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
    updateSettings({ showReader: true });
    requestAnimationFrame(() => {
      const block = readerBlockRefs.current[id];
      block?.scrollIntoView({ behavior: "smooth", block: "center" });
      block?.focus();
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

  function commitReaderEdit(block: ReaderBlock, value: string) {
    const currentText = blockPlainText(block);
    const normalized = normalizeReaderText(value);
    if (normalized === currentText) return;
    updateMarkdown(replaceBlockText(markdown, block, normalized));
    setStatus("Updated Markdown from read mode.");
  }

  function handleReaderKeyDown(
    event: ReactKeyboardEvent<HTMLElement>,
    block: ReaderBlock,
  ) {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
      return;
    }

    event.preventDefault();
    const value = normalizeReaderText(event.currentTarget.innerText);
    const offset = getCaretOffset(event.currentTarget);
    const before = value.slice(0, offset);
    const after = value.slice(offset);
    const separator = block.listMarker ? `\n${block.listMarker}` : "\n\n";
    const replacement = `${before}${separator}${after}`;

    updateMarkdown(replaceBlockText(markdown, block, replacement));
    pendingFocusSource.current = block.textStart + before.length + separator.length;
    setStatus(block.listMarker ? "Inserted new list item from read mode." : "Inserted new paragraph from read mode.");
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

    lastCommentSource.current = "reader";
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

  function rememberReaderCaret(block: ReaderBlock, element: HTMLElement) {
    const selectionObject = window.getSelection();
    if (selectionObject && selectionObject.rangeCount > 0 && element.contains(selectionObject.anchorNode)) {
      const range = selectionObject.getRangeAt(0);
      const source = pointToSource(range.startContainer, range.startOffset);
      if (source != null) {
        readerCaretSource.current = source;
        lastCommentSource.current = "reader";
        return;
      }
    }

    readerCaretSource.current = block.textStart;
    lastCommentSource.current = "reader";
  }

  function renderReaderBlock(block: ReaderBlock) {
    const editableProps = {
      contentEditable: block.kind === "heading" || block.kind === "paragraph",
      suppressContentEditableWarning: true,
      onFocus: (event: FocusEvent<HTMLElement>) => rememberReaderCaret(block, event.currentTarget),
      onMouseUp: (event: ReactMouseEvent<HTMLElement>) => rememberReaderCaret(block, event.currentTarget),
      onKeyUp: (event: ReactKeyboardEvent<HTMLElement>) => rememberReaderCaret(block, event.currentTarget),
      onBlur: (event: FocusEvent<HTMLElement>) =>
        commitReaderEdit(block, event.currentTarget.innerText),
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => handleReaderKeyDown(event, block),
    };

    if (block.kind === "heading") {
      return renderHeading(block, renderInlines(block), editableProps);
    }

    if (block.kind === "unordered-list" || block.kind === "ordered-list") {
      const List = block.kind === "ordered-list" ? "ol" : "ul";
      return (
        <List key={block.id} className="reader-list">
          {block.listItems?.map((item) => (
            <li
              key={item.id}
              className="reader-block"
              contentEditable
              suppressContentEditableWarning
              ref={(element) => {
                readerBlockRefs.current[item.id] = element;
              }}
              onFocus={(event) => rememberReaderCaret(item, event.currentTarget)}
              onMouseUp={(event) => rememberReaderCaret(item, event.currentTarget)}
              onKeyUp={(event) => rememberReaderCaret(item, event.currentTarget)}
              onKeyDown={(event) => handleReaderKeyDown(event, item)}
              onBlur={(event) => commitReaderEdit(item, event.currentTarget.innerText)}
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
        className="reader-block"
        data-block-id={block.id}
        {...editableProps}
      >
        {renderInlines(block)}
      </p>
    );
  }

  function renderHeading(
    block: ReaderBlock,
    children: ReactNode,
    editableProps: {
      contentEditable: boolean;
      suppressContentEditableWarning: boolean;
      onBlur: (event: FocusEvent<HTMLElement>) => void;
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
    },
  ) {
    const props = {
      key: block.id,
      className: "reader-block",
      "data-block-id": block.id,
      ref: (element: HTMLElement | null) => {
        readerBlockRefs.current[block.id] = element;
      },
      ...editableProps,
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
        className={`reader-text ${inline.commentId ? `comment-highlight ${categoryClass(inline.commentCategory ?? "note")}` : ""} ${
          inline.commentId === activeCommentId ? "active-highlight" : ""
        }`}
        data-source-start={inline.start}
        data-source-end={inline.end}
        data-comment-id={inline.commentId}
        onClick={(event) => {
          const id = event.currentTarget.dataset.commentId;
          if (id) setActiveCommentId(id);
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
          aria-label={rehearsal.running ? "Rehearsal reader" : "Paused rehearsal editor"}
        >
          {rehearsal.running ? readerBlocks.map(renderRehearsalBlock) : readerBlocks.map(renderReaderBlock)}
        </article>
      </main>
    );
  }

  return (
    <main
      className={`app-shell ${!settings.showEditor ? "editor-hidden" : ""} ${
        !settings.showReader ? "reader-hidden" : ""
      } ${!settings.showComments ? "comments-hidden" : ""}`}
    >
      <header className="hero">
        <div>
          <p className="eyebrow">Local-first Markdown writing</p>
          <h1>Scriptr</h1>
        </div>
        <div className="privacy-card">
          <strong>Your files stay local.</strong>
          <span>
            {desktop?.isDesktop
              ? "Desktop file open/save is available offline."
              : supportsDirectFiles
              ? "Direct file open/save is available in this browser."
              : "This browser uses import/export fallback."}
          </span>
        </div>
      </header>

      <section className="toolbar" aria-label="File and comment actions">
        <button onClick={newSpeech}>New</button>
        <button onClick={openFile}>Open</button>
        <button onClick={saveFile}>Save</button>
        <button onClick={saveAsFile}>Export</button>
        <button onClick={downloadCleanMarkdown}>Export Clean</button>
        <button
          onClick={() => addContextComment()}
          title="Shortcuts: Option/Alt-C note, B blocking, V voice, P position"
        >
          Comment <kbd>⌥C / Alt-C</kbd>
        </button>
        <input ref={importRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={importFile} hidden />
      </section>

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
            <input
              type="checkbox"
              checked={settings.showEditor}
              onChange={(event) => updateSettings({ showEditor: event.target.checked })}
            />
            Show editor
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.showReader}
              onChange={(event) => updateSettings({ showReader: event.target.checked })}
            />
            Show reader
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.showComments}
              onChange={(event) => updateSettings({ showComments: event.target.checked })}
            />
            Show comments
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.showOutline}
              onChange={(event) => updateSettings({ showOutline: event.target.checked })}
            />
            Show outline
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.showSnapshots}
              onChange={(event) => updateSettings({ showSnapshots: event.target.checked })}
            />
            Show snapshots
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.showHistory}
              onChange={(event) => updateSettings({ showHistory: event.target.checked })}
            />
            Show history
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

      <section className="status-row" aria-live="polite">
        <span>
          <strong>{fileName}</strong>
          {dirty ? " - unsaved changes" : " - saved"}
        </span>
        <span>{metrics.words} words</span>
        <span>{metrics.label} at {settings.wpm} wpm</span>
        <span>{status}</span>
        <span className="status-actions">
          <button className="ghost-button" onClick={() => updateSettings({ showHistory: !settings.showHistory })}>History</button>
          <button className="ghost-button" onClick={() => setRehearsalSetupOpen((open) => !open)}>Rehearsal</button>
          <button className="ghost-button" onClick={() => setSettingsOpen((open) => !open)}>Settings</button>
        </span>
      </section>

      <section className="workspace">
        {settings.showOutline && <aside className="panel outline-panel" aria-label="Outline">
          <div className="panel-title">
            <span>Outline</span>
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
        </aside>}

        {settings.showEditor && <section className="panel editor-panel">
          <div className="panel-title">
            <span>Markdown</span>
          </div>
          <CodeMirror
            value={markdown}
            extensions={[markdownExtension()]}
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
          />
        </section>}

        {settings.showReader && <section className="panel preview-panel" aria-label="Document preview">
          <div className="panel-title">
            <span>Read Mode</span>
          </div>
          <article
            ref={previewRef}
            className="speech-preview"
            aria-label="Editable reader"
          >
            {readerBlocks.map(renderReaderBlock)}
          </article>
        </section>}

        {settings.showComments && <aside className="panel comments-panel" aria-label="Comments">
          <div className="panel-title">
            <span>Comments</span>
          </div>
          <>
          {comments.length === 0 ? (
            <p className="empty">No comments yet. Select text or place your cursor near a word, then press Option/Alt-C.</p>
          ) : (
            comments.map((comment) => (
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
          </>
        </aside>}

        {settings.showSnapshots && <aside className="panel snapshots-panel" aria-label="Snapshots">
          <div className="panel-title">
            <span>Snapshots</span>
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
        </aside>}

        {settings.showHistory && <aside className="panel history-panel" aria-label="Browser autosave history">
          <div className="panel-title">
            <span>History</span>
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
        </aside>}
      </section>
    </main>
  );
}
