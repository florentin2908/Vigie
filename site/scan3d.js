/* Vigie — scan 3D de la vraie voiture (v0.15). Tout se calcule sur l'appareil : rien n'est envoyé.

   Une vidéo du tour de la voiture → la voiture en vraie 3D, peinte avec ses propres images.
   1. 72 images régulières de la vidéo (lecture accélérée + requestVideoFrameCallback, repli image par image).
   2. Détourage de la voiture sur chaque image : DeepLab v3 (MediaPipe, classes « car » et « bus »),
      en gardant la tache la plus proche du centre (une autre voiture garée plus loin est ignorée).
   3. Où était le téléphone : le décor derrière la voiture défile quand on tourne autour. Son décalage entre deux
      images (corrélation de phase, voiture masquée) donne l'angle parcouru ; le tour complet est ramené à 360°.
      La distance vient de la hauteur de la silhouette, corrigée au 2e passage par la forme trouvée au 1er.
   4. Sculpture (« coque visuelle ») : une grille de 96 × 96 × 96 cubes ; un cube reste s'il tombe dans la silhouette
      sur presque toutes les images qui le voient (quelques désaccords tolérés). Grossier puis fin.
   5. Peinture : 36 images régulières autour de la voiture, avec leur masque, rangées dans une planche (atlas) ;
      à l'affichage, chaque point de la forme prend la couleur des images qui le voient le mieux en face.
   Limites honnêtes : les creux (vitres, passages de roues) sont lissés, le dessous n'est pas vu, le toit est
   peu vu si le téléphone reste à hauteur des phares. */

export const N_FRAMES = 72, N_TEX = 36, GRID = 96;
const HFOV = 66;                  // champ de vision horizontal supposé de la caméra principale en paysage (degrés)
const CAR_H = 1.5, CAM_H = 0.85, TARGET_H = 0.7;
const WS = 320;                   // largeur des images d'analyse
const HERE = new URL('./', import.meta.url).href;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const tick = () => new Promise(r => setTimeout(r, 0));

/* ---------- 1. Images de la vidéo ---------- */
function seekTo(v, t) { return new Promise(res => { let done = false; const fin = () => { if (done) return; done = true; clearTimeout(to); v.removeEventListener('seeked', fin); res(); }; const to = setTimeout(fin, 4000); v.addEventListener('seeked', fin); v.currentTime = t; }); }
const toGray = d => { const g = new Uint8Array(d.length >> 2); for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; return g; };
const toJpeg = (c, q = .85) => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('jpeg')), 'image/jpeg', q));

async function grabFrames(file, progress, seekOnly) {
  const url = URL.createObjectURL(file), v = document.createElement('video');
  v.muted = true; v.defaultMuted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none;z-index:-1';
  document.body.appendChild(v);
  try {
    await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('lecture')), 20000); v.onloadeddata = () => { clearTimeout(to); res(); }; v.onerror = () => { clearTimeout(to); rej(new Error('lecture')); }; v.src = url; });
    const dur = v.duration;
    if (!v.videoWidth || !(dur > 0) || !isFinite(dur)) throw new Error('lecture');
    if (dur < 6) throw new Error('courte');
    const vw = v.videoWidth, vh = v.videoHeight;
    const BW = Math.min(1280, vw), BH = Math.round(vh * BW / vw), SW = WS, SH = Math.round(vh * SW / vw);   // 1280 px : texture plus nette
    const big = document.createElement('canvas'); big.width = BW; big.height = BH; const gb = big.getContext('2d');
    const sm = document.createElement('canvas'); sm.width = SW; sm.height = SH; const gs = sm.getContext('2d', { willReadFrequently: true });
    const GW = Math.min(640, vw), GH = Math.round(vh * GW / vw), gc = document.createElement('canvas'); gc.width = GW; gc.height = GH; const gg = gc.getContext('2d', { willReadFrequently: true });
    const grays = new Array(N_FRAMES), grayOf = () => { gg.drawImage(v, 0, 0, GW, GH); return toGray(gg.getImageData(0, 0, GW, GH).data); };
    const T = Array.from({ length: N_FRAMES }, (_, i) => Math.min(dur - .05, (i + .5) * dur / N_FRAMES)), step = dur / N_FRAMES;
    const bigs = new Array(N_FRAMES), smalls = new Array(N_FRAMES), times = new Array(N_FRAMES), jobs = []; let got = 0;
    const grab = (i, t) => { times[i] = t; gb.drawImage(v, 0, 0, BW, BH); gs.drawImage(v, 0, 0, SW, SH); smalls[i] = gs.getImageData(0, 0, SW, SH); grays[i] = grayOf(); got++; jobs.push(toJpeg(big).then(b => { bigs[i] = b; })); progress(got / N_FRAMES); };
    if ('requestVideoFrameCallback' in v && !seekOnly) {
      const rate = clamp(dur / 6, 1, 8);
      await new Promise(res => {
        let next = 0, done = false;
        const end = () => { if (done) return; done = true; clearTimeout(to); try { v.pause(); } catch (e) {} res(); };
        const to = setTimeout(end, Math.max(15000, dur / rate * 3000));
        const cb = (now, meta) => {
          if (done) return;
          const t = meta && meta.mediaTime != null ? meta.mediaTime : v.currentTime;
          while (next < N_FRAMES && t >= T[next] - step * .3) { if (t <= T[next] + step * .5) grab(next, t); next++; }
          if (next >= N_FRAMES) { end(); return; }
          v.requestVideoFrameCallback(cb);
        };
        v.requestVideoFrameCallback(cb);
        v.addEventListener('ended', end, { once: true });
        v.playbackRate = rate;
        const p = v.play(); if (p && p.catch) p.catch(end);
      });
    } else { try { await v.play(); v.pause(); } catch (e) {} }
    await Promise.all(jobs);
    for (let i = 0; i < N_FRAMES; i++) { if (smalls[i]) continue; await seekTo(v, T[i]); grab(i, v.currentTime); }
    await Promise.all(jobs);
    let sum = 0; const px = smalls[N_FRAMES >> 1].data; for (let i = 0; i < px.length; i += 4 * 97) sum += px[i] + px[i + 1] + px[i + 2];
    if (sum === 0) throw new Error('lecture');
    return { bigs, smalls, grays, times, SW, SH, BW, BH, GW, GH, dur };
  } finally { try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch (e) {} URL.revokeObjectURL(url); }
}

/* ---------- 2. Détourage de la voiture (DeepLab v3 via MediaPipe) ---------- */
let segP = null;
export function loadSegmenter() {
  if (!segP) segP = (async () => {
    const vision = await import(HERE + 'vendor/mediapipe/vision_bundle.mjs');
    // Le modèle est rangé en base64 (texte) : la page Claude ne sert pas les fichiers .tflite
    const res = await fetch(HERE + 'vendor/mediapipe/deeplab_v3.tflite.b64.txt'); if (!res.ok) throw new Error('modele');
    const b64 = (await res.text()).trim(), bin = atob(b64), model = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) model[i] = bin.charCodeAt(i);
    if (String.fromCharCode(...model.subarray(4, 8)) !== 'TFL3') throw new Error('modele');
    const seg = await vision.ImageSegmenter.createFromOptions(
      { wasmLoaderPath: HERE + 'vendor/mediapipe/vision_wasm_internal.js', wasmBinaryPath: HERE + 'vendor/mediapipe/vision_wasm_internal.wasm' },
      { baseOptions: { modelAssetBuffer: model, delegate: 'CPU' }, runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false });
    const labels = seg.getLabels().map(s => String(s).toLowerCase());
    const keep = ['car', 'bus'].map(k => labels.indexOf(k)).filter(i => i >= 0);
    if (!keep.length) throw new Error('modele');
    return { seg, keep };
  })();
  segP.catch(() => { segP = null; });
  return segP;
}

// Garde la tache de voiture la plus grande et la plus proche du centre, bouche les trous (vitres, reflets)
function cleanMask(raw, W, H) {
  const lab = new Int32Array(W * H).fill(-1), comps = []; const st = [];
  for (let i = 0; i < W * H; i++) {
    if (!raw[i] || lab[i] >= 0) continue;
    const id = comps.length; let n = 0, sx = 0, sy = 0; st.push(i); lab[i] = id;
    while (st.length) { const k = st.pop(), x = k % W, y = (k / W) | 0; n++; sx += x; sy += y;
      if (x > 0 && raw[k - 1] && lab[k - 1] < 0) { lab[k - 1] = id; st.push(k - 1); }
      if (x < W - 1 && raw[k + 1] && lab[k + 1] < 0) { lab[k + 1] = id; st.push(k + 1); }
      if (y > 0 && raw[k - W] && lab[k - W] < 0) { lab[k - W] = id; st.push(k - W); }
      if (y < H - 1 && raw[k + W] && lab[k + W] < 0) { lab[k + W] = id; st.push(k + W); } }
    const d = Math.hypot(sx / n - W / 2, sy / n - H / 2) / (W * .25);
    comps.push({ id, n, score: n / (1 + d * d) });
  }
  const m = new Uint8Array(W * H);
  if (!comps.length) return m;
  const best = comps.reduce((a, b) => b.score > a.score ? b : a);
  for (let i = 0; i < W * H; i++) if (lab[i] === best.id) m[i] = 1;
  // trous : tout ce qui n'est pas relié au bord de l'image est rempli
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) { for (const y of [0, H - 1]) { const k = y * W + x; if (!m[k] && !out[k]) { out[k] = 1; st.push(k); } } }
  for (let y = 0; y < H; y++) { for (const x of [0, W - 1]) { const k = y * W + x; if (!m[k] && !out[k]) { out[k] = 1; st.push(k); } } }
  while (st.length) { const k = st.pop(), x = k % W, y = (k / W) | 0;
    for (const j of [x > 0 ? k - 1 : -1, x < W - 1 ? k + 1 : -1, y > 0 ? k - W : -1, y < H - 1 ? k + W : -1]) if (j >= 0 && !m[j] && !out[j]) { out[j] = 1; st.push(j); } }
  for (let i = 0; i < W * H; i++) if (!out[i]) m[i] = 1;
  return m;
}
// Contour du détourage recalé sur les vrais bords de l'image (filtre guidé de He, Sun et Tang, guide en couleur) :
// DeepLab rend une silhouette un peu molle (sur la vidéo de test, 1 à 3 px de moins le long du toit) ; le filtre la
// plaque contre les bords de la voiture dans l'image, à r px près au plus.
function guidedMask(m, img, W, H, r, eps) {
  const N = W * H, d = img.data, I = [new Float32Array(N), new Float32Array(N), new Float32Array(N)], p = new Float32Array(N);
  for (let i = 0; i < N; i++) { I[0][i] = d[i * 4] / 255; I[1][i] = d[i * 4 + 1] / 255; I[2][i] = d[i * 4 + 2] / 255; p[i] = m[i]; }
  const S = new Float64Array((W + 1) * (H + 1));
  const box = src => { // moyenne sur une fenêtre (2r + 1)², par image intégrale
    for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += src[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; } }
    const out = new Float32Array(N);
    for (let y = 0; y < H; y++) { const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      for (let x = 0; x < W; x++) { const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
        out[y * W + x] = (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0)); } }
    return out; };
  const mul = (a, b) => { const o = new Float32Array(N); for (let i = 0; i < N; i++) o[i] = a[i] * b[i]; return o; };
  const mI = I.map(box), mp = box(p), mIp = I.map(c => box(mul(c, p))), vI = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]].map(([a, b]) => box(mul(I[a], I[b])));
  const A0 = new Float32Array(N), A1 = new Float32Array(N), A2 = new Float32Array(N), B = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const m0 = mI[0][i], m1 = mI[1][i], m2 = mI[2][i], pp = mp[i];
    const s00 = vI[0][i] - m0 * m0 + eps, s01 = vI[1][i] - m0 * m1, s02 = vI[2][i] - m0 * m2, s11 = vI[3][i] - m1 * m1 + eps, s12 = vI[4][i] - m1 * m2, s22 = vI[5][i] - m2 * m2 + eps;
    const c0 = mIp[0][i] - m0 * pp, c1 = mIp[1][i] - m1 * pp, c2 = mIp[2][i] - m2 * pp;
    const i00 = s11 * s22 - s12 * s12, i01 = s02 * s12 - s01 * s22, i02 = s01 * s12 - s02 * s11, i11 = s00 * s22 - s02 * s02, i12 = s01 * s02 - s00 * s12, i22 = s00 * s11 - s01 * s01;
    const det = s00 * i00 + s01 * i01 + s02 * i02;
    const a0 = (i00 * c0 + i01 * c1 + i02 * c2) / det, a1 = (i01 * c0 + i11 * c1 + i12 * c2) / det, a2 = (i02 * c0 + i12 * c1 + i22 * c2) / det;
    A0[i] = a0; A1[i] = a1; A2[i] = a2; B[i] = pp - a0 * m0 - a1 * m1 - a2 * m2;
  }
  const mA0 = box(A0), mA1 = box(A1), mA2 = box(A2), mB = box(B), out = new Uint8Array(N);
  for (let i = 0; i < N; i++) out[i] = mA0[i] * I[0][i] + mA1[i] * I[1][i] + mA2[i] * I[2][i] + mB[i] >= .5 ? 1 : 0;
  return out;
}
function dilate(m, W, H, r) {
  let a = m;
  for (let k = 0; k < r; k++) {
    const b = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x;
      b[i] = a[i] || (x > 0 && a[i - 1]) || (x < W - 1 && a[i + 1]) || (y > 0 && a[i - W]) || (y < H - 1 && a[i + W]) ? 1 : 0; }
    a = b;
  }
  return a;
}
function erode1(m, W, H) { const b = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; b[i] = m[i] && m[i - 1] && m[i + 1] && m[i - W] && m[i + W] ? 1 : 0; }
  return b; }
function maskStats(m, W, H) {
  let n = 0, x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { n, x0, x1, y0, y1, frac: n / (W * H), cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2, h: y1 - y0 + 1, w: x1 - x0 + 1,
    cutL: x0 <= 1, cutR: x1 >= W - 2, cutT: y0 <= 1, cutB: y1 >= H - 2 };
}

/* ---------- 3. Angle parcouru : corrélation de phase du décor ---------- */
function fft(re, im, inv) { // radix 2, sur place
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) { const ur = re[i + k], ui = im[i + k], j = i + k + len / 2, vr = re[j] * cr - im[j] * ci, vi = re[j] * ci + im[j] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[j] = ur - vr; im[j] = ui - vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
}
function fft2(re, im, W, H, inv) {
  const rr = new Float64Array(W), ri = new Float64Array(W);
  for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) { rr[x] = re[y * W + x]; ri[x] = im[y * W + x]; } fft(rr, ri, inv); for (let x = 0; x < W; x++) { re[y * W + x] = rr[x]; im[y * W + x] = ri[x]; } }
  const cr = new Float64Array(H), ci = new Float64Array(H);
  for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) { cr[y] = re[y * W + x]; ci[y] = im[y * W + x]; } fft(cr, ci, inv); for (let y = 0; y < H; y++) { re[y * W + x] = cr[y]; im[y * W + x] = ci[y]; } }
}
const GW = 128, GH = 64;
// Image grise 128 × 64 du décor, voiture (élargie) remplacée par la moyenne, fenêtre de Hann
function bgSpectrum(img, mask, SW, SH) {
  const g = new Float64Array(GW * GH), keep = new Uint8Array(GW * GH); let s = 0, c = 0;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const sx = Math.min(SW - 1, Math.floor((x + .5) * SW / GW)), sy = Math.min(SH - 1, Math.floor((y + .5) * SH / GH)), k = sy * SW + sx, p = k * 4;
    const v = .299 * img.data[p] + .587 * img.data[p + 1] + .114 * img.data[p + 2];
    g[y * GW + x] = v; if (!mask[k] && y < GH * .48) { keep[y * GW + x] = 1; s += v; c++; } // moitié haute : le sol, entre le téléphone et la voiture, défile en sens inverse
  }
  const mean = c ? s / c : 128;
  const re = new Float64Array(GW * GH), im = new Float64Array(GW * GH);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { const i = y * GW + x, w = (.5 - .5 * Math.cos(2 * Math.PI * (x + .5) / GW)) * (.5 - .5 * Math.cos(2 * Math.PI * (y + .5) / GH));
    re[i] = ((keep[i] ? g[i] : mean) - mean) * w; }
  fft2(re, im, GW, GH, false);
  return { re, im, bg: c / (GW * GH) };
}
// Décalage horizontal du décor de A vers B (en pixels de la grille 128) et netteté du pic
function shiftBetween(A, B) {
  const re = new Float64Array(GW * GH), im = new Float64Array(GW * GH);
  for (let i = 0; i < GW * GH; i++) { const r = B.re[i] * A.re[i] + B.im[i] * A.im[i], m = B.im[i] * A.re[i] - B.re[i] * A.im[i], mag = Math.hypot(r, m) + 1e-9; re[i] = r / mag; im[i] = m / mag; }
  fft2(re, im, GW, GH, true);
  let best = -1e9, bx = 0, by = 0, tot = 0;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { const v = re[y * GW + x]; tot += Math.abs(v); if (v > best) { best = v; bx = x; by = y; } }
  const at = (x, y) => re[((y + GH) % GH) * GW + ((x + GW) % GW)];
  const l = at(bx - 1, by), r = at(bx + 1, by), den = l - 2 * best + r, sub = den < 0 ? .5 * (l - r) / den : 0;
  let dx = bx + sub; if (dx > GW / 2) dx -= GW;
  let dy = by; if (dy > GH / 2) dy -= GH;
  return { dx, dy, peak: best / (tot / (GW * GH) + 1e-9) };
}

/* ---------- 4. Caméras et sculpture ---------- */
// Repère de la voiture : y vers le haut, origine au sol au centre du tour. Caméra i : position, droite, haut, avant.
// yaw > 0 : caméra tournée vers la gauche du centre de la voiture ; pitch > 0 : caméra levée
function makeCam(theta, d, yaw, pitch, th = TARGET_H, h = CAM_H, roll = 0) {
  const C = [Math.sin(theta) * d, h, Math.cos(theta) * d];
  let fw = [-C[0], th - C[1], -C[2]]; const n0 = Math.hypot(...fw); fw = fw.map(v => v / n0);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);                       // rotation autour de y (vers la gauche)
  fw = [fw[0] * cy + fw[2] * sy, fw[1], -fw[0] * sy + fw[2] * cy];
  let rt = [-fw[2], 0, fw[0]]; const nr = Math.hypot(...rt) || 1; rt = rt.map(v => v / nr);   // droite = avant × haut
  let up = [rt[1] * fw[2] - rt[2] * fw[1], rt[2] * fw[0] - rt[0] * fw[2], rt[0] * fw[1] - rt[1] * fw[0]];
  const cp = Math.cos(pitch), sp = Math.sin(pitch);                   // voiture vue plus bas → caméra levée
  const f2 = fw.map((v, k) => v * cp + up[k] * sp), u2 = up.map((v, k) => v * cp - fw[k] * sp);
  if (!roll) return { C, r: rt, u: u2, f: f2 };
  const cr = Math.cos(roll), sr = Math.sin(roll);                        // téléphone penché (roulis)
  return { C, r: rt.map((v, k) => v * cr + u2[k] * sr), u: u2.map((v, k) => v * cr - rt[k] * sr), f: f2 };
}
const camOf = p => makeCam(p.theta, p.d, p.yaw, p.pitch, p.th, p.h, p.roll);
function carve(cams, masks, SW, SH, fpx, box, n, coarse) {
  const { R, Y } = box, occ = new Uint8Array(n * n * n), nv = cams.length, maxOut = Math.max(2, Math.round(nv * .07));
  const order = []; for (let s = 0; s < 8; s++) for (let i = s; i < nv; i += 8) order.push(i);
  for (let z = 0; z < n; z++) { const wz = ((z + .5) / n * 2 - 1) * R;
    for (let y = 0; y < n; y++) { const wy = (y + .5) / n * Y; if (wy < .03) continue;
      for (let x = 0; x < n; x++) {
        if (coarse && !coarse(x, y, z)) continue;
        const wx = ((x + .5) / n * 2 - 1) * R; let out = 0, seen = 0;
        for (const i of order) { const c = cams[i], qx = wx - c.C[0], qy = wy - c.C[1], qz = wz - c.C[2];
          const zc = qx * c.f[0] + qy * c.f[1] + qz * c.f[2]; if (zc < .3) continue;
          const u = SW / 2 + fpx * (qx * c.r[0] + qy * c.r[1] + qz * c.r[2]) / zc, v = SH / 2 - fpx * (qx * c.u[0] + qy * c.u[1] + qz * c.u[2]) / zc;
          if (u < 0 || v < 0 || u >= SW || v >= SH) continue;          // hors de l'image : on ne sait pas
          seen++; if (!masks[i][(v | 0) * SW + (u | 0)]) { if (++out > maxOut) break; } }
        if (out <= maxOut && seen >= nv * .35) occ[(z * n + y) * n + x] = 1;
      } } }
  return occ;
}
function largestComponent(occ, n) {
  const lab = new Int32Array(occ.length).fill(-1), st = []; let best = -1, bestN = 0, id = 0;
  for (let i = 0; i < occ.length; i++) { if (!occ[i] || lab[i] >= 0) continue; let c = 0; lab[i] = id; st.push(i);
    while (st.length) { const k = st.pop(); c++; const x = k % n, y = ((k / n) | 0) % n, z = (k / (n * n)) | 0;
      for (const [j, okk] of [[k - 1, x > 0], [k + 1, x < n - 1], [k - n, y > 0], [k + n, y < n - 1], [k - n * n, z > 0], [k + n * n, z < n - 1]]) if (okk && occ[j] && lab[j] < 0) { lab[j] = id; st.push(j); } }
    if (c > bestN) { bestN = c; best = id; } id++; }
  const out = new Uint8Array(occ.length); for (let i = 0; i < occ.length; i++) if (lab[i] === best) out[i] = 1;
  return out;
}
function shapeOf(occ, n, box) { // axe long (analyse en composantes principales), dimensions
  const { R, Y } = box; let c = 0, mx = 0, mz = 0, ymax = 0;
  for (let i = 0; i < occ.length; i++) if (occ[i]) { const x = i % n, z = (i / (n * n)) | 0; mx += x; mz += z; c++; }
  if (!c) return null; mx /= c; mz /= c;
  let sxx = 0, szz = 0, sxz = 0;
  for (let i = 0; i < occ.length; i++) if (occ[i]) { const x = i % n - mx, z = ((i / (n * n)) | 0) - mz, y = ((i / n) | 0) % n; sxx += x * x; szz += z * z; sxz += x * z; if (y > ymax) ymax = y; }
  const alpha = .5 * Math.atan2(2 * sxz, sxx - szz), ca = Math.cos(alpha), sa = Math.sin(alpha), cell = 2 * R / n;
  let l0 = 1e9, l1 = -1e9, w0 = 1e9, w1 = -1e9;
  for (let i = 0; i < occ.length; i++) if (occ[i]) { const x = (i % n + .5) * cell - R, z = (((i / (n * n)) | 0) + .5) * cell - R, a = x * ca + z * sa, b = -x * sa + z * ca;
    if (a < l0) l0 = a; if (a > l1) l1 = a; if (b < w0) w0 = b; if (b > w1) w1 = b; }
  const ac = (l0 + l1) / 2, bc = (w0 + w1) / 2;
  return { alpha, L: l1 - l0, W: w1 - w0, H: (ymax + 1) / n * Y, cx: ac * ca - bc * sa, cz: ac * sa + bc * ca, voxels: c };
}

// Accord entre une forme sculptée et les silhouettes (sert d'arbitre entre deux jeux de caméras) : précision (points de
// la forme qui tombent dans la silhouette) + rappel (silhouette couverte par la forme).
function surfacePoints(occ, n, box, max) {
  const { R, Y } = box, pts = [];
  for (let z = 1; z < n - 1; z++) for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) { const i = (z * n + y) * n + x; if (!occ[i]) continue;
    if (occ[i - 1] && occ[i + 1] && occ[i - n] && occ[i + n] && occ[i - n * n] && occ[i + n * n]) continue;   // surface seulement
    pts.push(((x + .5) / n * 2 - 1) * R, (y + .5) / n * Y, ((z + .5) / n * 2 - 1) * R); }
  const P = pts.length / 3, k = Math.max(1, Math.ceil(P / max)); if (k === 1) return Float32Array.from(pts);
  const out = []; for (let i = 0; i < P; i += k) out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
  return Float32Array.from(out);
}
function silScore(cam, m, pts, SW, SH, fpx, img) {
  img.fill(0); let inC = 0, tot = 0; const P = pts.length / 3;
  for (let k = 0; k < P; k++) { const qx = pts[k * 3] - cam.C[0], qy = pts[k * 3 + 1] - cam.C[1], qz = pts[k * 3 + 2] - cam.C[2], zc = qx * cam.f[0] + qy * cam.f[1] + qz * cam.f[2]; if (zc < .3) continue;
    const u = (SW / 2 + fpx * (qx * cam.r[0] + qy * cam.r[1] + qz * cam.r[2]) / zc) | 0, v = (SH / 2 - fpx * (qx * cam.u[0] + qy * cam.u[1] + qz * cam.u[2]) / zc) | 0;
    if (u < 0 || v < 0 || u >= SW || v >= SH) continue; tot++; if (m[v * SW + u]) inC++; img[v * SW + u] = 1; }
  let cover = 0, area = 0;
  for (let i = SW; i < SW * (SH - 1); i += 2) if (m[i]) { area++; if (img[i] || img[i + 1] || img[i - 1] || img[i - SW] || img[i + SW]) cover++; }
  return (tot ? inC / tot : 0) + (area ? cover / area : 0);
}
/* ---------- 4 ter. Calage des caméras par les points de détail (v0.20) ----------
   Structure à partir du mouvement, en JavaScript pur : coins FAST + descripteur BRIEF sur les images en gris (640 px),
   appariements entre images voisines filtrés par la géométrie à deux vues (matrice fondamentale, RANSAC adaptatif),
   pistes, reconstruction de proche en proche (chaque image placée sur les points déjà connus et sur ses deux voisines,
   en partant du mouvement estimé par le décor), puis ajustement de faisceaux (Levenberg-Marquardt, complément de Schur).
   Caméras au format du scan (angle, distance, hauteur, visée, tangage, roulis). Sur la vidéo de synthèse : position
   du téléphone à 1 à 2 cm près au lieu de 36 cm, orientation à 0,1-0,2° au lieu de 2°. */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const pop = x => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };

// Valeurs propres d'une matrice symétrique n×n (Jacobi) : renvoie {vals, vecs} (vecs en colonnes, a[i*n+j])
function eigSym(A, n) {
  const a = Float64Array.from(A), v = new Float64Array(n * n); for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i * n + j] * a[i * n + j];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p * n + q]; if (Math.abs(apq) < 1e-300) continue;
      const th = (a[q * n + q] - a[p * n + p]) / (2 * apq), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = a[k * n + p], akq = a[k * n + q]; a[k * n + p] = c * akp - s * akq; a[k * n + q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = a[p * n + k], aqk = a[q * n + k]; a[p * n + k] = c * apk - s * aqk; a[q * n + k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = v[k * n + p], vkq = v[k * n + q]; v[k * n + p] = c * vkp - s * vkq; v[k * n + q] = s * vkp + c * vkq; }
    } }
  const vals = []; for (let i = 0; i < n; i++) vals.push(a[i * n + i]);
  return { vals, vecs: v };
}

