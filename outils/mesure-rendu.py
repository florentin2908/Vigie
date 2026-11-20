#!/usr/bin/env python3
"""Mesure de la qualité de la voiture scannée, pour suivre les progrès d'une version à l'autre.

Usage : python3 outils/mesure-rendu.py <dossier_video_de_test> <dossier_de_sortie> [--deps /tmp/vigie-deps]
        [--options '{"lisse": false}'] [--modele voiture.glb]

Fait tourner le vrai moteur (site/scan3d.js, avec DeepLab) dans Chromium sur la vidéo de test (outils/video-de-test.py),
puis compare la voiture scannée à la vraie voiture filmée :
- forme : écart moyen (cm) des surfaces vues de côté, de dessus, de l'avant et de l'arrière, après le meilleur calage
  (échelle, position, tangage) ; côté découpé en bandes (bas, ceinture, vitres) ; recouvrement des silhouettes (iou) ;
- bosses : ondulations de la carrosserie, en mm (médiane et 90e centile d'un filtre passe-bande 1-4 cm sur des cartes
  de profondeur à 5 mm, côté et dessus, roues exclues) ; la vraie voiture donne la référence (ses vraies arêtes) ;
- flou : netteté de l'image (gradient moyen à l'intérieur de la voiture) du scan peint rapportée à celle de la vraie
  voiture, vues « côté » et « proche » (1 = aussi net que la vraie voiture) ;
- durée du scan, taille du maillage et de la texture, sommets de la carrosserie lisse.
Écrit mesure.json, qualite.json (bilan complet du scan), planche.png (vraie voiture | scan peint | scan en argile, 5 vues) et forme.png (écarts en couleur :
rouge = scan trop grand, bleu = trop petit, vert = manque au scan, orange = en trop).
Avec --modele : la vraie voiture est ce modèle .glb (celui donné à outils/video-de-test.py --modele) ; il n'est jamais
copié dans le dépôt.
"""
import argparse, asyncio, base64, functools, http.server, io, json, os, re, socketserver, sys, threading, time
import numpy as np
from PIL import Image, ImageDraw

ap = argparse.ArgumentParser()
ap.add_argument('video_dir'); ap.add_argument('out')
ap.add_argument('--deps', default='/tmp/vigie-deps')
ap.add_argument('--options', default='{}', help='options du scan (JSON), par exemple {"lisse": false} ; par défaut images prises une par une (seekOnly), pour des mesures qui se répètent à l\'identique')
ap.add_argument('--modele', help='fichier .glb de la voiture filmée, si la vidéo a été faite avec --modele')
ap.add_argument('--export', help='dossier où écrire la voiture scannée pour la visionneuse (outils/visionneuse/) : voiture3d.html, scan3d.js, voiture.b64.txt, texture.jpg')
ap.add_argument('--site', help='dossier qui contient scan3d.js (par défaut site/ du dépôt) : pour mesurer une autre version du moteur')
args = ap.parse_args()
OPTS = dict({'seekOnly': True}, **json.loads(args.options))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.abspath(args.site) if args.site else os.path.join(ROOT, 'site'); VD = os.path.abspath(args.video_dir); OUT = os.path.abspath(args.out); os.makedirs(OUT, exist_ok=True)
NM = os.path.join(os.path.abspath(args.deps), 'node_modules')
truth = json.load(open(os.path.join(VD, 'tour-synthetique.json')))
MODELE = truth.get('modele')
if isinstance(MODELE, str) or (MODELE and not args.modele):
    sys.exit('Cette vidéo filme un modèle .glb : donne-le avec --modele (et refais la vidéo si son JSON ne garde que le nom).')
page = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
mod = re.search(r'<script type="module">(.*?)</script>', page, re.S).group(1); mod = mod[:mod.index('const introP=prepareIntro();')]

