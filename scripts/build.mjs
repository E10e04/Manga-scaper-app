#!/usr/bin/env node
// Copie les fichiers statiques de l'application dans ./www (webDir Capacitor).
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const out = join(root, 'www');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const files = ['index.html', 'app.js', 'styles.css', 'sw.js', 'manifest.webmanifest'];
const dirs = ['src', 'assets'];

for (const f of files) {
  const src = join(root, f);
  if (!existsSync(src)) { console.error(`[build] fichier manquant : ${f}`); process.exit(1); }
  cpSync(src, join(out, f));
}
for (const d of dirs) {
  const src = join(root, d);
  if (existsSync(src)) cpSync(src, join(out, d), { recursive: true });
}

// Browser ESM cannot resolve the bare "@capacitor/core" package name by
// itself. Ship Capacitor's self-contained ESM entry at the same URL used by
// Reader.js so the entire app module graph can start inside Android WebView.
const capacitorCore = join(root, 'node_modules', '@capacitor', 'core', 'dist', 'index.js');
if (!existsSync(capacitorCore)) {
  console.error('[build] dépendance manquante : @capacitor/core/dist/index.js');
  process.exit(1);
}
const capacitorCoreOut = join(out, 'node_modules', '@capacitor', 'core', 'dist');
mkdirSync(capacitorCoreOut, { recursive: true });
cpSync(capacitorCore, join(capacitorCoreOut, 'index.js'));

// server.js n'est PAS copié : le proxy local ne s'applique qu'à la version web.
writeFileSync(join(out, '.gitignore'), '*\n!.gitignore\n');
console.log('[build] www/ généré ✔');