// ---------- 1. points de détail ----------
const CIRC = [[0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3], [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3]];
let PAIRS = null;
function briefPairs() {
  if (PAIRS) return PAIRS; const r = rng(12345), g = () => { let s = 0; for (let k = 0; k < 6; k++) s += r(); return (s - 3) * 5.6; };
  PAIRS = new Int8Array(256 * 4); for (let i = 0; i < 256 * 4; i++) PAIRS[i] = clamp(Math.round(g()), -13, 13); return PAIRS;
}
// g : niveaux de gris (Uint8Array W×H). mask (facultatif) : 1 = garder. Renvoie {n, x: Float32Array, y, desc: Uint32Array(n*8)}
// Pyramide (échelles 1 ; 0,75 ; 0,56) : pour des photos prises de plus ou moins loin
function featuresPyr(g, W, H, maxN = 1500, thr = 16, levels = 3) {
  const outs = []; let cur = g, w = W, h = H, k = 1;
  for (let l = 0; l < levels; l++) {
    const f = features(cur, w, h, Math.round(maxN * (l === 0 ? .5 : .25)), thr); for (let i = 0; i < f.n; i++) { f.x[i] = (f.x[i] + .5) / k - .5; f.y[i] = (f.y[i] + .5) / k - .5; } outs.push(f);
    const w2 = Math.round(w * .75), h2 = Math.round(h * .75), g2 = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) { const sx = (x + .5) / .75 - .5, sy = (y + .5) / .75 - .5, x0 = Math.min(w - 2, Math.max(0, sx | 0)), y0 = Math.min(h - 2, Math.max(0, sy | 0)), fx = sx - x0, fy = sy - y0;
      g2[y * w2 + x] = (cur[y0 * w + x0] * (1 - fx) + cur[y0 * w + x0 + 1] * fx) * (1 - fy) + (cur[(y0 + 1) * w + x0] * (1 - fx) + cur[(y0 + 1) * w + x0 + 1] * fx) * fy; }
    cur = g2; w = w2; h = h2; k *= .75; }
  const n = outs.reduce((s, f) => s + f.n, 0), x = new Float32Array(n), y = new Float32Array(n), desc = new Uint32Array(n * 8); let o = 0;
  for (const f of outs) { x.set(f.x, o); y.set(f.y, o); desc.set(f.desc, o * 8); o += f.n; }
  return { n, x, y, desc };
}
function features(g, W, H, maxN = 1500, thr = 16, mask = null) {
  const off = CIRC.map(([dx, dy]) => dy * W + dx), B = 18, score = new Float32Array(W * H), cand = [];
  for (let y = B; y < H - B; y++) for (let x = B; x < W - B; x++) {
    const i = y * W + x; if (mask && !mask[i]) continue;
    const p = g[i], hi = p + thr, lo = p - thr;
    const a0 = g[i + off[0]], a4 = g[i + off[4]], a8 = g[i + off[8]], a12 = g[i + off[12]];
    let nb = (a0 > hi) + (a4 > hi) + (a8 > hi) + (a12 > hi), nd = (a0 < lo) + (a4 < lo) + (a8 < lo) + (a12 < lo);
    if (nb < 2 && nd < 2) continue;
    let best = 0;
    for (const sgn of [1, -1]) { let run = 0;
      for (let k = 0; k < 25; k++) { const v = g[i + off[k & 15]]; if (sgn > 0 ? v > hi : v < lo) { if (++run > best) best = run; } else run = 0; } }
    if (best < 9) continue;
    // réponse de Harris sur 5×5 (classe les coins)
    let sxx = 0, syy = 0, sxy = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const j = i + dy * W + dx, gx = g[j + 1] - g[j - 1], gy = g[j + W] - g[j - W]; sxx += gx * gx; syy += gy * gy; sxy += gx * gy; }
    const s = sxx * syy - sxy * sxy - .04 * (sxx + syy) * (sxx + syy); if (s <= 0) continue;
    score[i] = s; cand.push(i);
  }
  // non-maximum local 5×5, puis répartition sur une grille (pas tous les coins dans les feuilles)
  const keep = [];
  for (const i of cand) { const s = score[i]; let ok = true;
    for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2; dx++) { if (!dx && !dy) continue; if (score[i + dy * W + dx] > s) { ok = false; break; } }
    if (ok) keep.push(i); }
  const GX = 16, GY = 10, per = Math.ceil(maxN / (GX * GY)) + 2, cells = Array.from({ length: GX * GY }, () => []);
  for (const i of keep) { const x = i % W, y = (i / W) | 0; cells[Math.min(GY - 1, (y * GY / H) | 0) * GX + Math.min(GX - 1, (x * GX / W) | 0)].push(i); }
  let sel = []; for (const c of cells) { c.sort((a, b) => score[b] - score[a]); sel.push(...c.slice(0, per)); }
  sel.sort((a, b) => score[b] - score[a]); sel = sel.slice(0, maxN);
  // BRIEF 256 bits sur l'image lissée (boîte 5×5 deux fois)
  const sm = blur(blur(g, W, H, 2), W, H, 2), P = briefPairs(), n = sel.length, x = new Float32Array(n), y = new Float32Array(n), desc = new Uint32Array(n * 8);
  for (let k = 0; k < n; k++) { const i = sel[k], cx = i % W, cy = (i / W) | 0;
    // position affinée (parabole sur le score)
    const sl = score[i - 1], sr = score[i + 1], su = score[i - W], sd = score[i + W], s0 = score[i];
    const ddx = sl + sr - 2 * s0, ddy = su + sd - 2 * s0;
    x[k] = cx + (ddx < 0 ? clamp(.5 * (sl - sr) / ddx, -.5, .5) : 0); y[k] = cy + (ddy < 0 ? clamp(.5 * (su - sd) / ddy, -.5, .5) : 0);
    for (let b = 0; b < 256; b++) { const o = b * 4, v1 = sm[(cy + P[o + 1]) * W + cx + P[o]], v2 = sm[(cy + P[o + 3]) * W + cx + P[o + 2]]; if (v1 < v2) desc[k * 8 + (b >> 5)] |= 1 << (b & 31); } }
  return { n, x, y, desc };
}
function blur(g, W, H, r) {
  const t = new Float32Array(W * H), o = new Float32Array(W * H), k = 2 * r + 1;
  for (let y = 0; y < H; y++) { let s = 0; for (let x = -r; x <= r; x++) s += g[y * W + clamp(x, 0, W - 1)];
    for (let x = 0; x < W; x++) { t[y * W + x] = s / k; s += g[y * W + Math.min(W - 1, x + r + 1)] - g[y * W + Math.max(0, x - r)]; } }
  for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y <= r; y++) s += t[clamp(y, 0, H - 1) * W + x];
    for (let y = 0; y < H; y++) { o[y * W + x] = s / k; s += t[Math.min(H - 1, y + r + 1) * W + x] - t[Math.max(0, y - r) * W + x]; } }
  return o;
}

// ---------- 2. appariement ----------
// win : déplacement maximal cherché (pixels, horizontal et vertical) ; les points de B sont rangés dans une grille
function match(A, B, ratio = .82, maxD = 72, win = null) {
  const best = new Int32Array(A.n).fill(-1), d1 = new Int32Array(A.n), back = new Int32Array(B.n).fill(-1), bd = new Int32Array(B.n).fill(999);
  const G = 32; let cols = 0, rows = 0, cells = null;
  if (win) { for (let j = 0; j < B.n; j++) { cols = Math.max(cols, (B.x[j] / G | 0) + 1); rows = Math.max(rows, (B.y[j] / G | 0) + 1); }
    cells = Array.from({ length: cols * rows }, () => []); for (let j = 0; j < B.n; j++) cells[(B.y[j] / G | 0) * cols + (B.x[j] / G | 0)].push(j); }
  const test = (i, j, st) => { const ai = i * 8, bj = j * 8; let d = 0; for (let w = 0; w < 8; w++) d += pop(A.desc[ai + w] ^ B.desc[bj + w]);
    if (d < st.b1) { st.b2 = st.b1; st.b1 = d; st.bi = j; } else if (d < st.b2) st.b2 = d;
    if (d < bd[j]) { bd[j] = d; back[j] = i; } };
  for (let i = 0; i < A.n; i++) { const st = { b1: 999, b2: 999, bi: -1 };
    if (!win) for (let j = 0; j < B.n; j++) test(i, j, st);
    else { const c0 = Math.max(0, ((A.x[i] - win[0]) / G) | 0), c1 = Math.min(cols - 1, ((A.x[i] + win[0]) / G) | 0), r0 = Math.max(0, ((A.y[i] - win[1]) / G) | 0), r1 = Math.min(rows - 1, ((A.y[i] + win[1]) / G) | 0);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) for (const j of cells[r * cols + c]) test(i, j, st); }
    if (st.b1 <= maxD && st.b1 < ratio * st.b2) { best[i] = st.bi; d1[i] = st.b1; } }
  const out = []; for (let i = 0; i < A.n; i++) if (best[i] >= 0 && back[best[i]] === i) out.push(i, best[i]);
  return out;
}

// ---------- 3. géométrie à deux vues : matrice fondamentale (8 points normalisés) + RANSAC ----------
function normPts(xs, ys, idx) {
  let mx = 0, my = 0; for (const i of idx) { mx += xs[i]; my += ys[i]; } mx /= idx.length; my /= idx.length;
  let d = 0; for (const i of idx) d += Math.hypot(xs[i] - mx, ys[i] - my); d /= idx.length; const s = Math.SQRT2 / (d || 1);
  return { mx, my, s };
}
function fit8(ax, ay, bx, by, idx) {
  const na = normPts(ax, ay, idx), nb = normPts(bx, by, idx), M = new Float64Array(81);
  for (const i of idx) { const x1 = (ax[i] - na.mx) * na.s, y1 = (ay[i] - na.my) * na.s, x2 = (bx[i] - nb.mx) * nb.s, y2 = (by[i] - nb.my) * nb.s;
    const r = [x2 * x1, x2 * y1, x2, y2 * x1, y2 * y1, y2, x1, y1, 1];
    for (let p = 0; p < 9; p++) for (let q = 0; q < 9; q++) M[p * 9 + q] += r[p] * r[q]; }
  const { vals, vecs } = eigSym(M, 9); let k = 0; for (let i = 1; i < 9; i++) if (vals[i] < vals[k]) k = i;
  let F = []; for (let i = 0; i < 9; i++) F.push(vecs[i * 9 + k]);
  F = rank2(F);
  // dénormalisation : F = Tbᵀ F Ta
  const Ta = [na.s, 0, -na.s * na.mx, 0, na.s, -na.s * na.my, 0, 0, 1], Tb = [nb.s, 0, -nb.s * nb.mx, 0, nb.s, -nb.s * nb.my, 0, 0, 1];
  return mul3(mul3(tr3(Tb), F), Ta);
}
const mul3 = (A, B) => { const C = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j]; return C; };
const tr3 = A => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
function rank2(F) { // F = U S Vᵀ, plus petite valeur singulière mise à 0 (via FᵀF)
  const FtF = mul3(tr3(F), F), { vals, vecs } = eigSym(FtF, 3); let k = 0; for (let i = 1; i < 3; i++) if (vals[i] < vals[k]) k = i;
  const v = [vecs[k], vecs[3 + k], vecs[6 + k]], Fv = [F[0] * v[0] + F[1] * v[1] + F[2] * v[2], F[3] * v[0] + F[4] * v[1] + F[5] * v[2], F[6] * v[0] + F[7] * v[1] + F[8] * v[2]];
  const out = F.slice(); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 3 + j] -= Fv[i] * v[j]; return out;
}
function sampson(F, x1, y1, x2, y2) {
  const Fx1 = [F[0] * x1 + F[1] * y1 + F[2], F[3] * x1 + F[4] * y1 + F[5], F[6] * x1 + F[7] * y1 + F[8]];
  const Ftx2 = [F[0] * x2 + F[3] * y2 + F[6], F[1] * x2 + F[4] * y2 + F[7], F[2] * x2 + F[5] * y2 + F[8]];
  const e = x2 * Fx1[0] + y2 * Fx1[1] + Fx1[2]; return e * e / (Fx1[0] * Fx1[0] + Fx1[1] * Fx1[1] + Ftx2[0] * Ftx2[0] + Ftx2[1] * Ftx2[1] + 1e-12);
}
function ransacF(A, B, m, thr = 2.0, iters = 400, seed = 7) {
  const n = m.length / 2; if (n < 12) return [];
  const ax = new Float64Array(n), ay = new Float64Array(n), bx = new Float64Array(n), by = new Float64Array(n);
  for (let k = 0; k < n; k++) { ax[k] = A.x[m[2 * k]]; ay[k] = A.y[m[2 * k]]; bx[k] = B.x[m[2 * k + 1]]; by[k] = B.y[m[2 * k + 1]]; }
  const r = rng(seed), t2 = thr * thr; let bestIn = null, bestN = 0, need = iters;
  for (let it = 0; it < need; it++) {
    const s = new Set(); while (s.size < 8) s.add(Math.floor(r() * n));
    const F = fit8(ax, ay, bx, by, [...s]); const inl = [];
    for (let k = 0; k < n; k++) if (sampson(F, ax[k], ay[k], bx[k], by[k]) < t2) inl.push(k);
    if (inl.length > bestN) { bestN = inl.length; bestIn = inl;
      // nombre de tirages suffisant pour 99 % de chances d'avoir tiré 8 bons appariements
      const w8 = Math.pow(bestN / n, 8); need = Math.min(iters, Math.max(30, Math.ceil(Math.log(.01) / Math.log(Math.max(1e-12, 1 - w8))))); } }
  if (!bestIn || bestN < 12) return [];
  const F = fit8(ax, ay, bx, by, bestIn), out = [];
  for (let k = 0; k < n; k++) if (sampson(F, ax[k], ay[k], bx[k], by[k]) < t2) out.push(m[2 * k], m[2 * k + 1]);
  return out;
}

// ---------- 4. pistes (union-find) ----------
function tracks(feats, pairMatches) {
  const base = [0]; for (const f of feats) base.push(base[base.length - 1] + f.n);
  const par = new Int32Array(base[base.length - 1]).map((_, i) => i), find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (const { a, b, m } of pairMatches) for (let k = 0; k < m.length; k += 2) { const u = find(base[a] + m[k]), v = find(base[b] + m[k + 1]); if (u !== v) par[u] = v; }
  const groups = new Map();
  for (let f = 0; f < feats.length; f++) for (let i = 0; i < feats[f].n; i++) { const g = base[f] + i, r = find(g); if (r === g && !groups.has(r)) { /* racine seule ou non */ }
    let L = groups.get(r); if (!L) { L = []; groups.set(r, L); } L.push(f, i); }
  const out = [];
  for (const L of groups.values()) { if (L.length < 4) continue; const seen = new Set(); let bad = false;
    for (let k = 0; k < L.length; k += 2) { if (seen.has(L[k])) { bad = true; break; } seen.add(L[k]); }
    if (!bad) out.push(L); }
  return out;   // chaque piste : [image, point, image, point, …]
}

const KEYS = ['theta', 'd', 'h', 'yaw', 'pitch', 'roll'];
function projPt(c, X, fpx, cx, cy, out) {
  const qx = X[0] - c.C[0], qy = X[1] - c.C[1], qz = X[2] - c.C[2], z = qx * c.f[0] + qy * c.f[1] + qz * c.f[2];
  out[0] = cx + fpx * (qx * c.r[0] + qy * c.r[1] + qz * c.r[2]) / z; out[1] = cy - fpx * (qx * c.u[0] + qy * c.u[1] + qz * c.u[2]) / z; return z;
}
// triangulation linéaire d'une piste
function triang(cams, obs, fpx, cx, cy) {
  const A = new Float64Array(9), b = new Float64Array(3);
  for (let k = 0; k < obs.length; k += 3) { const c = cams[obs[k]], u = obs[k + 1] - cx, v = obs[k + 2] - cy;
    for (const row of [[u * c.f[0] - fpx * c.r[0], u * c.f[1] - fpx * c.r[1], u * c.f[2] - fpx * c.r[2]], [v * c.f[0] + fpx * c.u[0], v * c.f[1] + fpx * c.u[1], v * c.f[2] + fpx * c.u[2]]]) {
      const rc = row[0] * c.C[0] + row[1] * c.C[1] + row[2] * c.C[2];
      for (let i = 0; i < 3; i++) { b[i] += row[i] * rc; for (let j = 0; j < 3; j++) A[i * 3 + j] += row[i] * row[j]; } } }
  return solve3(A, b);
}
function solve3(A, b) {
  const [a, bb, c, d, e, f, g, h, i] = A, det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g); if (Math.abs(det) < 1e-12) return null;
  const inv = [(e * i - f * h), -(bb * i - c * h), (bb * f - c * e), -(d * i - f * g), (a * i - c * g), -(a * f - c * d), (d * h - e * g), -(a * h - bb * g), (a * e - bb * d)];
  return [(inv[0] * b[0] + inv[1] * b[1] + inv[2] * b[2]) / det, (inv[3] * b[0] + inv[4] * b[1] + inv[5] * b[2]) / det, (inv[6] * b[0] + inv[7] * b[1] + inv[8] * b[2]) / det];
}
function inv3(M) { const [a, b, c, d, e, f, g, h, i] = M, det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g); if (Math.abs(det) < 1e-18) return null;
  return [(e * i - f * h) / det, -(b * i - c * h) / det, (b * f - c * e) / det, -(d * i - f * g) / det, (a * i - c * g) / det, -(a * f - c * d) / det, (d * h - e * g) / det, -(a * h - b * g) / det, (a * e - b * d) / det]; }
// Cholesky en place (matrice n×n symétrique définie positive) ; résout A x = b
function cholSolve(A, b, n) {
  const L = new Float64Array(n * n);
  for (let j = 0; j < n; j++) { let s = A[j * n + j]; for (let k = 0; k < j; k++) s -= L[j * n + k] * L[j * n + k]; if (s <= 1e-12) return null; const ljj = Math.sqrt(s); L[j * n + j] = ljj;
    for (let i = j + 1; i < n; i++) { let t = A[i * n + j]; for (let k = 0; k < j; k++) t -= L[i * n + k] * L[j * n + k]; L[i * n + j] = t / ljj; } }
  const y = new Float64Array(n); for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  const x = new Float64Array(n); for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}

// ---------- 6. ajustement de faisceaux ----------
// poses : [{theta,d,h,yaw,pitch,roll,th}] ; obsList : pistes [[cam, u, v, cam, u, v, …]] ; renvoie poses ajustées + points
async function bundle(poses0, trk, fpx, cx, cy, opt = {}) {
  const nC = poses0.length, P = poses0.map(p => ({ ...p })), sig = opt.sigma || 2, iters = opt.iters ?? 25, fix = opt.fix ?? 0, fixed = opt.fixed || null;
  const prior = opt.prior || { roll: 8 * Math.PI / 180 };
  let cams = P.map(camOf), pts = [], obs = [];
  if (opt.pts) { pts = opt.pts.map(X => X.slice()); obs = trk; }
  else for (const t of trk) { const X = triang(cams, t, fpx, cx, cy); if (!X) continue;
    let ok = true; const tmp = [0, 0]; for (let k = 0; k < t.length; k += 3) { if (projPt(cams[t[k]], X, fpx, cx, cy, tmp) < .3) { ok = false; break; } }
    if (ok) { pts.push(X); obs.push(t); } }
  const cost = (cs, X) => { let s = 0; const tmp = [0, 0];
    for (let p = 0; p < obs.length; p++) { const t = obs[p];
      for (let k = 0; k < t.length; k += 3) { const z = projPt(cs[t[k]], X[p], fpx, cx, cy, tmp); const e2 = z < .1 ? 1e4 : (tmp[0] - t[k + 1]) ** 2 + (tmp[1] - t[k + 2]) ** 2; s += sig * sig * Math.log1p(e2 / (sig * sig)); } }
    return s; };
  const priorCost = PP => { let s = 0; for (const p of PP) for (const k in prior) s += (p[k] / prior[k]) ** 2 * sig * sig;
    if (opt.camPriors) PP.forEach((p, c) => { const cp = opt.camPriors[c]; if (!cp) return; if (cp.sd != null) s += ((p.d - cp.d) / cp.sd) ** 2 * sig * sig; if (cp.sh != null) s += ((p.h - cp.h) / cp.sh) ** 2 * sig * sig; }); return s; };
  let lam = 1e-3, cur = cost(cams, pts) + priorCost(P); const hist = [Math.round(cur)];
  const NP = 6, nPar = nC * NP, eps = [1e-4, 1e-4, 1e-4, 1e-4, 1e-4, 1e-4];
  for (let it = 0; it < iters; it++) {
    // jacobiennes des caméras par différences finies (6 réglages)
    const camsP = [], camsM = [];
    for (let c = 0; c < nC; c++) { camsP.push([]); camsM.push([]); for (let k = 0; k < NP; k++) { const a = { ...P[c] }, b = { ...P[c] }; a[KEYS[k]] += eps[k]; b[KEYS[k]] -= eps[k]; camsP[c].push(camOf(a)); camsM[c].push(camOf(b)); } }
    const U = new Float64Array(nPar * nPar), gc = new Float64Array(nPar), Vinv = [], Wp = [], gp = [];
    const tmp = [0, 0], tp = [0, 0], tm = [0, 0];
    // a priori (roulis proche de 0…) : termes quadratiques sur les caméras
    for (let c = 0; c < nC; c++) for (const key in prior) { const k = KEYS.indexOf(key), w = sig * sig / (prior[key] ** 2), i = c * NP + k; U[i * nPar + i] += w; gc[i] += w * P[c][key]; }
    if (opt.camPriors) for (let c = 0; c < nC; c++) { const cp = opt.camPriors[c]; if (!cp) continue;
      for (const [key, mean, sd] of [['d', cp.d, cp.sd], ['h', cp.h, cp.sh]]) { if (sd == null) continue; const k = KEYS.indexOf(key), w = sig * sig / (sd * sd), i = c * NP + k; U[i * nPar + i] += w; gc[i] += w * (P[c][key] - mean); } }
    for (let p = 0; p < obs.length; p++) { const t = obs[p], X = pts[p], V = new Float64Array(9), g3 = new Float64Array(3), Wl = [];
      for (let k = 0; k < t.length; k += 3) { const ci = t[k], cam = cams[ci], z = projPt(cam, X, fpx, cx, cy, tmp); if (z < .1) continue;
        const rx = tmp[0] - t[k + 1], ry = tmp[1] - t[k + 2], e2 = rx * rx + ry * ry, w = 1 / (1 + e2 / (sig * sig));
        // dérivées / point (analytiques)
        const qx = X[0] - cam.C[0], qy = X[1] - cam.C[1], qz = X[2] - cam.C[2], a = qx * cam.r[0] + qy * cam.r[1] + qz * cam.r[2], b = qx * cam.u[0] + qy * cam.u[1] + qz * cam.u[2];
        const Jp = [fpx * (cam.r[0] * z - a * cam.f[0]) / (z * z), fpx * (cam.r[1] * z - a * cam.f[1]) / (z * z), fpx * (cam.r[2] * z - a * cam.f[2]) / (z * z),
          -fpx * (cam.u[0] * z - b * cam.f[0]) / (z * z), -fpx * (cam.u[1] * z - b * cam.f[1]) / (z * z), -fpx * (cam.u[2] * z - b * cam.f[2]) / (z * z)];
        const Jc = new Float64Array(12);
        for (let q = 0; q < NP; q++) { projPt(camsP[ci][q], X, fpx, cx, cy, tp); projPt(camsM[ci][q], X, fpx, cx, cy, tm); Jc[q] = (tp[0] - tm[0]) / (2 * eps[q]); Jc[6 + q] = (tp[1] - tm[1]) / (2 * eps[q]); }
        const o = ci * NP;
        for (let q = 0; q < NP; q++) { gc[o + q] += w * (Jc[q] * rx + Jc[6 + q] * ry);
          for (let s = 0; s < NP; s++) U[(o + q) * nPar + o + s] += w * (Jc[q] * Jc[s] + Jc[6 + q] * Jc[6 + s]); }
        for (let q = 0; q < 3; q++) { g3[q] += w * (Jp[q] * rx + Jp[3 + q] * ry); for (let s = 0; s < 3; s++) V[q * 3 + s] += w * (Jp[q] * Jp[s] + Jp[3 + q] * Jp[3 + s]); }
        const Wm = new Float64Array(18); for (let q = 0; q < NP; q++) for (let s = 0; s < 3; s++) Wm[q * 3 + s] = w * (Jc[q] * Jp[s] + Jc[6 + q] * Jp[3 + s]);
        Wl.push(ci, Wm); }
      Vinv.push(V); Wp.push(Wl); gp.push(g3); }
    // essais avec amortissement croissant
    let accepted = false;
    for (let tries = 0; tries < 8 && !accepted; tries++) {
      const S = Float64Array.from(U), rhs = Float64Array.from(gc).map(v => -v);
      for (let i = 0; i < nPar; i++) S[i * nPar + i] += lam * (U[i * nPar + i] + 1e-6);
      // jauge : angle de la caméra de référence fixé ; caméras figées : tous leurs réglages
      { const i = fix * NP; S[i * nPar + i] += 1e12; }
      if (fixed) for (let c = 0; c < nC; c++) if (fixed[c]) for (let k = 0; k < NP; k++) { const i = c * NP + k; S[i * nPar + i] += 1e12; }
      const Vi = [];
      for (let p = 0; p < obs.length; p++) { const V = Vinv[p].slice(); for (let q = 0; q < 3; q++) V[q * 3 + q] += lam * V[q * 3 + q] + 1e-9; const vi = inv3(V); Vi.push(vi); if (!vi) continue;
        const Wl = Wp[p], g3 = gp[p], vg = [vi[0] * g3[0] + vi[1] * g3[1] + vi[2] * g3[2], vi[3] * g3[0] + vi[4] * g3[1] + vi[5] * g3[2], vi[6] * g3[0] + vi[7] * g3[1] + vi[8] * g3[2]];
        for (let a = 0; a < Wl.length; a += 2) { const ca = Wl[a], Wa = Wl[a + 1], WaV = new Float64Array(18);
          for (let q = 0; q < NP; q++) for (let s = 0; s < 3; s++) WaV[q * 3 + s] = Wa[q * 3] * vi[s] + Wa[q * 3 + 1] * vi[3 + s] + Wa[q * 3 + 2] * vi[6 + s];
          for (let q = 0; q < NP; q++) rhs[ca * NP + q] += WaV[q * 3] * g3[0] + WaV[q * 3 + 1] * g3[1] + WaV[q * 3 + 2] * g3[2];
          for (let b = 0; b < Wl.length; b += 2) { const cb = Wl[b], Wb = Wl[b + 1];
            for (let q = 0; q < NP; q++) for (let s = 0; s < NP; s++) S[(ca * NP + q) * nPar + cb * NP + s] -= WaV[q * 3] * Wb[s * 3] + WaV[q * 3 + 1] * Wb[s * 3 + 1] + WaV[q * 3 + 2] * Wb[s * 3 + 2]; } } }
      const dc = cholSolve(S, rhs, nPar); if (!dc) { lam *= 10; continue; }
      const P2 = P.map((p, c) => { const q = { ...p }; for (let k = 0; k < NP; k++) q[KEYS[k]] += dc[c * NP + k]; return q; });
      const pts2 = pts.map((X, p) => { const vi = Vi[p]; if (!vi) return X; const g3 = gp[p], Wl = Wp[p], r = [-g3[0], -g3[1], -g3[2]];
        for (let a = 0; a < Wl.length; a += 2) { const ca = Wl[a], Wa = Wl[a + 1]; for (let s = 0; s < 3; s++) for (let q = 0; q < NP; q++) r[s] -= Wa[q * 3 + s] * dc[ca * NP + q]; }
        return [X[0] + vi[0] * r[0] + vi[1] * r[1] + vi[2] * r[2], X[1] + vi[3] * r[0] + vi[4] * r[1] + vi[5] * r[2], X[2] + vi[6] * r[0] + vi[7] * r[1] + vi[8] * r[2]]; });
      const cams2 = P2.map(camOf), c2 = cost(cams2, pts2) + priorCost(P2);
      if (c2 < cur) { // échelle : distance médiane gardée (sauf si une caméra figée la fixe déjà)
        const ds = P2.map(p => p.d).sort((a, b) => a - b), k = fixed ? 1 : (opt.d0 || ds[ds.length >> 1]) / ds[ds.length >> 1];
        P2.forEach(p => { p.d *= k; p.h *= k; }); pts2.forEach(X => { X[0] *= k; X[1] *= k; X[2] *= k; });
        P.splice(0, nC, ...P2); pts = pts2; cams = P.map(camOf); cur = cost(cams, pts) + priorCost(P); lam = Math.max(1e-7, lam / 4); accepted = true; }
      else lam *= 6; }
    hist.push(Math.round(cur)); opt.onIter && opt.onIter((it + 1) / iters); await tick();
    if (!accepted) break; }
  // erreurs de reprojection finales
  const errs = []; const tmp = [0, 0];
  for (let p = 0; p < obs.length; p++) { const t = obs[p]; for (let k = 0; k < t.length; k += 3) { projPt(cams[t[k]], pts[p], fpx, cx, cy, tmp); errs.push(Math.hypot(tmp[0] - t[k + 1], tmp[1] - t[k + 2])); } }
  errs.sort((a, b) => a - b);
  return { poses: P, pts, obs, hist, medErr: errs[errs.length >> 1], p90: errs[Math.floor(errs.length * .9)] };
}

// Inverse de makeCam : position et axes (repère du monde) → réglages du scan (angle, distance, hauteur, visée, tangage, roulis)
function poseFromCam(C, r, u, f, th) {
  const theta = Math.atan2(C[0], C[2]), d = Math.hypot(C[0], C[2]), h = C[1];
  let fw = [-C[0], th - C[1], -C[2]]; const n0 = Math.hypot(...fw); fw = fw.map(v => v / n0);
  const h0 = Math.atan2(fw[0], fw[2]), hf = Math.atan2(f[0], f[2]);
  // makeCam : fw' = [fw0 cy + fw2 sy, fw1, -fw0 sy + fw2 cy] (rotation de +yaw autour de y, sens « vers la gauche »)
  const yaw = Math.atan2(Math.sin(hf - h0), Math.cos(hf - h0));
  const pitch = Math.asin(Math.max(-1, Math.min(1, f[1]))) - Math.asin(Math.max(-1, Math.min(1, fw[1])));
  const c0 = makeCam(theta, d, yaw, pitch, th, h, 0);
  const roll = Math.atan2(r[0] * c0.u[0] + r[1] * c0.u[1] + r[2] * c0.u[2], r[0] * c0.r[0] + r[1] * c0.r[1] + r[2] * c0.r[2]);
  return { theta, d, h, yaw, pitch, roll, th };
}

