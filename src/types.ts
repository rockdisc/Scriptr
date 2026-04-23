export type CommentStatus = "open" | "resolved";
export type CommentAnchor = "paragraph" | "selection" | "unlinked";
export type CommentCategory = "blocking" | "voice" | "change position" | "note";

export type SpeechComment = {
  id: string;
  status: CommentStatus;
  anchor: CommentAnchor;
  category: CommentCategory;
  created: string;
  text: string;
  blockStart: number;
  blockEnd: number;
  anchorStart?: number;
  anchorEnd?: number;
};

export type ReaderBlockKind = "heading" | "paragraph" | "unordered-list" | "ordered-list";

export type ReaderInline = {
  text: string;
  start: number;
  end: number;
  commentId?: string;
  commentCategory?: CommentCategory;
};

export type ReaderBlock = {
  id: string;
  kind: ReaderBlockKind;
  level?: number;
  listMarker?: string;
  start: number;
  end: number;
  textStart: number;
  textEnd: number;
  listItems?: ReaderBlock[];
  inlines: ReaderInline[];
};

export type FileSystemFileHandleLike = {
  name: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<{
    write: (data: string) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

export type FilePickerWindow = Window &
  typeof globalThis & {
    showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandleLike[]>;
    showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandleLike>;
  };

export type DesktopMarkdownFile = {
  fileName: string;
  path: string;
  markdown: string;
};

export type DesktopSaveResult = {
  fileName: string;
  path: string;
};

export type ScriptrDesktopApi = {
  isDesktop: true;
  openMarkdown: () => Promise<DesktopMarkdownFile | null>;
  saveMarkdown: (path: string, markdown: string) => Promise<void>;
  saveMarkdownAs: (defaultName: string, markdown: string) => Promise<DesktopSaveResult | null>;
  exportMarkdown: (defaultName: string, markdown: string) => Promise<DesktopSaveResult | null>;
};

export type ScriptrDesktopWindow = Window &
  typeof globalThis & {
    scriptrDesktop?: ScriptrDesktopApi;
  };

export type SpeechSnapshot = {
  id: string;
  title: string;
  timestamp: string;
  markdown: string;
  wordCount: number;
  commentCount: number;
};

export type BrowserDraft = {
  id: string;
  fileName: string;
  markdown: string;
  updatedAt: string;
  wordCount: number;
  commentCount: number;
};
