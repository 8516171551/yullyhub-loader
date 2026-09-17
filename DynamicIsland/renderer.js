// ==========================================
//  YullyHub Dynamic Island — Liquid Glass edition
//
//  Real refraction — no three.js.  A single HTML div is the "glass",
//  its ::after is `backdrop-filter: url(#liquid-glass-filter)`, and
//  the SVG filter is rebuilt on the fly from a physically-motivated
//  displacement map (Snell's law over a convex-squircle surface
//  profile).  Because the electron window is transparent, the
//  backdrop the filter reads IS the desktop behind us.
//
//  Refraction technique is a direct port of
//    https://github.com/archisvaze/liquid-glass  (SVG demo)
//  applied to a state-machine-driven, spring-animated pill.
// ==========================================

const NOW = () => performance.now() / 1000.0;
const clamp01 = (t) => Math.max(0, Math.min(1, t));

// ---- Anchored dims: BOTTOM edge of pill sits at y = BOTTOM_ANCHOR always.
// `y` in the sY spring represents the pill's BOTTOM edge (in stage-px).
// Because the anchor is fixed at the bottom, as the pill grows taller
// its TOP edge rises upward — so the pill "grows up" from the bottom of
// the window. Stage height H is defined below as 340. ---------------
const BOTTOM_ANCHOR = 320.0;   // 20px margin from the stage's bottom edge
function anchored(w, h) {
    return { w: w, h: h, y: BOTTOM_ANCHOR };
}
// Full on-screen sizes (NOT half-extents). Pill grows downward from top.
const DIM = {
    // A truly-hidden state: 0×0 pill so nothing paints. Every panel's
    // opacity is set to 0 while `state === 'hidden'`.
    hidden:  anchored(0,   0),
    dot:     anchored(30,  30),
    welcome: anchored(380, 60),
    idle:    anchored(200, 44),
    loading: anchored(400, 128),
    success: anchored(480, 200),
    close:   anchored(290, 52),
    // Message pill used by the SCRIPT engine — resized to fit each step's
    // text (see measureMsgDims below).
    msg:     anchored(440, 60),
};

const TIMING = {
    dot:         0.40,
    expanding:   0.55,
    welcomeIn:   0.28,
    welcomeHold: 1.30,
    welcomeOut:  0.28,
    retracting:  0.65,
    successHold: 2.20,
};

// ==========================================
//  Liquid-glass displacement + specular map generators
//  Direct port of archisvaze/liquid-glass (index.html) —
//  see calculateRefractionProfile / generateDisplacementMap /
//  generateSpecularMap.  Snell over a convex-squircle bezel.
// ==========================================
const SURFACE_FN = (x) => Math.pow(1 - Math.pow(1 - x, 4), 0.25); // convex squircle

function calculateRefractionProfile(glassThickness, bezelWidth, ior, samples) {
    samples = samples || 128;
    const eta = 1 / ior;
    function refract(nx, ny) {
        const dot = ny;
        const k = 1 - eta * eta * (1 - dot * dot);
        if (k < 0) return null;
        const sq = Math.sqrt(k);
        return [-(eta * dot + sq) * nx, eta - (eta * dot + sq) * ny];
    }
    const profile = new Float64Array(samples);
    for (let i = 0; i < samples; i++) {
        const x = i / samples;
        const y = SURFACE_FN(x);
        const dx = x < 1 ? 0.0001 : -0.0001;
        const y2 = SURFACE_FN(x + dx);
        const deriv = (y2 - y) / dx;
        const mag = Math.sqrt(deriv * deriv + 1);
        const ref = refract(-deriv / mag, -1 / mag);
        if (!ref) { profile[i] = 0; continue; }
        profile[i] = ref[0] * ((y * bezelWidth + glassThickness) / ref[1]);
    }
    return profile;
}

