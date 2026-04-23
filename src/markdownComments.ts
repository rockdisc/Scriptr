import type { CommentAnchor, CommentCategory, CommentStatus, SpeechComment } from "./types";

const commentBlockPattern = /<!--\s*speech-comment\n([\s\S]*?)-->/g;
const startAnchorPattern = /<!--\s*speech-anchor-start\s+([a-zA-Z0-9_-]+)\s*-->/g;
const endAnchorPattern = /<!--\s*speech-anchor-end\s+([a-zA-Z0-9_-]+)\s*-->/g;
const obsidianCommentBlockPattern = /%%sw-comment\n([\s\S]*?)%%/g;
const obsidianStartAnchorPattern = /%%sw-anchor-start:([a-zA-Z0-9_-]+)%%/g;
const obsidianEndAnchorPattern = /%%sw-anchor-end:([a-zA-Z0-9_-]+)%%/g;
const compactStartAnchorPattern = /%%([a-zA-Z0-9_-]{6})%%/g;
const compactAnchorPattern = /%%([a-zA-Z0-9_-]{6})%%([\s\S]*?)%%\/%%/g;

export function createCommentBlock(input: {
  id: string;
  anchor: Exclude<CommentAnchor, "unlinked">;
  text: string;
  status?: CommentStatus;
  category?: CommentCategory;
  created?: string;
}) {
  const textLines = input.text
    .trim()
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

  return `%%sw-comment
id: ${input.id}
status: ${input.status ?? "open"}
anchor: ${input.anchor}
category: ${input.category ?? "note"}
created: ${input.created ?? new Date().toISOString()}
text: |
${textLines}
%%`;
}

export function parseComments(markdown: string): SpeechComment[] {
  const linkedAnchors = findSelectionAnchors(markdown);
  const comments: SpeechComment[] = [];

  for (const match of findCommentBlocks(markdown)) {
    const body = match[1] ?? "";
    const fields = parseFields(body);
    const id = fields.id || `unlinked_${match.index ?? 0}`;
    const requestedAnchor = parseAnchor(fields.anchor);
    const selectionAnchor = linkedAnchors.get(id);
    const anchor =
      requestedAnchor === "selection" && !selectionAnchor
        ? "unlinked"
        : requestedAnchor;

    comments.push({
      id,
      status: fields.status === "resolved" ? "resolved" : "open",
      anchor,
      category: parseCategory(fields.category),
      created: fields.created || "",
      text: fields.text || "",
      blockStart: match.index ?? 0,
      blockEnd: (match.index ?? 0) + match[0].length,
      anchorStart: selectionAnchor?.start,
      anchorEnd: selectionAnchor?.end,
    });
  }

  return comments;
}

