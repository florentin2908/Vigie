#!/usr/bin/env python3
"""Banc de test de Vigie.

Usage :
  python3 outils/check.py docs <dossier_de_sortie> [--deps /tmp/vigie-deps] [--no-smoke]
  (docs/ = le site construit par outils/construire-site.py ; un dossier avec un index.html « contenu seul » marche aussi)

Avant : npm install --prefix /tmp/vigie-deps three@0.160.0 leaflet@1.9.4
        pip install playwright pillow (si absents) ; ffmpeg pour la vidéo de test de la vue 360°

Ce que fait le script :
- sert le dossier en http://127.0.0.1 (pour que fetch('changelog.json') et les fichiers relatifs marchent) ;
- si index.html n'a pas de doctype, l'entoure du squelette ajouté par l'outil Artifact à la publication
  (comme la vraie page) ; signale un squelette en double (doctype présent deux fois) ;
- remplace three.js (jsdelivr) et Leaflet (cdnjs) par les copies locales, bloque tout le reste du réseau
  (comme la page Claude : tuiles de carte, GPS et API de prix échouent, le repli doit s'afficher) ;
- attend la fin du démarrage, remplit le premier lancement guidé (prénom, modèle) et vérifie qu'il est sauvegardé ;
- note 3 pleins dans le carnet de pleins (2 complets, 1 complément) et vérifie la conso réelle et l'autonomie ;
- passe la voiture en « Électrique » (batterie, kWh, carnet de recharges), capture, puis revient en Diesel ;
- écrit le modèle « Nissan Qashqai » et vérifie la silhouette SUV, puis ajoute une photo de test et l'affiche sur l'accueil ;
- visite chaque rubrique à 390x844 puis à 1280x720 ;
- clique chaque bouton visible de chaque rubrique (test de fumée) ;
- repère les débordements horizontaux ;
- recharge la page et vérifie la sauvegarde (le premier lancement ne revient pas, prénom, couleur, pleins et photo conservés) ;
- mesure l'animation de lancement (images dessinées et plus long arrêt entre le début de l'animation et la fin du lancement) ;
- vérifie la pastille « Exemple » (semaine, trajets) sans boîtier et la pastille d'état qui se cache quand on descend sur téléphone ;
- (v0.13) change le scénario de démo (pneu crevé, tout va bien, P0420, batterie, réserve) et vérifie le bilan ;
- (v0.13) note une vidange et un contrôle technique dans le carnet d'entretien et vérifie la prochaine vidange et le prochain contrôle ;
- (v0.13) ouvre le mode autoradio à 1024x600 (écran de voiture), 844x390 et 390x844 : chiffres remplis, rien qui dépasse ni rogné,
  bilan, stations, caméra (message clair sans caméra), « Quitter », puis l'ouverture directe par ?mode=autoradio ;
- (v0.13) vérifie les fichiers de l'appli installable (manifeste, icônes, service hors ligne) ;
- (v0.14) vue 360° réelle : fabrique 10 photos puis une vidéo ffmpeg testsrc de 30 s en .mp4 H.264, les donne au Garage,
  vérifie l'extraction (36 images JPEG de 960 px dans IndexedDB, durée), l'affichage 360° de l'accueil, la rotation au glisser,
  la rotation lente quand on ne touche pas, et la conservation après rechargement ;
- écrit report.json et contact.jpg (planche de captures à regarder une fois).
Code de sortie 1 s'il y a une erreur JavaScript.
"""
import asyncio, json, os, sys, threading, functools, http.server, socketserver, time, argparse, subprocess

ap = argparse.ArgumentParser()
ap.add_argument('site'); ap.add_argument('out')
ap.add_argument('--deps', default='/tmp/vigie-deps')
ap.add_argument('--no-smoke', action='store_true')
args = ap.parse_args()
SITE = os.path.abspath(args.site); OUT = os.path.abspath(args.out); DEPS = os.path.abspath(args.deps)
os.makedirs(OUT, exist_ok=True)
NM = os.path.join(DEPS, 'node_modules')

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
handler = functools.partial(Quiet, directory=SITE)
httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{PORT}/'

from playwright.async_api import async_playwright
from PIL import Image

errors, shots, overflow, clicked = [], [], [], []

# Squelette ajouté par l'outil Artifact à la publication (copié de la page publiée le 17 nov. 2026)
SKELETON = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>\n'
PAGE = open(os.path.join(SITE, 'index.html'), encoding='utf-8').read()
if PAGE.lower().count('<!doctype') > 1:
    errors.append('contrôle : squelette de page en double dans index.html (retirer la 1re ligne <!doctype…<body> et le </body></html> final)')
if not PAGE.lstrip().lower().startswith('<!doctype'):
    PAGE = SKELETON + PAGE + '\n</body></html>'


async def route(r):
    u = r.request.url
    if 'cdn.jsdelivr.net/npm/three@0.160.0/' in u:
        path = os.path.join(NM, 'three', u.split('three@0.160.0/')[1].split('?')[0])
        if os.path.exists(path):
            return await r.fulfill(path=path, content_type='application/javascript')
        return await r.abort()
    if 'cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js' in u:
        return await r.fulfill(path=os.path.join(NM, 'leaflet', 'dist', 'leaflet.js'), content_type='application/javascript')
    if u.split('?')[0] == BASE + 'index.html':
        return await r.fulfill(body=PAGE, content_type='text/html; charset=utf-8')
    if u.startswith(BASE):
        return await r.continue_()
    return await r.abort()