function normM(A, B, m, fpx, cx, cy) { const o = []; for (let k = 0; k < m.length; k += 2) o.push((A.x[m[k]] + .5 - cx) / fpx, (A.y[m[k]] + .5 - cy) / fpx, (B.x[m[k + 1]] + .5 - cx) / fpx, (B.y[m[k + 1]] + .5 - cy) / fpx); return o; }
async function incremental(feats, pairs, n, fpx, cx, cy, P0, th, opt = {}) {
  const T = tracks(feats, pairs), nT = T.length, byFrame = Array.from({ length: n }, () => []);
  T.forEach((L, t) => { for (let k = 0; k < L.length; k += 2) byFrame[L[k]].push(t, feats[L[k]].x[L[k + 1]] + .5, feats[L[k]].y[L[k + 1]] + .5); });
  const X = new Array(nT).fill(null), poses = new Array(n).fill(null), reg = new Array(n).fill(false);
  const obsOf = t => { const L = T[t], o = []; for (let k = 0; k < L.length; k += 2) if (reg[L[k]]) o.push(L[k], feats[L[k]].x[L[k + 1]] + .5, feats[L[k]].y[L[k + 1]] + .5); return o; };
  const tmp = [0, 0];
  const triNew = () => { let added = 0; const cams = poses.map(p => p ? camOf(p) : null);
    for (let t = 0; t < nT; t++) { if (X[t]) continue; const o = obsOf(t); if (o.length < 6) continue;
      const Xp = triang(cams, o, fpx, cx, cy); if (!Xp) continue; let good = true;
      for (let k = 0; k < o.length; k += 3) { const z = projPt(cams[o[k]], Xp, fpx, cx, cy, tmp); if (z < .3 || Math.hypot(tmp[0] - o[k + 1], tmp[1] - o[k + 2]) > 3) { good = false; break; } }
      // angle entre les rayons extrêmes (points trop loin ou mal placés écartés)
      if (good) { const a = cams[o[0]].C, b = cams[o[o.length - 3]].C, va = [Xp[0] - a[0], Xp[1] - a[1], Xp[2] - a[2]], vb = [Xp[0] - b[0], Xp[1] - b[1], Xp[2] - b[2]];
        const cosv = (va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]) / (Math.hypot(...va) * Math.hypot(...vb)); if (cosv > Math.cos(1.5 * Math.PI / 180)) good = false; }
      if (good) { X[t] = Xp; added++; } }
    return added; };
  const ba = async (iters, fix0 = true) => { const idx = []; for (let c = 0; c < n; c++) if (reg[c]) idx.push(c); const loc = new Map(idx.map((c, i) => [c, i]));
    const trk = [], pts = [], tid = [];
    for (let t = 0; t < nT; t++) { if (!X[t]) continue; const o = obsOf(t); if (o.length < 6) continue; const oo = []; for (let k = 0; k < o.length; k += 3) oo.push(loc.get(o[k]), o[k + 1], o[k + 2]); trk.push(oo); pts.push(X[t]); tid.push(t); }
    const fixed = idx.map(c => fix0 && c === 0), hs = idx.map(c => poses[c].h).sort((a, b) => a - b), hm = hs[hs.length >> 1], kd = poses[0].d / P0[0].d;
    const camPriors = idx.map(c => ({ d: P0[c].d * kd, sd: .12 * P0[c].d * kd, h: hm, sh: .35 }));
    const r = await bundle(idx.map(c => poses[c]), trk, fpx, cx, cy, { iters, sigma: 2, pts, fixed, camPriors, prior: opt.prior || { roll: 10 * Math.PI / 180 }, onIter: opt.onBA });
    idx.forEach((c, i) => { poses[c] = r.poses[i]; }); tid.forEach((t, i) => { X[t] = r.pts[i]; });
    // points devenus faux : retirés (ils pourront revenir)
    const cams = poses.map(p => p ? camOf(p) : null); let removed = 0;
    for (const t of tid) { const o = obsOf(t); for (let k = 0; k < o.length; k += 3) { const z = projPt(cams[o[k]], X[t], fpx, cx, cy, tmp); if (z < .2 || Math.hypot(tmp[0] - o[k + 1], tmp[1] - o[k + 2]) > 4) { X[t] = null; removed++; break; } } }
    return { med: r.medErr, removed }; };
  // départ : caméra 0 telle qu'estimée par le scan ; caméra 1 par la géométrie à deux vues, à la distance prévue
  poses[0] = { ...P0[0] }; reg[0] = true;
  let strong = 1;
  { const m = pairs.find(p => p.a === 0 && p.b === 1);
    let p1 = { ...P0[1] };
    if (m) { p1 = registerCam(P0[1], [], [], [{ pose: poses[0], m: normM(feats[0], feats[1], m.m, fpx, cx, cy) }], fpx, cx, cy, { d: P0[1].d, sd: .05 * P0[1].d, h: P0[0].h, sh: .3, sr: .2 }); strong++; }
    poses[1] = p1; reg[1] = true; }
  triNew(); await ba(15);
  // ordre : en avant depuis 1, et en arrière depuis la fin (les dernières images recouvrent les premières), en alternance
  const order = []; { let f = 2, bk = n - 1; while (f <= bk) { order.push([f, -1]); f++; if (f <= bk && opt.bidir !== false) { order.push([bk, 1]); bk--; } } }
  const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
  let nb = 0;
  for (const [k, dir] of order) {
    const k1 = (k + dir + n) % n, a = poses[k1], init = {};
    for (const key of KEYS) init[key] = a[key] + (key === 'd' ? 0 : wrapA(P0[k][key] - P0[k1][key]));
    init.d = a.d * P0[k].d / P0[k1].d; init.th = th;
    const L = byFrame[k], Xs = [], uv = []; for (let q = 0; q < L.length; q += 3) if (X[L[q]]) { Xs.push(X[L[q]]); uv.push(L[q + 1], L[q + 2]); }
    let pose = init;
    const epi = []; for (const back of [1, 2]) { const j = (k + dir * back + n) % n; if (!reg[j]) continue; const lo = Math.min(j, k), hi = Math.max(j, k), pm = pairs.find(p => p.a === lo && p.b === hi);
      if (pm) epi.push({ pose: poses[j], m: lo === j ? normM(feats[j], feats[k], pm.m, fpx, cx, cy) : normM(feats[k], feats[j], pm.m, fpx, cx, cy).map((v, i, arr) => arr[i ^ 2]) }); }
    if (Xs.length >= 6 || epi.length) { const pd = init.d;
      pose = registerCam(init, Xs, uv, epi, fpx, cx, cy, { d: pd, sd: .08 * pd, h: a.h, sh: .25, sr: .25, sa: (opt.sa || 5) * Math.PI / 180 });
      if (Xs.length >= 12 || epi.reduce((s, e) => s + e.m.length / 4, 0) >= 40) strong++; }
    poses[k] = pose; reg[k] = true; triNew();
    if (++nb % 3 === 0) { opt.onProg && opt.onProg(nb / order.length); await tick(); }
  }
  // boucle refermée : on retriangule (pistes qui relient la fin au début) puis ajustement global
  triNew(); const fin = await ba(opt.finalIters ?? 20);
  // appui de chaque image : points bien reprojetés (< 2 px). Une image peu appuyée est mal placée (essai sur de vraies photos)
  const cams = poses.map(camOf), support = new Array(n).fill(0);
  for (let t = 0; t < nT; t++) { if (!X[t]) continue; const L = T[t]; for (let k = 0; k < L.length; k += 2) { const f = L[k], z = projPt(cams[f], X[t], fpx, cx, cy, tmp);
    if (z > .2 && Math.hypot(tmp[0] - feats[f].x[L[k + 1]] - .5, tmp[1] - feats[f].y[L[k + 1]] - .5) < 2) support[f]++; } }
  return { poses, X, med: fin.med, strong: strong / n, support, nPts: X.filter(Boolean).length };
}

// Placement d'une caméra : points 3D connus (reprojection) + géométrie avec les caméras voisines déjà placées
// (distance de Sampson, en pixels) + attente douce sur la distance et la hauteur. Levenberg-Marquardt, 6 réglages.
function registerCam(init, Xs, uv, epi, fpx, cx, cy, prior, sigs = [12, 4, 1.5], iters = 15) {
  const NP = 6, eps = 1e-4, tmp = [0, 0];
  const Rof = c => [c.r[0], c.r[1], c.r[2], -c.u[0], -c.u[1], -c.u[2], c.f[0], c.f[1], c.f[2]];
  const epiPre = epi.map(e => ({ R: Rof(camOf(e.pose)), C: camOf(e.pose).C, m: e.m }));   // m : [xj, yj, xk, yk, …] en coordonnées normalisées
  const resid = (q, sig, out) => {   // remplit out (résidus pondérés « racine de Cauchy »)
    const c = camOf(q), Rk = Rof(c); let n = 0;
    for (let i = 0; i < Xs.length; i++) { const z = projPt(c, Xs[i], fpx, cx, cy, tmp); const rx = z < .1 ? 50 : tmp[0] - uv[2 * i], ry = z < .1 ? 50 : tmp[1] - uv[2 * i + 1]; out[n++] = rx; out[n++] = ry; }
    for (const e of epiPre) { const R = mul3(Rk, tr3(e.R)), dC = [e.C[0] - c.C[0], e.C[1] - c.C[1], e.C[2] - c.C[2]], t = [0, 1, 2].map(i => Rk[i * 3] * dC[0] + Rk[i * 3 + 1] * dC[1] + Rk[i * 3 + 2] * dC[2]);
      const nt = Math.hypot(...t) || 1, tx = [0, -t[2] / nt, t[1] / nt, t[2] / nt, 0, -t[0] / nt, -t[1] / nt, t[0] / nt, 0], E = mul3(tx, R), m = e.m;
      for (let k = 0; k < m.length; k += 4) { const x1 = m[k], y1 = m[k + 1], x2 = m[k + 2], y2 = m[k + 3];
        const Ex1 = [E[0] * x1 + E[1] * y1 + E[2], E[3] * x1 + E[4] * y1 + E[5], E[6] * x1 + E[7] * y1 + E[8]], Etx2 = [E[0] * x2 + E[3] * y2 + E[6], E[1] * x2 + E[4] * y2 + E[7], E[2] * x2 + E[5] * y2 + E[8]];
        const num = x2 * Ex1[0] + y2 * Ex1[1] + Ex1[2], den = Math.sqrt(Ex1[0] ** 2 + Ex1[1] ** 2 + Etx2[0] ** 2 + Etx2[1] ** 2) + 1e-12; out[n++] = fpx * num / den; } }
    if (prior) { out[n++] = (q.d - prior.d) / (prior.sd || 1) * sig; out[n++] = (q.h - prior.h) / (prior.sh || 1) * sig; out[n++] = q.roll / (prior.sr || 1) * sig;
      if (prior.sa) for (const k of ['theta', 'yaw', 'pitch']) out[n++] = Math.atan2(Math.sin(q[k] - init[k]), Math.cos(q[k] - init[k])) / prior.sa * sig; }
    return n; };
  let p = { ...init }; const nR = 2 * Xs.length + epi.reduce((s, e) => s + e.m.length / 4, 0) + 6, r0 = new Float64Array(nR), rp = new Float64Array(nR), rm = new Float64Array(nR);
  const costOf = (q, sig) => { const n = resid(q, sig, r0); let s = 0; for (let i = 0; i < n; i++) s += Math.log1p(r0[i] * r0[i] / (sig * sig)); return s; };
  for (const sig of sigs) { let lam = 1e-3, cur = costOf(p, sig);
    for (let it = 0; it < iters; it++) {
      const n = resid(p, sig, r0), w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 1 / (1 + r0[i] * r0[i] / (sig * sig));
      const J = []; for (let k = 0; k < NP; k++) { const a = { ...p }, b = { ...p }; a[KEYS[k]] += eps; b[KEYS[k]] -= eps; resid(a, sig, rp); resid(b, sig, rm); const col = new Float64Array(n); for (let i = 0; i < n; i++) col[i] = (rp[i] - rm[i]) / (2 * eps); J.push(col); }
      const A = new Float64Array(36), g = new Float64Array(6);
      for (let a = 0; a < NP; a++) { for (let i = 0; i < n; i++) g[a] += w[i] * J[a][i] * r0[i]; for (let b = a; b < NP; b++) { let s = 0; for (let i = 0; i < n; i++) s += w[i] * J[a][i] * J[b][i]; A[a * 6 + b] = A[b * 6 + a] = s; } }
      let ok = false;
      for (let t = 0; t < 8 && !ok; t++) { const M = Float64Array.from(A); for (let a = 0; a < NP; a++) M[a * 6 + a] += lam * (A[a * 6 + a] + 1e-6);
        const d = cholSolve(M, Float64Array.from(g).map(v => -v), NP); if (!d) { lam *= 10; continue; }
        const q = { ...p }; for (let k = 0; k < NP; k++) q[KEYS[k]] += d[k]; const c2 = costOf(q, sig);
        if (c2 < cur) { p = q; cur = c2; lam = Math.max(1e-7, lam / 4); ok = true; } else lam *= 6; }
      if (!ok) break; } }
  return p;
}

