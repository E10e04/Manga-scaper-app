# manga2 — Manga Reader

Application de bibliothèque et lecture de mangas : ajout par URL, scraping multi-sources (Anime-Sama, SushiScan, Scan-VF + adaptateur générique), lecteur immersif, téléchargement hors ligne (IndexedDB), PWA et Android via Capacitor.

## Lancer (Web / dev)

```bash
npm install
npm start          # http://localhost:8080 (app + proxy CORS /api/page, /api/data, /api/image)
```

## Tests

```bash
npm test           # scripts/test.mjs — adaptateurs, bibliothèque, progression, erreurs (19 tests)
```

## PWA

`manifest.webmanifest` + `sw.js` (cache statique cache-first, cache runtime images, fallback offline). Installable sur ordinateur/mobile.

## Android (Capacitor)

```bash
npm install
npm run build               # génère www/
npx cap add android         # une seule fois
npx cap sync android
npx cap open android        # puis Build > Build APK(s) dans Android Studio
```

### APK automatique (GitHub Actions)

Le workflow `.github/workflows/android.yml` construit **manga-reader-debug.apk** à chaque push sur `main`, lors d'un tag `v*` (publié dans la Release GitHub correspondante) ou via exécution manuelle (`workflow_dispatch`).

Où trouver l'APK :
- **Actions** → *Build Android APK* → Artifacts → `manga-reader-debug-apk`
- ou **Releases** après un tag `vX.Y.Z` → asset `manga-reader-debug.apk`

Installation sur téléphone : copier l'APK, activer « sources inconnues », installer. Debug APK = signature debug Android standard. Une version release signée pourra être branchée en ajoutant un keystore en secrets GitHub (`RELEASE_KEYSTORE`, etc.) et une tâche `assembleRelease`.

> Dans l'APK Android, `CapacitorHttp` effectue les requêtes avec le réseau natif et les images sont chargées par l'application avec le referer du chapitre : aucun serveur sur ordinateur n'est requis. Le proxy Node.js reste disponible pour la version Web ou comme relais facultatif. Un site qui impose un CAPTCHA ou une vérification anti-bot peut toujours refuser l'accès automatique.

## Architecture

```
index.html · app.js · styles.css · sw.js · manifest.webmanifest · server.js · capacitor.config.json
src/adapters/   connecteurs de sites (interface matches/getMangaInfo/getChapters/getChapterPages)
src/scraper/    récupération via proxy + parsing DOM
src/library/    bibliothèque, stockage IndexedDB, progression
src/downloads/  file de téléchargement + stockage offline des images
src/reader/     lecteur vertical lazy-load + réglages
src/ui/         routeur, modales, toasts, composants
src/utils/      erreurs typées, sanitisation, helpers
scripts/        build.mjs (www/) · test.mjs
.github/workflows/android.yml   build APK debug + Release auto
```
