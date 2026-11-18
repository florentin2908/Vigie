# Vigie — mémoire du projet pour Claude Code

Vigie est **une seule appli mobile** : l'appli téléphone compagnon de la voiture **et** l'interface 3D pour écran de voiture du business plan « Interface 3D et modernisation d'habitacle (CarPlay / autoradios Android) ». Le mode autoradio est une partie de Vigie, pas une appli à part.

Propriétaire : Florentin (compte GitHub `florentin2908`). Textes de l'appli en français simple, tutoiement.

## À lire avant chaque passage

- `roadmap.md` : vision (§1), règles à respecter (§2), contraintes de la page Claude (§3), le vrai site (§3 bis), carte du code (§4), points à faire dans l'ordre (§5), journal (§7).
- Un passage traite 1 à 3 points de §5, en commençant par le premier non coché. On ne coche que ce qui est testé. À la fin : cocher, ajouter une ligne au journal (§7), ajouter la version dans `changelog.json` (elle s'affiche dans Garage > Nouveautés).

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Toute l'appli. Format « contenu de page seul » (pas de doctype ni de `<body>`), le même que dans l'artefact Claude |
| `changelog.json` | Nouveautés affichées dans l'appli |
| `roadmap.md` | Feuille de route, règles, carte du code, journal |
| `site/` | Appli installable : `manifest.webmanifest`, `sw.js` (ligne `const VERSION = 'vigie-dev';` remplacée à la construction), icônes |
| `outils/construire-site.py` | Construit `docs/` (le site) |
| `outils/check.py` | Banc de test automatique (dans l'artefact : `banc-de-test.txt`) |
| `docs/` | Site construit, servi par GitHub Pages. Ne jamais l'éditer à la main |

## Construire, tester, publier

```bash
python3 outils/construire-site.py                      # reconstruit docs/
npm install --prefix /tmp/vigie-deps three@0.160.0 leaflet@1.9.4   # une fois
pip install playwright pillow                          # une fois ; ffmpeg doit être installé
python3 outils/check.py docs /tmp/vigie-out --deps /tmp/vigie-deps  # environ 10 min
```

Le banc doit finir avec 0 erreur et 0 débordement. Il écrit `report.json` et `contact.jpg` (planche de captures à regarder).

Après chaque passage validé : construire `docs/`, commit, push sur `main` du dépôt `Vigie`.

## Adresses

- Site (GitHub Pages, branche `main`, dossier `/docs`) : **https://florentin2908.github.io/Vigie/** — dépôt créé le 18 nov. 2026 ; le site répond dès que Pages est activé (Settings > Pages > Branch `main`, dossier `/docs`).
- Artefact Claude : https://claude.ai/artifact/D65wicG7UAsTbm8npDVZhe — y publier `index.html` tel quel, avec `changelog.json`, `roadmap.md` et `banc-de-test.txt` (copie de `outils/check.py`). Relire la version en ligne avant (elle peut avoir changé).

## Connexion à GitHub

Florentin se connecte lui-même. Ne jamais lui demander de mot de passe ni de jeton.
- Sur son ordinateur : `gh auth login` (GitHub.com, HTTPS, connexion par le navigateur).
- Dans une session Claude Code sur le web : l'appli GitHub de Claude doit avoir accès au dépôt `Vigie` (https://github.com/apps/claude/installations/select_target).

## Règles qui ne se discutent pas (détail dans roadmap.md §2)

- Jamais de fausse donnée présentée comme réelle : le mode démo est toujours signalé.
- Aucune reproduction de modèle de voiture réel ni de logo ; la vraie voiture du client = sa photo ou sa vue 360°.
- Données seulement sur l'appareil (localStorage, IndexedDB pour la vue 360°) ; rien n'est envoyé.
- Mode autoradio : aucune vidéo, caméra de recul coupée en roulant, pas de bouton factice (verrouillage, climatisation).
- `prefers-reduced-motion` respecté ; `localStorage` et IndexedDB toujours dans un `try/catch`.