function generateDisplacementMap(w, h, radius, bezelWidth, profile, maxDisp) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        d[i] = 128; d[i + 1] = 128; d[i + 2] = 0; d[i + 3] = 255;
    }
    const r = radius, rSq = r * r, r1Sq = (r + 1) ** 2;
    const rBSq = Math.max(r - bezelWidth, 0) ** 2;
    const wB = w - r * 2, hB = h - r * 2, S = profile.length;

    for (let y1 = 0; y1 < h; y1++) {
        for (let x1 = 0; x1 < w; x1++) {
            const x = x1 < r ? x1 - r : x1 >= w - r ? x1 - r - wB : 0;
            const y = y1 < r ? y1 - r : y1 >= h - r ? y1 - r - hB : 0;
            const dSq = x * x + y * y;
            if (dSq > r1Sq || dSq < rBSq) continue;
            const dist = Math.sqrt(dSq);
            const fromSide = r - dist;
            const op = dSq < rSq ? 1
                : 1 - (dist - Math.sqrt(rSq)) / (Math.sqrt(r1Sq) - Math.sqrt(rSq));
            if (op <= 0 || dist === 0) continue;
            const cos = x / dist, sin = y / dist;
            const bi = Math.min(((fromSide / bezelWidth) * S) | 0, S - 1);
            const disp = profile[bi] || 0;
            const dX = (-cos * disp) / maxDisp;
            const dY = (-sin * disp) / maxDisp;
            const idx = (y1 * w + x1) * 4;
            d[idx]     = (128 + dX * 127 * op + 0.5) | 0;
            d[idx + 1] = (128 + dY * 127 * op + 0.5) | 0;
        }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
}

