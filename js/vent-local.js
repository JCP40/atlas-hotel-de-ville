// Vent local à 1,5 m pour l'UTCI de Confort (08/11/2026) : champs à 1 m/s (même solveur, même grille et mêmes itérations que
// l'outil Vent : js/vent-calcul.js) calculés dans le Web Worker (js/chaleur-worker.js, op « vent »), gardés tant que le bâti
// ne change pas (bibliothèque des 24 directions remplie à la demande, + directions hors bibliothèque déjà demandées), × vitesse
// (le calcul est linéaire en vitesse). Avant : calcul exact sur le fil principal par lots de 25 ms (une image de la maquette par lot).
// Direction multiple de 15° (rose à 12 secteurs, 240° par défaut) : champ de la bibliothèque. Autre direction : calcul exact de
// cette direction dans le worker (un solveur, ≈ 0,1 s), PAS le mélange des deux voisines : mesuré sur les mailles de Confort à 4 m/s,
// le mélange s'écarte du calcul exact de 0,07 à 0,17 m/s en moyenne à 7,5° des voisines (jusqu'à 2 m/s en bord de sillage),
// au-delà de la tolérance de 0,05 m/s ; `melanger: true` le permet quand même (aperçu). Échantillonnage vectorisé : rapports
// (vitesse locale / vent libre) de toutes les mailles demandées en un passage. Sans worker : null (calcul exact
// d'origine). Branchement (15/11/2026) : créé par js/vent.js (creerVentLocal) et appelé par app.vent.ventLocal({ calculer: true }),
// fonction publique unique du vent local (Chaleur, Confort, UTCI) ; plus de remplacement de app.vent.champPour à l'exécution
// (avant : installerVentLocal, minuterie de 250 ms). index.html le charge encore en script module : sans effet (aucun code au chargement).
import { N, HALF, preparerBatiments, creerGrille, filtrerHauteur, echantillonChamp, SECTEURS_BIBLIO, HAUTEUR_PIETON } from './vent-calcul.js';
import { visibiliteBatiment } from './maquette.js';
import { calculEnFond } from './chaleur-modele.js';

export function creerVentLocal(app) {
  const pas = 360 / SECTEURS_BIBLIO;
  let cache = { sig: null, grille: null, champs: new Map() }; // champs : k → { U, V, M } à 1 m/s

  // grille du bâti à 1,5 m : mêmes empreintes que l'entrée « piéton » de l'outil Vent (vent.js, entreeHauteur)
  function grillePieton() {
    const effectif = app.batiEffectif?.() ?? app.empreintes ?? [];
    const vue = { ...app, vueMaquette: false };
    const base = effectif.filter((e) => visibiliteBatiment(vue, e.cle) && Math.hypot(e.cx, e.cz) <= HALF * Math.SQRT2 + 40);
    return creerGrille(preparerBatiments(filtrerHauteur(base, HAUTEUR_PIETON)));
  }
  // signature de la grille (cellules pleines et hauteurs) : FNV-1a 32 bits
  function signature(g) {
    let x = 0x811c9dc5;
    for (let k = 0; k < g.solid.length; k++) {
      if (!g.solid[k]) continue;
      x = Math.imul(x ^ k, 0x01000193); x = Math.imul(x ^ Math.round(g.hgt[k] * 10), 0x01000193);
    }
    return `${app.etat}|${(x >>> 0).toString(36)}`;
  }

  // directions de la bibliothèque nécessaires pour `direction` : k0, k1, poids t de k1
  function voisines(direction) {
    const a = ((((direction % 360) + 360) % 360) / pas);
    const k0 = Math.floor(a + 1e-9) % SECTEURS_BIBLIO, t = Math.max(0, a - Math.floor(a + 1e-9));
    return t < 1e-6 ? { k0, k1: k0, t: 0 } : { k0, k1: (k0 + 1) % SECTEURS_BIBLIO, t };
  }

  // champ à 1,5 m pour (direction, vitesse) → { direction, vitesse, hauteur, source, ms, echantillon, rapports(xs, zs) } ou null
  async function champ(direction, vitesse, progres = () => {}, { melanger = false } = {}) {
    const t0 = performance.now();
    const g = grillePieton();
    const sig = signature(g);
    if (cache.sig !== sig) cache = { sig, grille: g, champs: new Map() };
    const vois = voisines(direction);
    const exact = vois.t > 0 && !melanger; // direction hors bibliothèque : calcul exact (clé « d<degrés> »)
    const { k0, k1, t } = exact ? { k0: `d${direction}`, k1: `d${direction}`, t: 0 } : vois;
    const manquent = [...new Set([k0, k1])].filter((k) => !cache.champs.has(k));
    let msCalcul = 0;
    if (manquent.length) {
      const tache = calculEnFond('vent', { solid: g.solid, hgt: g.hgt, n: g.n, h: g.h, directions: manquent.map((k) => (typeof k === 'string' ? +k.slice(1) : k * pas)) }, [], (p) => progres(p.u));
      if (!tache) return null;
      const r = await tache; // rejet (worker tombé) : l'appelant reprend le calcul d'origine
      if (cache.sig !== sig) return null;
      r.champs.forEach((c, i) => {
        const M = new Float32Array(c.U.length);
        for (let q = 0; q < M.length; q++) M[q] = Math.hypot(c.U[q], c.V[q]);
        cache.champs.set(manquent[i], { U: c.U, V: c.V, M });
      });
      msCalcul = r.ms;
    }
    // mélange des deux voisines × vitesse (creerBibliotheque.interpoler, toute la grille)
    const A = cache.champs.get(k0), B = cache.champs.get(k1), s = 1 - t, NN = N * N;
    const U = new Float32Array(NN), V = new Float32Array(NN);
    for (let i = 0; i < NN; i++) {
      const m = (s * A.M[i] + t * B.M[i]) * vitesse;
      const u = s * A.U[i] + t * B.U[i], v = s * A.V[i] + t * B.V[i], l = Math.hypot(u, v);
      const f = l > 1e-6 ? m / l : 0;
      U[i] = u * f; V[i] = v * f;
    }
    const out = [0, 0];
    return {
      direction, vitesse, hauteur: HAUTEUR_PIETON, attente: 0, source: exact ? 'exact' : t ? 'melange' : 'bibliotheque', directions: exact ? [direction] : [k0 * pas, k1 * pas], t,
      ms: performance.now() - t0, msCalcul, calcules: manquent.length,
      // repère atlas (z sud) ; false hors de la grille du calcul
      echantillon: (x, z, o) => echantillonChamp(U, V, x, -z, o),
      // rapports vitesse locale / vent libre (≤ 2,5) de toutes les mailles (xs, zs) ; NaN hors de la grille
      rapports(xs, zs) {
        const R = new Float32Array(xs.length);
        for (let i = 0; i < xs.length; i++) R[i] = vitesse > 0 && echantillonChamp(U, V, xs[i], -zs[i], out) ? Math.min(2.5, Math.hypot(out[0], out[1]) / vitesse) : NaN;
        return R;
      },
    };
  }
  return { champ, voisines, get cache() { return cache; }, vider() { cache = { sig: null, grille: null, champs: new Map() }; } };
}