export function stripCommentMetadata(markdown: string) {
  return stripYamlFrontmatter(markdown)
    .replace(compactStartAnchorPattern, "")
    .replace(/%%\/%%/g, "")
    .replace(commentBlockPattern, "")
    .replace(obsidianCommentBlockPattern, "")
    .replace(startAnchorPattern, "")
    .replace(endAnchorPattern, "")
    .replace(obsidianStartAnchorPattern, "")
    .replace(obsidianEndAnchorPattern, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function exportCleanMarkdown(markdown: string) {
  return markdown
    .replace(commentBlockPattern, "")
    .replace(obsidianCommentBlockPattern, "")
    .replace(startAnchorPattern, "")
    .replace(endAnchorPattern, "")
    .replace(obsidianStartAnchorPattern, "")
    .replace(obsidianEndAnchorPattern, "")
    .replace(compactStartAnchorPattern, "")
    .replace(/%%\/%%/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function insertParagraphComment(
  markdown: string,
  cursor: number,
  text: string,
  category: CommentCategory = "note",
) {
  const id = createId();
  const block = createCommentBlock({ id, anchor: "paragraph", text, category });
  const insertAt = findParagraphEnd(markdown, cursor);
  const prefix = markdown.slice(0, insertAt).replace(/\s*$/, "");
  const suffix = markdown.slice(insertAt).replace(/^\s*/, "");
  const nextMarkdown = `${prefix}\n\n${block}\n\n${suffix}`.trimEnd();

  return { markdown: `${nextMarkdown}\n`, id };
}

export function insertSelectionComment(
  markdown: string,
  start: number,
  end: number,
  text: string,
  category: CommentCategory = "note",
) {
  if (start === end) {
    return insertParagraphComment(markdown, start, text, category);
  }

  const id = createId();
  const block = createCommentBlock({ id, anchor: "selection", text, category });
  const selected = markdown.slice(start, end);
  const wrapped = `%%${id}%%${selected}%%/%%`;
  const nextMarkdown = `${markdown.slice(0, start)}${wrapped}${markdown.slice(end)}\n\n${block}`;

  return { markdown: `${nextMarkdown.trimEnd()}\n`, id };
}

export function insertSelectionCommentByVisibleRange(
  markdown: string,
  visibleStart: number,
  visibleEnd: number,
  text: string,
  category: CommentCategory = "note",
) {
  if (visibleStart === visibleEnd) {
    return insertSelectionComment(markdown, visibleStart, visibleEnd, text, category);
  }

  const range = expandRangeAroundHiddenMarkers(markdown, visibleStart, visibleEnd);
  return insertSelectionComment(markdown, range.start, range.end, text, category);
}

export function findNearestWordRange(markdown: string, cursor: number) {
  const isWord = (char: string) => /[\p{L}\p{N}'_-]/u.test(char);
  let start = Math.max(0, Math.min(cursor, markdown.length));
  let end = start;

  if (!isWord(markdown[start] ?? "") && isWord(markdown[start - 1] ?? "")) {
    start -= 1;
    end = start + 1;
  }

  while (start > 0 && isWord(markdown[start - 1])) start -= 1;
  while (end < markdown.length && isWord(markdown[end])) end += 1;

  if (start === end) return null;
  return { start, end };
}

export function stripYamlFrontmatter(markdown: string) {
  const bounds = findYamlFrontmatter(markdown);
  if (!bounds) return markdown;
  return markdown.slice(0, bounds.start) + markdown.slice(bounds.end);
}

export function findYamlFrontmatter(markdown: string) {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  return { start: 0, end: match[0].length };
}

export function replaceComment(markdown: string, id: string, updates: Partial<SpeechComment>) {
  const comment = parseComments(markdown).find((item) => item.id === id);
  if (!comment) return markdown;

  const block = createCommentBlock({
    id: comment.id,
    anchor: comment.anchor === "unlinked" ? "selection" : comment.anchor,
    created: comment.created || new Date().toISOString(),
    status: updates.status ?? comment.status,
    category: updates.category ?? comment.category,
    text: updates.text ?? comment.text,
  });

  return `${markdown.slice(0, comment.blockStart)}${block}${markdown.slice(comment.blockEnd)}`;
}

export function deleteComment(markdown: string, id: string) {
  const comment = parseComments(markdown).find((item) => item.id === id);
  if (!comment) return markdown;

  return removeCompactAnchor(
    markdown
    .slice(0, comment.blockStart)
    .concat(markdown.slice(comment.blockEnd)),
    id,
  )
    .replace(new RegExp(`<!--\\s*speech-anchor-start\\s+${escapeRegExp(id)}\\s*-->`, "g"), "")
    .replace(new RegExp(`<!--\\s*speech-anchor-end\\s+${escapeRegExp(id)}\\s*-->`, "g"), "")
    .replace(new RegExp(`%%sw-anchor-start:${escapeRegExp(id)}%%`, "g"), "")
    .replace(new RegExp(`%%sw-anchor-end:${escapeRegExp(id)}%%`, "g"), "")
    .replace(/\n{3,}/g, "\n\n");
}

export function getSpeechMetrics(markdown: string, wpm = 140) {
  const readable = stripCommentMetadata(markdown);
  const words = readable.match(/\b[\w'-]+\b/g)?.length ?? 0;
  const minutes = words / Math.max(1, wpm);

  return {
    words,
    minutes,
    label:
      minutes < 1
        ? `${Math.max(1, Math.round(minutes * 60))} sec`
        : `${minutes.toFixed(1)} min`,
  };
}

function parseFields(body: string) {
  const fields: Record<string, string> = {};
  const lines = body.replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^([a-zA-Z]+):\s*(.*)$/);
    if (!match) continue;

    const [, key, value] = match;
    if (value === "|") {
      const textLines: string[] = [];
      i += 1;
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i] === "")) {
        textLines.push(lines[i].replace(/^  /, ""));
        i += 1;
      }
      i -= 1;
      fields[key] = textLines.join("\n").trim();
    } else {
      fields[key] = value.trim();
    }
  }

  return fields;
}

function findCommentBlocks(markdown: string) {
  return [
    ...Array.from(markdown.matchAll(commentBlockPattern)),
    ...Array.from(markdown.matchAll(obsidianCommentBlockPattern)),
  ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

function parseAnchor(value: string | undefined): CommentAnchor {
  if (value === "paragraph" || value === "selection") return value;
  return "unlinked";
}

function parseCategory(value: string | undefined): CommentCategory {
  if (value === "blocking" || value === "voice" || value === "change position" || value === "note") {
    return value;
  }
  return "note";
}

function findSelectionAnchors(markdown: string) {
  const starts = new Map<string, { markerStart: number; contentStart: number }>();
  const linked = new Map<string, { start: number; end: number }>();

  for (const match of [
    ...Array.from(markdown.matchAll(startAnchorPattern)),
    ...Array.from(markdown.matchAll(obsidianStartAnchorPattern)),
  ]) {
    const markerStart = match.index ?? 0;
    starts.set(match[1], {
      markerStart,
      contentStart: markerStart + match[0].length,
    });
  }

  for (const match of markdown.matchAll(compactAnchorPattern)) {
    const markerStart = match.index ?? 0;
    const contentStart = markerStart + `%%${match[1]}%%`.length;
    linked.set(match[1], {
      start: contentStart,
      end: contentStart + (match[2] ?? "").length,
    });
  }

  for (const match of [
    ...Array.from(markdown.matchAll(endAnchorPattern)),
    ...Array.from(markdown.matchAll(obsidianEndAnchorPattern)),
  ]) {
    const start = starts.get(match[1]);
    if (start) {
      linked.set(match[1], {
        start: start.contentStart,
        end: match.index ?? start.contentStart,
      });
    }
  }

  return linked;
}

function expandRangeAroundHiddenMarkers(markdown: string, start: number, end: number) {
  const comments = parseComments(markdown);
  let expandedStart = start;
  let expandedEnd = end;

  for (const comment of comments) {
    if (!comment.anchorStart || !comment.anchorEnd) continue;
    if (comment.anchorStart >= start && comment.anchorEnd <= end) {
      expandedStart = Math.min(expandedStart, comment.anchorStart);
      expandedEnd = Math.max(expandedEnd, comment.anchorEnd);
    }
  }

  return { start: expandedStart, end: expandedEnd };
}

function findParagraphEnd(markdown: string, cursor: number) {
  const after = markdown.slice(cursor);
  const nextBreak = after.search(/\n\s*\n/);
  if (nextBreak === -1) return markdown.length;
  return cursor + nextBreak;
}

function createId() {
  return Math.random()
    .toString(36)
    .slice(2, 8)
    .padEnd(6, "0");
}

function removeCompactAnchor(markdown: string, id: string) {
  const startMarker = `%%${id}%%`;
  const start = markdown.indexOf(startMarker);
  if (start === -1) return markdown;

  const withoutStart = `${markdown.slice(0, start)}${markdown.slice(start + startMarker.length)}`;
  const end = withoutStart.indexOf("%%/%%", start);
  if (end === -1) return withoutStart;
  return `${withoutStart.slice(0, end)}${withoutStart.slice(end + "%%/%%".length)}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