SCENE = r"""
import * as MC from 'three/addons/objects/MarchingCubes.js';
import { scanVideo, buildScanObject } from './scan3d.js';
const b64 = arr => { const u = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); };
const MODELE = %(modele)s;
async function truthCar(glow) {   // la voiture filmée, posée comme dans outils/video-de-test.py (lueurs des feux : seulement pour les images)
  if (!MODELE) { useBody('compacte'); const car = buildCar({ paint: '#B3121F' }); if (glow) addGlows(car, .9); return car.group; }
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'); const gl = await new GLTFLoader().loadAsync('modele.glb');
  const g = new THREE.Group(), m = gl.scene; g.add(m);
  let b = new THREE.Box3().setFromObject(m), sz = b.getSize(new THREE.Vector3());
  const ax = MODELE.avant !== 'auto' ? MODELE.avant : (sz.x >= sz.z ? '+x' : '+z');
  m.rotation.y = { '+x': 0, '-x': Math.PI, '+z': -Math.PI / 2, '-z': Math.PI / 2 }[ax]; m.updateMatrixWorld(true);
  b = new THREE.Box3().setFromObject(m); sz = b.getSize(new THREE.Vector3());
  const k = MODELE.L / sz.x; m.scale.multiplyScalar(k); m.updateMatrixWorld(true); b = new THREE.Box3().setFromObject(m); const c = b.getCenter(new THREE.Vector3());
  m.position.x -= c.x; m.position.z -= c.z; m.position.y -= b.min.y; return g;
}
const clay = obj => obj.traverse(m => { if (m.isMesh && m.material && !m.material.isMeshBasicMaterial) m.material = new THREE.MeshPhysicalMaterial({ color: 0xd8d4cc, roughness: .3, clearcoat: 1, clearcoatRoughness: .05, side: THREE.DoubleSide }); });
window.__run = async (o) => {
  const blob = await (await fetch('tour.mp4')).blob(), t0 = performance.now();
  const rec = await scanVideo(new File([blob], 'tour.mp4', { type: 'video/mp4' }), o || {}); window.__rec = rec;
  return { v: rec.v, dims: rec.dims, q: rec.quality, ms: Math.round(performance.now() - t0), wheels: rec.wheels || null };
};
// Cartes de profondeur orthographiques : position du premier point de surface vu depuis chaque direction
window.__maps = async (RES, names, bodyOnly) => {
  const cv = document.createElement('canvas'); document.body.appendChild(cv);
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: false, preserveDrawingBuffer: true }); r.setPixelRatio(1);
  const mat = new THREE.ShaderMaterial({ vertexShader: 'varying vec3 vW;void main(){vec4 w=modelMatrix*vec4(position,1.);vW=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}',
    fragmentShader: 'varying vec3 vW;void main(){gl_FragColor=vec4(vW,1.);}', side: THREE.DoubleSide });
  const out = {};
  for (const which of ['vrai', 'scan']) {
    let obj;
    if (which === 'vrai') obj = await truthCar();
    else { const o = await buildScanObject(THREE, MC, window.__rec); obj = o.group; if (bodyOnly) { const g = new THREE.Group(); g.add(o.group.children[0].clone()); obj = g; } }
    const sc = new THREE.Scene(); sc.add(obj); sc.overrideMaterial = mat; out[which] = {};
    const X0 = -3.4, X1 = 3.4, Y1 = 2.2, Z0 = -1.4, Z1 = 1.4;
    const dirs = { cote: [X0, X1, -0.1, Y1], dessus: [X0, X1, Z0, Z1], avant: [Z0, Z1, -0.1, Y1], arriere: [Z0, Z1, -0.1, Y1] };
    for (const nm of names) { const [a0, a1, b0, b1] = dirs[nm], W = Math.round((a1 - a0) / RES), H = Math.round((b1 - b0) / RES);
      const cam = new THREE.OrthographicCamera(a0, a1, b1, b0, .1, 30);
      if (nm === 'cote') cam.position.set(0, 0, 10); else if (nm === 'dessus') { cam.up.set(0, 0, -1); cam.position.set(0, 10, 0); }
      else if (nm === 'avant') { cam.position.set(10, 0, 0); cam.left = -a1; cam.right = -a0; } else cam.position.set(-10, 0, 0);
      cam.lookAt(0, 0, 0); cam.updateProjectionMatrix();
      const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear(); r.render(sc, cam);
      const buf = new Float32Array(W * H * 4); r.readRenderTargetPixels(rt, 0, 0, W, H, buf); r.setRenderTarget(null); rt.dispose();
      out[which][nm] = { W, H, data: b64(buf) }; }
  }
  r.dispose(); cv.remove(); return out;
};
// Vues de l'appli : vraie voiture, scan peint, scan en argile, plus un masque (silhouette) par vue pour la netteté
window.__shots = async () => {
  const rec = window.__rec, W = 640, H = 400, cv = document.createElement('canvas'); cv.width = W; cv.height = H; document.body.appendChild(cv);
  const r = makeRenderer(cv); r.setPixelRatio(1); r.setSize(W, H, false);
  const views = [['accueil', .28, -.6, [0, 1, 0], .55], ['arriere', .22, 2.5, [0, 1, 0], .55], ['cote', .08, Math.PI / 2, [0, 1, 0], .6], ['dessus', Math.PI / 2 - .001, Math.PI / 2, [0, 0, -1], 0], ['proche', .18, -.35, [0, 1, 0], .7]];
  const L = rec.dims.L, Hd = rec.dims.H, out = [], white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (const which of ['vrai', 'scan', 'argile']) {
    const sc = new THREE.Scene(); sc.background = new THREE.Color('#2b2490'); lightScene(sc, r);
    let obj;
    if (which === 'vrai') obj = await truthCar(true);
    else { const o = await buildScanObject(THREE, MC, rec); obj = o.group; useDims(o.dims); if (which === 'argile') clay(obj); }
    const fake = { group: new THREE.Group() }; sc.add(fake.group); addGround(sc, fake); sc.add(obj);
    const ms = new THREE.Scene(); ms.background = new THREE.Color(0x000000); ms.overrideMaterial = white; const ghost = obj.clone(); ms.add(ghost);
    ghost.traverse(o => { if (o.isSprite || o.isPoints || o.isLine) o.visible = false; });
    const cam = new THREE.PerspectiveCamera(30, W / H, .1, 100);
    for (const [name, e, rot, up, ty] of views) {
      obj.rotation.y = rot; ghost.rotation.y = rot; fake.group.rotation.y = rot;
      const fw = name === 'dessus' ? 4.0 : Math.max(5.6, L + 1.2), fh = name === 'dessus' ? Math.max(6.8, L + 1.9) : Math.max(2.8, Hd + 1.2);
      let d = fitDist(cam, fw, fh); if (name === 'proche') d *= .55;
      cam.up.set(...up); cam.position.set(0, Math.sin(e) * d + ty, Math.cos(e) * d); cam.lookAt(0, ty, 0);
      r.render(sc, cam); const img = cv.toDataURL('image/png'); r.render(ms, cam); out.push({ which, name, img, mask: cv.toDataURL('image/png') });
    }
  }
  r.dispose(); cv.remove(); return out;
};
// Export pour la visionneuse (outils/visionneuse/voiture3d.html) : en-tête JSON + maillage, et la texture JPEG
window.__export = async (version) => {
  const rec = window.__rec, M = rec.mesh, nV = M.pos.length / 3, nT = M.idx.length / 3;
  const head = JSON.stringify({ v: 3, version, nV, nT, dims: rec.dims, wheels: rec.wheels, front: rec.front, paint: rec.paint, calage: rec.quality && rec.quality.calage });
  const hb = new TextEncoder().encode(head), hl = Math.ceil(hb.length / 4) * 4;
  const parts = [M.pos, M.nrm, M.uv, Uint16Array.from(M.idx), M.glass || new Uint8Array(nV)];
  let size = 8 + hl; for (const a of parts) { size += a.byteLength; size += (4 - size %% 4) %% 4; }
  const buf = new ArrayBuffer(size), dv = new DataView(buf), u8 = new Uint8Array(buf);
  dv.setUint32(0, 0x33474956, true); dv.setUint32(4, hl, true); u8.set(hb, 8);
  let o = 8 + hl; for (const a of parts) { u8.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o); o += a.byteLength; o += (4 - o %% 4) %% 4; }
  return { bin: b64(u8), tex: b64(new Uint8Array(await rec.tex.arrayBuffer())) };
};
window.__ready = true;
"""

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

