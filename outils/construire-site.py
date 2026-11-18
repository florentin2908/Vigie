#!/usr/bin/env python3
"""Construit le site de Vigie dans docs/ (le dossier servi par GitHub Pages).

Usage : python3 outils/construire-site.py

- index.html (à la racine) est au format « contenu de page seul », comme dans l'artefact Claude :
  pas de <!doctype>, <html>, <head> ni <body>. Le script l'entoure du squelette complet
  (doctype, langue, manifeste de l'appli installable, icônes, zones sûres du téléphone).
- copie changelog.json et tout le dossier site/ (manifeste, service hors ligne, icônes) ;
- écrit la version du changelog dans sw.js, pour que le téléphone reçoive chaque nouvelle version ;
- ajoute docs/.nojekyll (GitHub Pages sert les fichiers tels quels).
"""
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, 'docs')
SITE = os.path.join(ROOT, 'site')
KEEP = {'CNAME'}  # fichiers de docs/ à ne jamais effacer (domaine personnalisé éventuel)

# Mêmes styles de base que le squelette ajouté par l'outil Artifact (la page est dessinée pour lui),
# plus ce qu'il faut pour l'appli installable.
SKELETON = (
    '<!doctype html><html lang="fr"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    '<meta name="description" content="Vigie, l\'appli compagnon de ta voiture : autonomie, pneus, batterie, codes défaut, '
    'carnet de pleins, vue 360° de ta voiture, assistant Mécano et mode autoradio en 3D.">'
    '<link rel="manifest" href="manifest.webmanifest"><link rel="icon" href="icon.svg" type="image/svg+xml">'
    '<link rel="apple-touch-icon" href="icon-192.png"><meta name="mobile-web-app-capable" content="yes">'
    '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Vigie">'
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">'
    '<style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);'
    'padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}'
    'body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#15114f;color:#000}'
    'img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>'
)


def main():
    page = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    if page.lstrip().lower().startswith('<!doctype') or '<body' in page[:2000].lower():
        sys.exit('index.html doit être au format « contenu de page seul » (sans doctype ni <body>), comme dans l\'artefact.')
    changelog = json.load(open(os.path.join(ROOT, 'changelog.json'), encoding='utf-8'))
    version = (changelog.get('versions') or [{}])[0].get('version', 'dev')

    os.makedirs(DOCS, exist_ok=True)
    for name in os.listdir(DOCS):
        if name in KEEP:
            continue
        path = os.path.join(DOCS, name)
        shutil.rmtree(path) if os.path.isdir(path) else os.remove(path)

    with open(os.path.join(DOCS, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(SKELETON + '\n' + page.rstrip('\n') + '\n</body></html>\n')
    shutil.copy(os.path.join(ROOT, 'changelog.json'), DOCS)
    for name in sorted(os.listdir(SITE)):
        src = os.path.join(SITE, name)
        if os.path.isdir(src):
            continue
        if name == 'sw.js':
            text = open(src, encoding='utf-8').read()
            marker = "const VERSION = 'vigie-dev';"
            if marker not in text:
                sys.exit("site/sw.js doit contenir la ligne : " + marker)
            open(os.path.join(DOCS, name), 'w', encoding='utf-8').write(text.replace(marker, f"const VERSION = 'vigie-v{version}';"))
        else:
            shutil.copy(src, DOCS)
    open(os.path.join(DOCS, '.nojekyll'), 'w').close()

    files = sorted(os.listdir(DOCS))
    size = sum(os.path.getsize(os.path.join(DOCS, n)) for n in files)
    print(f'Site construit dans docs/ : Vigie v{version}, {len(files)} fichiers, {size // 1024} Ko')
    for n in files:
        print('  -', n)


if __name__ == '__main__':
    main()
