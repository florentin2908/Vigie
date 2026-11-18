# Vigie — ta voiture, en clair

Vigie est **une seule appli mobile** pour ta voiture :

- **sur ton téléphone** : en 3 secondes, tu sais si tout va bien (autonomie, pneus, batterie, température, codes défaut, entretien), avec le carnet de pleins, le carnet d'entretien, les stations proches et l'assistant **Mécano** qui explique les voyants simplement ;
- **ta vraie voiture en 360°** : filme-en le tour, puis fais-la tourner du doigt sur l'accueil ;
- **sur l'écran de ta voiture** : le **mode autoradio**, l'interface 3D du business plan « Interface 3D et modernisation d'habitacle », avec de gros chiffres et de gros boutons (GPS, Waze, Spotify, téléphone, caméra de recul, stations, bilan).

Elle lit la voiture avec un petit boîtier OBD2 Bluetooth BLE (15 à 30 €). Sans boîtier, un mode démo montre l'appli avec des données d'exemple, toujours signalées.

## Le site

Adresse prévue : **https://florentin2908.github.io/Vigie/** (GitHub Pages, branche `main`, dossier `/docs`).

Pour l'installer :
- **Android** (téléphone ou autoradio) : ouvre l'adresse dans Chrome, puis menu > « Installer l'appli ». Un appui long sur l'icône propose « Mode autoradio », « Ajouter un plein » et « Mécano ».
- **iPhone** : dans Safari, Partager > « Sur l'écran d'accueil ».
- Pour un écran de voiture : Garage > Écran de voiture > « Au démarrage de Vigie : ouvrir le mode autoradio », ou l'adresse `…/vigie/?mode=autoradio`.

## La vue 360° de ta voiture

Garage > Vue 360° de ta voiture > « Filmer le tour de ta voiture » : un tour complet en 20 à 30 secondes, à pas lents, téléphone à l'horizontale à hauteur des phares, à environ 2 m, de jour. Vigie en tire 36 images en quelques secondes. Tu peux aussi choisir une vidéo existante, ou 8 à 36 photos prises en tournant. Sur l'accueil, choisis « 360° » et fais-la tourner du doigt.

## Tes données

Tout reste sur l'appareil : profil, pleins, carnet d'entretien, photo et vue 360°. Rien n'est envoyé, sauf ta position aux services publics de prix des carburants quand tu ouvres la carte.

## Pour les développeurs

| Fichier | Rôle |
|---|---|
| `index.html` | Toute l'appli (contenu de page seul, le même fichier que dans l'artefact Claude) |
| `changelog.json` | Nouveautés affichées dans l'appli |
| `roadmap.md` | Feuille de route, règles et carte du code |
| `CLAUDE.md` | Mémoire du projet pour Claude Code |
| `site/` | Manifeste, service hors ligne et icônes de l'appli installable |
| `outils/construire-site.py` | Construit le site dans `docs/` |
| `outils/check.py` | Banc de test automatique |
| `docs/` | Le site construit (ne pas modifier à la main) |

```bash
python3 outils/construire-site.py
npm install --prefix /tmp/vigie-deps three@0.160.0 leaflet@1.9.4
pip install playwright pillow    # et ffmpeg pour la vidéo de test
python3 outils/check.py docs /tmp/vigie-out --deps /tmp/vigie-deps
```