async def browse():
    from playwright.async_api import async_playwright
    httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Q, directory=SITE)); threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{httpd.server_address[1]}/'
    html = ('<!doctype html><html><body style="margin:0;background:#000"><script type="importmap">'
            '{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}'
            '</script><script>window.VigieState={studio:true,accent:"#7CE3FF",floor:"#C9C3FF",tint:"#8F7CFF"};</script>'
            '<script type="module">' + mod + (SCENE % {'modele': json.dumps(MODELE)}) + '</script></body></html>')
    async with async_playwright() as p:
        exe = '/usr/bin/google-chrome' if os.path.exists('/usr/bin/google-chrome') else None
        b = await p.chromium.launch(executable_path=exe, args=['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'])
        pg = await b.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            if 'three@0.160.0/' in u: return await r.fulfill(path=os.path.join(NM, 'three', u.split('three@0.160.0/')[1]), content_type='application/javascript')
            if u == base + 'mesure.html': return await r.fulfill(body=html, content_type='text/html; charset=utf-8')
            if u == base + 'tour.mp4': return await r.fulfill(path=os.path.join(VD, 'tour-synthetique.mp4'), content_type='video/mp4')
            if u == base + 'modele.glb' and args.modele: return await r.fulfill(path=os.path.abspath(args.modele), content_type='model/gltf-binary')
            if u.startswith(base): return await r.continue_()
            return await r.abort()
        await pg.route('**/*', route)
        await pg.goto(base + 'mesure.html')
        await pg.wait_for_function('window.__ready', timeout=120000)
        info = await pg.evaluate('o => window.__run(o)', OPTS)
        print('scan :', info['ms'], 'ms', json.dumps(info['q'].get('bake'), ensure_ascii=False), flush=True)
        maps = await pg.evaluate("() => window.__maps(0.01, ['cote', 'dessus', 'avant', 'arriere'], false)")
        fine = await pg.evaluate("() => window.__maps(0.005, ['cote', 'dessus'], true)")
        shots = await pg.evaluate('() => window.__shots()')
        if args.export:
            import shutil
            ver = json.load(open(os.path.join(ROOT, 'changelog.json'), encoding='utf-8'))['versions'][0]['version']
            ex = await pg.evaluate('v => window.__export(v)', ver); E = os.path.abspath(args.export); os.makedirs(E, exist_ok=True)
            open(os.path.join(E, 'voiture.b64.txt'), 'w').write(ex['bin']); open(os.path.join(E, 'texture.jpg'), 'wb').write(base64.b64decode(ex['tex']))
            shutil.copy(os.path.join(SITE, 'scan3d.js'), E); shutil.copy(os.path.join(ROOT, 'outils', 'visionneuse', 'voiture3d.html'), E)
            print('visionneuse :', E, flush=True)
        await b.close()
    httpd.shutdown()
    return info, maps, fine, shots, errs

