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

/* ---------- 4 bis. Forme fine dans le repère de la voiture (v0.15.1) ---------- */
// Grille alignée sur la voiture : i le long (axe a), j en hauteur, k en largeur (axe b), cubes de CELL mètres.
// Indice (k * ny + j) * nx + i, comme la grille de départ. Seule la peau de la forme grossière est retestée.
const CELL = .025;
function morph3(occ, n, grow) { // dilatation (grow) ou érosion d'un cube, voisinage 3 × 3 × 3
  let a = occ;
  for (let ax = 0; ax < 3; ax++) { const s = ax === 0 ? 1 : ax === 1 ? n : n * n, b = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) { const c = ax === 0 ? i % n : ax === 1 ? ((i / n) | 0) % n : (i / (n * n)) | 0;
      const l = c > 0 ? a[i - s] : 0, r = c < n - 1 ? a[i + s] : 0; b[i] = grow ? (a[i] | l | r) : (a[i] & l & r); }
    a = b; }
  return a;
}
function carveAligned(cams, masks, SW, SH, fpx, S, sh) {
  const { alpha, cx, cz, L, W, H } = sh, ca = Math.cos(alpha), sa = Math.sin(alpha), m = .15;
  const nx = Math.ceil((L + 2 * m) / CELL), ny = Math.ceil((H + m) / CELL), nz = Math.ceil((W + 2 * m) / CELL);
  const a0 = -nx * CELL / 2, b0 = -nz * CELL / 2;
  const n = GRID, { R, Y } = S.box, near = morph3(S.occ, n, true), sure = morph3(morph3(S.occ, n, false), n, false);
  const occ = new Uint8Array(nx * ny * nz), nv = cams.length, maxOut = Math.max(2, Math.round(nv * .07));
  const order = []; for (let s = 0; s < 8; s++) for (let i = s; i < nv; i += 8) order.push(i);
  for (let k = 0; k < nz; k++) { const b = b0 + (k + .5) * CELL;
    for (let j = 0; j < ny; j++) { const wy = (j + .5) * CELL; if (wy < .03) continue; const gy = Math.floor(wy / Y * n); if (gy >= n) continue;
      for (let i = 0; i < nx; i++) {
        const a = a0 + (i + .5) * CELL, wx = cx + a * ca - b * sa, wz = cz + a * sa + b * ca;
        const gx = Math.floor((wx / R + 1) / 2 * n), gz = Math.floor((wz / R + 1) / 2 * n);
        if (gx < 0 || gz < 0 || gx >= n || gz >= n) continue;
        const g = (gz * n + gy) * n + gx; if (!near[g]) continue;
        if (sure[g]) { occ[(k * ny + j) * nx + i] = 1; continue; }   // bien à l'intérieur de la forme grossière
        let out = 0, seen = 0;
        for (const v of order) { const c = cams[v], qx = wx - c.C[0], qy = wy - c.C[1], qz = wz - c.C[2];
          const zc = qx * c.f[0] + qy * c.f[1] + qz * c.f[2]; if (zc < .3) continue;
          const u = SW / 2 + fpx * (qx * c.r[0] + qy * c.r[1] + qz * c.r[2]) / zc, w = SH / 2 - fpx * (qx * c.u[0] + qy * c.u[1] + qz * c.u[2]) / zc;
          if (u < 0 || w < 0 || u >= SW || w >= SH) continue;
          seen++; if (!masks[v][(w | 0) * SW + (u | 0)]) { if (++out > maxOut) break; } }
        if (out <= maxOut && seen >= nv * .35) occ[(k * ny + j) * nx + i] = 1;
      } } }
  return { occ, nx, ny, nz, a0, b0 };
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
// Couleur dominante d'un ensemble de pixels : la teinte la plus fréquente (ou le gris le plus fréquent pour une voiture
// blanche, grise ou noire), puis la moyenne des pixels de cette teinte entre le 40e et le 85e centile de luminosité
// (ni les ombres, ni les reflets du ciel).
function dominant(px) {
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
  let r = 0, g = 0, b = 0, n = 0; for (let k = Math.floor(sel.length * .4); k < Math.max(Math.floor(sel.length * .4) + 1, Math.floor(sel.length * .85)); k++) { const i = sel[k]; r += px[i * 3]; g += px[i * 3 + 1]; b += px[i * 3 + 2]; n++; }
  return n ? [r / n / 255, g / n / 255, b / n / 255] : null;
}
// Couleur de la peinture : portières, entre les vitres et les roues (loin des bords de la silhouette)
function paintColor(masks, smalls, idxs, SW, SH) {
  const px = [];
  for (const i of idxs) { const m = masks[i], st = maskStats(m, SW, SH); if (!st.n) continue; const d = smalls[i].data;
    for (let y = Math.max(2, Math.round(st.y0 + st.h * .4)); y <= Math.min(SH - 3, Math.round(st.y0 + st.h * .75)); y += 2)
      for (let x = Math.max(2, st.x0); x <= Math.min(SW - 3, st.x1); x += 2) { const p = y * SW + x;
        if (m[p] && m[p - 2] && m[p + 2] && m[p - 2 * SW] && m[p + 2 * SW]) px.push(d[p * 4], d[p * 4 + 1], d[p * 4 + 2]); } }
  return dominant(px);
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
  // Forme fine (cubes de 2,5 cm) dans le repère de la voiture, avec les mêmes caméras que la forme grossière, puis symétrie
  progress('carve', .93); await tick();
  const fine = carveAligned(poses.map(p => makeCam(p.theta, p.d, p.yaw, p.pitch, p.th)), dm, SW, SH, fpx, S, S.shape);
  const { nx, ny, nz } = fine, fo = largestComp3(fine.occ, nx, ny, nz);
  q.fine = { roofCut: flattenRoof(fo, nx, ny, nz) };
  const ff = new Float32Array(fo.length); let fv = 0; for (let i = 0; i < ff.length; i++) { ff[i] = fo[i]; fv += fo[i]; }
  if (fv < 5000) { const e = new Error('forme'); e.quality = q; throw e; }
  blur3a(ff, nx, ny, nz); blur3a(ff, nx, ny, nz); blur3a(ff, nx, ny, nz);
  const sym = symmetrize(ff, nx, ny, nz), f8 = new Uint8Array(ff.length);
  let i0 = nx, i1 = -1, j1 = -1, k0 = nz, k1 = -1;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const v = sym.g[(k * ny + j) * nx + i]; f8[(k * ny + j) * nx + i] = Math.round(clamp(v, 0, 1) * 255);
    if (v >= .5) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j > j1) j1 = j; if (k < k0) k0 = k; if (k > k1) k1 = k; } }
  const disp = { nx, ny, nz, cell: CELL, a0: fine.a0, b0: fine.b0, field: f8,
    ac: fine.a0 + ((i0 + i1) / 2 + .5) * CELL, bc: fine.b0 + (sym.mid + .5) * CELL };
  const dims = { L: (i1 - i0 + 1) * CELL, W: (k1 - k0 + 1) * CELL, H: (j1 + 1) * CELL };
  Object.assign(q.fine, { voxels: fv, grid: [nx, ny, nz], symPlaneCm: Math.round((disp.bc - (fine.b0 + nz * CELL / 2)) * 100) });
  progress('carve', 1);
  // 36 vues régulières autour de la voiture pour la peinture et la vue 360°
  progress('paint', 0);
  const ang = vis.map(i => theta[i]), picks = [];
  for (let k = 0; k < N_TEX; k++) { const t = ang[0] + Math.sign(total) * k * 2 * Math.PI / N_TEX; let bi = 0, bd = 1e9;
    vis.forEach((i, j) => { const d = Math.abs(Math.atan2(Math.sin(ang[j] - t), Math.cos(ang[j] - t))); if (d < bd) { bd = d; bi = j; } }); picks.push(bi); }
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
  const sh2 = S.shape, base = cn ? [cr / cn / 255, cg / cn / 255, cb / cn / 255] : [.6, .6, .6];
  q.loopDeg = 360; q.views = vis.length;
  return {
    v: 2, date: new Date().toISOString(), disp,
    align: { alpha: sh2.alpha, cx: sh2.cx, cz: sh2.cz }, dims,
    views, fN: [fpx / SW, fpx / SH], atlas: atlasBlob, maskAtlas: maskBlob, grid: [cols, rows],
    base, paint: paintColor(masks, F.smalls, vis.filter((_, j) => j % 2 === 0), SW, SH) || base,
    roof: roofColor(masks, F.smalls, vis.filter((_, j) => j % 2 === 0), SW, SH), quality: q,
    spinFrames: picks.map(j => F.bigs[vis[j]]), spinSize: [F.BW, F.BH],
    debug: opts.debug ? { poses: finalPoses, heading, ctimes: F.times, top: (() => { const n = GRID, t = new Array(n * n).fill(0); for (let i = 0; i < S.occ.length; i++) if (S.occ[i]) { const x = i % n, z = (i / (n * n)) | 0; t[z * n + x] = 1; } return t; })(), side: (() => { const n = GRID, t = new Array(n * n).fill(0); for (let i = 0; i < S.occ.length; i++) if (S.occ[i]) { const x = i % n, y = ((i / n) | 0) % n; t[(n - 1 - y) * n + x] = 1; } return t; })(), times: F.times, theta, dist, stats, ok, steps, dxs, peaks, vis, masks: [0, 9, 18, 27].map(i => Array.from(masks[i])), SW, SH } : undefined
  };
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
  if(uScan>0.001&&!gl_FrontFacing){gl_FragColor=vec4(vec3(0.05,0.22,0.36)+vec3(0.30,0.65,0.85)*0.45*uScan,uOpacity); // coupe du scanner : tranche lumineuse
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

// Construit l'objet 3D à afficher. MC = le module MarchingCubes de three.js (pour ses tables).
// Renvoie { group, material, dims, triangles } : la voiture posée au sol, axe long sur x, centrée.
export async function buildScanObject(THREE, MC, rec) {
  const D = rec.disp; if (!D || !D.field) throw new Error('ancien');
  const { nx, ny, nz, cell, a0, b0, ac, bc } = D;
  const { P, I } = marching(D.field, nx, ny, nz, 127.5, MC.edgeTable, MC.triTable);
  smoothMesh(P, I, 10);
  const nV = P.length / 3, { alpha, cx, cz } = rec.align, ca = Math.cos(alpha), sa = Math.sin(alpha);
  // Sens de la voiture : le toit (le haut de l'habitacle) est presque toujours plus près de l'arrière que de l'avant
  // (capot devant, coffre ou hayon derrière). L'avant est placé du côté des x positifs, comme les dessins de Vigie.
  const F = D.field; let jTop = 0;
  for (let q = 0; q < F.length; q++) if (F[q] >= 128) { const j = ((q / nx) | 0) % ny; if (j > jTop) jTop = j; }
  let sumA = 0, nA = 0; const jMin = Math.round(jTop * .82);
  for (let k = 0; k < nz; k++) for (let j = jMin; j < ny; j++) for (let i = 0; i < nx; i++) if (F[(k * ny + j) * nx + i] >= 128) { sumA += a0 + (i + .5) * cell; nA++; }
  const roofA = nA ? sumA / nA - ac : 0, flip = roofA > .02 ? -1 : 1;
  const pos = new Float32Array(nV * 3), orig = new Float32Array(nV * 3);
  for (let v = 0; v < nV; v++) {
    const a = a0 + (P[v * 3] + .5) * cell, y = (P[v * 3 + 1] + .5) * cell, b = b0 + (P[v * 3 + 2] + .5) * cell;
    pos[v * 3] = (a - ac) * flip; pos[v * 3 + 1] = y; pos[v * 3 + 2] = (b - bc) * flip;   // affichage : centrée, axe long sur x, avant vers +x
    orig[v * 3] = cx + a * ca - b * sa; orig[v * 3 + 1] = y; orig[v * 3 + 2] = cz + a * sa + b * ca;   // repère des caméras du scan
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(I, 1));
  g.computeVertexNormals();
  let nr = g.getAttribute('normal').array, out = 0;
  for (let v = 0; v < nV; v += 7) out += nr[v * 3] * pos[v * 3] + nr[v * 3 + 1] * (pos[v * 3 + 1] - .6) + nr[v * 3 + 2] * pos[v * 3 + 2];
  if (out < 0) { // triangles tournés vers l'intérieur : on les retourne (faces avant = dehors, utile à la coupe du scanner)
    for (let t = 0; t < I.length; t += 3) { const x = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = x; }
    g.computeVertexNormals(); nr.set(g.getAttribute('normal').array);
  }
  smoothNormals(nr, I, 3);
  const on = new Float32Array(nV * 3);
  for (let v = 0; v < nV; v++) { const na = nr[v * 3] * flip, nb = nr[v * 3 + 2] * flip; on[v * 3] = na * ca - nb * sa; on[v * 3 + 1] = nr[v * 3 + 1]; on[v * 3 + 2] = na * sa + nb * ca; }
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
  return { group, material, dims: rec.dims, triangles: I.length / 3, front: { flipped: flip < 0, roofCm: Math.round(roofA * 100) } };
}
