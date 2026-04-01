# Capture Studio

Capture Studio is a website screenshotting and QA export tool. It crawls a
site's sitemap, captures full‑page screenshots across multiple viewports, and
packages PDFs + previews into a ZIP you can download or store locally in your
browser.

## Highlights

- Sitemap‑driven crawl with URL caps for safety.
- Multi‑device capture (desktop, mobile, tablet, custom sizes).
- Full‑page PDFs generated from clean, stitched PNGs.
- Preview gallery with per‑page device thumbnails.
- Detached element capture for overlays or components.
- History stored locally (IndexedDB + localStorage).
- Real‑time progress updates via Server‑Sent Events.

## How It Works

1. **Client** collects a URL and export options.
2. **Server** fetches sitemap URLs (up to 200 pages).
3. **Playwright** captures each URL per selected device.
4. **ZIP** is built with PDFs + detached assets.
5. **Client** shows live progress + preview gallery.

## Tech Stack

- **Frontend**: Vite + React + Tailwind
- **Backend**: Express + Playwright (Chromium)
- **Storage**: IndexedDB for previews/ZIP + localStorage for metadata

## Getting Started

### Requirements

- Node.js 18+ (recommended)
- `zip` CLI available on your system (macOS/Linux)

### Install

```bash
npm install
```

Playwright Chromium is installed automatically via `postinstall`.

### Run

```bash
npm run dev
```

- Client: `http://localhost:5173`
- API: `http://localhost:8787`

## Usage

1. Open the app.
2. Enter a website or sitemap URL (e.g. `https://example.com` or
   `https://example.com/sitemap.xml`).
3. Pick devices and advanced options.
4. Start export and wait for progress to complete.
5. Download the ZIP or review previews and history.

## Advanced Options

- **Devices**: Select presets or add custom sizes (`1280x720`).
- **Detach selectors**: CSS selectors to capture separately, e.g.
  `.cookie-banner, #promo`.
- **Hide sticky elements**: Attempts to remove fixed/sticky overlays during
  capture.

## API (Local)

Base URL: `http://localhost:8787`

### Start export (preferred)

`POST /api/export/start`

```json
{
  "url": "https://example.com",
  "options": {
    "devices": [
      { "id": "desktop", "label": "Desktop", "width": 1920, "height": 1080 }
    ],
    "hideSticky": true,
    "detachSelectors": [".cookie-banner"]
  }
}
```

Returns `{ "jobId": "..." }`.

### Stream progress

`GET /api/export/stream/:jobId` (Server‑Sent Events)

Events:

- `progress`
- `done`
- `failed`

### Fetch preview list

`GET /api/export/previews/:jobId`

### Download ZIP

`GET /api/export/download/:jobId`

### Legacy export (no progress UI)

`POST /api/export`

Same payload as `/api/export/start`, returns ZIP directly.

## Storage Notes

- **Previews and ZIPs** are stored locally in the browser (IndexedDB).
- **History metadata** is stored in `localStorage`.
- Exports are temporary on the server (auto‑cleaned after ~10 minutes).

## Known Limits

- Sitemap crawl capped at **200 URLs**.
- Requires the `zip` CLI on the host machine.
- Large sites may take time depending on network + render complexity.

## License

Private project.
