// Calcul du modèle de bruit hors du fil principal (Web Worker module, 21/11/2026) : propagation (js/bruit-calcul.js).
// Messages : { id, op: 'transferts' | 'points', scene, recepteurs, points?, options } → { id, progres } puis { id, resultat } ou { id, erreur }.
// Plusieurs workers se partagent les récepteurs (js/bruit-modele.js) : chacun reçoit la scène raster entière.
import { calculerTransferts, transfertsPoints } from './bruit-calcul.js';

self.onmessage = ({ data: D }) => {
  const { id } = D;
  let dernier = performance.now();
  const progres = (u) => { const t = performance.now(); if (t - dernier > 400) { dernier = t; self.postMessage({ id, progres: u }); } };
  try {
    const t0 = performance.now();
    if (D.op === 'transferts') {
      const T = calculerTransferts(D.scene, D.recepteurs, { ...D.options, progres });
      self.postMessage({ id, resultat: { ...T, ms: performance.now() - t0 } }, [T.offsets.buffer, T.groupes.buffer, T.valeurs.buffer, T.interieur.buffer]);
    } else if (D.op === 'points') {
      const P = transfertsPoints(D.scene, D.recepteurs, D.points, D.options);
      self.postMessage({ id, resultat: { T: P, ms: performance.now() - t0 } }, [P.buffer]);
    } else throw new Error(`opération inconnue : ${D.op}`);
  } catch (e) {
    self.postMessage({ id, erreur: e.message || String(e) });
  }
};
