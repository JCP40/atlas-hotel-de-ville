// Calibration du modèle de bruit de l'atlas (js/bruit-calcul.js) sur la carte de référence de Nantes Métropole (21/11/2026).
// Usage (Node 18 ou plus, sans dépendance) :
//   node outils/bruit/calibrer-modele.mjs <scene.json> [data/bruit-reference-nantes-metropole.geojson] [data/bruit-modele.json]
// scene.json : bouton « Scène du modèle (JSON) » du panneau Bruit (voirie OSM, lignes de bus et de tramway, bâti existant en
// mètres locaux, origine). Le classement sonore est lu dans data/classement-sonore.geojson.
// Écrit data/bruit-modele.json (coefficients seulement : aucune donnée de Nantes Métropole) et affiche le rapport.
// La référence (© Nantes Métropole, sans licence ouverte) reste locale : ne pas la republier.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { creerProjection } from '../../js/geo.js';
import * as B from '../../js/bruit-calcul.js';

const ici = path.dirname(fileURLToPath(import.meta.url)), racine = path.resolve(ici, '../..');
const [fScene, fRef = path.join(racine, 'data/bruit-reference-nantes-metropole.geojson'), fSortie = path.join(racine, 'data/bruit-modele.json')] = process.argv.slice(2);
if (!fScene) { console.error('usage : node outils/bruit/calibrer-modele.mjs scene.json [reference.geojson] [sortie.json]'); process.exit(1); }
const lire = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const scene = lire(fScene), ref = lire(fRef);
const cs = fs.existsSync(path.join(racine, 'data/classement-sonore.geojson')) ? lire(path.join(racine, 'data/classement-sonore.geojson')) : { features: [] };
let modele = fs.existsSync(fSortie) ? lire(fSortie) : {};
const proj = creerProjection(scene.origine.lat, scene.origine.lon);
const E = B.entreesDepuisGeo({ voirie: scene.voirie, lignes: scene.lignes, classement: cs }, proj);
const sources = B.preparerSources(E, modele);
const M = B.fusionnerModele(modele);
console.log(`${sources.length} sources (${sources.filter((s) => s.type === 'route').length} routes, dont ${sources.filter((s) => s.comptage).length} avec comptage du classement sonore), ${scene.bati.length} bâtiments`);
const S = B.construireScene({ batiments: scene.bati, sources, demiCote: (scene.rayonEtude || 420) + M.calcul.rayon_m, pas: M.calcul.pas });
// récepteurs : points de référence (4 m) ; classes [lo, lo + 5[ ; 0 = sous la première classe ; 75 / 70 = classe ouverte
const refs = [], rec = [];
const cls = (v, ind) => (v == null ? null : v === 0 ? [-Infinity, ind === 'Ln' ? 50 : 55] : v >= (ind === 'Ln' ? 70 : 75) ? [v, Infinity] : [v, v + 5]);
for (const f of ref.features) {
  const p = f.properties, [lon, lat] = f.geometry.coordinates, q = proj.versLocal(lat, lon);
  if (!p.r) continue;
  refs.push({ r: rec.length / 4, lden: cls(p.r[0], 'Lden'), ln: cls(p.r[1], 'Ln'), rue: p.n >= 0 ? ref.rues[p.n] : null, milieu: p.z, tram: p.f ? { lden: cls(p.f[0], 'Lden'), ln: cls(p.f[1], 'Ln') } : null });
  rec.push(q.x, q.z, 0, 0);
}
const t0 = Date.now();
// cache facultatif des transferts (variable BRUIT_CACHE = fichier) : pour refaire la calibration sans refaire la propagation
const cache = process.env.BRUIT_CACHE;
let T;
if (cache && fs.existsSync(cache)) {
  const c = lire(cache);
  T = { n: c.n, offsets: Int32Array.from(c.offsets), groupes: Int32Array.from(c.groupes), valeurs: Float32Array.from(c.valeurs), interieur: Uint8Array.from(c.interieur) };
} else {
  T = B.calculerTransferts(S, Float32Array.from(rec), { ...M.calcul, progres: (u) => process.stdout.write(`\rpropagation ${Math.round(u * 100)} %`) });
  if (cache) fs.writeFileSync(cache, JSON.stringify({ n: T.n, offsets: [...T.offsets], groupes: [...T.groupes], valeurs: [...T.valeurs], interieur: [...T.interieur] }));
}
console.log(`\rpropagation : ${refs.length} récepteurs en ${((Date.now() - t0) / 1000).toFixed(1)} s, ${T.valeurs.length} couples récepteur-source`);
const routes = (g) => sources[g].type !== 'tram';
const avant = B.evaluer(T, sources, M, refs, { filtre: routes });
const C = B.calibrer(T, sources, M, refs, { filtre: routes, journal: (t) => console.log(t) });
// tramway : SEL d'un passage, sur les points où la référence « ferroviaire » (tramway compris) est cartographiée
const trams = refs.filter((p) => p.tram?.lden && p.tram.lden[0] > 0).map((p) => ({ ...p, lden: p.tram.lden, ln: p.tram.ln }));
let Mf = C.modele;
if (trams.length > 30) {
  let best = null;
  for (let sel = 70; sel <= 92; sel += 0.5) {
    const m = { ...Mf, tram: { ...Mf.tram, sel_7_5m: sel } };
    const e = B.evaluer(T, sources, m, trams, { filtre: (g) => sources[g].type === 'tram' });
    if (!best || e.cout < best.cout) best = { sel, cout: e.cout, dans: e.dansClasse };
  }
  Mf = { ...Mf, tram: { ...Mf.tram, sel_7_5m: best.sel } };
  console.log(`tramway : SEL à 7,5 m = ${best.sel} dB(A) (${trams.length} valeurs, ${Math.round(best.dans * 100)} % dans la classe)`);
}
const apres = B.evaluer(T, sources, Mf, refs, { filtre: routes });
const R = B.rapport(apres.L, refs);
const pc = (v) => (v == null ? '—' : `${Math.round(v * 100)} %`), f1 = (v) => (v == null ? '—' : v.toFixed(1));
console.log(`\nAvant calibration : Lden+Ln dans la classe ${pc(avant.dansClasse)}, à ±1 classe ${pc(avant.unePres)}`);
for (const ind of ['Lden', 'Ln']) console.log(`Après, ${ind} : dans la classe ${pc(R[ind].dansClasse)}, à ±1 classe ${pc(R[ind].unePres)}, biais ${f1(R[ind].biais)} dB, écart moyen ${f1(R[ind].ecartMoyen)} dB (${R[ind].n} points)`);
console.log('\nRue (bord de chaussée) | n | Lden modèle / réf. | dans la classe | Ln modèle / réf.');
for (const r of R.rues.filter((x) => x.n >= 15).slice(0, 30)) console.log(`${r.rue} | ${r.n} | ${f1(r.Lden.modele)} / ${f1(r.Lden.reference)} | ${pc(r.Lden.dansClasse)} | ${f1(r.Ln.modele)} / ${f1(r.Ln.reference)}`);
const cibles = ['R DE STRASBOURG', 'R GENERAL LECLERC DE HAUTECLOCQUE', 'R DE LA COMMUNE', "PL DE L'HOTEL DE VILLE"];
console.log('\nRues du site :');
for (const r of R.rues.filter((x) => cibles.includes(x.rue))) console.log(`${r.rue} | ${r.n} | ${f1(r.Lden.modele)} / ${f1(r.Lden.reference)} | ${pc(r.Lden.dansClasse)} | ${f1(r.Ln.modele)} / ${f1(r.Ln.reference)} | Ln dans la classe ${pc(r.Ln.dansClasse)}`);
// comparaison avec les cartes de l'État (data/bruit.geojson, type A routes) : même mesure sur les mêmes points
const fEtat = path.join(racine, 'data/bruit.geojson');
if (fs.existsSync(fEtat)) {
  const etat = lire(fEtat).features.filter((f) => f.properties.type !== 'C' && f.properties.source === 'routes');
  const zones = etat.map((f) => ({ ind: f.properties.indicateur, n: f.properties.db_lo, polys: (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).map((P) => P.map((a) => a.map(([lon, lat]) => { const q = proj.versLocal(lat, lon); return [q.x, q.z]; }))) }));
  const dans = (a, x, z) => { let d = false; for (let i = 0, j = a.length - 1; i < a.length; j = i++) { const [xi, zi] = a[i], [xj, zj] = a[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) d = !d; } return d; };
  const st = { Lden: { n: 0, ok: 0, m: 0 }, Ln: { n: 0, ok: 0, m: 0 } };
  for (const p of refs) {
    const x = rec[4 * p.r], z = rec[4 * p.r + 1];
    for (const ind of ['Lden', 'Ln']) {
      const cl = ind === 'Lden' ? p.lden : p.ln;
      if (!cl || !Number.isFinite(cl[0])) continue; // seulement les points cartographiés par la référence (≥ 55 / 50)
      let n = null;
      for (const Z of zones) if (Z.ind === ind && (n == null || Z.n > n) && Z.polys.some((P) => dans(P[0], x, z) && !P.slice(1).some((t) => dans(t, x, z)))) n = Z.n;
      st[ind].n++;
      if (n === cl[0]) st[ind].ok++;
      const v = apres.L[ind][p.r];
      if (Number.isFinite(v) && v >= cl[0] && v < cl[1]) st[ind].m++;
    }
  }
  for (const ind of ['Lden', 'Ln']) console.log(`Cartes de l'État (routes, type A) sur les ${st[ind].n} points ${ind} cartographiés par la référence : bonne classe ${pc(st[ind].ok / st[ind].n)} (hors carte = faux) ; modèle : ${pc(st[ind].m / st[ind].n)}`);
  R.etat = st;
}
const sortie = {
  ...Mf,
  description: 'Paramètres du modèle de bruit de l\'atlas (js/bruit-calcul.js), estimation pédagogique. Trafics par type de voie OSM, facteur des comptages du classement sonore, part de la nuit, correction globale et SEL du tramway calibrés par outils/bruit/calibrer-modele.mjs sur une carte de référence locale (non jointe). Aucune donnée de la référence dans ce fichier.',
  calibration: {
    date: new Date().toISOString().slice(0, 10), points: refs.length, outil: 'outils/bruit/calibrer-modele.mjs',
    reference: 'cartes de bruit stratégiques de Nantes Métropole (2022, GAMBA), routes, classes de 5 dB(A), points à 4 m hors bâti (fichier local non publié)',
    Lden: R.Lden, Ln: R.Ln, cartes_etat: R.etat || null,
    rues: R.rues.filter((x) => x.n >= 15).map((r) => ({ rue: r.rue, n: r.n, lden_modele: r.Lden.modele && +r.Lden.modele.toFixed(1), lden_dans_classe: r.Lden.dansClasse && +r.Lden.dansClasse.toFixed(2), ln_modele: r.Ln.modele && +r.Ln.modele.toFixed(1) })),
  },
};
fs.writeFileSync(fSortie, `${JSON.stringify(sortie, null, 2)}\n`);
console.log(`\nécrit : ${fSortie}`);
