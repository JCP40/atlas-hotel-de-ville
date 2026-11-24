import * as THREE from 'three';
import { h, info, lireLS, ecrireLS, viderGroupe } from './util.js';
import { telecharger } from './donnees.js';
import * as B from './bruit-calcul.js';

// Modèle de bruit de l'atlas (21/11/2026), section « Modèle (estimation) » de l'outil Bruit (js/bruit.js, seul point d'accroche).
// ESTIMATION PÉDAGOGIQUE inspirée de CNOSSOS-EU (méthode et limites : js/bruit-calcul.js) : sources = tronçons OSM (trafics par type
// de voie calibrés, comptages du classement sonore quand ils existent), bus et tramway (lignes de js/flux.js), sources ponctuelles
// ajoutées ; propagation sur le bâti effectif (Web Workers js/bruit-worker.js) ; paramètres dans data/bruit-modele.json
// (outils/bruit/calibrer-modele.mjs). Récepteurs à 4 m : grille de 5 m dans config.rayonEtude, façades photo (tous les mètres, 2 m
// devant), bâtiments du périmètre (tous les 4 m, 2 m à l'extérieur).
// Scénario (phase Projet seulement) : statut des tronçons (zone 30, zone de rencontre, piétonne, bus et tram seulement, trafic
// personnalisé), report du trafic, sources ponctuelles ; gardé dans data/projet.json, clé « bruit » (js/projet.js : serialiser/lire).
// Affichages : cartes officielles (js/bruit.js) | modèle (classes de 5 dB ou dégradé) | écart projet − existant | référence locale
// (data/bruit-reference-nantes-metropole.geojson, © Nantes Métropole, si l'utilisateur l'a copiée : jamais republiée).

const CLE = 'atlas-hdv-bruit-modele'; // { affichage, continu }
const COULEUR_SEL = '#ffd400';
const ECART_MAX = 10;
const STATUTS = [
  ['actuel', 'actuel (pas de changement)'], ['zone30', 'zone 30'], ['zone20', 'zone de rencontre (20 km/h)'],
  ['pietonne', 'rue piétonne'], ['transports', 'bus et tramway seulement'], ['perso', 'trafic personnalisé'],
];
const LIB_STATUT = Object.fromEntries(STATUTS);
const virgule = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d).replace('.', ','));
const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const PALETTE_ECART = [[0, [33, 102, 172]], [0.25, [103, 169, 207]], [0.45, [230, 240, 246]], [0.5, [247, 247, 247]], [0.55, [253, 228, 216]], [0.75, [239, 138, 98]], [1, [178, 24, 43]]];
const PALETTE_CONTINU = [[0, [185, 220, 164]], [0.2, [240, 228, 66]], [0.4, [247, 179, 43]], [0.55, [239, 125, 45]], [0.7, [215, 38, 61]], [0.85, [142, 43, 83]], [1, [61, 61, 158]]];
const CONTINU = [40, 80]; // dB(A), bornes du dégradé
function interpoler(P, u) {
  u = Math.max(0, Math.min(1, u));
  for (let i = 1; i < P.length; i++) if (u <= P[i][0]) { const [a, ca] = P[i - 1], [b, cb] = P[i], t = (u - a) / (b - a || 1); return ca.map((v, k) => Math.round(v + (cb[k] - v) * t)); }
  return P[P.length - 1][1];
}

