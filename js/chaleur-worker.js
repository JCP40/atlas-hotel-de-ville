// Calculs longs de Confort et Chaleur hors du fil principal (Web Worker module, 08/11/2026) : l'interface et la maquette
// restent fluides et le calcul n'est plus interrompu à chaque image (sur le fil principal, chaque pause rendue au navigateur
// laisse passer une image de la maquette 3D, qui peut coûter plus cher que le calcul lui-même).
// Mêmes fonctions que sur le fil principal (js/chaleur-modele.js, js/gpu.js) : résultats identiques.
// Messages : { id, op: 'svf' | 'masques' | 'journee', ... } → { id, progres } puis { id, resultat } ou { id, erreur }.
import { svfProcesseur, masquesProcesseur, simulerJournee } from './chaleur-modele.js';
import { svfCPU, masquesCPU } from './gpu.js';
import { creerSolveur } from './vent-calcul.js';
import { abriCiel } from './vent-abri.js';

const envoyer = (m, t = []) => self.postMessage(m, t);

self.onmessage = async ({ data: D }) => {
  const { id } = D;
  // progression au plus toutes les 0,4 s, et pas avant 0,4 s de calcul : chaque message est une tâche du fil principal,
  // suivie d'une image de la maquette (un calcul court n'en envoie aucun)
  let dernier = performance.now();
  const progres = (etape) => (u) => { const t = performance.now(); if (t - dernier > 400) { dernier = t; envoyer({ id, progres: { etape, u } }); } };
  const noteTexte = (texte) => { const m = /(\d+) %/.exec(texte); if (m) progres(texte.replace(/ :.*/, ''))(Number(m[1]) / 100); };
  try {
    if (D.op === 'svf') { // ouverture au ciel de Confort (svfCPU : même boucle que confort.js)
      const t0 = performance.now();
      const r = await svfCPU(D.g, D.pts, { ...D.options, note: noteTexte });
      envoyer({ id, resultat: { svf: r, ms: performance.now() - t0 } }, [r.buffer]);
      return;
    }
    if (D.op === 'masques') { // ombres de toutes les heures (rayonnement au sol de Confort)
      const t0 = performance.now();
      const M = await masquesCPU(D.g, D.pts, D.soleils, { ...D.options, note: noteTexte });
      envoyer({ id, resultat: { M, ms: performance.now() - t0 } }, [M.buffer]);
      return;
    }
    if (D.op === 'journee') { // Chaleur : ouverture au ciel, ombres (si la carte graphique ne les a pas faites), journée
      const { P, g, positions, classes, heures, options } = D;
      const ms = {};
      let t0 = performance.now();
      if (D.svf) { await svfProcesseur(P, g, { progres: progres('Ouverture au ciel') }); ms.svf = performance.now() - t0; }
      // vent réduit selon l'ouverture au ciel (abriCiel, repli unique du vent local) : toutes les mailles (true) ou celles hors du champ de l'outil Vent (liste)
      if (D.fvCiel === true) for (let i = 0; i < P.n; i++) P.fv[i] = abriCiel(P.svf[i]);
      else if (D.fvCiel) for (const i of D.fvCiel) P.fv[i] = abriCiel(P.svf[i]);
      t0 = performance.now();
      const M = D.M || await masquesProcesseur(P, g, positions, { progres: progres('Ombres') });
      if (!D.M) ms.masques = performance.now() - t0;
      t0 = performance.now();
      const R = simulerJournee(P, classes, heures, positions, M, { ...options, progres: progres('Bilan d\'énergie de la journée') });
      ms.journee = performance.now() - t0;
      envoyer({ id, resultat: { svf: P.svf, fv: P.fv, M, R, ms } }, [R.T.buffer, R.Tmax.buffer, R.hMax.buffer, ...(D.M ? [] : [M.buffer])]);
      return;
    }
    if (D.op === 'vent') { // UTCI : directions de la bibliothèque du vent à 1 m/s, 1,5 m (js/vent-local.js)
      const t0 = performance.now();
      const sv = creerSolveur({ solid: D.solid, hgt: D.hgt, n: D.n, h: D.h });
      const champs = [];
      D.directions.forEach((d, i) => {
        sv.resoudre(d, 1);
        champs.push({ U: Float32Array.from(sv.U), V: Float32Array.from(sv.V) });
        progres('Écoulement du vent')((i + 1) / D.directions.length);
      });
      envoyer({ id, resultat: { champs, ms: performance.now() - t0 } }, champs.flatMap((c) => [c.U.buffer, c.V.buffer]));
      return;
    }
    throw new Error(`opération inconnue : ${D.op}`);
  } catch (e) {
    envoyer({ id, erreur: e?.message || String(e) });
  }
};
