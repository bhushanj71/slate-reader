# Slate

A web PDF reader built to an E-Ink-first design system, so that on any display — LCD,
OLED or otherwise — it reads as though it belongs on a Kindle or a Kobo. Warm paper
rather than white, charcoal rather than black, Literata for reading and IBM Plex Sans for
the controls. Flat surfaces, borders instead of shadows, one muted accent, and no
gradients, blur, glow or motion beyond a brief refresh. It reads pages aloud in a human
voice, lights up the sentence being spoken, and always reopens on the line you stopped on.

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
- **Changes pages the way a panel does.** The outgoing spread is copied and laid over the
  new one while it is drawn, so nothing blank is ever on screen; the copy then thins out
  over 200ms and the new page is simply there. No flip, no slide, nothing to sit and
  watch. The hard clearing flash a panel does is under **Panel → Refresh flash**, off by
  default. A faint ghost of the previous page is left behind, as a real panel leaves one.
- **Opens full screen**, so the book has the whole display and nothing else does. The
  Fullscreen API is used where it is allowed and the page fills the window regardless,
  which is what makes this work on an iPhone, where a page cannot request fullscreen.
- **Three panel tones** — Paper, Bleached, Night ink — plus sharpen, fit and text size.

Your PDFs never leave the browser: they are held in IndexedDB and the checkpoints in
localStorage, on the reader's own device. The server hands out static files, and — only
if a key is configured — turns one sentence at a time into audio. It stores nothing.

## Running it locally

```bash
npm install
npm start
```

Then open http://localhost:3000.

## Deploying to Render

Fastest route: **New → Blueprint**, pick this repository. Render reads
`render.yaml` and creates a Node web service, then set `ELEVENLABS_API_KEY` in the
dashboard if you want the studio voice.

### As a static site (no server, no studio voice)

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

It binds to `process.env.PORT`, which Render provides. No database or disk is needed
either way. The only environment variable that does anything is `ELEVENLABS_API_KEY`,
and without it Slate simply reads in the browser's own voices.

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

### The studio voice

Slate can read in an ElevenLabs voice instead of the browser's. When the server has a
key it is offered under **Panel → Read by** and chosen by default, starting on a voice
labelled for narration rather than whatever the API lists first. Every voice the account
owns is listed there with its description and its accent, age and intended use, and each
has a **Preview** — those samples come from ElevenLabs' own CDN, so listening costs
nothing. Without a key the studio option never appears at all.

**The key stays on the server.** The browser asks `/api/voice/speak` for a
sentence and gets back audio; it never sees the key. A key shipped in front-end
code is readable by anyone who visits the page, which is the same as publishing
it — so the studio voice requires the Node web service, not the static site.

Set `ELEVENLABS_API_KEY` in the Render dashboard (never in the repository), or
in a local `.env` — see `.env.example`, and note `.gitignore` excludes it.

Because that endpoint spends real money on a public URL, it is bounded in four
ways: 1200 characters per request, `ELEVENLABS_CALLER_LIMIT` per caller per hour
(default 30k), `ELEVENLABS_DAILY_LIMIT` for everyone per day (default 150k), and
identical sentences are served from a cache rather than bought twice. Only voices
the account actually owns can be requested, so the endpoint cannot be used as an
open proxy. If the budget runs out, the network drops, or the browser refuses to
autoplay, the reading continues in the device voice from the same sentence.

Reading a book this way is not free: a page of dense prose is roughly 2–3k
characters.

### Getting a better voice on the device

How human it sounds depends on which voices the machine has, not on this app. Slate
scores what the browser offers and picks the most natural, preferring neural voices and
skipping the old formant ones, but it can only choose from what is installed. On Windows,
**Settings → Accessibility → Narrator → Add natural voices** installs voices in a
different class from the default set; Chrome and Edge also offer cloud voices. Any voice
can be chosen by hand under **Panel → Voice**.

## Layout

```
server.js                 Express: serves public/, /healthz, and the voice proxy
public/index.html         The device
public/css/paper.css      The design system: tokens, chrome, the refresh
public/js/app.js          Rendering, paging, checkpoints, bookmarks, settings
public/js/tts.js          Sentence splitting, the speech queue and its pauses
public/js/speech-text.js  Typeset text turned into words a voice can say
public/js/cloud-voice.js  Plays studio audio fetched a sentence at a time
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