// Pilote : points de détail, appariements, reconstruction ; puis mise à niveau (le haut des téléphones en moyenne donne la
// verticale), centre de la voiture au croisement des visées, sol trouvé sur la couche de points la plus basse autour de la
// voiture (sinon : téléphones à la hauteur supposée). null si le calage n'est pas assez sûr.
async function sfmCameras(F, vis, P0, fpxG, progress) {
  const { GW, GH } = F, n = vis.length, t0 = performance.now(), feats = [];
  for (let j = 0; j < n; j++) { feats.push(F.photos ? featuresPyr(F.grays[vis[j]], GW, GH, 1500, 16, 3) : features(F.grays[vis[j]], GW, GH, 1500, 16)); if (j % 4 === 3) { progress(.2 * (j + 1) / n); await tick(); } }
  const win = F.photos ? [GW * .47, GH * .36] : [GW * .22, GH * .19], pairs = [];
  for (let i = 0; i < n; i++) { for (const s of [1, 2]) { const j = (i + s) % n; if (j === i) continue;
      const m = match(feats[i], feats[j], .82, 72, win), f = ransacF(feats[i], feats[j], m, 2, 500, i * 3 + s);
      if (f.length >= 20 && f.length >= .12 * m.length) pairs.push(i < j ? { a: i, b: j, m: f } : { a: j, b: i, m: f.map((_, k) => f[k ^ 1]) }); }
    if (i % 3 === 2) { progress(.2 + .35 * (i + 1) / n); await tick(); } }
  const tm = performance.now() - t0;
  if (pairs.length < n * .8) return { info: { ms: Math.round(tm), paires: pairs.length, refus: 'peu de paires' } };
  const R = await incremental(feats, pairs, n, fpxG, GW / 2, GH / 2, P0, TARGET_H, { onProg: k => progress(.55 + .25 * k), onBA: k => progress(.8 + .18 * k) });
  const weak = R.support.map(v => v < 15), nw = weak.filter(Boolean).length;
  const info = { ms: Math.round(performance.now() - t0), appariementsMs: Math.round(tm), paires: pairs.length, points: R.nPts, erreurPx: Math.round(R.med * 100) / 100, appuiMedian: median(R.support), ecartees: nw };
  if (!(R.med < 1.2) || nw > n * .25 || R.nPts < 15 * n) return { info: Object.assign(info, { refus: 'calage peu sûr' }) };
  // mise à niveau : on tient son téléphone sans le pencher sur le côté, donc le bord horizontal des images (vecteur
  // « droite ») est à peu près horizontal ; la verticale est la direction la plus perpendiculaire à tous ces bords
  // (sur de vraies photos : 0,7° d'écart, contre 2,4° avec la moyenne des « haut », faussée par le tangage)
  const cams = R.poses.map(camOf), Mr = new Float64Array(9); let um = [0, 0, 0];
  cams.forEach(c => { for (let i = 0; i < 3; i++) { um[i] += c.u[i]; for (let j = 0; j < 3; j++) Mr[i * 3 + j] += c.r[i] * c.r[j]; } });
  const Er = eigSym(Mr, 3); let ke = 0; for (let i = 1; i < 3; i++) if (Er.vals[i] < Er.vals[ke]) ke = i;
  let up = [Er.vecs[ke], Er.vecs[3 + ke], Er.vecs[6 + ke]]; if (up[0] * um[0] + up[1] * um[1] + up[2] * um[2] < 0) up = up.map(v => -v);
  { const un = Math.hypot(...up); up = up.map(v => v / un); }
  const ax = [-up[2], 0, up[0]], s = Math.hypot(...ax), co = up[1], rot = (() => {   // axe = haut × vertical if (s < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const k = ax.map(v => v / s), K = [0, -k[2], k[1], k[2], 0, -k[0], -k[1], k[0], 0], K2 = mul3(K, K); return [0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => (i % 4 === 0 ? 1 : 0) + s * K[i] + (1 - co) * K2[i]); })();
  const ap = v => [rot[0] * v[0] + rot[1] * v[1] + rot[2] * v[2], rot[3] * v[0] + rot[4] * v[1] + rot[5] * v[2], rot[6] * v[0] + rot[7] * v[1] + rot[8] * v[2]];
  const C = cams.map(c => ap(c.C)), Rr = cams.map(c => ap(c.r)), Uu = cams.map(c => ap(c.u)), Ff = cams.map(c => ap(c.f)), pts = R.X.filter(Boolean).map(ap);
  // centre : point le plus proche de toutes les visées (plan horizontal)
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (let k = 0; k < n; k++) { const l = Math.hypot(Ff[k][0], Ff[k][2]) || 1, ux = Ff[k][0] / l, uz = Ff[k][2] / l, p11 = 1 - ux * ux, p12 = -ux * uz, p22 = 1 - uz * uz;
    a11 += p11; a12 += p12; a22 += p22; b1 += p11 * C[k][0] + p12 * C[k][2]; b2 += p12 * C[k][0] + p22 * C[k][2]; }
  const det = a11 * a22 - a12 * a12; if (Math.abs(det) < 1e-9) return { info: Object.assign(info, { refus: 'visées parallèles' }) };
  let cx0 = (b1 * a22 - a12 * b2) / det, cz0 = (a11 * b2 - a12 * b1) / det;
  // échelle : l'ajustement ne la fixe pas ; distance médiane des téléphones à la voiture = celle tirée de la taille des
  // silhouettes (comme l'estimation par le décor)
  { const k = median(P0.map(p => p.d)) / median(C.map(c => Math.hypot(c[0] - cx0, c[2] - cz0)));
    for (const c of C) { c[0] *= k; c[1] *= k; c[2] *= k; } for (const p of pts) { p[0] *= k; p[1] *= k; p[2] *= k; } cx0 *= k; cz0 *= k; info.echelle = Math.round(k * 100) / 100; }
  // sol : téléphones à la hauteur supposée (celle des conseils de tournage, comme l'estimation par le décor). Essayés et
  // écartés : les points de décor au sol (trop rares, sol trouvé jusqu'à 19 cm trop haut) et le bas des pneus sur les
  // vues de côté (le détourage rate le bas sombre des pneus : sol 17 cm trop haut sur la vidéo de test)
  const hm = median(C.map(c => c[1])), yg = hm - CAM_H, sol = 'hauteur supposée';
  info.sol = sol; info.hauteurM = Math.round((hm - yg) * 100) / 100;
  const poses = C.map((c, k) => poseFromCam([c[0] - cx0, c[1] - yg, c[2] - cz0], Rr[k], Uu[k], Ff[k], TARGET_H));
  return { poses, weak, info };
}

/* ---------- 4 bis. Forme fine dans le repère de la voiture (v0.15.1) ---------- */
// Grille alignée sur la voiture : i le long (axe a), j en hauteur, k en largeur (axe b), cubes de CELL mètres.
// Indice (k * ny + j) * nx + i, comme la grille de départ. Seule la peau de la forme grossière est retestée.
const CELL = .025;
// Lissage de la forme fine : passes de flou le long de la voiture (x) et en travers (yz), puis du maillage (Taubin) et des
// normales d'affichage (reflets du vernis sans bosses)
const LISSE = { x: 24, yz: 2, taubin: 40, normales: 60 };
function morph3(occ, n, grow) { // dilatation (grow) ou érosion d'un cube, voisinage 3 × 3 × 3
  let a = occ;
  for (let ax = 0; ax < 3; ax++) { const s = ax === 0 ? 1 : ax === 1 ? n : n * n, b = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) { const c = ax === 0 ? i % n : ax === 1 ? ((i / n) | 0) % n : (i / (n * n)) | 0;
      const l = c > 0 ? a[i - s] : 0, r = c < n - 1 ? a[i + s] : 0; b[i] = grow ? (a[i] | l | r) : (a[i] & l & r); }
    a = b; }
  return a;
}
function carveAligned(cams, masks, SW, SH, fpx, S, sh, tol, tol2) {
  const { alpha, cx, cz, L, W, H } = sh, ca = Math.cos(alpha), sa = Math.sin(alpha), m = .15;
  const nx = Math.ceil((L + 2 * m) / CELL), ny = Math.ceil((H + m) / CELL), nz = Math.ceil((W + 2 * m) / CELL);
  const a0 = -nx * CELL / 2, b0 = -nz * CELL / 2;
  const n = GRID, { R, Y } = S.box, near = morph3(S.occ, n, true), sure = morph3(morph3(S.occ, n, false), n, false);
  const occ = new Uint8Array(nx * ny * nz), nv = cams.length, maxOut = tol != null ? tol : Math.max(2, Math.round(nv * .07));
  const occ2 = tol2 != null ? new Uint8Array(nx * ny * nz) : null, lim = occ2 ? Math.max(maxOut, tol2) : maxOut;   // occ2 : forme plus tolérante (v0.25)
  const near2 = occ2 ? morph3(near, n, true) : null;   // la forme grossière a pu être creusée aussi : un cube de plus autour
  const order = []; for (let s = 0; s < 8; s++) for (let i = s; i < nv; i += 8) order.push(i);
  for (let k = 0; k < nz; k++) { const b = b0 + (k + .5) * CELL;
    for (let j = 0; j < ny; j++) { const wy = (j + .5) * CELL; if (wy < .03) continue; const gy = Math.floor(wy / Y * n); if (gy >= n) continue;
      for (let i = 0; i < nx; i++) {
        const a = a0 + (i + .5) * CELL, wx = cx + a * ca - b * sa, wz = cz + a * sa + b * ca;
        const gx = Math.floor((wx / R + 1) / 2 * n), gz = Math.floor((wz / R + 1) / 2 * n);
        if (gx < 0 || gz < 0 || gx >= n || gz >= n) continue;
        const g = (gz * n + gy) * n + gx, nr = near[g]; if (!nr && !(near2 && near2[g])) continue;
        if (sure[g]) { occ[(k * ny + j) * nx + i] = 1; if (occ2) occ2[(k * ny + j) * nx + i] = 1; continue; }   // bien à l'intérieur de la forme grossière
        let out = 0, seen = 0;
        for (const v of order) { const c = cams[v], qx = wx - c.C[0], qy = wy - c.C[1], qz = wz - c.C[2];
          const zc = qx * c.f[0] + qy * c.f[1] + qz * c.f[2]; if (zc < .3) continue;
          const u = SW / 2 + fpx * (qx * c.r[0] + qy * c.r[1] + qz * c.r[2]) / zc, w = SH / 2 - fpx * (qx * c.u[0] + qy * c.u[1] + qz * c.u[2]) / zc;
          if (u < 0 || w < 0 || u >= SW || w >= SH) continue;
          seen++; if (!masks[v][(w | 0) * SW + (u | 0)]) { if (++out > lim) break; } }
        if (seen >= nv * .35) { if (nr && out <= maxOut) occ[(k * ny + j) * nx + i] = 1; if (occ2 && out <= tol2) occ2[(k * ny + j) * nx + i] = 1; }
      } } }
  return { occ, occ2, nx, ny, nz, a0, b0 };
}
function largestComp3(occ, nx, ny, nz) {
  const lab = new Int32Array(occ.length).fill(-1), st = [], NXY = nx * ny; let best = -1, bestN = 0, id = 0;
  for (let i = 0; i < occ.length; i++) { if (!occ[i] || lab[i] >= 0) continue; let c = 0; lab[i] = id; st.push(i);
    while (st.length) { const k = st.pop(); c++; const x = k % nx, y = ((k / nx) | 0) % ny, z = (k / NXY) | 0;
      if (x > 0 && occ[k - 1] && lab[k - 1] < 0) { lab[k - 1] = id; st.push(k - 1); }
      if (x < nx - 1 && occ[k + 1] && lab[k + 1] < 0) { lab[k + 1] = id; st.push(k + 1); }
      if (y > 0 && occ[k - nx] && lab[k - nx] < 0) { lab[k - nx] = id; st.push(k - nx); }
      if (y < ny - 1 && occ[k + nx] && lab[k + nx] < 0) { lab[k + nx] = id; st.push(k + nx); }
      if (z > 0 && occ[k - NXY] && lab[k - NXY] < 0) { lab[k - NXY] = id; st.push(k - NXY); }
      if (z < nz - 1 && occ[k + NXY] && lab[k + NXY] < 0) { lab[k + NXY] = id; st.push(k + NXY); } }
    if (c > bestN) { bestN = c; best = id; } id++; }
  const out = new Uint8Array(occ.length); for (let i = 0; i < occ.length; i++) if (lab[i] === best) out[i] = 1;
  return out;
}
function blur1(f, nx, ny, nz, ax) { // flou [1 2 1] / 4 le long d'un seul axe (0 : longueur, 1 : hauteur, 2 : largeur)
  const b = new Float32Array(f.length), s = [1, nx, nx * ny][ax], n = [nx, ny, nz][ax];
  for (let i = 0; i < f.length; i++) { const c = ax === 0 ? i % nx : ax === 1 ? ((i / nx) | 0) % ny : (i / (nx * ny)) | 0;
    b[i] = (f[i] * 2 + (c > 0 ? f[i - s] : f[i]) + (c < n - 1 ? f[i + s] : f[i])) / 4; }
  f.set(b); return f;
}
function blur3a(f, nx, ny, nz) { // flou [1 2 1] / 4 sur les 3 axes
  const b = new Float32Array(f.length), dims = [nx, ny, nz], strides = [1, nx, nx * ny];
  for (let ax = 0; ax < 3; ax++) { const s = strides[ax], n = dims[ax];
    for (let i = 0; i < f.length; i++) { const c = ax === 0 ? i % nx : ax === 1 ? ((i / nx) | 0) % ny : (i / (nx * ny)) | 0;
      b[i] = (f[i] * 2 + (c > 0 ? f[i - s] : 0) + (c < n - 1 ? f[i + s] : 0)) / 4; }
    f.set(b); }
  return f;
}
// Vu d'en bas (téléphone plus bas que le toit), le haut de la forme sculptée monte en « tente » au-dessus du vrai toit.
// Pour chaque tranche de la voiture, le milieu est ramené à la hauteur atteinte aux deux tiers de sa largeur.
function flattenRoof(occ, nx, ny, nz) {
  const top = new Int16Array(nx * nz).fill(-1);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) for (let j = ny - 1; j >= 0; j--) if (occ[(k * ny + j) * nx + i]) { top[k * nx + i] = j; break; }
  let cut = 0;
  for (let i = 0; i < nx; i++) {
    let k0 = -1, k1 = -1; for (let k = 0; k < nz; k++) if (top[k * nx + i] >= 0) { if (k0 < 0) k0 = k; k1 = k; }
    if (k0 < 0 || k1 - k0 < 12) continue;
    const kA = Math.round(k0 + .34 * (k1 - k0)), kB = Math.round(k0 + .66 * (k1 - k0)), tA = top[kA * nx + i], tB = top[kB * nx + i];
    if (tA < 0 || tB < 0) continue;
    const cap = Math.round((tA + tB) / 2) + 1;
    for (let k = kA; k <= kB; k++) for (let j = cap + 1; j < ny; j++) { const q = (k * ny + j) * nx + i; if (occ[q]) { occ[q] = 0; cut++; } }
  }
  return cut;
}
// Une voiture est symétrique gauche-droite : on cherche le plan (en largeur) qui superpose le mieux la forme et son
// reflet, puis on fait la moyenne des deux. Les bosses d'un seul côté (erreurs de détourage) sont divisées par deux.
function symmetrize(f, nx, ny, nz) {
  const overlap = m2 => { let s = 0; for (let k = 0; k < nz; k++) { const k2 = m2 - k; if (k2 < 0 || k2 >= nz) continue;
    for (let j = 0; j < ny; j += 2) { const o1 = (k * ny + j) * nx, o2 = (k2 * ny + j) * nx; for (let i = 0; i < nx; i += 2) s += Math.min(f[o1 + i], f[o2 + i]); } } return s; };
  let bm = nz - 1, bs = -1;
  for (let m2 = nz - 1 - 12; m2 <= nz - 1 + 12; m2++) { const s = overlap(m2); if (s > bs) { bs = s; bm = m2; } }
  const g = new Float32Array(f.length);
  for (let k = 0; k < nz; k++) { const k2 = bm - k, in2 = k2 >= 0 && k2 < nz;
    for (let j = 0; j < ny; j++) { const o1 = (k * ny + j) * nx, o2 = (k2 * ny + j) * nx; for (let i = 0; i < nx; i++) g[o1 + i] = .5 * (f[o1 + i] + (in2 ? f[o2 + i] : 0)); } }
  return { g, mid: bm / 2 };
}
// Flancs tendus (v0.21) : vu d'en haut, la forme sculptée gonfle le milieu des flancs en « tente » (un flanc plat n'est
// frôlé que par les rares images prises dans son prolongement, et ces rayons ne touchent la carrosserie qu'aux angles).
// À chaque hauteur, la demi-largeur le long de la voiture est ramenée au niveau atteint près des angles (10e centile du
// palier), si ce palier couvre au moins 40 % de la longueur ; pas sous jMin (les pneus). g : champ symétrisé, mid : plan
// de symétrie (en cellules). Sur la vidéo de test : flancs à 1 à 3 cm des vrais au lieu de 5 à 10 cm.
function tautSides(g, nx, ny, nz, mid, jMin) {
  const w = new Float32Array(nx), lev = new Float32Array(ny).fill(-1), fill = .12 / CELL;
  for (let j = jMin; j < ny; j++) {
    let wmax = -1, i0 = nx, i1 = -1;
    for (let i = 0; i < nx; i++) { w[i] = -1;
      for (let k = nz - 1; k > mid; k--) { const v = g[(k * ny + j) * nx + i]; if (v >= .5) { const o = k + 1 < nz ? g[((k + 1) * ny + j) * nx + i] : 0; w[i] = k - mid + (v - .5) / Math.max(1e-3, v - o); break; } }
      if (w[i] > wmax) wmax = w[i]; if (w[i] >= 0) { if (i < i0) i0 = i; if (i > i1) i1 = i; } }
    if (i1 - i0 < 40) continue;
    const pl = []; for (let i = i0; i <= i1; i++) if (w[i] >= wmax - fill) pl.push(w[i]);
    if (pl.length < .4 * (i1 - i0 + 1)) continue;
    pl.sort((a, b) => a - b); lev[j] = pl[Math.floor(pl.length * .1)];
  }
  // niveaux lissés en hauteur (médiane sur 5 étages), puis la tente est coupée
  const lv = Float32Array.from(lev); let cut = 0;
  for (let j = 0; j < ny; j++) { if (lev[j] < 0) continue; const a = []; for (let d = -2; d <= 2; d++) if (j + d >= 0 && j + d < ny && lev[j + d] >= 0) a.push(lev[j + d]); lv[j] = median(a); }
  for (let j = 0; j < ny; j++) { if (lv[j] < 0) continue;
    for (let k = 0; k < nz; k++) { const d = Math.abs(k - mid) - lv[j]; if (d <= -.5) continue; const cap = clamp(.5 - d, 0, 1);
      for (let i = 0; i < nx; i++) { const q = (k * ny + j) * nx + i; if (g[q] > cap) { if (g[q] >= .5 && cap < .5) cut++; g[q] = cap; } } } }
  return { cut, levels: Array.from(lv).filter(v => v >= 0).length };
}
// Carrosserie « maquette » (v0.23) : chaque tranche de la forme sculptée est mesurée (bas, haut au milieu, demi-largeur
// à chaque hauteur), puis remplacée par une coupe de voiture nette : bas de caisse arrondi, flanc droit, épaulement à la
// ligne de ceinture, vitres qui rentrent vers le toit, toit plat à arêtes arrondies (capot et coffre : arêtes plus
// douces). La ligne de ceinture est mesurée (coude de la demi-largeur, droite le long de la voiture) ; l'angle de rentrée
// des vitres est mesuré puis borné à 10-20° (la sculpture arrondit trop le haut). Profils lissés le long de la voiture
// (médiane, puis moyenne gaussienne qui garde les cassures nettes : hayon, pare-brise) ; bouts arrondis comme des
// boucliers. v0.24 : haut et bas mesurés au dixième de millimètre ; profils et pente des vitres rendus à la carrosserie
// lisse (maquetteMesh), qui remplace le champ rastérisé ci-dessous (gardé pour le sens de la voiture et en repli).
const MQ = { taubin: 10, normales: 8, sigma: 9, rb: .07, rs: .025, rr: .055, rt: .13, ledge: .035, crown: .015, tanMin: Math.tan(10 * Math.PI / 180), tanMax: Math.tan(20 * Math.PI / 180), rPlan: .18, rTop: .12, rBot: .1 };
// Toit creusé par quelques images (v0.25) : une partie n'est gardée que si au plus 3 % des images la voient hors de la
// voiture ; quand le détourage rate le haut sombre de la voiture (toit noir, becquet, lunette devant des immeubles) sur
// 2 ou 3 images, le bout du toit est creusé (vidéo de test : arrière d'un break 9 à 14 cm trop bas sur 70 cm, profil de
// berline). Une 2e forme plus tolérante (8 % des images) est sculptée en même temps ; au milieu de la largeur, l'écart de
// hauteur entre les deux formes, moins l'écart habituel (1er quartile sur le toit : la « tente » de la forme tolérante), relève
// le haut de chaque tranche, sur le dessus de la voiture seulement, de 15 cm au plus.
function roofLift(top0, topT, nx, nz, mid) {
  const k0 = Math.max(0, Math.floor(mid - 6)), k1 = Math.min(nz - 1, Math.ceil(mid + 6)), h0 = new Float32Array(nx).fill(-1), hT = new Float32Array(nx).fill(-1);
  for (let i = 0; i < nx; i++) for (let k = k0; k <= k1; k++) { h0[i] = Math.max(h0[i], top0[k * nx + i]); hT[i] = Math.max(hT[i], topT[k * nx + i]); }
  let hMax = 0; for (let i = 0; i < nx; i++) hMax = Math.max(hMax, h0[i]);
  const roof = [], d = new Float32Array(nx).fill(NaN);
  for (let i = 0; i < nx; i++) { if (h0[i] < .75 * hMax || hT[i] < 0) continue; d[i] = hT[i] - h0[i]; if (h0[i] >= .9 * hMax) roof.push(d[i]); }
  if (roof.length < 20) return null;
  roof.sort((a, b) => a - b); const bias = roof[Math.floor(roof.length / 4)], lift = new Float32Array(nx), lim = .15 / CELL; let n = 0, mx = 0;
  const raw = new Float32Array(nx);   // médiane sur 5 tranches, puis moyenne gaussienne (4 tranches) : pas de marches de 2,5 cm
  for (let i = 0; i < nx; i++) { if (isNaN(d[i])) continue; const a = []; for (let e = -2; e <= 2; e++) if (i + e >= 0 && i + e < nx && !isNaN(d[i + e])) a.push(d[i + e]);
    raw[i] = clamp(median(a) - bias, 0, lim); }
  for (let i = 0; i < nx; i++) { if (isNaN(d[i])) continue; let sm = 0, w = 0;
    for (let e = -12; e <= 12; e++) { const j = i + e; if (j < 0 || j >= nx) continue; const g = Math.exp(-e * e / 32); sm += g * raw[j]; w += g; }
    const v = sm / w; lift[i] = v * CELL; if (v > .1) n++; if (v > mx) mx = v; }
  return { lift, info: { biaisCm: Math.round(bias * CELL * 100), tranches: n, maxCm: Math.round(mx * CELL * 100) } };
}
function maquetteField(D, sill) {
  const { nx, ny, nz, cell, field: F, b0, bc } = D, kmid = (bc - b0) / cell - .5, NXY = nx * ny;
  const LF = D.lift || new Float32Array(nx), W = new Float32Array(nx * ny).fill(-1), top = new Float32Array(nx).fill(NaN), bot = new Float32Array(nx).fill(NaN);
  const pc = new Float32Array(ny), pe = new Float32Array(ny);   // par rangée : plus forte valeur au milieu (±6 colonnes) et sur la moitié
  for (let i = 0; i < nx; i++) {
    let jt = -1, jb = ny;
    for (let j = 0; j < ny; j++) {
      for (let k = nz - 1; k > kmid; k--) { const v = F[k * NXY + j * nx + i]; if (v >= 128) { const o = k + 1 < nz ? F[(k + 1) * NXY + j * nx + i] : 0;
        W[i * ny + j] = (k - kmid + (v - 127.5) / Math.max(1, v - o)) * cell; if (j < jb) jb = j; break; } }
      let mc = 0, me = 0;
      for (let k = Math.max(0, Math.floor(kmid - 6)); k <= Math.min(nz - 1, Math.ceil(kmid + 6)); k++) mc = Math.max(mc, F[k * NXY + j * nx + i]);
      for (let k = Math.floor(kmid) + 1; k < nz; k++) me = Math.max(me, F[k * NXY + j * nx + i]);
      pc[j] = mc; pe[j] = me; if (mc >= 128) jt = j;
    }
    // v0.24 : haut et bas pris là où la forme passe 127,5 entre deux cubes (au dixième de millimètre, plus en marches de 2,5 cm)
    if (jt >= 0) { top[i] = (jt + .5 + (jt + 1 < ny ? (pc[jt] - 127.5) / Math.max(1, pc[jt] - pc[jt + 1]) : .5)) * cell + LF[i];
      bot[i] = jb > 0 && jb < ny ? (jb - .5 + clamp((127.5 - pe[jb - 1]) / Math.max(1, pe[jb] - pe[jb - 1]), 0, 1)) * cell : jb * cell; }
  }
  const yv = j => (j + .5) * cell, av = i => D.a0 + (i + .5) * cell;
  let i0 = nx, i1 = -1; for (let i = 0; i < nx; i++) if (!isNaN(top[i])) { if (i < i0) i0 = i; if (i > i1) i1 = i; }
  if (i1 - i0 < 40) return null;
  let tMax = 0; for (let i = i0; i <= i1; i++) if (top[i] > tMax) tMax = top[i];
  // ligne de ceinture : coude de la demi-largeur sur les tranches d'habitacle, puis droite robuste le long de la voiture
  const bx = [], by = [];
  for (let i = i0; i <= i1; i++) { if (!(top[i] >= .9 * tMax)) continue; const b = bot[i], t = top[i]; let w0 = 0;
    for (let j = 0; j < ny; j++) { const y = yv(j); if (y >= b + .1 && y <= b + .6 * (t - b) && W[i * ny + j] > w0) w0 = W[i * ny + j]; }
    for (let j = 0; j < ny; j++) { const y = yv(j); if (y > b + .45 * (t - b) && W[i * ny + j] > 0 && W[i * ny + j] < w0 - .04) { bx.push(av(i)); by.push(y); break; } } }
  let ka = 0, kb = bx.length ? median(by) : .62 * tMax;
  for (let it = 0; it < 4 && bx.length >= 10; it++) {
    const res = bx.map((x, n) => Math.abs(ka * x + kb - by[n])), lim = Math.max(.02, [...res].sort((a, b) => a - b)[Math.floor(res.length * .7)]);
    let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
    bx.forEach((x, n) => { if (res[n] > lim) return; sx += x; sy += by[n]; sxx += x * x; sxy += x * by[n]; m++; });
    const den = m * sxx - sx * sx; if (m < 5 || Math.abs(den) < 1e-9) break;
    ka = clamp((m * sxy - sx * sy) / den, -.03, .03); kb = (sy - ka * sx) / m;
  }
  const belt = x => ka * x + kb;
  // demi-largeur de caisse : la plus grande entre le bas + 10 cm et la ceinture - 5 cm
  const wb = new Float32Array(nx).fill(NaN);
  for (let i = i0; i <= i1; i++) { if (isNaN(top[i])) continue; const hi = Math.min(top[i] - .05, belt(av(i)) - .05); let w0 = -1;
    for (let j = 0; j < ny; j++) { const y = yv(j); if (y >= bot[i] + .1 && y <= hi && W[i * ny + j] > w0) w0 = W[i * ny + j]; }
    if (w0 > 0) wb[i] = w0; }
  const smooth = (v, r, sv) => { const o = Float32Array.from(v);   // médiane, puis moyenne gaussienne ; sv : écart de valeur toléré (bord net gardé : filtre bilatéral)
    for (let i = 0; i < nx; i++) { const a = []; for (let d = -r; d <= r; d++) if (i + d >= 0 && i + d < nx && !isNaN(v[i + d])) a.push(v[i + d]); if (a.length && !isNaN(v[i])) o[i] = median(a); }
    const o2 = Float32Array.from(o), sg = MQ.sigma;   // puis moyenne gaussienne (sigma en tranches de 2,5 cm)
    for (let i = 0; i < nx; i++) { if (isNaN(o[i])) continue; let sm = 0, n = 0;
      for (let d = -3 * sg; d <= 3 * sg; d++) if (i + d >= 0 && i + d < nx && !isNaN(o[i + d])) { const dv = sv ? (o[i + d] - o[i]) / sv : 0, g = Math.exp(-d * d / (2 * sg * sg) - dv * dv / 2); sm += o[i + d] * g; n += g; } o2[i] = sm / n; }
    return o2; };
  // v0.24 : pour le bas et la pente des vitres, droite locale robuste au lieu de la moyenne : autour de chaque tranche,
  // droite ajustée (poids gaussiens) ; les tranches loin de la droite (écart / sv) comptent moins. Le bas qui remonte
  // vers les boucliers reste une pente douce (plus de marche sous les bouts).
  const droite = (v, r, sv = .08) => { const o = Float32Array.from(v);
    for (let i = 0; i < nx; i++) { const a = []; for (let d = -r; d <= r; d++) if (i + d >= 0 && i + d < nx && !isNaN(v[i + d])) a.push(v[i + d]); if (a.length && !isNaN(v[i])) o[i] = median(a); }
    const o2 = Float32Array.from(o), sg = MQ.sigma, R = 3 * sg;
    for (let i = 0; i < nx; i++) { if (isNaN(o[i])) continue; let a = o[i], b = 0;
      for (let it = 0; it < 3; it++) { let S0 = 0, S1 = 0, S2 = 0, T0 = 0, T1 = 0;
        for (let d = -R; d <= R; d++) { const j = i + d; if (j < 0 || j >= nx || isNaN(o[j])) continue;
          const e = it ? (o[j] - a - b * d) / sv : 0, g = Math.exp(-d * d / (2 * sg * sg) - e * e / 2);
          S0 += g; S1 += g * d; S2 += g * d * d; T0 += g * o[j]; T1 += g * o[j] * d; }
        const den = S0 * S2 - S1 * S1; if (den > 1e-9) { a = (T0 * S2 - T1 * S1) / den; b = (S0 * T1 - S1 * T0) / den; } else if (S0 > 0) { a = T0 / S0; b = 0; } }
      o2[i] = a; }
    return o2; };
  const T = smooth(top, 4, .03), B = droite(bot, 2, .03), WB = smooth(wb, 4);
  // pente des vitres de côté (mesurée sur les tranches d'habitacle, bornée, lissée) pour la carrosserie lisse
  const tgRaw = new Float32Array(nx).fill(NaN);
  for (let i = i0; i <= i1; i++) { const t = T[i], w = WB[i]; if (isNaN(t) || isNaN(w)) continue;
    const h = t - belt(av(i)), f = clamp(h / .25, 0, 1), jj = Math.floor((t - LF[i] - .12) / cell); if (h < .1 || f < .5 || jj < 0 || jj >= ny || !(W[i * ny + jj] > 0)) continue;
    tgRaw[i] = clamp((w - MQ.ledge * f - W[i * ny + jj]) / h, MQ.tanMin, MQ.tanMax); }
  const coupes = { i0, i1, T: Float32Array.from(T), B: Float32Array.from(B), WB: Float32Array.from(WB), TG: droite(tgRaw, 4), ka, kb, sill: sill || 0 };
  for (const [ie, dir] of [[i0, 1], [i1, -1]]) {
    const ir = ie + dir * Math.round(MQ.rPlan / cell), wRef = WB[ir], tRef = T[ie + dir * Math.round(MQ.rTop / cell)], bRef = B[ie + dir * Math.round(MQ.rBot / cell)];
    for (let n = 0; n * cell < MQ.rPlan; n++) { const i = ie + dir * n, d = (n + .5) * cell; if (isNaN(WB[i])) continue;
      if (!isNaN(wRef)) WB[i] = Math.min(WB[i], wRef - MQ.rPlan + Math.sqrt(Math.max(0, MQ.rPlan ** 2 - (MQ.rPlan - d) ** 2)));
      if (d < MQ.rTop && !isNaN(tRef)) T[i] = Math.min(T[i], tRef - MQ.rTop + Math.sqrt(Math.max(0, MQ.rTop ** 2 - (MQ.rTop - d) ** 2)));
      if (d < MQ.rBot && !isNaN(bRef)) B[i] = Math.max(B[i], bRef + MQ.rBot - Math.sqrt(Math.max(0, MQ.rBot ** 2 - (MQ.rBot - d) ** 2))); } }
  const G = new Uint8Array(F.length), kz = new Float32Array(nz); for (let k = 0; k < nz; k++) kz[k] = Math.abs(k - kmid) * cell;
  let cab = 0;
  for (let i = i0; i <= i1; i++) {
    const t = T[i], b = Math.max(B[i], sill || 0), w = WB[i]; if (isNaN(t) || isNaN(w) || t - b < .1) continue;
    const bl = belt(av(i)), h = t - bl, f = clamp(h / .25, 0, 1);   // f : part d'habitacle (0 sur le capot et le coffre)
    let wg0 = w, wg1 = w, rr = Math.min(MQ.rt, (t - b) / 3);
    if (h > .02) { wg0 = w - MQ.ledge * f; const jj = Math.floor((t - LF[i] - .12) / cell), wm = jj >= 0 && jj < ny && W[i * ny + jj] > 0 ? W[i * ny + jj] : wg0;
      wg1 = wg0 - f * clamp(wg0 - wm, h * MQ.tanMin, h * MQ.tanMax); rr = MQ.rr + (1 - f) * (MQ.rt - MQ.rr); if (f > .5) cab++; }
    const rb = Math.min(MQ.rb, (t - b) / 3), rs = MQ.rs, top0 = Math.min(bl, t);
    const half = y => {   // demi-largeur de la coupe à la hauteur y
      if (y < b || y > t) return -1;
      if (y < b + rb) return w - rb + Math.sqrt(Math.max(0, rb * rb - (b + rb - y) ** 2));
      if (h <= .02) { const r = Math.min(MQ.rt, (t - b) / 3); return y > t - r ? w - r + Math.sqrt(Math.max(0, r * r - (y - (t - r)) ** 2)) : w; }
      if (y < top0 - rs) return w;
      if (y < top0) return w - rs * f + Math.sqrt(Math.max(0, rs * rs - (y - (top0 - rs)) ** 2)) * f + (1 - f) * 0;
      const r = Math.min(rr, h / 2);
      if (y < t - r) return wg0 + (wg1 - wg0) * (y - bl) / Math.max(1e-3, t - r - bl);
      return wg1 - r + Math.sqrt(Math.max(0, r * r - (y - (t - r)) ** 2)); };
    for (let j = 0; j < ny; j++) { const y = yv(j), hw = half(y); if (hw <= 0) continue;
      for (let k = 0; k < nz; k++) { const z = kz[k], tz = t - MQ.crown * Math.min(1, z / Math.max(.3, hw)) ** 2;
        const v = clamp(.5 + (hw - z) / cell, 0, 1) * clamp(.5 + (tz - y) / cell, 0, 1); if (v > 0) G[k * NXY + j * nx + i] = Math.round(v * 255); } }
  }
  // transitions douces d'une tranche à l'autre
  const Gf = new Float32Array(G.length); for (let n = 0; n < G.length; n++) Gf[n] = G[n] / 255;
  for (let p = 0; p < 4; p++) blur1(Gf, nx, ny, nz, 0);
  for (let n = 0; n < G.length; n++) F[n] = Math.round(clamp(Gf[n], 0, 1) * 255);
  const cabH = new Float32Array(nx).fill(-1); for (let i = i0; i <= i1; i++) if (!isNaN(T[i])) cabH[i] = T[i] - belt(av(i));   // hauteur d'habitacle au-dessus de la ceinture
  return { ceintureM: Math.round(kb * 100) / 100, penteCeinture: Math.round(ka * 1000) / 1000, tranchesHabitacle: cab, belt: [ka, kb, cabH], coupes };
}
// Carrosserie lisse (v0.24) : plus de grille de cubes (marching cubes : petites ondulations visibles dans les reflets).
// La surface est construite directement le long de la voiture, coupe après coupe, avec les mêmes mesures que la maquette
// (haut, bas, demi-largeur de caisse, ligne de ceinture, pente des vitres). Chaque coupe a toujours le même nombre de
// points aux mêmes endroits (fond, arrondi du bas de caisse, flanc, épaulement, rebord, vitres, arête du toit, toit
// bombé) : les arêtes sont des lignes nettes, sans vrille. Une seule forme de coupe qui passe en douceur du capot
// (grand arrondi) à l'habitacle (épaulement net, vitres qui rentrent). Coupes serrées aux bouts (arrondis des boucliers)
// et autour des roues ; passages de roue découpés exactement dans les coupes (arche ronde, bords nets, fond plat) ; bouts
// fermés par une face plate raccordée en douceur. Normales moyennées sur les faces voisines, sauf aux vraies cassures
// (bords des arches) qui restent nettes.
// Points par morceau de demi-coupe : fond, arrondi du bas, flanc bas (ou paroi du passage de roue), voûte de l'arche,
// flanc, épaulement, rebord, vitres, arête du toit, toit.
const LOFT = { n: [7, 6, 6, 5, 14, 7, 2, 14, 7, 16], gap: .035, depth: .27, archDeg: 6, endDeg: 7.5, cap: 5, crease: Math.cos(Math.PI / 4) };
function maquetteMesh(D, C, wheels, align) {
  const { cell, a0, ac, bc } = D, { i0, i1, ka, kb } = C, nS = i1 - i0 + 1;
  if (nS < 20) return null;
  const fill = v => { if (!v) return null; const o = new Float32Array(nS); let last = -1;   // profil sans trou (interpolé, bouts prolongés)
    for (let n = 0; n < nS; n++) { const x = v[i0 + n]; if (isNaN(x)) continue;
      if (last < 0) o.fill(x, 0, n); else for (let m = last + 1; m < n; m++) o[m] = o[last] + (x - o[last]) * (m - last) / (n - last);
      o[n] = x; last = n; }
    if (last < 0) return null; o.fill(o[last], last + 1); return o; };
  const T = fill(C.T), B = fill(C.B), WB = fill(C.WB), TG = fill(C.TG); if (!T || !B || !WB) return null;
  const at = (v, x) => { const u = clamp((x - a0) / cell - .5 - i0, 0, nS - 1), k = Math.min(nS - 2, Math.floor(u)); return v[k] + (v[k + 1] - v[k]) * (u - k); };
  const xMin = a0 + i0 * cell, xMax = a0 + (i1 + 1) * cell;
  const ends = [[xMin, 1], [xMax, -1]].map(([xe, dir]) => ({ xe, dir, w: at(WB, xe + dir * MQ.rPlan), t: at(T, xe + dir * MQ.rTop), b: at(B, xe + dir * MQ.rBot) }));
  const circ = (r, d) => r - Math.sqrt(Math.max(0, r * r - (r - d) ** 2));   // retrait d'un arrondi de rayon r, à la distance d du bout
  const prof = x => { let w = at(WB, x), t = at(T, x), b = at(B, x);
    for (const e of ends) { const d = Math.max(0, (x - e.xe) * e.dir);
      if (d < MQ.rPlan) w = Math.min(w, e.w - circ(MQ.rPlan, d));
      if (d < MQ.rTop) t = Math.min(t, e.t - circ(MQ.rTop, d));
      if (d < MQ.rBot) b = Math.max(b, e.b + circ(MQ.rBot, d)); }
    b = Math.max(b, C.sill); return { w, t, b: Math.min(b, t - .2), tg: TG ? at(TG, x) : MQ.tanMin }; };
  const N = LOFT.n, NH = N.reduce((a, n) => a + n + 1, 0), NR = 2 * NH - 2;
  // Demi-coupe (z ≥ 0), du milieu du dessous au milieu du toit : NH points [z, y]. notch : passage de roue (paroi zin, haut de l'arche yArc)
  const half = (x, notch, rNear) => {
    const { w, t, b, tg } = prof(x), H = t - b, rb = Math.min(MQ.rb, H / 3), tE = t - MQ.crown, bl = ka * x + kb, f = clamp((tE - bl) / .25, 0, 1);
    const yB = clamp(Math.min(bl, tE), b + rb + .04, tE), rT0 = Math.min(MQ.rt, H / 3), rS = clamp(rT0 + (MQ.rs - rT0) * f, .005, Math.max(.005, yB - b - rb - .02));
    const wg0 = Math.min(w - MQ.ledge * f, w - rS), hg = tE - yB, rr = Math.min(MQ.rr, hg / 2), yTop = yB - rS;
    const sl = f * Math.max(0, t - bl) * tg / Math.max(.02, hg - rr), wg1 = Math.max(wg0 - sl * hg, rr + .08);   // rentrée des vitres atteinte au début de l'arête du toit
    const o = [], seg = (n, fn) => { for (let k = 0; k <= n; k++) o.push(...fn(k / n)); };
    const ln = (n, z0, y0, z1, y1) => seg(n, u => [z0 + (z1 - z0) * u, y0 + (y1 - y0) * u]);
    const ar = (n, cz, cy, r, a, a2) => seg(n, u => [cz + r * Math.cos(a + (a2 - a) * u), cy + r * Math.sin(a + (a2 - a) * u)]);
    const yLow = clamp(Math.max(rNear, b + rb + .01), b + rb, yTop), yl = notch ? Math.max(notch.yArc, b + rb + .01) : 0;
    if (notch && notch.zin > .1 && notch.zin < w - rb - .01 && yl < yTop - .01) {   // passage de roue : fond, paroi, voûte, puis le flanc
      const zi = notch.zin; ln(N[0], 0, b, zi, b); ln(N[1], zi, b, zi, b); ln(N[2], zi, b, zi, yl); ln(N[3], zi, yl, w, yl); ln(N[4], w, yl, w, yTop);
    } else { ln(N[0], 0, b, w - rb, b); ar(N[1], w - rb, b + rb, rb, -Math.PI / 2, 0); ln(N[2], w, b + rb, w, yLow); ln(N[3], w, yLow, w, yLow); ln(N[4], w, yLow, w, yTop); }
    ar(N[5], w - rS, yTop, rS, 0, Math.PI / 2);                                  // épaulement (grand arrondi sur le capot et le coffre)
    ln(N[6], w - rS, yB, wg0, yB);                                              // rebord sous les vitres
    let T1 = [wg0, yB], cz = wg0, cy = yB, a1 = Math.PI / 2, r2 = 0;
    if (hg > 1e-4) { const L = Math.hypot(wg1 - wg0, hg), uz = (wg1 - wg0) / L, uy = hg / L, sl = (tE - rr - yB - rr * uz) / uy;   // arrondi tangent au toit et aux vitres
      T1 = [wg0 + sl * uz, yB + sl * uy]; cz = T1[0] - rr * uy; cy = T1[1] + rr * uz; a1 = Math.atan2(-uz, uy); r2 = rr; }
    ln(N[7], wg0, yB, T1[0], T1[1]);                                            // vitres de côté
    ar(N[8], cz, cy, r2, a1, Math.PI / 2);                                      // arête du toit
    const zI = Math.max(cz, 1e-3); seg(N[9], u => { const z = zI * (1 - u); return [z, t - MQ.crown * (1 - Math.cos(Math.PI * z / zI)) / 2]; });   // toit bombé
    return o; };
  // Coupes : une par tranche de 2,5 cm, serrées aux bouts (arrondis) et autour des roues (arche tous les 6°, deux fois
  // deux coupes au même endroit à l'avant et à l'arrière de l'arche : bord vertical net)
  const R0 = wh => wh.r + LOFT.gap, st = [];
  for (let i = i0; i <= i1; i++) st.push({ x: a0 + (i + .5) * cell, p: 0 });
  for (let a = 0; a <= 90 + 1e-6; a += LOFT.endDeg) { const d = MQ.rPlan * (1 - Math.cos(a * Math.PI / 180)); st.push({ x: xMin + d, p: 1 }, { x: xMax - d, p: 1 }); }
  const arches = (wheels || []).filter(wh => wh.xa - R0(wh) > xMin + MQ.rPlan && wh.xa + R0(wh) < xMax - MQ.rPlan && wh.zo - LOFT.depth > .1);
  for (const wh of arches) { const R = R0(wh);
    for (let a = 0; a <= 180 + 1e-6; a += LOFT.archDeg) { const x = wh.xa - R * Math.cos(a * Math.PI / 180);
      if (a === 0) st.push({ x, p: 2, cut: 0, wh }, { x, p: 2, cut: 0, wh }, { x, p: 2, cut: 1, wh }, { x, p: 2, cut: 1, wh });
      else if (a > 180 - 1e-6) st.push({ x, p: 2, cut: 1, wh }, { x, p: 2, cut: 1, wh }, { x, p: 2, cut: 0, wh }, { x, p: 2, cut: 0, wh });
      else st.push({ x, p: 2, cut: 1, wh }); } }
  st.sort((u, v) => u.x - v.x);
  const keep = st.filter((u, n) => { if (u.p === 2) return true;
    for (let m = n - 1; m >= 0 && u.x - st[m].x < .003; m--) if (st[m].p >= u.p) return false;
    for (let m = n + 1; m < st.length && st[m].x - u.x < .003; m++) if (st[m].p > u.p) return false;
    return true; });
  const arcAt = (wh, x) => ({ zin: wh.zo - LOFT.depth, yArc: wh.r + Math.sqrt(Math.max(0, R0(wh) ** 2 - (x - wh.xa) ** 2)) });
  const notchOf = u => { if (u.p === 2) return u.cut ? arcAt(u.wh, u.x) : null; for (const wh of arches) if (Math.abs(u.x - wh.xa) < R0(wh)) return arcAt(wh, u.x); return null; };
  const rNear = x => { let r = .3, d = 1e9; for (const wh of arches) if (Math.abs(x - wh.xa) < d) { d = Math.abs(x - wh.xa); r = wh.r; } return r; };
  const S = keep.length, K = LOFT.cap, nV0 = S * NR + 2 * ((K - 1) * NR + 1), P = new Float64Array(nV0 * 3);
  const segOf = new Uint8Array(NH), segV = new Uint8Array(nV0).fill(10), staV = new Int16Array(nV0).fill(-1), sideV = new Int8Array(nV0);   // morceau, coupe et côté de chaque sommet
  { let j = 0; N.forEach((n, m) => { for (let k = 0; k <= n; k++) segOf[j++] = m; }); }
  keep.forEach((u, si) => { const h = half(u.x, notchOf(u), rNear(u.x)), o = si * NR;
    for (let k = 0; k < NR; k++) { const j = k < NH ? k : NR - k, q = (o + k) * 3; P[q] = u.x; P[q + 1] = h[j * 2 + 1]; P[q + 2] = (k < NH ? 1 : -1) * h[j * 2];
      segV[o + k] = segOf[j]; staV[o + k] = si; sideV[o + k] = k < NH ? 1 : -1; } });
  const slope = Float32Array.from(keep, u => (prof(u.x + .02).t - prof(u.x - .02).t) / .04);   // pente du dessus à chaque coupe
  const tn = (a, b, c) => { const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2], vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]; };
  let I = [];
  for (let si = 0; si < S - 1; si++) for (let k = 0; k < NR; k++) { const k1 = (k + 1) % NR, a = si * NR + k, b = si * NR + k1, c = (si + 1) * NR + k1, d = (si + 1) * NR + k; I.push(a, b, c, a, c, d); }
  { const yc = .6, xc = (xMin + xMax) / 2; let out = 0;   // triangles tournés vers l'extérieur
    for (let t = 0; t < I.length; t += 3) { const n = tn(I[t], I[t + 1], I[t + 2]), g = [0, 1, 2].map(e => (P[I[t] * 3 + e] + P[I[t + 1] * 3 + e] + P[I[t + 2] * 3 + e]) / 3); out += n[0] * (g[0] - xc) + n[1] * (g[1] - yc) + n[2] * g[2]; }
    if (out < 0) for (let t = 0; t < I.length; t += 3) { const x = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = x; } }
  let vb = S * NR;   // bouts : face plate, anneaux resserrés vers le centre
  for (const [si, dir] of [[0, -1], [S - 1, 1]]) { const o = si * NR, x = keep[si].x; let cy = 0; for (let k = 0; k < NR; k++) cy += P[(o + k) * 3 + 1]; cy /= NR;
    const ring = l => l === 0 ? o : vb + (l - 1) * NR, ci = vb + (K - 1) * NR;
    for (let l = 1; l < K; l++) for (let k = 0; k < NR; k++) { const q = (ring(l) + k) * 3, f = 1 - l / K; P[q] = x; P[q + 1] = cy + (P[(o + k) * 3 + 1] - cy) * f; P[q + 2] = P[(o + k) * 3 + 2] * f; }
    P[ci * 3] = x; P[ci * 3 + 1] = cy; P[ci * 3 + 2] = 0;
    const cap = [];
    for (let l = 0; l < K - 1; l++) for (let k = 0; k < NR; k++) { const k1 = (k + 1) % NR; cap.push(ring(l) + k, ring(l) + k1, ring(l + 1) + k1, ring(l) + k, ring(l + 1) + k1, ring(l + 1) + k); }
    for (let k = 0; k < NR; k++) cap.push(ring(K - 1) + k, ring(K - 1) + (k + 1) % NR, ci);
    for (let t = 0; t < cap.length; t += 3) if (tn(cap[t], cap[t + 1], cap[t + 2])[0] * dir < 0) { const x2 = cap[t + 1]; cap[t + 1] = cap[t + 2]; cap[t + 2] = x2; }
    I = I.concat(cap); vb = ci + 1; }
  // triangles plats retirés (morceaux de coupe réduits à un point), sommets inutilisés retirés
  const J = [], fn = [];
  for (let t = 0; t < I.length; t += 3) { const n = tn(I[t], I[t + 1], I[t + 2]); if (Math.hypot(n[0], n[1], n[2]) > 2e-9) { J.push(I[t], I[t + 1], I[t + 2]); fn.push(n); } }
  const map = new Int32Array(nV0).fill(-1); let nV = 0; for (const v of J) if (map[v] < 0) map[v] = nV++;
  const Pa = new Float64Array(nV * 3), Na = new Float64Array(nV * 3), idx = new Uint32Array(J.length), seg = new Uint8Array(nV), sta = new Int16Array(nV), side = new Int8Array(nV);
  for (let v = 0; v < nV0; v++) if (map[v] >= 0) { for (let e = 0; e < 3; e++) Pa[map[v] * 3 + e] = P[v * 3 + e]; seg[map[v]] = segV[v]; sta[map[v]] = staV[v]; side[map[v]] = sideV[v]; }
  for (let t = 0; t < J.length; t += 3) { const n = fn[t / 3]; for (let e = 0; e < 3; e++) { const v = map[J[t + e]]; idx[t + e] = v; Na[v * 3] += n[0]; Na[v * 3 + 1] += n[1]; Na[v * 3 + 2] += n[2]; } }
  // normales : sommets au même endroit (jonctions des morceaux, coupes doublées) fondus, sauf aux cassures de plus de 45°
  const groups = new Map(), key = v => Math.round(Pa[v * 3] * 1e5) + ',' + Math.round(Pa[v * 3 + 1] * 1e5) + ',' + Math.round(Pa[v * 3 + 2] * 1e5);
  for (let v = 0; v < nV; v++) { const k = key(v), g = groups.get(k); if (g) g.push(v); else groups.set(k, [v]); }
  const unit = v => { const l = Math.hypot(Na[v * 3], Na[v * 3 + 1], Na[v * 3 + 2]) || 1; return [Na[v * 3] / l, Na[v * 3 + 1] / l, Na[v * 3 + 2] / l]; }, Nf = Float64Array.from(Na);
  for (const g of groups.values()) { if (g.length < 2) continue; const us = g.map(unit);
    g.forEach((v, m) => { let x = 0, y = 0, z = 0; g.forEach((w2, m2) => { if (us[m][0] * us[m2][0] + us[m][1] * us[m2][1] + us[m][2] * us[m2][2] >= LOFT.crease) { x += Na[w2 * 3]; y += Na[w2 * 3 + 1]; z += Na[w2 * 3 + 2]; } }); Nf[v * 3] = x; Nf[v * 3 + 1] = y; Nf[v * 3 + 2] = z; }); }
  // repères : affichage (centré, avant vers +x) et caméras du scan, comme meshFromField
  const { roofA, flip } = frontOf(D), { alpha, cx, cz } = align, ca = Math.cos(alpha), sa = Math.sin(alpha);
  const pos = new Float32Array(nV * 3), orig = new Float32Array(nV * 3), nrm = new Float32Array(nV * 3), onrm = new Float32Array(nV * 3);
  for (let v = 0; v < nV; v++) { const a = Pa[v * 3], y = Pa[v * 3 + 1], z = Pa[v * 3 + 2], b = bc + z, l = Math.hypot(Nf[v * 3], Nf[v * 3 + 1], Nf[v * 3 + 2]) || 1, na = Nf[v * 3] / l, ny = Nf[v * 3 + 1] / l, nz = Nf[v * 3 + 2] / l;
    pos[v * 3] = (a - ac) * flip; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z * flip;
    orig[v * 3] = cx + a * ca - b * sa; orig[v * 3 + 1] = y; orig[v * 3 + 2] = cz + a * sa + b * ca;
    nrm[v * 3] = na * flip; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz * flip;
    onrm[v * 3] = na * ca - nz * sa; onrm[v * 3 + 1] = ny; onrm[v * 3 + 2] = na * sa + nz * ca; }
  return { pos, orig, nrm, onrm, idx, flip, roofA, coupes: S, arches: arches.length, parts: { seg, sta, side, slope } };
}
// Vitres de la carrosserie lisse (v0.24) : sur le morceau « vitres de côté » de chaque coupe, tout ou rien, décidé par
// coupe et par côté (avis de la majorité des sommets, coupe isolée corrigée par ses voisines) : bords nets au rebord, à
// l'arête du toit et entre deux coupes (montants). Arête du toit et toit plat : jamais vitrés ; dessus en pente
// (pare-brise, lunette) et faces des bouts : comme la texture le montre ; carrosserie sous les vitres : jamais vitrée.
function glassBySections(mm, parts) {
  const { seg, sta, side, slope } = parts, nV = seg.length, nS = slope.length, G = mm.glass, src = mm.src;
  const acc = [0, 1].map(() => Array.from({ length: nS }, () => []));
  for (let i = 0; i < G.length; i++) { const v = src[i]; if (v < nV && seg[v] === 7) acc[side[v] > 0 ? 1 : 0][sta[v]].push(G[i]); }
  const dec = acc.map(a => { const vt = a.map(l => l.length ? (median(l) > 127 ? 1 : 0) : -1);
    return vt.map((x, k) => k > 0 && k < nS - 1 && vt[k - 1] >= 0 && vt[k + 1] >= 0 && x >= 0 ? (vt[k - 1] + x + vt[k + 1] >= 2 ? 1 : 0) : Math.max(0, x)); });
  for (let i = 0; i < G.length; i++) { const v = src[i]; if (v >= nV) continue; const sg = seg[v];
    if (sg === 7) G[i] = dec[side[v] > 0 ? 1 : 0][sta[v]] ? 255 : 0;
    else if (sg === 8) G[i] = 0;
    else if (sg === 9) { if (Math.abs(slope[sta[v]]) < .3) G[i] = 0; }
    else if (sg < 7) G[i] = 0; }
}
// Couleur dominante d'un ensemble de pixels : la teinte la plus fréquente (ou le gris le plus fréquent pour une voiture
// blanche, grise ou noire), puis la moyenne des pixels de cette teinte entre le 40e et le 85e centile de luminosité
// (ni les ombres, ni les reflets du ciel).
function dominant(px, lo = .4, hi = .85) {
  if (!px.length) return null;
  const key = (r, g, b) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
    if (sat < .22 || mx < 40) return 200 + Math.min(7, mx >> 5);
    let h = mx === r ? (g - b) / (mx - mn) : mx === g ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn); h = (h + 6) % 6;
    return Math.min(23, Math.floor(h * 4)) * 3 + Math.min(2, Math.floor((sat - .22) / .26)); };
  const cnt = new Uint32Array(208), keys = new Uint8Array(px.length / 3);
  for (let i = 0; i < keys.length; i++) { keys[i] = key(px[i * 3], px[i * 3 + 1], px[i * 3 + 2]); cnt[keys[i]]++; }
  let best = 0; for (let k = 1; k < 208; k++) if (cnt[k] > cnt[best]) best = k;
  const sel = []; for (let i = 0; i < keys.length; i++) if (keys[i] === best) sel.push(i);
  sel.sort((x, y) => (px[x * 3] * .3 + px[x * 3 + 1] * .59 + px[x * 3 + 2] * .11) - (px[y * 3] * .3 + px[y * 3 + 1] * .59 + px[y * 3 + 2] * .11));
  let r = 0, g = 0, b = 0, n = 0; for (let k = Math.floor(sel.length * lo); k < Math.max(Math.floor(sel.length * lo) + 1, Math.floor(sel.length * hi)); k++) { const i = sel[k]; r += px[i * 3]; g += px[i * 3 + 1]; b += px[i * 3 + 2]; n++; }
  return n ? [r / n / 255, g / n / 255, b / n / 255] : null;
}
// Couleur de la peinture : portières, entre les vitres et les roues (loin des bords de la silhouette)
function paintColor(masks, smalls, idxs, SW, SH) {
  const px = [];
  for (const i of idxs) { const m = masks[i], st = maskStats(m, SW, SH); if (!st.n) continue; const d = smalls[i].data;
    for (let y = Math.max(2, Math.round(st.y0 + st.h * .4)); y <= Math.min(SH - 3, Math.round(st.y0 + st.h * .75)); y += 2)
      for (let x = Math.max(2, st.x0); x <= Math.min(SW - 3, st.x1); x += 2) { const p = y * SW + x;
        if (m[p] && m[p - 2] && m[p + 2] && m[p - 2 * SW] && m[p + 2 * SW]) px.push(d[p * 4], d[p * 4 + 1], d[p * 4 + 2]); } }
  return dominant(px, .55, .9);   // v0.23 : la peinture bien éclairée (sa vraie couleur de jour), pas ses zones d'ombre
}
// Couleur du haut de la voiture (toit) : juste sous le bord haut de la silhouette, sur le milieu de sa longueur
function roofColor(masks, smalls, idxs, SW, SH) {
  const px = [];
  for (const i of idxs) { const m = masks[i], st = maskStats(m, SW, SH); if (!st.n || st.cutT) continue; const d = smalls[i].data;
    for (let x = Math.round(st.x0 + st.w * .3); x <= Math.round(st.x1 - st.w * .3); x += 2) {
      let y = 0; while (y < SH && !m[y * SW + x]) y++;
      for (let yy = y + 2; yy <= Math.min(SH - 1, y + 5); yy++) { const p = yy * SW + x; if (m[p]) px.push(d[p * 4], d[p * 4 + 1], d[p * 4 + 2]); } } }
  return dominant(px);
}