def on_console(m):
    if m.type != 'error': return
    t = m.text
    if 'Failed to load resource' in t or 'net::ERR' in t: return
    errors.append('console: ' + t[:400])

OVERFLOW_JS = """() => {
  const main = document.querySelector('#main'); if (!main) return [];
  const view = document.querySelector('.view.on'); if (!view) return [];
  const lim = main.getBoundingClientRect().right + 1, bad = [];
  if (main.scrollWidth > main.clientWidth + 1) bad.push('main déborde de ' + (main.scrollWidth - main.clientWidth) + ' px');
  for (const el of view.querySelectorAll('*')) {
    if (el.closest('.prompts,.chatlog,.leaflet-container,svg,canvas')) continue;
    const r = el.getBoundingClientRect();
    if (r.width && r.right > lim) {
      bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.')) + ' dépasse de ' + Math.round(r.right - lim) + ' px');
      if (bad.length > 8) break;
    }
  }
  return bad;
}"""

# Mesure du lancement : images dessinées entre le début de l'animation (#splash.s1) et la fin (body.ready)
INTRO_JS = """
window.__vm={f:[],s1:0,ready:0};
(function loop(){window.__vm.f.push(performance.now());if(!window.__vm.ready)requestAnimationFrame(loop);})();
new MutationObserver(()=>{const s=document.getElementById('splash');if(s&&s.classList.contains('s1')&&!__vm.s1)__vm.s1=performance.now();if(document.body&&document.body.classList.contains('ready')&&!__vm.ready)__vm.ready=performance.now();}).observe(document,{subtree:true,attributes:true,childList:true});
"""
INTRO_STATS = """() => { const m = window.__vm || {f: []}, f = m.f.filter(t => t >= m.s1 - 50 && t <= m.ready); let gap = 0;
  for (let i = 1; i < f.length; i++) gap = Math.max(gap, f[i] - f[i - 1]);
  return {images: Math.max(0, f.length - 1), pire_arret_ms: Math.round(gap), duree_ms: Math.round(m.ready - m.s1)}; }"""
intro = {}
rendu = {}
vue360 = {}

async def honesty(pg):
    try:
        await goto_tab(pg, 'drive')
        st = await pg.evaluate("() => ({n: [...document.querySelectorAll('#v-drive [data-ex]')].filter(e => !e.hidden && e.offsetParent).length, note: (document.querySelector('#tripList') || {}).textContent || ''})")
        if st['n'] < 2: errors.append(f"contrôle : sans boîtier, {st['n']} pastille(s) « Exemple » visible(s) au lieu de 2 (semaine, trajets)")
        if 'exemple' not in st['note'].lower(): errors.append('contrôle : les trajets d\'exemple ne sont pas signalés')
        await goto_tab(pg, 'home')
        if await pg.is_visible('#mStatus'):
            await pg.evaluate("document.querySelector('#main').scrollTo(0, 600)"); await pg.wait_for_timeout(500)
            down = await pg.evaluate("document.querySelector('#mStatus').classList.contains('away')")
            await pg.evaluate("document.querySelector('#main').scrollTo(0, 0)"); await pg.wait_for_timeout(500)
            up = await pg.evaluate("document.querySelector('#mStatus').classList.contains('away')")
            if not down or up: errors.append('contrôle : la pastille d\'état ne se cache pas en descendant ou ne revient pas en remontant')
    except Exception as e:
        errors.append('contrôle : pastilles « Exemple » ou d\'état bloquées : ' + str(e).splitlines()[0][:120])

async def snap(pg, name):
    p = os.path.join(OUT, name + '.png'); await pg.screenshot(path=p); shots.append(p)

async def tabs(pg):
    return await pg.eval_on_selector_all('.rail-tabs button[data-tab]', 'b => b.map(x => x.dataset.tab)')

async def goto_tab(pg, tab):
    await pg.click(f'.rail-tabs button[data-tab="{tab}"]', timeout=20000, force=True)
    await pg.wait_for_timeout(1600)

async def smoke(pg, tab):
    sel = '.view.on button:not([disabled])'
    n = await pg.eval_on_selector_all(sel, 'b => b.length')
    for i in range(min(n, 30)):
        if await pg.evaluate('window.VigieState && window.VigieState.tab') != tab:
            await goto_tab(pg, tab)
        btns = await pg.query_selector_all(sel)
        if i >= len(btns): break
        b = btns[i]
        if not await b.is_visible(): continue
        label = (await b.inner_text()).strip().replace('\n', ' ')[:40] or await b.get_attribute('aria-label') or '?'
        before = len(errors)
        try:
            # 15 s : en rendu logiciel, une image de la 3D prend plus d'une seconde (même mesure avant et après v0.11)
            await b.scroll_into_view_if_needed(timeout=15000)
            await b.click(timeout=8000, force=True)
        except Exception as e:
            errors.append(f'clic impossible [{tab}] « {label} » : {str(e).splitlines()[0][:120]}')
        await pg.wait_for_timeout(450)
        await pg.evaluate("() => { for (const id of ['#sheet', '#onboard']) { const s = document.querySelector(id); if (s) s.classList.remove('open'); } if (window.VigieRadio) window.VigieRadio.close(); }")
        clicked.append(f'{tab}: {label}' + ('  ← ERREUR' if len(errors) > before else ''))

