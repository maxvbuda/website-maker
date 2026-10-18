/* SiteSlides publish server (Cloudflare Worker).
 *
 * Receives a site from the editor and commits it to GitHub at <repo>/<slug>/, so it is
 * served at PAGES_BASE + slug + '/'. The GitHub token lives only here, as a secret.
 *
 * Safety rules:
 *  - Only writes inside a site folder that it created (marked by OWNER_FILE). Anything
 *    else in the repo — the editor, this worker, hand-made folders — can't be touched.
 *  - A site can only be updated by whoever holds its owner key (only a hash is stored).
 *  - Only page HTML, style.css and PNG/JPEG/GIF/WebP images are accepted (checked by content).
 *  - Every page gets a Content-Security-Policy that blocks all JavaScript except the
 *    editor's own fit.js, so no published page can run code on the shared github.io origin.
 *  - HTML boxes are stored as .txt (GitHub Pages serves them as plain text, never run) and
 *    are served by GET /box/<slug>/<n> from this worker's own origin with a sandbox policy,
 *    so their scripts can run without ever touching the github.io origin.
 *  - Size and rate limits.
 *
 * Every publish also updates SITES_FILE, the list the gallery page reads.
 */

const OWNER_FILE = '.siteslides-owner';
const SITES_FILE = 'sites.json';
const BOX_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const PAGE_RE = /^[a-z0-9][a-z0-9-]{0,60}\.html$/;
const ASSET_RE = /^assets\/image-\d{1,4}\.(png|jpg|gif|webp)$/;
const BOX_RE = /^boxes\/\d{1,4}\.txt$/;
const RESERVED = new Set(['worker', 'assets', 'api', 'admin', 'www', 'static', 'node_modules', 'gallery', 'boxes']);
const MAX_PAGES = 30;
const MAX_IMAGES = 30; // each image is one GitHub API call; Workers allow 50 per request
const MAX_BOXES = 100;
const MAX_TOTAL = 10 * 1024 * 1024;
const MAX_TEXT = 2 * 1024 * 1024;

const MAGIC = {
  png: [[0x89, 0x50, 0x4e, 0x47]],
  jpg: [[0xff, 0xd8, 0xff]],
  gif: [[0x47, 0x49, 0x46, 0x38]],
  webp: [[0x52, 0x49, 0x46, 0x46]],
};

class PublishError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new PublishError(status, message); };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', ...CORS },
});

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname.startsWith('/box/')) return serveBox(url, env);
    if (req.method !== 'POST' || url.pathname !== '/publish') return json({ error: 'Not found' }, 404);

    if (env.PUBLISH_LIMIT) {
      const { success } = await env.PUBLISH_LIMIT.limit({ key: req.headers.get('CF-Connecting-IP') || 'unknown' });
      if (!success) return json({ error: 'Too many publishes in a row. Wait a minute and try again.' }, 429);
    }
    if (Number(req.headers.get('Content-Length') || 0) > MAX_TOTAL * 1.4) {
      return json({ error: 'Your site is too big to publish (limit 10 MB). Try using smaller images.' }, 413);
    }

    let body;
    try {
      body = await req.json();
    } catch (err) {
      return json({ error: 'Bad request.' }, 400);
    }
    try {
      return json(await publish(body, env));
    } catch (err) {
      if (err instanceof PublishError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Publishing failed. Please try again in a moment.' }, 502);
    }
  },
};

async function serveBox(url, env) {
  const m = url.pathname.match(/^\/box\/([a-z0-9-]{1,50})\/(\d{1,4})$/);
  if (!m || !SLUG_RE.test(m[1])) return new Response('Not found', { status: 404 });
  // The version in ?v= changes whenever the box changes, so cached copies never go stale.
  const v = (url.searchParams.get('v') || '').replace(/[^a-z0-9]/g, '').slice(0, 16);
  const res = await fetch(`${env.PAGES_BASE}${m[1]}/boxes/${m[2]}.txt?v=${v}`, {
    cf: { cacheTtlByStatus: { '200-299': 3600, '300-599': 0 } },
  });
  if (!res.ok) return new Response('This box isn’t published yet. Reload in a minute.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new Response(res.body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': BOX_SANDBOX,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': v ? 'public, max-age=3600' : 'public, max-age=60',
    },
  });
}

function validate(body, env) {
  const slug = typeof body.slug === 'string' ? body.slug : '';
  if (!SLUG_RE.test(slug)) fail(400, 'Site names can only use lowercase letters, numbers and dashes.');
  if (RESERVED.has(slug)) fail(409, `“${slug}” is reserved. Pick another site name.`);
  if (!Array.isArray(body.files)) fail(400, 'Bad request.');

  const csp = `<meta http-equiv="Content-Security-Policy" content="script-src ${env.PAGES_BASE}fit.js; object-src 'none'; base-uri 'none'">`;
  const names = new Set();
  const text = [];
  const images = [];
  let total = 0;
  for (const f of body.files) {
    const name = typeof f?.name === 'string' ? f.name : '';
    if (names.has(name)) fail(400, `Duplicate file: ${name}`);
    names.add(name);
    const isPage = PAGE_RE.test(name);
    const asset = name.match(ASSET_RE);
    if (isPage || name === 'style.css' || BOX_RE.test(name)) {
      if (typeof f.text !== 'string' || f.text.length > MAX_TEXT) fail(400, `${name} is too big.`);
      total += f.text.length;
      text.push({ name, content: isPage ? withCsp(f.text, csp) : f.text });
    } else if (asset) {
      const b64 = typeof f.base64 === 'string' ? f.base64 : '';
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64.slice(0, 4096)) || !hasMagic(b64, MAGIC[asset[1]])) {
        fail(400, `${name} isn’t a valid image.`);
      }
      total += Math.ceil(b64.length * 0.75);
      images.push({ name, base64: b64 });
    } else {
      fail(400, `This file can’t be published: ${name}`);
    }
    if (total > MAX_TOTAL) fail(413, 'Your site is too big to publish (limit 10 MB). Try using smaller images.');
  }
  if (!names.has('index.html')) fail(400, 'Your site needs a home page.');
  if (text.length > MAX_PAGES + 1) fail(400, `A site can have at most ${MAX_PAGES} pages.`);
  if (images.length > MAX_IMAGES) fail(400, `A site can have at most ${MAX_IMAGES} images.`);
  if (text.filter((f) => BOX_RE.test(f.name)).length > MAX_BOXES) fail(400, `A site can have at most ${MAX_BOXES} HTML boxes.`);
  const title = (typeof body.title === 'string' ? body.title : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || slug;

  const ownerKey = typeof body.ownerKey === 'string' && /^[a-f0-9]{64}$/.test(body.ownerKey) ? body.ownerKey : null;
  return { slug, title, text, images, ownerKey };
}

