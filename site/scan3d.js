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
    const BW = Math.min(960, vw), BH = Math.round(vh * BW / vw), SW = WS, SH = Math.round(vh * SW / vw);
    const big = document.createElement('canvas'); big.width = BW; big.height = BH; const gb = big.getContext('2d');
    const sm = document.createElement('canvas'); sm.width = SW; sm.height = SH; const gs = sm.getContext('2d', { willReadFrequently: true });
    const T = Array.from({ length: N_FRAMES }, (_, i) => Math.min(dur - .05, (i + .5) * dur / N_FRAMES)), step = dur / N_FRAMES;
    const bigs = new Array(N_FRAMES), smalls = new Array(N_FRAMES), times = new Array(N_FRAMES), jobs = []; let got = 0;
    const grab = (i, t) => { times[i] = t; gb.drawImage(v, 0, 0, BW, BH); gs.drawImage(v, 0, 0, SW, SH); smalls[i] = gs.getImageData(0, 0, SW, SH); got++; jobs.push(toJpeg(big).then(b => { bigs[i] = b; })); progress(got / N_FRAMES); };
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
    return { bigs, smalls, times, SW, SH, BW, BH, dur };
  } finally { try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch (e) {} URL.revokeObjectURL(url); }
}

/* ---------- 2. Détourage de la voiture (DeepLab v3 via MediaPipe) ---------- */
let segP = null;
export function loadSegmenter() {
  if (!segP) segP = (async () => {
    const vision = await import(HERE + 'vendor/mediapipe/vision_bundle.mjs');
    const seg = await vision.ImageSegmenter.createFromOptions(
      { wasmLoaderPath: HERE + 'vendor/mediapipe/vision_wasm_internal.js', wasmBinaryPath: HERE + 'vendor/mediapipe/vision_wasm_internal.wasm' },
      { baseOptions: { modelAssetPath: HERE + 'vendor/mediapipe/deeplab_v3.tflite', delegate: 'CPU' }, runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false });
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
function makeCam(theta, d, yaw, pitch, th = TARGET_H) {
  const C = [Math.sin(theta) * d, CAM_H, Math.cos(theta) * d];
  let fw = [-C[0], th - C[1], -C[2]]; const n0 = Math.hypot(...fw); fw = fw.map(v => v / n0);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);                       // rotation autour de y (vers la gauche)
  fw = [fw[0] * cy + fw[2] * sy, fw[1], -fw[0] * sy + fw[2] * cy];
  let rt = [-fw[2], 0, fw[0]]; const nr = Math.hypot(...rt) || 1; rt = rt.map(v => v / nr);   // droite = avant × haut
  let up = [rt[1] * fw[2] - rt[2] * fw[1], rt[2] * fw[0] - rt[0] * fw[2], rt[0] * fw[1] - rt[1] * fw[0]];
  const cp = Math.cos(pitch), sp = Math.sin(pitch);                   // voiture vue plus bas → caméra levée
  const f2 = fw.map((v, k) => v * cp + up[k] * sp), u2 = up.map((v, k) => v * cp - fw[k] * sp);
  return { C, r: rt, u: u2, f: f2 };
}
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
function blur3(f, n) { // flou 3 × 3 × 3 séparable
  const a = f, b = new Float32Array(f.length);
  for (let ax = 0; ax < 3; ax++) { const s = ax === 0 ? 1 : ax === 1 ? n : n * n;
    for (let i = 0; i < a.length; i++) { const c = ax === 0 ? i % n : ax === 1 ? ((i / n) | 0) % n : (i / (n * n)) | 0;
      b[i] = (a[i] * 2 + (c > 0 ? a[i - s] : 0) + (c < n - 1 ? a[i + s] : 0)) / 4; }
    a.set(b); }
  return a;
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

// Réglage fin : pour chaque image, l'angle et la distance qui font le mieux coller la forme sculptée à la silhouette
function refineCams(occ, n, box, base, masks, SW, SH, fpx, ok, refineDist) {
  const { R, Y } = box, pts = [];
  for (let z = 1; z < n - 1; z++) for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) { const i = (z * n + y) * n + x; if (!occ[i]) continue;
    if (occ[i - 1] && occ[i + 1] && occ[i - n] && occ[i + n] && occ[i - n * n] && occ[i + n * n]) continue; // surface seulement
    if ((x + y + z) % 2) continue; pts.push(((x + .5) / n * 2 - 1) * R, (y + .5) / n * Y, ((z + .5) / n * 2 - 1) * R); }
  const P = pts.length / 3, img = new Uint8Array(SW * SH);
  const score = (cam, m) => { img.fill(0); let inC = 0, tot = 0;
    for (let k = 0; k < P; k++) { const qx = pts[k * 3] - cam.C[0], qy = pts[k * 3 + 1] - cam.C[1], qz = pts[k * 3 + 2] - cam.C[2], zc = qx * cam.f[0] + qy * cam.f[1] + qz * cam.f[2]; if (zc < .3) continue;
      const u = (SW / 2 + fpx * (qx * cam.r[0] + qy * cam.r[1] + qz * cam.r[2]) / zc) | 0, v = (SH / 2 - fpx * (qx * cam.u[0] + qy * cam.u[1] + qz * cam.u[2]) / zc) | 0;
      if (u < 0 || v < 0 || u >= SW || v >= SH) continue; tot++; if (m[v * SW + u]) inC++; img[v * SW + u] = 1; }
    let cover = 0, area = 0; for (let i = 0; i < SW * SH; i += 2) if (m[i]) { area++; if (img[i] || img[i + 1] || img[i - SW] || img[i + SW]) cover++; }
    return (tot ? inC / tot : 0) + (area ? cover / area : 0); };
  // le cap de la caméra (mesuré sur le décor) reste fixe : on cherche comment le répartir entre position (θ) et visée
  const D = Math.PI / 180;
  return base.map((p, j) => { let best = p, bs = -1;
    const DS = refineDist ? [.96, 1, 1.04] : [1], DP = refineDist ? [-1.5, 0, 1.5] : [0];
    for (const dt of [-4, -2.5, -1.2, 0, 1.2, 2.5, 4]) for (const ds of DS) for (const dp of DP) {
      const q = { ...p, theta: p.theta - dt * D, yaw: p.yaw + dt * D, d: p.d * ds, pitch: p.pitch + dp * D }, sc = score(makeCam(q.theta, q.d, q.yaw, q.pitch, q.th), masks[j]) - (Math.abs(dt) / 25 + Math.abs(ds - 1) * .6 + Math.abs(dp) / 40);
      if (sc > bs) { bs = sc; best = q; } }
    return best; });
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
    if (!err.spinFrames) { err.spinFrames = F.bigs.filter((b, i) => b && i % 2 === 0); err.spinSize = [F.BW, F.BH]; }
    throw err;
  }
}

async function scanFrames(F, opts, progress) {
  const q = {};
  const { SW, SH } = F, fpx = (Math.max(SW, SH) / 2) / Math.tan(HFOV / 2 * Math.PI / 180);
  // Détourage
  progress('model', 0);
  let masks;
  if (opts.testMasks) masks = await opts.testMasks(SW, SH, F.times);
  else {
    const { seg, keep } = await loadSegmenter().catch(() => { throw new Error('modele'); });
    masks = [];
    for (let i = 0; i < N_FRAMES; i++) {
      const res = seg.segment(F.smalls[i]), cm = res.categoryMask, cats = cm.getAsUint8Array(), mw = cm.width, mh = cm.height, raw = new Uint8Array(SW * SH);
      for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) { const c = cats[Math.min(mh - 1, (y * mh / SH) | 0) * mw + Math.min(mw - 1, (x * mw / SW) | 0)]; raw[y * SW + x] = keep.includes(c) ? 1 : 0; }
      try { res.close(); } catch (e) {}
      masks.push(cleanMask(raw, SW, SH));
      progress('mask', (i + 1) / N_FRAMES); if (i % 6 === 5) await tick();
      // Pas de voiture sur le premier tiers du tour : inutile de continuer
      if (i === 23) { const seen = masks.filter(m => maskStats(m, SW, SH).frac > .02).length; if (seen < 6) { const e = new Error('voiture'); e.quality = { carFrames: seen, frames: 24 }; throw e; } }
    }
  }
  const stats = masks.map(m => maskStats(m, SW, SH));
  const ok = stats.map(s => s.frac > .02 && s.n > 0);
  q.carFrames = ok.filter(Boolean).length; q.frames = N_FRAMES;
  if (q.carFrames < N_FRAMES * .6) { const e = new Error('voiture'); e.quality = q; throw e; }
  // Angle parcouru, image après image
  progress('pose', 0);
  const spec = F.smalls.map((img, i) => bgSpectrum(img, dilate(masks[i], SW, SH, 6), SW, SH));
  const dxs = [], peaks = [];
  for (let i = 1; i < N_FRAMES; i++) { const s = shiftBetween(spec[i - 1], spec[i]); dxs.push(s.dx); peaks.push(s.peak); if (i % 12 === 0) { progress('pose', i / N_FRAMES); await tick(); } }
  // le dernier pas (fin → début du tour) n'est pas mesuré : on prend la médiane
  const med = median(dxs), sgn = Math.sign(med) || 1;
  const steps = dxs.map((d, i) => { const bad = Math.sign(d) !== sgn || Math.abs(d) > Math.abs(med) * 4 || peaks[i] < 3; return bad ? med : d; });
  steps.push(med);
  const total = steps.reduce((a, b) => a + b, 0);
  q.peak = Math.round(median(peaks) * 10) / 10; q.badSteps = dxs.filter((d, i) => Math.sign(d) !== sgn || Math.abs(d) > Math.abs(med) * 4 || peaks[i] < 3).length;
  const heading = [0]; for (let i = 1; i < N_FRAMES; i++) heading.push(heading[i - 1] + steps[i - 1] / Math.abs(total) * 2 * Math.PI);
  const f0 = fpx;
  // Visée : on suppose que la voiture est gardée au milieu de l'écran (conseil affiché avant de filmer). Le centre de
  // la silhouette est faussé par la perspective et par les bords du cadre : sur la vidéo de test, s'y fier sculpte moins bien.
  // La visée réelle de chaque image est ensuite retrouvée par le recalage sur la silhouette, pour la peinture.
  const xc = new Array(N_FRAMES).fill(0);
  const yc = stats.map(s => s.cy - SH / 2);
  const theta = heading.map((h, i) => h - Math.atan(xc[i] / f0));
  // Distance : hauteur de la silhouette (images coupées en haut ou en bas : valeur des voisines)
  let dist = stats.map((s, i) => ok[i] && !s.cutT && !s.cutB ? f0 * CAR_H / s.h : null);
  const fill = a => a.map((v, i) => { if (v != null) return v; for (let k = 1; k < N_FRAMES; k++) { const b = a[(i + k) % N_FRAMES], c = a[(i - k + N_FRAMES) % N_FRAMES]; if (b != null) return b; if (c != null) return c; } return 4; });
  dist = fill(dist); dist = dist.map((_, i) => median([dist[(i - 1 + N_FRAMES) % N_FRAMES], dist[i], dist[(i + 1) % N_FRAMES]]));
  const vis = []; for (let i = 0; i < N_FRAMES; i++) if (ok[i]) vis.push(i);
  const yawOf = i => Math.atan(xc[i] / f0), pitOf = i => Math.atan(yc[i] / f0);       // voiture vue à droite → caméra tournée à gauche
  const mk = off => vis.map(i => makeCam(theta[i], dist[i] + off(i), yawOf(i), pitOf(i)));
  const dm = vis.map(i => dilate(masks[i], SW, SH, 2));
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
  let poses = vis.map(i => ({ theta: theta[i], d: dist[i] + 1, yaw: yawOf(i), pitch: pitOf(i), th: TARGET_H }));
  if (opts.truePoses) {
    const tp = opts.truePoses(F.times); poses = vis.map(i => ({ theta: tp[i].theta, d: tp[i].d, yaw: tp[i].yaw ?? yawOf(i), pitch: tp[i].pitch ?? pitOf(i), th: tp[i].th ?? TARGET_H }));
    const Sn = await sculpt(poses.map(p => makeCam(p.theta, p.d, p.yaw, p.pitch, p.th))); if (Sn.shape) { S = Sn; passes.push(Sn.shape); }
  }
  // Peinture : chaque caméra est recalée sur sa silhouette (angle, distance, assiette) pour que les images tombent au bon endroit
  progress('carve', .9);
  const texPoses = opts.truePoses ? poses : refineCams(S.occ, GRID, S.box, poses, dm, SW, SH, fpx, ok, true);
  const camsTex = texPoses.map(p => makeCam(p.theta, p.d, p.yaw, p.pitch, p.th));
  vis.forEach((i, j) => { theta[i] = texPoses[j].theta; });
  const finalPoses = texPoses;
  q.passes = passes.map(p => [p.L, p.W, p.H].map(v => Math.round(v * 100) / 100));
  progress('carve', 1);
  // Champ lissé pour le maillage
  const field = new Float32Array(S.occ.length); for (let i = 0; i < field.length; i++) field[i] = S.occ[i];
  blur3(field, GRID); blur3(field, GRID);
  const f8 = new Uint8Array(field.length); for (let i = 0; i < field.length; i++) f8[i] = Math.round(clamp(field[i], 0, 1) * 255);
  // 36 vues régulières autour de la voiture pour la peinture et la vue 360°
  progress('paint', 0);
  const ang = vis.map(i => theta[i]), picks = [];
  for (let k = 0; k < N_TEX; k++) { const t = ang[0] + Math.sign(total) * k * 2 * Math.PI / N_TEX; let bi = 0, bd = 1e9;
    vis.forEach((i, j) => { const d = Math.abs(Math.atan2(Math.sin(ang[j] - t), Math.cos(ang[j] - t))); if (d < bd) { bd = d; bi = j; } }); picks.push(bi); }
  const CW = 512, CH = Math.round(CW * SH / SW), MW = 256, MH = Math.round(MW * SH / SW), cols = 6, rows = 6;
  const atlas = document.createElement('canvas'); atlas.width = CW * cols; atlas.height = CH * rows; const ga = atlas.getContext('2d');
  const matl = document.createElement('canvas'); matl.width = MW * cols; matl.height = MH * rows; const gm = matl.getContext('2d');
  const mc = document.createElement('canvas'); mc.width = SW; mc.height = SH; const gmc = mc.getContext('2d'), mid = gmc.createImageData(SW, SH);
  const views = new Float32Array(N_TEX * 12); let cr = 0, cg = 0, cb = 0, cn = 0;
  for (let k = 0; k < N_TEX; k++) {
    const j = picks[k], i = vis[j], cam = camsTex[j], col = k % cols, row = (k / cols) | 0;
    const bmp = await createImageBitmap(F.bigs[i]); ga.drawImage(bmp, col * CW, row * CH, CW, CH); if (bmp.close) bmp.close();
    const m = dm[j]; for (let p = 0; p < SW * SH; p++) { const v = m[p] ? 255 : 0; mid.data[p * 4] = mid.data[p * 4 + 1] = mid.data[p * 4 + 2] = v; mid.data[p * 4 + 3] = 255;
      if (masks[i][p] && (p & 7) === 0) { const s = F.smalls[i].data; cr += s[p * 4]; cg += s[p * 4 + 1]; cb += s[p * 4 + 2]; cn++; } }
    gmc.putImageData(mid, 0, 0); gm.drawImage(mc, col * MW, row * MH, MW, MH);
    views.set([...cam.C, ...cam.r, ...cam.u, ...cam.f], k * 12);
    progress('paint', (k + 1) / N_TEX); if (k % 6 === 5) await tick();
  }
  const [atlasBlob, maskBlob] = await Promise.all([toJpeg(atlas, .86), new Promise(r => matl.toBlob(r, 'image/png'))]);
  const sh2 = S.shape;
  q.loopDeg = 360; q.views = vis.length;
  return {
    v: 1, date: new Date().toISOString(), n: GRID, field: f8, box: S.box,
    align: { alpha: sh2.alpha, cx: sh2.cx, cz: sh2.cz }, dims: { L: sh2.L, W: sh2.W, H: sh2.H },
    views, fN: [fpx / SW, fpx / SH], atlas: atlasBlob, maskAtlas: maskBlob, grid: [cols, rows],
    base: cn ? [cr / cn / 255, cg / cn / 255, cb / cn / 255] : [.6, .6, .6], quality: q,
    spinFrames: picks.map(j => F.bigs[vis[j]]), spinSize: [F.BW, F.BH],
    debug: opts.debug ? { poses: finalPoses, heading, ctimes: F.times, top: (() => { const n = GRID, t = new Array(n * n).fill(0); for (let i = 0; i < S.occ.length; i++) if (S.occ[i]) { const x = i % n, z = (i / (n * n)) | 0; t[z * n + x] = 1; } return t; })(), side: (() => { const n = GRID, t = new Array(n * n).fill(0); for (let i = 0; i < S.occ.length; i++) if (S.occ[i]) { const x = i % n, y = ((i / n) | 0) % n; t[(n - 1 - y) * n + x] = 1; } return t; })(), times: F.times, theta, dist, stats, ok, steps, dxs, peaks, vis, masks: [0, 9, 18, 27].map(i => Array.from(masks[i])), SW, SH } : undefined
  };
}