/* ---------- Tout le scan ---------- */
export async function scanVideo(file, opts = {}) {
  const progress = opts.progress || (() => {});
  progress('frames', 0);
  const F = await grabFrames(file, k => progress('frames', k), opts.seekOnly);
  try { return await scanFrames(F, opts, progress); }
  catch (e) {
    // Les images déjà tirées servent quand même à la vue 360° (une sur deux : 36 images régulières)
    const err = e instanceof Error ? e : new Error(String(e && e.message || e));
    if (!err.spinFrames) { try { const sp = await spinOf(F, F.bigs.map((b, i) => i).filter(i => F.bigs[i] && i % 2 === 0)); err.spinFrames = sp.frames; err.spinSize = sp.size; } catch (e2) {} }
    throw err;
  }
}

// Photos prises en tournant autour de la voiture (v0.20) : même calcul qu'avec une vidéo, une image par photo, dans
// l'ordre donné (celui des noms de fichiers). Le champ de l'appareil vient de la focale « équivalent 24 × 36 » de la photo
// quand elle est indiquée (grand-angle 0,5× compris), sinon celui d'un téléphone en mode photo.
export const MIN_PHOTOS = 16;
function exifFocal35(buf) {
  try { const v = new DataView(buf); if (v.getUint16(0) !== 0xFFD8) return 0; let o = 2;
    while (o + 10 < v.byteLength) { const mk = v.getUint16(o), len = v.getUint16(o + 2);
      if (mk === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) { const t = o + 10, le = v.getUint16(t) === 0x4949, g16 = q => v.getUint16(t + q, le), g32 = q => v.getUint32(t + q, le);
        const scan = (ifd, depth) => { if (depth > 2) return 0; const n = g16(ifd); for (let i = 0; i < n && i < 400; i++) { const e = ifd + 2 + i * 12, tag = g16(e);
            if (tag === 0xA405) return g16(e + 8);
            if (tag === 0x8769) { const r = scan(g32(e + 8), depth + 1); if (r) return r; } } return 0; };
        return scan(g32(4), 0); }
      if ((mk & 0xFF00) !== 0xFF00) break; o += 2 + len; }
  } catch (e) {}
  return 0;
}
async function framesOfPhotos(files, progress) {
  const bigs = [], smalls = [], grays = [], times = []; let BW = 0, BH = 0, SH = 0, GW = 0, GH = 0, ar = 0, f35 = 0, big, gb, sm, gs, gc, gg;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!f35) try { f35 = exifFocal35(await file.slice(0, 196608).arrayBuffer()); } catch (e) {}
    let bmp = null;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { bmp = await new Promise(res => { const u = URL.createObjectURL(file), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => { URL.revokeObjectURL(u); res(null); }; im.src = u; }); }
    if (!bmp) continue;
    const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
    if (!BW) { ar = w / h; BW = Math.min(1280, w); BH = Math.round(h * BW / w); SH = Math.round(h * WS / w);
      big = document.createElement('canvas'); big.width = BW; big.height = BH; gb = big.getContext('2d');
      sm = document.createElement('canvas'); sm.width = WS; sm.height = SH; gs = sm.getContext('2d', { willReadFrequently: true });
      GW = Math.min(640, w); GH = Math.round(h * GW / w); gc = document.createElement('canvas'); gc.width = GW; gc.height = GH; gg = gc.getContext('2d', { willReadFrequently: true }); }
    if (Math.abs(w / h / ar - 1) < .04) {                                  // une photo tournée autrement est laissée de côté
      gb.drawImage(bmp, 0, 0, BW, BH); gs.drawImage(bmp, 0, 0, WS, SH); smalls.push(gs.getImageData(0, 0, WS, SH)); bigs.push(await toJpeg(big)); times.push(i);
      gg.drawImage(bmp, 0, 0, GW, GH); grays.push(toGray(gg.getImageData(0, 0, GW, GH).data)); }
    if (bmp.close) bmp.close(); progress && progress((i + 1) / files.length); if (i % 4 === 3) await tick();
  }
  if (bigs.length < MIN_PHOTOS) throw new Error('peu');
  const lng = Math.max(ar, 1 / ar), half = lng > 1.45 && lng < 1.6 ? 18 : 17.3;   // 3:2 (appareil photo) ou 4:3 (téléphone)
  const hfov = f35 > 8 ? clamp(2 * Math.atan(half / f35) * 180 / Math.PI, 30, 115) : HFOV + 2;
  return { bigs, smalls, grays, times, SW: WS, SH, BW, BH, GW, GH, dur: bigs.length, hfov, photos: true };
}
export async function scanPhotos(files, opts = {}) {
  const progress = opts.progress || (() => {});
  progress('frames', 0);
  const F = await framesOfPhotos(files, k => progress('frames', k));
  try { return await scanFrames(F, opts, progress); }
  catch (e) {
    const err = e instanceof Error ? e : new Error(String(e && e.message || e));
    if (!err.spinFrames) { try { const n = F.bigs.length, idx = n <= N_TEX ? F.bigs.map((_, i) => i) : Array.from({ length: N_TEX }, (_, k) => Math.floor(k * n / N_TEX)); const sp = await spinOf(F, idx); err.spinFrames = sp.frames; err.spinSize = sp.size; } catch (e2) {} }
    throw err;
  }
}

// Images de la vue 360° : 960 px de large (les images du scan font jusqu'à 1280 px)
async function spinOf(F, idxs) {
  if (F.BW <= 960) return { frames: idxs.map(i => F.bigs[i]), size: [F.BW, F.BH] };
  const W = 960, H = Math.round(F.BH * W / F.BW), c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'), out = [];
  for (const i of idxs) { const b = await createImageBitmap(F.bigs[i]); g.drawImage(b, 0, 0, W, H); if (b.close) b.close(); out.push(await toJpeg(c, .85)); }
  return { frames: out, size: [W, H] };
}
const packMesh = mm => { const n = new Int8Array(mm.nrm.length), uv = new Uint16Array(mm.uv.length);
  for (let i = 0; i < n.length; i++) n[i] = Math.round(clamp(mm.nrm[i], -1, 1) * 127);
  for (let i = 0; i < uv.length; i++) uv[i] = Math.round(clamp(mm.uv[i], 0, 1) * 65535);
  const r = { pos: mm.pos, nrm: n, uv, idx: mm.idx }; if (mm.glass) r.glass = mm.glass; return r; };

async function scanFrames(F, opts, progress) {
  const q = {}, NF = F.smalls.length;                                   // 72 images d'une vidéo, ou les photos
  const { SW, SH } = F, fpx = (Math.max(SW, SH) / 2) / Math.tan((F.hfov || HFOV) / 2 * Math.PI / 180);
  // Détourage
  progress('model', 0);
  let masks;
  if (opts.testMasks) masks = await opts.testMasks(SW, SH, F.times);
  else {
    const { seg, keep } = await loadSegmenter().catch(() => { throw new Error('modele'); });
    masks = [];
    for (let i = 0; i < NF; i++) {
      const res = seg.segment(F.smalls[i]), cm = res.categoryMask, cats = cm.getAsUint8Array(), mw = cm.width, mh = cm.height, raw = new Uint8Array(SW * SH);
      for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) { const c = cats[Math.min(mh - 1, (y * mh / SH) | 0) * mw + Math.min(mw - 1, (x * mw / SW) | 0)]; raw[y * SW + x] = keep.includes(c) ? 1 : 0; }
      try { res.close(); } catch (e) {}
      { const cm0 = cleanMask(raw, SW, SH), gf = opts.affine === false ? null : opts.affine || [8, .01];   // v0.21 : contour recalé sur l'image
        masks.push(gf ? cleanMask(guidedMask(cm0, F.smalls[i], SW, SH, gf[0], gf[1]), SW, SH) : cm0); }
      progress('mask', (i + 1) / NF); if (i % 6 === 5) await tick();
      // Pas de voiture sur le premier tiers du tour : inutile de continuer
      if (i === Math.floor(NF / 3) - 1) { const seen = masks.filter(m => maskStats(m, SW, SH).frac > .02).length; if (seen < Math.max(2, NF / 12)) { const e = new Error('voiture'); e.quality = { carFrames: seen, frames: i + 1 }; throw e; } }
    }
  }
  const stats = masks.map(m => maskStats(m, SW, SH));
  const ok = stats.map(s => s.frac > .02 && s.n > 0);
  q.carFrames = ok.filter(Boolean).length; q.frames = NF;
  // Bilan du tournage (v0.22) : ce qui gêne le scan, mesuré sur les images ; l'appli en tire 1 à 3 conseils. Seuils réglés
  // pour que la vidéo de test (bien filmée : voiture touchant le bord sur 28 % des images, 68 % de la largeur) n'en ait aucun.
  // La lumière est mesurée sur toute l'image : une voiture noire de jour n'est pas « sombre ».
  const cons = []; q.conseils = cons;
  { const okS = stats.filter((s_, i) => ok[i]);
    if (SH > SW) cons.push({ k: 'vertical' });
    if (okS.length) { const cut = okS.filter(s_ => s_.cutL || s_.cutR).length / okS.length;
      if (cut > .45) cons.push({ k: 'coupee', v: Math.round(cut * 100) });
      else if (median(okS.map(s_ => s_.w / SW)) < .3 && median(okS.map(s_ => s_.h / SH)) < .3) cons.push({ k: 'petite' }); }
    let lum = 0, nl = 0;
    for (let i = 0; i < NF; i += 4) { const d = F.smalls[i].data; for (let p = 0; p < SW * SH; p += 13) { lum += d[p * 4] * .3 + d[p * 4 + 1] * .59 + d[p * 4 + 2] * .11; nl++; } }
    if (nl && lum / nl < 50) cons.push({ k: 'sombre' });
    if (!F.photos && F.dur && F.dur < 15) cons.push({ k: 'rapide', v: Math.round(F.dur) }); }
  if (q.carFrames < NF * .6) { const e = new Error('voiture'); e.quality = q; throw e; }
  // Angle parcouru, image après image
  progress('pose', 0);
  const spec = F.smalls.map((img, i) => bgSpectrum(img, dilate(masks[i], SW, SH, 6), SW, SH));
  const dxs = [], peaks = [];
  for (let i = 1; i < NF; i++) { const s = shiftBetween(spec[i - 1], spec[i]); dxs.push(s.dx); peaks.push(s.peak); if (i % 12 === 0) { progress('pose', i / NF); await tick(); } }
  // le dernier pas (fin → début du tour) n'est pas mesuré : on prend la médiane
  const med = median(dxs), sgn = Math.sign(med) || 1;
  const steps = dxs.map((d, i) => { const bad = Math.sign(d) !== sgn || Math.abs(d) > Math.abs(med) * 4 || peaks[i] < 3; return bad ? med : d; });
  steps.push(med);
  const total = steps.reduce((a, b) => a + b, 0);
  q.peak = Math.round(median(peaks) * 10) / 10; q.badSteps = dxs.filter((d, i) => Math.sign(d) !== sgn || Math.abs(d) > Math.abs(med) * 4 || peaks[i] < 3).length;
  const heading = [0]; for (let i = 1; i < NF; i++) heading.push(heading[i - 1] + steps[i - 1] / Math.abs(total) * 2 * Math.PI);
  if (!F.photos && q.badSteps > NF * .2) cons.push({ k: 'irregulier' });
  const f0 = fpx;
  // Visée : on suppose que la voiture est gardée au milieu de l'écran (conseil affiché avant de filmer). Le centre de
  // la silhouette est faussé par la perspective et par les bords du cadre : sur la vidéo de test, s'y fier sculpte moins bien.
  // La visée réelle de chaque image est ensuite retrouvée par le recalage sur la silhouette, pour la peinture.
  const xc = new Array(NF).fill(0);
  const yc = stats.map(s => s.cy - SH / 2);
  const theta = heading.map((h, i) => h - Math.atan(xc[i] / f0));
  // Distance : hauteur de la silhouette (images coupées en haut ou en bas : valeur des voisines)
  let dist = stats.map((s, i) => ok[i] && !s.cutT && !s.cutB ? f0 * CAR_H / s.h : null);
  const fill = a => a.map((v, i) => { if (v != null) return v; for (let k = 1; k < NF; k++) { const b = a[(i + k) % NF], c = a[(i - k + NF) % NF]; if (b != null) return b; if (c != null) return c; } return 4; });
  dist = fill(dist); dist = dist.map((_, i) => median([dist[(i - 1 + NF) % NF], dist[i], dist[(i + 1) % NF]]));
  let vis = []; for (let i = 0; i < NF; i++) if (ok[i]) vis.push(i);
  const yawOf = i => Math.atan(xc[i] / f0), pitOf = i => Math.atan(yc[i] / f0);       // voiture vue à droite → caméra tournée à gauche
  const mk = off => vis.map(i => makeCam(theta[i], dist[i] + off(i), yawOf(i), pitOf(i)));
  let dm = vis.map(i => dilate(masks[i], SW, SH, 2));
  // 1er passage : distance au centre ≈ distance au plus près + 1 m
  const sculpt = async (cams) => {
    const R = clamp(Math.min(...cams.map(c => Math.hypot(c.C[0], c.C[2]))) * .8, 1.8, 3.2), box = { R, Y: 2.4 };
    const cn = GRID / 2, co = carve(cams, dm, SW, SH, fpx, box, cn, null); await tick();
    const near = (x, y, z) => { const X = x >> 1, Y = y >> 1, Z = z >> 1; for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const a = X + dx, b = Y + dy, c = Z + dz; if (a >= 0 && b >= 0 && c >= 0 && a < cn && b < cn && c < cn && co[(c * cn + b) * cn + a]) return true; } return false; };
    const occ = largestComponent(carve(cams, dm, SW, SH, fpx, box, GRID, near), GRID);
    return { occ, box, shape: shapeOf(occ, GRID, box) };
  };
  progress('carve', 0);
  let S1 = await sculpt(mk(() => 1));
  if (!S1.shape || S1.shape.voxels < 200) { const e = new Error('forme'); e.quality = q; throw e; }
  // Un seul passage : distance au centre ≈ distance tirée de la hauteur de la silhouette + 1 m. Des passages qui
  // corrigent la distance d'après la forme trouvée la font grossir d'un passage à l'autre (essayé sur la vidéo de test).
  let S = S1; const passes = [S1.shape];
  let poses = vis.map(i => ({ theta: theta[i], d: dist[i] + 1, yaw: yawOf(i), pitch: pitOf(i), th: TARGET_H, h: CAM_H, roll: 0 }));
  if (opts.truePoses) {
    const tp = opts.truePoses(F.times); poses = vis.map(i => ({ theta: tp[i].theta, d: tp[i].d, yaw: tp[i].yaw ?? yawOf(i), pitch: tp[i].pitch ?? pitOf(i), th: tp[i].th ?? TARGET_H, h: tp[i].h ?? CAM_H, roll: tp[i].roll ?? 0 }));
    const Sn = await sculpt(poses.map(camOf)); if (Sn.shape) { S = Sn; passes.push(Sn.shape); }
  }
  // Calage des caméras par les points de détail (v0.20) : position complète du téléphone pour chaque image. Gardé si la
  // forme sculptée avec ces caméras colle au moins aussi bien aux silhouettes qu'avec l'estimation par le décor.
  let calee = false;
  if (!opts.truePoses && opts.sfm !== false && F.grays) {
    progress('carve', .05);
    let sf = null; try { sf = await sfmCameras(F, vis, poses, fpx * F.GW / SW, k => progress('carve', .05 + .7 * k)); } catch (e) { sf = { info: { refus: String(e && e.message || e).slice(0, 80) } }; }
    q.calage = sf && sf.info;
    if (sf && sf.poses) { const keep = sf.weak.map(w => !w), dm2 = dm.filter((_, j) => keep[j]), P2 = sf.poses.filter((_, j) => keep[j]), dmAll = dm;
      dm = dm2; const S2 = await sculpt(P2.map(camOf)); dm = dmAll;
      if (S2.shape && S2.shape.voxels >= 200) {
        const img = new Uint8Array(SW * SH), acc = (S_, P_, D_) => { const pts = surfacePoints(S_.occ, GRID, S_.box, 4000); let t = 0; P_.forEach((p, j) => { t += silScore(camOf(p), D_[j], pts, SW, SH, fpx, img); }); return t / P_.length; };
        const a = acc(S, poses, dm), b = acc(S2, P2, dm2); q.calage.silhouettes = [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000];
        if (b >= a - .02) { poses = P2; S = S2; passes.push(S2.shape); calee = true; vis = vis.filter((_, j) => keep[j]); dm = dm2; }
        else q.calage.refus = 'silhouettes moins bien'; } }
  }
  q.calage = Object.assign(q.calage || {}, { garde: calee });
  if (!calee && !opts.truePoses && opts.sfm !== false && F.grays) cons.push({ k: F.photos ? 'photos' : 'calage' });
  progress('carve', .9);
  const camsTex = poses.map(camOf);
  vis.forEach((i, j) => { theta[i] = poses[j].theta; });
  const finalPoses = poses, D1 = 180 / Math.PI;
  q.camera = { visee: Math.round(median(poses.map(p => Math.abs(p.yaw))) * D1), roulis: Math.round(median(poses.map(p => Math.abs(p.roll))) * D1 * 10) / 10,
    hauteur: Math.round(median(poses.map(p => p.h)) * 100) / 100 };
  q.passes = passes.map(p => [p.L, p.W, p.H].map(v => Math.round(v * 100) / 100));
  // Forme fine (cubes de 2,5 cm) dans le repère de la voiture, avec les caméras calées ; tolérance plus serrée une fois
  // les caméras calées (une partie est retirée dès que 3 % des images la voient hors de la voiture), puis symétrie
  progress('carve', .93); await tick();
  const tolFine = opts.tolFix != null ? opts.tolFix : calee ? Math.max(1, Math.round(camsTex.length * (opts.tolFine ?? .03))) : undefined;
  const tolToit = opts.toitTol === false || tolFine == null ? null : Math.max(tolFine + 2, Math.round(camsTex.length * (typeof opts.toitTol === 'number' ? opts.toitTol : .08)));
  const fine = carveAligned(camsTex, dm, SW, SH, fpx, S, S.shape, tolFine, tolToit);
  const { nx, ny, nz } = fine, fo = largestComp3(fine.occ, nx, ny, nz);
  const topCols = occ => { const t = new Int16Array(nx * nz).fill(-1);   // plus haut cube plein de chaque colonne (i, k)
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) for (let j = ny - 1; j >= 0; j--) if (occ[(k * ny + j) * nx + i]) { t[k * nx + i] = j; break; }
    return t; };
  const top0 = topCols(fo), topT = fine.occ2 ? topCols(largestComp3(fine.occ2, nx, ny, nz)) : null;
  q.fine = { roofCut: flattenRoof(fo, nx, ny, nz) };
  const ff = new Float32Array(fo.length); let fv = 0; for (let i = 0; i < ff.length; i++) { ff[i] = fo[i]; fv += fo[i]; }
  if (fv < 5000) { const e = new Error('forme'); e.quality = q; throw e; }
  blur3a(ff, nx, ny, nz); blur3a(ff, nx, ny, nz); blur3a(ff, nx, ny, nz);
  // Lissage (v0.21) : surtout dans la longueur (les bosses de la sculpture), un peu en travers (les arêtes restent nettes)
  const LS = Object.assign({}, LISSE, opts.lissage); for (let k = 0; k < LS.x; k++) blur1(ff, nx, ny, nz, 0); for (let k = 0; k < LS.yz; k++) { blur1(ff, nx, ny, nz, 1); blur1(ff, nx, ny, nz, 2); }
  const sym = symmetrize(ff, nx, ny, nz), f8 = new Uint8Array(ff.length);
  if (opts.tendu !== false) q.fine.tendu = tautSides(sym.g, nx, ny, nz, sym.mid, Math.round(.25 / CELL));
  let i0 = nx, i1 = -1, j1 = -1, k0 = nz, k1 = -1;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const v = sym.g[(k * ny + j) * nx + i]; f8[(k * ny + j) * nx + i] = Math.round(clamp(v, 0, 1) * 255);
    if (v >= .5) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j > j1) j1 = j; if (k < k0) k0 = k; if (k > k1) k1 = k; } }
  const disp = { nx, ny, nz, cell: CELL, a0: fine.a0, b0: fine.b0, field: f8,
    ac: fine.a0 + ((i0 + i1) / 2 + .5) * CELL, bc: fine.b0 + (sym.mid + .5) * CELL };
  if (topT) { const r = roofLift(top0, topT, nx, nz, sym.mid); if (r) { disp.lift = r.lift; q.fine.toitReleve = r.info; } }
  const dims = { L: (i1 - i0 + 1) * CELL, W: (k1 - k0 + 1) * CELL, H: (j1 + 1) * CELL };
  // Roues : contacts au sol vus de profil (sinon bas de la forme), rayon d'après la hauteur ; passages de roue creusés
  // (le pneu et la jante sont ajoutés ensuite)
  let wd = detectWheels(disp, { i0, i1, k0, k1 });
  const ws = wheelsFromSides(vis, camsTex, masks, SW, SH, fpx, { alpha: S.shape.alpha, cx: S.shape.cx, cz: S.shape.cz }, disp.ac, dims);
  if (wd || ws) { const L0 = dims.L, rP = clamp(.22 * dims.H, .28, .4);
    const fa = ws ? ws.front : wd.wheels[0].xa, ra = ws ? ws.rear : wd.wheels[1].xa, wbr = (fa - ra) / L0;
    if (wbr > .45 && wbr < .75) {
      const zo = xa => { const i = clamp(Math.round((xa - disp.a0) / CELL - .5), 0, nx - 1), j = Math.min(ny - 1, Math.round(rP / CELL - .5)); let km = -1;
        for (let k = nz - 1; k >= 0; k--) if (disp.field[(k * ny + j) * nx + i] >= 128) { km = k; break; }
        return km < 0 ? dims.W / 2 - .06 : (disp.b0 + (km + .5) * CELL) - disp.bc - .025; };
      wd = { wheels: [{ xa: fa, r: rP, zo: zo(fa) }, { xa: ra, r: rP, zo: zo(ra) }], sill: ws && ws.sill != null ? clamp(ws.sill, 0, .45) : wd ? wd.sill : 0, source: ws ? 'vues de côté (' + ws.nF + ' + ' + ws.nR + ' contacts)' : 'forme' };
    } else wd = null; }
  // Dessous (v0.21) : jamais vu par le téléphone (plus haut que lui), la forme sculptée y descend jusqu'au sol. Elle est
  // coupée à plat à la hauteur du bas de caisse, entre les roues comme aux bouts (les pneus sont ajoutés ensuite).
  if (wd && opts.sous !== false && wd.sill >= .08) { const F8 = disp.field; let cutS = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) { const t = clamp(((j + .5) * CELL - wd.sill) / CELL + .5, 0, 1); if (t >= 1) continue;
      for (let i = 0; i < nx; i++) { const q = (k * ny + j) * nx + i; const v = Math.round(F8[q] * t); if (F8[q] >= 128 && v < 128) cutS++; F8[q] = v; } }
    q.fine.sousCut = cutS; }
  let beltLine = null, coupes = null;
  if (opts.maquette !== false) { const mqr = maquetteField(disp, wd ? wd.sill : 0); if (mqr) { beltLine = mqr.belt; coupes = mqr.coupes; delete mqr.belt; delete mqr.coupes; } q.fine.maquette = mqr; }
  if (wd) { carveWells(disp, wd.wheels); q.roues = { rayonsCm: wd.wheels.map(w => Math.round(w.r * 100)), empattementCm: Math.round((wd.wheels[0].xa - wd.wheels[1].xa) * 100), basDeCaisseCm: Math.round(wd.sill * 100), source: wd.source }; }
  else q.roues = 'non trouvées';
  Object.assign(q.fine, { voxels: fv, grid: [nx, ny, nz], symPlaneCm: Math.round((disp.bc - (fine.b0 + nz * CELL / 2)) * 100) });
  progress('carve', 1);
  // 36 vues régulières autour de la voiture pour la vue 360° (et la peinture de secours)
  progress('paint', 0);
  const ang = vis.map(i => theta[i]), picks = [];
  for (let k = 0; k < N_TEX; k++) { const t = ang[0] + Math.sign(total) * k * 2 * Math.PI / N_TEX; let bi = 0, bd = 1e9;
    vis.forEach((i, j) => { const d = Math.abs(Math.atan2(Math.sin(ang[j] - t), Math.cos(ang[j] - t))); if (d < bd) { bd = d; bi = j; } }); picks.push(bi); }
  const sh2 = S.shape, align = { alpha: sh2.alpha, cx: sh2.cx, cz: sh2.cz }, sel = vis.filter((_, j) => j % 2 === 0);
  const paint = paintColor(masks, F.smalls, sel, SW, SH) || [.6, .6, .6], roof = roofColor(masks, F.smalls, sel, SW, SH) || paint;
  const spin = await spinOf(F, picks.map(j => vis[j]));
  q.loopDeg = 360; q.views = vis.length;
  const common = { date: new Date().toISOString(), align, dims, paint, roof, quality: q, spinFrames: spin.frames, spinSize: spin.size,
    debug: opts.debug ? { poses: finalPoses, heading, ctimes: F.times, top: (() => { const n = GRID, t = new Array(n * n).fill(0); for (let i = 0; i < S.occ.length; i++) if (S.occ[i]) { const x = i % n, z = (i / (n * n)) | 0; t[z * n + x] = 1; } return t; })(), side: (() => { const n = GRID, t = new Array(n * n).fill(0); for (let i = 0; i < S.occ.length; i++) if (S.occ[i]) { const x = i % n, y = ((i / n) | 0) % n; t[(n - 1 - y) * n + x] = 1; } return t; })(), times: F.times, theta, dist, stats, ok, steps, dxs, peaks, vis, masks: (opts.debugAll ? masks.map((_, i) => i) : [0, 9, 18, 27].filter(i => i < masks.length)).map(i => Array.from(masks[i])), SW, SH } : undefined };
  // v0.19 : maillage calculé une fois, texture « cuite » sur la carte graphique (toutes les images, visibilité, exposition)
  if (!opts.noBake) try {
    const THREE = await import('three'), MC = await import('three/addons/objects/MarchingCubes.js');
    let m0 = null;   // v0.24 : carrosserie lisse construite coupe par coupe (sinon, ou si elle échoue : forme sculptée en cubes)
    if (coupes && opts.lisse !== false) try { m0 = maquetteMesh(disp, coupes, wd ? wd.wheels : [], align); if (m0) q.fine.lisse = { coupes: m0.coupes, arches: m0.arches }; } catch (e) { q.fine.lisse = 'repli : ' + (e && e.message || e); m0 = null; }
    if (!m0) m0 = meshFromField(disp, align, MC, beltLine ? MQ.taubin : LS.taubin, beltLine ? MQ.normales : LS.normales);
    const m1 = wd ? addRims(m0, wd.wheels, disp, align) : m0, mirs = coupes && m0.parts && opts.retros !== false ? mirrorsFrom(disp, coupes) : null;
    const m = mirs ? addMirrors(m1, mirs, disp, align) : m1, mm = uvCharts(m, 2048);
    q.retros = mirs ? { piedPareBriseCm: Math.round(mirs[0].dF * 100), miPareBriseCm: Math.round(mirs[0].dM * 100), dépasseCm: Math.round((mirs[0].zOut - mirs[0].zIn - .06) * 100), hauteurCm: Math.round(mirs[0].y * 100) } : 'non placés';
    if (m.wheels) { const xs = m.wheels.map(w => w.x); dims.wf = Math.max(...xs); dims.wr = Math.min(...xs); }
    // Pas de correction d'exposition : avec 72 images voisines, les écarts se fondent d'eux-mêmes (une correction essayée
    // confondait les reflets avec l'exposition sur la vidéo de test)
    const views = vis.map((i, j) => ({ img: F.bigs[i], mask: erode1(masks[i], SW, SH), cam: camsTex[j], gain: 1 }));
    const lin = c => Math.pow(c, 2.2), lumRef = .3 * lin(paint[0]) + .59 * lin(paint[1]) + .11 * lin(paint[2]);
    const tb = performance.now();
    const bk = await bakeTexture(THREE, mm, views, { size: 2048, SW, SH, fN: [fpx / SW, fpx / SH], paint, roof, H: dims.H, lumRef, wheels: m.wheels, soft: opts.soft, net: opts.net, progress: k => progress('paint', k) });
    const tex = bk.blob; mm.glass = bk.glass;
    if (beltLine && mm.glass) { const fl = m0.flip, P = mm.pos;   // bas des vitres = ligne de ceinture mesurée ; pas de vitre sur le capot ni le coffre
      for (let v = 0; v < mm.glass.length; v++) { const a = P[v * 3] * fl + disp.ac, yb = beltLine[0] * a + beltLine[1], y = P[v * 3 + 1], si = clamp(Math.floor((a - disp.a0) / CELL), 0, nx - 1);
        if (y < yb + .005 || beltLine[2][si] < .08) mm.glass[v] = 0; else if (y < yb + .03) mm.glass[v] = Math.round(mm.glass[v] * (y - yb - .005) / .025); } }
    if (m0.parts && mm.glass) glassBySections(mm, m0.parts);
    q.bake = { views: views.length, texelsParMetre: Math.round(mm.texPerM), sommets: mm.pos.length / 3, triangles: mm.idx.length / 3, ms: Math.round(performance.now() - tb),
      textureKo: Math.round(tex.size / 1024), vitresPct: bk.glassShare };
    progress('paint', 1);
    return { v: 3, ...common, mesh: packMesh(mm), tex, wheels: m.wheels || null, front: { flipped: m.flip < 0, roofCm: Math.round(m.roofA * 100) } };
  } catch (e) { q.bake = 'repli : ' + (e && e.message || e); }
  // Repli (sans WebGL 2) : 36 vues rangées dans une planche, peintes à l'affichage
  const CW = 640, CH = Math.round(CW * SH / SW), MW = SW, MH = SH, cols = 6, rows = 6;
  const atlas = document.createElement('canvas'); atlas.width = CW * cols; atlas.height = CH * rows; const ga = atlas.getContext('2d');
  const matl = document.createElement('canvas'); matl.width = MW * cols; matl.height = MH * rows; const gm = matl.getContext('2d');
  const mc = document.createElement('canvas'); mc.width = SW; mc.height = SH; const gmc = mc.getContext('2d'), mid = gmc.createImageData(SW, SH);
  const views = new Float32Array(N_TEX * 12); let cr = 0, cg = 0, cb = 0, cn = 0;
  for (let k = 0; k < N_TEX; k++) {
    const j = picks[k], i = vis[j], cam = camsTex[j], col = k % cols, row = (k / cols) | 0;
    const bmp = await createImageBitmap(F.bigs[i]); ga.drawImage(bmp, col * CW, row * CH, CW, CH); if (bmp.close) bmp.close();
    const m = erode1(masks[i], SW, SH); for (let p = 0; p < SW * SH; p++) { const v = m[p] ? 255 : 0; mid.data[p * 4] = mid.data[p * 4 + 1] = mid.data[p * 4 + 2] = v; mid.data[p * 4 + 3] = 255;
      if (masks[i][p] && (p & 7) === 0) { const s = F.smalls[i].data; cr += s[p * 4]; cg += s[p * 4 + 1]; cb += s[p * 4 + 2]; cn++; } }
    gmc.putImageData(mid, 0, 0); gm.drawImage(mc, col * MW, row * MH, MW, MH);
    views.set([...cam.C, ...cam.r, ...cam.u, ...cam.f], k * 12);
    progress('paint', (k + 1) / N_TEX); if (k % 6 === 5) await tick();
  }
  const [atlasBlob, maskBlob] = await Promise.all([toJpeg(atlas, .86), new Promise(r => matl.toBlob(r, 'image/png'))]);
  return { v: 2, ...common, disp, views, fN: [fpx / SW, fpx / SH], atlas: atlasBlob, maskAtlas: maskBlob, grid: [cols, rows],
    base: cn ? [cr / cn / 255, cg / cn / 255, cb / cn / 255] : [.6, .6, .6] };
}

