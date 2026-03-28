# Projet inventaire Phil

## Arborescence

| Dossier / fichier | Rôle |
|-------------------|------|
| **`index.html`** (racine) | Landing servie sur `/`. |
| **`public/`** | `app.html`, `login.html`, `config.js`, `Assets/`, `pages/` (légal, pricing, etc.). |
| **`docs/`** | Documentation Markdown (Stripe, règles Firestore). |
| **`functions/`** | Cloud Functions Firebase (si utilisé). |
| **`server.js`** | Serveur Express : fichiers statiques + API Stripe. |
| **`package.json`** | Dépendances Node du serveur local. |

Démarrage : `npm start` puis ouvrir `http://localhost:4242`.

Les chemins dans les HTML (`Assets/`, `pages/`, `login.html`) sont relatifs à `public/` ; pas de changement nécessaire après ce déplacement.
