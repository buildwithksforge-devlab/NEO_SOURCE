/**
 * NEØ Pulse — the branded launch frame.
 *
 * Plain HTML + CSS injected into the server-rendered shell, so the very first
 * painted frame is already the NEØ mark on the launch background. There is no
 * white flash before it, no stale previous page behind it, and none after it
 * either: the document background stays #0B0D0F until the splash has faded
 * out over a real application frame.
 *
 * Exact palette (the only colours used here):
 *   launch background  #0B0D0F
 *   mark               #F7F2E8
 *   wordmark           #FFFFFF
 *   gold accent        #C8A96B
 *   attribution        #D6D1C8
 *
 * Rules it must never break:
 *  - a ready application is never held longer than the cold-launch lockup
 *    needed for the attribution to actually be readable;
 *  - a warm launch (same tab session) cross-fades quickly instead of snapping,
 *    so the previous screen never flashes through;
 *  - reduced motion gets a single short cross-fade of the complete lockup;
 *  - it is aria-hidden, holds no focus and traps nothing;
 *  - a hard safety timer removes it even if hydration never happens.
 */

/** Milliseconds the complete lockup stays up on a cold launch. */
export const LAUNCH_COLD_FLOOR_MS = 1150;

/** Canonical NEØ wordmark (same artwork the footer attribution uses). */
const NEO_WORDMARK_URL =
  "/neo-wordmark.png";

/** Instagram glyph, identical in spirit to the footer creator credit. */
const INSTAGRAM_GLYPH = `
<svg viewBox="0 0 24 24" aria-hidden="true" class="neo-launch__ig">
  <defs>
    <radialGradient id="neo-launch-ig" cx="30%" cy="107%" r="150%">
      <stop offset="0%" stop-color="#FDF497"/><stop offset="5%" stop-color="#FDF497"/>
      <stop offset="45%" stop-color="#FD5949"/><stop offset="60%" stop-color="#D6249F"/>
      <stop offset="90%" stop-color="#285AEB"/>
    </radialGradient>
  </defs>
  <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="url(#neo-launch-ig)"/>
  <rect x="5.75" y="5.75" width="12.5" height="12.5" rx="4" fill="none" stroke="#fff" stroke-width="1.6"/>
  <circle cx="12" cy="12" r="3.1" fill="none" stroke="#fff" stroke-width="1.6"/>
  <circle cx="16.6" cy="7.4" r="1.05" fill="#fff"/>
</svg>`;

export const LAUNCH_SPLASH_MARKUP = `
<div id="neo-launch" aria-hidden="true" role="presentation">
  <div class="neo-launch__ambient"></div>
  <div class="neo-launch__stage">
    <div class="neo-launch__markwrap">
      <span class="neo-launch__halo"></span>
      <img id="neo-launch-mark" class="neo-launch__mark" src="/neo-splash-mark.png" alt="" decoding="async" fetchpriority="high" />
      <span class="neo-launch__sheen"></span>
    </div>
    <p id="neo-launch-word" class="neo-launch__word">NEØ</p>
    <p id="neo-launch-sub" class="neo-launch__sub" hidden></p>
    <div class="neo-launch__powered">
      <span class="neo-launch__poweredlabel">Powered by</span>
      <span class="neo-launch__poweredmark">
        <img src="${NEO_WORDMARK_URL}" alt="" decoding="async" />
      </span>
    </div>
    <span class="neo-launch__bar"><i></i></span>
  </div>
  <div class="neo-launch__credit">
    ${INSTAGRAM_GLYPH}
    <span>Built by AI, Data &amp; Marketing by Wambui</span>
  </div>
</div>`;

