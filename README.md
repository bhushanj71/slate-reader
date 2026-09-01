# Slate

A web PDF reader with the manners of an e-ink device: a matte grey panel, ink-on-paper
type, no colour and no motion except the refresh flash between pages. It reads pages
aloud, lights up the sentence being spoken, and always reopens on the line you stopped on.

## What it does

- **Reads PDFs** with [pdf.js](https://mozilla.github.io/pdf.js/), rendered to a canvas
  passed through a greyscale/contrast filter so it looks printed rather than backlit.
- **Reads them aloud** using the browser's own speech voices. Text is split into
  sentences, spoken one at a time, and the matching words on the page invert as they
  are read — the way a real panel inverts a selection. It turns the page by itself and
  keeps going.
- **Remembers the checkpoint** for every document: page, scroll position and sentence.
  Reopen a file and it resumes there; a toast offers to start over instead.
- **Bookmarks** any page, with the first line of the page as its label.
- **Three panel tones** — Paper, Bleached, Night ink — plus sharpen, fit and text size.

Files never leave the browser. PDFs are held in IndexedDB and checkpoints in
localStorage on the reader's own device; the server only serves static assets.

## Running it locally

```bash
npm install
npm start
```

Then open http://localhost:3000.

## Deploying to Render

Fastest route: **New → Blueprint**, pick this repository. Render reads
`render.yaml` and creates a static site.

### As a static site (recommended)

Nothing here needs a server at runtime, and a static site on the free plan does
not spin down between visits.

| Setting | Value |
| --- | --- |
| Build command | *(none)* |
| Publish directory | `public` |

`public/` is self-contained — pdf.js is committed under `public/vendor` — so
there is nothing to build and nothing to install. If Render insists on a build
command, `echo ok` will do.

If the host shows **Not Found**, the publish directory is wrong: it must be
`public`, the folder holding `index.html`, not the repository root and not
blank. Leave *Root Directory* empty unless the repository is nested.

### As a Node web service

`server.js` serves the same app and adds a health check. Use this if you would
rather deploy a server, or plan to add an API later.

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/healthz` |

It binds to `process.env.PORT`, which Render provides. No environment variables,
database or disk are required either way.

## Keyboard

| Key | Action |
| --- | --- |
| `←` `→` (or `j` `k`) | Turn the page |
| `Space` | Read aloud / pause |
| `B` | Bookmark this page |
| `Esc` | Close the drawer |

## Browser support

Rendering works anywhere pdf.js does. Reading aloud uses the Web Speech API — available
in Chrome, Edge and Safari; Firefox needs a system speech service installed. Where no
voices exist, the listening controls explain themselves and everything else still works.

## Layout

```
server.js                 Express: serves public/, plus /healthz
public/index.html         The device
public/css/paper.css      The panel: tokens, chrome, refresh flash
public/js/app.js          Rendering, paging, checkpoints, bookmarks, settings
public/js/tts.js          Sentence splitting and the speech queue
public/js/store.js        IndexedDB shelf + localStorage checkpoints
public/js/keep-drawing.js Keeps pdf.js drawing while the tab is hidden
public/vendor/            pdf.js, committed so public/ can be published as-is
tools/copy-vendor.mjs     Refreshes public/vendor after a pdfjs-dist upgrade
```

## Upgrading pdf.js

```bash
npm install pdfjs-dist@latest && npm run vendor
```

`npm run vendor` refreshes `public/vendor` from `node_modules`, taking only what
the reader fetches: the minified library and worker, the cmaps, and the standard
fonts. Commit the result — it is what gets published.