def arr(m):
    a = np.frombuffer(base64.b64decode(m['data']), dtype=np.float32).reshape(m['H'], m['W'], 4)[::-1]
    return a.copy()

# ---------- forme : écarts après le meilleur calage (même méthode que les essais de la v0.21 à la v0.23) ----------
RES = .01; X0, X1, Y1, Z0, Z1 = -3.4, 3.4, 2.2, -1.4, 1.4
DEPTH = {'cote': (2, 1), 'dessus': (1, 1), 'avant': (0, 1), 'arriere': (0, -1)}
def extents(m, w):
    c = m[w, 'cote']; cov = c[..., 3] > 0; xs = c[..., 0][cov]; ys = c[..., 1][cov]
    t = m[w, 'dessus']; ct = t[..., 3] > 0; zs = t[..., 2][ct]
    return xs.min(), xs.max(), ys.max(), zs.min(), zs.max()
def grid(nm, shape, res=RES):
    H, W = shape[:2]; c = (np.arange(W) + .5) * res; r = (np.arange(H) + .5) * res
    if nm == 'cote': return np.meshgrid(X0 + c, Y1 - r)
    if nm == 'dessus': return np.meshgrid(X0 + c, -Z1 + r)
    if nm == 'avant': return np.meshgrid(-(Z0 + c), Y1 - r)
    return np.meshgrid(Z0 + c, Y1 - r)
def pix(nm, u, v, shape):
    H, W = shape[:2]
    if nm == 'cote': col = (u - X0) / RES; row = (Y1 - v) / RES
    elif nm == 'dessus': col = (u - X0) / RES; row = (v + Z1) / RES
    elif nm == 'avant': col = (-u - Z0) / RES; row = (Y1 - v) / RES
    else: col = (u - Z0) / RES; row = (Y1 - v) / RES
    col = np.floor(col).astype(int); row = np.floor(row).astype(int); ok = (col >= 0) & (col < W) & (row >= 0) & (row < H)
    return np.clip(row, 0, H - 1), np.clip(col, 0, W - 1), ok