export const LAUNCH_SPLASH_STYLES = `
/* The document itself carries the launch background until the frame has gone,
   so no browser-default white and no previous screen ever shows between the
   layers. */
html:not(.neo-launched),
html:not(.neo-launched) body{background-color:#0B0D0F}
html.neo-launched,html.neo-launched body{transition:background-color .3s ease-out}
#neo-launch{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:#0B0D0F;color:#F7F2E8;opacity:1;pointer-events:none;
  transition:opacity .34s cubic-bezier(.4,0,.2,1),transform .34s cubic-bezier(.4,0,.2,1);
  padding:env(safe-area-inset-top) env(safe-area-inset-right) max(2rem,env(safe-area-inset-bottom)) env(safe-area-inset-left)}
#neo-launch.neo-launch--out{opacity:0;transform:scale(1.035)}
#neo-launch.neo-launch--warm{transition-duration:.18s}
#neo-launch .neo-launch__ambient{position:absolute;inset:0;
  background:radial-gradient(60% 45% at 50% 42%,rgba(200,169,107,.20) 0%,rgba(200,169,107,.06) 38%,rgba(11,13,15,0) 72%);
  opacity:0;animation:neo-launch-bloom 1.1s cubic-bezier(.22,.7,.28,1) forwards}
#neo-launch .neo-launch__stage{position:relative;display:flex;flex-direction:column;align-items:center;gap:.7rem;
  padding:2rem;max-width:22rem;text-align:center}
#neo-launch .neo-launch__markwrap{position:relative;border-radius:26%;
  transform:scale(.86) translateY(6px);opacity:0;
  animation:neo-launch-lift .56s cubic-bezier(.16,.84,.26,1) forwards}
#neo-launch .neo-launch__halo{position:absolute;inset:-28%;border-radius:50%;
  background:radial-gradient(circle,rgba(200,169,107,.34) 0%,rgba(200,169,107,0) 68%);
  opacity:0;animation:neo-launch-halo 1.5s .25s cubic-bezier(.22,.7,.28,1) infinite}
#neo-launch .neo-launch__mark{position:relative;display:block;width:104px;height:104px;object-fit:contain}
#neo-launch .neo-launch__sheen{position:absolute;top:-20%;bottom:-20%;width:38%;left:-45%;border-radius:26%;
  background:linear-gradient(100deg,rgba(255,255,255,0) 0%,rgba(255,248,231,.55) 50%,rgba(255,255,255,0) 100%);
  transform:skewX(-14deg);animation:neo-launch-sheen .85s .42s cubic-bezier(.4,0,.2,1) forwards;opacity:0}
#neo-launch .neo-launch__word{margin:.25rem 0 0;font-size:1.5rem;letter-spacing:.9em;font-weight:600;color:#FFFFFF;
  text-indent:.9em;opacity:0;animation:neo-launch-settle .7s .26s cubic-bezier(.16,.84,.26,1) forwards;
  font-family:'Plus Jakarta Sans',system-ui,sans-serif}
#neo-launch .neo-launch__sub{margin:0;font-size:.78rem;letter-spacing:.12em;color:#F7F2E8;
  opacity:0;transform:translateY(8px);animation:neo-launch-rise .4s .5s ease-out forwards;
  font-family:'Plus Jakarta Sans',system-ui,sans-serif}
#neo-launch .neo-launch__powered{display:inline-flex;align-items:center;gap:.5rem;margin-top:.35rem;
  opacity:0;transform:translateY(8px);animation:neo-launch-rise .4s .62s ease-out forwards}
#neo-launch .neo-launch__poweredlabel{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:#D6D1C8;
  font-family:'Plus Jakarta Sans',system-ui,sans-serif}
#neo-launch .neo-launch__poweredmark{display:inline-flex;align-items:center;border-radius:.375rem;
  background:#020A1C;padding:.25rem .5rem}
#neo-launch .neo-launch__poweredmark img{height:14px;width:auto;object-fit:contain;display:block}
#neo-launch .neo-launch__bar{display:block;margin-top:.9rem;width:118px;height:2px;border-radius:2px;
  background:rgba(247,242,232,.12);overflow:hidden;opacity:0;animation:neo-launch-rise .3s .7s ease-out forwards}
#neo-launch .neo-launch__bar i{display:block;height:100%;width:40%;border-radius:2px;
  background:linear-gradient(90deg,rgba(200,169,107,0),#C8A96B,rgba(200,169,107,0));
  animation:neo-launch-track 1.15s .75s cubic-bezier(.45,0,.35,1) infinite}
#neo-launch .neo-launch__credit{position:absolute;left:0;right:0;bottom:max(1.25rem,env(safe-area-inset-bottom));
  display:flex;align-items:center;justify-content:center;gap:.4rem;padding:0 1.25rem;
  font-size:.68rem;color:#D6D1C8;opacity:0;animation:neo-launch-rise .4s .78s ease-out forwards;
  font-family:'Plus Jakarta Sans',system-ui,sans-serif}
#neo-launch .neo-launch__ig{width:14px;height:14px;flex:none}
@keyframes neo-launch-bloom{0%{opacity:0}45%{opacity:1}100%{opacity:.75}}
@keyframes neo-launch-lift{to{transform:scale(1) translateY(0);opacity:1}}
@keyframes neo-launch-halo{0%{opacity:0;transform:scale(.9)}40%{opacity:.85}100%{opacity:0;transform:scale(1.18)}}
@keyframes neo-launch-sheen{0%{left:-45%;opacity:0}20%{opacity:1}100%{left:115%;opacity:0}}
@keyframes neo-launch-settle{0%{opacity:0;letter-spacing:.9em;text-indent:.9em}
  60%{opacity:1}100%{opacity:1;letter-spacing:.32em;text-indent:.32em}}
@keyframes neo-launch-rise{to{opacity:1;transform:translateY(0)}}
@keyframes neo-launch-track{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}
@media (prefers-reduced-motion: reduce){
  #neo-launch *{animation:none !important}
  #neo-launch .neo-launch__ambient{opacity:.7}
  #neo-launch .neo-launch__markwrap,#neo-launch .neo-launch__word,#neo-launch .neo-launch__sub,
  #neo-launch .neo-launch__powered,#neo-launch .neo-launch__bar,#neo-launch .neo-launch__credit{
    opacity:1;transform:none}
  #neo-launch .neo-launch__word{letter-spacing:.32em;text-indent:.32em}
  #neo-launch .neo-launch__halo,#neo-launch .neo-launch__sheen{display:none}
}`;

