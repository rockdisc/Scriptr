import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { findYamlFrontmatter, parseComments } from "./markdownComments";

type DecorationRange = {
  from: number;
  to: number;
  decoration: Decoration;
};

const metadataPatterns = [
  /<!--\s*speech-comment\n[\s\S]*?-->/g,
  /%%sw-comment\n[\s\S]*?%%/g,
  /<!--\s*speech-anchor-start\s+[a-zA-Z0-9_-]+\s*-->/g,
  /<!--\s*speech-anchor-end\s+[a-zA-Z0-9_-]+\s*-->/g,
  /%%sw-anchor-start:[a-zA-Z0-9_-]+%%/g,
  /%%sw-anchor-end:[a-zA-Z0-9_-]+%%/g,
  /%%[a-zA-Z0-9_-]{6}%%/g,
  /%%\/%%/g,
];

const commentBlockPatterns = [
  /<!--\s*speech-comment\n[\s\S]*?-->/g,
  /%%sw-comment\n[\s\S]*?%%/g,
];

const inlineAnchorPatterns = [
  /<!--\s*speech-anchor-start\s+[a-zA-Z0-9_-]+\s*-->/g,
  /<!--\s*speech-anchor-end\s+[a-zA-Z0-9_-]+\s*-->/g,
  /%%sw-anchor-start:[a-zA-Z0-9_-]+%%/g,
  /%%sw-anchor-end:[a-zA-Z0-9_-]+%%/g,
  /%%[a-zA-Z0-9_-]{6}%%/g,
  /%%\/%%/g,
];

export function commentDecorations(activeCommentId: string | null, cleanComments: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, activeCommentId, cleanComments);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, activeCommentId, cleanComments);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
    },
  );
}

function buildDecorations(view: EditorView, activeCommentId: string | null, cleanComments: boolean) {
  const markdown = view.state.doc.toString();
  const ranges: DecorationRange[] = [];

  for (const comment of parseComments(markdown)) {
    if (comment.anchorStart != null && comment.anchorEnd != null && comment.anchorStart < comment.anchorEnd) {
      const category = comment.category.replace(/\s+/g, "-");
      const activeClass = comment.id === activeCommentId ? " active-highlight" : "";
      const resolvedClass = comment.status === "resolved" ? " is-resolved" : "";
      ranges.push({
        from: comment.anchorStart,
        to: comment.anchorEnd,
        decoration: Decoration.mark({
          class: `cm-commented-range ${category}${resolvedClass}${activeClass}`,
        }),
      });
    }
  }

  if (cleanComments) {
    addHiddenYamlFrontmatter(view, markdown, ranges);
    addHiddenInlineAnchors(markdown, ranges);
    addHiddenCommentBlocks(view, markdown, ranges);
  } else {
    addSubduedMetadata(markdown, ranges);
  }

  ranges.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    return a.decoration.startSide - b.decoration.startSide || b.to - a.to;
  });

  const builder = new RangeSetBuilder<Decoration>();

  for (const range of ranges) {
    if (range.to < range.from) continue;
    builder.add(range.from, range.to, range.decoration);
  }

  return builder.finish();
}

function addHiddenYamlFrontmatter(view: EditorView, markdown: string, ranges: DecorationRange[]) {
  const frontmatter = findYamlFrontmatter(markdown);
  if (!frontmatter) return;
  addHiddenLines(view, frontmatter.start, frontmatter.end, ranges);
}

function addSubduedMetadata(markdown: string, ranges: DecorationRange[]) {
  for (const pattern of metadataPatterns) {
    pattern.lastIndex = 0;
    for (const match of markdown.matchAll(pattern)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      if (from === to) continue;
      ranges.push({
        from,
        to,
        decoration: Decoration.mark({ class: "cm-comment-metadata" }),
      });
    }
  }
}

function addHiddenInlineAnchors(markdown: string, ranges: DecorationRange[]) {
  for (const pattern of inlineAnchorPatterns) {
    pattern.lastIndex = 0;
    for (const match of markdown.matchAll(pattern)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      if (from === to) continue;
      ranges.push({
        from,
        to,
        decoration: Decoration.replace({}),
      });
    }
  }
}

function addHiddenCommentBlocks(view: EditorView, markdown: string, ranges: DecorationRange[]) {
  for (const pattern of commentBlockPatterns) {
    pattern.lastIndex = 0;
    for (const match of markdown.matchAll(pattern)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      if (from === to) continue;
      addHiddenLines(view, from, to, ranges);
    }
  }
}

function addHiddenLines(view: EditorView, from: number, to: number, ranges: DecorationRange[]) {
  const hiddenLine = Decoration.line({ class: "cm-hidden-metadata-line" });
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(Math.max(from, to - 1));

  for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
    const line = view.state.doc.line(lineNumber);
    ranges.push({
      from: line.from,
      to: line.from,
      decoration: hiddenLine,
    });
  }
}
