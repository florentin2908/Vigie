# Vigie — ta voiture, en clair

Vigie est **une seule appli mobile** pour ta voiture :

- **sur ton téléphone** : en 3 secondes, tu sais si tout va bien (autonomie, pneus, batterie, température, codes défaut, entretien), avec le carnet de pleins, le carnet d'entretien, les stations proches et l'assistant **Mécano** qui explique les voyants simplement ;
- **ta vraie voiture en 3D** : filme-en le tour, Vigie la scanne et la refait en 3D avec ses propres couleurs, sur l'accueil, dans Santé, au Garage et en mode autoradio (et en vue 360°) ;
- **sur l'écran de ta voiture** : le **mode autoradio**, l'interface 3D du business plan « Interface 3D et modernisation d'habitacle », avec de gros chiffres et de gros boutons (GPS, Waze, Spotify, téléphone, caméra de recul, stations, bilan).

Elle lit la voiture avec un petit boîtier OBD2 Bluetooth BLE (15 à 30 €). Sans boîtier, un mode démo montre l'appli avec des données d'exemple, toujours signalées.

## Le site

Adresse : **https://florentin2908.github.io/Vigie/** (GitHub Pages, branche `main`, dossier `/docs` ; en ligne depuis le 18 nov. 2026).

Pour l'installer :
- **Android** (téléphone ou autoradio) : ouvre l'adresse dans Chrome, puis menu > « Installer l'appli ». Un appui long sur l'icône propose « Mode autoradio », « Ajouter un plein » et « Mécano ».
- **iPhone** : dans Safari, Partager > « Sur l'écran d'accueil ».
- Pour un écran de voiture : Garage > Écran de voiture > « Au démarrage de Vigie : ouvrir le mode autoradio », ou l'adresse `https://florentin2908.github.io/Vigie/?mode=autoradio`.

## Ta voiture en 3D

Garage > Ta voiture en 3D > « Scanner ma voiture » : un tour complet en 20 à 30 secondes, à pas lents et réguliers, téléphone à l'horizontale à hauteur des phares, à environ 3 m (la voiture reste entière et au milieu de l'écran), de jour. Vigie reconnaît la voiture sur chaque image, retrouve où était le téléphone, sculpte sa forme en 3D, repère les roues et les vitres, puis la peint en haute définition avec tes images (sans les reflets du décor : le vernis brille en temps réel). Tout se calcule sur le téléphone, sans fichier à exporter ni autre appli. Un interrupteur ramène le dessin Vigie.

Tu as aussi la vue 360° (36 images) : sur l'accueil, choisis « 360° » et fais-la tourner du doigt. Avec 8 à 36 photos prises en tournant, Vigie fait seulement la vue 360°.

Limites : les vitres et les creux sont lissés, le dessous n'est pas vu, le toit est peu vu, la taille est estimée.

## Tes données

Tout reste sur l'appareil : profil, pleins, carnet d'entretien, photo, vue 360° et scan 3D. Rien n'est envoyé, sauf ta position aux services publics de prix des carburants quand tu ouvres la carte.

## Pour les développeurs

| Fichier | Rôle |
|---|---|
| `index.html` | Toute l'appli (contenu de page seul, le même fichier que dans l'artefact Claude) |
| `changelog.json` | Nouveautés affichées dans l'appli |
| `roadmap.md` | Feuille de route, règles et carte du code |
| `CLAUDE.md` | Mémoire du projet pour Claude Code |
| `site/` | Manifeste, service hors ligne et icônes de l'appli installable ; `scan3d.js` et `vendor/mediapipe/` pour le scan 3D |
| `outils/construire-site.py` | Construit le site dans `docs/` |
| `outils/check.py` | Banc de test automatique |
| `outils/video-de-test.py`, `outils/essai-scan.py` | Vidéo de synthèse et mesure de précision du scan 3D |
| `docs/` | Le site construit (ne pas modifier à la main) |

```bash
python3 outils/construire-site.py
npm install --prefix /tmp/vigie-deps three@0.160.0 leaflet@1.9.4
pip install playwright pillow    # et ffmpeg pour la vidéo de test
python3 outils/check.py docs /tmp/vigie-out --deps /tmp/vigie-deps
```
