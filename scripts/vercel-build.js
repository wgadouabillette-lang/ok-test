/**
 * Prépare le dossier public/ pour Vercel : copie la landing depuis la racine du repo.
 * Exécuté par Vercel (build) sans npm install requis.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'index.html');
const dest = path.join(root, 'public', 'index.html');

if (!fs.existsSync(src)) {
  console.error('vercel-build: fichier manquant:', src);
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'public'))) {
  console.error('vercel-build: dossier public/ manquant');
  process.exit(1);
}

fs.copyFileSync(src, dest);
console.log('vercel-build: index.html -> public/index.html ok');
