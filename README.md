# SiteSlides

Build a website the way you build a slide deck. Each slide is a page; drag headings, text, buttons, images, shapes — or your own HTML — anywhere on it, then export plain static HTML.

**Use it:** https://maxvbuda.github.io/website-maker/ (or just open `index.html` locally — no build step, no dependencies).

## Features
- Slide-style page list: add, duplicate, reorder (drag), delete; the first page is `index.html`
- Drag, resize and snap-to-guides on a 1200px canvas; right-click menu, undo/redo, copy/paste
- Style panel: fonts, colors, alignment, padding, fill, corners, border, shadow, opacity
- **HTML boxes:** click **HTML**, drag a box anywhere, and type your own code — it exports as a `<div>` at that exact spot and size
- Links to other pages or any URL
- Preview at desktop / tablet / phone sizes
- **Publish** in one click to `maxvbuda.github.io/website-maker/<site-name>/` — no login (see *Publishing server* below)
- Export a `.zip` (HTML pages + `style.css` + images) ready for Netlify, GitHub Pages or any host
- Autosaves in the browser; save/open project `.json` files
- Interactive tutorial on first visit (reopen with the **Tutorial** button)

## Publishing server

`worker/` is a Cloudflare Worker that receives a site from the editor and commits it to this repo
under `<site-name>/`. The GitHub token lives only in the worker as a secret. For safety it:

- only writes inside site folders it created, so the editor and anything else in the repo can't be touched
- gives each site a secret owner key (kept automatically in the publisher's browser), so only that browser can update it
- accepts only page HTML, `style.css` and PNG/JPEG/GIF/WebP images (checked by content), with size and rate limits
- adds a Content-Security-Policy to every published page that blocks all JavaScript except `fit.js`

One-time setup:

```sh
cd worker
npx wrangler login
npx wrangler secret put GITHUB_TOKEN   # fine-grained token: only this repo, Contents: Read and write
npx wrangler deploy
```

Then set `PUBLISH_API` at the top of `app.js` to the deployed `https://…workers.dev` URL.