/* ---------- Affichage : maillage lisse + peinture par projection des images + lumière de studio ---------- */
// Marching cubes avec sommets partagés (un sommet par arête de la grille), sur une grille nx × ny × nz.
// Mêmes conventions que l'addon MarchingCubes de three.js (tables edgeTable / triTable) : densité, intérieur ≥ iso.
function marching(F, nx, ny, nz, iso, edgeTable, triTable) {
  const NXY = nx * ny, N = NXY * nz, E = [new Int32Array(N).fill(-1), new Int32Array(N).fill(-1), new Int32Array(N).fill(-1)];
  let P = new Float32Array(65536 * 3), np = 0, I = new Uint32Array(65536 * 6), ni = 0;
  const ev = new Int32Array(12);
  const vert = (ax, q, x, y, z, f0, f1) => { const e = E[ax]; let v = e[q]; if (v >= 0) return v;
    if (np * 3 + 3 > P.length) { const b = new Float32Array(P.length * 2); b.set(P); P = b; }
    const t = (iso - f0) / (f1 - f0); P[np * 3] = ax === 0 ? x + t : x; P[np * 3 + 1] = ax === 1 ? y + t : y; P[np * 3 + 2] = ax === 2 ? z + t : z;
    e[q] = np; return np++; };
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    const q = x + y * nx + z * NXY;
    const f0 = F[q], f1 = F[q + 1], f2 = F[q + nx], f3 = F[q + 1 + nx], f4 = F[q + NXY], f5 = F[q + 1 + NXY], f6 = F[q + nx + NXY], f7 = F[q + 1 + nx + NXY];
    let ci = 0; if (f0 < iso) ci |= 1; if (f1 < iso) ci |= 2; if (f2 < iso) ci |= 8; if (f3 < iso) ci |= 4;
    if (f4 < iso) ci |= 16; if (f5 < iso) ci |= 32; if (f6 < iso) ci |= 128; if (f7 < iso) ci |= 64;
    const bits = edgeTable[ci]; if (!bits) continue;
    if (bits & 1) ev[0] = vert(0, q, x, y, z, f0, f1);
    if (bits & 2) ev[1] = vert(1, q + 1, x + 1, y, z, f1, f3);
    if (bits & 4) ev[2] = vert(0, q + nx, x, y + 1, z, f2, f3);
    if (bits & 8) ev[3] = vert(1, q, x, y, z, f0, f2);
    if (bits & 16) ev[4] = vert(0, q + NXY, x, y, z + 1, f4, f5);
    if (bits & 32) ev[5] = vert(1, q + 1 + NXY, x + 1, y, z + 1, f5, f7);
    if (bits & 64) ev[6] = vert(0, q + nx + NXY, x, y + 1, z + 1, f6, f7);
    if (bits & 128) ev[7] = vert(1, q + NXY, x, y, z + 1, f4, f6);
    if (bits & 256) ev[8] = vert(2, q, x, y, z, f0, f4);
    if (bits & 512) ev[9] = vert(2, q + 1, x + 1, y, z, f1, f5);
    if (bits & 1024) ev[10] = vert(2, q + 1 + nx, x + 1, y + 1, z, f3, f7);
    if (bits & 2048) ev[11] = vert(2, q + nx, x, y + 1, z, f2, f6);
    const o = ci << 4;
    for (let i = 0; triTable[o + i] !== -1; i += 3) {
      if (ni + 3 > I.length) { const b = new Uint32Array(I.length * 2); b.set(I); I = b; }
      I[ni++] = ev[triTable[o + i]]; I[ni++] = ev[triTable[o + i + 1]]; I[ni++] = ev[triTable[o + i + 2]]; }
  }
  return { P: P.slice(0, np * 3), I: I.slice(0, ni) };
}
// Lissage de Taubin (lisse sans faire maigrir la forme)
function smoothMesh(P, I, iters) {
  const nV = P.length / 3, S = new Float32Array(nV * 3), C = new Float32Array(nV);
  const add = (u, v, w) => { S[u * 3] += P[v * 3] + P[w * 3]; S[u * 3 + 1] += P[v * 3 + 1] + P[w * 3 + 1]; S[u * 3 + 2] += P[v * 3 + 2] + P[w * 3 + 2]; C[u] += 2; };
  const pass = lam => { S.fill(0); C.fill(0);
    for (let t = 0; t < I.length; t += 3) { const a = I[t], b = I[t + 1], c = I[t + 2]; add(a, b, c); add(b, c, a); add(c, a, b); }
    for (let v = 0; v < nV; v++) if (C[v]) for (let k = 0; k < 3; k++) P[v * 3 + k] += lam * (S[v * 3 + k] / C[v] - P[v * 3 + k]); };
  for (let i = 0; i < iters; i++) { pass(.5); pass(-.53); }
}

// Normales moyennées avec les voisines : la lumière glisse sans marches sur les grandes surfaces (toit, capot)
function smoothNormals(Nr, I, iters) {
  const nV = Nr.length / 3, S = new Float32Array(nV * 3);
  for (let it = 0; it < iters; it++) { S.set(Nr);
    for (let t = 0; t < I.length; t += 3) { const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      for (let k = 0; k < 3; k++) { S[a + k] += Nr[b + k] + Nr[c + k]; S[b + k] += Nr[a + k] + Nr[c + k]; S[c + k] += Nr[a + k] + Nr[b + k]; } }
    for (let v = 0; v < nV; v++) { const x = S[v * 3], y = S[v * 3 + 1], z = S[v * 3 + 2], l = Math.hypot(x, y, z) || 1; Nr[v * 3] = x / l; Nr[v * 3 + 1] = y / l; Nr[v * 3 + 2] = z / l; } }
}
const VS = `attribute vec3 aOrig;attribute vec3 aOrigN;varying vec3 vO;varying vec3 vN;varying vec3 vWP;varying vec3 vWN;varying float vY;
void main(){vO=aOrig;vN=aOrigN;vY=position.y;vec4 wp=modelMatrix*vec4(position,1.0);vWP=wp.xyz;vWN=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*viewMatrix*wp;}`;
// Couleur vue sur les images (les vues les plus en face pèsent le plus) ; ce qu'aucune image ne voit (toit, capot, dessous)
// prend la couleur de la peinture estimée. Par-dessus : vernis (reflets d'un studio : boîte à lumière, horizon, lumière principale).
const FS = (n) => `uniform sampler2D uTex;uniform sampler2D uMask;uniform vec3 uC[${n}];uniform vec3 uR[${n}];uniform vec3 uU[${n}];uniform vec3 uF[${n}];
uniform vec2 uFN;uniform float uOpacity;uniform vec3 uPaint;uniform vec3 uRoof;uniform float uH;uniform float uGloss;uniform float uReveal;uniform float uScan;varying vec3 vO;varying vec3 vN;varying vec3 vWP;varying vec3 vWN;varying float vY;
void main(){
  if(vY>uReveal)discard;
  if(uScan>0.001&&!gl_FrontFacing){float sl=0.75+0.25*step(0.5,fract(gl_FragCoord.y*0.2));gl_FragColor=vec4((vec3(0.03,0.12,0.21)+vec3(0.16,0.42,0.58)*0.45*uScan)*sl,uOpacity); // coupe du scanner : tranche lumineuse
    #include <colorspace_fragment>
    return;}
  vec3 n=normalize(vN);vec3 acc=vec3(0.0);float ws=0.0;float wmax=0.0;
  for(int i=0;i<${n};i++){
    vec3 q=vO-uC[i];float zc=dot(q,uF[i]);if(zc<0.2)continue;
    float w=dot(n,normalize(uC[i]-vO));if(w<0.12)continue;
    vec2 uv=vec2(0.5+uFN.x*dot(q,uR[i])/zc,0.5+uFN.y*dot(q,uU[i])/zc);
    if(uv.x<0.0||uv.y<0.0||uv.x>1.0||uv.y>1.0)continue;
    float col=mod(float(i),6.0),row=floor(float(i)/6.0);
    vec2 a=vec2((col+uv.x)/6.0,(5.0-row+uv.y)/6.0);
    float mk=texture2D(uMask,a).r;vec3 tc=texture2D(uTex,a).rgb;
    float wt=exp(48.0*(w-1.0))*mix(0.0005,1.0,smoothstep(0.35,0.65,mk))/(0.12+dot(tc,vec3(0.3,0.59,0.11)));
    acc+=tc*wt;ws+=wt;wmax=max(wmax,w*step(0.5,mk));
  }
  vec3 seen=ws>1e-30?acc/ws:uPaint;
  float conf=smoothstep(0.14,0.34,wmax);
  vec3 N=normalize(vWN);vec3 V=normalize(cameraPosition-vWP);if(dot(N,V)<0.0)N=-N;
  vec3 L=normalize(vec3(0.55,0.75,0.35));float nl=dot(N,L);
  vec3 R=reflect(-V,N);float ndv=clamp(dot(N,V),0.0,1.0);float fres=0.04+0.96*pow(1.0-ndv,5.0);
  vec3 env=mix(vec3(0.015,0.015,0.03),vec3(0.30,0.32,0.42),smoothstep(0.0,0.7,R.y))+vec3(1.5)*smoothstep(0.82,0.95,R.y);
  float sp=pow(max(dot(R,L),0.0),90.0);
  vec3 prior=mix(uPaint,uRoof,smoothstep(0.70*uH,0.86*uH,vY));vec3 painted=prior*(0.30+0.70*(0.5+0.5*nl));
  vec3 base=mix(painted,seen*(0.92+0.16*max(nl,0.0)),conf);
  vec3 c=base*(1.0-fres*uGloss*0.5)+(env*fres+vec3(sp*0.55))*uGloss;
  float band=exp(-abs(uReveal-vY)*28.0)*uScan;c=mix(c,c*0.55+vec3(0.10,0.22,0.30),uScan*0.35)+vec3(0.45,0.92,1.0)*band*2.4; // ligne du scanner
  gl_FragColor=vec4(c,uOpacity);
  #include <colorspace_fragment>
}`;

function vertexNormals(P, I) { // normales des sommets, pondérées par l'aire des triangles
  const N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) { const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    N[a] += nx; N[a + 1] += ny; N[a + 2] += nz; N[b] += nx; N[b + 1] += ny; N[b + 2] += nz; N[c] += nx; N[c + 1] += ny; N[c + 2] += nz; }
  for (let v = 0; v < N.length; v += 3) { const l = Math.hypot(N[v], N[v + 1], N[v + 2]) || 1; N[v] /= l; N[v + 1] /= l; N[v + 2] /= l; }
  return N;
}
// Sens de la voiture : le toit (le haut de l'habitacle) est presque toujours plus près de l'arrière que de l'avant
// (capot devant, coffre ou hayon derrière). L'avant est placé du côté des x positifs, comme les dessins de Vigie.
function frontOf(D) {
  const { nx, ny, nz, cell, a0, ac, field: F } = D; let jTop = 0;
  for (let q = 0; q < F.length; q++) if (F[q] >= 128) { const j = ((q / nx) | 0) % ny; if (j > jTop) jTop = j; }
  let sumA = 0, nA = 0; const jMin = Math.round(jTop * .82);
  for (let k = 0; k < nz; k++) for (let j = jMin; j < ny; j++) for (let i = 0; i < nx; i++) if (F[(k * ny + j) * nx + i] >= 128) { sumA += a0 + (i + .5) * cell; nA++; }
  const roofA = nA ? sumA / nA - ac : 0; return { roofA, flip: roofA > .02 ? -1 : 1 };
}
// Maillage de la forme : marching cubes, lissage, sens de la voiture (avant vers +x), triangles tournés vers l'extérieur.
// pos/nrm : repère d'affichage (centré, axe long sur x) ; orig/onrm : repère des caméras du scan.
function meshFromField(D, align, MC, taubin = 16, nSmooth = 24) {
  const { nx, ny, nz, cell, a0, b0, ac, bc } = D;
  const { P, I } = marching(D.field, nx, ny, nz, 127.5, MC.edgeTable, MC.triTable);
  smoothMesh(P, I, taubin);
  const nV = P.length / 3, { alpha, cx, cz } = align, ca = Math.cos(alpha), sa = Math.sin(alpha), { roofA, flip } = frontOf(D);
  const pos = new Float32Array(nV * 3), orig = new Float32Array(nV * 3);
  for (let v = 0; v < nV; v++) {
    const a = a0 + (P[v * 3] + .5) * cell, y = (P[v * 3 + 1] + .5) * cell, b = b0 + (P[v * 3 + 2] + .5) * cell;
    pos[v * 3] = (a - ac) * flip; pos[v * 3 + 1] = y; pos[v * 3 + 2] = (b - bc) * flip;
    orig[v * 3] = cx + a * ca - b * sa; orig[v * 3 + 1] = y; orig[v * 3 + 2] = cz + a * sa + b * ca;
  }
  let nr = vertexNormals(pos, I), out = 0;
  for (let v = 0; v < nV; v += 7) out += nr[v * 3] * pos[v * 3] + nr[v * 3 + 1] * (pos[v * 3 + 1] - .6) + nr[v * 3 + 2] * pos[v * 3 + 2];
  if (out < 0) { for (let t = 0; t < I.length; t += 3) { const x = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = x; } nr = vertexNormals(pos, I); }
  smoothNormals(nr, I, 3);
  const on = new Float32Array(nV * 3);
  for (let v = 0; v < nV; v++) { const na = nr[v * 3] * flip, nb = nr[v * 3 + 2] * flip; on[v * 3] = na * ca - nb * sa; on[v * 3 + 1] = nr[v * 3 + 1]; on[v * 3 + 2] = na * sa + nb * ca; }
  const rn = Float32Array.from(nr); smoothNormals(rn, I, nSmooth);   // normales d'affichage : reflets du vernis sans bosses
  return { pos, orig, nrm: rn, onrm: on, idx: I, flip, roofA };
}