async def onboarding(pg):
    is_open = "() => { const o = document.querySelector('#onboard'); return !!(o && o.classList.contains('open')); }"
    try:
        await pg.wait_for_function(is_open, timeout=4000)
    except Exception:
        errors.append('contrôle : le premier lancement guidé ne s\'affiche pas')
        return
    await snap(pg, 'tel_premier_lancement')
    try:
        await pg.fill('#ob-name', 'Testeur')
        await pg.click('#obNext'); await pg.wait_for_timeout(500)
        await pg.fill('#ob-car', 'Citadine de test')
        await pg.click('#obNext'); await pg.wait_for_timeout(500)
        await snap(pg, 'tel_premier_lancement_3')
        await pg.click('#obNext'); await pg.wait_for_timeout(1000)
    except Exception as e:
        errors.append('contrôle : premier lancement bloqué : ' + str(e).splitlines()[0][:120]); return
    st = await pg.evaluate("() => ({open: document.querySelector('#onboard').classList.contains('open'), flag: localStorage.getItem('vigie.onboarded'), prof: JSON.parse(localStorage.getItem('vigie.profile') || '{}'), h1: (document.querySelector('[data-k=name]') || {}).textContent})")
    if st['open']: errors.append('contrôle : le premier lancement reste ouvert après « Voir la démo »')
    if st['flag'] != '1': errors.append('contrôle : le premier lancement n\'est pas marqué comme vu')
    if st['prof'].get('name') != 'Testeur' or st['prof'].get('car') != 'Citadine de test':
        errors.append('contrôle : prénom ou modèle du premier lancement non sauvegardé')
    if st['h1'] != 'Testeur': errors.append('contrôle : le prénom saisi ne s\'affiche pas sur l\'accueil')

FUEL_TEST = [  # date, km, litres, champ prix, prix, complet
    ('2026-10-01', '120000', '40', 'tot', '68', True),
    ('2026-10-20', '120600', '20', 'pl', '1,70', False),
    ('2026-11-10', '121200', '30', 'tot', '52,50', True),
]
async def fuel_log(pg):
    if not await pg.query_selector('#fuelAdd'):
        errors.append('contrôle : carnet de pleins absent'); return
    try:
        await goto_tab(pg, 'drive')
        for d, km, l, kind, price, full in FUEL_TEST:
            await pg.click('#fuelAdd', force=True); await pg.wait_for_timeout(300)
            await pg.fill('#fu-date', d); await pg.fill('#fu-km', km); await pg.fill('#fu-l', l)
            await pg.fill('#fu-' + kind, price)
            if (await pg.is_checked('#fu-full')) != full:
                await pg.click('#fuelForm .switch', force=True)
            await pg.click('#fuelSave', force=True); await pg.wait_for_timeout(400)
            err = (await pg.text_content('#fuelErr') or '').strip()
            if err: errors.append('contrôle : plein refusé : ' + err)
        await pg.wait_for_timeout(900)
        await snap(pg, 'tel_carnet_pleins')
        st = await pg.evaluate("() => ({n: JSON.parse(localStorage.getItem('vigie.fuel') || '[]').length, conso: document.querySelector('#fsConso').textContent, km: document.querySelector('#fsKm').textContent, note: (document.querySelector('[data-k=rangeNote]') || {}).textContent || ''})")
    except Exception as e:
        errors.append('contrôle : carnet de pleins bloqué : ' + str(e).splitlines()[0][:120]); return
    if st['n'] != 3: errors.append(f"contrôle : {st['n']} plein(s) sauvegardé(s) au lieu de 3")
    if st['conso'] != '4,2': errors.append(f"contrôle : conso réelle affichée « {st['conso']} » au lieu de « 4,2 »")
    if st['km'] != '0,072': errors.append(f"contrôle : coût au km affiché « {st['km']} » au lieu de « 0,072 »")
    if 'conso réelle' not in st['note']: errors.append('contrôle : l\'autonomie n\'utilise pas la conso réelle du carnet')

async def set_energy(pg, value):
    await goto_tab(pg, 'car')
    await pg.select_option('#f-fuel', value)
    await pg.click('#profileForm button[type=submit]', force=True)
    await pg.wait_for_timeout(500)

async def energy(pg):
    try:
        await set_energy(pg, 'Électrique')
        lab = await pg.text_content('label[for=f-tank]')
        await goto_tab(pg, 'drive')
        await pg.wait_for_timeout(1200)
        st = await pg.evaluate("() => ({store: document.querySelector('#v-drive [data-u=store]').textContent, unit: document.querySelector('#v-drive [data-u=e]').textContent, log: document.querySelector('#v-drive [data-u=log]').textContent, ev: document.body.classList.contains('ev'), prof: JSON.parse(localStorage.getItem('vigie.profile') || '{}'), note: (document.querySelector('[data-k=rangeNote]') || {}).textContent || ''})")
        await snap(pg, 'tel_conduite_electrique')
        await pg.evaluate("document.querySelector('#main').scrollTo(0, 1e6)"); await pg.wait_for_timeout(700)
        await snap(pg, 'tel_conduite_electrique_bas')
        await pg.evaluate("document.querySelector('#main').scrollTo(0, 0)")
        if lab != 'Batterie utile (kWh)': errors.append(f'contrôle : électrique, libellé « {lab} » au lieu de « Batterie utile (kWh) »')
        if st['store'] != 'Batterie' or st['unit'] != 'kWh' or st['log'] != 'Carnet de recharges' or not st['ev']:
            errors.append(f"contrôle : affichage électrique incomplet : {st['store']} / {st['unit']} / {st['log']}")
        if not (8 <= st['prof'].get('conso', 0) <= 40) or st['prof'].get('price', 9) > 1:
            errors.append(f"contrôle : conso ou prix non adaptés à l'électrique ({st['prof'].get('conso')} / {st['prof'].get('price')})")
        if 'kWh/100' not in st['note']: errors.append('contrôle : la note d\'autonomie n\'est pas en kWh/100')
        await set_energy(pg, 'Diesel')
        back = await pg.evaluate("() => ({ev: document.body.classList.contains('ev'), conso: JSON.parse(localStorage.getItem('vigie.profile') || '{}').conso})")
        if back['ev'] or back['conso'] > 12: errors.append('contrôle : retour au Diesel incomplet')
    except Exception as e:
        errors.append('contrôle : bascule électrique bloquée : ' + str(e).splitlines()[0][:120])

