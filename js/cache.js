// Cache local du navigateur (IndexedDB) : les données obtenues en ligne sont gardées
// pour les visites suivantes, ce qui évite de réinterroger les serveurs à chaque ouverture.

const BASE = 'atlas-hotel-de-ville';
const MAGASIN = 'donnees';
let ouverture = null;

function ouvrir() {
  if (ouverture) return ouverture;
  ouverture = new Promise((ok, ko) => {
    if (!('indexedDB' in window)) { ko(new Error('IndexedDB indisponible')); return; }
    const req = indexedDB.open(BASE, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(MAGASIN);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => ko(req.error);
  });
  return ouverture;
}

export async function lireCache(cle, ageMaxJours = 90) {
  try {
    const db = await ouvrir();
    const val = await new Promise((ok, ko) => {
      const r = db.transaction(MAGASIN).objectStore(MAGASIN).get(cle);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    });
    if (!val) return null;
    if (Date.now() - val.date > ageMaxJours * 86400000) return null;
    return val.donnees;
  } catch {
    return null;
  }
}

export async function ecrireCache(cle, donnees) {
  try {
    const db = await ouvrir();
    await new Promise((ok, ko) => {
      const t = db.transaction(MAGASIN, 'readwrite');
      t.objectStore(MAGASIN).put({ date: Date.now(), donnees }, cle);
      t.oncomplete = ok;
      t.onerror = () => ko(t.error);
    });
  } catch { /* cache facultatif */ }
}

export async function viderCache() {
  try {
    const db = await ouvrir();
    await new Promise((ok) => { const t = db.transaction(MAGASIN, 'readwrite'); t.objectStore(MAGASIN).clear(); t.oncomplete = ok; });
  } catch { /* rien */ }
}