function generateSpecularMap(w, h, radius, bezelWidth, angle) {
    angle = angle != null ? angle : Math.PI / 3;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    d.fill(0);
    const r = radius, rSq = r * r, r1Sq = (r + 1) ** 2;
    const rBSq = Math.max(r - bezelWidth, 0) ** 2;
    const wB = w - r * 2, hB = h - r * 2;
    const sv = [Math.cos(angle), Math.sin(angle)];

    for (let y1 = 0; y1 < h; y1++) {
        for (let x1 = 0; x1 < w; x1++) {
            const x = x1 < r ? x1 - r : x1 >= w - r ? x1 - r - wB : 0;
            const y = y1 < r ? y1 - r : y1 >= h - r ? y1 - r - hB : 0;
            const dSq = x * x + y * y;
            if (dSq > r1Sq || dSq < rBSq) continue;
            const dist = Math.sqrt(dSq);
            const fromSide = r - dist;
            const op = dSq < rSq ? 1
                : 1 - (dist - Math.sqrt(rSq)) / (Math.sqrt(r1Sq) - Math.sqrt(rSq));
            if (op <= 0 || dist === 0) continue;
            const cos = x / dist, sin = -y / dist;
            const dot = Math.abs(cos * sv[0] + sin * sv[1]);
            const edge = Math.sqrt(Math.max(0, 1 - (1 - fromSide) ** 2));
            const coeff = dot * edge;
            const col = (255 * coeff) | 0;
            const alpha = (col * coeff * op) | 0;
            const idx = (y1 * w + x1) * 4;
            d[idx]     = col;
            d[idx + 1] = col;
            d[idx + 2] = col;
            d[idx + 3] = alpha;
        }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
}

// ==========================================
//  Filter rebuild — call whenever pill dims change meaningfully.
// ==========================================
const FILTER_PARAMS = {
    glassThick:   80,
    bezelWidth:   28,
    ior:          3.0,
    scaleRatio:   0.75,
    blurAmt:      0.5,
    specOpacity:  0.45,
    specSat:      1.0,
};

const svgDefs = document.getElementById('svg-defs');
let _lastFilterKey = '';

function rebuildFilter(w, h, radius) {
    const iw = Math.max(2, Math.round(w));
    const ih = Math.max(2, Math.round(h));
    const ir = Math.max(1, Math.min(Math.round(radius), Math.min(iw, ih) / 2));
    const key = `${iw}x${ih}r${ir}`;
    if (key === _lastFilterKey) return;
    _lastFilterKey = key;

    const clampedBezel = Math.min(FILTER_PARAMS.bezelWidth, ir - 1, Math.min(iw, ih) / 2 - 1);
    if (clampedBezel < 2) {
        svgDefs.innerHTML = '';
        return;
    }
    const profile = calculateRefractionProfile(FILTER_PARAMS.glassThick, clampedBezel, FILTER_PARAMS.ior, 128);
    let maxDisp = 0;
    for (let i = 0; i < profile.length; i++) if (Math.abs(profile[i]) > maxDisp) maxDisp = Math.abs(profile[i]);
    if (maxDisp < 0.0001) maxDisp = 1;
    const dispUrl = generateDisplacementMap(iw, ih, ir, clampedBezel, profile, maxDisp);
    const specUrl = generateSpecularMap(iw, ih, ir, clampedBezel * 2.5);
    const scale   = maxDisp * FILTER_PARAMS.scaleRatio;

    svgDefs.innerHTML = `
        <filter id="liquid-glass-filter" x="0%" y="0%" width="100%" height="100%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="${FILTER_PARAMS.blurAmt}" result="blurred_source" />
            <feImage href="${dispUrl}" x="0" y="0" width="${iw}" height="${ih}" result="disp_map" />
            <feDisplacementMap in="blurred_source" in2="disp_map"
                scale="${scale}" xChannelSelector="R" yChannelSelector="G"
                result="displaced" />
            <feColorMatrix in="displaced" type="saturate" values="${FILTER_PARAMS.specSat}" result="displaced_sat" />
            <feImage href="${specUrl}" x="0" y="0" width="${iw}" height="${ih}" result="spec_layer" />
            <feComposite in="displaced_sat" in2="spec_layer" operator="in" result="spec_masked" />
            <feComponentTransfer in="spec_layer" result="spec_faded">
                <feFuncA type="linear" slope="${FILTER_PARAMS.specOpacity}" />
            </feComponentTransfer>
            <feBlend in="spec_masked" in2="displaced" mode="normal" result="with_sat" />
            <feBlend in="spec_faded" in2="with_sat" mode="normal" />
        </filter>
    `;
}

// ==========================================
//  Shape spring — one 2D spring per dim, mass-spring-damper
// ==========================================
class Spring1 {
    constructor(k, c, m) { this.value = 0; this.velocity = 0; this.target = 0; this.k=k; this.c=c; this.m=m; }
    setTarget(v)  { this.target = v; }
    snapTo(v)     { this.value = v; this.target = v; this.velocity = 0; }
    update(delta) {
        const dt = Math.min(delta, 0.033), sub = 4, sd = dt / sub;
        for (let i = 0; i < sub; i++) {
            const disp = this.value - this.target;
            const a = (-this.k*disp - this.c*this.velocity) / Math.max(this.m, 0.01);
            this.velocity += a * sd;
            this.value    += this.velocity * sd;
        }
        if (Math.abs(this.velocity) < 0.0001 && Math.abs(this.value - this.target) < 0.0001) {
            this.value = this.target; this.velocity = 0;
        }
        return this.value;
    }
}
const sW = new Spring1(230, 24, 1.0);
const sH = new Spring1(230, 24, 1.0);
const sY = new Spring1(200, 22, 1.0);
sW.snapTo(DIM.dot.w); sH.snapTo(DIM.dot.h); sY.snapTo(DIM.dot.y);

// ==========================================
//  DOM handles
// ==========================================
const glass         = document.getElementById('glass');
const welcomePanel  = document.getElementById('welcome-panel');
const idlePanel     = document.getElementById('idle-panel');
const loadingPanel  = document.getElementById('loading-panel');
const loadStatus    = document.getElementById('load-status');
const loadFill      = document.getElementById('load-fill');
const successPanel  = document.getElementById('success-panel');
const successText   = document.getElementById('success-text');
const closePanel    = document.getElementById('close-panel');
const msgPanel      = document.getElementById('msg-panel');
const msgText       = document.getElementById('msg-text');
const msgHint       = document.getElementById('msg-hint');
const PANELS = [welcomePanel, idlePanel, loadingPanel, successPanel, closePanel, msgPanel];

// ==========================================
//  State machine — the island starts INVISIBLE. No birth animation,
//  no idle brand pill. It only appears once a script event arrives.
// ==========================================
let state = 'hidden';
let stateStart = NOW();
let loadingActive = false;
let loadingProduct = '';
let loadingPct = 0;
sW.snapTo(DIM.hidden.w); sH.snapTo(DIM.hidden.h); sY.snapTo(DIM.hidden.y);

const DIMS_FOR = {
    hidden: DIM.hidden,
    dot: DIM.dot, expanding: DIM.welcome, welcome: DIM.welcome,
    retracting: DIM.hidden, idle: DIM.hidden,   // retract straight to hidden
    loading: DIM.loading, success: DIM.success, close: DIM.close,
    msg: DIM.msg,
};
function setState(next, dimOverride) {
    state = next;
    stateStart = NOW();
    const t = dimOverride || DIMS_FOR[next] || DIM.idle;
    sW.setTarget(t.w); sH.setTarget(t.h); sY.setTarget(t.y);
}

// ---- Auto-sized message pill --------------------------------------------
// Measure the current step's text (+ optional keybind hint) using a hidden
// element that inherits the exact msg-panel typography, then return a dim
// tuple the msg pill should morph to. Grows in X for short text, wraps to
// multiple lines and grows in Y for long text.
const _measureBox = document.createElement('div');
Object.assign(_measureBox.style, {
    position: 'absolute',
    visibility: 'hidden',
    pointerEvents: 'none',
    top: '-2000px', left: '-2000px',
    fontFamily: "'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontWeight: '500',
    fontSize: '14px',
    letterSpacing: '0.3px',
    lineHeight: '1.35',
    padding: '6px 26px',
    boxSizing: 'border-box',
});
document.body.appendChild(_measureBox);

const MSG_MIN_W = 180;
const MSG_MAX_W = 640;   // stage width is 780 — leave breathing room
const MSG_MIN_H = 48;
const MSG_PAD_H = 18;    // px of vertical breathing room around the text

function measureMsgDims(text, keybind) {
    const label = (text || '') + (keybind ? '   ' + keybind : '');

    // 1st pass: no wrap — natural width of the text.
    _measureBox.style.whiteSpace = 'nowrap';
    _measureBox.style.maxWidth = 'none';
    _measureBox.textContent = label;
    let w = _measureBox.offsetWidth;
    let h = _measureBox.offsetHeight;

    // Fits on one line inside our max? Use it directly.
    if (w <= MSG_MAX_W) {
        const finalW = Math.max(MSG_MIN_W, w + 24);   // 12px pad each side
        const finalH = Math.max(MSG_MIN_H, h + MSG_PAD_H);
        msgPanel.style.whiteSpace = 'nowrap';
        msgPanel.style.maxWidth = 'none';
        return anchored(finalW, finalH);
    }

    // Too wide — wrap to MSG_MAX_W and re-measure the height.
    _measureBox.style.whiteSpace = 'normal';
    _measureBox.style.maxWidth = MSG_MAX_W + 'px';
    h = _measureBox.offsetHeight;
    msgPanel.style.whiteSpace = 'normal';
    msgPanel.style.maxWidth = MSG_MAX_W + 'px';
    return anchored(MSG_MAX_W, Math.max(MSG_MIN_H, h + MSG_PAD_H));
}

// ==========================================
//  WS bridge
// ==========================================
function paintProgress() {
    loadStatus.textContent = loadingActive
        ? `Loading ${loadingProduct}...`
        : 'Loading product...';
    loadFill.style.width = clamp01(loadingPct / 100) * 100 + '%';
}
paintProgress();

// ==========================================
//  SCRIPT ENGINE — plays an admin-authored sequence of steps.
//  Each step: { kind: 'message'|'close', text, dismiss, timeout, keybind }
// ==========================================
let scriptSteps = [];
let scriptIdx = 0;
let scriptTimer = null;
let scriptKeybind = null;
let scriptUnhook = null;

function clearScriptWaits() {
    if (scriptTimer !== null) { clearTimeout(scriptTimer); scriptTimer = null; }
    if (scriptKeybind && window.electronAPI) {
        window.electronAPI.unregisterKeybind(scriptKeybind);
    }
    scriptKeybind = null;
}

function endScript() {
    clearScriptWaits();
    scriptSteps = [];
    scriptIdx = 0;
    // Vanish entirely — no idle brand pill, no ghost.
    setState('hidden');
}

// Monotonically-increasing script generation — every fresh `script` event
// bumps it. Any timer / keybind that fires from an OLD generation is
// silently discarded so a re-triggered script never plays 2 steps at once.
let scriptGen = 0;

function playStep(i) {
    const myGen = scriptGen;
    const captured = i;   // capture BY VALUE, no module-level state races
    clearScriptWaits();
    if (!Array.isArray(scriptSteps) || captured >= scriptSteps.length) {
        endScript();
        return;
    }
    scriptIdx = captured;
    const step = scriptSteps[captured] || {};
    const kind = step.kind || 'message';
    console.log('[island] step', captured, kind, step.text || '', 'timeout=', step.timeout, 'key=', step.keybind);

    if (kind === 'success') {
        // Big check-mark stage with custom text below it, then advance
        // after `timeout` seconds (default 2.5).
        if (step.text) successText.textContent = step.text;
        setState('success');
        const secs = Number(step.timeout);
        const ms = (Number.isFinite(secs) && secs > 0) ? secs * 1000 : 2500;
        const nextIdx = captured + 1;
        scriptTimer = setTimeout(() => {
            if (myGen !== scriptGen) return;
            playStep(nextIdx);
        }, ms);
        return;
    }

    if (kind === 'close') {
        // If the author supplied bye-text we show the close pill briefly.
        // If they left it blank we skip the pill entirely and collapse
        // straight to hidden — no "Click me to close loader" default.
        const byeText = (step.text || '').trim();
        if (!byeText) {
            endScript();
            return;
        }
        closePanel.textContent = byeText;
        setState('close');
        const secs = Number(step.timeout);
        const ms = (Number.isFinite(secs) && secs > 0) ? secs * 1000 : 900;
        scriptTimer = setTimeout(() => {
            if (myGen !== scriptGen) return;
            endScript();
        }, ms);
        return;
    }

    // message kind — auto-size pill to fit the text (grows x + y as needed)
    msgText.textContent = step.text || '';
    const wantsKey = (step.dismiss === 'keybind' || step.dismiss === 'both') && step.keybind;
    const wantsTimeout = (step.dismiss === 'timeout' || step.dismiss === 'both' || !step.dismiss);

    if (wantsKey) {
        msgHint.textContent = step.keybind;
        msgHint.style.display = 'inline-flex';
        scriptKeybind = step.keybind;
        if (window.electronAPI) {
            window.electronAPI.registerKeybind(step.keybind);
        }
    } else {
        msgHint.style.display = 'none';
    }

    // Measure THEN morph — dims are custom per step.
    const dims = measureMsgDims(step.text, wantsKey ? step.keybind : null);
    setState('msg', dims);

    if (wantsTimeout) {
        const secs = Number(step.timeout);
        const ms = (Number.isFinite(secs) && secs > 0) ? secs * 1000 : 2500;
        // Capture the CURRENT step index + generation so nothing external
        // can hijack the advance target.
        const nextIdx = captured + 1;
        scriptTimer = setTimeout(() => {
            if (myGen !== scriptGen) return;     // stale timer from a previous script — ignore
            playStep(nextIdx);
        }, ms);
    }
}

// Hook the OS keybind handler ONCE. Every registered accelerator is
// forwarded to us; we only advance if it matches the CURRENT waiting key
// AND belongs to the current script generation.
if (window.electronAPI && window.electronAPI.onKeybind) {
    scriptUnhook = window.electronAPI.onKeybind((acc) => {
        if (!acc || !scriptKeybind) return;
        if (acc.toUpperCase() !== scriptKeybind.toUpperCase()) return;
        playStep(scriptIdx + 1);
    });
}

function connectIslandWS() {
    const host = window.YULLY_HOST || '127.0.0.1:3000';
    const ws = new WebSocket(`ws://${host}/ws-island`);
    ws.onopen = () => console.log('[island] ws open');
    ws.onmessage = (ev) => {
        try {
            const m = JSON.parse(ev.data);
            if (m.type !== 'island') return;
            if (m.action === 'script' && Array.isArray(m.steps)) {
                // Fresh generation — invalidates all stale timers/keybind waits.
                scriptGen++;
                scriptSteps = m.steps;
                scriptIdx = 0;
                console.log('[island] script gen=', scriptGen, 'steps=', scriptSteps.length);
                playStep(0);
            } else if (m.action === 'cancel') {
                scriptGen++;
                endScript();
            }
        } catch {}
    };
    ws.onclose = () => setTimeout(connectIslandWS, 1200);
    ws.onerror = () => ws.close();
}
connectIslandWS();

// Any click on the island triggers a bounce animation and does nothing
// else. Previously clicking the close pill ended the script — user asked
// for the bye-pill to be non-interactive (advances only via its timeout).
function bounceGlass() {
    if (state === 'hidden') return;
    glass.classList.remove('bounce');
    // force a reflow so the animation restarts on repeat clicks
    void glass.offsetWidth;
    glass.classList.add('bounce');
    setTimeout(() => glass.classList.remove('bounce'), 360);
}
document.addEventListener('mousedown', (e) => {
    if (state === 'hidden') return;
    // only bounce when the click landed inside the pill's bounding box
    const rect = glass.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.right
                && e.clientY >= rect.top  && e.clientY <= rect.bottom;
    if (inside) bounceGlass();
});

// ==========================================
//  Panel alignment + opacity
// ==========================================
function alignAllPanels() {
    // Pill's true vertical centre = TOP_ANCHOR + h/2. Previously I was
    // handing panels the pill's BOTTOM edge (sY = TOP_ANCHOR + h), which
    // parked the text on the bottom rim.
    // Pill's true vertical centre = bottom-edge (sY) minus half its height.
    const centreY = sY.value - sH.value / 2;
    for (const el of PANELS) {
        el.style.top       = centreY + 'px';
        el.style.transform = 'translate(-50%, -50%)';
    }
}

function paintPanelOpacities(now) {
    const dt = now - stateStart;
    let welcome = 0, idle = 0, loading = 0, success = 0, close = 0, msg = 0;
    if (state === 'welcome') {
        if (dt < TIMING.welcomeIn) welcome = dt / TIMING.welcomeIn;
        else if (dt < TIMING.welcomeIn + TIMING.welcomeHold) welcome = 1;
        else welcome = 1 - clamp01((dt - TIMING.welcomeIn - TIMING.welcomeHold) / TIMING.welcomeOut);
    } else if (state === 'idle')       idle = 1;
    else if (state === 'retracting')   idle = clamp01(dt / TIMING.retracting);
    else if (state === 'loading')      loading = 1;
    else if (state === 'success')      success = 1;
    else if (state === 'close')        close = 1;
    else if (state === 'msg')          msg = 1;
    // state === 'hidden' → every panel stays at 0 (default)

    welcomePanel.style.opacity = String(welcome);
    idlePanel.style.opacity    = String(idle);
    loadingPanel.style.opacity = String(loading);
    successPanel.style.opacity = String(success);
    closePanel.style.opacity   = String(close);
    msgPanel.style.opacity     = String(msg);
}

// ==========================================
//  State transitions (time-driven for dot->expand->welcome->retract->idle)
// ==========================================
function updateStateMachine(now) {
    const dt = now - stateStart;
    if (state === 'dot'        && dt > TIMING.dot)        setState('expanding');
    else if (state === 'expanding' && dt > TIMING.expanding) setState('welcome');
    else if (state === 'welcome') {
        const total = TIMING.welcomeIn + TIMING.welcomeHold + TIMING.welcomeOut;
        if (dt > total) setState('retracting');
    } else if (state === 'retracting' && dt > TIMING.retracting) setState('idle');
}

// ==========================================
//  MAIN LOOP
// ==========================================
let prev = NOW();
function tick() {
    requestAnimationFrame(tick);
    const now = NOW();
    const delta = now - prev;
    prev = now;

    // Never auto-advance the birth timeline while a script is playing —
    // the script engine drives its own state changes end-to-end.
    if (state !== 'success' && state !== 'close' && state !== 'msg') updateStateMachine(now);

    const w = sW.update(delta);
    const h = sH.update(delta);
    const y = sY.update(delta);

    // Apply to glass element. Pill = fully-rounded rectangle.
    const r = Math.min(w, h) / 2;
    glass.style.width  = w + 'px';
    glass.style.height = h + 'px';
    glass.style.borderRadius = r + 'px';
    // top: distance from stage top to pill's own top edge.
    glass.style.top    = (y - h) + 'px';

    // Rebuild the SVG filter when dims change enough to matter (>= 1 px).
    rebuildFilter(w, h, r);

    alignAllPanels();
    paintPanelOpacities(now);
}
tick();

// ==========================================
//  Click-through hit test — only the pill's bounding box is opaque.
// ==========================================
let hovering = false;
document.addEventListener('mousemove', (e) => {
    const rect = glass.getBoundingClientRect();
    const pad = 6;
    const hit = e.clientX >= rect.left - pad && e.clientX <= rect.right + pad
             && e.clientY >= rect.top  - pad && e.clientY <= rect.bottom + pad;
    if (hit !== hovering) {
        hovering = hit;
        if (window.electronAPI) {
            if (hit) window.electronAPI.setIgnoreMouseEvents(false);
            else     window.electronAPI.setIgnoreMouseEvents(true, { forward: true });
        }
    }
});
document.addEventListener('mouseleave', () => {
    hovering = false;
    if (window.electronAPI) window.electronAPI.setIgnoreMouseEvents(true, { forward: true });
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.close();
    if (e.key === 'r' || e.key === 'R') {
        sW.snapTo(DIM.dot.w); sH.snapTo(DIM.dot.h); sY.snapTo(DIM.dot.y);
        setState('dot');
    }
});