async def body_and_photo(pg):
    try:
        await goto_tab(pg, 'car')
        await pg.fill('#f-car', 'Nissan Qashqai')
        await pg.click('#profileForm button[type=submit]', force=True); await pg.wait_for_timeout(1500)
        st = await pg.evaluate("() => ({body: window.VigieState.body, note: (document.querySelector('[data-k=bodyNote]') || {}).textContent || ''})")
        if st['body'] != 'suv' or 'SUV' not in st['note']:
            errors.append(f"contrôle : silhouette « {st['body']} » au lieu de SUV pour un Qashqai")
        await goto_tab(pg, 'home'); await pg.wait_for_timeout(1200)
        await snap(pg, 'tel_accueil_suv')
        img = os.path.join(OUT, 'photo-test.jpg')
        im = Image.new('RGB', (1600, 1000), (40, 70, 120))
        from PIL import ImageDraw
        d = ImageDraw.Draw(im); d.rectangle([300, 450, 1300, 760], fill=(200, 205, 215)); d.ellipse([420, 680, 620, 880], fill=(20, 20, 24)); d.ellipse([980, 680, 1180, 880], fill=(20, 20, 24))
        im.save(img, quality=85)
        await goto_tab(pg, 'car')
        await pg.set_input_files('#photoIn', img); await pg.wait_for_timeout(1500)
        ph = await pg.evaluate("() => ({stored: (localStorage.getItem('vigie.photo') || '').slice(0, 15), shown: !document.querySelector('#photoImg').hidden})")
        if not ph['stored'].startswith('data:image/jpeg') or not ph['shown']:
            errors.append('contrôle : la photo de la voiture n\'est pas enregistrée ou pas affichée')
        await goto_tab(pg, 'home'); await pg.wait_for_timeout(800)
        vis = await pg.evaluate("() => !document.querySelector('#stageSwitch').hidden && document.querySelector('#homeStage').classList.contains('photo')")
        if not vis: errors.append('contrôle : la photo ne s\'affiche pas sur l\'accueil')
        await snap(pg, 'tel_accueil_photo')
        await pg.click('#stageSwitch button[data-view="3d"]', force=True); await pg.wait_for_timeout(600)
    except Exception as e:
        errors.append('contrôle : silhouette ou photo bloquée : ' + str(e).splitlines()[0][:120])

async def demo_scenarios(pg):
    try:
        await goto_tab(pg, 'car')
        res = {}
        for k in ['flat', 'ok', 'p0420', 'batt', 'low']:
            await pg.select_option('#demoSc', k); await pg.wait_for_timeout(1000)
            res[k] = await pg.evaluate("() => ({t: document.querySelector('#hbTitle').textContent, s: document.querySelector('#hbSub').textContent, bad: document.querySelector('#healthBar').classList.contains('bad')})")
        await pg.select_option('#demoSc', 'base'); await pg.wait_for_timeout(600)
        if not res['flat']['bad'] or 'arrière droit' not in res['flat']['s']: errors.append(f"contrôle : scénario « Pneu crevé » mal affiché : {res['flat']}")
        if res['ok']['t'] != 'Tout est en ordre': errors.append(f"contrôle : scénario « Tout va bien » affiche « {res['ok']['t']} »")
        if 'P0420' not in res['p0420']['s']: errors.append(f"contrôle : scénario « P0420 » mal affiché : {res['p0420']}")
        if not res['batt']['bad'] or 'Batterie' not in res['batt']['s']: errors.append(f"contrôle : scénario « Batterie faible » mal affiché : {res['batt']}")
        if 'réserve' not in res['low']['s'].lower(): errors.append(f"contrôle : scénario « Réserve » mal affiché : {res['low']}")
        if await pg.evaluate("localStorage.getItem('vigie.demo')") != 'base': errors.append('contrôle : le scénario de démo n\'est pas sauvegardé')
    except Exception as e:
        errors.append('contrôle : scénarios de démo bloqués : ' + str(e).splitlines()[0][:120])

