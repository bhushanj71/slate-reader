# Slate

A web PDF reader with the manners of an e-ink device, drawn from a photograph of a real
one: true black on cool grey paper, heavy grotesque capitals, monospace everywhere else,
one stroke weight, and no colour at all. Where a grey is wanted the pixels are dithered,
because a panel has no mid-tones to give. It reads pages aloud in a human voice, lights
up the sentence being spoken, and always reopens on the line you stopped on.

## What it does

- **Reads PDFs** with [pdf.js](https://mozilla.github.io/pdf.js/), rendered to a canvas
  passed through a greyscale/contrast filter so it looks printed rather than backlit.
- **Reads them aloud** like a person, not a screen reader. A PDF is typeset for eyes,
  so the text is rewritten for a voice before it is spoken: ligatures and words broken
  across lines are repaired, `Fig. 4` becomes "Figure 4" and `e.g.` becomes "for
  example", bracketed citations and URLs stop being read out, and bare page numbers and
  leader dots are skipped. It rests between sentences, longer between paragraphs, and
  longer still after a heading — which it finds by watching the type size, since nothing
  in the extracted text says where one is. The matching words invert on the page as they
  are read, the way a real panel inverts a selection, and it turns the page by itself.
- **Remembers the checkpoint** for every document: page, scroll position and sentence.
  Reopen a file and it resumes there; a toast offers to start over instead.
- **Bookmarks** any page, with the first line of the page as its label.
- **Turns leaves, not slides.** The outgoing spread is copied and laid over the new one
  while it is drawn, so nothing blank is ever on screen between two pages; the copy then
  pivots on the spine and leaves the faint ghost a panel leaves behind. The hard refresh
  flash a real panel does is still there under **Panel → Refresh flash**, off by default
  because it fights the turn.
- **Opens full screen**, so the book has the whole display and nothing else does. The
  Fullscreen API is used where it is allowed and the page fills the window regardless,
  which is what makes this work on an iPhone, where a page cannot request fullscreen.
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
| `F` | Full screen |
| `H` | Hide the controls |
| `Esc` | Close the drawer |

## Browser support

Rendering works anywhere pdf.js does. Reading aloud uses the Web Speech API — available
in Chrome, Edge and Safari; Firefox needs a system speech service installed. Where no
voices exist, the listening controls explain themselves and everything else still works.

### Getting a better voice

How human it sounds depends on which voices the machine has, not on this app. Slate
scores what the browser offers and picks the most natural, preferring neural voices and
skipping the old formant ones, but it can only choose from what is installed. On Windows,
**Settings → Accessibility → Narrator → Add natural voices** installs voices in a
different class from the default set; Chrome and Edge also offer cloud voices. Any voice
can be chosen by hand under **Panel → Voice**.

## Layout

```
server.js                 Express: serves public/, plus /healthz
public/index.html         The device
public/css/paper.css      The panel: tokens, chrome, the leaf turn
public/js/app.js          Rendering, paging, checkpoints, bookmarks, settings
public/js/tts.js          Sentence splitting, the speech queue and its pauses
public/js/speech-text.js  Typeset text turned into words a voice can say
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
