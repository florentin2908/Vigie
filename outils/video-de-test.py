#!/usr/bin/env python3
"""Fabrique une vidéo de test réaliste pour le scan 3D de Vigie, avec sa vérité terrain.

Usage : python3 outils/video-de-test.py <dossier_de_sortie> [--deps /tmp/vigie-deps] [--images 300] [--depart 0.03]

Le tour est filmé par une caméra virtuelle (champ de 66° en paysage, comme un téléphone) qui marche autour
d'une voiture Vigie rouge, sur un parking, à hauteur des phares, en suivant un rectangle arrondi à environ
2,8 m de la carrosserie, à vitesse de marche constante (donc à vitesse d'angle variable), avec de petits
tremblements de visée. Décor : sol texturé, immeubles, ciel, une autre voiture garée plus loin.
Sortie : tour-synthetique.mp4 (30 s, H.264) et tour-synthetique.json (angle vrai de chaque image,
distance, dimensions vraies de la voiture, champ de la caméra).
"""
import argparse, asyncio, base64, functools, http.server, json, os, re, socketserver, subprocess, sys, tempfile, threading

ap = argparse.ArgumentParser()
ap.add_argument('out')
ap.add_argument('--deps', default='/tmp/vigie-deps')
ap.add_argument('--images', type=int, default=300)
ap.add_argument('--depart', type=float, default=.03, help='point de départ du tour (fraction du tour, 0,03 = devant à gauche ; 0,53 = de l\'autre côté)')
args = ap.parse_args()
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.abspath(args.out); os.makedirs(OUT, exist_ok=True)
NM = os.path.join(os.path.abspath(args.deps), 'node_modules')

# Le code 3D de Vigie (silhouettes, éclairage) est repris tel quel depuis index.html, sans le lancement de l'appli
page = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
mod = re.search(r'<script type="module">(.*?)</script>', page, re.S).group(1)
mod = mod[:mod.index('const introP=prepareIntro();')]