async def carnet(pg):
    try:
        await goto_tab(pg, 'sante')
        for op, d, km, prix in [('vidange', '2026-09-01', '125000', '89,90'), ('ct', '2025-12-10', '118000', '')]:
            await pg.click('#cnAdd', force=True); await pg.wait_for_timeout(400)
            await pg.select_option('#cn-op', op)
            await pg.fill('#cn-date', d); await pg.fill('#cn-km', km); await pg.fill('#cn-prix', prix)
            await pg.click('#cnSave', force=True); await pg.wait_for_timeout(500)
            err = (await pg.text_content('#cnErr') or '').strip()
            if err: errors.append('contrôle : opération d\'entretien refusée : ' + err)
        st = await pg.evaluate("() => ({n: JSON.parse(localStorage.getItem('vigie.carnet') || '[]').length, service: JSON.parse(localStorage.getItem('vigie.profile') || '{}').service, txt: document.querySelector('#carnet').textContent, form: !document.querySelector('#cnForm').hidden})")
        await pg.evaluate("document.querySelector('#carnetCard').scrollIntoView({block: 'center'})"); await pg.wait_for_timeout(600)
        await snap(pg, 'tel_carnet_entretien')
        if st['n'] != 2: errors.append(f"contrôle : {st['n']} opération(s) d'entretien sauvegardée(s) au lieu de 2")
        if st['service'] != 145000: errors.append(f"contrôle : prochaine vidange à {st['service']} km au lieu de 145 000 km (vidange à 125 000 km + 20 000 km)")
        if 'décembre 2027' not in st['txt']: errors.append('contrôle : le prochain contrôle technique (décembre 2027) n\'est pas calculé')
        if 'Vidange + filtre à huile' not in st['txt']: errors.append('contrôle : la vidange notée n\'apparaît pas dans le carnet')
        if st['form']: errors.append('contrôle : le formulaire du carnet reste ouvert après l\'enregistrement')
    except Exception as e:
        errors.append('contrôle : carnet d\'entretien bloqué : ' + str(e).splitlines()[0][:120])

IDB_JS = """() => new Promise(r => {
  const q = indexedDB.open('vigie');
  q.onsuccess = () => { try { const g = q.result.transaction('spin').objectStore('spin').get('current');
    g.onsuccess = () => { const v = g.result; q.result.close(); r(v ? {n: v.frames.length, w: v.w, h: v.h, type: v.frames[0].type, tailles: new Set(v.frames.map(b => b.size)).size, src: v.src} : null); };
    g.onerror = () => r(null); } catch (e) { r(null); } };
  q.onerror = () => r(null);
})"""

async def spin360(pg):
    vid = os.path.join(OUT, 'tour-test.mp4')
    try:
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=30:size=1280x720:rate=30',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', vid], check=True, timeout=180)
    except Exception as e:
        errors.append('contrôle : vue 360° non testée, ffmpeg absent ou en échec : ' + str(e)[:100]); return
    from PIL import ImageDraw
    pics = []
    for i in range(10):
        im = Image.new('RGB', (1600, 900), (30 + i * 15, 40, 90)); d = ImageDraw.Draw(im)
        d.rectangle([300 + i * 60, 380, 1000 + i * 30, 640], fill=(210, 215, 225)); d.ellipse([400 + i * 50, 580, 560 + i * 50, 740], fill=(15, 15, 20))
        f = os.path.join(OUT, f'tour-photo-{i:02d}.jpg'); im.save(f, quality=85); pics.append(f)
    try:
        await goto_tab(pg, 'car')
        await pg.set_input_files('#spinPics', pics)
        await pg.wait_for_function("window.VigieSpin && !window.VigieSpin.state().busy && window.VigieSpin.state().n === 10", timeout=60000)
        t0 = time.time()
        await pg.set_input_files('#spinVid', vid)
        await pg.wait_for_function("window.VigieSpin && !window.VigieSpin.state().busy && (window.VigieSpin.state().src === 'video' || document.querySelector('#spinErr').textContent)", timeout=120000)
        secs = round(time.time() - t0, 1)
        st = await pg.evaluate("() => Object.assign(window.VigieSpin.state(), {err: document.querySelector('#spinErr').textContent})")
        db = await pg.evaluate(IDB_JS)
        vue360.update({'extraction_s': secs, 'extraction_ms_appli': st['ms'], 'images': st['n'], 'stockage': db})
        if st['err']: errors.append('contrôle : vue 360° refusée : ' + st['err'])
        if st['n'] != 36: errors.append(f"contrôle : {st['n']} image(s) tirée(s) de la vidéo au lieu de 36")
        if not db or db['n'] != 36 or db['w'] != 960 or db['type'] != 'image/jpeg' or db['src'] != 'video':
            errors.append(f'contrôle : la vue 360° n\'est pas gardée comme prévu dans IndexedDB : {db}')
        elif db['tailles'] < 30: errors.append('contrôle : les images de la vue 360° se ressemblent trop (extraction figée ?)')
        if st['ms'] and st['ms'] > 15000: errors.append(f"contrôle : extraction de la vue 360° en {st['ms'] / 1000:.1f} s (objectif : moins de 15 s)")
        await pg.evaluate("document.querySelector('#spinCard').scrollIntoView({block: 'center'})"); await pg.wait_for_timeout(800)
        await snap(pg, 'tel_garage_360')
        await goto_tab(pg, 'home'); await pg.evaluate("document.querySelector('#main').scrollTo(0, 0)"); await pg.wait_for_timeout(1000)
        vis = await pg.evaluate("() => ({spin: document.querySelector('#homeStage').classList.contains('is360'), btn: !document.querySelector('#stageSwitch button[data-view=spin]').hidden, w: document.querySelector('#stageSpin img').naturalWidth, src: (document.querySelector('#stageSpin img').getAttribute('src') || '').slice(0, 5), pause3d: window.VigieState.photoView})")
        if not (vis['spin'] and vis['btn'] and vis['src'] == 'blob:' and vis['w'] == 960 and vis['pause3d']):
            errors.append(f'contrôle : la vue 360° ne s\'affiche pas sur l\'accueil : {vis}')
        await snap(pg, 'tel_accueil_360')
        a0 = await pg.evaluate('window.VigieSpin.homeAngle()'); f0 = await pg.evaluate('window.VigieSpin.homeFrame()')
        box = await pg.locator('#stageSpin').bounding_box()
        cx, cy = box['x'] + box['width'] * .75, box['y'] + box['height'] / 2
        await pg.mouse.move(cx, cy); await pg.mouse.down()
        for k in range(1, 11):
            await pg.mouse.move(cx - k * 18, cy); await pg.wait_for_timeout(30)
        await pg.mouse.up(); await pg.wait_for_timeout(400)
        a1 = await pg.evaluate('window.VigieSpin.homeAngle()'); f1 = await pg.evaluate('window.VigieSpin.homeFrame()')
        vue360.update({'glisser_degres': round(a1 - a0), 'image_avant': f0, 'image_apres': f1})
        if abs(a1 - a0) < 30 or f1 == f0: errors.append(f'contrôle : glisser ne fait pas tourner la vue 360° ({a0:.0f}° → {a1:.0f}°)')
        await pg.wait_for_timeout(4500)
        a2 = await pg.evaluate('window.VigieSpin.homeAngle()')
        vue360['rotation_lente_degres'] = round(a2 - a1)
        if abs(a2 - a1) < 5: errors.append('contrôle : la vue 360° ne tourne pas toute seule quand on ne la touche pas')
        await snap(pg, 'tel_accueil_360_tourne')
    except Exception as e:
        errors.append('contrôle : vue 360° bloquée : ' + str(e).splitlines()[0][:140])

