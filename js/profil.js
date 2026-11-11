// Profil des calculs longs (Confort, Chaleur, UTCI) : désactivé par défaut, sans effet sur les calculs.
// Activation : adresse ?profil=1, ou dans la console localStorage.setItem('atlas-hdv-profil', '1') puis recharger.
// Chaque étape est notée (performance.measure « atlas:<étape> », visible dans l'onglet Performance de Chrome) ;
// en console : atlasProfil.tableau() (étape / ms / % / appels), atlasProfil.evenements(), atlasProfil.vider().
let actif = false;
try { actif = /[?&]profil=1\b/.test(location.search) || localStorage.getItem('atlas-hdv-profil') === '1'; } catch { actif = false; }
const lignes = [];
const evenements = new Map();
export const profilActif = () => actif;
// t0 = debut() ; ... ; fin('étape', t0) — debut() renvoie 0 et fin() ne fait rien quand le profil est désactivé
export const debut = () => (actif ? performance.now() : 0);
export function fin(nom, t0, detail = null) {
  if (!actif) return;
  const t1 = performance.now();
  try { performance.measure(`atlas:${nom}`, { start: t0, end: t1 }); } catch { /* navigateur ancien */ }
  lignes.push({ nom, ms: t1 - t0, debut: t0, detail });
}
// compte les événements internes (app.emettre) pendant le profil : recalculs déclenchés en double
export function installer(app) {
  if (!actif || app.__profilInstalle) return;
  app.__profilInstalle = true;
  const emettre = app.emettre.bind(app);
  app.emettre = (nom, ...a) => { evenements.set(nom, (evenements.get(nom) || 0) + 1); return emettre(nom, ...a); };
  console.info('Profil des calculs actif : atlasProfil.tableau() après un calcul.');
}
function tableau({ afficher = true } = {}) {
  const parNom = new Map();
  for (const l of lignes) {
    const a = parNom.get(l.nom) || { etape: l.nom, ms: 0, appels: 0 };
    a.ms += l.ms; a.appels++;
    parNom.set(l.nom, a);
  }
  // total = étapes « … complet » (sinon étapes sans « / ») ; les sous-étapes « parent / enfant » sont rapportées à ce total
  const complets = [...parNom.values()].filter((a) => / complet$/.test(a.etape));
  const racines = complets.length ? complets : [...parNom.values()].filter((a) => !a.etape.includes(' / '));
  const total = racines.reduce((s, a) => s + a.ms, 0) || 1;
  const T = [...parNom.values()].map((a) => ({ etape: a.etape, ms: Math.round(a.ms), '%': Math.round((1000 * a.ms) / total) / 10, appels: a.appels }));
  if (afficher) console.table(T);
  return T;
}
if (typeof window !== 'undefined') {
  window.atlasProfil = {
    actif: () => actif, lignes, tableau, evenements: () => Object.fromEntries(evenements),
    vider: () => { lignes.length = 0; evenements.clear(); },
  };
}