SCENE = r"""
const W=640,H=360,N=%(n)d,HFOV=66;
const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;document.body.appendChild(canvas);
const renderer=makeRenderer(canvas);renderer.setPixelRatio(1);renderer.setSize(W,H,false);renderer.setClearColor(0x9fb8d8,1);
const scene=new THREE.Scene();lightScene(scene,renderer);
// Ciel
{const c=document.createElement('canvas');c.width=16;c.height=256;const g=c.getContext('2d');const lg=g.createLinearGradient(0,0,0,256);lg.addColorStop(0,'#5d8fd6');lg.addColorStop(.6,'#b9cde6');lg.addColorStop(1,'#dfe6ee');g.fillStyle=lg;g.fillRect(0,0,16,256);
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;scene.background=t;}
// Sol de parking : bitume bruité et lignes blanches
function noiseTex(w,h,base,amp,lines){const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.fillStyle=base;g.fillRect(0,0,w,h);
  let s=7;const rnd=()=>{s=(s*16807)%%2147483647;return s/2147483647;};
  for(let i=0;i<w*h/6;i++){const v=Math.floor(rnd()*amp);g.fillStyle=`rgba(${v},${v},${v},.18)`;g.fillRect(rnd()*w,rnd()*h,2,2);}
  if(lines){g.fillStyle='rgba(240,240,240,.85)';for(let x=40;x<w;x+=170)g.fillRect(x,0,8,h*.45);for(let x=40;x<w;x+=170)g.fillRect(x,h*.62,8,h*.38);g.fillStyle='rgba(250,210,60,.8)';g.fillRect(0,h*.53,w,6);}
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.wrapS=t.wrapT=THREE.RepeatWrapping;return t;}
{const t=noiseTex(1024,1024,'#565b62',255,true);t.repeat.set(6,6);const m=new THREE.Mesh(new THREE.PlaneGeometry(120,120),new THREE.MeshStandardMaterial({map:t,roughness:.95}));m.rotation.x=-Math.PI/2;scene.add(m);}
// Immeubles tout autour (fenêtres) : donnent du relief au décor
function facade(col,seed){const c=document.createElement('canvas');c.width=256;c.height=256;const g=c.getContext('2d');g.fillStyle=col;g.fillRect(0,0,256,256);
  let s=seed;const rnd=()=>{s=(s*16807)%%2147483647;return s/2147483647;};
  for(let y=12;y<250;y+=34)for(let x=10;x<246;x+=30){g.fillStyle=rnd()<.3?'#f6e7a8':'#24324a';g.fillRect(x,y,18,22);}
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;}
const COLS=['#c98b6b','#d8c7a2','#9fa8b5','#b85c4a','#e3d9c6','#7e8f9e','#c2a36b','#a7b59a'];
for(let i=0;i<14;i++){const a=i/14*Math.PI*2+.2,r=17+((i*7)%%5)*2.2,h=6+((i*5)%%4)*3,w=6+((i*3)%%3)*2;
  const t=facade(COLS[i%%COLS.length],i*97+11);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(w/6,h/6);
  const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,5),new THREE.MeshStandardMaterial({map:t,roughness:.8}));b.position.set(Math.sin(a)*r,h/2,Math.cos(a)*r);b.lookAt(0,h/2,0);scene.add(b);}
// Deux arbres et une autre voiture garée plus loin (Vigie doit garder la voiture du centre)
for(const [x,z] of [[-7,6],[8,-5]]){const tr=new THREE.Mesh(new THREE.CylinderGeometry(.18,.24,2.4,10),new THREE.MeshStandardMaterial({color:0x5a4030}));tr.position.set(x,1.2,z);scene.add(tr);
  const fo=new THREE.Mesh(new THREE.SphereGeometry(1.5,16,12),new THREE.MeshStandardMaterial({color:0x3f7a3a,roughness:.9}));fo.position.set(x,3.1,z);scene.add(fo);}
useBody('citadine');const other=buildCar({paint:'#E9EDF4'});other.group.position.set(-6.5,0,-8.5);other.group.rotation.y=.4;scene.add(other.group);
// La voiture scannée
useBody('compacte');const car=buildCar({paint:'#B3121F'});scene.add(car.group);
const box=new THREE.Box3().setFromObject(car.group),size=box.getSize(new THREE.Vector3()),ctr=box.getCenter(new THREE.Vector3());
// Masque vrai : la voiture en blanc sur noir
const white=new THREE.MeshBasicMaterial({color:0xffffff}),maskScene=new THREE.Scene();maskScene.background=new THREE.Color(0x000000);
const carMask=car.group.clone(true);carMask.traverse(o=>{if(o.isMesh)o.material=white;});maskScene.add(carMask);
// Caméra : rectangle arrondi à environ 2,8 m de la carrosserie, à vitesse de marche constante
const VF=2*Math.atan(Math.tan(HFOV/2*Math.PI/180)*H/W)*180/Math.PI;
const cam=new THREE.PerspectiveCamera(VF,W/H,.05,200);
const hx=size.x/2,hz=size.z/2,off=2.8,straightX=2*hx,straightZ=2*hz,arc=Math.PI/2*off,P=2*straightX+2*straightZ+4*arc;
function pathAt(u){ // u ∈ [0,1) le long du chemin, sens trigonométrique vu de dessus
  let d=u*P;const segs=[[straightX,'s',[ hx,  hz+off],[-1,0]],[arc,'a',[-hx, hz],Math.PI/2],[straightZ,'s',[-hx-off, hz],[0,-1]],[arc,'a',[-hx,-hz],Math.PI],
                        [straightX,'s',[-hx,-hz-off],[1,0]],[arc,'a',[ hx,-hz],-Math.PI/2],[straightZ,'s',[ hx+off,-hz],[0,1]],[arc,'a',[ hx, hz],0]];
  for(const [len,k,p0,q] of segs){if(d<=len){if(k==='s')return [p0[0]+q[0]*d,p0[1]+q[1]*d];const a=q+d/off;return [p0[0]+Math.cos(a)*off,p0[1]+Math.sin(a)*off];}d-=len;}
  return pathAt(0);
}
window.__frames=[];window.__truth={n:N,hfov:HFOV,w:W,h:H,dims:{L:size.x,W:size.z,H:size.y},center:[ctr.x,ctr.y,ctr.z],frames:[]};
const tgt=new THREE.Vector3(ctr.x,.65,ctr.z);
window.__render=function(i){
  const u=(i/N+%(depart)f)%%1,[x,z]=pathAt(u),y=.85+Math.sin(i*.9)*.02;
  cam.position.set(x,y,z);
  const j1=Math.sin(i*.37)*.035,j2=Math.sin(i*.23+1)*.02; // tremblements de visée (environ 2° et 1°)
  cam.lookAt(tgt);cam.rotateY(j1);cam.rotateX(j2);
  renderer.render(scene,cam);const img=canvas.toDataURL('image/jpeg',.9);
  renderer.setClearColor(0x000000,1);renderer.render(maskScene,cam);const mask=canvas.toDataURL('image/png');renderer.setClearColor(0x9fb8d8,1);
  window.__truth.frames.push({i,az:Math.atan2(x-ctr.x,z-ctr.z)*180/Math.PI,dist:Math.hypot(x-ctr.x,z-ctr.z),yawJitterDeg:j1*180/Math.PI,yaw:j1,pitch:j2,camY:y,tgtY:.65});
  return {img,mask};
};
window.__ready=true;
"""


