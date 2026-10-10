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

// server.js n'est PAS copié : le proxy local ne s'applique qu'à la version web.
writeFileSync(join(out, '.gitignore'), '*\n!.gitignore\n');
console.log('[build] www/ généré ✔');