def compare(m, s, tx, tz, flip=False, ph=0.0, ty=0.0):
    res, heat = {}, {}
    for nm in ('cote', 'dessus', 'avant', 'arriere'):
        T = m['vrai', nm]; ax, sg = DEPTH[nm]; u, v = grid(nm, T.shape)
        if nm == 'cote': us, vs = (u - tx) / s, (v - ty - ph * u) / s
        elif nm == 'dessus': us, vs = (u - tx) / s, (v - tz) / s
        else: us, vs = (u - tz) / s, (v - ty) / s
        src = nm
        if flip:
            if nm == 'cote': us = -us
            elif nm == 'dessus': us, vs = -us, -vs
            else: us = -us; src = 'arriere' if nm == 'avant' else 'avant'
        S = m['scan', src]; r, c, ok = pix(src, us, vs, S.shape)
        sc = S[r, c]; covS = (sc[..., 3] > 0) & ok; covT = T[..., 3] > 0
        raw = sc[..., ax]
        if flip and ax in (0, 2) and nm != 'cote': raw = -raw
        dS = raw * s + (tx if ax == 0 else tz if ax == 2 else 0); dT = T[..., ax]
        if nm == 'dessus': dS = dS + ph * u + ty
        e = (dS - dT) * sg; both = covS & covT
        if not both.any(): return None, None
        ea = np.abs(e[both])
        res[nm] = dict(iou=round(float(both.sum() / (covS | covT).sum()), 3), moy=round(float(ea.mean() * 100), 1), p90=round(float(np.percentile(ea, 90) * 100), 1), biais=round(float(e[both].mean() * 100), 1))
        if nm == 'cote':
            for lo, hi, lab in ((.35, .75, 'bas'), (.75, 1.0, 'ceinture'), (1.0, 2.0, 'vitres')):
                band = both & (v >= lo) & (v < hi); eb = e[band]
                if eb.size: res[nm][lab] = dict(moy=round(float(np.abs(eb).mean() * 100), 1), biais=round(float(eb.mean() * 100), 1))
        hm = np.full(T.shape[:2], np.nan); hm[both] = e[both]; heat[nm] = (hm, covT, covS)
    return res, heat
def total(r): return 1e9 if r is None else sum(r[k]['moy'] for k in ('cote', 'dessus', 'avant', 'arriere'))
def fit(m):
    a = extents(m, 'vrai'); b = extents(m, 'scan')
    Lt, Ht = a[1] - a[0], a[2]; Ls, Hs = b[1] - b[0], b[2]
    s = (Lt * Ls + Ht * Hs) / (Ls * Ls + Hs * Hs); tx = (a[0] + a[1]) / 2 - s * (b[0] + b[1]) / 2; tz = (a[3] + a[4]) / 2 - s * (b[3] + b[4]) / 2
    s, tx, tz = float(s), float(tx), float(tz)
    dims = dict(vrai=dict(L=round(float(Lt), 3), H=round(float(Ht), 3), W=round(float(a[4] - a[3]), 3)), scan=dict(L=round(float(Ls), 3), H=round(float(Hs), 3), W=round(float(b[4] - b[3]), 3)))
    flip = total(compare(m, s, tx, tz, True)[0]) < total(compare(m, s, tx, tz, False)[0])
    best = (total(compare(m, s, tx, tz, flip)[0]), s, tx, 0.0, 0.0)
    for ds, dx, dp, dy in ((.02, .04, .008, .03), (.006, .012, .003, .01), (.002, .004, .001, .004)):
        s0, t0, p0, y0 = best[1:]
        for ks in range(-2, 3):
            for kx in range(-2, 3):
                for kp in range(-2, 3):
                    for ky in range(-2, 3):
                        c = (s0 + ks * ds, t0 + kx * dx, p0 + kp * dp, y0 + ky * dy); v = total(compare(m, c[0], c[1], tz, flip, c[2], c[3])[0])
                        if v < best[0]: best = (v,) + c
    s, tx, ph, ty = best[1:]
    res, heat = compare(m, s, tx, tz, flip, ph, ty)
    return dict(echelle=round(s, 4), tx=round(tx, 3), tz=round(tz, 3), tangageDeg=round(ph * 57.2958, 2), ty=round(ty, 3), retourne=bool(flip), dims=dims, ecarts=res), heat