class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


async def main():
    from playwright.async_api import async_playwright
    tmp = tempfile.mkdtemp()
    html = ('<!doctype html><html><body style="margin:0;background:#000"><script type="importmap">'
            '{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}'
            '</script><script>window.VigieState={studio:false,accent:"#5AC8FA",floor:"#5AC8FA",tint:"#ffffff"};</script>'
            '<script type="module">' + mod + (SCENE % {'n': args.images, 'depart': args.depart}) + '</script></body></html>')
    open(os.path.join(tmp, 'index.html'), 'w', encoding='utf-8').write(html)
    httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Q, directory=tmp))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{httpd.server_address[1]}/'
    frames = os.path.join(tmp, 'f'); os.makedirs(frames)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome' if os.path.exists('/usr/bin/google-chrome') else None,
                                    args=['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 700, 'height': 420})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))

        async def route(r):
            u = r.request.url
            if 'three@0.160.0/' in u:
                return await r.fulfill(path=os.path.join(NM, 'three', u.split('three@0.160.0/')[1]), content_type='application/javascript')
            if u.startswith(base):
                return await r.continue_()
            return await r.abort()
        await pg.route('**/*', route)
        await pg.goto(base + 'index.html')
        try:
            await pg.wait_for_function('window.__ready', timeout=60000)
        except Exception:
            sys.exit('la scène de test ne démarre pas : ' + '; '.join(errs)[:500])
        for i in range(args.images):
            r = await pg.evaluate(f'window.__render({i})')
            open(os.path.join(frames, f'{i:04d}.jpg'), 'wb').write(base64.b64decode(r['img'].split(',')[1]))
            open(os.path.join(frames, f'm{i:04d}.png'), 'wb').write(base64.b64decode(r['mask'].split(',')[1]))
            if i % 50 == 0: print(f'  image {i}/{args.images}', flush=True)
        truth = await pg.evaluate('window.__truth')
        await b.close()
    fps = max(1, round(args.images / 30))
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-framerate', str(fps), '-i', os.path.join(frames, '%04d.jpg'),
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', str(fps), '-movflags', '+faststart', os.path.join(OUT, 'tour-synthetique.mp4')], check=True)
    os.makedirs(os.path.join(OUT, 'masques'), exist_ok=True)
    for f in os.listdir(frames):
        if f.startswith('m'): os.replace(os.path.join(frames, f), os.path.join(OUT, 'masques', f[1:]))
    truth['fps'] = fps
    json.dump(truth, open(os.path.join(OUT, 'tour-synthetique.json'), 'w'), indent=1)
    print(f"Vidéo : {os.path.join(OUT, 'tour-synthetique.mp4')} ({args.images} images, {fps} images/s) ; voiture {truth['dims']}")

asyncio.run(main())
