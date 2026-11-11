// Tests de js/utci.js : node outils/utci/test-utci.mjs (valeurs de référence calculées en Python avec l'expression d'origine du polynôme UTCI_approx, ln(TK) du code UTCI_a002)
import { utci, classeUTCI, pressionSaturante, versDixMetres, tmrtSimplifiee, TERMES } from '../../js/utci.js';
const CAS = [
  // Ta, Tmrt, va (10 m), HR, UTCI attendu (°C)
  [20, 20, 0.5, 50, 19.85], // référence : pas de stress, UTCI ≈ Ta
  [25, 25, 1, 50, 24.61], // exemple de la documentation de pythermalcomfort : 24,6
  [30, 50, 1, 50, 35.43], // été, au soleil : stress de chaleur fort
  [35, 60, 1, 40, 41.62], // chaleur très forte
  [-10, -15, 8, 80, -36.75], // froid venté
  [10, 10, 15, 70, -16.75], // vent fort
  [0, 0, 4, 80, -10.83],
  [-25, -25, 10, 70, -54.21],
];
let ok = true;
const t0 = performance.now();
if (TERMES.length !== 210) { console.log('ÉCHEC nombre de termes', TERMES.length); ok = false; }
for (const [ta, tr, v, hr, att] of CAS) {
  const u = utci(ta, tr, v, hr);
  const bon = Math.abs(u - att) < 0.01;
  ok &&= bon;
  console.log(`${bon ? 'ok   ' : 'ÉCHEC'} Ta ${ta} Tmrt ${tr} va ${v} HR ${hr} → UTCI ${u.toFixed(2)} (attendu ${att}) ${classeUTCI(u).libelle}`);
}
const es = pressionSaturante(20); // 23,39 hPa (Hardy 1998)
if (Math.abs(es - 23.39) > 0.02) { console.log('ÉCHEC pression saturante', es); ok = false; }
if (Math.abs(versDixMetres(1) - 1.488) > 0.01) { console.log('ÉCHEC vent à 10 m', versDixMetres(1)); ok = false; }
// Tmrt à l'ombre, ciel et sol à la température de l'air, émissivités 1 → Tmrt ≈ Ta
const s = 5.67e-8 * 293.15 ** 4;
const tm = tmrtSimplifiee({ svf: 1, Lciel: s, Lmurs: s, Lsol: s, ep: 0.97 });
if (Math.abs(tm - 20) > 0.05) { console.log('ÉCHEC Tmrt neutre', tm); ok = false; }
let n = 0; const t1 = performance.now();
for (let i = 0; i < 100000; i++) n += utci(15 + (i % 20), 30, 2, 60);
console.log(`100 000 évaluations : ${Math.round(performance.now() - t1)} ms`);
console.log(ok ? 'TOUS LES TESTS PASSENT' : 'DES TESTS ÉCHOUENT');
process.exit(ok ? 0 : 1);
