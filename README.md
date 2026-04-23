# Scriptr

Scriptr is a local-first Markdown writing app with private, file-embedded comments, browser autosave history, reader comments, and rehearsal mode. It is designed to work as a personal app and as a public static website that anyone can use without accounts, servers, analytics, or runtime network calls.

## Features

- Write speeches in normal `.md` files.
- Add selected-text comments from the editor or reader with `Alt-C`.
- Press `Alt-C` with no editor selection to comment the nearest word.
- Use `Alt-B`, `Alt-V`, and `Alt-P` for blocking, voice, and change-position comments.
- Restore, delete, or download browser-autosaved drafts from History.
- Click highlighted reader text to activate the matching comment.
- Edit paragraph, heading, and list-item text directly from read mode.
- Press `Enter` in read mode to create a real Markdown paragraph or list item.
- Collapse the editor, reader, or comments panes when you want more space.
- Use Settings to change speaking WPM or hide editor, reader, or comments views completely.
- Hide YAML frontmatter from read mode while preserving it in the Markdown file.
- Store new comments inside Obsidian-compatible `%%` comment tags so they stay out of Obsidian Reading view.
- Open and save files directly in Chromium-based browsers with the File System Access API.
- Fall back to import/download in browsers without direct file permissions.
- Show word count and estimated speaking time.

## Development

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite.

## Build

```bash
npm run build
npm run preview
```

The production site is generated in `dist/` and can be hosted as static files.

## GitHub Pages Release

1. Push this folder to a GitHub repository.
2. In the repository settings, set Pages to use GitHub Actions.
3. Push to the `main` branch or run the `Deploy GitHub Pages` workflow manually.
4. Because `vite.config.ts` uses `base: "./"`, the built app can run from a repository subpath.

## Browser Support

Direct open/save works best in Chromium-based browsers that support the File System Access API. Other modern browsers can still use the app by importing a Markdown file and downloading the updated file when finished.

## Privacy

The runtime app has no backend, accounts, analytics, cloud sync, or network calls. Files remain on the user's device unless the user manually uploads or shares them outside the app.

## Comment Format

New selected-text comments use compact Obsidian-style anchors plus metadata comments:

```md
%%abc123%%important phrase%%/%%

%%sw-comment
id: abc123
status: open
anchor: selection
category: note
created: 2026-04-22T00:00:00-05:00
text: |
  This phrase may be too vague.
%%
```

Legacy long-form Obsidian and HTML comments are still read for older files:

```md
<!-- speech-anchor-start sc_20260422_002 -->important phrase<!-- speech-anchor-end sc_20260422_002 -->

<!-- speech-comment
id: sc_20260422_002
status: open
anchor: selection
text: |
  This phrase may be too vague.
-->
```