RADIO_JS = """() => {
  const r = document.querySelector('#radio'); if (!r) return {open: false};
  const W = innerWidth, H = innerHeight, portrait = H > W, bad = [];
  for (const el of r.querySelectorAll('*')) {
    if (el.closest('[hidden],svg,canvas,.gl-host')) continue;
    const b = el.getBoundingClientRect(); if (!b.width) continue;
    const name = el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.');
    if (b.right > W + 1 || b.left < -1) bad.push(name + ' dépasse sur le côté');
    else if (!portrait && b.bottom > H + 1) bad.push(name + ' dépasse en bas de ' + Math.round(b.bottom - H) + ' px');
    if (bad.length > 8) break;
  }
  const clip = [...r.querySelectorAll('.rd-card')].filter(c => c.scrollHeight > c.clientHeight + 2).map(c => 'carte « ' + ((c.querySelector('.rd-k') || {}).textContent || 'vitesse').trim().slice(0, 24) + ' » rognée de ' + (c.scrollHeight - c.clientHeight) + ' px');
  const cut = [...r.querySelectorAll('.rd-v,.rd-sv b,.rd-btn span,.rd-k>span:first-child,.rd-k .stat>span,.rd-tg .tc')].filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map(e => '« ' + e.textContent.trim().slice(0, 24) + ' » coupé');
  return {open: r.classList.contains('open'), shell: getComputedStyle(document.querySelector('.shell')).visibility, speed: (r.querySelector('.rd-sv b') || {}).textContent, range: (r.querySelector('[data-k=range]') || {}).textContent, tires: [...r.querySelectorAll('.rd-tg [data-k]')].map(e => e.textContent), clock: (document.querySelector('#rdClock') || {}).textContent || '', bad, clip, cut};
}"""

async def radio(pg):
    try:
        await pg.set_viewport_size({'width': 1024, 'height': 600}); await pg.wait_for_timeout(800)
        await goto_tab(pg, 'home')
        await pg.click('#qaRadio', force=True); await pg.wait_for_timeout(3000)
        st = await pg.evaluate(RADIO_JS)
        if not st.get('open'): errors.append('contrôle : le mode autoradio ne s\'ouvre pas'); return
        if st['shell'] != 'hidden': errors.append('contrôle : l\'appli reste visible sous le mode autoradio')
        if st['speed'] in ('—', '') or st['range'] in ('—', '') or '—' in st['tires']:
            errors.append(f"contrôle : chiffres manquants en mode autoradio (vitesse {st['speed']}, autonomie {st['range']}, pneus {st['tires']})")
        if ':' not in st['clock']: errors.append('contrôle : l\'horloge du mode autoradio est vide')
        for o in st['bad'] + st['clip'] + st['cut']: overflow.append('1024x600 [autoradio] ' + o)
        await snap(pg, 'autoradio_1024x600')
        await pg.click('#rdBilan', force=True); await pg.wait_for_timeout(800)
        if await pg.evaluate("document.querySelectorAll('#rdPanB .finding').length") < 1: errors.append('contrôle : le bilan du mode autoradio est vide')
        await snap(pg, 'autoradio_bilan')
        await pg.click('#rdPanX', force=True); await pg.wait_for_timeout(300)
        await pg.click('#rdStations', force=True); await pg.wait_for_timeout(500)
        if 'sur la carte' not in (await pg.text_content('#rdPanB') or ''): errors.append('contrôle : le panneau Stations n\'explique pas le repli')
        await pg.click('#rdPanX', force=True); await pg.wait_for_timeout(300)
        await pg.click('#rdCamBtn', force=True); await pg.wait_for_timeout(1800)
        cam = await pg.evaluate("() => ({shown: !document.querySelector('#rdCam').hidden, live: document.querySelector('#rdCam').classList.contains('live'), msg: document.querySelector('#rdCamMsg').textContent})")
        if not cam['shown'] or (not cam['live'] and (not cam['msg'] or 'Ouverture' in cam['msg'])): errors.append(f"contrôle : la caméra n'affiche ni image ni message clair ({cam})")
        await snap(pg, 'autoradio_camera')
        await pg.click('#rdCamX', force=True); await pg.wait_for_timeout(300)
        for w, h in [(844, 390), (390, 844)]:
            await pg.set_viewport_size({'width': w, 'height': h}); await pg.wait_for_timeout(1600)
            st = await pg.evaluate(RADIO_JS)
            for o in st['bad'] + st['clip'] + st['cut']: overflow.append(f'{w}x{h} [autoradio] ' + o)
            await snap(pg, f'autoradio_{w}x{h}')
        await pg.click('#rdExit', force=True); await pg.wait_for_timeout(800)
        st = await pg.evaluate("() => ({open: document.querySelector('#radio').classList.contains('open'), on: document.body.classList.contains('radio-on')})")
        if st['open'] or st['on']: errors.append('contrôle : « Quitter » ne ferme pas le mode autoradio')
        await pg.set_viewport_size({'width': 1024, 'height': 600})
        await pg.goto(BASE + 'index.html?mode=autoradio', wait_until='commit')
        await pg.wait_for_function("document.body && document.body.classList.contains('ready')", timeout=45000)
        await pg.wait_for_timeout(3500)
        if not await pg.evaluate("document.querySelector('#radio').classList.contains('open')"): errors.append('contrôle : ?mode=autoradio n\'ouvre pas le mode autoradio')
        await snap(pg, 'autoradio_url')
        await pg.evaluate("window.VigieRadio && window.VigieRadio.close()")
    except Exception as e:
        errors.append('contrôle : mode autoradio bloqué : ' + str(e).splitlines()[0][:120])