// The policy must come before anything the page author wrote. Right after the doctype keeps
// standards mode; the parser moves the <meta> into <head> automatically.
function withCsp(html, csp) {
  const m = html.match(/^﻿?\s*<!doctype html>/i);
  return m ? `${m[0]}\n${csp}${html.slice(m[0].length)}` : `${csp}\n${html}`;
}

function hasMagic(b64, signatures) {
  let head;
  try {
    head = atob(b64.slice(0, 16));
  } catch (err) {
    return false;
  }
  return signatures.some((sig) => sig.every((byte, i) => head.charCodeAt(i) === byte));
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function github(env) {
  const base = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  return async (path, opts = {}) => {
    const res = await fetch(base + path, {
      ...opts,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'siteslides-publish',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status} on ${path}: ${await res.text()}`);
      err.githubStatus = res.status;
      throw err;
    }
    return res.json();
  };
}

async function publish(body, env) {
  const { slug, title, text, images, ownerKey } = validate(body, env);
  const gh = github(env);
  const branch = encodeURIComponent(env.GITHUB_BRANCH);

  // Upload images once; blob SHAs stay valid if the commit has to be retried.
  const imageEntries = [];
  for (const img of images) {
    const blob = await gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content: img.base64, encoding: 'base64' }) });
    imageEntries.push({ path: `${slug}/${img.name}`, mode: '100644', type: 'blob', sha: blob.sha });
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const ref = await gh(`/git/ref/heads/${branch}`);
    const baseCommit = await gh(`/git/commits/${ref.object.sha}`);
    const root = await gh(`/git/trees/${baseCommit.tree.sha}`);
    const existing = root.tree.find((t) => t.path === slug);

    let key = ownerKey;
    let oldFiles = [];
    if (existing) {
      if (existing.type !== 'tree') fail(409, `“${slug}” is already taken. Pick another site name.`);
      const folder = await gh(`/git/trees/${existing.sha}?recursive=1`);
      const owner = folder.tree.find((t) => t.path === OWNER_FILE);
      if (!owner || !ownerKey) fail(409, `“${slug}” is already taken. Pick another site name.`);
      const stored = atob((await gh(`/git/blobs/${owner.sha}`)).content.replace(/\n/g, '')).trim();
      if (stored !== await sha256Hex(ownerKey)) fail(409, `“${slug}” is already taken. Pick another site name.`);
      oldFiles = folder.tree.filter((t) => t.type === 'blob' && t.path !== OWNER_FILE).map((t) => `${slug}/${t.path}`);
    } else if (!key) {
      key = randomHex(32);
    }

    const sitesEntry = root.tree.find((t) => t.path === SITES_FILE && t.type === 'blob');
    let sites = [];
    if (sitesEntry) {
      try {
        const raw = (await gh(`/git/blobs/${sitesEntry.sha}`)).content.replace(/\n/g, '');
        sites = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))));
        if (!Array.isArray(sites)) sites = [];
      } catch (err) {
        sites = [];
      }
    }
    sites = [{ slug, title, updated: new Date().toISOString() }, ...sites.filter((s) => s && s.slug !== slug)];

    const entries = [
      { path: SITES_FILE, mode: '100644', type: 'blob', content: `${JSON.stringify(sites, null, 1)}\n` },
      ...text.map((f) => ({ path: `${slug}/${f.name}`, mode: '100644', type: 'blob', content: f.content })),
      ...imageEntries,
      { path: `${slug}/${OWNER_FILE}`, mode: '100644', type: 'blob', content: `${await sha256Hex(key)}\n` },
    ];
    const keep = new Set(entries.map((e) => e.path));
    for (const p of oldFiles) if (!keep.has(p)) entries.push({ path: p, mode: '100644', type: 'blob', sha: null });

    const tree = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: entries }) });
    const commit = await gh('/git/commits', {
      method: 'POST',
      body: JSON.stringify({ message: `Publish ${slug}`, tree: tree.sha, parents: [ref.object.sha] }),
    });
    try {
      await gh(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
    } catch (err) {
      if (err.githubStatus === 422 && attempt === 0) continue; // someone else committed first; rebuild on top
      throw err;
    }
    return { url: `${env.PAGES_BASE}${slug}/`, ownerKey: key };
  }
  fail(503, 'The site is busy. Please click Publish again.');
}
