# Folio

A serene, 100% client-side browser e-book reader powered by [foliate-js](https://github.com/johnfactotum/foliate-js). Zero backend, zero uploads, zero build step — ready to deploy straight to GitHub Pages.

## Features

- **Broad Format Support**: EPUB, MOBI, AZW3/KF8, FB2, CBZ, and PDF parsed entirely in the browser.
- **Local Library**: Books, covers, reading progress, bookmarks, and highlights are persisted privately on your device using IndexedDB.
- **7 Reading Themes**: Light, Stone, Sage, Nord, Charcoal, Obsidian, and Sepia — applied consistently across both the reader chrome and book typography.
- **Typography & Layout Controls**: Two-page spread, single-page paginated, or true continuous multi-chapter vertical scroll; 6 font families; adjustable font size, line height, column width, justification, and hyphenation.
- **Annotations & Notes**: Highlight passages in four colors, attach notes, bookmark pages, and export all notes for a book to Markdown.
- **Navigation & Research**: Docked split sidebar on desktop with chapter names, streaming full-book search, interactive inline footnote cards, hover-reveal segmented chapter bar, and back/forward reading history.
- **Safe by Design**: Enforces a strict Content Security Policy (`script-src 'self'`) to block embedded scripts inside EPUB files.

## Run Locally

Serve the repository root with any static file server (native ES modules require HTTP rather than `file://`):

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Deploy to GitHub Pages

No build step is needed:

1. Push this repository to GitHub.
2. Open **Settings -> Pages**.
3. Under **Build and deployment**, select **Deploy from a branch**, choose `main` and `/ (root)`, and save.
4. Your static reader is live. Every book opened by visitors stays strictly on their own device.

## Keyboard Shortcuts

- `ArrowRight` / `Space` / `L` — Next page
- `ArrowLeft` / `Shift+Space` / `H` — Previous page
- `T` — Toggle Contents, Notes & Search drawer
- `/` — Search inside current book
- `A` — Typography & Theme settings
- `B` — Bookmark current page
- `F` — Toggle Fullscreen
- `?` — Show keyboard shortcuts
- `Esc` — Close open panels or exit focus mode

## Credits

Powered by [foliate-js](https://github.com/johnfactotum/foliate-js) (MIT License, included in `vendor/foliate-js/LICENSE`).