def pwa_static():
    try:
        page = open(os.path.join(SITE, 'index.html'), encoding='utf-8').read()
        if 'rel="manifest"' not in page: errors.append('contrôle : index.html ne déclare pas le manifeste'); return
        m = json.load(open(os.path.join(SITE, 'manifest.webmanifest'), encoding='utf-8'))
        for k in ('name', 'short_name', 'start_url', 'display', 'icons'):
            if not m.get(k): errors.append(f'contrôle : manifeste sans « {k} »')
        sizes = set()
        for ic in m.get('icons', []):
            f = os.path.join(SITE, ic['src'])
            if not os.path.exists(f): errors.append(f"contrôle : icône manquante {ic['src']}"); continue
            if ic['src'].endswith('.png'):
                w, h = Image.open(f).size
                if f'{w}x{h}' != ic['sizes']: errors.append(f"contrôle : icône {ic['src']} en {w}x{h} au lieu de {ic['sizes']}")
                sizes.add(w)
        if not {192, 512} <= sizes: errors.append('contrôle : il faut des icônes PNG 192 et 512 px')
        sw = open(os.path.join(SITE, 'sw.js'), encoding='utf-8').read()
        import re
        shell = re.search(r"SHELL\s*=\s*\[(.*?)\]", sw, re.S)
        for f in re.findall(r"'([^']+)'", shell.group(1) if shell else ''):
            if f != './' and not os.path.exists(os.path.join(SITE, f)): errors.append(f'contrôle : sw.js met en cache un fichier absent : {f}')
    except Exception as e:
        errors.append('contrôle : fichiers de l\'appli installable illisibles : ' + str(e).splitlines()[0][:120])

async def persistence(pg):
    before = await pg.evaluate("() => JSON.parse(localStorage.getItem('vigie.profile') || '{}')")
    await pg.reload(wait_until='commit')
    try:
        await pg.wait_for_function("document.body && document.body.classList.contains('ready')", timeout=45000)
    except Exception:
        errors.append('le démarrage ne se termine pas après rechargement'); return
    await pg.wait_for_timeout(2500)
    st = await pg.evaluate("() => ({open: document.querySelector('#onboard') ? document.querySelector('#onboard').classList.contains('open') : false, paint: window.VigieState && window.VigieState.paint, label: (document.querySelector('#paintName') || {}).textContent, on: (document.querySelector('.sw.on') || {getAttribute: () => null}).getAttribute('aria-label'), h1: (document.querySelector('[data-k=name]') || {}).textContent})")
    if st['open']: errors.append('contrôle : le premier lancement réapparaît après rechargement')
    if before.get('paint') and str(st['paint']).lower() != str(before['paint']).lower():
        errors.append('contrôle : la couleur choisie est perdue après rechargement')
    if not st['label'] or st['label'] != st['on']:
        errors.append('contrôle : la couleur choisie ne s\'affiche pas dans « Couleur »')
    if before.get('name') and st['h1'] != before['name']:
        errors.append('contrôle : le prénom est perdu après rechargement')
    if not await pg.evaluate("() => !!localStorage.getItem('vigie.photo') && !document.querySelector('#photoImg').hidden"):
        errors.append('contrôle : la photo est perdue après rechargement')
    f = await pg.evaluate("() => ({n: JSON.parse(localStorage.getItem('vigie.fuel') || '[]').length, conso: (document.querySelector('#fsConso') || {}).textContent})")
    if f['n'] < 3 or f['conso'] in (None, '—'):
        errors.append('contrôle : les pleins ou la conso réelle sont perdus après rechargement')
    c = await pg.evaluate("() => ({n: JSON.parse(localStorage.getItem('vigie.carnet') || '[]').length, rows: document.querySelectorAll('#carnet .cn-row').length, sc: document.querySelector('#demoSc').value})")
    if c['n'] < 1 or c['rows'] != c['n']: errors.append(f"contrôle : le carnet d'entretien est perdu ou mal affiché après rechargement ({c})")
    if c['sc'] != 'base': errors.append('contrôle : le scénario de démo est perdu après rechargement')
    try:
        await pg.wait_for_function("window.VigieSpin && window.VigieSpin.state().loaded", timeout=20000)
        sp = await pg.evaluate("() => ({n: window.VigieSpin.state().n, view: localStorage.getItem('vigie.view'), spin: document.querySelector('#homeStage').classList.contains('is360')})")
        if sp['n'] != 36: errors.append(f"contrôle : la vue 360° est perdue après rechargement ({sp['n']} images)")
        if sp['view'] == 'spin' and not sp['spin']: errors.append('contrôle : l\'accueil ne revient pas en vue 360° après rechargement')
    except Exception as e:
        errors.append('contrôle : vue 360° pas rechargée : ' + str(e).splitlines()[0][:120])

