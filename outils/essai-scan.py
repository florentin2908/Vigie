#!/usr/bin/env python3
"""Essai du scan 3D de Vigie sur une vidéo de test dont on connaît la vérité (voir outils/video-de-test.py).

Usage : python3 outils/essai-scan.py <dossier_video_de_test> <dossier_de_sortie> [--deps /tmp/vigie-deps]

Fait tourner le vrai moteur (site/scan3d.js, avec DeepLab) dans Chromium sur tour-synthetique.mp4, puis mesure :
- la voiture reconnue sur combien d'images ;
- l'erreur d'angle de chaque position du téléphone (après alignement de l'origine) ;
- les proportions de la forme (longueur / hauteur, largeur / hauteur) comparées aux vraies ;
- la durée de chaque étape ; et dessine la voiture reconstruite sous 4 angles (scan-vues.png).
Écrit scan-essai.json. Code de sortie 1 si le scan échoue ou si une mesure sort des tolérances.
"""
import argparse, asyncio, base64, functools, http.server, json, math, os, socketserver, sys, threading

ap = argparse.ArgumentParser()
ap.add_argument('video_dir'); ap.add_argument('out')
ap.add_argument('--deps', default='/tmp/vigie-deps')
ap.add_argument('--image-par-image', action='store_true', help='capture par recherche, sans lecture accélérée')
ap.add_argument('--vrais-masques', action='store_true', help='utilise les vrais masques au lieu de DeepLab')
ap.add_argument('--vraie-visee', action='store_true')
ap.add_argument('--variante', default='C')
ap.add_argument('--vraies-positions', action='store_true', help='sculpte avec les vraies positions (pour isoler les erreurs)')
args = ap.parse_args()
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, 'site'); VD = os.path.abspath(args.video_dir); OUT = os.path.abspath(args.out); os.makedirs(OUT, exist_ok=True)
NM = os.path.join(os.path.abspath(args.deps), 'node_modules')
truth = json.load(open(os.path.join(VD, 'tour-synthetique.json')))

HTML = """<!doctype html><html><body style="margin:0;background:#222">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import * as MC from 'three/addons/objects/MarchingCubes.js';
import { scanVideo, buildScanObject } from './scan3d.js';
window.__run = async () => {
  const t0 = performance.now(), times = {}; let last = t0, stage = '';
  const blob = await (await fetch('tour.mp4')).blob();
  const file = new File([blob], 'tour.mp4', { type: 'video/mp4' });
  let rec;
  try {
    rec = await scanVideo(file, { debug: true, variant: window.__VAR, testMasks: window.__MASKS ? async (SW, SH, times) => { const out = [], c = document.createElement('canvas'); c.width = SW; c.height = SH; const g = c.getContext('2d', { willReadFrequently: true });
      for (const t of times) { const k = Math.min(window.__TRUE.frames.length - 1, Math.round(t * window.__TRUE.fps)), im = new Image(); im.src = 'masques/' + String(k).padStart(4, '0') + '.png'; await im.decode(); g.drawImage(im, 0, 0, SW, SH);
        const d = g.getImageData(0, 0, SW, SH).data, m = new Uint8Array(SW * SH); for (let i = 0; i < SW * SH; i++) m[i] = d[i * 4] > 100 ? 1 : 0; out.push(m); } return out; } : null, seekOnly: !!window.__SEEK, truePoses: window.__TRUE && !window.__ONLYMASK ? (times) => times.map(t => { const f = window.__TRUE.frames[Math.min(window.__TRUE.frames.length - 1, Math.round(t * window.__TRUE.fps))]; return { theta: f.az * Math.PI / 180, d: f.dist, yaw: window.__AIM ? f.yaw : undefined, pitch: window.__AIM ? f.pitch : undefined, th: window.__AIM ? f.tgtY : undefined }; }) : null, progress: (s) => { if (s !== stage) { const now = performance.now(); if (stage) times[stage] = Math.round(now - last); last = now; stage = s; } } });
  } catch (e) { return { error: String(e && e.message || e), quality: e && e.quality }; }
  times[stage] = Math.round(performance.now() - last); times.total = Math.round(performance.now() - t0); const durations = times;
  const tb = performance.now(); const obj = await buildScanObject(THREE, MC, rec); durations.affichage = Math.round(performance.now() - tb);
  // 4 vues de la voiture reconstruite
  const W = 480, H = 270, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true }); r.setSize(W, H, false); r.setClearColor(0x30343c, 1);
  r.outputColorSpace = THREE.SRGBColorSpace;
  const sc = new THREE.Scene(); sc.add(obj.group);
  const cam = new THREE.PerspectiveCamera(35, W / H, .05, 100), views = [];
  for (const a of [0, 45, 90, 200]) { const d = 8, rad = a * Math.PI / 180; cam.position.set(Math.cos(rad) * d, 2.2, Math.sin(rad) * d); cam.lookAt(0, .6, 0); r.render(sc, cam); views.push(cv.toDataURL('image/png')); }
  const D = rec.debug;
  return { quality: rec.quality, dims: rec.dims, durations, triangles: obj.triangles, views,
           poses: D.poses, heading: D.heading, top: D.top, side: D.side, times: D.ctimes, theta: D.theta, ok: D.ok, vis: D.vis, dist: D.dist, steps: D.steps, peaks: D.peaks, atlasKB: Math.round(rec.atlas.size / 1024), masks: D.masks, SW: D.SW, SH: D.SH };
};
window.__ready = true;
</script></body></html>"""