/* ---------- Affichage : maillage + peinture par projection des images ---------- */
const VS = `attribute vec3 aOrig;attribute vec3 aOrigN;varying vec3 vO;varying vec3 vN;
void main(){vO=aOrig;vN=aOrigN;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
const FS = (n) => `uniform sampler2D uTex;uniform sampler2D uMask;uniform vec3 uC[${n}];uniform vec3 uR[${n}];uniform vec3 uU[${n}];uniform vec3 uF[${n}];
uniform vec2 uFN;uniform float uOpacity;uniform vec3 uBase;varying vec3 vO;varying vec3 vN;
void main(){
  vec3 n=normalize(vN);vec3 acc=vec3(0.0);float ws=0.0;
  for(int i=0;i<${n};i++){
    vec3 q=vO-uC[i];float zc=dot(q,uF[i]);if(zc<0.2)continue;
    float w=dot(n,normalize(uC[i]-vO));if(w<0.2)continue;
    vec2 uv=vec2(0.5+uFN.x*dot(q,uR[i])/zc,0.5+uFN.y*dot(q,uU[i])/zc);
    if(uv.x<0.0||uv.y<0.0||uv.x>1.0||uv.y>1.0)continue;
    float col=mod(float(i),6.0),row=floor(float(i)/6.0);
    vec2 a=vec2((col+uv.x)/6.0,(5.0-row+uv.y)/6.0);
    float wt=pow((w-0.2)/0.8,4.0)*mix(0.08,1.0,texture2D(uMask,a).r);
    acc+=texture2D(uTex,a).rgb*wt;ws+=wt;
  }
  if(ws<0.0005){
    vec3 nh=normalize(vec3(n.x,0.0001,n.z));
    for(int i=0;i<${n};i++){
      vec3 q=vO-uC[i];float zc=dot(q,uF[i]);if(zc<0.2)continue;
      vec2 uv=vec2(0.5+uFN.x*dot(q,uR[i])/zc,0.5+uFN.y*dot(q,uU[i])/zc);
      if(uv.x<0.0||uv.y<0.0||uv.x>1.0||uv.y>1.0)continue;
      float col=mod(float(i),6.0),row=floor(float(i)/6.0);
      vec2 a=vec2((col+uv.x)/6.0,(5.0-row+uv.y)/6.0);
      float wt=texture2D(uMask,a).r*(0.25+0.75*max(dot(nh,normalize(uC[i]-vO)),0.0));
      acc+=texture2D(uTex,a).rgb*wt;ws+=wt;
    }
  }
  vec3 c=ws>0.0005?acc/ws:uBase*(0.55+0.45*max(n.y,0.0));
  gl_FragColor=vec4(c,uOpacity);
  #include <colorspace_fragment>
}`;

// Construit l'objet 3D à afficher. Renvoie { group, material, dims } : la voiture est posée au sol, axe long sur x.
export async function buildScanObject(THREE, MarchingCubes, rec) {
  const n = rec.n, mc = new MarchingCubes(n, new THREE.MeshBasicMaterial(), false, false, 300000);
  for (let i = 0; i < rec.field.length; i++) mc.field[i] = rec.field[i] / 255;
  mc.isolation = .5; mc.update();
  const cnt = mc.count, P = mc.geometry.getAttribute('position').array, Nn = mc.geometry.getAttribute('normal').array;
  const { R, Y } = rec.box, { alpha, cx, cz } = rec.align, ca = Math.cos(alpha), sa = Math.sin(alpha);
  const pos = new Float32Array(cnt * 3), orig = new Float32Array(cnt * 3), on = new Float32Array(cnt * 3);
  for (let v = 0; v < cnt; v++) {
    const x = (P[v * 3] + 1 / n) * R, y = ((P[v * 3 + 1] + 1) / 2 + .5 / n) * Y, z = (P[v * 3 + 2] + 1 / n) * R; // même repère que la grille sculptée
    orig[v * 3] = x; orig[v * 3 + 1] = y; orig[v * 3 + 2] = z;
    let nx = Nn[v * 3] / R, ny = Nn[v * 3 + 1] * 2 / Y, nz = Nn[v * 3 + 2] / R; const l = Math.hypot(nx, ny, nz) || 1; on[v * 3] = nx / l; on[v * 3 + 1] = ny / l; on[v * 3 + 2] = nz / l;
    const dx = x - cx, dz = z - cz; pos[v * 3] = dx * ca + dz * sa; pos[v * 3 + 1] = y; pos[v * 3 + 2] = -dx * sa + dz * ca;
  }
  mc.geometry.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aOrig', new THREE.BufferAttribute(orig, 3)); g.setAttribute('aOrigN', new THREE.BufferAttribute(on, 3));
  g.computeVertexNormals(); g.computeBoundingSphere();
  // Image classique (pas ImageBitmap, qui ignore flipY sur certains navigateurs)
  const load = (blob, srgb) => new Promise((res, rej) => { const u = URL.createObjectURL(blob), im = new Image();
    im.onload = () => { const t = new THREE.Texture(im); t.flipY = true; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.needsUpdate = true; URL.revokeObjectURL(u); res(t); };
    im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('image')); }; im.src = u; });
  const [tex, mtex] = await Promise.all([load(rec.atlas, true), load(rec.maskAtlas, false)]);
  const NV = rec.views.length / 12, V = k => new THREE.Vector3(...rec.views.subarray(k, k + 3));
  const uC = [], uR = [], uU = [], uF = [];
  for (let i = 0; i < NV; i++) { uC.push(V(i * 12)); uR.push(V(i * 12 + 3)); uU.push(V(i * 12 + 6)); uF.push(V(i * 12 + 9)); }
  const material = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: tex }, uMask: { value: mtex }, uC: { value: uC }, uR: { value: uR }, uU: { value: uU }, uF: { value: uF },
      uFN: { value: new THREE.Vector2(...rec.fN) }, uOpacity: { value: 1 }, uBase: { value: new THREE.Color(...rec.base) } },
    vertexShader: VS, fragmentShader: FS(NV), side: THREE.DoubleSide, toneMapped: false, transparent: false
  });
  const mesh = new THREE.Mesh(g, material), group = new THREE.Group(); group.add(mesh);
  return { group, material, dims: rec.dims, triangles: cnt / 3 };
}