export function creerModeleBruit(app, { classes, auChangement = () => {}, nuit = () => false } = {}) {
  const memo = (() => { try { return JSON.parse(lireLS(CLE) || 'null'); } catch { return null; } })() || {};
  const etat = {
    affichage: ['modele', 'ecart', 'reference'].includes(memo.affichage) ? memo.affichage : 'officielles',
    continu: !!memo.continu,
    modele: null, // paramètres (data/bruit-modele.json fusionnés)
    sources: null, recepteurs: null, meta: null, grille: null,
    transferts: new Map(), // signature du bâti → { T, ms }
    resultats: { existant: null, projet: null },
    calcul: null, progres: null, erreur: null, ms: null,
    scenario: { troncons: {}, report: { pourcent: 0, rayon: 200 }, points: [] },
    selection: [], portee: 'rue', choix: false, ajoutPoint: null,
    reference: null, comparaison: null,
  };
  const memoriser = () => ecrireLS(CLE, JSON.stringify({ affichage: etat.affichage, continu: etat.continu }));
  const ui = {};
  const groupe = new THREE.Group();
  groupe.name = 'bruit-modele';
  app.scene.add(groupe);
  const groupeSel = new THREE.Group();
  groupeSel.name = 'bruit-modele-selection';
  groupeSel.userData.horsDecoupe = true;
  app.scene.add(groupeSel);
  const indic = () => (nuit() ? 'Ln' : 'Lden');
  const phaseProjet = () => app.phase?.phase === 'projet' || (!app.phase && app.projet?.etat?.visible);
  const classeDe = (n) => classes.find((c) => n >= c.min && n < c.max) || null;

  // ------------------------------------------------------------
  // Données
  // ------------------------------------------------------------
  let pret = null;
  function charger() {
    return (pret ||= (async () => {
      const m = await fetch('data/bruit-modele.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      etat.modele = B.fusionnerModele(m || {});
      etat.modeleCalibre = !!m?.calibration;
      etat.classement = await fetch('data/classement-sonore.geojson').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      lire(app.projet?.etat?.bruitLu ?? null);
    })());
  }
  function sources() {
    if (etat.sources) return etat.sources;
    const E = B.entreesDepuisGeo({ voirie: app.donnees?.osm?.voirie, lignes: app.donnees?.osm?.lignes, classement: etat.classement }, app.proj);
    etat.sources = B.preparerSources(E, etat.modele);
    etat.index = new Map(etat.sources.map((s, g) => [s.id, g]));
    return etat.sources;
  }

  // récepteurs : grille (5 m), façades photo, bâtiments (du bâti EXISTANT : mêmes points pour les deux phases)
  const R = () => app.config.rayonEtude || 420;
  function preparerRecepteurs(batiExistant) {
    const pas = etat.modele.calcul.grille_m || 5, r = R();
    const n = Math.ceil((2 * r) / pas), x0 = -(n * pas) / 2, z0 = x0;
    const rec = [], meta = [];
    const grille = { nx: n, nz: n, x0, z0, pas, idx: new Int32Array(n * n).fill(-1) };
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = x0 + (i + 0.5) * pas, z = z0 + (j + 0.5) * pas;
      if (Math.hypot(x, z) > r) continue;
      grille.idx[j * n + i] = rec.length / 4;
      rec.push(x, z, 0, 0);
    }
    const nGrille = rec.length / 4;
    const facades = new Map(), batiments = new Map();
    for (const f of app.toits?.toutesFacades?.() || []) {
      const [gx, gz] = f.gauche, [dx, dz] = f.droite, L = Math.hypot(dx - gx, dz - gz);
      if (!(L > 0.2)) continue;
      const ux = (dx - gx) / L, uz = (dz - gz) / L, az = (f.normale_az * Math.PI) / 180;
      let nx = Math.sin(az), nz = -Math.cos(az);
      if (!Number.isFinite(nx)) { nx = -uz; nz = ux; }
      const k = Math.max(2, Math.ceil(L)), L0 = rec.length / 4;
      for (let q = 0; q <= k; q++) { const s = (q / k) * L; rec.push(gx + ux * s + nx * 2, gz + uz * s + nz * 2, nx, nz); }
      facades.set(String(f.id), [L0, rec.length / 4]);
    }
    const nFac = rec.length / 4;
    for (const e of batiExistant) {
      if (!(Math.hypot(e.cx, e.cz) <= r)) continue;
      const L0 = rec.length / 4;
      for (const poly of e.polys || []) {
        const ext = poly[0];
        if (!ext || ext.length < 3) continue;
        for (let a = 0; a < ext.length; a++) {
          const [x1, z1] = ext[a], [x2, z2] = ext[(a + 1) % ext.length], L = Math.hypot(x2 - x1, z2 - z1);
          if (L < 0.5) continue;
          const ux = (x2 - x1) / L, uz = (z2 - z1) / L, k = Math.max(1, Math.round(L / 4));
          for (let q = 0; q < k; q++) {
            const s = ((q + 0.5) / k) * L, px = x1 + ux * s, pz = z1 + uz * s;
            let nx = -uz, nz = ux;
            if (dansAnneau(ext, px + nx * 0.5, pz + nz * 0.5)) { nx = -nx; nz = -nz; }
            rec.push(px + nx * 2, pz + nz * 2, nx, nz);
          }
        }
      }
      if (rec.length / 4 > L0) batiments.set(cleBatiment(e), [L0, rec.length / 4]);
    }
    etat.recepteurs = Float32Array.from(rec);
    etat.meta = { nGrille, nFac, n: rec.length / 4, facades, batiments };
    etat.grille = grille;
  }
  function dansAnneau(a, x, z) {
    let d = false;
    for (let i = 0, j = a.length - 1; i < a.length; j = i++) { const [xi, zi] = a[i], [xj, zj] = a[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) d = !d; }
    return d;
  }
  const cleBatiment = (e) => String(e.id || e.cle || (() => { const g = app.proj.versGeo(e.cx, e.cz); return `g${g.lat.toFixed(6)},${g.lon.toFixed(6)}`; })());

  // bâti des deux phases, quel que soit l'état du calque Projet
  function batiPhases() {
    const P = app.projet;
    const eff = app.batiEffectif?.() || app.empreintes || [];
    const visible = P?.etat?.visible !== false;
    const demolis = new Set([...(P?.etat?.demolis?.keys?.() || [])]);
    let existant, projet;
    if (visible) {
      existant = [...eff.filter((e) => !e.projet), ...(P?.demolisVisibles?.() || [])];
      projet = eff;
    } else {
      existant = eff;
      const formes = (P?.etat?.formes || []).filter((f) => f.vis).map((f) => P.empreinteForme(f));
      projet = [...eff.filter((e) => !demolis.has(String(e.id))), ...formes, ...(app.imports?.empreintes?.() || [])];
    }
    const conv = (L) => L.map((e) => ({ polys: e.polys, h: e.hauteur ?? e.h }));
    return { existant: conv(existant), projet: conv(projet), existantBrut: existant };
  }
  const signature = (L) => { let s = 0, k = 0; for (const e of L) { s += (e.h || 0) * 7.13 + (e.polys?.[0]?.[0]?.[0]?.[0] || 0) * 0.37 + (e.polys?.[0]?.[0]?.length || 0); k++; } return `${k}:${s.toFixed(3)}`; };

  // ------------------------------------------------------------
  // Calcul (Web Workers)
  // ------------------------------------------------------------
  let workers = null, idMsg = 0;
  function pool() {
    if (workers) return workers;
    const nb = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    workers = Array.from({ length: nb }, () => new Worker(new URL('./bruit-worker.js', import.meta.url), { type: 'module' }));
    return workers;
  }
  function tache(w, msg, transfert = [], surProgres = () => {}) {
    return new Promise((ok, ko) => {
      const id = ++idMsg;
      const f = ({ data }) => {
        if (data.id !== id) return;
        if (data.progres != null) { surProgres(data.progres); return; }
        w.removeEventListener('message', f);
        if (data.erreur) ko(new Error(data.erreur)); else ok(data.resultat);
      };
      w.addEventListener('message', f);
      w.postMessage({ id, ...msg }, transfert);
    });
  }
  const sceneTransfert = (S) => ({ n: S.n, x0: S.x0, z0: S.z0, pas: S.pas, H: S.H, NX: S.NX, NZ: S.NZ, gA: S.gA, gB: S.gB, dens: S.dens, G: S.G });
  async function transferts(bati, libelle) {
    const sig = signature(bati);
    if (etat.transferts.has(sig)) return etat.transferts.get(sig);
    const M = etat.modele, src = sources();
    const t0 = performance.now();
    const S = B.construireScene({ batiments: bati, sources: src, demiCote: R() + M.calcul.rayon_m, pas: M.calcul.pas });
    const W = pool(), rec = etat.recepteurs, n = rec.length / 4;
    // morceaux entrelacés (la grille et les façades n'ont pas le même coût) : 4 par worker
    const nb = W.length * 4, tailles = [];
    for (let k = 0; k < nb; k++) tailles.push([Math.floor((k * n) / nb), Math.floor(((k + 1) * n) / nb)]);
    const prog = new Float64Array(nb);
    const maj = () => { etat.progres = `${libelle} : ${Math.round((prog.reduce((a, b) => a + b, 0) / nb) * 100)} %`; majEtat(); };
    const scene = sceneTransfert(S);
    let suivant = 0;
    const parts = new Array(nb);
    await Promise.all(W.map(async (w) => {
      while (suivant < nb) {
        const k = suivant++;
        const [a, b] = tailles[k];
        const r = await tache(w, { op: 'transferts', scene, recepteurs: rec.slice(4 * a, 4 * b), options: M.calcul }, [], (u) => { prog[k] = u; maj(); });
        prog[k] = 1; maj();
        parts[k] = r;
      }
    }));
    // fusion CSR
    let tot = 0;
    for (const p of parts) tot += p.valeurs.length;
    const offsets = new Int32Array(n + 1), groupes = new Int32Array(tot), valeurs = new Float32Array(tot), interieur = new Uint8Array(n);
    let pos = 0, r0 = 0;
    for (const p of parts) {
      for (let i = 0; i < p.n; i++) offsets[r0 + i] = p.offsets[i] + pos;
      groupes.set(p.groupes, pos); valeurs.set(p.valeurs, pos); interieur.set(p.interieur, r0);
      pos += p.valeurs.length; r0 += p.n;
    }
    offsets[n] = pos;
    const res = { T: { offsets, groupes, valeurs, interieur, n }, S, ms: performance.now() - t0 };
    etat.transferts.set(sig, res);
    etat.msPropagation = res.ms;
    while (etat.transferts.size > 3) etat.transferts.delete(etat.transferts.keys().next().value);
    return res;
  }
  async function transfertsPoints(S, points) {
    if (!points.length) return null;
    const P = points.map((p) => { const q = app.proj.versLocal(p.lat, p.lon); return { x: q.x, z: q.z, h: p.h ?? 1.5 }; });
    const r = await tache(pool()[0], { op: 'points', scene: sceneTransfert(S), recepteurs: etat.recepteurs, points: P, options: etat.modele.calcul });
    return r.T;
  }
  function parametresPoints(points) {
    const D = etat.modele.points;
    return {
      lw: points.map((p) => p.lw ?? D[p.type]?.lw ?? 85),
      parts: points.map((p) => { const q = p.parts || D[p.type]?.parts || { jour: 1, soir: 1, nuit: 0 }; return [q.jour ?? 0, q.soir ?? 0, q.nuit ?? 0]; }),
    };
  }

  // calcul complet (existant + projet si besoin), puis affichage
  async function calculer({ projet = true } = {}) {
    if (etat.calcul) return etat.calcul;
    etat.erreur = null;
    etat.calcul = (async () => {
      await charger();
      if (!app.donnees?.osm?.voirie?.features?.length) throw new Error('voirie OSM absente (données hors ligne non préparées)');
      const t0 = performance.now();
      const bp = batiPhases();
      if (!etat.recepteurs) preparerRecepteurs(bp.existantBrut);
      const src = sources();
      const ex = await transferts(bp.existant, 'Propagation, existant');
      const E0 = B.emissions(src, etat.modele).E;
      etat.resultats.existant = { ...B.combiner(ex.T, E0), info: null };
      // routes et bus seulement (la référence de Nantes Métropole « routes » ne compte pas le tramway)
      etat.resultats.routes = B.combiner(ex.T, E0, { filtre: (g) => src[g].type !== 'tram' });
      if (projet) {
        const pr = await transferts(bp.projet, 'Propagation, projet');
        etat.progres = 'Scénario du projet…'; majEtat();
        const PT = await transfertsPoints(pr.S, etat.scenario.points);
        const em = B.emissions(src, etat.modele, etat.scenario);
        etat.resultats.projet = { ...B.combiner(pr.T, em.E, { points: PT ? { T: PT, ...parametresPoints(etat.scenario.points) } : null }), info: em.info, T: pr.T, PT };
      }
      etat.ms = performance.now() - t0;
      etat.progres = null;
      comparer();
    })();
    try { await etat.calcul; } catch (e) { etat.erreur = e.message; etat.progres = null; console.warn('Modèle de bruit :', e); } finally { etat.calcul = null; }
    dessiner(); majEtat(); auChangement();
    return etat.resultats;
  }
  // scénario modifié : recombinaison seule (transferts gardés), sauf nouvelles sources ponctuelles
  let minuterie = 0;
  function scenarioChange({ points = false } = {}) {
    clearTimeout(minuterie);
    minuterie = setTimeout(async () => {
      const P = etat.resultats.projet;
      if (!P?.T) { if (etat.affichage !== 'officielles') calculer(); return; }
      const sig = signature(batiPhases().projet), pr = etat.transferts.get(sig);
      if (!pr) { etat.resultats.projet = null; calculer(); return; }
      const PT = points || !P.PT ? await transfertsPoints(pr.S, etat.scenario.points) : P.PT;
      const em = B.emissions(sources(), etat.modele, etat.scenario);
      etat.resultats.projet = { ...B.combiner(pr.T, em.E, { points: PT ? { T: PT, ...parametresPoints(etat.scenario.points) } : null }), info: em.info, T: pr.T, PT };
      dessiner(); majEtat(); auChangement();
    }, 120);
  }

  // ------------------------------------------------------------
  // Affichage : texture sur la grille de 5 m (planche : image calée automatiquement, js/planche.js)
  // ------------------------------------------------------------
  const resultatAffiche = () => (phaseProjet() ? etat.resultats.projet : etat.resultats.existant) || etat.resultats.existant;
  function valeursGrille(quoi = etat.affichage, ind = indic()) {
    const G = etat.grille;
    if (!G) return null;
    const v = new Float32Array(G.nx * G.nz).fill(NaN);
    const E = etat.resultats.existant?.[ind], P = etat.resultats.projet?.[ind];
    const Ra = resultatAffiche()?.[ind];
    for (let c = 0; c < v.length; c++) {
      const r = G.idx[c];
      if (r < 0) continue;
      if (quoi === 'ecart') v[c] = P && E ? P[r] - E[r] : NaN;
      else if (quoi === 'reference') v[c] = etat.refGrille?.[ind]?.[c] ?? NaN;
      else v[c] = Ra ? Ra[r] : NaN;
    }
    return { ...G, v };
  }
  function couleur(v, quoi) {
    if (!Number.isFinite(v)) return null;
    if (quoi === 'ecart') {
      if (Math.abs(v) < 0.5) return [240, 240, 240, 70];
      return [...interpoler(PALETTE_ECART, (v + ECART_MAX) / (2 * ECART_MAX)), 225];
    }
    if (etat.continu && quoi !== 'reference') return [...interpoler(PALETTE_CONTINU, (v - CONTINU[0]) / (CONTINU[1] - CONTINU[0])), 215];
    const c = classeDe(v);
    return c ? [...hex(c.couleur), 205] : null;
  }
  function dessiner() {
    viderGroupe(groupe);
    const voir = !!app.couches.bruit && etat.affichage !== 'officielles';
    groupe.visible = voir;
    if (!voir) return;
    const G = valeursGrille();
    if (!G || (etat.affichage !== 'reference' && !etat.resultats.existant)) return;
    const data = new Uint8Array(G.nx * G.nz * 4);
    let k = 0;
    for (let c = 0; c < G.v.length; c++) {
      const col = couleur(G.v[c], etat.affichage);
      if (col) { data[4 * c] = col[0]; data[4 * c + 1] = col[1]; data[4 * c + 2] = col[2]; data[4 * c + 3] = col[3]; k++; }
    }
    if (!k) return;
    const tex = new THREE.DataTexture(data, G.nx, G.nz, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    const geo = new THREE.PlaneGeometry(G.nx * G.pas, G.nz * G.pas).rotateX(-Math.PI / 2);
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12 }));
    m.position.set(G.x0 + (G.nx * G.pas) / 2, 0.35, G.z0 + (G.nz * G.pas) / 2);
    m.name = `bruit-modele-${etat.affichage}`;
    m.renderOrder = 6;
    m.raycast = () => {};
    groupe.add(m);
    // isophones (limites des classes) en traits fins
    if (etat.affichage !== 'ecart') {
      const pos = [];
      for (const t of [55, 60, 65, 70, 75]) for (const a of B.contours(G, t)) for (let i = 0; i < a.length; i++) { const p = a[i], q = a[(i + 1) % a.length]; pos.push(p[0], 0.45, p[1], q[0], 0.45, q[1]); }
      if (pos.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#4a2a3a', transparent: true, opacity: 0.35, depthWrite: false }));
        l.renderOrder = 6.9; l.raycast = () => {}; l.name = 'bruit-modele-isophones';
        groupe.add(l);
      }
    }
  }

  // surbrillance des tronçons choisis et des tronçons modifiés
  function dessinerSelection() {
    viderGroupe(groupeSel);
    if (!app.couches.bruit || !etat.sources) return;
    const ajouter = (ids, couleur, y, op) => {
      const pos = [];
      for (const id of ids) {
        const g = etat.index.get(id);
        if (g == null) continue;
        const pts = etat.sources[g].pts;
        for (let i = 1; i < pts.length; i++) pos.push(pts[i - 1][0], y, pts[i - 1][1], pts[i][0], y, pts[i][1]);
      }
      if (!pos.length) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: couleur, transparent: true, opacity: op, depthTest: false }));
      l.renderOrder = 9; l.raycast = () => {};
      groupeSel.add(l);
    };
    ajouter(Object.keys(etat.scenario.troncons), '#7a1fa2', 0.7, 0.9);
    ajouter(etat.selection, COULEUR_SEL, 0.8, 1);
    for (const p of etat.scenario.points) {
      const q = app.proj.versLocal(p.lat, p.lon);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.4, 16), new THREE.MeshBasicMaterial({ color: '#7a1fa2', depthTest: false, transparent: true, opacity: 0.85 }));
      m.position.set(q.x, (app.relief?.dz?.(q.x, q.z) || 0) + 0.6, q.z);
      m.renderOrder = 9; m.raycast = () => {};
      groupeSel.add(m);
    }
    groupeSel.visible = phaseProjet() || etat.selection.length > 0;
  }

  // ------------------------------------------------------------
  // Référence locale (Nantes Métropole) : comparaison modèle / référence
  // ------------------------------------------------------------
  async function chargerReference() {
    if (etat.reference !== null) return etat.reference;
    const fc = await fetch('data/bruit-reference-nantes-metropole.geojson').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    etat.reference = fc?.features ? fc : false;
    return etat.reference;
  }
  // valeur interpolée (bilinéaire) de la grille de 5 m au point (x, z), mailles du bâti ignorées
  function echantillon(L, x, z) {
    const G = etat.grille, u = (x - G.x0) / G.pas - 0.5, v = (z - G.z0) / G.pas - 0.5, i = Math.floor(u), j = Math.floor(v);
    let s = 0, w = 0;
    for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= G.nx || jj >= G.nz) continue;
      const r = G.idx[jj * G.nx + ii], val = r >= 0 ? L[r] : NaN;
      if (!Number.isFinite(val)) continue;
      const p = (di ? u - i : 1 - (u - i)) * (dj ? v - j : 1 - (v - j));
      s += p * 10 ** (val / 10); w += p;
    }
    return w > 0.05 ? 10 * Math.log10(s / w) : NaN;
  }
  function comparer() {
    const fc = etat.reference, G = etat.grille, E = etat.resultats.routes;
    if (!fc || !G) { etat.comparaison = null; return; }
    const cls = (v, ind) => (v == null ? null : v === 0 ? [-Infinity, ind === 'Ln' ? 50 : 55] : v >= (ind === 'Ln' ? 70 : 75) ? [v, Infinity] : [v, v + 5]);
    etat.refGrille = { Lden: new Float32Array(G.nx * G.nz).fill(NaN), Ln: new Float32Array(G.nx * G.nz).fill(NaN) };
    const st = { Lden: { n: 0, ok: 0, pm: 0 }, Ln: { n: 0, ok: 0, pm: 0 } }, rues = new Map();
    const SITE = ['R DE STRASBOURG', 'R GENERAL LECLERC DE HAUTECLOCQUE', 'R DE LA COMMUNE', "PL DE L'HOTEL DE VILLE"];
    for (const f of fc.features) {
      const p = f.properties;
      if (!p.r) continue;
      const [lon, lat] = f.geometry.coordinates, q = app.proj.versLocal(lat, lon);
      const i = Math.floor((q.x - G.x0) / G.pas), j = Math.floor((q.z - G.z0) / G.pas);
      if (i < 0 || j < 0 || i >= G.nx || j >= G.nz) continue;
      const c = j * G.nx + i;
      ['Lden', 'Ln'].forEach((ind, k) => {
        const v0 = p.r[k];
        if (v0 == null) return;
        const cl = cls(v0, ind);
        etat.refGrille[ind][c] = Number.isFinite(cl[0]) && Number.isFinite(cl[1]) ? cl[0] + 2.5 : Number.isFinite(cl[0]) ? cl[0] + 2.5 : cl[1] - 2.5;
        const v = E ? echantillon(E[ind], q.x, q.z) : NaN;
        if (!Number.isFinite(v)) return;
        const e = v < cl[0] ? cl[0] - v : v >= cl[1] ? v - cl[1] : 0;
        st[ind].n++; if (e === 0) st[ind].ok++; if (e <= 5) st[ind].pm++;
        const rue = p.n >= 0 ? fc.rues?.[p.n] : null;
        if (rue && SITE.includes(rue) && (p.z === 'b' || p.z === 'c')) {
          if (!rues.has(rue)) rues.set(rue, { Lden: [], Ln: [], refLden: [], refLn: [] });
          rues.get(rue)[ind].push(v); rues.get(rue)[`ref${ind}`].push(etat.refGrille[ind][c]);
        }
      });
    }
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
    etat.comparaison = { st, rues: [...rues].map(([rue, o]) => ({ rue, n: o.Lden.length, Lden: med(o.Lden), refLden: med(o.refLden), Ln: med(o.Ln), refLn: med(o.refLn) })) };
  }

  // ------------------------------------------------------------
  // Valeurs par façade et bâtiment (tableau et CSV de js/bruit.js)
  // ------------------------------------------------------------
  function maxSur(L, [a, b]) { if (!L) return null; let m = -Infinity; for (let r = a; r < b; r++) if (L[r] > m) m = L[r]; return Number.isFinite(m) ? m : null; }
  function valeurs(r) {
    const M = etat.meta;
    if (!M || !etat.resultats.existant) return null;
    const plage = r.type === 'facade' ? M.facades.get(String(r.id)) : M.batiments.get(String(r.id));
    if (!plage) return null;
    const E = etat.resultats.existant, P = etat.resultats.projet;
    const o = { Lden: maxSur(E.Lden, plage), Ln: maxSur(E.Ln, plage), pLden: P ? maxSur(P.Lden, plage) : null, pLn: P ? maxSur(P.Ln, plage) : null };
    o.dLden = o.Lden != null && o.pLden != null ? o.pLden - o.Lden : null;
    o.dLn = o.Ln != null && o.pLn != null ? o.pLn - o.Ln : null;
    return o;
  }
  const actif = () => !!etat.resultats.existant;
  function entetes() {
    if (!actif()) return [];
    const ind = indic();
    return [h('th', { title: `Modèle de l'atlas (estimation), ${ind} existant, maximum sur la façade, dB(A)` }, `Mod. ${ind}`),
      etat.resultats.projet ? h('th', { title: `Modèle, ${ind} du projet (scénario de la phase Projet)` }, 'Projet') : null,
      etat.resultats.projet ? h('th', { title: 'Écart projet − existant (dB)' }, 'Δ') : null].filter(Boolean);
  }
  function cellules(r) {
    if (!actif()) return [];
    const v = valeurs(r), ind = indic();
    const a = v?.[ind], p = v?.[`p${ind}`], d = v?.[`d${ind}`];
    return [h('td', { class: a == null ? 'nc' : '' }, a == null ? '—' : virgule(a, 0)),
      etat.resultats.projet ? h('td', {}, p == null ? '—' : virgule(p, 0)) : null,
      etat.resultats.projet ? h('td', { class: d != null && d >= 1 ? 'depasse' : '', style: d != null && d <= -1 ? 'color:#2166ac;font-weight:600' : '' }, d == null ? '—' : `${d > 0 ? '+' : ''}${virgule(d)}`) : null].filter(Boolean);
  }
  const entetesCSV = () => ['modele_lden_existant', 'modele_ln_existant', 'modele_lden_projet', 'modele_ln_projet', 'modele_ecart_lden_db', 'modele_ecart_ln_db'];
  function valeursCSV(r) {
    const v = valeurs(r), a = (x) => (x == null ? '' : Math.round(x * 10) / 10);
    return v ? [a(v.Lden), a(v.Ln), a(v.pLden), a(v.pLn), a(v.dLden), a(v.dLn)] : ['', '', '', '', '', ''];
  }
  const noteCSV = () => (actif() ? ['# Colonnes modele_* : modèle de bruit de l\'atlas (estimation pédagogique inspirée de CNOSSOS-EU, calibrée sur la carte de Nantes Métropole ; ± 3 à 5 dB au mieux, pas une étude réglementaire), niveau maximal à 4 m sur les points de la façade (2 m devant) ; projet = scénario de la phase Projet ; écart = projet − existant'] : []);

  // ------------------------------------------------------------
  // Légende automatique, planche, DXF
  // ------------------------------------------------------------
  function legende() {
    if (!app.couches.bruit || etat.affichage === 'officielles') return [];
    const ind = indic();
    if (etat.affichage === 'ecart') {
      if (!etat.resultats.projet) return [];
      const stops = []; for (let u = 0; u <= 1.0001; u += 0.125) stops.push([u, interpoler(PALETTE_ECART, u)]);
      return [{ id: 'bruit-modele', titre: `Bruit ${ind} : écart projet − existant (modèle de l'atlas, estimation)`,
        degrade: { stops, graduations: [-10, -5, 0, 5, 10].map((v) => ({ u: (v + ECART_MAX) / (2 * ECART_MAX), texte: `${v > 0 ? '+' : ''}${v} dB` })), gauche: '◀ plus calme', droite: 'plus bruyant ▶' },
        note: 'Écart de moins de 0,5 dB : gris clair. 3 dB = énergie doublée ou divisée par deux ; 10 dB ≈ deux fois plus ou moins fort à l\'oreille.' }];
    }
    const titre = etat.affichage === 'reference' ? `Bruit ${ind} routier : référence Nantes Métropole (2022, copie locale)` : `Bruit ${ind} : modèle de l'atlas (estimation, ${phaseProjet() && etat.resultats.projet ? 'projet' : 'existant'}), 4 m`;
    if (etat.continu && etat.affichage !== 'reference') {
      const stops = []; for (let u = 0; u <= 1.0001; u += 0.125) stops.push([u, interpoler(PALETTE_CONTINU, u)]);
      return [{ id: 'bruit-modele', titre, degrade: { stops, graduations: [40, 50, 60, 70, 80].map((v) => ({ u: (v - CONTINU[0]) / (CONTINU[1] - CONTINU[0]), texte: `${v}` })), gauche: 'dB(A)' }, note: 'Estimation pédagogique : ± 3 à 5 dB au mieux.' }];
    }
    return [{ id: 'bruit-modele', titre, items: classes.map((c) => ({ libelle: c.libelle, couleur: c.couleur, forme: 'aplat' })), note: etat.affichage === 'reference' ? '© Nantes Métropole, carte de bruit stratégique (routes) : usage local, non republiable.' : 'Estimation pédagogique (± 3 à 5 dB au mieux), pas une carte réglementaire.' }];
  }
  function svgPlanche(X, Y) { // isophones du modèle (l'aplat est l'image calée ajoutée par js/planche.js)
    if (!app.couches.bruit || etat.affichage === 'officielles' || etat.affichage === 'ecart') return '';
    const G = valeursGrille();
    if (!G) return '';
    const o = [];
    for (const t of [55, 60, 65, 70, 75]) {
      const A = B.contours(G, t);
      if (A.length) o.push(`<path data-isophone="${t}" d="${A.map((a) => `M${a.map(([x, z]) => `${X(x).toFixed(2)} ${Y(z).toFixed(2)}`).join('L')}Z`).join('')}"/>`);
    }
    return o.length ? `<g id="bruit-modele-isophones" fill="none" stroke="#4a2a3a" stroke-width="0.15" opacity="0.6">${o.join('')}</g>` : '';
  }
  function entitesDXF() {
    if (!app.couches.bruit || etat.affichage === 'officielles') return [];
    const ind = indic(), I = ind.toUpperCase(), L = [];
    const G = valeursGrille();
    if (!G) return L;
    if (etat.affichage === 'ecart') {
      for (const t of [1, 3, 5, 10]) for (const a of B.contours(G, t)) L.push({ calque: `BRUIT_ECART_${I}_PLUS_${t}`, poly: [a] });
      const neg = { ...G, v: G.v.map((x) => -x) };
      for (const t of [1, 3, 5, 10]) for (const a of B.contours(neg, t)) L.push({ calque: `BRUIT_ECART_${I}_MOINS_${t}`, poly: [a] });
    } else {
      const ph = etat.affichage === 'reference' ? 'REFERENCE' : phaseProjet() && etat.resultats.projet ? 'PROJET' : 'EXISTANT';
      for (const t of [50, 55, 60, 65, 70, 75]) for (const a of B.contours(G, t)) L.push({ calque: `BRUIT_MODELE_${ph}_${I}_SUP_${t}`, poly: [a] });
    }
    return L;
  }

  // ------------------------------------------------------------
  // Scénario : sélection des tronçons, statuts, sources ponctuelles ; data/projet.json clé « bruit »
  // ------------------------------------------------------------
  function serialiser() {
    const S = etat.scenario;
    if (!Object.keys(S.troncons).length && !S.points.length && !(S.report.pourcent > 0)) return undefined;
    return {
      description: 'Scénario du modèle de bruit (phase Projet) : statut des tronçons OSM (way/…), report du trafic, sources ponctuelles (WGS84).',
      troncons: Object.entries(S.troncons).map(([id, t]) => ({ id, nom: t.nom || undefined, ...t })),
      report: S.report.pourcent > 0 ? S.report : undefined,
      points: S.points.length ? S.points : undefined,
    };
  }
  function lire(d) {
    const S = { troncons: {}, report: { pourcent: 0, rayon: 200 }, points: [] };
    if (d && typeof d === 'object') {
      for (const t of d.troncons || []) if (t?.id && LIB_STATUT[t.statut]) { const { id, ...r } = t; S.troncons[id] = r; }
      if (d.report) S.report = { pourcent: Math.max(0, Math.min(100, +d.report.pourcent || 0)), rayon: +d.report.rayon || 200 };
      for (const p of d.points || []) if (Number.isFinite(p?.lat) && Number.isFinite(p?.lon)) S.points.push({ id: p.id || `s${S.points.length + 1}`, type: p.type || 'autre', lat: p.lat, lon: p.lon, lw: p.lw, h: p.h, parts: p.parts, nom: p.nom });
    }
    etat.scenario = S;
  }
  function choisirTroncon(id, { ajouter = false } = {}) {
    const g = etat.index.get(id);
    if (g == null) return;
    const s = etat.sources[g];
    const ids = etat.portee === 'rue' && s.nom ? etat.sources.filter((o) => o.type === 'route' && o.nom === s.nom).map((o) => o.id) : [id];
    etat.selection = ajouter ? [...new Set([...etat.selection, ...ids])] : ids;
    dessinerSelection(); rafraichir();
  }
  function sourceSous(p) {
    let best = null;
    for (const s of etat.sources || []) {
      if (s.type !== 'route') continue;
      for (let i = 1; i < s.pts.length; i++) {
        const [ax, az] = s.pts[i - 1], [bx, bz] = s.pts[i], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / L2));
        const d = Math.hypot(p[0] - ax - t * dx, p[1] - az - t * dz) - s.largeur / 2;
        if (d < 10 && (!best || d < best.d)) best = { d, s };
      }
    }
    return best?.s || null;
  }
  const capture = (p, e) => {
    if (!p) return;
    if (etat.ajoutPoint) {
      const g = app.proj.versGeo(p[0], p[1]), D = etat.modele.points[etat.ajoutPoint] || etat.modele.points.autre;
      etat.scenario.points.push({ id: `s${Date.now().toString(36)}`, type: etat.ajoutPoint, lat: +g.lat.toFixed(7), lon: +g.lon.toFixed(7), lw: D.lw, h: D.h, nom: D.libelle });
      etat.ajoutPoint = null; arreterCapture();
      dessinerSelection(); rafraichir(); scenarioChange({ points: true });
      return;
    }
    const s = sourceSous(p);
    if (s) choisirTroncon(s.id, { ajouter: !!e?.shiftKey });
    else app.signaler?.('Aucune voie circulée à moins de 10 m : cliquez sur une chaussée.');
  };
  function demarrerCapture() { app.captureSol = capture; etat.choix = true; }
  function arreterCapture() { if (app.captureSol === capture) app.captureSol = null; etat.choix = false; }
  app.on('outil', (id) => { if (id !== 'bruit') { arreterCapture(); etat.ajoutPoint = null; } });

  function appliquerStatut(reglage) {
    if (!etat.selection.length) return;
    for (const id of etat.selection) {
      const s = etat.sources[etat.index.get(id)];
      if (reglage.statut === 'actuel') delete etat.scenario.troncons[id];
      else etat.scenario.troncons[id] = { nom: s?.nom || undefined, ...reglage };
    }
    if (!phaseProjet()) app.phase?.definir?.('projet');
    etat.selection = [];
    dessinerSelection(); rafraichir(); scenarioChange();
  }

  // ------------------------------------------------------------
  // Panneau
  // ------------------------------------------------------------
  let conteneur = null;
  function rafraichir() { if (conteneur?.isConnected) { const c = conteneur; c.replaceChildren(...contenuBloc()); } }
  function majEtat() {
    if (!ui.etat?.isConnected) return;
    const txt = etat.progres || (etat.erreur ? `Calcul impossible : ${etat.erreur}` : etat.resultats.existant ? `Propagation calculée en ${virgule((etat.msPropagation || etat.ms || 0) / 1000)} s (${etat.meta?.n ?? 0} récepteurs, ${etat.sources?.length ?? 0} sources, ${pool().length} calculs en parallèle).` : 'Pas encore calculé.');
    ui.etat.textContent = txt;
  }
  function changerAffichage(v) {
    etat.affichage = v; memoriser();
    if (v === 'reference') charger().then(chargerReference).then(() => { preparerGrilleRef(); comparer(); dessiner(); rafraichir(); auChangement(); });
    else if (v !== 'officielles' && !etat.resultats.existant) calculer();
    if (!app.couches.bruit && v !== 'officielles') { app.couches.bruit = true; app.emettre('couches'); }
    dessiner(); auChangement(); rafraichir();
  }
  function preparerGrilleRef() {
    if (etat.grille || !etat.modele) return;
    const bp = batiPhases();
    preparerRecepteurs(bp.existantBrut);
    comparer();
  }
  function bloc() {
    conteneur = h('div', { class: 'bruit-modele' });
    charger().then(() => { if (etat.reference === null) chargerReference().then(rafraichir); else rafraichir(); });
    conteneur.append(...contenuBloc());
    return [conteneur];
  }
  function contenuBloc() {
    styles();
    const ind = indic();
    const choix = [['officielles', 'Cartes officielles'], ['modele', 'Modèle'], ['ecart', 'Écart projet'], ...(etat.reference ? [['reference', 'Référence locale']] : [])];
    ui.etat = h('p', { class: 'note', 'data-garder': '', role: 'status' });
    const L = [
      h('div', { class: 'titre-info' }, h('h3', {}, 'Modèle (estimation)'),
        info('Modèle de bruit calculé par l\'atlas (js/bruit-calcul.js), inspiré de CNOSSOS-EU (directive (UE) 2015/996), simplifié :',
          'Émission : puissance par véhicule selon la vitesse (coefficients CNOSSOS-EU, véhicules légers et poids lourds, 8 bandes d\'octave, pondération A) ; trafic du classement sonore (comptages TMJA de la DDTM 44) quand il existe, sinon trafic moyen par type de voie OSM, calibré ; part jour / soir / nuit calibrée ; bus (lignes de l\'outil Flux) et tramway (niveau d\'exposition d\'un passage, calibré) ; revêtement pavé + 2,5 à 4 dB.',
          'Propagation, en 2,5D sur une grille de 2 m : rayons partant de chaque récepteur (144 directions, 200 m), chaussées comme sources surfaciques, sol urbain réfléchissant, diffraction par les toits (chemin tendu au-dessus des bâtiments, atténuation CNOSSOS-EU par bande, 25 dB au plus), réflexions sur les façades (2 au plus, 1 dB de perte), absorption de l\'air. Relief, écrans bas, arbres, réflexions au-delà du 2e ordre et diffraction latérale ignorés.',
          'Récepteurs à 4 m (comme les cartes stratégiques) : grille de 5 m dans le périmètre d\'étude, façades photo (niveau incident à 2 m devant), bâtiments (tous les 4 m). Lden = jour 12 h, soir 4 h (+5 dB), nuit 8 h (+10 dB).',
          'Calibration : outils/bruit/calibrer-modele.mjs ajuste les trafics par type de voie, le facteur des comptages, la part de la nuit, la part des bus, une correction globale et le tramway pour coller aux classes de 5 dB de la carte de Nantes Métropole (2022) ; paramètres dans data/bruit-modele.json (aucune donnée de la métropole dedans).',
          'Phase Projet : bâtiments du projet pris en compte (écrans, réflexions), statuts des rues, report du trafic et sources ponctuelles ci-dessous ; enregistrés dans data/projet.json (clé « bruit »).')),
      h('div', { class: 'bruit-bandeau bruit-bandeau-modele', 'data-garder': '' },
        h('strong', {}, 'Estimation pédagogique'), ', pas une étude acoustique réglementaire : ± 3 à 5 dB au mieux après calibration ; trafics estimés hors des voies classées ; l\'écart projet − existant est plus fiable que les niveaux eux-mêmes.'),
      h('div', { class: 'choix bruit-choix-affichage', role: 'radiogroup', 'aria-label': 'Carte affichée' }, ...choix.map(([v, l]) => h('label', {},
        h('input', { type: 'radio', name: 'affichage-bruit-modele', checked: etat.affichage === v, onchange: () => changerAffichage(v) }), l))),
      etat.affichage === 'modele' ? h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: etat.continu, onchange: (e) => { etat.continu = e.target.checked; memoriser(); dessiner(); auChangement(); } }), 'Dégradé continu (sinon classes de 5 dB)') : null,
      etat.affichage === 'ecart' && !phaseProjet() ? h('p', { class: 'note', 'data-garder': '' }, 'Le scénario s\'applique en phase Projet (bouton en haut à droite) ; l\'écart reste calculé ici.') : null,
      ui.etat,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton petit', disabled: !!etat.calcul, onclick: () => { etat.transferts.clear(); etat.recepteurs = null; etat.sources = null; etat.resultats = { existant: null, projet: null }; calculer(); } }, etat.resultats.existant ? 'Recalculer' : 'Calculer le modèle'),
        app.mode === 'presentateur' ? h('button', { type: 'button', class: 'bouton discret petit', title: 'Voirie, lignes de bus et de tramway et bâti existant, pour outils/bruit/calibrer-modele.mjs', onclick: exporterScene }, 'Scène du modèle (JSON)') : null),
    ];
    if (etat.comparaison) {
      const C = etat.comparaison, pc = (a, b) => (b ? `${Math.round((a / b) * 100)} %` : '—');
      L.push(h('div', { class: 'titre-info' }, h('h3', {}, 'Modèle et référence'),
        info('Comparaison de l\'existant calculé (routes et bus, sans le tramway) avec la carte de bruit stratégique de Nantes Métropole (routes, 2022), lue dans la copie locale data/bruit-reference-nantes-metropole.geojson (© Nantes Métropole, pas de licence ouverte : ne pas republier). Points tous les 5 m hors bâti ; la référence est une classe de 5 dB : « dans la classe » = le modèle tombe dans la même classe.')),
      h('p', { class: 'note', 'data-garder': '' }, `Dans la même classe de 5 dB : Lden ${pc(C.st.Lden.ok, C.st.Lden.n)}, Ln ${pc(C.st.Ln.ok, C.st.Ln.n)} ; à une classe près : Lden ${pc(C.st.Lden.pm, C.st.Lden.n)}, Ln ${pc(C.st.Ln.pm, C.st.Ln.n)} (${C.st.Lden.n} points).`),
      C.rues.length ? h('table', { class: 'table-bruit' }, h('thead', {}, h('tr', {}, h('th', {}, 'Bord de chaussée'), h('th', {}, 'Lden mod. / réf.'), h('th', {}, 'Ln mod. / réf.'))),
        h('tbody', {}, ...C.rues.map((r) => h('tr', {}, h('td', {}, r.rue), h('td', {}, `${virgule(r.Lden, 0)} / ${virgule(r.refLden)}`), h('td', {}, `${virgule(r.Ln, 0)} / ${virgule(r.refLn)}`))))) : null);
    }
    // scénario
    const routes = (etat.sources || []).filter((s) => s.type === 'route');
    const noms = [...new Set(routes.map((s) => s.nom).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
    const sel = etat.selection.map((id) => etat.sources?.[etat.index.get(id)]).filter(Boolean);
    const regl = { statut: 'pietonne', livraisons: true, riverains: 5, pourcent: 50, vitesse: 30 };
    const f = {};
    const enTete = sel.length ? (() => { const t = B.traficRoute(sel[0], etat.modele); return `${sel.length} tronçon${sel.length > 1 ? 's' : ''} choisi${sel.length > 1 ? 's' : ''}${sel[0].nom ? ` (${sel[0].nom})` : ''} : ${Math.round(t.tmja)} véh/j${t.source === 'comptage' ? ' (comptage du classement sonore)' : ' (estimé par type de voie)'}, ${Math.round(t.v)} km/h.`; })() : 'Aucun tronçon choisi.';
    L.push(
      h('div', { class: 'titre-info' }, h('h3', {}, 'Scénario du projet (bruit)'),
        info('Choisir une rue dans la liste ou cliquer sur une chaussée (Maj + clic : ajouter), puis lui donner un statut. « Rue entière » prend tous les tronçons OSM du même nom ; « tronçon » le tronçon cliqué (en général entre deux carrefours).',
          'Hypothèses (data/bruit-modele.json, statuts) : zone 30 = vitesse limitée à 30 km/h, trafic inchangé ; zone de rencontre = 20 km/h, trafic × 0,8 ; rue piétonne = riverains (part du trafic actuel, 5 % par défaut) + livraisons le matin (30 véhicules/jour, moitié de poids lourds) à 20 km/h ; bus et tramway seulement = trafic routier supprimé, lignes gardées ; trafic personnalisé = part du trafic actuel et vitesse.',
          'Report du trafic : la part choisie du trafic retiré est ajoutée aux voies parallèles proches (à moins de 200 m, orientées à ± 45°, au prorata de leur importance et de la proximité) : ordre de grandeur seulement, sans modèle de trafic.',
          'Sources ponctuelles : puissance acoustique type et part du temps de fonctionnement par période (hypothèses, modifiables dans data/bruit-modele.json). Tout ne compte qu\'en phase Projet.')),
      h('div', { class: 'actions' },
        h('select', { 'aria-label': 'Rue', onchange: (e) => { const s = routes.find((o) => o.nom === e.target.value); if (s) { etat.portee = 'rue'; choisirTroncon(s.id); } } },
          h('option', { value: '' }, 'Choisir une rue…'), ...noms.map((n) => h('option', { value: n }, n))),
        h('button', { type: 'button', class: `bouton petit${etat.choix ? ' actif' : ''}`, 'aria-pressed': String(etat.choix), onclick: () => { if (etat.choix) arreterCapture(); else { etat.ajoutPoint = null; demarrerCapture(); } rafraichir(); } }, etat.choix && !etat.ajoutPoint ? 'Arrêter le choix' : 'Choisir sur la carte')),
      h('div', { class: 'choix', role: 'radiogroup', 'aria-label': 'Portée du clic' }, ...[['rue', 'Rue entière'], ['troncon', 'Tronçon']].map(([v, l]) => h('label', {},
        h('input', { type: 'radio', name: 'portee-bruit', checked: etat.portee === v, onchange: () => { etat.portee = v; } }), l))),
      h('p', { class: 'note', 'data-garder': '' }, enTete),
      sel.length ? h('div', { class: 'bruit-statut' },
        h('label', {}, 'Statut : ', f.statut = h('select', { onchange: (e) => { regl.statut = e.target.value; maj(); } }, ...STATUTS.map(([v, l]) => h('option', { value: v, selected: v === regl.statut }, l)))),
        f.piet = h('div', {},
          h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { regl.livraisons = e.target.checked; } }), 'Livraisons le matin'),
          h('label', {}, 'Riverains : ', h('input', { type: 'number', min: 0, max: 100, step: 1, value: regl.riverains, style: 'width:4.5em', onchange: (e) => { regl.riverains = +e.target.value; } }), ' % du trafic actuel')),
        f.perso = h('div', { hidden: true },
          h('label', {}, 'Trafic : ', h('input', { type: 'number', min: 0, max: 300, step: 5, value: regl.pourcent, style: 'width:4.5em', onchange: (e) => { regl.pourcent = +e.target.value; } }), ' % '),
          h('label', {}, 'vitesse : ', h('input', { type: 'number', min: 5, max: 90, step: 5, value: regl.vitesse, style: 'width:4.5em', onchange: (e) => { regl.vitesse = +e.target.value; } }), ' km/h')),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'bouton petit', onclick: () => appliquerStatut({ ...regl, ...(regl.statut === 'pietonne' ? {} : { livraisons: undefined, riverains: undefined }), ...(regl.statut === 'perso' ? {} : { pourcent: undefined, vitesse: undefined }) }) }, 'Appliquer'),
          h('button', { type: 'button', class: 'bouton discret petit', onclick: () => { etat.selection = []; dessinerSelection(); rafraichir(); } }, 'Annuler le choix'))) : null,
    );
    function maj() { if (f.piet) f.piet.hidden = regl.statut !== 'pietonne'; if (f.perso) f.perso.hidden = regl.statut !== 'perso'; }
    maj();
    const mods = Object.entries(etat.scenario.troncons);
    if (mods.length) {
      const parNom = new Map();
      for (const [id, t] of mods) { const k = `${t.nom || id}|${t.statut}`; if (!parNom.has(k)) parNom.set(k, { nom: t.nom || id, t, ids: [] }); parNom.get(k).ids.push(id); }
      L.push(h('ul', { class: 'bruit-modifs' }, ...[...parNom.values()].map(({ nom, t, ids }) => h('li', {},
        h('span', {}, `${nom} : ${LIB_STATUT[t.statut]}${t.statut === 'pietonne' ? ` (riverains ${t.riverains ?? 5} %${t.livraisons === false ? ', sans livraisons' : ', livraisons'})` : t.statut === 'perso' ? ` (${t.pourcent} %, ${t.vitesse} km/h)` : ''}${ids.length > 1 ? `, ${ids.length} tronçons` : ''}`),
        h('button', { type: 'button', class: 'bouton discret petit', title: 'Retirer', onclick: () => { for (const id of ids) delete etat.scenario.troncons[id]; dessinerSelection(); rafraichir(); scenarioChange(); } }, '×')))));
    }
    L.push(
      h('label', {}, 'Report du trafic retiré sur les rues parallèles : ', h('input', { type: 'range', min: 0, max: 100, step: 10, value: etat.scenario.report.pourcent, oninput: (e) => { etat.scenario.report.pourcent = +e.target.value; e.target.nextSibling.textContent = ` ${e.target.value} %`; }, onchange: () => scenarioChange() }), h('span', {}, ` ${etat.scenario.report.pourcent} %`)),
      h('div', { class: 'actions' },
        h('select', { 'aria-label': 'Type de source ponctuelle', onchange: (e) => { if (!e.target.value) return; etat.ajoutPoint = e.target.value; demarrerCapture(); app.signaler?.('Cliquez sur la carte pour poser la source.'); rafraichir(); } },
          h('option', { value: '' }, etat.ajoutPoint ? 'Cliquez sur la carte…' : 'Ajouter une source ponctuelle…'), ...Object.entries(etat.modele?.points || {}).map(([k, p]) => h('option', { value: k }, `${p.libelle} (${p.lw} dB(A))`)))),
      etat.scenario.points.length ? h('ul', { class: 'bruit-modifs' }, ...etat.scenario.points.map((p, i) => h('li', {},
        h('span', {}, `${p.nom || etat.modele?.points?.[p.type]?.libelle || p.type} : `),
        h('input', { type: 'number', min: 40, max: 130, step: 1, value: p.lw ?? 85, style: 'width:4em', title: 'Puissance acoustique L_W, dB(A)', onchange: (e) => { p.lw = +e.target.value; scenarioChange(); } }), ' dB(A) ',
        h('button', { type: 'button', class: 'bouton discret petit', title: 'Retirer', onclick: () => { etat.scenario.points.splice(i, 1); dessinerSelection(); rafraichir(); scenarioChange({ points: true }); } }, '×')))) : null,
      app.mode === 'presentateur' && app.projet?.enregistrer ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton discret petit', onclick: () => app.projet.enregistrer() }, 'Enregistrer le scénario (data/projet.json)')) : null,
    );
    if (etat.resultats.projet && etat.meta) L.push(resumeEcart());
    setTimeout(majEtat, 0);
    return L.filter(Boolean);
  }
  // résumé : façades photo et bâtiments les plus touchés par le scénario
  function resumeEcart() {
    const E = etat.resultats.existant, P = etat.resultats.projet, ind = indic();
    const L = [];
    for (const [cle, plage] of etat.meta.batiments) { const a = maxSur(E[ind], plage), b = maxSur(P[ind], plage); if (a != null && b != null) L.push({ cle, d: b - a }); }
    const baisse = L.filter((x) => x.d <= -1).length, hausse = L.filter((x) => x.d >= 1).length;
    const dmin = L.reduce((m, x) => Math.min(m, x.d), 0), dmax = L.reduce((m, x) => Math.max(m, x.d), 0);
    return h('p', { class: 'note', 'data-garder': '' }, `Projet − existant (${ind}, façade la plus exposée de chaque bâtiment) : ${baisse} bâtiment${baisse > 1 ? 's' : ''} en baisse d'au moins 1 dB (jusqu'à ${virgule(dmin)} dB), ${hausse} en hausse d'au moins 1 dB (jusqu'à +${virgule(dmax)} dB).`);
  }

  function exporterScene() {
    const bp = batiPhases();
    const s = { description: 'Scène du modèle de bruit de l\'atlas (voirie OSM, lignes, bâti existant en mètres locaux), pour outils/bruit/calibrer-modele.mjs. Données OSM © contributeurs OpenStreetMap (ODbL).',
      origine: app.config.origine, rayonEtude: R(), voirie: app.donnees.osm.voirie, lignes: app.donnees.osm.lignes, bati: bp.existant.map((e) => ({ polys: e.polys, h: e.h })) };
    telecharger('atlas-hdv-bruit-scene.json', JSON.stringify(s));
  }

  function styles() {
    if (document.getElementById('styles-bruit-modele')) return;
    document.head.append(h('style', { id: 'styles-bruit-modele' }, `
.bruit-bandeau-modele { border-left-color: #7a1fa2; background: #f3eef7; }
.bruit-choix-affichage { flex-wrap: wrap; }
.bruit-statut { margin: 4px 0 6px; padding: 6px 8px; background: rgba(122, 31, 162, 0.06); border-radius: 4px; }
.bruit-statut label { display: inline-block; margin: 2px 8px 2px 0; }
.bruit-modifs { margin: 4px 0; padding-left: 16px; font-size: 12.5px; }
.bruit-modifs li { display: flex; align-items: center; gap: 4px; justify-content: space-between; }
`));
  }

  // ------------------------------------------------------------
  // Événements
  // ------------------------------------------------------------
  app.on('couches', () => { const v = !!app.couches.bruit && etat.affichage !== 'officielles'; groupe.visible = v; if (v && !groupe.children.length) dessiner(); dessinerSelection(); });
  app.on('phase', () => { dessiner(); dessinerSelection(); if (etat.affichage !== 'officielles' && phaseProjet() && !etat.resultats.projet) calculer(); rafraichir(); auChangement(); });
  app.on('bati', () => { // projet modifié : le résultat du projet est à refaire (les transferts sont gardés par signature)
    if (!etat.resultats.existant) return;
    etat.resultats.projet = null;
    if (etat.affichage !== 'officielles' && app.couches.bruit) calculer(); else { dessiner(); auChangement(); }
  });

  return {
    etat, charger, calculer, dessiner, bloc, legende, svgPlanche, entitesDXF, entetes, cellules, entetesCSV, valeursCSV, noteCSV,
    serialiser, lire, valeurs, valeursGrille, choisirTroncon, appliquerStatut, scenarioChange, comparer, chargerReference,
    officiel: () => etat.affichage === 'officielles',
    definirAffichage: changerAffichage,
    get sources() { return sources(); },
  };
}