async def main():
    async with async_playwright() as p:
        exe = '/usr/bin/google-chrome' if os.path.exists('/usr/bin/google-chrome') else None
        b = await p.chromium.launch(executable_path=exe, args=['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        # service_workers='block' : le service hors ligne contournerait les routes du banc (copies locales, réseau coupé)
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, reduced_motion='no-preference', service_workers='block')
        pg = await ctx.new_page()
        pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)[:400]))
        pg.on('console', on_console)
        await pg.route('**/*', route)
        await pg.add_init_script(INTRO_JS)
        t0 = time.time()
        await pg.goto(BASE + 'index.html', wait_until='commit')
        try:
            await pg.wait_for_function("document.body && document.body.classList.contains('ready')", timeout=45000)
        except Exception:
            errors.append('le démarrage ne se termine pas (body.ready absent après 45 s)')
        await pg.wait_for_timeout(2500)
        start_s = round(time.time() - t0, 1)
        try: intro.update(await pg.evaluate(INTRO_STATS))
        except Exception: pass
        await onboarding(pg)
        await honesty(pg)
        await fuel_log(pg)
        await energy(pg)
        await body_and_photo(pg)
        await demo_scenarios(pg)
        await carnet(pg)
        await spin360(pg)
        T = await tabs(pg)
        for tab in T:
            await goto_tab(pg, tab)
            await snap(pg, f'tel_{tab}_haut')
            for o in await pg.evaluate(OVERFLOW_JS): overflow.append(f'390px [{tab}] {o}')
            await pg.evaluate("document.querySelector('#main').scrollTo(0, 1e6)")
            await pg.wait_for_timeout(700)
            await snap(pg, f'tel_{tab}_bas')
            await pg.evaluate("document.querySelector('#main').scrollTo(0, 0)")
        if not args.no_smoke:
            for tab in T:
                await goto_tab(pg, tab)
                await smoke(pg, tab)
        await persistence(pg)
        await pg.set_viewport_size({'width': 1280, 'height': 720})
        await pg.wait_for_timeout(800)
        for tab in T:
            await goto_tab(pg, tab)
            await snap(pg, f'large_{tab}')
            for o in await pg.evaluate(OVERFLOW_JS): overflow.append(f'1280px [{tab}] {o}')
        try: rendu.update(await pg.evaluate("() => ({niveau_allege: (window.VigieState || {}).gfx || 0, image_ms: (window.VigieState || {}).frameMs || null})"))
        except Exception: pass
        await radio(pg)
        await b.close()
    pwa_static()

    ims = []
    for s in shots:
        im = Image.open(s).convert('RGB'); w = 260; h = int(im.height * w / im.width); ims.append(im.resize((w, h)))
    cols = 5; rows = (len(ims) + cols - 1) // cols
    cw = 260; ch = max(i.height for i in ims)
    sheet = Image.new('RGB', (cw * cols, ch * rows), 'white')
    for i, im in enumerate(ims): sheet.paste(im, ((i % cols) * cw, (i // cols) * ch))
    sheet.save(os.path.join(OUT, 'contact.jpg'), quality=82)
    rep = {'demarrage_s': start_s, 'lancement': intro, 'rendu_3d': rendu, 'vue_360': vue360, 'rubriques': T, 'erreurs': errors, 'debordements': overflow, 'boutons_testes': len(clicked), 'clics': clicked, 'captures': shots}
    json.dump(rep, open(os.path.join(OUT, 'report.json'), 'w'), ensure_ascii=False, indent=1)
    print(f'Rubriques : {T}')
    print(f'Démarrage terminé en {start_s} s · {len(clicked)} boutons cliqués')
    if intro: print(f"Animation de lancement : {intro.get('images')} images en {intro.get('duree_ms')} ms, plus long arrêt {intro.get('pire_arret_ms')} ms (rendu logiciel, plus lent qu'un vrai téléphone)")
    if rendu: print(f"Rendu 3D : {rendu.get('image_ms')} ms par image, niveau allégé {rendu.get('niveau_allege')} (0 = pleine qualité)")
    if vue360: print(f"Vue 360° : {vue360.get('images')} images en {vue360.get('extraction_ms_appli')} ms (vidéo de 30 s), glisser {vue360.get('glisser_degres')}°, rotation lente {vue360.get('rotation_lente_degres')}°")
    print(f'ERREURS ({len(errors)}) :'); [print('  - ' + e) for e in errors]
    print(f'DÉBORDEMENTS ({len(overflow)}) :'); [print('  - ' + o) for o in overflow[:30]]
    print('Planche :', os.path.join(OUT, 'contact.jpg'))
    sys.exit(1 if any(e.startswith('pageerror') for e in errors) else 0)

asyncio.run(main())