def colorize(hm, covT, covS, lim=.10):
    img = np.zeros(hm.shape + (3,), np.uint8); img[:] = (28, 26, 60)
    t = np.clip(np.nan_to_num(hm) / lim, -1, 1)
    red = np.stack([255 * np.ones_like(t), 255 * (1 - t), 255 * (1 - t)], -1); blue = np.stack([255 * (1 + t), 255 * (1 + t), 255 * np.ones_like(t)], -1)
    col = np.where((t >= 0)[..., None], red, blue); b = ~np.isnan(hm); img[b] = col[b].astype(np.uint8)
    img[covT & ~covS] = (60, 200, 90); img[covS & ~covT & ~b] = (250, 160, 40)
    return Image.fromarray(img)

# ---------- bosses : passe-bande 1-4 cm sur la profondeur (5 mm par pixel) ----------
def gauss(a, sig):
    r = int(3 * sig + .5); x = np.arange(-r, r + 1); k = np.exp(-x * x / (2 * sig * sig)); k /= k.sum()
    a = np.apply_along_axis(lambda v: np.convolve(v, k, 'same'), 1, a)
    return np.apply_along_axis(lambda v: np.convolve(v, k, 'same'), 0, a)
def box_min(mask, r):   # érosion (carré de côté 2r+1) par sommes cumulées
    m = mask.astype(np.float64); c = np.pad(m, ((r + 1, r), (r + 1, r))).cumsum(0).cumsum(1); n = (2 * r + 1) ** 2
    s = c[2 * r + 1:, 2 * r + 1:] - c[:-2 * r - 1, 2 * r + 1:] - c[2 * r + 1:, :-2 * r - 1] + c[:-2 * r - 1, :-2 * r - 1]
    return s >= n - .5
def bumps(a, nm, wheels, res=.005):
    ax = 2 if nm == 'cote' else 1; D = a[..., ax].astype(np.float64); M = a[..., 3] > 0
    u, v = grid(nm, a.shape, res)
    gy, gx = np.gradient(np.where(M, D, 0.0), res)
    ok = M & (np.hypot(gx, gy) < 1.0)
    ok = box_min(ok, 6)                                     # 3 cm de marge aux bords et aux cassures
    if nm == 'cote':
        for x, r in wheels: ok &= ~((np.abs(u - x) < r + .12) & (v < 2 * r + .12))
    Dm = np.where(M, D, 0.0); Mf = M.astype(np.float64)
    g1 = gauss(Dm, .01 / res) / np.maximum(gauss(Mf, .01 / res), 1e-6); g4 = gauss(Dm, .04 / res) / np.maximum(gauss(Mf, .04 / res), 1e-6)
    e = np.abs(g1 - g4)[ok] * 1000
    if e.size < 500: return None
    return dict(med=round(float(np.median(e)), 2), p90=round(float(np.percentile(e, 90)), 2), pixels=int(e.size))

# ---------- flou : gradient moyen à l'intérieur de la voiture ----------
def img(u): return Image.open(io.BytesIO(base64.b64decode(u.split(',')[1]))).convert('RGB')
def sharp(shot):
    I = np.asarray(img(shot['img']), np.float64) @ [.3, .59, .11]; M = np.asarray(img(shot['mask']))[..., 0] > 128
    gy, gx = np.gradient(I); ok = box_min(M, 3)
    return float(np.hypot(gx, gy)[ok].mean()) if ok.sum() > 200 else None

