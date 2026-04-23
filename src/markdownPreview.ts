import { findYamlFrontmatter, parseComments } from "./markdownComments";
import type { ReaderBlock, ReaderInline } from "./types";

const commentMarkerPattern =
  /<!--\s*speech-anchor-(?:start|end)\s+[a-zA-Z0-9_-]+\s*-->|%%sw-anchor-(?:start|end):[a-zA-Z0-9_-]+%%|%%[a-zA-Z0-9_-]{6}%%|%%\/%%|<!--\s*speech-comment\n[\s\S]*?-->|%%sw-comment\n[\s\S]*?%%/g;

export function createReaderBlocks(markdown: string): ReaderBlock[] {
  const hiddenRanges = getHiddenRanges(markdown);
  const comments = parseComments(markdown);
  const blocks: ReaderBlock[] = [];
  const blockPattern = /[^\n](?:[\s\S]*?)(?=\n{2,}|$)/g;

  for (const match of markdown.matchAll(blockPattern)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const end = start + raw.length;
    if (isHiddenBlock(start, end, hiddenRanges)) continue;
    if (!raw.trim() || raw.includes("<!-- speech-comment") || raw.includes("%%sw-comment")) {
      continue;
    }

    const trimmedStartOffset = raw.search(/\S/);
    const trimmedEndOffset = raw.length - raw.trimEnd().length;
    const trimmed = raw.trim();
    const textStart = start + trimmedStartOffset;
    const textEnd = end - trimmedEndOffset;

    if (/^#{1,6}\s/.test(trimmed)) {
      const marker = trimmed.match(/^#{1,6}\s*/)![0];
      const level = Math.min(6, marker.trim().length);
      blocks.push({
        id: `block-${textStart}`,
        kind: "heading",
        level,
        start,
        end,
        textStart: textStart + marker.length,
        textEnd,
        inlines: createInlines(markdown, textStart + marker.length, textEnd, comments),
      });
      continue;
    }

    if (/^[-*]\s/m.test(trimmed)) {
      blocks.push(createListBlock(markdown, raw, start, end, false, comments));
      continue;
    }

    if (/^\d+\.\s/m.test(trimmed)) {
      blocks.push(createListBlock(markdown, raw, start, end, true, comments));
      continue;
    }

    blocks.push({
      id: `block-${textStart}`,
      kind: "paragraph",
      start,
      end,
      textStart,
      textEnd,
      inlines: createInlines(markdown, textStart, textEnd, comments),
    });
  }

  return blocks;
}

export function blockPlainText(block: ReaderBlock) {
  return block.inlines.map((inline) => inline.text).join("");
}

export function replaceBlockText(markdown: string, block: ReaderBlock, text: string) {
  const hasAnchors = block.inlines.some((inline) => inline.commentId);

  if (hasAnchors) {
    return replaceVisibleTextPreservingMarkers(markdown, block.textStart, block.textEnd, text);
  }

  if (block.kind === "heading") {
    return markdown.slice(0, block.textStart) + text + markdown.slice(block.textEnd);
  }

  if (block.kind === "paragraph") {
    return markdown.slice(0, block.textStart) + text + markdown.slice(block.textEnd);
  }

  return markdown;
}

function replaceVisibleTextPreservingMarkers(markdown: string, start: number, end: number, text: string) {
  const raw = markdown.slice(start, end);
  const pieces: Array<
    | { kind: "marker"; value: string }
    | { kind: "text"; value: string; plainLength: number }
  > = [];
  let cursor = 0;
  let visibleLength = 0;

  for (const match of raw.matchAll(commentMarkerPattern)) {
    const markerStart = match.index ?? 0;
    if (markerStart > cursor) {
      const value = raw.slice(cursor, markerStart);
      const plainLength = stripInlineMarkdown(value).length;
      pieces.push({ kind: "text", value, plainLength });
      visibleLength += plainLength;
    }
    pieces.push({ kind: "marker", value: match[0] });
    cursor = markerStart + match[0].length;
  }

  if (cursor < raw.length) {
    const value = raw.slice(cursor);
    const plainLength = stripInlineMarkdown(value).length;
    pieces.push({ kind: "text", value, plainLength });
    visibleLength += plainLength;
  }

  if (!pieces.some((piece) => piece.kind === "marker")) {
    return markdown.slice(0, start) + text + markdown.slice(end);
  }

  let replacementCursor = 0;
  let remainingOld = visibleLength;
  let remainingNew = text.length;
  const nextRaw = pieces
    .map((piece) => {
      if (piece.kind === "marker") return piece.value;

      const take =
        remainingOld <= 0
          ? remainingNew
          : Math.round((piece.plainLength / remainingOld) * remainingNew);
      const segment = text.slice(replacementCursor, replacementCursor + take);
      replacementCursor += take;
      remainingNew -= take;
      remainingOld -= piece.plainLength;
      return segment;
    })
    .join("");

  return markdown.slice(0, start) + nextRaw + markdown.slice(end);
}

function createListBlock(
  markdown: string,
  raw: string,
  start: number,
  end: number,
  ordered: boolean,
  comments: ReturnType<typeof parseComments>,
): ReaderBlock {
  const listItems: ReaderBlock[] = [];
  let offset = 0;

  for (const line of raw.split("\n")) {
    const lineStart = start + offset;
    const marker = ordered ? line.match(/^\d+\.\s*/) : line.match(/^[-*]\s*/);
    if (marker) {
      const textStart = lineStart + marker[0].length;
      const textEnd = lineStart + line.length;
      listItems.push({
        id: `block-${textStart}`,
        kind: "paragraph",
        listMarker: marker[0],
        start: lineStart,
        end: lineStart + line.length,
        textStart,
        textEnd,
        inlines: createInlines(markdown, textStart, textEnd, comments),
      });
    }
    offset += line.length + 1;
  }

  return {
    id: `block-${start}`,
    kind: ordered ? "ordered-list" : "unordered-list",
    start,
    end,
    textStart: start,
    textEnd: end,
    listItems,
    inlines: [],
  };
}

function createInlines(
  markdown: string,
  start: number,
  end: number,
  comments: ReturnType<typeof parseComments>,
): ReaderInline[] {
  const ranges = comments
    .filter(
      (comment) =>
        comment.status === "open" &&
        comment.anchorStart != null &&
        comment.anchorEnd != null &&
        comment.anchorStart < end &&
        comment.anchorEnd > start,
    )
    .map((comment) => ({
      start: Math.max(start, comment.anchorStart!),
      end: Math.min(end, comment.anchorEnd!),
      commentId: comment.id,
      commentCategory: comment.category,
    }))
    .sort((a, b) => a.start - b.start);

  const inlines: ReaderInline[] = [];
  let cursor = start;

  for (const range of ranges) {
    if (range.start > cursor) {
      inlines.push(...visibleTextInlines(markdown, cursor, range.start));
    }
    inlines.push(...visibleTextInlines(markdown, range.start, range.end, range.commentId, range.commentCategory));
    cursor = Math.max(cursor, range.end);
  }

  if (cursor < end) {
    inlines.push(...visibleTextInlines(markdown, cursor, end));
  }

  return inlines;
}

function visibleTextInlines(
  markdown: string,
  start: number,
  end: number,
  commentId?: string,
  commentCategory?: ReturnType<typeof parseComments>[number]["category"],
) {
  const raw = markdown.slice(start, end);
  const inlines: ReaderInline[] = [];
  let cursor = 0;

  for (const match of raw.matchAll(commentMarkerPattern)) {
    const markerStart = match.index ?? 0;
    if (markerStart > cursor) {
      inlines.push({
        text: stripInlineMarkdown(raw.slice(cursor, markerStart)),
        start: start + cursor,
        end: start + markerStart,
        commentId,
        commentCategory,
      });
    }
    cursor = markerStart + match[0].length;
  }

  if (cursor < raw.length) {
    inlines.push({
      text: stripInlineMarkdown(raw.slice(cursor)),
      start: start + cursor,
      end,
      commentId,
      commentCategory,
    });
  }

  return inlines.filter((inline) => inline.text.length > 0);
}

function getHiddenRanges(markdown: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  const frontmatter = findYamlFrontmatter(markdown);
  if (frontmatter) ranges.push(frontmatter);

  for (const match of markdown.matchAll(/<!--\s*speech-comment\n[\s\S]*?-->/g)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }

  for (const match of markdown.matchAll(/%%sw-comment\n[\s\S]*?%%/g)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }

  return ranges;
}

function isHiddenBlock(start: number, end: number, ranges: Array<{ start: number; end: number }>) {
  return ranges.some((range) => start >= range.start && end <= range.end);
}

function stripInlineMarkdown(value: string) {
  return value
    .replace(/<!--\s*speech-anchor-start\s+[a-zA-Z0-9_-]+\s*-->/g, "")
    .replace(/<!--\s*speech-anchor-end\s+[a-zA-Z0-9_-]+\s*-->/g, "")
    .replace(/%%sw-anchor-start:[a-zA-Z0-9_-]+%%/g, "")
    .replace(/%%sw-anchor-end:[a-zA-Z0-9_-]+%%/g, "")
    .replace(/%%[a-zA-Z0-9_-]{6}%%/g, "")
    .replace(/%%\/%%/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}