/**
 * Runs before hydration. Handles warm launches, the cached property logo, the
 * cold-launch lockup floor and the safety timer, and exposes
 * window.neoLaunchDone() for the app to call as soon as it has painted.
 */
export const LAUNCH_SPLASH_SCRIPT = `(function(){
  var el = document.getElementById('neo-launch');
  if (!el) return;
  var root = document.documentElement;
  var removed = false;
  var born = Date.now();
  var floor = ${LAUNCH_COLD_FLOOR_MS};
  function hide(){
    if (removed) return; removed = true;
    el.classList.add('neo-launch--out');
    // The document keeps the launch background through the cross-fade, so the
    // destination shell appears underneath rather than after a white frame.
    window.setTimeout(function(){
      root.classList.add('neo-launched');
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }, 360);
  }
  function remove(){
    if (removed) return;
    var left = floor - (Date.now() - born);
    if (left > 0) { window.setTimeout(hide, left); floor = 0; return; }
    hide();
  }
  window.neoLaunchDone = remove;
  try {
    // Warm launch: this tab has already seen the launch frame. Still a short
    // cross-fade — snapping it away lets the previous screen flash through on
    // mobile before the new one has painted.
    if (window.sessionStorage.getItem('neo.launched') === '1') {
      floor = 160; el.classList.add('neo-launch--warm'); window.__neoWarmStart = true;
    } else {
      window.__neoWarmStart = false;
      window.sessionStorage.setItem('neo.launched','1');
    }
  } catch (e) { /* private mode — treat as a cold launch */ }
  try {
    // Property Guest experience: canonical cached property branding, applied
    // before the animation starts so the mark is never swapped mid-flight.
    var raw = window.localStorage.getItem('neo.lockup.v1') || window.localStorage.getItem('neo.brand.v1');
    if (raw) {
      var brand = JSON.parse(raw);
      if (brand && brand.logo) {
        var img = document.getElementById('neo-launch-mark');
        if (img) { img.onerror = function(){ img.src = '/neo-splash-mark.png'; }; img.src = brand.logo; }
      }
      if (brand && brand.name) {
        var word = document.getElementById('neo-launch-word');
        var sub = document.getElementById('neo-launch-sub');
        if (word) { word.textContent = brand.name; word.style.letterSpacing = '.06em'; word.style.textIndent='.06em'; word.style.animation='neo-launch-rise .4s .26s ease-out forwards'; word.style.opacity='0'; word.style.transform='translateY(8px)'; }
        if (sub) { sub.textContent = 'Guest Experience'; sub.hidden = false; }
      }
    }
  } catch (e) { /* fall back to the NEØ mark */ }
  // Backstops only — the application dismisses this the moment it paints.
  // The launch coordinator (src/lib/launch-state.ts) dismisses this once the
  // real destination has painted. A downloaded bundle or a 'load' event is NOT
  // readiness — removing on those exposed a white frame before the app painted.
  window.neoLaunchMarks = {
    shellPaintedAt: Math.round(performance.now()),
    bundleStartedAt: null,
    buildVersion: document.documentElement.getAttribute('data-build') || null
  };
  // Hard safety net only: nobody is ever trapped on the splash.
  window.setTimeout(hide, 8000);
})();`;
