/* SiteSlides — a slide-style editor for static websites.
 * No build step, no dependencies: open index.html in a browser. */
(() => {
  'use strict';

  // ---------- Constants ----------
  const PAGE_W = 1200;
  const STORAGE_KEY = 'siteslides.project.v1';
  const TUTORIAL_KEY = 'siteslides.tutorialDone.v1';
  const OWNER_KEYS = 'siteslides.ownerKeys.v1';
  // Publishing server (see worker/). Empty turns Publish off.
  const PUBLISH_API = 'https://siteslides-publish.maxvbuda.workers.dev';
  const PAGES_BASE = 'https://maxvbuda.github.io/website-maker/';
  const SNAP = 6; // screen pixels
  const FONTS = ['Inter', 'Poppins', 'Montserrat', 'Playfair Display', 'Lora', 'Space Mono', 'Georgia', 'Arial', 'Verdana', 'Times New Roman', 'Courier New'];
  const GOOGLE_FONTS = {
    'Inter': 'Inter:wght@400;700',
    'Poppins': 'Poppins:ital,wght@0,400;0,700;1,400',
    'Montserrat': 'Montserrat:ital,wght@0,400;0,700;1,400',
    'Playfair Display': 'Playfair+Display:ital,wght@0,400;0,700;1,400',
    'Lora': 'Lora:ital,wght@0,400;0,700;1,400',
    'Space Mono': 'Space+Mono:ital,wght@0,400;0,700;1,400',
  };
  const SERIF = new Set(['Playfair Display', 'Lora', 'Georgia', 'Times New Roman']);
  const MONO = new Set(['Space Mono', 'Courier New']);
  const VALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };
  const TEXTUAL = new Set(['heading', 'text', 'button']);
  const TYPE_LABELS = { heading: 'Heading', text: 'Text', button: 'Button', image: 'Image', shape: 'Shape', ellipse: 'Circle', line: 'Line', html: 'HTML box' };

  // CSS shared by exported pages and the preview.
  const SITE_CSS = `*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{overflow-x:hidden;-webkit-font-smoothing:antialiased}
.site-viewport{position:relative;width:100%;overflow:hidden}
.site-page{position:relative;width:${PAGE_W}px;margin:0 auto;transform-origin:0 0;overflow:hidden}
.el{position:absolute;overflow:hidden;display:block}
.el-text{width:100%;overflow-wrap:break-word}
.el-text p{margin:0}
.el img{width:100%;height:100%;display:block}
.el-html-frame{width:100%;height:100%;border:0;display:block;background:transparent}
a.el{text-decoration:none;cursor:pointer;transition:filter .15s ease,transform .15s ease}
a.el:hover{filter:brightness(1.08)}
a.el-button:hover{transform:translateY(-1px)}
`;

  // Scales the fixed-width page down to fit narrow screens. Published pages use fit.js instead.
  const FIT_SCRIPT = `(function(){var v=document.querySelector('.site-viewport'),p=document.querySelector('.site-page');function f(){var w=document.documentElement.clientWidth;if(!w)return;var s=Math.min(1,w/${PAGE_W});p.style.transform=s<1?'scale('+s+')':'';p.style.marginLeft=s<1?'0':'';v.style.height=(p.offsetHeight*s)+'px'}window.addEventListener('resize',f);window.addEventListener('load',f);f()})();`;

  // ---------- Helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const slugify = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
  const fontStack = (f) => `'${f}', ${SERIF.has(f) ? 'serif' : MONO.has(f) ? 'monospace' : 'sans-serif'}`;
  const bus = new EventTarget();
  const emit = (name) => bus.dispatchEvent(new Event(name));

  // ---------- State ----------
  let site;
  let currentPageId;
  let selectedId = null;
  let editingId = null;
  let zoom = 'fit';
  let scale = 1;
  let clipboard = null;
  let drawMode = null;
  let codeTargetId = null;
  let imageTargetId = null;
  let ctxPageId = null;
  const undoStack = [];
  const redoStack = [];
  let lastPush = { t: 0, key: null };

  const stage = $('#stage');
  const stageWrap = $('#stage-wrap');
  const workspace = $('#workspace');
  const propsEl = $('#props');

  const currentPage = () => site.pages.find((p) => p.id === currentPageId) || site.pages[0];
  const findEl = (id) => currentPage().elements.find((e) => e.id === id);
  const selected = () => (selectedId ? findEl(selectedId) : null);
  const nodeFor = (id) => stage.querySelector(`.el[data-id="${id}"]`);

  // ---------- Model ----------
  function baseStyle() {
    return {
      font: 'Inter', size: 18, color: '#1f2937', bold: false, italic: false, underline: false,
      align: 'left', valign: 'top', lineHeight: 1.5, padding: 0,
      bg: '', radius: 0, borderW: 0, borderColor: '#d1d5db', opacity: 100, shadow: false, fit: 'cover',
    };
  }

  const DEFAULTS = {
    heading: { w: 700, h: 80, content: 'Your headline here', style: { font: 'Poppins', size: 48, bold: true, color: '#111827', lineHeight: 1.15 } },
    text: { w: 500, h: 110, content: 'Double-click to write. Drag me anywhere on the page.', style: { size: 18, color: '#4b5563' } },
    button: { w: 200, h: 54, content: 'Click me', style: { size: 17, bold: true, color: '#ffffff', bg: '#4f46e5', radius: 10, align: 'center', valign: 'middle', lineHeight: 1.2, padding: 8 } },
    image: { w: 420, h: 280, src: '', alt: '', style: { radius: 8 } },
    shape: { w: 320, h: 200, style: { bg: '#e0e7ff', radius: 12 } },
    ellipse: { w: 200, h: 200, style: { bg: '#fde68a' } },
    line: { w: 400, h: 4, style: { bg: '#d1d5db', radius: 2 } },
    html: {
      w: 420, h: 220,
      code: '<div style="height:100%;display:flex;align-items:center;justify-content:center;\n  background:linear-gradient(135deg,#6366f1,#ec4899);color:white;\n  font:600 22px system-ui;border-radius:12px">\n  Hello from my own HTML!\n</div>',
    },
  };

  function makeElement(type, over = {}) {
    const d = clone(DEFAULTS[type]);
    const el = {
      id: uid(), type, x: 0, y: 0, w: d.w, h: d.h,
      style: Object.assign(baseStyle(), d.style || {}, over.style || {}),
      link: { type: 'none', url: '', pageId: '', newTab: false },
    };
    if (TEXTUAL.has(type)) el.content = d.content;
    if (type === 'image') { el.src = d.src; el.alt = d.alt; }
    if (type === 'html') el.code = d.code;
    const { style, ...rest } = over;
    return Object.assign(el, rest);
  }

  function makePage(name, height = 900) {
    return { id: uid(), name, bg: '#ffffff', height, elements: [] };
  }

  function starterSite() {
    const home = makePage('Home', 980);
    const about = makePage('About', 760);
    const E = (type, o) => makeElement(type, o);
    home.elements.push(
      E('shape', { x: 0, y: 0, w: 1200, h: 560, style: { bg: '#eef2ff', radius: 0 } }),
      E('ellipse', { x: 790, y: 110, w: 320, h: 320, style: { bg: '#c7d2fe' } }),
      E('ellipse', { x: 930, y: 290, w: 170, h: 170, style: { bg: '#fde68a' } }),
      E('text', { x: 100, y: 120, w: 300, h: 30, content: 'WELCOME', style: { size: 14, bold: true, color: '#4f46e5', lineHeight: 2 } }),
      E('heading', { x: 100, y: 160, w: 640, h: 140, content: 'Build a website the way you build slides', style: { size: 52 } }),
      E('text', { x: 100, y: 320, w: 560, h: 64, content: 'Drag things around, click to style them, and export real HTML when you\'re done.', style: { size: 20 } }),
      E('button', { x: 100, y: 420, w: 210, h: 56, content: 'About us →', link: { type: 'page', url: '', pageId: about.id, newTab: false } }),
      E('heading', { x: 100, y: 630, w: 1000, h: 50, content: 'Why you\'ll love it', style: { size: 34, align: 'center' } }),
      ...[['No code', 'If you can make a slide deck, you can make a website.'], ['Real HTML', 'Export plain files that work on any web host.'], ['Your own code', 'Drop in an HTML box when you want something custom.']]
        .map(([t, b], i) => E('text', {
          x: 100 + i * 345, y: 720, w: 310, h: 170,
          content: `<b style="font-size:20px;color:#111827">${t}</b><br>${b}`,
          style: { size: 16, bg: '#ffffff', radius: 14, padding: 24, borderW: 1, borderColor: '#e5e7eb', shadow: true },
        })),
    );
    about.elements.push(
      E('heading', { x: 100, y: 100, w: 700, h: 70, content: 'About us' }),
      E('line', { x: 100, y: 190, w: 80, h: 5, style: { bg: '#4f46e5' } }),
      E('text', { x: 100, y: 230, w: 620, h: 180, content: 'Tell visitors who you are and what you do. Every page in SiteSlides is a blank canvas — headings, text, images, buttons and your own HTML can go anywhere.', style: { size: 19, lineHeight: 1.7 } }),
      E('image', { x: 780, y: 100, w: 320, h: 400, style: { radius: 16 } }),
      E('button', { x: 100, y: 450, w: 200, h: 54, content: '← Back home', style: { bg: '#111827' }, link: { type: 'page', url: '', pageId: home.id, newTab: false } }),
    );
    return { title: 'My Website', pages: [home, about] };
  }

  function blankSite() {
    return { title: 'My Website', pages: [makePage('Home')] };
  }

  // ---------- Rendering elements (shared by editor, thumbnails, preview and export) ----------
  function elementCSS(el) {
    const s = el.style;
    const css = [`left:${el.x}px`, `top:${el.y}px`, `width:${el.w}px`, `height:${el.h}px`];
    if (TEXTUAL.has(el.type)) {
      css.push(
        `font-family:${fontStack(s.font)}`, `font-size:${s.size}px`, `color:${s.color}`,
        `font-weight:${s.bold ? 700 : 400}`, `font-style:${s.italic ? 'italic' : 'normal'}`,
        `text-decoration:${s.underline ? 'underline' : 'none'}`, `text-align:${s.align}`,
        `line-height:${s.lineHeight}`, `padding:${s.padding || 0}px`,
        'display:flex', 'flex-direction:column', `justify-content:${VALIGN[s.valign] || 'flex-start'}`,
      );
    }
    if (s.bg) css.push(`background:${s.bg}`);
    if (el.type === 'ellipse') css.push('border-radius:50%');
    else if (s.radius) css.push(`border-radius:${s.radius}px`);
    if (s.borderW) css.push(`border:${s.borderW}px solid ${s.borderColor}`);
    if (s.opacity < 100) css.push(`opacity:${s.opacity / 100}`);
    if (s.shadow) css.push('box-shadow:0 12px 32px rgba(15,23,42,.16)');
    return css.join(';');
  }

  const PLACEHOLDER_IMG = '<div class="img-placeholder"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10" r="2" fill="currentColor"/><path d="M4 18l5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>Double-click to add an image</div>';

  // `lazy` loads fonts without blocking rendering (used inside the editor's iframes and preview).
  function fontLinkTag(fonts, lazy = false) {
    const fams = [...fonts].filter((f) => GOOGLE_FONTS[f]).map((f) => `family=${GOOGLE_FONTS[f]}`);
    if (!fams.length) return '';
    const href = `https://fonts.googleapis.com/css2?${fams.join('&')}&display=swap`;
    return lazy ? `<link rel="stylesheet" href="${href}" media="print" onload="this.media='all'">` : `<link rel="stylesheet" href="${href}">`;
  }

  // HTML boxes run in their own frame so their styles and scripts can't break the rest of the page.
  // A full document (with <html> or a doctype) is used as written; a snippet gets a blank page around it.
  function htmlFrameDoc(code) {
    code = code || '';
    if (/^\s*(<!--[\s\S]*?-->\s*)*<(!doctype|html)[\s>]/i.test(code)) return code;
    return `<!doctype html><html><head><meta charset="utf-8">${fontLinkTag(Object.keys(GOOGLE_FONTS), true)}<style>*{box-sizing:border-box}html,body{margin:0;padding:0;height:100%;background:transparent}</style></head><body>${code}</body></html>`;
  }

  const BOX_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock';

  function hashText(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
  }

  // mode: 'editor' | 'thumb' | 'preview' | 'export'
  function elementInner(el, mode, ctx) {
    if (TEXTUAL.has(el.type)) return `<div class="el-text">${el.content || ''}</div>`;
    if (el.type === 'image') {
      if (el.src) {
        const src = mode === 'export' && ctx.assets.has(el.src) ? ctx.assets.get(el.src) : el.src;
        return `<img src="${esc(src)}" alt="${esc(el.alt)}" style="object-fit:${el.style.fit}" draggable="false">`;
      }
      return mode === 'editor' || mode === 'thumb' ? PLACEHOLDER_IMG : '';
    }
    if (el.type === 'html') {
      if (mode === 'editor') return `<iframe class="el-html-frame" tabindex="-1" sandbox="allow-scripts" srcdoc="${esc(htmlFrameDoc(el.code))}"></iframe>`;
      if (mode === 'thumb') return '<div class="html-thumb">&lt;/&gt;</div>';
      // Published pages block scripts, so their boxes are served from the publishing server instead.
      const box = ctx.boxes?.get(el.id);
      if (box) return `<iframe class="el-html-frame" title="HTML box" sandbox="${BOX_SANDBOX}" src="${esc(`${PUBLISH_API}/box/${ctx.slug}/${box.n}?v=${box.v}`)}"></iframe>`;
      return `<iframe class="el-html-frame" title="HTML box" sandbox="${BOX_SANDBOX}" srcdoc="${esc(htmlFrameDoc(el.code))}"></iframe>`;
    }
    return '';
  }

  function normalizeUrl(u) {
    u = (u || '').trim();
    if (!u) return '';
    if (/^([a-z][a-z0-9+.-]*:|\/|#|\.)/i.test(u)) return u;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u)) return `mailto:${u}`;
    return `https://${u}`;
  }

  function linkAttrs(el, mode, ctx) {
    const l = el.link;
    if (!l || l.type === 'none' || (mode !== 'export' && mode !== 'preview') || el.type === 'html') return null;
    if (l.type === 'page') {
      if (!site.pages.some((p) => p.id === l.pageId)) return null;
      return mode === 'preview' ? ` href="#" data-page="${esc(l.pageId)}"` : ` href="${esc(ctx.files.get(l.pageId))}"`;
    }
    const href = normalizeUrl(l.url);
    if (!href) return null;
    return ` href="${esc(href)}"${l.newTab ? ' target="_blank" rel="noopener"' : ''}`;
  }

  function elementHTML(el, mode, ctx = {}) {
    const attrs = linkAttrs(el, mode, ctx);
    const tag = attrs ? 'a' : 'div';
    return `<${tag} class="el el-${el.type}"${attrs || ''} style="${esc(elementCSS(el))}">${elementInner(el, mode, ctx)}</${tag}>`;
  }

  function pageFiles() {
    const map = new Map();
    const used = new Set(['index']);
    site.pages.forEach((p, i) => {
      if (i === 0) { map.set(p.id, 'index.html'); return; }
      const base = slugify(p.name);
      let s = base;
      let k = 2;
      while (used.has(s)) s = `${base}-${k++}`;
      used.add(s);
      map.set(p.id, `${s}.html`);
    });
    return map;
  }

  function buildPageDoc(page, mode, ctx = {}) {
    const fonts = new Set(page.elements.filter((e) => TEXTUAL.has(e.type)).map((e) => e.style.font));
    const css = mode === 'export' ? '<link rel="stylesheet" href="style.css">' : `<style>${SITE_CSS}</style>`;
    const nav = mode === 'preview'
      ? `<script>document.addEventListener('click',function(e){var a=e.target.closest('a');if(!a)return;var p=a.getAttribute('data-page');if(p){e.preventDefault();parent.postMessage({siteslidesNav:p},'*')}else if(!a.target){a.target='_blank'}});<\/script>`
      : '';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.name)} · ${esc(site.title)}</title>
${fontLinkTag(fonts, mode === 'preview')}
${css}
</head>
<body style="background:${esc(page.bg)}">
<div class="site-viewport">
<div class="site-page" style="height:${page.height}px;background:${esc(page.bg)}">
${page.elements.map((e) => elementHTML(e, mode, ctx)).join('\n')}
</div>
</div>
${ctx.publish ? '<script src="../fit.js"></script>' : `<script>${FIT_SCRIPT}<\/script>`}
${nav}
</body>
</html>
`;
  }

  // ---------- Persistence & history ----------
  let saveTimer = null;
  let warnedQuota = false;
  function save() {
    $('#save-status').textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ site, currentPageId }));
        $('#save-status').textContent = 'All changes saved';
      } catch (err) {
        $('#save-status').textContent = 'Not saved';
        if (!warnedQuota) {
          warnedQuota = true;
          toast('Browser storage is full (big images?). Use File → Save project to keep your work.', 5000);
        }
      }
    }, 300);
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.site && Array.isArray(data.site.pages) && data.site.pages.length) {
          site = data.site;
          currentPageId = data.currentPageId;
          return;
        }
      }
    } catch (err) { /* fall through to starter */ }
    site = starterSite();
    currentPageId = site.pages[0].id;
  }

  const snapshot = () => JSON.stringify({ site, currentPageId });

  // `key` coalesces rapid edits to the same thing (e.g. typing in a field) into one undo step.
  function pushHistory(key = null) {
    const now = Date.now();
    if (key && key === lastPush.key && now - lastPush.t < 1000) { lastPush.t = now; return; }
    undoStack.push(snapshot());
    if (undoStack.length > 150) undoStack.shift();
    redoStack.length = 0;
    lastPush = { t: now, key };
    updateToolbar();
  }

  function restore(snap) {
    const data = JSON.parse(snap);
    site = data.site;
    currentPageId = site.pages.some((p) => p.id === data.currentPageId) ? data.currentPageId : site.pages[0].id;
    if (selectedId && !findEl(selectedId)) selectedId = null;
    editingId = null;
    lastPush = { t: 0, key: null };
    renderAll();
    save();
  }

  function undo() {
    if (editingId) stopEditing();
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
  }

  function changed({ thumbs = true } = {}) {
    save();
    if (thumbs) scheduleThumbs();
    updateToolbar();
  }

  // ---------- Stage ----------
  function layoutStage() {
    const page = currentPage();
    if (zoom === 'fit') {
      const avail = workspace.clientWidth - 80;
      scale = clamp(avail / PAGE_W, 0.2, 1);
    } else {
      scale = parseFloat(zoom);
    }
    stage.style.transform = `scale(${scale})`;
    stage.style.height = `${page.height}px`;
    stage.style.background = page.bg;
    stage.style.setProperty('--s', 1 / scale);
    stageWrap.style.width = `${PAGE_W * scale}px`;
    stageWrap.style.height = `${page.height * scale}px`;
    $('#page-resizer').style.width = `${PAGE_W * scale}px`;
    $('#page-height-label').textContent = `${page.height}px tall — drag to resize`;
  }

  function createNode(el) {
    const n = document.createElement('div');
    n.dataset.id = el.id;
    paintNode(n, el);
    return n;
  }

  function paintNode(n, el) {
    n.className = `el el-${el.type}${editingId === el.id ? ' editing' : ''}`;
    n.style.cssText = elementCSS(el);
    if (editingId === el.id) return;
    const inner = elementInner(el, 'editor');
    if (n._inner !== inner) { n.innerHTML = inner; n._inner = inner; }
  }

  function renderStage() {
    layoutStage();
    stage.innerHTML = '';
    for (const el of currentPage().elements) stage.appendChild(createNode(el));
    const box = document.createElement('div');
    box.id = 'sel-box';
    box.innerHTML = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((d) => `<div class="h" data-dir="${d}"></div>`).join('') + '<div class="size-tip hidden"></div>';
    stage.appendChild(box);
    updateSelectionBox();
  }

  function updateNode(el) {
    const n = nodeFor(el.id);
    if (n) paintNode(n, el);
    updateSelectionBox();
  }

  function updateSelectionBox(showSize = false) {
    const box = $('#sel-box');
    if (!box) return;
    const el = selected();
    box.classList.toggle('hidden', !el);
    if (!el) return;
    Object.assign(box.style, { left: `${el.x}px`, top: `${el.y}px`, width: `${el.w}px`, height: `${el.h}px` });
    box.classList.toggle('editing', editingId === el.id);
    $$('.h', box).forEach((h) => h.classList.toggle('hidden', editingId === el.id));
    const tip = $('.size-tip', box);
    tip.classList.toggle('hidden', !showSize);
    tip.textContent = `${Math.round(el.w)} × ${Math.round(el.h)}`;
  }

  function select(id) {
    if (editingId && editingId !== id) stopEditing();
    selectedId = id;
    updateSelectionBox();
    renderProps();
    updateToolbar();
  }

  // ---------- Pages panel ----------
  let thumbsQueued = false;
  function scheduleThumbs() {
    if (thumbsQueued) return;
    thumbsQueued = true;
    requestAnimationFrame(() => { thumbsQueued = false; renderPages(); });
  }

  function renderPages() {
    const list = $('#page-list');
    list.innerHTML = site.pages.map((p, i) => `
      <div class="page-item${p.id === currentPageId ? ' active' : ''}" draggable="true" data-page-id="${p.id}">
        <div class="page-num">${i + 1}</div>
        <div>
          <div class="page-thumb"><div class="thumb-inner" style="height:${p.height}px;background:${esc(p.bg)}">${p.elements.map((e) => elementHTML(e, 'thumb')).join('')}</div></div>
          <div class="page-name">${esc(p.name)}${i === 0 ? '<span class="home-badge">Home</span>' : ''}</div>
        </div>
      </div>`).join('');
  }

  function goToPage(id) {
    if (editingId) stopEditing();
    currentPageId = id;
    selectedId = null;
    cancelDraw();
    renderAll();
    workspace.scrollTop = 0;
    save();
  }

  function addPage() {
    pushHistory();
    const p = makePage(`Page ${site.pages.length + 1}`);
    site.pages.push(p);
    goToPage(p.id);
    emit('page-added');
  }

  function duplicatePage(id = currentPageId) {
    const src = site.pages.find((p) => p.id === id);
    if (!src) return;
    pushHistory();
    const copy = clone(src);
    copy.id = uid();
    copy.name = `${src.name} copy`;
    copy.elements.forEach((e) => { e.id = uid(); });
    site.pages.splice(site.pages.indexOf(src) + 1, 0, copy);
    goToPage(copy.id);
  }

  function deletePage(id = currentPageId) {
    if (site.pages.length === 1) { toast('A website needs at least one page.'); return; }
    const idx = site.pages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    pushHistory();
    site.pages.splice(idx, 1);
    if (currentPageId === id) currentPageId = site.pages[Math.max(0, idx - 1)].id;
    goToPage(currentPageId);
    toast('Page deleted — Ctrl+Z to undo');
  }

  function movePage(id, toIndex) {
    const from = site.pages.findIndex((p) => p.id === id);
    if (from < 0) return;
    toIndex = clamp(toIndex, 0, site.pages.length - 1);
    if (from === toIndex) return;
    pushHistory();
    const [p] = site.pages.splice(from, 1);
    site.pages.splice(toIndex, 0, p);
    renderPages();
    renderProps();
    save();
  }

  // ---------- Properties panel ----------
  const f = {
    num: (prop, v, attrs = '') => `<input type="number" data-prop="${prop}" value="${v}" ${attrs}>`,
    color: (prop, v) => `<input type="color" data-prop="${prop}" value="${esc(v || '#ffffff')}">`,
    text: (prop, v, ph = '') => `<input type="text" data-prop="${prop}" value="${esc(v)}" placeholder="${esc(ph)}">`,
    field: (label, inner) => `<label class="field"><span>${label}</span>${inner}</label>`,
    seg: (prop, cur, opts) => `<div class="seg">${opts.map(([v, l, t]) => `<button type="button" data-set="${prop}" data-value="${v}" title="${t || ''}" class="${cur === v ? 'on' : ''}">${l}</button>`).join('')}</div>`,
    select: (prop, cur, opts, extra = '') => `<select data-prop="${prop}" ${extra}>${opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`,
  };

  function renderProps() {
    const el = selected();
    propsEl.innerHTML = el ? elementProps(el) : pageProps(currentPage());
  }

  function pageProps(page) {
    const idx = site.pages.indexOf(page);
    return `
      <div class="props-head"><span class="type-badge">Page</span><h3>${esc(page.name)}</h3></div>
      <div class="props-section">
        <p class="hint">Click any item on the page to edit it. These settings apply to the whole page.</p>
        ${f.field('Name', f.text('name', page.name))}
        ${f.field('Background', f.color('bg', page.bg))}
        ${f.field('Height', `${f.num('height', page.height, 'min="200" step="10"')}<span class="unit">px</span>`)}
        ${f.field('File', `<code>${esc(pageFiles().get(page.id))}</code>`)}
      </div>
      <div class="props-section">
        <h4>Page actions</h4>
        <div class="btn-row">
          <button data-action="dup-page">Duplicate</button>
          ${idx > 0 ? '<button data-action="make-home">Make home page</button>' : ''}
          <button class="danger" data-action="del-page">Delete</button>
        </div>
      </div>
      <div class="props-section">
        <h4>Website</h4>
        ${f.field('Site name', `<input type="text" data-site="title" value="${esc(site.title)}">`)}
        <p class="hint">Used in each browser tab title and the name of your export.</p>
      </div>`;
  }

  function elementProps(el) {
    const s = el.style;
    const parts = [`
      <div class="props-head"><span class="type-badge">${TYPE_LABELS[el.type]}</span><div class="spacer"></div>
        <button class="icon ghost" data-action="duplicate" title="Duplicate">⧉</button>
        <button class="icon ghost danger" data-action="delete" title="Delete">✕</button>
      </div>
      <div class="props-section">
        <h4>Position &amp; size</h4>
        <div class="grid2">
          ${f.field('X', f.num('x', Math.round(el.x)))}${f.field('Y', f.num('y', Math.round(el.y)))}
          ${f.field('W', f.num('w', Math.round(el.w), 'min="4"'))}${f.field('H', f.num('h', Math.round(el.h), 'min="2"'))}
        </div>
        <div class="btn-row">
          <button data-action="center-h" title="Center horizontally on the page">Center on page</button>
          <button data-action="full-width" title="Stretch to the full page width">Full width</button>
        </div>
      </div>`];

    if (el.type === 'html') {
      parts.push(`
        <div class="props-section">
          <h4>Your HTML</h4>
          <pre class="code-snippet">${esc(el.code || '(empty)')}</pre>
          <button class="primary" data-action="edit-code">Edit HTML…</button>
          <p class="hint" style="margin-top:8px">Shown in its own frame at this exact position and size, so its styles and scripts can’t affect the rest of the page. Tip: double-click the box to edit.</p>
        </div>`);
    }

    if (TEXTUAL.has(el.type)) {
      parts.push(`
        <div class="props-section">
          <h4>Text</h4>
          ${f.field('Font', f.select('style.font', s.font, FONTS.map((x) => [x, x])))}
          ${f.field('Size', `${f.num('style.size', s.size, 'min="6" max="400"')}${f.color('style.color', s.color)}`)}
          ${f.field('Style', f.seg('', '', []).replace('</div>', '') + ['bold:B:Bold', 'italic:I:Italic', 'underline:U:Underline'].map((t) => {
            const [k, l, title] = t.split(':');
            return `<button type="button" data-toggle="style.${k}" title="${title}" class="${s[k] ? 'on' : ''}" style="font-weight:${k === 'bold' ? 700 : 400};font-style:${k === 'italic' ? 'italic' : 'normal'};text-decoration:${k === 'underline' ? 'underline' : 'none'}">${l}</button>`;
          }).join('') + '</div>')}
          ${f.field('Align', f.seg('style.align', s.align, [['left', '⇤', 'Left'], ['center', '↔', 'Center'], ['right', '⇥', 'Right']]))}
          ${f.field('Vertical', f.seg('style.valign', s.valign, [['top', 'Top'], ['middle', 'Mid'], ['bottom', 'Bot']]))}
          ${f.field('Line height', f.num('style.lineHeight', s.lineHeight, 'min="0.8" max="3" step="0.05"'))}
          ${f.field('Padding', `${f.num('style.padding', s.padding, 'min="0" max="200"')}<span class="unit">px</span>`)}
        </div>`);
    }

    if (el.type === 'image') {
      const isData = (el.src || '').startsWith('data:');
      parts.push(`
        <div class="props-section">
          <h4>Image</h4>
          <div class="btn-row" style="margin-bottom:8px"><button class="primary" data-action="replace-image">${el.src ? 'Replace image…' : 'Upload image…'}</button></div>
          ${f.field('Or URL', f.text('src', isData ? '' : el.src, isData ? 'Uploaded image' : 'https://…'))}
          ${f.field('Fit', f.select('style.fit', s.fit, [['cover', 'Fill box (crop)'], ['contain', 'Fit inside'], ['fill', 'Stretch']]))}
          ${f.field('Alt text', f.text('alt', el.alt, 'Describe the image'))}
        </div>`);
    }

    if (el.type !== 'html') {
      parts.push(`
        <div class="props-section">
          <h4>Fill &amp; border</h4>
          ${f.field('Fill', `${f.color('style.bg', s.bg || '#ffffff')}<button type="button" class="none-btn${s.bg ? '' : ' on'}" data-action="bg-none">None</button>`)}
          ${el.type !== 'ellipse' ? f.field('Corners', `<input type="range" data-prop="style.radius" min="0" max="100" value="${s.radius}"><span class="unit">${s.radius}px</span>`) : ''}
          ${el.type !== 'line' ? f.field('Border', `${f.num('style.borderW', s.borderW, 'min="0" max="40" style="max-width:60px"')}<span class="unit">px</span>${f.color('style.borderColor', s.borderColor)}`) : ''}
          ${f.field('Shadow', `<input type="checkbox" data-prop="style.shadow"${s.shadow ? ' checked' : ''}>`)}
        </div>`);
    }
    parts.push(`
      <div class="props-section">
        ${f.field('Opacity', `<input type="range" data-prop="style.opacity" min="5" max="100" value="${s.opacity}"><span class="unit">${s.opacity}%</span>`)}
      </div>`);

    if (el.type !== 'html' && el.type !== 'line') {
      const l = el.link;
      const pages = site.pages.map((p) => [p.id, p.name]);
      parts.push(`
        <div class="props-section" id="link-section">
          <h4>Link</h4>
          ${f.field('Goes to', f.select('link.type', l.type, [['none', 'Nothing'], ['page', 'A page on this site'], ['url', 'A web address']], 'data-rerender'))}
          ${l.type === 'page' ? f.field('Page', f.select('link.pageId', l.pageId, [['', 'Choose a page…'], ...pages])) : ''}
          ${l.type === 'url' ? f.field('Address', f.text('link.url', l.url, 'example.com')) + f.field('New tab', `<input type="checkbox" data-prop="link.newTab"${l.newTab ? ' checked' : ''}>`) : ''}
          ${l.type !== 'none' ? '<p class="hint">Links are clickable in Preview and in your exported site.</p>' : ''}
        </div>`);
    }

    parts.push(`
      <div class="props-section">
        <h4>Arrange</h4>
        <div class="btn-row">
          <button data-action="front">To front</button><button data-action="forward">Forward</button>
          <button data-action="backward">Backward</button><button data-action="back">To back</button>
        </div>
      </div>`);
    return parts.join('');
  }

  function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => o[k], obj);
    target[last] = value;
  }
  const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

  function readInput(t) {
    if (t.type === 'checkbox') return t.checked;
    if (t.type === 'number' || t.type === 'range') {
      const v = parseFloat(t.value);
      return Number.isFinite(v) ? v : null;
    }
    return t.value;
  }

  propsEl.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.site) {
      pushHistory('site-title');
      site.title = t.value;
      $('#site-title').value = t.value;
      changed({ thumbs: false });
      return;
    }
    const prop = t.dataset.prop;
    if (!prop) return;
    const value = readInput(t);
    if (value === null) return;
    const el = selected();
    if (el) {
      pushHistory(`el:${el.id}:${prop}`);
      if (prop === 'w' || prop === 'h') setPath(el, prop, Math.max(prop === 'w' ? 4 : 2, value));
      else setPath(el, prop, value);
      if (prop === 'style.bg') $('.none-btn', propsEl)?.classList.remove('on');
      if (t.type === 'range') t.nextElementSibling.textContent = `${value}${prop === 'style.opacity' ? '%' : 'px'}`;
      updateNode(el);
      if (t.hasAttribute('data-rerender')) { renderProps(); emit('link-set'); }
      if (prop === 'link.pageId' || prop === 'link.url') emit('link-set');
    } else {
      const page = currentPage();
      pushHistory(`page:${page.id}:${prop}`);
      if (prop === 'height') page.height = clamp(Math.round(value), 200, 20000);
      else setPath(page, prop, value);
      if (prop === 'name') $('.props-head h3', propsEl).textContent = value;
      layoutStage();
    }
    changed();
  });

  // Typing in a page's height then leaving should snap the field to the clamped value.
  propsEl.addEventListener('change', (e) => {
    if (e.target.dataset.prop === 'height' && !selected()) e.target.value = currentPage().height;
  });

  propsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-toggle],[data-set]');
    if (!b) return;
    const el = selected();
    if (!el) return;
    if (b.dataset.toggle) {
      pushHistory();
      setPath(el, b.dataset.toggle, !getPath(el, b.dataset.toggle));
    } else {
      pushHistory();
      setPath(el, b.dataset.set, b.dataset.value);
    }
    updateNode(el);
    renderProps();
    changed();
  });

  // ---------- Element operations ----------
  function visibleCenterY(h) {
    const page = currentPage();
    const wsRect = workspace.getBoundingClientRect();
    const stRect = stage.getBoundingClientRect();
    const cy = (wsRect.top + wsRect.height / 2 - stRect.top) / scale;
    return Math.round(clamp(cy - h / 2, 0, Math.max(0, page.height - h)));
  }

  function addElement(el, { place = true } = {}) {
    const page = currentPage();
    if (place) {
      el.x = Math.round((PAGE_W - el.w) / 2);
      el.y = visibleCenterY(el.h);
      while (page.elements.some((o) => o.x === el.x && o.y === el.y)) { el.x += 20; el.y += 20; }
    }
    pushHistory();
    page.elements.push(el);
    stage.insertBefore(createNode(el), $('#sel-box'));
    select(el.id);
    changed();
    emit('element-added');
    return el;
  }

  const insert = (type) => { cancelDraw(); return addElement(makeElement(type)); };

  function deleteSelected() {
    const el = selected();
    if (!el) return;
    pushHistory();
    const page = currentPage();
    page.elements = page.elements.filter((e) => e.id !== el.id);
    nodeFor(el.id)?.remove();
    editingId = null;
    select(null);
    changed();
  }

  function duplicateSelected() {
    const el = selected();
    if (!el) return;
    const copy = clone(el);
    copy.id = uid();
    copy.x += 20;
    copy.y += 20;
    addElement(copy, { place: false });
  }

  function copySelected() {
    const el = selected();
    if (el) { clipboard = clone(el); toast('Copied'); }
  }

  function paste() {
    if (!clipboard) return;
    const copy = clone(clipboard);
    copy.id = uid();
    const page = currentPage();
    while (page.elements.some((o) => o.x === copy.x && o.y === copy.y)) { copy.x += 20; copy.y += 20; }
    clipboard = clone(copy);
    addElement(copy, { place: false });
  }

  function reorder(where) {
    const el = selected();
    if (!el) return;
    const arr = currentPage().elements;
    const i = arr.indexOf(el);
    const j = { front: arr.length - 1, back: 0, forward: Math.min(arr.length - 1, i + 1), backward: Math.max(0, i - 1) }[where];
    if (i === j) return;
    pushHistory();
    arr.splice(i, 1);
    arr.splice(j, 0, el);
    renderStage();
    changed();
  }

  function nudge(dx, dy) {
    const el = selected();
    if (!el) return;
    pushHistory(`nudge:${el.id}`);
    el.x += dx;
    el.y += dy;
    updateNode(el);
    syncGeometryFields(el);
    changed();
  }

  function syncGeometryFields(el) {
    for (const k of ['x', 'y', 'w', 'h']) {
      const input = propsEl.querySelector(`input[data-prop="${k}"]`);
      if (input && document.activeElement !== input) input.value = Math.round(el[k]);
    }
  }

  // ---------- Text editing ----------
  function startEditing(el) {
    if (!TEXTUAL.has(el.type)) return;
    const n = nodeFor(el.id);
    const t = n && $('.el-text', n);
    if (!t) return;
    editingId = el.id;
    n.classList.add('editing');
    t.contentEditable = 'true';
    t.focus();
    const range = document.createRange();
    range.selectNodeContents(t);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    updateSelectionBox();
    t.addEventListener('blur', () => { if (editingId === el.id) stopEditing(); }, { once: true });
  }

  function stopEditing() {
    const id = editingId;
    if (!id) return;
    editingId = null;
    const el = findEl(id);
    const n = nodeFor(id);
    const t = n && $('.el-text', n);
    if (el && t) {
      t.contentEditable = 'false';
      const html = t.innerHTML;
      if (html !== el.content) {
        pushHistory();
        el.content = html;
        changed();
        emit('text-edited');
      }
      n._inner = elementInner(el, 'editor');
      n.classList.remove('editing');
    }
    window.getSelection()?.removeAllRanges();
    updateSelectionBox();
  }

  // Grow the text box while typing so text never gets cut off.
  stage.addEventListener('input', (e) => {
    if (!editingId || !e.target.classList.contains('el-text')) return;
    const el = findEl(editingId);
    const pad = (el.style.padding || 0) * 2 + (el.style.borderW || 0) * 2;
    const need = Math.ceil(e.target.scrollHeight + pad);
    if (need > el.h) {
      el.h = need;
      nodeFor(el.id).style.height = `${need}px`;
      updateSelectionBox();
      syncGeometryFields(el);
    }
  });

  // Paste plain text only, so styles from other sites don't sneak in.
  stage.addEventListener('paste', (e) => {
    if (!editingId) return;
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });

  // ---------- Pointer interactions: select, drag, resize, draw ----------
  function stagePoint(e) {
    const r = stage.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  }

  function blurActive() {
    const a = document.activeElement;
    if (a && a !== document.body && !a.closest?.('#stage')) a.blur();
  }

  function snapTargets(exclude) {
    const page = currentPage();
    const xs = [0, PAGE_W / 2, PAGE_W];
    const ys = [0, page.height / 2, page.height];
    for (const o of page.elements) {
      if (o.id === exclude) continue;
      xs.push(o.x, o.x + o.w / 2, o.x + o.w);
      ys.push(o.y, o.y + o.h / 2, o.y + o.h);
    }
    return { xs, ys };
  }

  // Finds the smallest offset that lines up one of `edges` with one of `targets`.
  function bestSnap(edges, targets) {
    const th = SNAP / scale;
    let best = null;
    for (const e of edges) {
      for (const t of targets) {
        const d = t - e;
        if (Math.abs(d) <= th && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
      }
    }
    return best;
  }

  function showGuides(vx, hy) {
    clearGuides();
    if (vx != null) stage.insertAdjacentHTML('beforeend', `<div class="guide v" style="left:${vx}px"></div>`);
    if (hy != null) stage.insertAdjacentHTML('beforeend', `<div class="guide h" style="top:${hy}px"></div>`);
  }
  const clearGuides = () => $$('.guide', stage).forEach((g) => g.remove());

  function trackPointer(e, onMove, onUp) {
    const move = (ev) => onMove(ev);
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      onUp(ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function startDrag(e, el) {
    const start = { x: e.clientX, y: e.clientY, ex: el.x, ey: el.y };
    const targets = snapTargets(el.id);
    let moved = false;
    trackPointer(e, (ev) => {
      const dx = (ev.clientX - start.x) / scale;
      const dy = (ev.clientY - start.y) / scale;
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      if (!moved) { pushHistory(); moved = true; }
      let nx = start.ex + dx;
      let ny = start.ey + dy;
      let gx = null;
      let gy = null;
      if (!ev.altKey) {
        const sx = bestSnap([nx, nx + el.w / 2, nx + el.w], targets.xs);
        const sy = bestSnap([ny, ny + el.h / 2, ny + el.h], targets.ys);
        if (sx) { nx += sx.d; gx = sx.at; }
        if (sy) { ny += sy.d; gy = sy.at; }
      }
      el.x = Math.round(nx);
      el.y = Math.round(ny);
      updateNode(el);
      showGuides(gx, gy);
      syncGeometryFields(el);
    }, () => {
      clearGuides();
      if (moved) { changed(); emit('element-moved'); }
    });
  }

  function startResize(e, el, dir) {
    const start = { x: e.clientX, y: e.clientY, ...clone({ x: el.x, y: el.y, w: el.w, h: el.h }) };
    const ratio = start.w / start.h;
    const minW = 10;
    const minH = el.type === 'line' ? 1 : 10;
    pushHistory();
    trackPointer(e, (ev) => {
      const dx = (ev.clientX - start.x) / scale;
      const dy = (ev.clientY - start.y) / scale;
      let { x, y, w, h } = start;
      if (dir.includes('e')) w = start.w + dx;
      if (dir.includes('w')) { w = start.w - dx; x = start.x + dx; }
      if (dir.includes('s')) h = start.h + dy;
      if (dir.includes('n')) { h = start.h - dy; y = start.y + dy; }
      // Corner drags keep the aspect ratio for images by default; Shift flips that.
      const keepRatio = dir.length === 2 && (el.type === 'image' ? !ev.shiftKey : ev.shiftKey);
      if (keepRatio) {
        if (Math.abs(w - start.w) / start.w > Math.abs(h - start.h) / start.h) h = w / ratio;
        else w = h * ratio;
        if (dir.includes('w')) x = start.x + start.w - w;
        if (dir.includes('n')) y = start.y + start.h - h;
      }
      if (w < minW) { if (dir.includes('w')) x -= minW - w; w = minW; }
      if (h < minH) { if (dir.includes('n')) y -= minH - h; h = minH; }
      Object.assign(el, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
      updateNode(el);
      updateSelectionBox(true);
      syncGeometryFields(el);
    }, () => {
      updateSelectionBox();
      changed();
      emit('element-moved');
    });
  }

  function startDraw(e) {
    const p0 = stagePoint(e);
    const box = document.createElement('div');
    box.id = 'draw-box';
    stage.appendChild(box);
    let rect = { x: p0.x, y: p0.y, w: 0, h: 0 };
    trackPointer(e, (ev) => {
      const p = stagePoint(ev);
      rect = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
      Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    }, () => {
      box.remove();
      const type = drawMode;
      cancelDraw();
      const el = makeElement(type);
      if (rect.w >= 12 && rect.h >= 12) Object.assign(el, { w: Math.round(rect.w), h: Math.round(rect.h) });
      el.x = Math.round(rect.w >= 12 ? rect.x : p0.x - el.w / 2);
      el.y = Math.round(rect.h >= 12 ? rect.y : p0.y - el.h / 2);
      el.x = clamp(el.x, -el.w + 20, PAGE_W - 20);
      el.y = clamp(el.y, 0, Math.max(0, currentPage().height - 20));
      addElement(el, { place: false });
      emit('html-drawn');
      if (type === 'html') openCodeEditor(el);
    });
  }

  function enterDraw(type) {
    if (editingId) stopEditing();
    drawMode = type;
    workspace.classList.add('drawing');
    $('#btn-html').classList.add('active');
    toast('Drag on the page to draw your HTML box (Esc to cancel)', 3000);
  }

  function cancelDraw() {
    drawMode = null;
    workspace.classList.remove('drawing');
    $('#btn-html').classList.remove('active');
  }

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (drawMode) { e.preventDefault(); blurActive(); startDraw(e); return; }
    const handle = e.target.closest('.h');
    if (handle) {
      e.preventDefault();
      e.stopPropagation();
      startResize(e, selected(), handle.dataset.dir);
      return;
    }
    const n = e.target.closest('.el');
    if (!n) return; // empty canvas is handled by the workspace listener
    const el = findEl(n.dataset.id);
    if (editingId === el.id) return; // let the caret move inside the text
    e.preventDefault();
    blurActive();
    if (selectedId !== el.id) select(el.id);
    else if (editingId) stopEditing();
    startDrag(e, el);
  });

  workspace.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (drawMode && !e.target.closest('#stage')) { cancelDraw(); return; }
    if (e.target.closest('.el') || e.target.closest('.h') || e.target.closest('#page-resizer')) return;
    if (editingId) stopEditing();
    if (selectedId) select(null);
    emit('page-clicked');
  });

  stage.addEventListener('dblclick', (e) => {
    const n = e.target.closest('.el');
    if (!n) return;
    const el = findEl(n.dataset.id);
    if (TEXTUAL.has(el.type)) startEditing(el);
    else if (el.type === 'image') pickImage(el.id);
    else if (el.type === 'html') openCodeEditor(el);
  });

  $('#page-resizer').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const page = currentPage();
    const startY = e.clientY;
    const startH = page.height;
    pushHistory();
    trackPointer(e, (ev) => {
      page.height = clamp(Math.round((startH + (ev.clientY - startY) / scale) / 10) * 10, 200, 20000);
      layoutStage();
      const input = propsEl.querySelector('input[data-prop="height"]');
      if (input) input.value = page.height;
    }, () => changed());
  });

  // ---------- Context menu ----------
  const menu = $('#context-menu');
  function openMenu(x, y, items) {
    menu.innerHTML = items.map((it) => (it === '-' ? '<hr>' : `<button data-action="${it[0]}"${it[3] ? ' disabled' : ''}>${it[1]}${it[2] ? `<span class="kbd">${it[2]}</span>` : ''}</button>`)).join('');
    menu.classList.remove('hidden');
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  }
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

  stage.addEventListener('contextmenu', (e) => {
    const n = e.target.closest('.el');
    if (editingId && n?.dataset.id === editingId) return;
    e.preventDefault();
    if (n) {
      select(n.dataset.id);
      const el = selected();
      openMenu(e.clientX, e.clientY, [
        ...(TEXTUAL.has(el.type) ? [['edit-text', 'Edit text', 'Double-click'], '-'] : []),
        ...(el.type === 'html' ? [['edit-code', 'Edit HTML…', 'Double-click'], '-'] : []),
        ...(el.type === 'image' ? [['replace-image', 'Replace image…'], '-'] : []),
        ['cut', 'Cut', `${mod}X`], ['copy', 'Copy', `${mod}C`], ['paste', 'Paste', `${mod}V`, !clipboard],
        ['duplicate', 'Duplicate', `${mod}D`], '-',
        ['front', 'Bring to front'], ['back', 'Send to back'], '-',
        ['delete', 'Delete', 'Del'],
      ]);
    } else {
      select(null);
      openMenu(e.clientX, e.clientY, [['paste', 'Paste', `${mod}V`, !clipboard], '-', ['add-text', 'Add text'], ['add-html', 'Draw HTML box']]);
    }
  });

  // ---------- Pages panel events ----------
  const pageList = $('#page-list');
  pageList.addEventListener('click', (e) => {
    const item = e.target.closest('.page-item');
    if (item && item.dataset.pageId !== currentPageId) goToPage(item.dataset.pageId);
  });
  pageList.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.page-item');
    if (!item) return;
    e.preventDefault();
    ctxPageId = item.dataset.pageId;
    const i = site.pages.findIndex((p) => p.id === ctxPageId);
    openMenu(e.clientX, e.clientY, [
      ['ctx-dup-page', 'Duplicate page'], ['ctx-home-page', 'Make home page', '', i === 0],
      ['ctx-up-page', 'Move up', '', i === 0], ['ctx-down-page', 'Move down', '', i === site.pages.length - 1], '-',
      ['ctx-del-page', 'Delete page'],
    ]);
  });
  let dragPageId = null;
  pageList.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.page-item');
    dragPageId = item?.dataset.pageId;
    e.dataTransfer.effectAllowed = 'move';
  });
  pageList.addEventListener('dragover', (e) => {
    if (!dragPageId) return;
    e.preventDefault();
    $$('.page-item', pageList).forEach((i) => i.classList.remove('drop-before', 'drop-after'));
    const item = e.target.closest('.page-item');
    if (!item) return;
    const r = item.getBoundingClientRect();
    item.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  pageList.addEventListener('drop', (e) => {
    e.preventDefault();
    const item = e.target.closest('.page-item');
    if (dragPageId && item) {
      const ids = site.pages.map((p) => p.id);
      let to = ids.indexOf(item.dataset.pageId) + (item.classList.contains('drop-after') ? 1 : 0);
      if (ids.indexOf(dragPageId) < to) to -= 1;
      movePage(dragPageId, to);
    }
    dragPageId = null;
    renderPages();
  });
  pageList.addEventListener('dragend', () => { dragPageId = null; renderPages(); });

  // ---------- Images ----------
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const url = reader.result;
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          const w = img.naturalWidth || 400;
          const h = img.naturalHeight || 300;
          const max = 1600;
          if (/gif|svg/.test(file.type) || (Math.max(w, h) <= max && file.size < 700000)) { resolve({ url, w, h }); return; }
          const k = Math.min(1, max / Math.max(w, h));
          const c = document.createElement('canvas');
          c.width = Math.round(w * k);
          c.height = Math.round(h * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve({ url: c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.86), w: c.width, h: c.height });
        };
        img.src = url;
      };
      reader.readAsDataURL(file);
    });
  }

  function pickImage(targetId) {
    imageTargetId = targetId;
    const input = $('#file-image');
    input.value = '';
    input.click();
  }

  async function placeImageFile(file, targetId, at) {
    try {
      const { url, w, h } = await readImage(file);
      let el = targetId && findEl(targetId);
      if (el) {
        pushHistory();
        el.src = url;
        el.h = Math.round(el.w * (h / w));
        updateNode(el);
        renderProps();
        changed();
      } else {
        const k = Math.min(1, 500 / w);
        el = makeElement('image', { w: Math.round(w * k), h: Math.round(h * k), src: url, alt: file.name.replace(/\.[^.]+$/, '') });
        if (at) { el.x = Math.round(at.x - el.w / 2); el.y = Math.round(at.y - el.h / 2); }
        addElement(el, { place: !at });
      }
      emit('image-added');
    } catch (err) {
      toast('Sorry, that image could not be read.');
    }
  }

  $('#file-image').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) placeImageFile(file, imageTargetId);
  });

  workspace.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  workspace.addEventListener('drop', (e) => {
    const file = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    const n = e.target.closest('.el');
    const target = n && findEl(n.dataset.id)?.type === 'image' ? n.dataset.id : null;
    placeImageFile(file, target, target ? null : stagePoint(e));
  });

  // ---------- HTML code editor ----------
  const codeInput = $('#code-input');
  const codeFrame = $('#code-preview-frame');
  let codePreviewTimer = null;

  function openCodeEditor(el) {
    codeTargetId = el.id;
    codeInput.value = el.code || '';
    openModal('#code-modal');
    updateCodePreview();
    setTimeout(() => codeInput.focus(), 30);
  }

  function updateCodePreview() {
    const el = findEl(codeTargetId);
    if (!el) return;
    const holder = $('#code-preview-holder');
    const k = Math.min(1, (holder.clientWidth - 22) / el.w);
    Object.assign(codeFrame.style, { width: `${el.w}px`, height: `${el.h}px`, transform: `scale(${k})`, marginBottom: `${-(el.h * (1 - k))}px` });
    codeFrame.srcdoc = htmlFrameDoc(codeInput.value);
  }

  codeInput.addEventListener('input', () => {
    clearTimeout(codePreviewTimer);
    codePreviewTimer = setTimeout(updateCodePreview, 250);
  });

  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveCode();
    }
  });

  function saveCode() {
    const el = findEl(codeTargetId);
    if (el && el.code !== codeInput.value) {
      pushHistory();
      el.code = codeInput.value;
      updateNode(el);
      changed();
    }
    closeModals();
    if (el) select(el.id);
    emit('html-saved');
  }

  // ---------- Preview ----------
  let previewPageId = null;
  function openPreview(pageId = currentPageId) {
    if (editingId) stopEditing();
    previewPageId = pageId;
    const sel = $('#preview-page');
    sel.innerHTML = site.pages.map((p) => `<option value="${p.id}"${p.id === pageId ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
    openModal('#preview-modal');
    $('#preview-frame').srcdoc = buildPageDoc(site.pages.find((p) => p.id === pageId), 'preview');
    emit('previewed');
  }
  $('#preview-page').addEventListener('change', (e) => openPreview(e.target.value));
  $('#preview-devices').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#preview-devices button').forEach((x) => x.classList.toggle('on', x === b));
    $('#preview-frame').style.width = { desktop: '100%', tablet: '768px', phone: '390px' }[b.dataset.device];
  });
  window.addEventListener('message', (e) => {
    const id = e.data && e.data.siteslidesNav;
    if (id && !$('#preview-modal').classList.contains('hidden') && site.pages.some((p) => p.id === id)) openPreview(id);
  });

  // ---------- Export (zip) ----------
  function buildExportFiles({ publish = false, slug = '' } = {}) {
    const files = pageFiles();
    const assets = new Map();
    let n = 0;
    for (const p of site.pages) {
      for (const e of p.elements) {
        if (e.type === 'image' && e.src?.startsWith('data:') && !assets.has(e.src)) {
          const mime = e.src.slice(5, e.src.indexOf(';'));
          const ext = ({ 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' })[mime] || mime.split('/')[1] || 'png';
          assets.set(e.src, `assets/image-${++n}.${ext}`);
        }
      }
    }
    const boxes = new Map();
    const boxFiles = [];
    if (publish) {
      for (const p of site.pages) {
        for (const e of p.elements) {
          if (e.type !== 'html') continue;
          const doc = htmlFrameDoc(e.code);
          boxes.set(e.id, { n: boxes.size + 1, v: hashText(doc) });
          boxFiles.push({ name: `boxes/${boxes.size}.txt`, data: doc });
        }
      }
    }
    const out = site.pages.map((p) => ({ name: files.get(p.id), data: buildPageDoc(p, 'export', { files, assets, publish, boxes, slug }) }));
    out.push({ name: 'style.css', data: SITE_CSS }, ...boxFiles);
    assets.forEach((path, dataUrl) => out.push({ name: path, data: dataUrlBytes(dataUrl) }));
    return out;
  }

  function dataUrlBytes(url) {
    const [head, body] = url.split(',');
    if (!head.includes(';base64')) return new TextEncoder().encode(decodeURIComponent(body));
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // Minimal "stored" (uncompressed) zip writer.
  function makeZip(files) {
    const enc = new TextEncoder();
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const local = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
      const name = enc.encode(file.name);
      const data = typeof file.data === 'string' ? enc.encode(file.data) : file.data;
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true);
      lh.setUint16(10, time, true);
      lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      local.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true);
      ch.setUint16(14, date, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(38, 0, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...local, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function openExport() {
    if (editingId) stopEditing();
    const files = buildExportFiles();
    $('#export-files').innerHTML = files.map((x) => `<li>${esc(x.name)}</li>`).join('');
    openModal('#export-modal');
    emit('export-opened');
  }

  // ---------- Publish ----------
  // The publish server (worker/) commits the site into the GitHub repo, so it's served at
  // PAGES_BASE + <site-name>/. Each site gets an owner key, kept in this browser, that is
  // needed to update it later.
  function ownerKeys() {
    try { return JSON.parse(localStorage.getItem(OWNER_KEYS) || '{}'); } catch (err) { return {}; }
  }
  function rememberOwnerKey(slug, key) {
    const keys = ownerKeys();
    keys[slug] = key;
    try { localStorage.setItem(OWNER_KEYS, JSON.stringify(keys)); } catch (err) { /* also kept in the project */ }
  }

  function setPubStatus(html, kind = '') {
    const el = $('#pub-status');
    el.className = `pub-status ${kind}`;
    el.innerHTML = html;
  }

  function refreshPublishUrl() {
    const url = `${PAGES_BASE}${slugify($('#pub-slug').value)}/`;
    $('#pub-url').textContent = url;
    $('#pub-url').href = url;
  }

  function openPublish() {
    if (editingId) stopEditing();
    $('#pub-slug').value = site.publish?.slug || slugify(site.title);
    $('#pub-go').disabled = false;
    $('#pub-status').classList.add('hidden');
    if (site.publish?.url) {
      setPubStatus(`Last published ${new Date(site.publish.at).toLocaleString()} to <a href="${esc(site.publish.url)}" target="_blank" rel="noopener">${esc(site.publish.url)}</a>. Publish again to update it.`);
    }
    refreshPublishUrl();
    openModal('#publish-modal');
  }

  $('#pub-slug').addEventListener('input', refreshPublishUrl);
  $('#pub-slug').addEventListener('change', (e) => { e.target.value = slugify(e.target.value); refreshPublishUrl(); });

  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function doPublish() {
    const slug = slugify($('#pub-slug').value);
    $('#pub-slug').value = slug;
    if (!PUBLISH_API) { setPubStatus('Publishing isn’t switched on for this copy of SiteSlides yet. Use Export instead.', 'err'); return; }
    const key = (site.publish?.slug === slug && site.publish.key) || ownerKeys()[slug] || null;
    if (key && site.publish?.slug !== slug && !confirm(`You already published a different site called “${slug}”. Replace it with this one?`)) return;
    const btn = $('#pub-go');
    btn.disabled = true;
    setPubStatus('Publishing…');
    try {
      const files = buildExportFiles({ publish: true, slug }).map((f) => (typeof f.data === 'string'
        ? { name: f.name, text: f.data }
        : { name: f.name, base64: bytesToBase64(f.data) }));
      const res = await fetch(`${PUBLISH_API}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, title: site.title, ownerKey: key, files }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Publishing failed. Please try again.');
      rememberOwnerKey(slug, data.ownerKey);
      site.publish = { slug, url: data.url, at: Date.now(), key: data.ownerKey };
      save();
      setPubStatus(`🎉 Published! Your site will be live at <a href="${esc(data.url)}" target="_blank" rel="noopener">${esc(data.url)}</a> in about a minute. It will also show up in the <a href="${PAGES_BASE}gallery/" target="_blank" rel="noopener">gallery</a>.`, 'ok');
      emit('published');
    } catch (err) {
      setPubStatus(esc(err instanceof TypeError ? 'Couldn’t reach the publishing server. Check your internet connection and try again.' : err.message), 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Modals, menus, toast ----------
  function openModal(sel) {
    closeMenus();
    $$('.modal').forEach((m) => m.classList.add('hidden'));
    $(sel).classList.remove('hidden');
  }
  function closeModals() {
    $$('.modal').forEach((m) => m.classList.add('hidden'));
  }
  function closeMenus() {
    $$('.dropdown').forEach((d) => d.classList.add('hidden'));
    $$('.menu-btn').forEach((b) => b.classList.remove('open'));
  }
  $$('.modal').forEach((m) => m.addEventListener('pointerdown', (e) => { if (e.target === m && m.id !== 'code-modal') closeModals(); }));

  let toastTimer = null;
  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---------- Project files ----------
  function replaceSite(newSite, msg) {
    pushHistory();
    site = newSite;
    currentPageId = site.pages[0].id;
    selectedId = null;
    editingId = null;
    renderAll();
    save();
    if (msg) toast(msg);
  }

  $('#file-project').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const s = data.site || data;
      if (!Array.isArray(s.pages) || !s.pages.length) throw new Error('bad');
      replaceSite(s, `Opened “${s.title || file.name}”`);
    } catch (err) {
      toast('That file is not a SiteSlides project.');
    }
  });

  // ---------- Actions (toolbar, menus, panels, keyboard) ----------
  const withSel = (fn) => () => { if (selected()) fn(selected()); };
  const actions = {
    undo, redo,
    'add-heading': () => insert('heading'),
    'add-text': () => insert('text'),
    'add-button': () => insert('button'),
    'add-image': () => { cancelDraw(); pickImage(null); },
    'add-shape': () => insert('shape'),
    'add-ellipse': () => insert('ellipse'),
    'add-line': () => insert('line'),
    'add-html': () => (drawMode === 'html' ? cancelDraw() : enterDraw('html')),
    'edit-code': withSel((el) => openCodeEditor(el)),
    'save-code': saveCode,
    'edit-text': withSel((el) => startEditing(el)),
    'replace-image': withSel((el) => pickImage(el.id)),
    duplicate: duplicateSelected,
    delete: deleteSelected,
    copy: copySelected,
    cut: () => { copySelected(); deleteSelected(); },
    paste,
    front: () => reorder('front'),
    back: () => reorder('back'),
    forward: () => reorder('forward'),
    backward: () => reorder('backward'),
    'center-h': withSel((el) => { pushHistory(); el.x = Math.round((PAGE_W - el.w) / 2); updateNode(el); syncGeometryFields(el); changed(); }),
    'full-width': withSel((el) => { pushHistory(); el.x = 0; el.w = PAGE_W; updateNode(el); syncGeometryFields(el); changed(); }),
    'bg-none': withSel((el) => { pushHistory(); el.style.bg = ''; updateNode(el); renderProps(); changed(); }),
    'add-page': addPage,
    'dup-page': () => duplicatePage(),
    'del-page': () => deletePage(),
    'make-home': () => { movePage(currentPageId, 0); toast('This is now your home page (index.html)'); },
    'ctx-dup-page': () => duplicatePage(ctxPageId),
    'ctx-del-page': () => deletePage(ctxPageId),
    'ctx-home-page': () => movePage(ctxPageId, 0),
    'ctx-up-page': () => movePage(ctxPageId, site.pages.findIndex((p) => p.id === ctxPageId) - 1),
    'ctx-down-page': () => movePage(ctxPageId, site.pages.findIndex((p) => p.id === ctxPageId) + 1),
    preview: () => openPreview(),
    export: openExport,
    publish: openPublish,
    gallery: () => window.open(`${PAGES_BASE}gallery/`, '_blank', 'noopener'),
    'do-publish': doPublish,
    'download-zip': () => {
      download(makeZip(buildExportFiles()), `${slugify(site.title)}.zip`);
      toast('Website downloaded! Unzip it and upload the folder to any host.', 4000);
      emit('exported');
    },
    'close-modal': closeModals,
    'new-blank': () => { if (confirm('Start a new blank site? (You can undo this.)')) replaceSite(blankSite(), 'New blank site'); },
    'new-template': () => { if (confirm('Start over from the starter template? (You can undo this.)')) replaceSite(starterSite(), 'Starter template loaded'); },
    'open-project': () => { const i = $('#file-project'); i.value = ''; i.click(); },
    'save-project': () => {
      download(new Blob([JSON.stringify({ app: 'siteslides', version: 1, site }, null, 1)], { type: 'application/json' }), `${slugify(site.title)}.siteslides.json`);
      toast('Project saved — open it later with File → Open project');
    },
    tutorial: () => startTutorial(),
    'tut-next': () => tutGo(1),
    'tut-back': () => tutGo(-1),
    'tut-end': () => endTutorial(),
  };

  document.addEventListener('click', (e) => {
    const menuBtn = e.target.closest('.menu-btn');
    if (menuBtn) {
      const dd = $(`#${menuBtn.dataset.menu}`);
      const wasOpen = !dd.classList.contains('hidden');
      closeMenus();
      if (!wasOpen) { dd.classList.remove('hidden'); menuBtn.classList.add('open'); }
      return;
    }
    const b = e.target.closest('[data-action]');
    if (!b) { if (!e.target.closest('.dropdown')) closeMenus(); return; }
    if (b.disabled) return;
    const fn = actions[b.dataset.action];
    closeMenus();
    if (fn) fn(b);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.dropdown') && !e.target.closest('.menu-btn')) closeMenus();
  });

  function isTyping(e) {
    const t = e.target;
    return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
  }

  document.addEventListener('keydown', (e) => {
    const k = e.key;
    const cmd = e.metaKey || e.ctrlKey;
    if (k === 'Escape') {
      if (!$('#code-modal').classList.contains('hidden')) { closeModals(); return; }
      if ($$('.modal').some((m) => !m.classList.contains('hidden'))) { closeModals(); return; }
      if (!menu.classList.contains('hidden') || !$('#file-menu').classList.contains('hidden')) { closeMenus(); return; }
      if (drawMode) { cancelDraw(); return; }
      if (editingId) { stopEditing(); return; }
      if (tut.open) { endTutorial(); return; }
      if (selectedId) select(null);
      return;
    }
    if (cmd && k.toLowerCase() === 's') { e.preventDefault(); save(); toast('Saved in this browser. Use File → Save project for a backup file.'); return; }
    if ($$('.modal').some((m) => !m.classList.contains('hidden'))) return;
    if (isTyping(e)) return;
    if (cmd && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (cmd && k.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (cmd && k.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (cmd && k.toLowerCase() === 'c') { copySelected(); return; }
    if (cmd && k.toLowerCase() === 'x') { actions.cut(); return; }
    if (cmd && k.toLowerCase() === 'v') { paste(); return; }
    if (k === 'Delete' || k === 'Backspace') { if (selectedId) { e.preventDefault(); deleteSelected(); } return; }
    if (k === 'Enter' && selected()) {
      e.preventDefault();
      const el = selected();
      if (TEXTUAL.has(el.type)) startEditing(el);
      else if (el.type === 'html') openCodeEditor(el);
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[k] && selectedId) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      nudge(arrows[k][0] * step, arrows[k][1] * step);
    }
  });

  $('#site-title').addEventListener('input', (e) => {
    pushHistory('site-title');
    site.title = e.target.value;
    const other = propsEl.querySelector('[data-site="title"]');
    if (other) other.value = site.title;
    changed({ thumbs: false });
  });

  $('#zoom').addEventListener('change', (e) => { zoom = e.target.value; layoutStage(); });
  window.addEventListener('resize', () => { if (zoom === 'fit') layoutStage(); });

  function updateToolbar() {
    $('[data-action="undo"]').disabled = !undoStack.length;
    $('[data-action="redo"]').disabled = !redoStack.length;
    $$('#arrange-bar button').forEach((b) => { b.disabled = !selectedId; });
  }

  function renderAll() {
    $('#site-title').value = site.title;
    renderPages();
    renderStage();
    renderProps();
    updateToolbar();
  }

  // ---------- Tutorial ----------
  const tut = { open: false, i: 0, timer: null, handler: null, waitName: null };

  const firstOf = (type) => currentPage().elements.find((e) => e.type === type);
  const STEPS = [
    {
      title: 'Welcome to SiteSlides 👋',
      body: '<p>Make a website the same way you make a slide deck. Each slide is a <b>page</b> of your site, and everything on it can be dragged anywhere.</p><p>This quick tour takes about two minutes. Some steps ask you to try things — you can always press <b>Next</b> to skip ahead.</p>',
    },
    {
      target: '#pages', place: 'right',
      title: 'Pages are your slides',
      body: '<p>Each thumbnail is one page. The first one is your <b>home page</b>.</p><p>Click <b>+ New page</b> to add one, drag thumbnails to reorder, and right-click a page for more options.</p>',
    },
    {
      target: '#insert-bar', place: 'bottom', waitFor: 'element-added',
      title: 'Insert things',
      body: '<p>Use this bar to add headings, text, buttons, images, shapes and lines.</p><p><b>Try it:</b> click <b>Text</b> now.</p>',
    },
    {
      target: '#workspace', place: 'center-bottom', waitFor: 'element-moved',
      title: 'Move and resize',
      body: '<p><b>Drag</b> your new text box to move it. Pink guide lines show up when it lines up with the page or other items. (Hold <kbd>Alt</kbd> to turn snapping off.)</p><p>Drag the small <b>square handles</b> to resize, and <b>double-click</b> to change the words.</p>',
    },
    {
      target: '#props', place: 'left',
      title: 'Style it',
      body: '<p>This panel shows options for whatever you have selected: font, size, color, alignment, fill, rounded corners, border, shadow and more.</p><p>Tip: <b>right-click</b> anything for quick actions like duplicate and bring to front.</p>',
    },
    {
      target: '#btn-html', place: 'bottom', waitFor: 'html-drawn',
      title: 'Bring your own HTML',
      body: '<p>Want a map, a video embed, a form, or anything custom? Use an <b>HTML box</b>.</p><p><b>Try it:</b> click <b>HTML</b>, then <b>drag a box</b> on the page where you want it.</p>',
    },
    {
      target: '#code-modal .dialog', place: 'center-bottom', waitFor: 'html-saved', onlyIf: () => !$('#code-modal').classList.contains('hidden'),
      title: 'Write your code',
      body: '<p>Type or paste any HTML on the left — the right side shows a live preview at your box\'s exact size.</p><p>Click <b>Save HTML</b> when you\'re done. When you export, your code becomes a <code>&lt;div&gt;</code> at exactly that spot. Double-click the box to edit it again later.</p>',
    },
    {
      target: '#link-section', place: 'left',
      onEnter: () => { const b = firstOf('button'); if (b) select(b.id); $('#link-section')?.scrollIntoView({ block: 'center' }); },
      fallback: '#props',
      title: 'Link pages together',
      body: '<p>Any text, button, image or shape can be a link. Pick <b>A page on this site</b> to connect your pages, or <b>A web address</b> to link anywhere on the internet.</p>',
    },
    {
      target: '#page-resizer', place: 'top',
      onEnter: () => select(null),
      title: 'Page settings',
      body: '<p>Click an empty part of the page to edit the page itself — its name, background color and height.</p><p>Websites scroll, so <b>drag this bar</b> to make the page taller or shorter.</p>',
    },
    {
      target: '#btn-preview', place: 'bottom',
      title: 'Preview',
      body: '<p>See your site exactly as visitors will — on desktop, tablet or phone. Links work in the preview, so you can click around.</p>',
    },
    {
      target: '#btn-publish', place: 'bottom',
      title: 'Publish it',
      body: '<p><b>Publish</b> puts your site online for free at its own address, like <code>maxvbuda.github.io/website-maker/my-site/</code>. Publish again any time to update it.</p><p>Prefer another host? <b>Export</b> downloads a .zip of plain HTML files you can upload anywhere.</p>',
    },
    {
      title: 'You\'re ready! 🎉',
      body: `<p>Your work saves automatically in this browser. Use <b>File → Save project</b> to keep a backup file.</p>
        <div class="shortcuts">
          <kbd>Double-click</kbd><span>Edit text / HTML / image</span>
          <kbd>Del</kbd><span>Delete selected</span>
          <kbd>${mod}D</kbd><span>Duplicate</span>
          <kbd>${mod}Z</kbd><span>Undo (${mod}⇧Z to redo)</span>
          <kbd>Arrows</kbd><span>Nudge (hold ⇧ for 10px)</span>
          <kbd>Alt + drag</kbd><span>Move without snapping</span>
        </div>
        <p>Reopen this tour any time with the <b>Tutorial</b> button at the top.</p>`,
    },
  ];

  function startTutorial() {
    closeModals();
    closeMenus();
    tut.open = true;
    tut.i = 0;
    $('#tutorial').classList.remove('hidden');
    showStep();
    clearInterval(tut.timer);
    tut.timer = setInterval(positionTutorial, 200);
  }

  function endTutorial() {
    tut.open = false;
    clearWait();
    clearInterval(tut.timer);
    $('#tutorial').classList.add('hidden');
    try { localStorage.setItem(TUTORIAL_KEY, '1'); } catch (err) { /* ignore */ }
  }

  function clearWait() {
    if (tut.handler) bus.removeEventListener(tut.waitName, tut.handler);
    tut.handler = null;
  }

  function tutGo(dir) {
    let i = tut.i + dir;
    while (STEPS[i] && STEPS[i].onlyIf && !STEPS[i].onlyIf()) i += dir;
    if (i >= STEPS.length) { endTutorial(); toast('Have fun building! 🚀'); return; }
    if (i < 0) return;
    // Leaving the code-editor step without saving shouldn't strand the modal open.
    if (STEPS[tut.i].target === '#code-modal .dialog' && dir < 0) closeModals();
    tut.i = i;
    showStep();
  }

  function showStep() {
    clearWait();
    const s = STEPS[tut.i];
    s.onEnter?.();
    $('#tut-title').textContent = s.title;
    $('#tut-body').innerHTML = s.body;
    $('#tut-count').textContent = `Step ${tut.i + 1} of ${STEPS.length}`;
    $('#tut-back').disabled = tut.i === 0;
    $('#tut-next').textContent = tut.i === STEPS.length - 1 ? 'Start building' : s.waitFor ? 'Skip' : 'Next';
    $('#tut-wait').classList.toggle('hidden', !s.waitFor);
    if (s.waitFor) {
      const at = tut.i;
      tut.waitName = s.waitFor;
      tut.handler = () => { clearWait(); setTimeout(() => { if (tut.open && tut.i === at) tutGo(1); }, 450); };
      bus.addEventListener(s.waitFor, tut.handler);
    }
    positionTutorial();
  }

  function positionTutorial() {
    if (!tut.open) return;
    const s = STEPS[tut.i];
    const spot = $('#tut-spot');
    const card = $('#tut-card');
    const target = (s.target && $(s.target)) || (s.fallback && $(s.fallback));
    const cw = card.offsetWidth;
    const chh = card.offsetHeight;
    const vw = innerWidth;
    const vh = innerHeight;
    const M = 14;
    if (!target || !target.getClientRects().length) {
      spot.classList.add('center');
      Object.assign(spot.style, { left: `${vw / 2}px`, top: `${vh / 2}px`, width: '0px', height: '0px' });
      Object.assign(card.style, { left: `${(vw - cw) / 2}px`, top: `${(vh - chh) / 2}px` });
      return;
    }
    spot.classList.remove('center');
    const r0 = target.getBoundingClientRect();
    const r = {
      left: Math.max(4, r0.left - 6), top: Math.max(4, r0.top - 6),
      right: Math.min(vw - 4, r0.right + 6), bottom: Math.min(vh - 4, r0.bottom + 6),
    };
    Object.assign(spot.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
    const spots = {
      right: [r.right + M, r.top],
      left: [r.left - cw - M, r.top],
      bottom: [r.left, r.bottom + M],
      top: [r.left, r.top - chh - M],
      'center-bottom': [(r.left + r.right - cw) / 2, r.bottom - chh - 24],
    };
    const fits = ([x, y]) => x >= 8 && y >= 8 && x + cw <= vw - 8 && y + chh <= vh - 8;
    const order = [s.place, 'bottom', 'right', 'left', 'top'].filter(Boolean);
    let pos = order.map((p) => spots[p]).find(fits) || spots[s.place] || spots.bottom;
    pos = [clamp(pos[0], 8, vw - cw - 8), clamp(pos[1], 8, vh - chh - 8)];
    Object.assign(card.style, { left: `${pos[0]}px`, top: `${pos[1]}px` });
  }
  window.addEventListener('resize', positionTutorial);

  // ---------- Boot ----------
  load();
  renderAll();
  let firstVisit = true;
  try { firstVisit = !localStorage.getItem(TUTORIAL_KEY); } catch (err) { /* ignore */ }
  if (firstVisit) setTimeout(startTutorial, 400);

  // Exposed for automated tests.
  window.SiteSlides = { get site() { return site; }, buildExportFiles, makeZip, buildPageDoc };
})();
