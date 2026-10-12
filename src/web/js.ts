// The JS a page needs before it can be captured: devtools hidden, animations frozen, inner scrollers
// unfolded, the document warmed up. Each one is a comment-tagged expression, so the batch reader
// knows which answer is which.
import { config } from '../core/ctx.ts';

// Dev-only devtools badges sit over a corner of the page; they are not the UI under review.
export const NO_DEVTOOLS = `document.querySelectorAll('.tsqd-parent-container, button[aria-label*="Devtools"]').forEach(e => { e.style.display = 'none' })`;
// VYSU_WEB_HIDE, one selector at a time: a selector list the browser cannot parse is dropped whole,
// so one typo would bring every overlay back. Cut at the commas outside parentheses, brackets and
// quotes (`:is(a, b)` and `[aria-label="a,b"]` are one selector each).
export function hideSelectors(list: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (const c of list) {
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    else if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}
// The page script that hides them: a stylesheet, so whatever the app renders later under those
// selectors is hidden too, and a selector that matches nothing changes nothing. Registered as an
// init script, it runs before the page's own on every document of the session (a navigation, a
// reload, a new tab); the document element may not exist yet at that point, hence the second try.
export function hideJs(list: string): string {
  const css = hideSelectors(list)
    .map((sel) => `${sel}{display:none!important}`)
    .join('\n');
  return `(() => { const add = () => { if (document.getElementById("vysu-hide")) return; const root = document.head || document.documentElement; if (!root) return; const s = document.createElement("style"); s.id = "vysu-hide"; s.textContent = ${JSON.stringify(css)}; root.appendChild(s) }; add(); document.addEventListener("DOMContentLoaded", add) })();\n`;
}
// --freeze: a blinking caret or a spinner mid-turn is the whole difference between « identical » and
// « 0.2 % changed » on a page nothing touched.
export const FREEZE_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
// An app shell that never scrolls the document — a full-height grid whose content scrolls inside one
// pane — brings back the first screen and nothing else from `screenshot --full`, which only ever
// grows to the document. Before a --full capture, every in-flow pane that scrolls is let go of its
// height, along with its ancestors up to <html>, and the document grows to the real content.
// A pane inside a `position: fixed` subtree is skipped: a toast, a drawer, a devtools panel parked
// below the fold never add to the document, and expanding one only paints it over the page.
// Under 200 px tall or laid out nowhere (getClientRects), it is chrome, not the screen under review.
export const EXPAND_JS =
  '/*vysuexpand*/(() => { const floats = e => { for (let n = e; n; n = n.parentElement) if (getComputedStyle(n).position === "fixed") return true; return false }; const panes = [...document.querySelectorAll("body *")].filter(e => e.clientHeight >= 200 && e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.getClientRects().length && !floats(e)); const marked = new Set(); for (const p of panes) for (let e = p; e && e !== document.documentElement; e = e.parentElement) marked.add(e); marked.forEach(e => e.setAttribute("data-vysu-expand", "")); const s = document.createElement("style"); s.id = "vysu-expand"; s.textContent = "html,body,[data-vysu-expand]{height:auto!important;max-height:none!important;min-height:0!important;overflow:visible!important}"; document.head.appendChild(s); return [panes.length, document.scrollingElement.scrollHeight] })()';
// A page that reveals its sections as they cross the viewport — an IntersectionObserver, a lazy
// image, a counter that counts up — paints each of them once, on the way past. A --full capture of a
// page just opened therefore holds the sections above the fold finished and the ones below
// half-drawn, and two runs of the same page disagree on which. Before such a capture the document is
// walked once, a viewport at a time, leaving frames in between for the observers to fire, and left
// back at the top. A page that fits the viewport has nothing to reveal and is skipped.
export const WARM_JS =
  '/*vysuwarm*/(async () => { const d = document.scrollingElement, step = innerHeight; if (d.scrollHeight <= step + 8) return 0; const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); let n = 0; for (let y = 0; y < d.scrollHeight; y += step) { d.scrollTo({ top: y, behavior: "instant" }); await frame(); await new Promise(r => setTimeout(r, 60)); n++ } d.scrollTo({ top: 0, behavior: "instant" }); await frame(); return n })()';
// `wait idle` on the web: the page has gone quiet once no request has completed for half a second, no
// image on screen is still loading (a map's tiles: what is in flight is not in the resource timeline
// yet, an <img> not complete is) and the document itself has loaded. On screen only: a lazy image
// below the fold never loads until it is scrolled to, and waited for it would hold every step to
// its cap (a Nidz incident list, 2 156 px down). A navigation has
// networkidle for that; an action — a click that fetches, a map that pans — has nothing else. Answers
// « idle|busy <seconds> <requests seen> »; never waits past its cap, so the call always comes back.
export function idleJs(capSeconds: number): string {
  const cap = Math.round(capSeconds * 1000);
  return `/*vysuidle*/new Promise(done => { const t0 = performance.now(); let last = t0, n = 0, po; try { po = new PerformanceObserver(l => { n += l.getEntries().length; last = performance.now() }); po.observe({ type: "resource" }) } catch {} const end = s => { if (po) po.disconnect(); done(s + " " + ((performance.now() - t0) / 1000).toFixed(1) + " " + n) }; const tick = () => { const t = performance.now(); if (t - last >= 500 && document.readyState === "complete" && [...document.images].every(i => { if (i.complete) return true; const r = i.getBoundingClientRect(); return r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth || !r.width || !r.height })) return end("idle"); if (t - t0 >= ${cap}) return end("busy"); setTimeout(tick, 100) }; tick() })`;
}
// Back to a normal layout, so the next viewport measures its own panes rather than the expanded ones.
export const RESTORE_JS =
  'document.getElementById("vysu-expand")?.remove(); document.querySelectorAll("[data-vysu-expand]").forEach(e => e.removeAttribute("data-vysu-expand"))';

export function chromeJs(freeze: boolean): string {
  let js = NO_DEVTOOLS;
  if (freeze) js += `; { const s = document.createElement('style'); s.textContent = '${FREEZE_CSS}'; document.head.appendChild(s) }`;
  return js;
}

// The language the web app is in, and where it is kept. An app that has no such key says so: `lang`
// dies rather than writing a localStorage entry nothing reads.
export function langReadJs(prefix = ''): string {
  const key = config().get('LANG_STORAGE_KEY');
  const def = config().get('LANG');
  if (!key) return '';
  return `${prefix}(() => { try { return localStorage.getItem("${key}") || "${def}" } catch (e) { return "${def}" } })()`;
}

// The boxes an --ignore selector resolves to, in the batch, per viewport: document coordinates for
// a --full capture.
export function ignoreJs(selectors: string[], full: boolean): string {
  const off = full ? '[Math.round(scrollX), Math.round(scrollY)]' : '[0, 0]';
  return `/*vysubox*/${pyJsonList(selectors)}.flatMap(s => [...document.querySelectorAll(s)]).map(e => { const r = e.getBoundingClientRect(), o = ${off}; return [Math.round(r.x) + o[0], Math.round(r.y) + o[1], Math.round(r.width), Math.round(r.height)] })`;
}

// Python's json.dumps of a list of strings, which is what these snippets and meta.json are fed.
export function pyJsonList(items: string[]): string {
  return `[${items.map(pyJsonString).join(', ')}]`;
}
export function pyJsonString(s: string): string {
  return JSON.stringify(s).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// Where a click is about to land, in CSS pixels. agent-browser's `find … click` answers with nothing
// but success, and the marker attribute it leaves is gone by the time the click returns: the box has
// to be read *before* the gesture, by an eval resolving the same three rules as the click itself
// (accessible name = aria-label or text, matched as a case-insensitive substring, like Playwright).
export function boxOfJs(label: string, field: boolean): string {
  return `(() => {
  const want = ${pyJsonString(label)}.trim().toLowerCase(), field = ${field ? 'true' : 'false'};
  const shown = e => e.getClientRects().length > 0;
  const name = e => ((e.getAttribute("aria-label") || e.textContent || "").trim().toLowerCase());
  const pick = sel => [...document.querySelectorAll(sel)].find(e => shown(e) && name(e).includes(want));
  let e;
  if (field) {
    const named = c => ((c.getAttribute("aria-label") || c.placeholder || [...(c.labels || [])].map(l => l.textContent).join(" ")).trim().toLowerCase());
    e = [...document.querySelectorAll("input, textarea, select")].find(c => shown(c) && named(c).includes(want));
  } else {
    e = pick("button, [role=button], input[type=submit]") || pick("a, [role=link]")
      || [...document.querySelectorAll("body *")].find(c => !c.children.length && shown(c) && name(c).includes(want));
  }
  if (!e) return "";
  const r = e.getBoundingClientRect();
  return [r.x, r.y, r.width, r.height].map(Math.round).join(" ");
})()`;
}