/* ---------- Roues (v0.19) ---------- */
// Là où le bas de la forme touche le sol, sur le bord extérieur : les roues. Entre elles, le bas de caisse est plus haut.
// Le centre d'une roue est le point le plus bas ; son rayon vient de la largeur de l'arche à hauteur du bas de caisse.
function detectWheels(D, ext) {
  const { nx, ny, nz, cell, a0, b0, bc, field: F } = D, { i0, i1, k0, k1 } = ext;
  const kc = (k0 + k1) / 2, half = (k1 - k0 + 1) / 2, kA = Math.round(kc + .5 * half), h = new Float32Array(nx).fill(NaN);
  for (let i = i0; i <= i1; i++) { let lo = 1e9;
    for (let k = kA; k <= k1; k++) for (let j = 0; j < Math.min(ny, lo); j++) if (F[(k * ny + j) * nx + i] >= 128) { lo = j; break; }
    if (lo < 1e9) h[i] = (lo + .5) * cell; }
  const hs = Float32Array.from(h);
  for (let i = i0 + 2; i <= i1 - 2; i++) { const w = [h[i - 2], h[i - 1], h[i], h[i + 1], h[i + 2]].filter(v => !isNaN(v)); if (w.length) hs[i] = median(w); }
  const L = i1 - i0 + 1, mid = [];
  for (let i = Math.round(i0 + .38 * L); i <= Math.round(i1 - .38 * L); i++) if (!isNaN(hs[i])) mid.push(hs[i]);
  if (mid.length < 4) return null;
  const sill = median(mid);
  const low = (ia, ib) => { let bi = -1, bv = 1e9; for (let i = ia; i <= ib; i++) if (!isNaN(hs[i]) && hs[i] < bv) { bv = hs[i]; bi = i; } return bi < 0 ? null : { i: bi, h: bv }; };
  const fr = low(Math.round(i0 + .55 * L), Math.round(i1 - .04 * L)), rr = low(Math.round(i0 + .04 * L), Math.round(i1 - .55 * L));
  if (!fr || !rr || sill - fr.h < .07 || sill - rr.h < .07 || fr.h > .1 || rr.h > .1) return null;
  const wheel = w => { let ia = w.i, ib = w.i; const lim = sill - .02;
    while (ia > i0 && hs[ia - 1] < lim) ia--; while (ib < i1 && hs[ib + 1] < lim) ib++;
    const wh = (Math.min(w.i - ia, ib - w.i) + .5) * cell, r = clamp((wh * wh + sill * sill) / (2 * sill), .26, .4);
    const j = Math.min(ny - 1, Math.round(r / cell - .5)); let km = -1;
    for (let k = nz - 1; k >= 0; k--) if (F[(k * ny + j) * nx + w.i] >= 128) { km = k; break; }
    const zo = km < 0 ? half * cell - .06 : (b0 + (km + .5) * cell) - bc - .025;
    return { xa: a0 + (w.i + .5) * cell, r, zo }; };
  const F1 = wheel(fr), R1 = wheel(rr), wb = F1.xa - R1.xa;
  if (wb < .45 * L * cell || wb > .78 * L * cell) return null;
  return { wheels: [F1, R1], sill };
}
// Plus précis : vue de côté, le bas de la silhouette ne touche le sol qu'aux pneus (un creux en « U » par roue, même
// si la voiture dépasse du cadre). Chaque point le plus bas est ramené sur le sol (rayon de la caméra jusqu'à y = 0),
// donc à sa vraie place le long de la voiture ; médiane sur toutes les vues de côté.
function wheelsFromSides(vis, cams, masks, SW, SH, fpx, align, ac, dims) {
  const ca = Math.cos(align.alpha), sa = Math.sin(align.alpha), F = [], R = [], SL = [];
  for (let j = 0; j < vis.length; j++) { const c = cams[j];
    const dx = align.cx - c.C[0], dz = align.cz - c.C[2], da = dx * ca + dz * sa, db = -dx * sa + dz * ca, dd = Math.hypot(da, db);
    if (Math.abs(db) / dd < .77) continue;                                          // vues de côté (±40°)
    const m = masks[vis[j]], yb = new Float32Array(SW).fill(-1);
    for (let x = 0; x < SW; x++) for (let y = SH - 1; y >= 0; y--) if (m[y * SW + x]) { yb[x] = y; break; }
    const ys = Float32Array.from(yb);
    for (let x = 2; x < SW - 2; x++) if (yb[x - 2] >= 0 && yb[x + 2] >= 0) ys[x] = median([yb[x - 2], yb[x - 1], yb[x], yb[x + 1], yb[x + 2]]);
    const rp = Math.max(4, Math.round(fpx * .32 / Math.max(1.5, dd - dims.W / 4))), rise = Math.max(2, .25 * rp), cps = [];
    for (let x = 0; x < SW; x++) { const y0 = ys[x]; if (y0 < 0 || y0 >= SH - 2) continue;        // bas du pneu hors cadre
      let top = true; for (let k = Math.max(0, x - rp); k <= Math.min(SW - 1, x + rp) && top; k++) if (ys[k] > y0) top = false;
      if (!top) continue;
      const side = d => { for (let k = x + d * Math.round(rp * .5); Math.abs(k - x) <= 2 * rp; k += d) { if (k < 0 || k >= SW) return false;
        if (ys[k] < 0 || ys[k] <= y0 - rise) return true; } return false; };
      if (!side(-1) || !side(1)) continue;                                           // pas un creux de pneu
      let sx = 0, n = 0; for (let k = Math.max(0, x - rp); k <= Math.min(SW - 1, x + rp); k++) if (ys[k] >= y0 - 1.5) { sx += k; n++; }
      const px = sx / n, rx = (px + .5 - SW / 2) / fpx, uy = (SH / 2 - (y0 + .75)) / fpx;
      const dir = [0, 1, 2].map(k => c.f[k] + rx * c.r[k] + uy * c.u[k]);
      if (dir[1] < -1e-3) { const t = -c.C[1] / dir[1], gx = c.C[0] + t * dir[0] - align.cx, gz = c.C[2] + t * dir[2] - align.cz;
        const a = gx * ca + gz * sa, b = -gx * sa + gz * ca;
        if (Math.abs(b) < dims.W / 2 + .3 && Math.abs(a - ac) < dims.L / 2) { (a > ac ? F : R).push(a); cps.push(px); } }
      x += rp; }
    // Bas de caisse (v0.21) : entre les deux pneus, le bas de la silhouette est le bord inférieur du flanc proche ; son rayon
    // est arrêté sur le plan de ce flanc (demi-largeur), ce qui donne sa hauteur
    if (cps.length >= 2) { const p1 = Math.min(...cps), p2 = Math.max(...cps), bs = db > 0 ? -dims.W / 2 : dims.W / 2;
      if (p2 - p1 > 4 * rp) for (let x = Math.round(p1 + .3 * (p2 - p1)); x <= p1 + .7 * (p2 - p1); x += 2) { if (ys[x] < 0) continue;
        const rx = (x + .5 - SW / 2) / fpx, uy = (SH / 2 - (ys[x] + 1)) / fpx, dir = [0, 1, 2].map(k => c.f[k] + rx * c.r[k] + uy * c.u[k]);
        const bC = -(c.C[0] - align.cx) * sa + (c.C[2] - align.cz) * ca, bD = -dir[0] * sa + dir[2] * ca; if (Math.abs(bD) < 1e-6) continue;
        const t = (bs - bC) / bD; if (t > 0) SL.push(c.C[1] + t * dir[1]); } } }
  if (F.length < 3 || R.length < 3) return null;
  return { front: median(F), rear: median(R), nF: F.length, nR: R.length, sill: SL.length >= 20 ? median(SL) : null, nSill: SL.length };
}
// Passages de roue : on creuse la forme autour de chaque roue (rayon + 3,5 cm), du flanc vers l'intérieur (27 cm)
function carveWells(D, wheels) {
  const { nx, ny, nz, cell, a0, b0, bc, field: F } = D, gap = .035, depth = .27;
  for (const w of wheels) { const R = w.r + gap, zin = w.zo - depth;
    const ia = Math.max(0, Math.floor((w.xa - R - a0) / cell) - 2), ib = Math.min(nx - 1, Math.ceil((w.xa + R - a0) / cell) + 2), jb = Math.min(ny - 1, Math.ceil((w.r + R) / cell) + 2);
    for (let k = 0; k < nz; k++) { const t = clamp((Math.abs(b0 + (k + .5) * cell - bc) - zin) / cell + .5, 0, 1); if (t <= 0) continue;
      for (let j = 0; j <= jb; j++) { const y = (j + .5) * cell;
        for (let i = ia; i <= ib; i++) { const d = Math.hypot(a0 + (i + .5) * cell - w.xa, y - w.r) - R, sOut = clamp(d / cell + .5, 0, 1), q = (k * ny + j) * nx + i;
          F[q] = Math.round(F[q] * (1 - t * (1 - sOut))); } } } }
}
// Place des rétroviseurs : la forme sculptée ne les garde pas (trop fins, retirés par la tolérance de la sculpture) et
// leur image tombait sur la portière et le montant. Le pied du pare-brise est repéré sur le profil du haut (voir plus
// bas) ; le rétroviseur y est posé (pied du montant), à hauteur
// de ceinture, et dépasse du flanc de 10 cm (taille courante, un peu plus grand sur une voiture haute).
function mirrorsFrom(D, C) {
  const { cell, a0 } = D, { flip } = frontOf(D), av = i => a0 + (i + .5) * cell, belt = a => C.ka * a + C.kb;
  const iF = flip > 0 ? C.i1 : C.i0, st = -flip, L = (C.i1 - C.i0 + 1) * cell, T = C.T, ok = i => i >= C.i0 && i <= C.i1 && !isNaN(T[i]);
  let roof = 0; for (let i = C.i0; i <= C.i1; i++) if (ok(i) && T[i] > roof) roof = T[i];
  // milieu du pare-brise : 1re tranche (depuis l'avant) à mi-hauteur entre la ceinture et le toit ; puis on redescend la
  // pente vers l'avant tant qu'elle reste celle d'un pare-brise (plus de 25 cm de montée par mètre) : là est son pied
  let mid = -1; for (let n = 0; n * cell < .7 * L; n++) { const i = iF + st * n; if (ok(i) && T[i] - belt(av(i)) > .5 * (roof - belt(av(i)))) { mid = i; break; } }
  if (mid < 0) return null;
  const sl = i => ok(i + 2) && ok(i - 2) ? Math.abs(T[i + 2] - T[i - 2]) / (4 * cell) : 0;
  let ws = mid; while (ok(ws - st) && sl(ws - st) > .25 && Math.abs(ws - iF) > 2) ws -= st;
  if (ws < 0) return null;
  const dF = Math.abs(av(ws) - av(iF)); if (dF < .3 || dF > .45 * L) return null;
  const k = clamp(Math.max(...Array.from(C.T).filter(v => !isNaN(v))) / 1.5, .85, 1.25), a = av(ws), i = clamp(Math.round((a - a0) / cell - .5), C.i0, C.i1);
  const w = C.WB[i], bl = belt(a); if (isNaN(w)) return null;
  const h = .13 * k, y = Math.min(bl + .08 * k, C.T[i] - h / 2 - .02);
  return [1, -1].map(side => ({ side, a, y, h, len: .17 * k, zIn: w - .06, zOut: w + .1 * k, dF, dM: Math.abs(av(mid) - av(iF)) }));
}
// Rétroviseurs (v0.26) : dessin simple et original (coque arrondie qui s'affine vers la portière), posé à la place
// trouvée par mirrorsFrom ; peint ensuite par la cuisson avec les images.
// Chaque face a sa propre carte de texture (14 + 6 × n° + face), sinon elle partagerait l'image de la portière.
function addMirrors(m, mirrors, D, align) {
  const { ac, bc } = D, flip = m.flip, ca = Math.cos(align.alpha), sa = Math.sin(align.alpha), NLA = 10, NLO = 24, E = .45;
  const sp = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
  const P = [], O = [], N = [], ON = [], I = [], fixed = []; let base = m.pos.length / 3; const nT0 = m.idx.length / 3, info = [];
  mirrors.forEach((mr, mi) => {
    const hz = (mr.zOut - mr.zIn) / 2, zc = (mr.zIn + mr.zOut) / 2, hx = mr.len / 2, hy = mr.h / 2, loc = [], c0 = base;
    for (let la = 0; la <= NLA; la++) { const ph = -Math.PI / 2 + la * Math.PI / NLA;
      for (let lo = 0; lo < NLO; lo++) { const th = lo * 2 * Math.PI / NLO;
        const ux = sp(Math.cos(ph), E) * sp(Math.cos(th), E), uy = sp(Math.sin(ph), E), uz = sp(Math.cos(ph), E) * sp(Math.sin(th), E);
        const k = .5 + .5 * (uz + 1) / 2;   // plus fin côté portière (pied), plein côté extérieur (coque)
        loc.push([mr.a + ux * hx * k, mr.y + uy * hy * k, mr.side * (zc + uz * hz)]); } }
    const nv = loc.length, acc = new Float64Array(nv * 3), at = (la, lo) => la * NLO + ((lo + NLO) % NLO), tris = [];
    for (let la = 0; la < NLA; la++) for (let lo = 0; lo < NLO; lo++) { const a = at(la, lo), b = at(la, lo + 1), c = at(la + 1, lo + 1), d = at(la + 1, lo);
      if (la > 0) tris.push([a, b, c]); if (la < NLA - 1) tris.push([a, c, d]); }
    const ctr = [mr.a, mr.y, mr.side * zc];
    for (const t of tris) { const [A, B, C] = t.map(i => loc[i]); const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const g = [(A[0] + B[0] + C[0]) / 3 - ctr[0], (A[1] + B[1] + C[1]) / 3 - ctr[1], (A[2] + B[2] + C[2]) / 3 - ctr[2]];
      if (nx * g[0] + ny * g[1] + nz * g[2] < 0) { const s = t[1]; t[1] = t[2]; t[2] = s; nx = -nx; ny = -ny; nz = -nz; }
      for (const i of t) { acc[i * 3] += nx; acc[i * 3 + 1] += ny; acc[i * 3 + 2] += nz; }
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz), f = az >= ax && az >= ay ? (nz > 0 ? 0 : 1) : ax >= ay ? (nx > 0 ? 2 : 3) : (ny > 0 ? 4 : 5);
      I.push(c0 + t[0], c0 + t[1], c0 + t[2]); fixed.push(14 + mi * 6 + f); }
    for (let i = 0; i < nv; i++) { const [a, y, z] = loc[i], b = bc + z, l = Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]) || 1, na = acc[i * 3] / l, ny = acc[i * 3 + 1] / l, nz = acc[i * 3 + 2] / l;
      P.push((a - ac) * flip, y, z * flip); O.push(align.cx + a * ca - b * sa, y, align.cz + a * sa + b * ca);
      N.push(na * flip, ny, nz * flip); ON.push(na * ca - nz * sa, ny, na * sa + nz * ca); }
    base += nv; info.push(mr);
  });
  const cat = (A, B) => { const r = new Float32Array(A.length + B.length); r.set(A); r.set(B, A.length); return r; };
  const idx = new Uint32Array(m.idx.length + I.length); idx.set(m.idx); idx.set(I, m.idx.length);
  const fx = new Uint8Array(nT0 + fixed.length).fill(255); if (m.fixed) fx.set(m.fixed); fx.set(fixed, nT0);
  return Object.assign({}, m, { pos: cat(m.pos, P), orig: cat(m.orig, O), nrm: cat(m.nrm, N), onrm: cat(m.onrm, ON), idx, fixed: fx });
}
// Disques de jante (en retrait de 3 cm dans le pneu) ajoutés au maillage : la texture y pose les vraies jantes, à la bonne profondeur
function addRims(m, wheels, D, align) {
  const { ac, bc } = D, flip = m.flip, ca = Math.cos(align.alpha), sa = Math.sin(align.alpha), RINGS = 6, SEG = 48;
  const P = [], O = [], N = [], ON = [], I = [], fixed = [], centers = {}, list = [];
  let base = m.pos.length / 3; const nT0 = m.idx.length / 3;
  wheels.forEach((w, wi) => [1, -1].forEach((side, si) => {
    const xd = (w.xa - ac) * flip, zd = side * (w.zo - .05), rr = .74 * w.r, ch = 6 + wi * 2 + si, b = side * (w.zo - .03) * flip + bc, a = w.xa;
    centers[ch] = [xd, w.r, side]; list.push({ x: xd, z: side * w.zo, r: w.r, s: side });   // jante 5 cm en retrait du flanc du pneu
    const vtx = (X, Y, Z) => { P.push(X, Y, Z); const aa = X * flip + ac, bb = Z * flip + bc; O.push(align.cx + aa * ca - bb * sa, Y, align.cz + aa * sa + bb * ca);
      N.push(0, 0, side); const nb = side * flip; ON.push(-nb * sa, 0, nb * ca); };
    const c0 = base; vtx(xd, w.r, zd); base++;
    for (let ri = 1; ri <= RINGS; ri++) for (let sg = 0; sg < SEG; sg++) { const an = sg / SEG * 2 * Math.PI, rad = rr * ri / RINGS; vtx(xd + Math.cos(an) * rad, w.r + Math.sin(an) * rad, zd); base++; }
    const at = (ri, sg) => c0 + 1 + (ri - 1) * SEG + ((sg + SEG) % SEG);
    const tri = (p, q, r) => { if (side > 0) I.push(p, q, r); else I.push(p, r, q); fixed.push(ch); };
    for (let sg = 0; sg < SEG; sg++) tri(c0, at(1, sg), at(1, sg + 1));
    for (let ri = 1; ri < RINGS; ri++) for (let sg = 0; sg < SEG; sg++) { tri(at(ri, sg), at(ri + 1, sg), at(ri + 1, sg + 1)); tri(at(ri, sg), at(ri + 1, sg + 1), at(ri, sg + 1)); }
  }));
  const cat = (A, B) => { const r = new Float32Array(A.length + B.length); r.set(A); r.set(B, A.length); return r; };
  const idx = new Uint32Array(m.idx.length + I.length); idx.set(m.idx); idx.set(I, m.idx.length);
  const fx = new Uint8Array(nT0 + fixed.length).fill(255); fx.set(fixed, nT0);
  return Object.assign({}, m, { pos: cat(m.pos, P), orig: cat(m.orig, O), nrm: cat(m.nrm, N), onrm: cat(m.onrm, ON), idx, fixed: fx, rimCenters: centers, wheels: list });
}

/* ---------- Texture « cuite » (v0.19) : une seule image nette pour toute la voiture ---------- */
// Découpage en 6 cartes (droite, gauche, avant, arrière, dessus, dessous) projetées à plat, rangées dans une texture carrée.
// Les sommets partagés par deux cartes sont dédoublés. Le dessous, jamais vu, reçoit peu de place.
function uvCharts(m, size) {
  const { pos, idx } = m, nT = idx.length / 3, nV = pos.length / 3, chart = new Uint8Array(nT);
  for (let t = 0; t < nT; t++) { const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    chart[t] = m.fixed && m.fixed[t] !== 255 ? m.fixed[t] : az >= ax && az >= ay ? (nz > 0 ? 0 : 1) : ax >= ay ? (nx > 0 ? 2 : 3) : (ny > 0 ? 4 : 5); }
  { // 3 passes : un triangle prend la carte la plus fréquente autour de lui si son orientation s'y prête
    const vt = new Int32Array(nV + 1); for (let i = 0; i < idx.length; i++) vt[idx[i] + 1]++; for (let v = 0; v < nV; v++) vt[v + 1] += vt[v];
    const tl = new Int32Array(idx.length), fill = vt.slice(0, nV); for (let i = 0; i < idx.length; i++) tl[fill[idx[i]]++] = (i / 3) | 0;
    const fn = new Float32Array(nT * 3);
    for (let t = 0; t < nT; t++) { const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1; fn[t * 3] = nx / l; fn[t * 3 + 1] = ny / l; fn[t * 3 + 2] = nz / l; }
    const axisOf = [[2, 1], [2, -1], [0, 1], [0, -1], [1, 1], [1, -1]], cnt = new Int32Array(16);
    for (let it = 0; it < 3; it++) { const next = chart.slice();
      for (let t = 0; t < nT; t++) { cnt.fill(0);
        for (let k = 0; k < 3; k++) { const v = idx[t * 3 + k]; for (let q = vt[v]; q < vt[v + 1]; q++) cnt[chart[tl[q]]]++; }
        if (chart[t] >= 6) continue;
        let best = chart[t]; for (let c = 0; c < 6; c++) if (cnt[c] > cnt[best]) best = c;
        if (best !== chart[t]) { const [ax, sg] = axisOf[best]; if (fn[t * 3 + ax] * sg > .35) next[t] = best; } }
      chart.set(next); }
  }
  const NC = 26, RC = m.rimCenters || {};
  const proj = (c, x, y, z) => c >= 14 ? proj((c - 14) % 6, x, y, z) : c >= 6 ? [(x - RC[c][0]) * RC[c][2], y - RC[c][1]] : c === 0 ? [x, y] : c === 1 ? [-x, y] : c === 2 ? [-z, y] : c === 3 ? [z, y] : c === 4 ? [x, -z] : [x, z];
  const SC = [1, 1, 1, 1, 1, .3, 1, 1, 1, 1, 1, 1, 1, 1, ...new Array(12).fill(1)], key = new Int32Array(nV * NC).fill(-1), src = [], uvm = [], ch = [];
  const nIdx = new Uint32Array(idx.length);
  for (let t = 0; t < nT; t++) { const c = chart[t];
    for (let k = 0; k < 3; k++) { const v = idx[t * 3 + k], kk = v * NC + c;
      if (key[kk] < 0) { key[kk] = src.length; src.push(v); const [u, w] = proj(c, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); uvm.push(u, w); ch.push(c); }
      nIdx[t * 3 + k] = key[kk]; } }
  const n2 = src.length, B = [];
  for (let c = 0; c < NC; c++) B.push([1e9, 1e9, -1e9, -1e9]);
  for (let i = 0; i < n2; i++) { const b = B[ch[i]], u = uvm[i * 2], w = uvm[i * 2 + 1]; if (u < b[0]) b[0] = u; if (w < b[1]) b[1] = w; if (u > b[2]) b[2] = u; if (w > b[3]) b[3] = w; }
  // Rangement en étagères ; on cherche la plus grande échelle (texels par mètre) qui tient dans la texture
  const pad = 8, order = [0, 1, 4, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, ...Array.from({ length: 12 }, (_, k) => 14 + k)].filter(c => B[c][2] > B[c][0]);
  const pack = s => { let x = 0, y = 0, rowH = 0; const off = [];
    for (const c of [...order].sort((p, q) => (B[q][3] - B[q][1]) * SC[q] - (B[p][3] - B[p][1]) * SC[p])) {
      const w = Math.ceil((B[c][2] - B[c][0]) * s * SC[c]) + 2 * pad, h = Math.ceil((B[c][3] - B[c][1]) * s * SC[c]) + 2 * pad;
      if (w > size) return null;
      if (x + w > size) { x = 0; y += rowH; rowH = 0; }
      if (y + h > size) return null;
      off[c] = [x, y]; x += w; rowH = Math.max(rowH, h); }
    return off; };
  let lo = 10, hi = 4000, best = null;
  for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2, o = pack(mid); if (o) { lo = mid; best = o; } else hi = mid; }
  const s = lo, uv = new Float32Array(n2 * 2);
  for (let i = 0; i < n2; i++) { const c = ch[i], o = best[c], k = s * SC[c];
    uv[i * 2] = ((uvm[i * 2] - B[c][0]) * k + o[0] + pad) / size; uv[i * 2 + 1] = ((uvm[i * 2 + 1] - B[c][1]) * k + o[1] + pad) / size; }
  const pick = (a, d) => { const r = new Float32Array(n2 * d); for (let i = 0; i < n2; i++) for (let j = 0; j < d; j++) r[i * d + j] = a[src[i] * d + j]; return r; };
  return { pos: pick(m.pos, 3), nrm: pick(m.nrm, 3), orig: pick(m.orig, 3), onrm: pick(m.onrm, 3), uv, idx: nIdx, texPerM: s,
    src: Uint32Array.from(src), rim: Uint8Array.from(ch, c => c >= 6 && c < 14 ? 1 : 0), mir: Uint8Array.from(ch, c => c >= 14 ? 1 : 0), idx0: idx, nV0: nV };
}
// Vitres repérées par sommet : rapport « vue la plus sombre / moyenne » lu dans la texture (3 × 3 texels), moyenné sur
// les copies d'un même sommet, lissé 6 fois sur les voisins, puis seuil doux. Jantes et moitié basse exclues.
function glassMask(mm, rp, size, H) {
  const n = mm.pos.length / 3, n0 = mm.nV0, src = mm.src, sum = new Float32Array(n0), cnt = new Float32Array(n0);
  for (let i = 0; i < n; i++) { if (mm.rim && mm.rim[i] || mm.mir && mm.mir[i]) continue;
    const x0 = Math.floor(mm.uv[i * 2] * size), y0 = Math.floor(mm.uv[i * 2 + 1] * size); let r = 0, d = 0, k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = x0 + dx, y = y0 + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const o = (y * size + x) * 4; if (rp[o + 3] < 128 || rp[o + 1] < 50) continue; r += rp[o] / 255; d += (rp[o + 2] / 255) ** 2 / 4; k++; }
    if (!k) continue; const v = src[i], hi = mm.pos[i * 3 + 1] > .45 * H ? 1 : 0; r /= k; d /= k;
    // reflets changeants (vue la plus sombre bien plus sombre que la moyenne) ET fond sombre (verre teinté, habitacle) :
    // une peinture brillante a aussi des reflets changeants, mais sa vue la plus sombre garde sa couleur
    sum[v] += hi * clamp((.55 - r) / .25, 0, 1) * clamp((.045 - d) / .025, 0, 1); cnt[v]++; }
  let f = new Float32Array(n0); for (let v = 0; v < n0; v++) f[v] = cnt[v] ? sum[v] / cnt[v] : 0;
  const I = mm.idx0;
  for (let it = 0; it < 6; it++) { const a = new Float32Array(n0), c = new Float32Array(n0);
    for (let t = 0; t < I.length; t += 3) { const s3 = f[I[t]] + f[I[t + 1]] + f[I[t + 2]]; for (let k = 0; k < 3; k++) { a[I[t + k]] += s3; c[I[t + k]] += 3; } }
    for (let v = 0; v < n0; v++) if (c[v]) f[v] = a[v] / c[v]; }
  const out = new Float32Array(n), u8 = new Uint8Array(n); let on = 0;
  for (let i = 0; i < n; i++) { const g = mm.rim && mm.rim[i] || mm.mir && mm.mir[i] ? 0 : clamp((f[src[i]] - .4) / .25, 0, 1); out[i] = g; u8[i] = Math.round(g * 255); if (g > .5) on++; }
  return { f: out, u8, share: Math.round(on / n * 100) };
}
const BAKE_VS = `attribute vec3 aOrig;attribute vec3 aOrigN;attribute float aSharp;attribute float aRefl;varying vec3 vO;varying vec3 vN;varying vec2 vUv;varying float vY;varying float vSharp;varying float vRefl;varying vec3 vP;
void main(){vO=aOrig;vN=aOrigN;vUv=uv;vY=position.y;vP=position;vSharp=aSharp;vRefl=aRefl;gl_Position=vec4(uv*2.0-1.0,0.0,1.0);}`;
const BAKE_TEST = `uniform sampler2D uMsk;uniform sampler2D uDep;uniform vec3 uC;uniform vec3 uR;uniform vec3 uU;uniform vec3 uF;uniform vec2 uFN;
varying vec3 vO;varying vec3 vN;varying vec2 vUv;varying float vY;varying float vSharp;varying float vRefl;
float seen(out vec2 im){vec3 n=normalize(vN);vec3 q=vO-uC;float zc=dot(q,uF);if(zc<0.3)return -1.0;
  float c=dot(n,normalize(-q));if(c<0.06)return -1.0;
  im=vec2(0.5+uFN.x*dot(q,uR)/zc,0.5+uFN.y*dot(q,uU)/zc);
  if(im.x<0.003||im.y<0.003||im.x>0.997||im.y>0.997)return -1.0;
  if(zc>texture2D(uDep,im).r+0.04)return -1.0;              // caché par une autre partie de la voiture
  if(texture2D(uMsk,im).r<0.5)return -1.0;                  // hors de la silhouette : décor
  return c;}`;
