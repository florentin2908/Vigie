#!/usr/bin/env python3
"""Film fidèle de l'intro de Vigie, image par image (30 images par seconde exactes).

Usage : python3 outils/film-intro.py docs <dossier_de_sortie> <largeur> <hauteur> <video_de_scan|-> [secondes]
  ex. : python3 outils/film-intro.py docs /tmp/film 390 844 -            (téléphone, dessin Vigie)
        python3 outils/film-intro.py docs /tmp/film 1024 600 /tmp/scan/tour-synthetique.mp4   (écran de voiture, voiture scannée)

Le temps de la page est piloté (paramètre ?vt=1) : minuteries, requestAnimationFrame et animations CSS avancent
d'exactement 1/30 s entre deux captures, quelle que soit la lenteur du rendu logiciel. Avec une vidéo de scan
(outils/video-de-test.py), la voiture est d'abord scannée dans l'appli, puis l'intro est filmée.
Écrit i0000.png…, intro.mp4 (H.264) et planche.png (une image toutes les 0,3 s).
"""
import asyncio, functools, http.server, os, socketserver, sys, threading, time, json, subprocess
SITE, OUT, W, H, VID = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
SECS = float(sys.argv[6]) if len(sys.argv) > 6 else 7.6
NM = os.path.join(os.environ.get('VIGIE_DEPS', '/tmp/vigie-deps'), 'node_modules')
os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT):
    if f.endswith('.png'): os.remove(os.path.join(OUT, f))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Q, directory=SITE)); threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{httpd.server_address[1]}/'
VT_JS = r"""(()=>{ if(new URLSearchParams(location.search).get('vt')!=='1')return;
  let VT=0;const D0=Date.now();window.__VTon=true;
  performance.now=()=>VT;Date.now=()=>D0+VT;
  const timers=new Map();let tid=1;
  window.setTimeout=(fn,ms,...a)=>{const id=tid++;timers.set(id,{due:VT+(+ms||0),fn,a,iv:0});return id;};
  window.setInterval=(fn,ms,...a)=>{const id=tid++;timers.set(id,{due:VT+(+ms||0),fn,a,iv:Math.max(1,+ms||0)});return id;};
  window.clearTimeout=window.clearInterval=id=>{timers.delete(id);};
  let rafs=[],rid=1;
  window.requestAnimationFrame=cb=>{const id=rid++;rafs.push([id,cb]);return id;};
  window.cancelAnimationFrame=id=>{rafs=rafs.filter(r=>r[0]!==id);};
  window.requestIdleCallback=(cb)=>window.setTimeout(()=>cb({didTimeout:false,timeRemaining:()=>10}),1);
  window.__flush=()=>{for(let g=0;g<2000;g++){let b=null;for(const [id,t] of timers)if(t.due<=VT&&(!b||t.due<b[1].due))b=[id,t];if(!b)return;const [id,t]=b;if(t.iv)t.due+=t.iv;else timers.delete(id);try{typeof t.fn==='function'?t.fn(...t.a):0;}catch(e){console.error('minuterie',e&&e.message);}}};
  window.__anims=new Map();
  window.__sync=()=>{for(const an of document.getAnimations()){if(!__anims.has(an)){__anims.set(an,VT);try{an.pause();}catch(e){}}try{an.currentTime=Math.max(0,VT-__anims.get(an));}catch(e){}}};
  window.__frame=(dt)=>{VT+=dt;__flush();const q=rafs;rafs=[];for(const [,cb] of q){try{cb(VT);}catch(e){console.error('image',e&&e.message);}}__flush();__sync();};
  window.__rafs=()=>rafs.length;window.__VT=()=>VT;
})();"""
async def main():
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        c = await b.new_context(viewport={'width': W, 'height': H}, service_workers='block', reduced_motion='no-preference')
        pg = await c.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:300]))
        pg.on('console', lambda m: errs.append(m.type + ': ' + m.text[:200]) if m.type == 'error' and 'Failed to load' not in m.text and 'INFO:' not in m.text else None)
        async def route(r):
            u = r.request.url
            if 'three@0.160.0/' in u: return await r.fulfill(path=os.path.join(NM, 'three', u.split('three@0.160.0/')[1].split('?')[0]), content_type='application/javascript')
            if 'leaflet.js' in u: return await r.fulfill(path=os.path.join(NM, 'leaflet', 'dist', 'leaflet.js'), content_type='application/javascript')
            if u.startswith(BASE): return await r.continue_()
            return await r.abort()
        await pg.route('**/*', route)
        await pg.add_init_script("try{localStorage.setItem('vigie.onboarded','1');if(!localStorage.getItem('vigie.profile'))localStorage.setItem('vigie.profile',JSON.stringify({name:'Florentin',car:'',year:'2015',fuel:'Diesel'}));}catch(e){}")
        await pg.add_init_script(VT_JS)
        if VID != '-':
            await pg.goto(BASE + 'index.html', wait_until='commit'); await pg.wait_for_function("document.body&&document.body.classList.contains('ready')", timeout=90000); await pg.wait_for_timeout(1000)
            await pg.click('.rail-tabs button[data-tab="car"]', force=True); await pg.wait_for_timeout(800)
            await pg.set_input_files('#spinVid', VID)
            await pg.wait_for_function("window.VigieSpin&&!window.VigieSpin.state().busy&&(window.VigieSpin.state().scan||window.VigieSpin.state().scanNote)", timeout=240000)
        await pg.goto(BASE + 'index.html?vt=1', wait_until='commit')
        # temps figé : le chargement réel continue, seules les minuteries immédiates passent
        for k in range(1500):
            await pg.wait_for_timeout(40)
            try:
                st = await pg.evaluate("(()=>{if(!window.__VTon)return 'x';__flush();return ((window.VigieState||{}).introCar||'')+'|'+(window.__rafs?__rafs():0);})()")
            except Exception: continue
            car, n = st.split('|') if '|' in st else ('', '0')
            if car and int(n) > 0: break
        print('intro prête :', st, 'après', round(k * .04, 1), 's réelles', flush=True)
        n = int(SECS * 30)
        for i in range(n):
            await pg.evaluate("__frame(1000/30)")
            await pg.screenshot(path=os.path.join(OUT, f'i{i:04d}.png'))
            if i % 30 == 0: print('image', i, await pg.evaluate("(document.getElementById('splash')||{}).className+' | '+document.body.className"), flush=True)
        print('erreurs :', errs[:6])
        await b.close()
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-framerate', '30', '-i', os.path.join(OUT, 'i%04d.png'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-movflags', '+faststart', os.path.join(OUT, 'intro.mp4')], check=True)
    from PIL import Image, ImageDraw
    import glob
    fs = sorted(glob.glob(os.path.join(OUT, 'i*.png')))[::9]
    th = [Image.open(f).convert('RGB') for f in fs]; th = [im.resize((int(im.width * 300 / im.height), 300)) for im in th]
    cols = 10 if W < H else 5; rows = (len(th) + cols - 1) // cols; tw = th[0].width
    sheet = Image.new('RGB', (tw * cols, 300 * rows), 'black'); d = ImageDraw.Draw(sheet)
    for i, im in enumerate(th): x, y = (i % cols) * tw, (i // cols) * 300; sheet.paste(im, (x, y)); d.text((x + 5, y + 5), f'{i * .3:.1f}s', fill=(255, 255, 0))
    sheet.save(os.path.join(OUT, 'planche.png'))
asyncio.run(main())
