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

// ---- Anchored dims: top edge of pill sits at y = TOP_ANCHOR always ----
const TOP_ANCHOR = 20.0;
function anchored(w, h) {
    return { w: w, h: h, y: TOP_ANCHOR + h };
}
// Full on-screen sizes (NOT half-extents). Pill grows downward from top.
const DIM = {
    dot:     anchored(30,  30),
    welcome: anchored(380, 60),
    idle:    anchored(200, 44),
    loading: anchored(400, 128),
    success: anchored(480, 200),
    close:   anchored(290, 52),
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
const closePanel    = document.getElementById('close-panel');
const PANELS = [welcomePanel, idlePanel, loadingPanel, successPanel, closePanel];

// ==========================================
//  State machine
// ==========================================
let state = 'dot';
let stateStart = NOW();
let loadingActive = false;
let loadingProduct = '';
let loadingPct = 0;

const DIMS_FOR = {
    dot: DIM.dot, expanding: DIM.welcome, welcome: DIM.welcome,
    retracting: DIM.idle, idle: DIM.idle,
    loading: DIM.loading, success: DIM.success, close: DIM.close,
};
function setState(next) {
    state = next;
    stateStart = NOW();
    const t = DIMS_FOR[next] || DIM.idle;
    sW.setTarget(t.w); sH.setTarget(t.h); sY.setTarget(t.y);
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

function connectIslandWS() {
    const host = window.YULLY_HOST || '127.0.0.1:3000';
    const ws = new WebSocket(`ws://${host}/ws-island`);
    ws.onopen = () => console.log('[island] ws open');
    ws.onmessage = (ev) => {
        try {
            const m = JSON.parse(ev.data);
            if (m.type !== 'island') return;
            if (m.action === 'start') {
                loadingActive = true;
                loadingProduct = m.product || 'product';
                loadingPct = 0;
                paintProgress();
                setState('loading');
            } else if (m.action === 'progress') {
                loadingPct = Number(m.pct) || 0;
                paintProgress();
            } else if (m.action === 'done') {
                loadingPct = 100;
                paintProgress();
                loadingActive = false;
                setState('success');
                setTimeout(() => { if (state === 'success') setState('close'); }, TIMING.successHold * 1000);
            }
        } catch {}
    };
    ws.onclose = () => setTimeout(connectIslandWS, 1200);
    ws.onerror = () => ws.close();
}
connectIslandWS();

closePanel.addEventListener('click', () => setState('idle'));

// ==========================================
//  Panel alignment + opacity
// ==========================================
function alignAllPanels() {
    // Pill's true vertical centre = TOP_ANCHOR + h/2. Previously I was
    // handing panels the pill's BOTTOM edge (sY = TOP_ANCHOR + h), which
    // parked the text on the bottom rim.
    const centreY = TOP_ANCHOR + sH.value / 2;
    for (const el of PANELS) {
        el.style.top       = centreY + 'px';
        el.style.transform = 'translate(-50%, -50%)';
    }
}

function paintPanelOpacities(now) {
    const dt = now - stateStart;
    let welcome = 0, idle = 0, loading = 0, success = 0, close = 0;
    if (state === 'welcome') {
        if (dt < TIMING.welcomeIn) welcome = dt / TIMING.welcomeIn;
        else if (dt < TIMING.welcomeIn + TIMING.welcomeHold) welcome = 1;
        else welcome = 1 - clamp01((dt - TIMING.welcomeIn - TIMING.welcomeHold) / TIMING.welcomeOut);
    } else if (state === 'idle')       idle = 1;
    else if (state === 'retracting')   idle = clamp01(dt / TIMING.retracting);
    else if (state === 'loading')      loading = 1;
    else if (state === 'success')      success = 1;
    else if (state === 'close')        close = 1;

    welcomePanel.style.opacity = String(welcome);
    idlePanel.style.opacity    = String(idle);
    loadingPanel.style.opacity = String(loading);
    successPanel.style.opacity = String(success);
    closePanel.style.opacity   = String(close);
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

    if (!loadingActive && state !== 'success' && state !== 'close') updateStateMachine(now);

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