def main():
    t0 = time.time()
    info, maps, fine, shots, errs = asyncio.run(browse())
    m = {(w, nm): arr(maps[w][nm]) for w in ('vrai', 'scan') for nm in ('cote', 'dessus', 'avant', 'arriere')}
    forme, heat = fit(m)
    e = forme['ecarts']; forme['moyenne'] = round(sum(e[k]['moy'] for k in e) / len(e), 2)
    # roues du scan (repère d'affichage), placées aussi sur la vraie voiture grâce au calage
    sw = [(w['x'], w['r']) for w in (info.get('wheels') or [])]
    s, tx = forme['echelle'], forme['tx']; tw = [((-x if forme['retourne'] else x) * s + tx, r * s) for x, r in sw]
    bos = {'scan': {}, 'vrai': {}}
    for nm in ('cote', 'dessus'):
        bos['scan'][nm] = bumps(arr(fine['scan'][nm]), nm, sw); bos['vrai'][nm] = bumps(arr(fine['vrai'][nm]), nm, tw)
    by = {(sh['which'], sh['name']): sh for sh in shots}
    flou = {}
    for nm in ('cote', 'proche', 'accueil'):
        a, b = sharp(by['scan', nm]), sharp(by['vrai', nm])
        flou[nm] = round(a / b, 3) if a and b else None
    q = info['q']; bake = q.get('bake') if isinstance(q.get('bake'), dict) else {}
    rep = dict(date=time.strftime('%Y-%m-%d %H:%M'), options=OPTS, modele=(MODELE or {}).get('nom') if isinstance(MODELE, dict) else None,
               forme=forme, bosses=bos, flou=flou,
               scan=dict(ms=info['ms'], version=info.get('v'), sommets=bake.get('sommets'), triangles=bake.get('triangles'), textureKo=bake.get('textureKo'),
                         texelsParMetre=bake.get('texelsParMetre'), vitresPct=bake.get('vitresPct'), lisse=(q.get('fine') or {}).get('lisse'), roues=q.get('roues')),
               erreurs=errs[:10], dureeS=round(time.time() - t0))
    json.dump(rep, open(os.path.join(OUT, 'mesure.json'), 'w'), indent=1, ensure_ascii=False)
    json.dump(q, open(os.path.join(OUT, 'qualite.json'), 'w'), indent=1, ensure_ascii=False)   # bilan complet du scan (q), pour chercher un défaut
    # planche : vraie voiture | scan peint | scan en argile
    names = ['accueil', 'arriere', 'cote', 'dessus', 'proche']; W, H = img(shots[0]['img']).size
    sheet = Image.new('RGB', (W * 3, H * len(names) + 28), (20, 18, 44)); g = ImageDraw.Draw(sheet)
    for i, t in enumerate(('vraie voiture', 'scan (peint)', 'scan (argile : forme seule)')): g.text((i * W + 10, 8), t, fill=(255, 255, 255))
    for k, nm in enumerate(names):
        for i, w in enumerate(('vrai', 'scan', 'argile')): sheet.paste(img(by[w, nm]['img']), (i * W, 28 + k * H))
    sheet.save(os.path.join(OUT, 'planche.png'))
    ims = [colorize(*heat[nm]) for nm in ('cote', 'dessus', 'avant', 'arriere')]
    fw = max(ims[0].width, ims[2].width + ims[3].width + 20); out = Image.new('RGB', (fw, ims[0].height + ims[1].height + ims[2].height), (28, 26, 60))
    out.paste(ims[0], (0, 0)); out.paste(ims[1], (0, ims[0].height)); out.paste(ims[2], (0, ims[0].height + ims[1].height)); out.paste(ims[3], (ims[2].width + 20, ims[0].height + ims[1].height))
    out.save(os.path.join(OUT, 'forme.png'))
    c = e['cote']; bs = bos['scan']; bv = bos['vrai']
    f = lambda d, k: '?' if not d or not d.get(k) else f"{d[k]['med']:.2f}/{d[k]['p90']:.2f}"
    print(f"forme : côté {c['moy']} cm (vitres {c.get('vitres', {}).get('moy')}), dessus {e['dessus']['moy']}, avant {e['avant']['moy']}, arrière {e['arriere']['moy']} → moyenne {forme['moyenne']} cm")
    print(f"bosses (mm, médiane/90e centile) : scan côté {f(bs, 'cote')} dessus {f(bs, 'dessus')} | vraie voiture côté {f(bv, 'cote')} dessus {f(bv, 'dessus')}")
    print(f"flou (netteté scan / vraie voiture) : {flou}")
    print('erreurs de la page :', errs[:3] if errs else 'aucune')
    print('écrit :', os.path.join(OUT, 'mesure.json'), 'planche.png', 'forme.png')
    return 1 if errs else 0

if __name__ == '__main__':
    sys.exit(main())