class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


def wrap(a):
    return (a + 180) % 360 - 180


async def main():
    from playwright.async_api import async_playwright
    httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Q, directory=SITE))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{httpd.server_address[1]}/'
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome' if os.path.exists('/usr/bin/google-chrome') else None,
                                    args=['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'])
        pg = await b.new_page()
        logs = []
        pg.on('pageerror', lambda e: logs.append('pageerror: ' + str(e)))
        pg.on('console', lambda m: m.type in ('error', 'warning') and logs.append(m.type + ': ' + m.text[:200]))

        async def route(r):
            u = r.request.url
            if 'three@0.160.0/' in u:
                return await r.fulfill(path=os.path.join(NM, 'three', u.split('three@0.160.0/')[1]), content_type='application/javascript')
            if u == base + 'essai.html':
                return await r.fulfill(body=HTML, content_type='text/html; charset=utf-8')
            if u == base + 'tour.mp4':
                return await r.fulfill(path=os.path.join(VD, 'tour-synthetique.mp4'), content_type='video/mp4')
            if u.startswith(base + 'masques/'):
                return await r.fulfill(path=os.path.join(VD, 'masques', u.split('masques/')[1]), content_type='image/png')
            if u.startswith(base):
                return await r.continue_()
            return await r.abort()
        await pg.route('**/*', route)
        await pg.goto(base + 'essai.html')
        await pg.wait_for_function('window.__ready', timeout=30000)
        if args.image_par_image: await pg.evaluate('() => { window.__SEEK = true; }')
        if args.vraies_positions or args.vrais_masques: await pg.evaluate('t => { window.__TRUE = t; }', truth)
        if args.vrais_masques: await pg.evaluate('() => { window.__MASKS = true; }')
        await pg.evaluate('v => { window.__VAR = v; }', args.variante)
        if args.vraie_visee: await pg.evaluate('() => { window.__AIM = true; }')
        if args.vrais_masques and not args.vraies_positions: await pg.evaluate('() => { window.__ONLYMASK = true; }')
        res = await pg.evaluate('window.__run()')
        await b.close()
    rep = {'logs': logs[:20]}
    if 'error' in res:
        rep.update(res); json.dump(rep, open(os.path.join(OUT, 'scan-essai.json'), 'w'), indent=1, ensure_ascii=False)
        print('ÉCHEC du scan :', res); print('\n'.join(logs[:10])); sys.exit(1)
    # Erreur d'angle : on compare chaque image retenue à l'angle vrai au même instant de la vidéo
    fps, nfr = truth['fps'], len(truth['frames']); dur = nfr / fps; N = len(res['theta'])
    diffs = []
    for i in res['vis']:
        k = min(nfr - 1, round(res['times'][i] * fps)); diffs.append(wrap(math.degrees(res['theta'][i]) - truth['frames'][k]['az']))
    mean = math.degrees(math.atan2(sum(math.sin(math.radians(d)) for d in diffs), sum(math.cos(math.radians(d)) for d in diffs)))
    errs = [abs(wrap(d - mean)) for d in diffs]
    # même chose en supposant le sens inverse (pour vérifier que le sens du tour est bien trouvé)
    diffs2 = [wrap(-math.degrees(res['theta'][i]) - truth['frames'][min(nfr - 1, round(res['times'][i] * fps))]['az']) for i in res['vis']]
    mean2 = math.degrees(math.atan2(sum(math.sin(math.radians(d)) for d in diffs2), sum(math.cos(math.radians(d)) for d in diffs2)))
    errs2 = [abs(wrap(d - mean2)) for d in diffs2]
    T = truth['dims']; D = res['dims']
    ratio = lambda a, b: a / b if b else 0
    if res.get('masks'):
        from PIL import Image as _I
        W, H = res['SW'], res['SH']; fpsn = truth['fps']; nf = len(truth['frames']); Nn = len(res['theta'])
        sheet = _I.new('RGB', (W * 2, H * 4))
        for r, (i, m) in enumerate(zip([0, 9, 18, 27], res['masks'])):
            im = _I.new('L', (W, H)); im.putdata([255 if v else 0 for v in m]); sheet.paste(im.convert('RGB'), (0, r * H))
            k = min(nf - 1, round(res['times'][i] * fpsn)); tm = os.path.join(VD, 'masques', f'{k:04d}.png')
            if os.path.exists(tm): sheet.paste(_I.open(tm).convert('L').point(lambda v: 255 if v > 100 else 0).resize((W, H)).convert('RGB'), (W, r * H))
        sheet.save(os.path.join(OUT, 'masques-deeplab-vs-vrais.png'))
    if res.get('top'):
        from PIL import Image as _I
        n = int(len(res['top']) ** .5); a = _I.new('L', (n, n)); a.putdata([255 if v else 0 for v in res['top']]); b = _I.new('L', (n, n)); b.putdata([255 if v else 0 for v in res['side']])
        sh = _I.new('L', (n * 2 + 4, n)); sh.paste(a, (0, 0)); sh.paste(b, (n + 4, 0)); sh.resize(((n * 2 + 4) * 3, n * 3)).save(os.path.join(OUT, 'forme-dessus-cote.png'))
    rep['debug'] = {'poses': res.get('poses'), 'heading': res.get('heading'), 'theta': res['theta'], 'dist': res['dist'], 'vis': res['vis'], 'steps': res['steps'], 'peaks': res['peaks']}
    rep.update({'qualite': res['quality'], 'durees_ms': res['durations'], 'triangles': res['triangles'], 'atlas_ko': res['atlasKB'],
                'angle_erreur_moy_deg': round(sum(errs) / len(errs), 1), 'angle_erreur_max_deg': round(max(errs), 1),
                'angle_erreur_moy_sens_inverse_deg': round(sum(errs2) / len(errs2), 1),
                'dims_scan': {k: round(v, 2) for k, v in D.items()}, 'dims_vraies': {k: round(v, 2) for k, v in T.items()},
                'L/H_scan': round(ratio(D['L'], D['H']), 2), 'L/H_vrai': round(ratio(T['L'], T['H']), 2),
                'W/H_scan': round(ratio(D['W'], D['H']), 2), 'W/H_vrai': round(ratio(T['W'], T['H']), 2)})
    from PIL import Image
    import io
    ims = [Image.open(io.BytesIO(base64.b64decode(v.split(',')[1]))) for v in res['views']]
    sheet = Image.new('RGB', (ims[0].width * 2, ims[0].height * 2))
    for i, im in enumerate(ims): sheet.paste(im, ((i % 2) * im.width, (i // 2) * im.height))
    sheet.save(os.path.join(OUT, 'scan-vues.png'))
    json.dump(rep, open(os.path.join(OUT, 'scan-essai.json'), 'w'), indent=1, ensure_ascii=False)
    for k, v in rep.items():
        if k not in ('logs', 'debug'): print(f'{k} : {v}')
    if logs: print('Journal :', *logs[:8], sep='\n  ')
    bad = []
    if rep['angle_erreur_moy_deg'] > 10: bad.append('angles trop imprécis')
    if abs(rep['L/H_scan'] / rep['L/H_vrai'] - 1) > .2: bad.append('longueur fausse')
    if abs(rep['W/H_scan'] / rep['W/H_vrai'] - 1) > .25: bad.append('largeur fausse')
    if bad: print('HORS TOLÉRANCE :', ', '.join(bad)); sys.exit(1)
    print('Scan dans les tolérances.')

asyncio.run(main())