// Accentuation de la texture (v0.27) : la vidéo du téléphone donne environ 1 pixel par centimètre de voiture, moins que ce
// que l'écran montre de près ; un masque flou (couleur + k × (couleur − flou)) rend leur netteté aux joncs, poignées,
// arêtes et feux. Flou : 2 passes de moyenne en boîte de rayon r texels ; seuil s pour ne pas grossir le bruit.
const NET = { r: 4, k: 1, s: 2 };
function sharpenTex(px, size, o) {
  const n = size * size, r = o.r, L = new Float32Array(n), T = new Float32Array(n);
  const box = (src, dst, horiz) => { for (let a = 0; a < size; a++) { let acc = 0, cnt = 0;
    const at = b => horiz ? a * size + b : b * size + a;
    for (let b = 0; b < r; b++) { acc += src[at(b)]; cnt++; }
    for (let b = 0; b < size; b++) { if (b + r < size) { acc += src[at(b + r)]; cnt++; } if (b - r - 1 >= 0) { acc -= src[at(b - r - 1)]; cnt--; } dst[at(b)] = acc / cnt; } } };
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) L[i] = px[i * 4 + c];
    box(L, T, true); box(T, L, false); box(L, T, true); box(T, L, false);
    for (let i = 0; i < n; i++) { if (px[i * 4 + 3] === 0) continue; const v = px[i * 4 + c], d = v - L[i];
      if (Math.abs(d) > o.s) px[i * 4 + c] = clamp(Math.round(v + o.k * (d - Math.sign(d) * o.s)), 0, 255); }
  }
}
async function bakeTexture(THREE, mm, views, opts) {
  const size = opts.size || 2048;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: false, powerPreference: 'high-performance' });
  try {
    if (!renderer.capabilities.isWebGL2) throw new Error('webgl2');
    let shaderErr = false; renderer.debug.onShaderError = () => { shaderErr = true; };   // un shader refusé par l'appareil : repli
    const ex = renderer.extensions; if (!ex.has('EXT_color_buffer_float') && !ex.has('EXT_color_buffer_half_float')) throw new Error('flottants');
    renderer.autoClear = false;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mm.pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(mm.uv, 2));
    g.setAttribute('aOrig', new THREE.BufferAttribute(mm.orig, 3)); g.setAttribute('aOrigN', new THREE.BufferAttribute(mm.onrm, 3));
    const nV = mm.pos.length / 3, aRefl = new THREE.BufferAttribute(new Float32Array(nV), 1);
    g.setAttribute('aSharp', new THREE.BufferAttribute(Float32Array.from(mm.rim || new Uint8Array(nV)), 1)); g.setAttribute('aRefl', aRefl);
    g.setIndex(new THREE.BufferAttribute(mm.idx, 1));
    const scene = new THREE.Scene(), cam = new THREE.Camera(), mesh = new THREE.Mesh(g); mesh.frustumCulled = false; scene.add(mesh);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); quad.frustumCulled = false; const qscene = new THREE.Scene(); qscene.add(quad);
    const rt = (w, h, type, filter, fmt) => new THREE.WebGLRenderTarget(w, h, { type, format: fmt || THREE.RGBAFormat, minFilter: filter, magFilter: filter, depthBuffer: false, generateMipmaps: false });
    const HF = THREE.HalfFloatType, NE = THREE.NearestFilter, LI = THREE.LinearFilter;
    const DW = 384, DH = Math.round(DW * opts.SH / opts.SW);
    const depthRT = new THREE.WebGLRenderTarget(DW, DH, { type: HF, format: THREE.RGBAFormat, minFilter: NE, magFilter: NE, depthBuffer: true, generateMipmaps: false });
    const cmaxRT = rt(size, size, HF, NE, THREE.RedFormat), accRT = rt(size, size, HF, NE), minRT = rt(size, size, HF, NE, THREE.RedFormat), robRT = rt(size, size, HF, NE), outA = rt(size, size, THREE.UnsignedByteType, NE), outB = rt(size, size, THREE.UnsignedByteType, NE);
    const camU = () => ({ uC: { value: new THREE.Vector3() }, uR: { value: new THREE.Vector3() }, uU: { value: new THREE.Vector3() }, uF: { value: new THREE.Vector3() }, uFN: { value: new THREE.Vector2(...opts.fN) } });
    const setCam = (U, v) => { U.uC.value.fromArray(v.cam.C); U.uR.value.fromArray(v.cam.r); U.uU.value.fromArray(v.cam.u); U.uF.value.fromArray(v.cam.f); };
    const depthMat = new THREE.ShaderMaterial({ uniforms: camU(), side: THREE.DoubleSide,
      vertexShader: `attribute vec3 aOrig;uniform vec3 uC;uniform vec3 uR;uniform vec3 uU;uniform vec3 uF;uniform vec2 uFN;varying float vZ;
        void main(){vec3 q=aOrig-uC;float zc=dot(q,uF);vZ=zc;const float n=0.2;const float f=60.0;
        gl_Position=vec4(2.0*uFN.x*dot(q,uR),2.0*uFN.y*dot(q,uU),zc*(f+n)/(f-n)-2.0*f*n/(f-n),zc);}`,
      fragmentShader: `varying float vZ;void main(){gl_FragColor=vec4(vZ,0.0,0.0,1.0);}` });
    const maxU = Object.assign(camU(), { uMsk: { value: null }, uDep: { value: depthRT.texture } });
    const maxMat = new THREE.ShaderMaterial({ uniforms: maxU, vertexShader: BAKE_VS, side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      fragmentShader: BAKE_TEST + `void main(){vec2 im;float c=seen(im);if(c<0.0)discard;gl_FragColor=vec4(c,0.0,0.0,1.0);}` });
    const accU = Object.assign(camU(), { uMsk: { value: null }, uDep: { value: depthRT.texture }, uImg: { value: null }, uCmax: { value: cmaxRT.texture }, uGain: { value: 1 }, uLumRef: { value: opts.lumRef } });
    const accMat = new THREE.ShaderMaterial({ uniforms: accU, vertexShader: BAKE_VS, side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
      fragmentShader: BAKE_TEST + `uniform sampler2D uImg;uniform sampler2D uCmax;uniform float uGain;uniform float uLumRef;
        void main(){vec2 im;float c=seen(im);if(c<0.0)discard;
        float cm=texture2D(uCmax,vUv).r;vec3 col=texture2D(uImg,im).rgb*uGain;float lum=dot(col,vec3(0.3,0.59,0.11));
        float w=exp(mix(48.0,400.0,vSharp)*min(c-cm,0.1))*clamp((0.12+uLumRef)/(0.12+lum),0.3,3.0);   // les 2-3 vues les plus en face (jantes : la seule bien en face) ; reflets clairs atténués
        gl_FragColor=vec4(col*w,w);}` });
    const minU = Object.assign(camU(), { uMsk: accU.uMsk, uDep: { value: depthRT.texture }, uImg: accU.uImg, uCmax: { value: cmaxRT.texture }, uGain: accU.uGain });
    const minMat = new THREE.ShaderMaterial({ uniforms: minU, vertexShader: BAKE_VS, side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.MinEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
      fragmentShader: BAKE_TEST + `uniform sampler2D uImg;uniform sampler2D uCmax;uniform float uGain;
        void main(){vec2 im;float c=seen(im);if(c<0.0)discard;if(c<texture2D(uCmax,vUv).r-0.12)discard;   // seulement les bonnes vues
        float l=dot(texture2D(uImg,im).rgb*uGain,vec3(0.3,0.59,0.11));gl_FragColor=vec4(l,l,l,l);}` });
    // 3e passe : moyenne « robuste » autour de la couleur de base (référence = moyenne géométrique de la vue la plus sombre
    // et de la moyenne) : les reflets clairs et les vues mal recalées (bien plus sombres) comptent peu. Depuis v0.22, sur
    // la carrosserie, les vues jusqu'à 25-30° du meilleur angle comptent aussi (poids exp(8 (c - cmax)) au lieu de 48) : un
    // reflet ne reste pas au même endroit d'une image à l'autre, il se dilue ; les caméras calées gardent les détails nets
    const robU = Object.assign(camU(), { uMsk: accU.uMsk, uDep: { value: depthRT.texture }, uImg: accU.uImg, uCmax: { value: cmaxRT.texture }, uAcc: { value: accRT.texture }, uMin: { value: minRT.texture }, uGain: accU.uGain, uSoft: { value: opts.soft || 8 } });
    const robMat = new THREE.ShaderMaterial({ uniforms: robU, vertexShader: BAKE_VS, side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
      fragmentShader: BAKE_TEST + `uniform sampler2D uImg;uniform sampler2D uCmax;uniform sampler2D uAcc;uniform sampler2D uMin;uniform float uGain;uniform float uSoft;
        void main(){vec2 im;float c=seen(im);if(c<0.0)discard;
        float cm=texture2D(uCmax,vUv).r;vec4 a=texture2D(uAcc,vUv);float mn=texture2D(uMin,vUv).r;
        float ml=a.a>1e-6?dot(a.rgb/a.a,vec3(0.3,0.59,0.11)):0.1;float ref=sqrt(max(min(mn,ml),1e-4)*max(ml,1e-4));
        vec3 col=texture2D(uImg,im).rgb*uGain;float lum=dot(col,vec3(0.3,0.59,0.11));float d=log((lum+0.002)/(ref+0.002));
        float w=exp(mix(uSoft,400.0,vSharp)*min(c-cm,0.1))*exp(-d*d*2.5);
        gl_FragColor=vec4(col*w,w);}` });
    const finU = { uAcc: { value: accRT.texture }, uRob: { value: robRT.texture }, uMin: { value: minRT.texture }, uCmax: { value: cmaxRT.texture }, uPaint: { value: new THREE.Color().setRGB(...opts.paint, THREE.SRGBColorSpace) },
      uRoof: { value: new THREE.Color().setRGB(...opts.roof, THREE.SRGBColorSpace) }, uH: { value: opts.H },
      uWh: { value: [0, 1, 2, 3].map(i => { const w = opts.wheels && opts.wheels[i]; return w ? new THREE.Vector4(w.x, w.r, Math.abs(w.z), w.s) : new THREE.Vector4(0, 0, 0, 0); }) } };
    const finMat = new THREE.ShaderMaterial({ uniforms: finU, vertexShader: BAKE_VS, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      fragmentShader: `uniform sampler2D uAcc;uniform sampler2D uRob;uniform sampler2D uMin;uniform sampler2D uCmax;uniform vec3 uPaint;uniform vec3 uRoof;uniform float uH;uniform vec4 uWh[4];varying vec2 vUv;varying float vY;varying float vSharp;varying float vRefl;varying vec3 vP;varying vec3 vN;
        void main(){vec4 a=texture2D(uAcc,vUv);vec4 b=texture2D(uRob,vUv);float cm=texture2D(uCmax,vUv).r;vec4 mn=texture2D(uMin,vUv);
        vec3 seen=a.a>1e-6?a.rgb/a.a:uPaint;if(b.a>1e-6&&vSharp<0.5)seen=b.rgb/b.a;float sl=dot(seen,vec3(0.3,0.59,0.11));
        float r=mn.r<7.0&&sl>1e-4?mn.r/sl:1.0;
        seen*=mix(1.0,clamp(r,0.06,1.0),vRefl*(1.0-vSharp));   // vitres : la vue la plus sombre (le verre teinté, sans les reflets)
        // Peinture : couleur vue = a × teinte de la carrosserie + b × blanc (reflet du ciel, des façades). Quand ce modèle colle,
        // on garde a × teinte : la peinture sans ses reflets figés (le vernis les recrée à l'affichage, au bon endroit)
        float pp=dot(uPaint,uPaint),p1=uPaint.r+uPaint.g+uPaint.b,pc=dot(uPaint,seen),c1=seen.r+seen.g+seen.b,det=pp*3.6-p1*p1;
        float ka=(pc*3.6-p1*c1)/max(det,1e-7),kb=(pp*c1-p1*pc)/max(det,1e-7);if(kb<0.0){kb=0.0;ka=pc/max(pp,1e-7);}
        float rel=length(seen-ka*uPaint-kb)/(length(seen)+0.02);
        float isP=smoothstep(0.22,0.1,rel)*smoothstep(0.25,0.45,ka)*(1.0-vRefl)*(1.0-vSharp);
        // v0.22 : reflets clairs figés retirés aussi de la teinte (a) : la peinture ne dépasse plus sa vraie couleur, sauf un
        // peu sur ce qui regarde le ciel (capot, toit) ; le vernis recrée les reflets à l'affichage
        float cap=1.0+0.22*clamp(normalize(vN).y,0.0,1.0),kc=mix(ka>cap?cap+(ka-cap)*0.15:ka,ka,smoothstep(1.5,1.9,ka));   // au-delà de 1,6 fois la peinture : un feu
        seen=mix(seen,kc*uPaint,isP);
        float conf=smoothstep(0.14,0.34,cm);
        vec3 prior=mix(uPaint,uRoof,smoothstep(0.70*uH,0.86*uH,vY));   // ce qu'aucune image ne voit : peinture en bas, toit en haut
        vec3 c=clamp(mix(prior,seen,conf),0.0,1.0);
        // Intérieur des passages de roue (caché par le pneu sur les images) : sombre, comme une vraie doublure de passage
        float well=0.0;for(int i=0;i<4;i++){vec4 w=uWh[i];if(w.y<=0.0||vP.z*w.w<0.0||abs(vP.z)>w.z+0.03)continue;
          well=max(well,smoothstep(w.y+0.05,w.y+0.03,length(vec2(vP.x-w.x,vP.y-w.y))));}
        c=mix(c,vec3(0.012,0.012,0.014),well*(1.0-vSharp));
        gl_FragColor=vec4(mix(c*12.92,1.055*pow(c,vec3(1.0/2.4))-0.055,step(0.0031308,c)),1.0);}` });
    const ratMat = new THREE.ShaderMaterial({ uniforms: finU, vertexShader: BAKE_VS, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      fragmentShader: `uniform sampler2D uAcc;uniform sampler2D uMin;uniform sampler2D uCmax;varying vec2 vUv;
        void main(){vec4 a=texture2D(uAcc,vUv);float cm=texture2D(uCmax,vUv).r;float mn=texture2D(uMin,vUv).r;
        float sl=a.a>1e-6?dot(a.rgb/a.a,vec3(0.3,0.59,0.11)):0.0;float r=mn<7.0&&sl>1e-4?clamp(mn/sl,0.0,1.0):1.0;
        gl_FragColor=vec4(r,clamp(cm,0.0,1.0),sqrt(clamp(mn*4.0,0.0,1.0)),1.0);}` });
    const dilU = { uSrc: { value: null }, uPx: { value: new THREE.Vector2(1 / size, 1 / size) } };
    const dilMat = new THREE.ShaderMaterial({ uniforms: dilU, depthTest: false, depthWrite: false,
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`,
      fragmentShader: `uniform sampler2D uSrc;uniform vec2 uPx;varying vec2 vUv;
        void main(){vec4 c=texture2D(uSrc,vUv);if(c.a>0.5){gl_FragColor=c;return;}vec4 s=vec4(0.0);
        for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){vec4 t=texture2D(uSrc,vUv+vec2(float(dx),float(dy))*uPx);if(t.a>0.5)s+=vec4(t.rgb,1.0);}
        gl_FragColor=s.a>0.0?vec4(s.rgb/s.a,1.0):vec4(0.0);}` });
    // masques des vues (silhouette resserrée), lignes retournées pour la convention de WebGL (bas d'abord)
    const maskTex = v => { const W = opts.SW, H = opts.SH, d = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const val = v.mask[(H - 1 - y) * W + x] ? 255 : 0, o = (y * W + x) * 4; d[o] = d[o + 1] = d[o + 2] = val; d[o + 3] = 255; }
      const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat); t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true; return t; };
    const big = document.createElement('canvas'), bg = big.getContext('2d');
    const drawDepth = v => { setCam(depthMat.uniforms, v); mesh.material = depthMat; renderer.setRenderTarget(depthRT);
      renderer.setClearColor(new THREE.Color(1000, 0, 0), 1); renderer.clear(true, true, false); renderer.render(scene, cam); };
    // 1er tour : meilleur angle de vue atteint par chaque point de la voiture (sert de référence aux poids)
    renderer.setRenderTarget(cmaxRT); renderer.setClearColor(0x000000, 0); renderer.clear();
    for (let k = 0; k < views.length; k++) { const v = views[k], mt = maskTex(v);
      drawDepth(v); setCam(maxU, v); maxU.uMsk.value = mt; mesh.material = maxMat; renderer.setRenderTarget(cmaxRT); renderer.render(scene, cam); mt.dispose();
      opts.progress && opts.progress(.3 * (k + 1) / views.length); if (k % 8 === 7) await tick(); }
    // 2e tour : couleur, image par image, pondérée par l'angle (les 2-3 vues les plus en face), la visibilité et la lumière
    renderer.setRenderTarget(minRT); renderer.setClearColor(new THREE.Color(8, 8, 8), 8); renderer.clear();
    renderer.setRenderTarget(accRT); renderer.setClearColor(0x000000, 0); renderer.clear();
    for (let k = 0; k < views.length; k++) { const v = views[k], mt = maskTex(v);
      const bmp = await createImageBitmap(v.img); big.width = bmp.width; big.height = bmp.height; bg.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
      const it = new THREE.CanvasTexture(big); it.colorSpace = THREE.SRGBColorSpace; it.minFilter = THREE.LinearFilter; it.generateMipmaps = false; it.flipY = true;
      drawDepth(v); setCam(accU, v); accU.uMsk.value = mt; accU.uImg.value = it; accU.uGain.value = v.gain; mesh.material = accMat;
      renderer.setRenderTarget(accRT); renderer.render(scene, cam);
      setCam(minU, v); mesh.material = minMat; renderer.setRenderTarget(minRT); renderer.render(scene, cam); it.dispose(); mt.dispose();
      opts.progress && opts.progress(.3 + .3 * (k + 1) / views.length); if (k % 4 === 3) await tick(); }
    // 3e tour : moyenne robuste (mêmes images)
    renderer.setRenderTarget(robRT); renderer.setClearColor(0x000000, 0); renderer.clear();
    for (let k = 0; k < views.length; k++) { const v = views[k], mt = maskTex(v);
      const bmp = await createImageBitmap(v.img); big.width = bmp.width; big.height = bmp.height; bg.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
      const it = new THREE.CanvasTexture(big); it.colorSpace = THREE.SRGBColorSpace; it.minFilter = THREE.LinearFilter; it.generateMipmaps = false; it.flipY = true;
      drawDepth(v); setCam(robU, v); accU.uMsk.value = mt; accU.uImg.value = it; accU.uGain.value = v.gain; mesh.material = robMat;
      renderer.setRenderTarget(robRT); renderer.render(scene, cam); it.dispose(); mt.dispose();
      opts.progress && opts.progress(.6 + .3 * (k + 1) / views.length); if (k % 4 === 3) await tick(); }
    // Vitres : là où la vue la plus sombre est bien plus sombre que la moyenne, la couleur dépend du point de vue (reflets
    // sur du verre) ; repéré par sommet, lissé sur la forme, seulement dans la moitié haute
    renderer.setRenderTarget(outB); renderer.setClearColor(0x000000, 0); renderer.clear(); mesh.material = ratMat; renderer.render(scene, cam);
    const rp = new Uint8Array(size * size * 4); renderer.readRenderTargetPixels(outB, 0, 0, size, size, rp);
    const glass = glassMask(mm, rp, size, opts.H); aRefl.array.set(glass.f); aRefl.needsUpdate = true;
    // Couleur finale (normalisée, peinture là où rien n'est vu), puis débordement autour des cartes (pas de joints visibles)
    renderer.setRenderTarget(outA); renderer.setClearColor(0x000000, 0); renderer.clear(); mesh.material = finMat; renderer.render(scene, cam);
    let a = outA, b = outB; quad.material = dilMat;
    for (let i = 0; i < 10; i++) { dilU.uSrc.value = a.texture; renderer.setRenderTarget(b); renderer.clear(); renderer.render(qscene, cam); const t = a; a = b; b = t; }
    const px = new Uint8Array(size * size * 4); renderer.readRenderTargetPixels(a, 0, 0, size, size, px);
    let cov = 0, lit = 0; for (let i = 0; i < px.length; i += 4 * 97) if (px[i + 3] > 0) { cov++; if (px[i] + px[i + 1] + px[i + 2] > 6) lit++; }
    if (shaderErr || cov < size * size / 97 * .05 || lit < cov * .2) throw new Error(shaderErr ? 'shader' : 'texture vide');
    if (opts.net !== false) sharpenTex(px, size, Object.assign({}, NET, opts.net));
    const out = document.createElement('canvas'); out.width = out.height = size; const og = out.getContext('2d'), img = og.createImageData(size, size);
    for (let y = 0; y < size; y++) img.data.set(px.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);   // haut de l'image = v = 1
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    og.putImageData(img, 0, 0);
    const blob = await toJpeg(out, .9);
    [depthRT, cmaxRT, accRT, minRT, robRT, outA, outB].forEach(r => r.dispose()); [depthMat, maxMat, accMat, minMat, robMat, finMat, ratMat, dilMat].forEach(m => m.dispose()); g.dispose();
    return { blob, glass: glass.u8, glassShare: glass.share };
  } finally { renderer.setRenderTarget(null); renderer.dispose(); try { renderer.forceContextLoss(); } catch (e) {} }
}

// Construit l'objet 3D à afficher. MC = le module MarchingCubes de three.js (pour ses tables).
// Renvoie { group, material, dims, triangles } : la voiture posée au sol, axe long sur x, centrée.
// v3 : maillage et texture cuite, matériau physique (vernis et reflets du studio de la scène). La couleur vient de la texture
// (émissive : pas d'éclairage ajouté par-dessus les vraies lumières de la vidéo) ; le vernis ajoute les reflets qui bougent
// avec la voiture. Pneus et plastiques noirs du bas restent mats. Uniformes uReveal / uScan : faisceau du scanner de l'intro.
function scanPatch(sh) {
  const rv = this.userData.reveal, gl = !!this.userData.glass, mq = this.userData.maq; sh.uniforms.uReveal = rv.uReveal; sh.uniforms.uScan = rv.uScan;
  sh.uniforms.uMaq = { value: mq.on }; sh.uniforms.uPaintC = { value: mq.paint }; sh.uniforms.uEmi = { value: mq.emi }; sh.uniforms.uWhl = { value: mq.wheels }; sh.uniforms.uNW = { value: mq.nw };
  sh.vertexShader = (gl ? 'attribute float aGlass;\n' : '') + 'varying float vSY;\nvarying float vGlass;\nvarying vec3 vSP;\nvarying float vUp;\nvarying float vNX;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvSY = position.y;\n\tvSP = position;\n\tvUp = normal.y;\n\tvNX = normal.x;\n\tvGlass = ' + (gl ? 'aGlass' : '0.0') + ';');
  sh.fragmentShader = 'uniform float uReveal;\nuniform float uScan;\nuniform float uMaq;\nuniform vec3 uPaintC;\nuniform float uEmi;\nuniform vec4 uWhl[4];\nuniform int uNW;\nvarying float vSY;\nvarying float vGlass;\nvarying vec3 vSP;\nvarying float vUp;\nvarying float vNX;\n' + sh.fragmentShader
    .replace('void main() {', `void main() {
	if(vSY>uReveal)discard;
	if(uScan>0.001&&!gl_FrontFacing){float sl=0.75+0.25*step(0.5,fract(gl_FragCoord.y*0.2));gl_FragColor=linearToOutputTexel(vec4((vec3(0.03,0.12,0.21)+vec3(0.16,0.42,0.58)*0.45*uScan)*sl,1.0));return;}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
	float vgL=dot(totalEmissiveRadiance,vec3(0.3,0.59,0.11));
	float vgS=max(max(totalEmissiveRadiance.r,totalEmissiveRadiance.g),totalEmissiveRadiance.b)-min(min(totalEmissiveRadiance.r,totalEmissiveRadiance.g),totalEmissiveRadiance.b);
	float vigieGloss=1.0-(1.0-smoothstep(0.32,0.5,vSY))*(1.0-smoothstep(0.03,0.09,vgL))*(1.0-smoothstep(0.05,0.15,vgS));
	if(uMaq>0.5){
	  vec3 tc=totalEmissiveRadiance/uEmi;float pp=max(dot(uPaintC,uPaintC),1e-5),ka=dot(tc,uPaintC)/pp;
	  float res=length(tc-ka*uPaintC)/(length(tc)+0.02),darkP=step(dot(uPaintC,vec3(0.3,0.59,0.11)),0.025);
	  float isP=mix(smoothstep(0.26,0.1,res)*smoothstep(0.18,0.42,ka)*(1.0-smoothstep(1.4,1.8,ka)),smoothstep(0.06,0.02,length(tc-uPaintC)),darkP);
	  float lum=dot(tc,vec3(0.3,0.59,0.11)),pl=max(dot(uPaintC,vec3(0.3,0.59,0.11)),0.004);
	  isP=max(isP,smoothstep(0.55,0.8,vUp)*smoothstep(0.08,0.2,lum/pl)*(1.0-smoothstep(2.2,3.2,lum/pl))*(1.0-smoothstep(0.2,0.4,vGlass)));   // capot, toit, coffre : reflets du ciel, du pare-brise
	  for(int w=0;w<4;w++){if(w>=uNW)break;vec4 wh=uWhl[w];if(vSP.z*wh.w<0.25)continue;float d=length(vec2(vSP.x-wh.x,vSP.y-wh.y));
	    isP=max(isP,smoothstep(wh.y+0.035,wh.y+0.06,d)*(1.0-smoothstep(wh.y+0.15,wh.y+0.22,d)));}   // ailes autour des roues : peinture
	  isP*=1.0-vGlass;
	  float well=0.0;   // v0.24 : intérieur des passages de roue (voûte, parois) : plastique noir mat, comme une vraie voiture
	  for(int w=0;w<4;w++){if(w>=uNW)break;vec4 wh=uWhl[w];if(vSP.z*wh.w<0.0)continue;float R=wh.y+0.035,dx=abs(vSP.x-wh.x);
	    float inA=vSP.y>wh.y?step(length(vec2(dx,vSP.y-wh.y)),R+0.006):step(dx,R+0.006);
	    well=max(well,inA*max(max(step(0.3,-vUp),step(0.7,abs(vNX))),step(abs(vSP.z),abs(wh.z)-0.2)));}
	  isP*=1.0-well;
	  diffuseColor.rgb=mix(diffuseColor.rgb,uPaintC*mix(1.0,clamp(ka,0.55,1.1),0.35),isP);
	  totalEmissiveRadiance*=1.0-isP;metalnessFactor=mix(metalnessFactor,0.5,isP);roughnessFactor=mix(roughnessFactor,0.26,isP);
	  float gE=smoothstep(0.4,0.6,vGlass),fr=(1.0-smoothstep(0.0,0.07,abs(vGlass-0.5)))*step(0.02,vGlass);
	  diffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.006,0.01,0.018),gE);totalEmissiveRadiance*=1.0-0.75*gE;metalnessFactor=mix(metalnessFactor,0.6,gE);
	  diffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.004),fr);totalEmissiveRadiance*=1.0-fr;roughnessFactor=mix(roughnessFactor,0.35,fr);
	  diffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.012),well);totalEmissiveRadiance*=1.0-0.9*well;roughnessFactor=mix(roughnessFactor,0.85,well);metalnessFactor*=1.0-well;
	  vigieGloss=max(vigieGloss,isP)*(1.0-well);
	}`)
    .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
	#ifdef USE_CLEARCOAT
	material.clearcoat=mix(material.clearcoat*vigieGloss,0.85,vGlass);
	material.clearcoatRoughness=mix(material.clearcoatRoughness,0.1,vGlass);
	#endif
	material.roughness=mix(mix(0.75,material.roughness,vigieGloss),mix(0.16,0.07,uMaq),vGlass);`)
    .replace('#include <opaque_fragment>', `#include <opaque_fragment>
	gl_FragColor.rgb=mix(gl_FragColor.rgb,gl_FragColor.rgb*0.55+vec3(0.1,0.22,0.3),uScan*0.35)+vec3(0.45,0.92,1.0)*exp(-abs(uReveal-vSY)*28.0)*uScan*2.4;`);
}
const LOOK = { env: .55, spec: .5, rough: .38, coat: 1, coatRough: .08, emi: 1.15, maq: 1, envMaq: 1.1 };   // vernis plein (v0.19) ; maq : peinture de studio (v0.23)
async function buildV3(THREE, rec, look) {
  const L = Object.assign({}, LOOK, look || {});
  const M = rec.mesh, g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(M.pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(M.nrm, 3, true));
  g.setAttribute('uv', new THREE.BufferAttribute(M.uv, 2, true)); g.setIndex(new THREE.BufferAttribute(M.idx, 1)); g.computeBoundingSphere();
  const hasGlass = !!(M.glass && M.glass.length === M.pos.length / 3); if (hasGlass) g.setAttribute('aGlass', new THREE.BufferAttribute(M.glass, 1, true));   // vitres (v0.19)
  const tex = await new Promise((res, rej) => { const u = URL.createObjectURL(rec.tex), im = new Image();
    im.onload = () => { const t = new THREE.Texture(im); t.flipY = true; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.needsUpdate = true; URL.revokeObjectURL(u); res(t); };
    im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('image')); }; im.src = u; });
  const mk = rv => { const m = new THREE.MeshPhysicalMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: tex, metalness: 0, roughness: L.rough,
      specularIntensity: L.spec, clearcoat: L.coat, clearcoatRoughness: L.coatRough, envMapIntensity: L.maq ? L.envMaq : L.env, emissiveIntensity: L.emi, side: THREE.DoubleSide, toneMapped: false });
    m.userData.reveal = rv; m.userData.glass = hasGlass; m.userData.maq = { on: L.maq && rec.paint ? 1 : 0, paint: new THREE.Color().setRGB(...(rec.paint || [.6, .6, .6]), THREE.SRGBColorSpace), emi: L.emi,   // sans couleur mesurée : peinture des images
      wheels: [0, 1, 2, 3].map(n => { const w = (rec.wheels || [])[n]; return w ? new THREE.Vector4(w.x, w.r, w.z, w.s) : new THREE.Vector4(); }), nw: Math.min(4, (rec.wheels || []).length) };
    m.onBeforeCompile = scanPatch; m.customProgramCacheKey = () => 'vigie-scan-v3' + (hasGlass ? '-vitres' : '') + (L.maq && rec.paint ? '-maq' : ''); return m; };
  // Pneus : caoutchouc noir (une roue est une roue) ; la jante, elle, vient de tes images (disque de la texture)
  const tires = (rec.wheels || []).map(w => { const r = w.r, tw = clamp(.115 * rec.dims.W, .17, .25), h = tw / 2;
    const prof = [[.74 * r, -h + .012], [.9 * r, -h], [r - .025, -h + .02], [r, -h + .06], [r, h - .06], [r - .025, h - .02], [.9 * r, h], [.74 * r, h - .012]].map(([x, y]) => new THREE.Vector2(x, y));
    const tg = new THREE.LatheGeometry(prof, 56); tg.rotateX(Math.PI / 2); return { w, tg, h }; });
  const rubber = rv => { const m = new THREE.MeshPhysicalMaterial({ color: 0x0b0c0e, roughness: .8, metalness: 0, envMapIntensity: .5, side: THREE.DoubleSide });
    m.userData.reveal = rv; m.userData.maq = { on: 0, paint: new THREE.Color(0, 0, 0), emi: 1, wheels: [0, 1, 2, 3].map(() => new THREE.Vector4()), nw: 0 }; m.onBeforeCompile = scanPatch; m.customProgramCacheKey = () => 'vigie-scan-v3-pneu'; return m; };
  const assemble = rv => { const m = mk(rv), gr = new THREE.Group(); gr.add(new THREE.Mesh(g, m)); const rm = rubber(rv);
    tires.forEach(({ w, tg, h }) => { const t = new THREE.Mesh(tg, rm); t.position.set(w.x, w.r, w.z - w.s * h); gr.add(t); }); return { m, gr }; };
  const rv0 = { uReveal: { value: 99 }, uScan: { value: 0 } }, A = assemble(rv0), material = A.m, group = A.gr;
  const obj = { group, material, reveal: rv0, dims: rec.dims, triangles: M.idx.length / 3, front: rec.front, disposeTex: () => tex.dispose() };
  obj.copy = () => { const rv = { uReveal: { value: 99 }, uScan: { value: 0 } }, B = assemble(rv);
    return { group: B.gr, material: B.m, reveal: rv, dims: rec.dims, triangles: obj.triangles, front: rec.front, disposeTex: obj.disposeTex, orig: obj }; };
  return obj;
}

export async function buildScanObject(THREE, MC, rec, look) {
  if (rec.mesh && rec.tex) return buildV3(THREE, rec, look);
  const D = rec.disp; if (!D || !D.field) throw new Error('ancien');
  const mm = meshFromField(D, rec.align, MC), { pos, orig, onrm: on, idx: I, flip, roofA } = mm;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(mm.nrm, 3)); g.setIndex(new THREE.BufferAttribute(I, 1));
  g.setAttribute('aOrig', new THREE.BufferAttribute(orig, 3)); g.setAttribute('aOrigN', new THREE.BufferAttribute(on, 3));
  g.computeBoundingSphere();
  // Image classique (pas ImageBitmap, qui ignore flipY sur certains navigateurs)
  const load = (blob, srgb) => new Promise((res, rej) => { const u = URL.createObjectURL(blob), im = new Image();
    im.onload = () => { const t = new THREE.Texture(im); t.flipY = true; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.needsUpdate = true; URL.revokeObjectURL(u); res(t); };
    im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('image')); }; im.src = u; });
  const [tex, mtex] = await Promise.all([load(rec.atlas, true), load(rec.maskAtlas, false)]);
  const NV = rec.views.length / 12, V = k => new THREE.Vector3(...rec.views.subarray(k, k + 3));
  const uC = [], uR = [], uU = [], uF = [];
  for (let i = 0; i < NV; i++) { uC.push(V(i * 12)); uR.push(V(i * 12 + 3)); uU.push(V(i * 12 + 6)); uF.push(V(i * 12 + 9)); }
  const pc = rec.paint || rec.base || [.6, .6, .6], rc = rec.roof || pc, srgb = c => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
  const material = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: tex }, uMask: { value: mtex }, uC: { value: uC }, uR: { value: uR }, uU: { value: uU }, uF: { value: uF },
      uFN: { value: new THREE.Vector2(...rec.fN) }, uOpacity: { value: 1 }, uGloss: { value: .6 }, uReveal: { value: 99 }, uScan: { value: 0 },
      uPaint: { value: srgb(pc) }, uRoof: { value: srgb(rc) }, uH: { value: rec.dims.H } },
    vertexShader: VS, fragmentShader: FS(NV), side: THREE.DoubleSide, toneMapped: false, transparent: false
  });
  const mesh = new THREE.Mesh(g, material), group = new THREE.Group(); group.add(mesh);
  return { group, material, reveal: material.uniforms, dims: rec.dims, triangles: I.length / 3, front: { flipped: flip < 0, roofCm: Math.round(roofA * 100) } };
}
