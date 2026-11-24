// Modèle de bruit de l'atlas (21/11/2026) : calcul pur, sans DOM ni Three.js (Web Worker js/bruit-worker.js, essais et
// calibration sous Node : outils/bruit/calibrer-modele.mjs). ESTIMATION PÉDAGOGIQUE inspirée de CNOSSOS-EU (directive (UE)
// 2015/996), simplifiée : ce n'est pas un calcul réglementaire (± 3 à 5 dB au mieux après calibration).
//
// 1) Émission. Route : puissance acoustique par véhicule selon la vitesse, par bande d'octave 63 Hz - 8 kHz, bruit de
//    roulement A_R + B_R lg(v / 70) et de propulsion A_P + B_P (v − 70) / 70 (coefficients CNOSSOS-EU de la directive 2015/996,
//    annexe, tableau F-1 ; catégorie 1 véhicules légers, catégorie 3 poids lourds et bus ; v ≥ 20 km/h), pondération A ; source
//    linéique L_W' = 10 lg( Σ Q_m / (1000 v_m) · 10^(L_W,m / 10) ) dB/m (Q en véh/h, v en km/h). Tramway : niveau d'exposition
//    (SEL) d'un passage à 7,5 m, converti en puissance linéique (L_W' = SEL + 10 lg Q − 10 lg 3600 + 10 lg 15). Sources ponctuelles
//    (terrasse, livraison, ventilation) : puissance L_W et part du temps de fonctionnement par période.
// 2) Propagation, en 2,5D sur une grille de 2 m (hauteur du bâti effectif ; sol urbain réfléchissant, G = 0 ; relief ignoré) :
//    méthode des rayons : depuis chaque récepteur (4 m), N rayons horizontaux ; chaque maille de chaussée traversée est une source
//    surfacique (puissance linéique répartie sur la largeur) ; énergie reçue = W'' · Δθ · ℓ · s / (2π (s² + Δh²)) (rayonnement
//    hémisphérique au-dessus d'un sol réfléchissant : une ligne infinie à la distance d donne W' / 2d) ; diffraction par les toits :
//    différence de marche δ le long de l'enveloppe convexe supérieure du profil (chemin tendu au-dessus des bâtiments, plusieurs
//    arêtes), atténuation CNOSSOS-EU Δ = 10 lg(3 + 40 δ / λ) par bande (plafonnée à 25 dB), moyennée sur le spectre du trafic ;
//    réflexions spéculaires sur les façades (2 au plus, perte de 1 dB chacune, normales des murs du bâti) : effet de rue en U ;
//    absorption atmosphérique moyenne 0,005 dB/m ; rayon de calcul 200 m. Façades : niveau incident à 2 m devant le mur (rayons
//    vers le mur ignorés), comme les cartes de bruit stratégiques.
// 3) Indicateurs : Ld (6-18 h), Le (18-22 h), Ln (22-6 h), Lden = 10 lg((12·10^(Ld/10) + 4·10^((Le+5)/10) + 8·10^((Ln+10)/10)) / 24).
//    Les transferts récepteur ← source (par tronçon) sont gardés : changer les trafics, les vitesses ou un statut de rue ne
//    demande qu'une recombinaison (instantanée) ; changer le bâti demande un nouveau calcul de propagation.
// 4) Calibration (calibrer) : trafics par type de voie OSM sans comptage, facteur sur les comptages du classement sonore,
//    part de la nuit, correction globale, SEL du tramway ; coût nul quand le modèle tombe dans la classe de 5 dB de la référence.

// ------------------------------------------------------------------
// Émission
// ------------------------------------------------------------------
export const BANDES = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
export const PONDERATION_A = [-26.2, -16.1, -8.6, -3.2, 0, 1.2, 1.0, -1.1];
// CNOSSOS-EU, directive (UE) 2015/996, annexe, tableau F-1 (valeurs reprises par la directive déléguée (UE) 2021/1226)
export const CNOSSOS_ROUTE = {
  1: { // véhicules légers
    AR: [79.7, 85.7, 84.5, 90.2, 97.3, 93.9, 84.1, 74.3], BR: [30.0, 41.5, 38.9, 25.7, 32.5, 37.2, 39.0, 40.0],
    AP: [94.5, 89.2, 88.0, 85.9, 84.2, 86.9, 83.3, 76.1], BP: [-1.3, 7.2, 7.7, 8.0, 8.0, 8.0, 8.0, 8.0],
  },
  3: { // poids lourds (et bus, faute de mieux)
    AR: [87.0, 91.7, 94.1, 100.7, 100.8, 94.3, 87.1, 82.5], BR: [30.0, 33.5, 31.3, 25.4, 31.8, 37.1, 38.6, 40.6],
    AP: [104.4, 100.6, 101.7, 101.0, 100.1, 95.9, 91.3, 85.3], BP: [0, 3, 4.6, 5, 5, 5, 5, 5],
  },
};
const lg = Math.log10;
const dB = (e) => (e > 0 ? 10 * lg(e) : -Infinity);
const en = (L) => 10 ** (L / 10);

export function spectreVehicule(cat, v) {
  const C = CNOSSOS_ROUTE[cat] || CNOSSOS_ROUTE[1];
  const vv = Math.max(20, v || 20);
  return BANDES.map((_, b) => {
    const LR = C.AR[b] + C.BR[b] * lg(vv / 70);
    const LP = C.AP[b] + (C.BP[b] * (vv - 70)) / 70;
    return dB(en(LR) + en(LP)) + PONDERATION_A[b];
  });
}
// puissance acoustique pondérée A d'un véhicule (dB(A))
export const lwVehicule = (cat, v) => dB(spectreVehicule(cat, v).reduce((s, L) => s + en(L), 0));

// puissance linéique (énergie, 10^(L_W'/10)) d'un flux : qVL, qPL en véh/h ; vitesses en km/h ; corr en dB (revêtement)
export function energieFlux({ qVL = 0, qPL = 0, vVL = 30, vPL = 30, corrVL = 0, corrPL = 0 }) {
  const a = qVL > 0 ? (qVL / (1000 * Math.max(vVL, 5))) * en(lwVehicule(1, vVL) + corrVL) : 0;
  const b = qPL > 0 ? (qPL / (1000 * Math.max(vPL, 5))) * en(lwVehicule(3, vPL) + corrPL) : 0;
  return a + b;
}

// table d'atténuation par diffraction (facteur d'énergie selon la différence de marche δ, moyenne sur le spectre)
const C_SON = 340;
const PAS_DELTA = 0.005, N_DELTA = 8000; // 0 à 40 m
function tableDiffraction(spectre) {
  const s = spectre.map(en), tot = s.reduce((a, b) => a + b, 0);
  const t = new Float32Array(N_DELTA + 1);
  for (let i = 0; i <= N_DELTA; i++) {
    const d = i * PAS_DELTA;
    let e = 0;
    for (let b = 0; b < BANDES.length; b++) {
      const lambda = C_SON / BANDES[b];
      const D = Math.min(25, 10 * lg(3 + (40 * d) / lambda));
      e += s[b] * 10 ** (-D / 10);
    }
    t[i] = e / tot;
  }
  return t;
}
let TABLE = null;
const table = () => (TABLE ||= tableDiffraction(spectreVehicule(1, 30)));
export const attenuationDiffraction = (delta) => -10 * lg(table()[Math.min(N_DELTA, Math.max(0, Math.round(delta / PAS_DELTA)))]);

// ------------------------------------------------------------------
// Paramètres par défaut (remplacés par data/bruit-modele.json)
// ------------------------------------------------------------------
export const MODELE_DEFAUT = {
  version: 1,
  description: 'Paramètres du modèle de bruit de l\'atlas (estimation pédagogique, js/bruit-calcul.js). Valeurs par défaut non calibrées.',
  calcul: { pas: 2, rayon_m: 200, rayons: 144, reflexions: 2, perte_reflexion_db: 1, absorption_db_m: 0.005, h_recepteur: 4, h_source: 0.05, grille_m: 5 },
  periodes: { jour: 0.72, soir: 0.18, nuit: 0.10 }, // part du trafic journalier (6-18 h, 18-22 h, 22-6 h)
  correction_globale_db: 0,
  rues: {}, // facteur sur le trafic du type de voie, par nom OSM de rue (calibré)
  facteur_comptages: 1, // multiplicateur des TMJA du classement sonore
  // trafic moyen journalier (véh/j, deux sens) par type de voie OSM sans comptage
  trafics: { primary: 15000, secondary: 9000, tertiary: 5000, unclassified: 1500, residential: 1200, living_street: 300, service: 150, pedestrian: 150, busway: 0 },
  vitesses: { primary: 50, secondary: 30, tertiary: 30, unclassified: 30, residential: 30, living_street: 20, service: 20, pedestrian: 20, busway: 30 },
  pl: { primary: 0.05, secondary: 0.04, tertiary: 0.03, unclassified: 0.02, residential: 0.02, living_street: 0.02, service: 0.02, pedestrian: 0.05, busway: 0 },
  largeurs: { primary: 12, secondary: 9, tertiary: 7, unclassified: 6, residential: 5.5, living_street: 4.5, service: 3.5, pedestrian: 4, busway: 6 },
  revetements: { paving_stones: 2.5, sett: 3, cobblestone: 4, unhewn_cobblestone: 4, concrete: 0.5 }, // dB ajoutés aux véhicules légers
  bus: { passages_par_ligne_sens: { jour: 4, soir: 2, nuit: 0.3 }, facteur: 1, vitesse: 25, largeur: 3.5 },
  tram: { sel_7_5m: 80, vitesse: 25, passages_heure: { jour: 16, soir: 10, nuit: 3 }, largeur: 3 },
  points: {
    terrasse: { libelle: 'Terrasse de café (≈ 30 personnes)', lw: 85, h: 1.2, parts: { jour: 0.5, soir: 1, nuit: 0.1 } },
    livraison: { libelle: 'Aire de livraison (camion, déchargement)', lw: 100, h: 1.5, parts: { jour: 0.04, soir: 0, nuit: 0 } },
    ventilation: { libelle: 'Ventilation / climatisation (groupe extérieur)', lw: 75, h: 3, parts: { jour: 1, soir: 1, nuit: 0.5 } },
    animation: { libelle: 'Place animée, marché, jeux d\'enfants', lw: 90, h: 1.5, parts: { jour: 0.4, soir: 0.3, nuit: 0 } },
    autre: { libelle: 'Autre source (puissance à saisir)', lw: 85, h: 1.5, parts: { jour: 1, soir: 1, nuit: 0 } },
  },
  statuts: {
    zone30: { vitesse: 30, trafic: 1 },
    zone20: { vitesse: 20, trafic: 0.8 },
    pietonne: { vitesse: 20, riverains: 0.05, livraisons_tmja: 30, livraisons_pl: 0.5 },
  },
};
export const TYPES_ROUTE = ['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'pedestrian', 'busway'];
const TYPE_DE = { motorway: 'primary', trunk: 'primary', primary_link: 'primary', secondary_link: 'secondary', tertiary_link: 'tertiary', road: 'unclassified' };
export const typeRoute = (hw) => (TYPES_ROUTE.includes(hw) ? hw : TYPE_DE[hw] || null);
export function fusionnerModele(m = {}) {
  const D = MODELE_DEFAUT, o = { ...D, ...m };
  for (const k of ['calcul', 'periodes', 'trafics', 'vitesses', 'pl', 'largeurs', 'revetements', 'statuts', 'rues']) o[k] = { ...D[k], ...(m[k] || {}) };
  o.bus = { ...D.bus, ...(m.bus || {}), passages_par_ligne_sens: { ...D.bus.passages_par_ligne_sens, ...(m.bus?.passages_par_ligne_sens || {}) } };
  o.tram = { ...D.tram, ...(m.tram || {}), passages_heure: { ...D.tram.passages_heure, ...(m.tram?.passages_heure || {}) } };
  o.points = { ...D.points, ...(m.points || {}) };
  return o;
}

// ------------------------------------------------------------------
// Géométrie
// ------------------------------------------------------------------
function distSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx, z = az + t * dz;
  return [Math.hypot(px - x, pz - z), t];
}
function longueur(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
function echantillonner(pts, pas) { // points tous les « pas » m avec la direction locale
  const o = [];
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const k = Math.max(1, Math.round(L / pas));
    for (let j = 0; j < k; j++) { const t = (j + 0.5) / k; o.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t, ux: (bx - ax) / L, uz: (bz - az) / L }); }
  }
  return o;
}
function dansAnneau(a, x, z) {
  let d = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    const [xi, zi] = a[i], [xj, zj] = a[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) d = !d;
  }
  return d;
}
const dansPoly = (poly, x, z) => dansAnneau(poly[0], x, z) && !poly.slice(1).some((t) => dansAnneau(t, x, z));

// ------------------------------------------------------------------
// Sources : tronçons OSM (+ comptages du classement sonore), lignes de bus et de tramway
// entrée : routes [{ id, nom, tags, pts }], lignes [{ id, mode, lignes, pts }], classement [{ id, nom, troncon, pts, tmja, vitesse_vl, vitesse_pl, categorie, largeur_chaussee_m }]
// ------------------------------------------------------------------
export function apparierClassement(routes, classement) {
  // pour chaque tronçon OSM motorisé : tronçon du classement le plus proche et parallèle sur 60 % de sa longueur au moins
  const res = new Map();
  if (!classement?.length) return res;
  const segs = [];
  classement.forEach((c, ic) => { for (let i = 1; i < c.pts.length; i++) segs.push({ ic, a: c.pts[i - 1], b: c.pts[i], s0: longueur(c.pts.slice(0, i)) }); });
  const parTroncon = new Map();
  const norm = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  for (const r of routes) {
    if (['pedestrian', 'living_street', 'service', 'busway'].includes(typeRoute(r.tags?.highway))) continue;
    const ech = echantillonner(r.pts, 5);
    const nomR = norm(r.nom);
    if (!ech.length) continue;
    const votes = new Map();
    for (const p of ech) {
      let best = null;
      for (const s of segs) {
        const [d, t] = distSeg(p.x, p.z, s.a[0], s.a[1], s.b[0], s.b[1]);
        const lim = 8 + (classement[s.ic].largeur_chaussee_m || 6) / 2;
        if (d > lim) continue;
        if (nomR && classement[s.ic].nom && !norm(classement[s.ic].nom).split(/\s+/).some((m) => m.length >= 4 && nomR.includes(m))) continue;
        const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) || 1;
        const cos = Math.abs(((s.b[0] - s.a[0]) * p.ux + (s.b[1] - s.a[1]) * p.uz) / L);
        if (cos < 0.8) continue;
        if (!best || d < best.d) best = { d, ic: s.ic, pos: s.s0 + t * L, lat: d };
      }
      if (best) { const v = votes.get(best.ic) || { n: 0, pos: [], lat: 0 }; v.n++; v.pos.push(best.pos); v.lat += best.lat; votes.set(best.ic, v); }
    }
    let bi = -1, bn = 0;
    for (const [ic, v] of votes) if (v.n > bn) { bn = v.n; bi = ic; }
    if (bi < 0 || bn < 0.6 * ech.length) continue;
    const v = votes.get(bi);
    const m = { ic: bi, a: Math.min(...v.pos), b: Math.max(...v.pos), lat: v.lat / v.n, part: 1 };
    res.set(r.id, m);
    if (!parTroncon.has(bi)) parTroncon.set(bi, []);
    parTroncon.get(bi).push([r.id, m]);
  }
  // chaussées séparées (deux tronçons OSM parallèles décalés pour un même tronçon du classement) : comptage partagé
  for (const L of parTroncon.values()) {
    for (const [, m] of L) {
      let n = 1;
      for (const [, o] of L) {
        if (o === m) continue;
        const ov = Math.min(m.b, o.b) - Math.max(m.a, o.a), lmin = Math.min(m.b - m.a, o.b - o.a);
        if (lmin > 0 && ov > 0.5 * lmin && Math.abs(m.lat - o.lat) > 2.5) n++;
      }
      m.part = 1 / n;
    }
  }
  return res;
}

const ACCES_NON = /^(no|private)$/;
export function preparerSources({ routes = [], lignes = [], classement = [] }, modele) {
  const M = fusionnerModele(modele);
  const motorisees = routes.filter((r) => {
    const t = typeRoute(r.tags?.highway);
    if (!t || r.pts.length < 2) return false;
    if (t === 'service' && /parking_aisle|driveway/.test(r.tags.service || '')) return false;
    if (ACCES_NON.test(r.tags.motor_vehicle || '') || (ACCES_NON.test(r.tags.access || '') && !r.tags.motor_vehicle)) return t === 'busway' || r.tags.psv === 'yes' || r.tags.bus === 'yes' ? true : false;
    return true;
  });
  const app = apparierClassement(motorisees, classement);
  const S = [];
  for (const r of motorisees) {
    const t = typeRoute(r.tags.highway);
    const m = app.get(r.id), c = m ? classement[m.ic] : null;
    const ms = parseFloat(String(r.tags.maxspeed || '').replace(/[^\d.]/g, ''));
    const voies = parseFloat(r.tags.lanes);
    const largeur = Number.isFinite(voies) && voies > 0 ? Math.max(3, Math.min(14, voies * 3.1)) : M.largeurs[t];
    S.push({
      id: r.id, type: 'route', couche: 0, nom: r.nom || '', highway: t, pts: r.pts, largeur,
      vitesse: Number.isFinite(ms) && ms > 0 ? ms : c?.vitesse_vl || M.vitesses[t],
      revetement: M.revetements[r.tags.surface] || 0, surface: r.tags.surface || null,
      comptage: c ? { tmja: c.tmja, part: m.part, troncon: c.troncon || c.nom, categorie: c.categorie, vitesse_vl: c.vitesse_vl } : null,
      acces: r.tags.motor_vehicle || r.tags.access || null, sensUnique: r.tags.oneway === 'yes',
    });
  }
  for (const l of lignes) {
    if (l.pts.length < 2) continue;
    if (l.mode === 'tram') S.push({ id: `tram-${l.id}`, type: 'tram', couche: 1, nom: `Tramway ${(l.lignes || []).join(', ')}`, pts: l.pts, largeur: M.tram.largeur, lignes: l.lignes || [] });
    else S.push({ id: `bus-${l.id}`, type: 'bus', couche: 1, nom: `Bus ${(l.lignes || []).join(', ')}`, pts: l.pts, largeur: M.bus.largeur, lignes: l.lignes || [], frequences: l.frequences || null });
  }
  return S;
}

// ------------------------------------------------------------------
// Scène raster : hauteurs du bâti, normales des murs, sources (deux couches : routes, transports en commun)
// ------------------------------------------------------------------
export function construireScene({ batiments = [], sources = [], demiCote, pas = 2 }) {
  const n = Math.ceil((2 * demiCote) / pas), x0 = -n * pas / 2, z0 = -n * pas / 2;
  const N = n * n;
  const H = new Float32Array(N), NX = new Float32Array(N), NZ = new Float32Array(N);
  const gA = new Int32Array(N).fill(-1), gB = new Int32Array(N).fill(-1);
  const ix = (x) => Math.floor((x - x0) / pas), iz = (z) => Math.floor((z - z0) / pas);
  for (const b of batiments) {
    const h = b.h;
    if (!(h > 0)) continue;
    for (const poly of b.polys || []) {
      const ext = poly[0];
      if (!ext || ext.length < 3) continue;
      let xa = Infinity, xb = -Infinity, za = Infinity, zb = -Infinity;
      for (const [x, z] of ext) { xa = Math.min(xa, x); xb = Math.max(xb, x); za = Math.min(za, z); zb = Math.max(zb, z); }
      const i0 = Math.max(0, ix(xa)), i1 = Math.min(n - 1, ix(xb)), j0 = Math.max(0, iz(za)), j1 = Math.min(n - 1, iz(zb));
      for (let j = j0; j <= j1; j++) {
        const zc = z0 + (j + 0.5) * pas;
        // balayage : intersections de la ligne zc avec tous les anneaux (pair-impair : trous compris)
        const xs = [];
        for (const a of poly) for (let k = 0, l = a.length - 1; k < a.length; l = k++) {
          const [xk, zk] = a[k], [xl, zl] = a[l];
          if ((zk > zc) !== (zl > zc)) xs.push(xk + ((zc - zk) * (xl - xk)) / (zl - zk));
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const a0 = Math.max(i0, Math.ceil((xs[k] - x0) / pas - 0.5)), a1 = Math.min(i1, Math.floor((xs[k + 1] - x0) / pas - 0.5));
          for (let i = a0; i <= a1; i++) { const c = j * n + i; if (h > H[c]) H[c] = h; }
        }
      }
      // normales des murs (vers l'extérieur de la matière), sur les mailles le long de chaque arête
      for (const a of poly) for (let k = 0; k < a.length; k++) {
        const [ax, az] = a[k], [bx, bz] = a[(k + 1) % a.length], L = Math.hypot(bx - ax, bz - az);
        if (L < 0.3) continue;
        let nx = (bz - az) / L, nz = -(bx - ax) / L;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        if (dansPoly(poly, mx + nx * 0.3, mz + nz * 0.3)) { nx = -nx; nz = -nz; }
        const m = Math.max(1, Math.ceil(L / (pas / 3)));
        for (let s = 0; s <= m; s++) {
          const x = ax + ((bx - ax) * s) / m - nx * 0.4, z = az + ((bz - az) * s) / m - nz * 0.4;
          const i = ix(x), j = iz(z);
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          NX[j * n + i] = nx; NZ[j * n + i] = nz;
        }
      }
    }
  }
  // sources : bande de la largeur de la chaussée, hors bâti ; densité = longueur / aire réellement couverte (puissance conservée)
  const G = sources.length;
  const longueurs = new Float64Array(G), compte = new Float64Array(G);
  sources.forEach((s, g) => {
    const L = s.couche === 1 ? gB : gA, w = s.largeur / 2;
    for (let k = 1; k < s.pts.length; k++) {
      const [ax, az] = s.pts[k - 1], [bx, bz] = s.pts[k];
      longueurs[g] += Math.hypot(bx - ax, bz - az);
      const i0 = Math.max(0, ix(Math.min(ax, bx) - w)), i1 = Math.min(n - 1, ix(Math.max(ax, bx) + w));
      const j0 = Math.max(0, iz(Math.min(az, bz) - w)), j1 = Math.min(n - 1, iz(Math.max(az, bz) + w));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const c = j * n + i;
        if (H[c] > 0) continue;
        if (distSeg(x0 + (i + 0.5) * pas, z0 + (j + 0.5) * pas, ax, az, bx, bz)[0] <= Math.max(w, pas * 0.5)) L[c] = g;
      }
    }
  });
  for (let c = 0; c < N; c++) { if (gA[c] >= 0) compte[gA[c]]++; if (gB[c] >= 0) compte[gB[c]]++; }
  const dens = new Float32Array(G);
  for (let g = 0; g < G; g++) dens[g] = compte[g] > 0 ? longueurs[g] / (compte[g] * pas * pas) : 0;
  return { n, x0, z0, pas, H, NX, NZ, gA, gB, dens, G };
}

// ------------------------------------------------------------------
// Propagation : transferts récepteur ← groupe (énergie reçue pour 1 W/m de puissance linéique : L = L_W' + 10 lg T)
// recepteurs : Float32Array [x, z, nx, nz] par récepteur (nx = nz = 0 : pas de façade)
// ------------------------------------------------------------------
export function calculerTransferts(S, recepteurs, opts = {}) {
  const o = { ...MODELE_DEFAUT.calcul, ...opts };
  const { n, x0, z0, pas, H, NX, NZ, gA, gB, dens, G } = S;
  const NR = o.rayons, dTheta = (2 * Math.PI) / NR, rMax = o.rayon_m, hr = o.h_recepteur, hs = o.h_source;
  const dh2 = (hr - hs) ** 2, kAir = (o.absorption_db_m * Math.LN10) / 10, fRefl = 10 ** (-o.perte_reflexion_db / 10);
  const T = table();
  const nRec = recepteurs.length / 4;
  const acc = new Float64Array(G), vu = new Uint8Array(G), liste = new Int32Array(G);
  let nListe = 0;
  const offsets = new Int32Array(nRec + 1);
  let cap = nRec * 24, gr = new Int32Array(cap), va = new Float32Array(cap), pos = 0;
  const interieur = new Uint8Array(nRec);
  // enveloppe convexe supérieure du profil (s, y), une par niveau de réflexion
  const PROF = 3, CAPH = 8192;
  const hsA = Array.from({ length: PROF }, () => new Float64Array(CAPH)), hyA = Array.from({ length: PROF }, () => new Float64Array(CAPH)), cuA = Array.from({ length: PROF }, () => new Float64Array(CAPH));
  const hn = new Int32Array(PROF);
  const ajouterHull = (d, s, y) => {
    const Hs = hsA[d], Hy = hyA[d], Cu = cuA[d];
    let k = hn[d];
    while (k >= 2) { // retirer le dernier point s'il n'est pas au-dessus de la corde (avant-dernier → nouveau)
      const ax = Hs[k - 2], ay = Hy[k - 2], bx = Hs[k - 1], by = Hy[k - 1];
      if ((bx - ax) * (y - ay) - (by - ay) * (s - ax) >= 0) k--; else break;
    }
    if (k >= CAPH) return;
    Hs[k] = s; Hy[k] = y; Cu[k] = k ? Cu[k - 1] + Math.hypot(s - Hs[k - 1], y - Hy[k - 1]) : 0;
    hn[d] = k + 1;
  };
  // différence de marche pour une source au sol à la distance s (chemin tendu au-dessus de l'enveloppe)
  const delta = (d, s) => {
    const Hs = hsA[d], Hy = hyA[d], Cu = cuA[d];
    let k = hn[d] - 1;
    while (k >= 1) {
      const ax = Hs[k - 1], ay = Hy[k - 1], bx = Hs[k], by = Hy[k];
      if ((bx - ax) * (hs - ay) - (by - ay) * (s - ax) >= 0) k--; else break;
    }
    if (k < 1) return -1;
    return Cu[k] + Math.hypot(s - Hs[k], hs - Hy[k]) - Math.hypot(s, hr - hs);
  };
  const ajouter = (g, e) => { if (!vu[g]) { vu[g] = 1; liste[nListe++] = g; } acc[g] += e; };

  // une branche de rayon (récursive pour les réflexions)
  function branche(d, px, pz, dx, dz, s0, fac, nRefl) {
    let u = (px - x0) / pas, v = (pz - z0) / pas;
    let i = Math.floor(u), j = Math.floor(v);
    if (i < 0 || j < 0 || i >= n || j >= n) return;
    const si = dx > 0 ? 1 : -1, sj = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(pas / dx) : Infinity, tdz = dz !== 0 ? Math.abs(pas / dz) : Infinity;
    let tx = dx !== 0 ? ((dx > 0 ? i + 1 - u : u - i) * pas) / Math.abs(dx) : Infinity;
    let tz = dz !== 0 ? ((dz > 0 ? j + 1 - v : v - j) * pas) / Math.abs(dz) : Infinity;
    let t = 0, libre = H[j * n + i] <= 0, reflechi = nRefl >= o.reflexions, axe = 0;
    const tMax = rMax - s0;
    while (t < tMax) {
      const tn = Math.min(tx, tz, tMax);
      const c = j * n + i, hC = H[c];
      const l = tn - t;
      if (hC > 0) {
        if (libre && !reflechi && hC >= 3 && s0 + t > 0.5) { // mur touché : réflexion spéculaire
          let nx = NX[c], nz = NZ[c];
          if (nx === 0 && nz === 0) { if (axe === 0) { nx = -si; nz = 0; } else { nx = 0; nz = -sj; } }
          const dot = dx * nx + dz * nz;
          if (dot < 0) {
            reflechi = true;
            const rx = dx - 2 * dot * nx, rz = dz - 2 * dot * nz, rl = Math.hypot(rx, rz);
            if (d + 1 < PROF) {
              const D = d + 1;
              hsA[D].set(hsA[d].subarray(0, hn[d])); hyA[D].set(hyA[d].subarray(0, hn[d])); cuA[D].set(cuA[d].subarray(0, hn[d])); hn[D] = hn[d];
              branche(D, px + dx * t - dx * 0.02, pz + dz * t - dz * 0.02, rx / rl, rz / rl, s0 + t, fac * fRefl, nRefl + 1);
            }
          }
        }
        ajouterHull(d, s0 + t, hC); ajouterHull(d, s0 + tn, hC);
        libre = false;
      } else {
        libre = true;
        const ga = gA[c], gb = gB[c];
        if (ga >= 0 || gb >= 0) {
          const s = s0 + (t + tn) / 2;
          const dl = delta(d, s);
          const ef = dl < 0 ? 1 : T[Math.min(N_DELTA, Math.round(dl / PAS_DELTA))];
          const base = (fac * dTheta * l * s * ef * Math.exp(-kAir * s)) / (2 * Math.PI * (s * s + dh2));
          if (ga >= 0) ajouter(ga, base * dens[ga]);
          if (gb >= 0) ajouter(gb, base * dens[gb]);
        }
      }
      if (tn >= tMax) break;
      t = tn;
      if (tx < tz) { i += si; tx += tdx; axe = 0; } else { j += sj; tz += tdz; axe = 1; }
      if (i < 0 || j < 0 || i >= n || j >= n) break;
    }
  }

  const progres = o.progres || (() => {});
  for (let r = 0; r < nRec; r++) {
    const x = recepteurs[4 * r], z = recepteurs[4 * r + 1], fnx = recepteurs[4 * r + 2], fnz = recepteurs[4 * r + 3];
    const i = Math.floor((x - x0) / pas), j = Math.floor((z - z0) / pas);
    offsets[r] = pos;
    if (i < 0 || j < 0 || i >= n || j >= n || H[j * n + i] > 0) { interieur[r] = 1; continue; }
    nListe = 0;
    for (let k = 0; k < NR; k++) {
      const th = (k + 0.5) * dTheta, dx = Math.sin(th), dz = -Math.cos(th);
      if ((fnx !== 0 || fnz !== 0) && dx * fnx + dz * fnz < 0) continue; // niveau incident en façade
      hsA[0][0] = 0; hyA[0][0] = hr; cuA[0][0] = 0; hn[0] = 1;
      branche(0, x, z, dx, dz, 0, 1, 0);
    }
    let tot = 0;
    for (let k = 0; k < nListe; k++) tot += acc[liste[k]];
    const seuil = tot * 1e-5;
    if (pos + nListe > cap) { cap = Math.max(cap * 2, pos + nListe + 1024); const g2 = new Int32Array(cap); g2.set(gr); gr = g2; const v2 = new Float32Array(cap); v2.set(va); va = v2; }
    for (let k = 0; k < nListe; k++) {
      const g = liste[k];
      if (acc[g] > seuil) { gr[pos] = g; va[pos] = acc[g]; pos++; }
      acc[g] = 0; vu[g] = 0;
    }
    if ((r & 255) === 0) progres(r / nRec);
  }
  offsets[nRec] = pos;
  return { offsets, groupes: gr.slice(0, pos), valeurs: va.slice(0, pos), interieur, n: nRec };
}

// sources ponctuelles : facteur T (L = L_W + 10 lg T) par récepteur et par source (rayonnement hémisphérique, diffraction)
export function transfertsPoints(S, recepteurs, points, opts = {}) {
  const o = { ...MODELE_DEFAUT.calcul, ...opts };
  const { n, x0, z0, pas, H } = S;
  const hr = o.h_recepteur, kAir = (o.absorption_db_m * Math.LN10) / 10;
  const T = table();
  const nRec = recepteurs.length / 4, P = points.length;
  const out = new Float32Array(nRec * P);
  const Hs = new Float64Array(4096), Hy = new Float64Array(4096), Cu = new Float64Array(4096);
  for (let r = 0; r < nRec; r++) {
    const xr = recepteurs[4 * r], zr = recepteurs[4 * r + 1];
    for (let p = 0; p < P; p++) {
      const { x, z, h = 1.5 } = points[p];
      const D = Math.hypot(x - xr, z - zr);
      if (D > o.rayon_m * 1.5) continue;
      let k = 0;
      Hs[0] = 0; Hy[0] = hr; Cu[0] = 0; k = 1;
      const m = Math.ceil(D / (pas / 2));
      for (let q = 1; q < m; q++) {
        const s = (q / m) * D, xi = xr + ((x - xr) * q) / m, zi = zr + ((z - zr) * q) / m;
        const i = Math.floor((xi - x0) / pas), j = Math.floor((zi - z0) / pas);
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const y = H[j * n + i];
        if (!(y > 0)) continue;
        while (k >= 2 && (Hs[k - 1] - Hs[k - 2]) * (y - Hy[k - 2]) - (Hy[k - 1] - Hy[k - 2]) * (s - Hs[k - 2]) >= 0) k--;
        Hs[k] = s; Hy[k] = y; Cu[k] = Cu[k - 1] + Math.hypot(s - Hs[k - 1], y - Hy[k - 1]); k++;
      }
      let kk = k - 1;
      while (kk >= 1 && (Hs[kk] - Hs[kk - 1]) * (h - Hy[kk - 1]) - (Hy[kk] - Hy[kk - 1]) * (D - Hs[kk - 1]) >= 0) kk--;
      const d3 = Math.hypot(D, hr - h);
      const dl = kk < 1 ? -1 : Cu[kk] + Math.hypot(D - Hs[kk], h - Hy[kk]) - d3;
      const ef = dl < 0 ? 1 : T[Math.min(N_DELTA, Math.round(dl / PAS_DELTA))];
      out[r * P + p] = (ef * Math.exp(-kAir * d3)) / (2 * Math.PI * Math.max(1, d3 * d3));
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Émissions par groupe et par période (énergie de puissance linéique, 10^(L_W'/10)), scénarios
// ------------------------------------------------------------------
export const PERIODES = [['jour', 12], ['soir', 4], ['nuit', 8]];

// trafic d'une route : { tmja, pl, v, revetement }
export function traficRoute(s, M) {
  if (s.comptage) return { tmja: s.comptage.tmja * s.comptage.part * M.facteur_comptages, pl: M.pl[s.highway] ?? 0.03, v: s.vitesse, source: 'comptage' };
  let tmja = M.trafics[s.highway] ?? 0;
  if (s.sensUnique && ['residential', 'tertiary', 'unclassified'].includes(s.highway)) tmja *= 0.7;
  if (s.highway === 'pedestrian' && !/destination|delivery|permit|yes/.test(s.acces || '')) tmja *= 0.5;
  const f = s.nom ? M.rues?.[s.nom] : null; // facteur calibré pour cette rue (rues sans comptage, assez de points de référence)
  if (f != null) return { tmja: tmja * f, pl: M.pl[s.highway] ?? 0.03, v: s.vitesse, source: 'rue' };
  return { tmja, pl: M.pl[s.highway] ?? 0.03, v: s.vitesse, source: 'type' };
}

function energiePeriodes(tmja, pl, v, revetement, M, parts = M.periodes) {
  return PERIODES.map(([p, h]) => energieFlux({ qVL: (tmja * (1 - pl) * parts[p]) / h, qPL: (tmja * pl * parts[p]) / h, vVL: v, vPL: Math.min(v, 50), corrVL: revetement }));
}

// statut appliqué à un tronçon : renvoie [Ed, Ee, En] et le trafic retiré (véh/j, pour le report)
export function emissionRoute(s, M, statut = null) {
  const t = traficRoute(s, M);
  if (!statut || statut.statut === 'actuel') return { E: energiePeriodes(t.tmja, t.pl, t.v, s.revetement, M), tmja: t.tmja, retire: 0, v: t.v };
  const S = M.statuts;
  if (statut.statut === 'zone30') { const v = Math.min(t.v, S.zone30.vitesse); const q = t.tmja * S.zone30.trafic; return { E: energiePeriodes(q, t.pl, v, s.revetement, M), tmja: q, retire: t.tmja - q, v }; }
  if (statut.statut === 'zone20') { const v = Math.min(t.v, S.zone20.vitesse); const q = t.tmja * S.zone20.trafic; return { E: energiePeriodes(q, t.pl, v, s.revetement, M), tmja: q, retire: t.tmja - q, v }; }
  if (statut.statut === 'transports') return { E: [0, 0, 0], tmja: 0, retire: t.tmja, v: t.v };
  if (statut.statut === 'perso') {
    const q = t.tmja * Math.max(0, statut.pourcent ?? 100) / 100, v = Math.max(5, statut.vitesse ?? t.v);
    return { E: energiePeriodes(q, t.pl, v, s.revetement, M), tmja: q, retire: Math.max(0, t.tmja - q), v };
  }
  if (statut.statut === 'pietonne') {
    const P = S.pietonne, v = P.vitesse;
    const riv = t.tmja * (statut.riverains ?? P.riverains * 100) / 100;
    const E = energiePeriodes(riv, t.pl, v, s.revetement, M);
    if (statut.livraisons !== false) { // livraisons le matin (part de jour seulement)
      const L = energiePeriodes(P.livraisons_tmja, P.livraisons_pl, v, s.revetement, M, { jour: 1, soir: 0, nuit: 0 });
      for (let k = 0; k < 3; k++) E[k] += L[k];
    }
    return { E, tmja: riv + (statut.livraisons !== false ? P.livraisons_tmja : 0), retire: Math.max(0, t.tmja - riv), v };
  }
  return { E: energiePeriodes(t.tmja, t.pl, t.v, s.revetement, M), tmja: t.tmja, retire: 0, v: t.v };
}

function emissionTransport(s, M, frequence) {
  if (s.type === 'tram') {
    const T = M.tram;
    return PERIODES.map(([p]) => { const Q = T.passages_heure[p]; return Q > 0 ? en(T.sel_7_5m + 10 * lg(Q) - 10 * lg(3600) + 10 * lg(15)) : 0; });
  }
  const B = M.bus;
  return PERIODES.map(([p]) => {
    const Q = (s.lignes?.length ? s.lignes : ['?']).reduce((a, l) => a + 2 * (p === 'jour' && frequence?.(l) != null ? frequence(l) : B.passages_par_ligne_sens[p]), 0);
    return energieFlux({ qPL: Q * (B.facteur ?? 1), vPL: B.vitesse });
  });
}

// scenario : { troncons: { [idSource]: { statut, livraisons, riverains, pourcent, vitesse } }, report: { pourcent, rayon }, sansTransports: [ids] }
export function emissions(sources, modele, scenario = null, { frequence = null } = {}) {
  const M = fusionnerModele(modele);
  const G = sources.length;
  const E = [new Float64Array(G), new Float64Array(G), new Float64Array(G)];
  const info = new Array(G);
  const reports = [];
  sources.forEach((s, g) => {
    if (s.type === 'route') {
      const st = scenario?.troncons?.[s.id] || null;
      const r = emissionRoute(s, M, st);
      for (let k = 0; k < 3; k++) E[k][g] = r.E[k];
      info[g] = { tmja: r.tmja, v: r.v, statut: st?.statut || 'actuel' };
      if (st && r.retire > 0) reports.push({ g, retire: r.retire });
    } else {
      const e = emissionTransport(s, M, frequence);
      for (let k = 0; k < 3; k++) E[k][g] = e[k];
      info[g] = { statut: 'actuel' };
    }
  });
  // report du trafic retiré sur les voies parallèles proches (non modifiées), au prorata de leur importance et de la proximité
  const pc = (scenario?.report?.pourcent ?? 0) / 100;
  if (pc > 0 && reports.length) {
    const R = scenario.report.rayon || 200;
    const RANG = { primary: 4, secondary: 3, tertiary: 2, unclassified: 1, residential: 1 };
    for (const { g, retire } of reports) {
      const s = sources[g], dir = direction(s.pts), mil = milieu(s.pts);
      const cand = [];
      sources.forEach((o, k) => {
        if (k === g || o.type !== 'route' || scenario.troncons?.[o.id] || !RANG[o.highway]) return;
        const d = Math.hypot(milieu(o.pts)[0] - mil[0], milieu(o.pts)[1] - mil[1]);
        if (d > R || d < 8) return;
        const od = direction(o.pts);
        if (Math.abs(dir[0] * od[0] + dir[1] * od[1]) < 0.7) return;
        cand.push({ k, w: RANG[o.highway] / Math.max(20, d) });
      });
      const W = cand.reduce((a, c) => a + c.w, 0);
      for (const { k, w } of cand) {
        const o = sources[k], t = traficRoute(o, M);
        const ajout = (retire * pc * w) / W;
        const avant = emissionRoute(o, M, null).E, apres = energiePeriodes(t.tmja + ajout, t.pl, t.v, o.revetement, M);
        for (let q = 0; q < 3; q++) E[q][k] += apres[q] - avant[q];
        info[k] = { ...info[k], report: (info[k].report || 0) + ajout };
      }
    }
  }
  const cg = en(M.correction_globale_db || 0);
  for (let k = 0; k < 3; k++) for (let g = 0; g < G; g++) E[k][g] *= cg;
  return { E, info };
}
const direction = (pts) => { const [a, b] = [pts[0], pts[pts.length - 1]], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; };
const milieu = (pts) => { const L = longueur(pts); let acc = 0; for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); if (acc + l >= L / 2) { const t = (L / 2 - acc) / (l || 1); return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; } acc += l; } return pts[0]; };

// recombinaison : niveaux par récepteur (NaN : dans le bâti ou rien reçu). filtre(g) → false : groupe ignoré
export function combiner(T, E, { points = null, filtre = null, plancher = 20 } = {}) {
  const { offsets, groupes, valeurs, interieur, n } = T;
  const Ld = new Float32Array(n), Le = new Float32Array(n), Ln = new Float32Array(n), Lden = new Float32Array(n);
  const P = points?.lw?.length || 0;
  for (let r = 0; r < n; r++) {
    if (interieur[r]) { Ld[r] = Le[r] = Ln[r] = Lden[r] = NaN; continue; }
    let ed = 0, ee = 0, enn = 0;
    for (let k = offsets[r]; k < offsets[r + 1]; k++) {
      const g = groupes[k];
      if (filtre && !filtre(g)) continue;
      const v = valeurs[k];
      ed += v * E[0][g]; ee += v * E[1][g]; enn += v * E[2][g];
    }
    for (let p = 0; p < P; p++) {
      const t = points.T[r * P + p];
      if (!t) continue;
      const w = en(points.lw[p]) * t;
      ed += w * points.parts[p][0]; ee += w * points.parts[p][1]; enn += w * points.parts[p][2];
    }
    const pl = en(plancher);
    Ld[r] = dB(ed + pl); Le[r] = dB(ee + pl); Ln[r] = dB(enn + pl);
    Lden[r] = dB((12 * (ed + pl) + 4 * (ee + pl) * en(5) + 8 * (enn + pl) * en(10)) / 24);
  }
  return { Ld, Le, Ln, Lden };
}

// ------------------------------------------------------------------
// Calibration sur une carte de référence en classes de 5 dB
// refs : [{ r (indice du récepteur), lden: [lo, hi], ln: [lo, hi], rue, milieu }] (lo = -Infinity sous la première classe, hi = Infinity classe ouverte)
// ------------------------------------------------------------------
const ecartClasse = (L, [lo, hi]) => (L < lo ? lo - L : L >= hi ? L - hi : 0);
export function evaluer(T, sources, modele, refs, opts = {}) {
  const { E } = emissions(sources, modele, null, opts);
  const L = combiner(T, E, { filtre: opts.filtre });
  let c = 0, nIn = 0, nPm = 0, N = 0;
  for (const p of refs) {
    for (const [ind, cls] of [['Lden', p.lden], ['Ln', p.ln]]) {
      if (!cls) continue;
      const v = L[ind][p.r];
      if (!Number.isFinite(v)) continue;
      const e = ecartClasse(v, cls);
      c += e * e; N++;
      if (e === 0) nIn++;
      if (e <= 5) nPm++;
    }
  }
  return { cout: N ? c / N : Infinity, dansClasse: N ? nIn / N : 0, unePres: N ? nPm / N : 0, N, L };
}

// recherche par coordonnées (section dorée sur le logarithme des trafics), quelques passes ; a priori faibles (pénalité)
export function calibrer(T, sources, modele, refs, { passes = 4, types = null, journal = () => {}, filtre = null, frequence = null, parRue = true, minPoints = 25 } = {}) {
  let M = fusionnerModele(modele);
  const present = new Set(sources.filter((s) => s.type === 'route' && !s.comptage).map((s) => s.highway));
  const aComptages = sources.some((s) => s.comptage);
  const P = [];
  for (const t of types || TYPES_ROUTE) if (present.has(t) && t !== 'busway') P.push({ nom: `trafics.${t}`, lire: (m) => lg(Math.max(1, m.trafics[t])), ecrire: (m, v) => { m.trafics = { ...m.trafics, [t]: Math.round(10 ** v) }; }, min: 0, max: 4.7, prior: lg(MODELE_DEFAUT.trafics[t] || 100), poids: 0.02 });
  if (aComptages) P.push({ nom: 'facteur_comptages', lire: (m) => lg(m.facteur_comptages), ecrire: (m, v) => { m.facteur_comptages = Math.round(10 ** v * 1000) / 1000; }, min: -0.5, max: 0.5, prior: 0, poids: 0.5 });
  if (sources.some((s) => s.type === 'bus')) P.push({ nom: 'bus.facteur', lire: (m) => lg(m.bus.facteur ?? 1), ecrire: (m, v) => { m.bus = { ...m.bus, facteur: Math.round(10 ** v * 1000) / 1000 }; }, min: -1.3, max: 0.3, prior: 0, poids: 0.05 });
  P.push({ nom: 'periodes.nuit', lire: (m) => m.periodes.nuit, ecrire: (m, v) => { const r = (1 - v) / (m.periodes.jour + m.periodes.soir); m.periodes = { jour: Math.round(m.periodes.jour * r * 1000) / 1000, soir: Math.round(m.periodes.soir * r * 1000) / 1000, nuit: Math.round(v * 1000) / 1000 }; }, min: 0.03, max: 0.2, prior: 0.1, poids: 0 });
  P.push({ nom: 'correction_globale_db', lire: (m) => m.correction_globale_db, ecrire: (m, v) => { m.correction_globale_db = Math.round(v * 10) / 10; }, min: -6, max: 6, prior: 0, poids: 0.02 });
  const cout = (m) => {
    let pen = 0;
    for (const p of P) pen += p.poids * (p.lire(m) - p.prior) ** 2;
    return evaluer(T, sources, m, refs, { filtre, frequence }).cout + pen;
  };
  let best = cout(M);
  journal(`départ : coût ${best.toFixed(3)}`);
  const phi = (Math.sqrt(5) - 1) / 2;
  for (let passe = 0; passe < passes; passe++) {
    for (const p of P) {
      const x0 = p.lire(M);
      const span = passe === 0 ? (p.max - p.min) / 2 : (p.max - p.min) / (4 * (passe + 1));
      let a = Math.max(p.min, x0 - span), b = Math.min(p.max, x0 + span);
      const essai = (x) => { const m = structuredClone(M); p.ecrire(m, x); return cout(m); };
      let c = b - phi * (b - a), d = a + phi * (b - a), fc = essai(c), fd = essai(d);
      for (let it = 0; it < 18; it++) {
        if (fc < fd) { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = essai(c); } else { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = essai(d); }
      }
      const x = fc < fd ? c : d, f = Math.min(fc, fd);
      if (f < best) { p.ecrire(M, x); best = f; }
    }
    journal(`passe ${passe + 1} : coût ${best.toFixed(3)}`);
  }
  // 2e temps : facteur par rue (sans comptage, au moins minPoints points de bord ou de chaussée dans la référence)
  if (parRue) {
    const norm = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    const compte = new Map();
    for (const p of refs) if (p.rue && (p.milieu === 'b' || p.milieu === 'c')) compte.set(p.rue, (compte.get(p.rue) || 0) + 1);
    const noms = [...new Set(sources.filter((s) => s.type === 'route' && !s.comptage && s.nom).map((s) => s.nom))];
    const candidats = noms.filter((nom) => { const N = norm(nom); return [...compte].some(([r, n]) => n >= minPoints && norm(r).split(/\s+/).filter((m) => m.length >= 4).every((m) => N.includes(m))); });
    M.rues = { ...(M.rues || {}) };
    const phi2 = phi;
    for (let passe = 0; passe < 2; passe++) for (const nom of candidats) {
      const essai = (x) => { const m = { ...M, rues: { ...M.rues, [nom]: 10 ** x } }; return evaluer(T, sources, m, refs, { filtre, frequence }).cout + 0.3 * 0.02 * x * x * refs.length / Math.max(1, refs.length); };
      let a = -1, b = 1, c = b - phi2 * (b - a), d = a + phi2 * (b - a), fc = essai(c), fd = essai(d);
      for (let it = 0; it < 14; it++) { if (fc < fd) { b = d; d = c; fd = fc; c = b - phi2 * (b - a); fc = essai(c); } else { a = c; c = d; fc = fd; d = a + phi2 * (b - a); fd = essai(d); } }
      const x = fc < fd ? c : d, f = Math.min(fc, fd), f0 = essai(lg(M.rues[nom] ?? 1));
      if (f < f0 - 1e-4) M.rues[nom] = Math.round(10 ** x * 100) / 100;
    }
    journal(`facteurs par rue (${candidats.length} rues) : coût ${evaluer(T, sources, M, refs, { filtre, frequence }).cout.toFixed(3)}`);
  }
  return { modele: M, cout: best, evaluation: evaluer(T, sources, M, refs, { filtre, frequence }) };
}

// rapport : par rue (points de bord de chaussée), biais par rapport au milieu de la classe (classes fermées), % dans la classe
export function rapport(L, refs, { milieux = ['b', 'c'] } = {}) {
  const parRue = new Map(), tous = { n: 0, dans: 0, pm: 0, biais: 0, nb: 0, abs: 0 };
  const lignes = { Lden: { ...tous }, Ln: { ...tous } };
  for (const p of refs) {
    for (const ind of ['Lden', 'Ln']) {
      const cls = ind === 'Lden' ? p.lden : p.ln;
      if (!cls) continue;
      const v = L[ind][p.r];
      if (!Number.isFinite(v)) continue;
      const e = ecartClasse(v, cls), g = lignes[ind];
      g.n++; if (e === 0) g.dans++; if (e <= 5) g.pm++;
      if (Number.isFinite(cls[0]) && Number.isFinite(cls[1])) { const b = v - (cls[0] + cls[1]) / 2; g.biais += b; g.abs += Math.abs(b); g.nb++; }
      if (p.rue && milieux.includes(p.milieu)) {
        if (!parRue.has(p.rue)) parRue.set(p.rue, { rue: p.rue, Lden: { m: [], r: [], dans: 0, n: 0 }, Ln: { m: [], r: [], dans: 0, n: 0 } });
        const R = parRue.get(p.rue)[ind];
        R.m.push(v); R.n++; if (e === 0) R.dans++;
        R.r.push(Number.isFinite(cls[1]) ? (Number.isFinite(cls[0]) ? (cls[0] + cls[1]) / 2 : cls[1] - 2.5) : cls[0] + 2.5);
      }
    }
  }
  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const fin = (g) => ({ n: g.n, dansClasse: g.n ? g.dans / g.n : null, unePres: g.n ? g.pm / g.n : null, biais: g.nb ? g.biais / g.nb : null, ecartMoyen: g.nb ? g.abs / g.nb : null });
  const rues = [...parRue.values()].map((R) => ({
    rue: R.rue,
    n: R.Lden.n,
    Lden: { modele: med(R.Lden.m), reference: med(R.Lden.r), dansClasse: R.Lden.n ? R.Lden.dans / R.Lden.n : null },
    Ln: { modele: med(R.Ln.m), reference: med(R.Ln.r), dansClasse: R.Ln.n ? R.Ln.dans / R.Ln.n : null },
  })).sort((a, b) => b.n - a.n);
  return { Lden: fin(lignes.Lden), Ln: fin(lignes.Ln), rues };
}

// ------------------------------------------------------------------
// Contours (isophones) d'une grille : anneaux des régions v ≥ seuil (bords en escalier de la maille)
// grille : { nx, nz, x0, z0, pas, v: Float32Array (NaN = hors calcul) } ; anneaux en [x, z] (mètres)
// ------------------------------------------------------------------
export function contours(grille, seuil) {
  const { nx, nz, x0, z0, pas, v } = grille;
  const dedans = (i, j) => i >= 0 && j >= 0 && i < nx && j < nz && v[j * nx + i] >= seuil;
  // arêtes orientées (région à gauche en parcourant, repère i vers la droite, j vers le bas)
  const suivants = new Map();
  const cle = (i, j) => j * (nx + 1) + i;
  const ajouter = (a, b) => { const k = cle(...a); if (!suivants.has(k)) suivants.set(k, []); suivants.get(k).push(b); };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    if (!dedans(i, j)) continue;
    if (!dedans(i, j - 1)) ajouter([i + 1, j], [i, j]);
    if (!dedans(i, j + 1)) ajouter([i, j + 1], [i + 1, j + 1]);
    if (!dedans(i - 1, j)) ajouter([i, j], [i, j + 1]);
    if (!dedans(i + 1, j)) ajouter([i + 1, j + 1], [i + 1, j]);
  }
  const anneaux = [];
  for (const [k0] of suivants) {
    while (suivants.get(k0)?.length) {
      const start = [k0 % (nx + 1), Math.floor(k0 / (nx + 1))];
      const pts = [start];
      let cur = start, prev = null;
      for (let garde = 0; garde < 1e6; garde++) {
        const L = suivants.get(cle(...cur));
        if (!L?.length) break;
        let idx = 0;
        if (L.length > 1 && prev) { // sommet en damier : tourner à gauche d'abord
          const dx = cur[0] - prev[0], dz = cur[1] - prev[1];
          idx = L.findIndex((b) => (dx * (b[1] - cur[1]) - dz * (b[0] - cur[0])) < 0);
          if (idx < 0) idx = 0;
        }
        const nxt = L.splice(idx, 1)[0];
        prev = cur; cur = nxt;
        if (cur[0] === start[0] && cur[1] === start[1]) break;
        pts.push(cur);
      }
      // sommets alignés retirés
      const simp = pts.filter((p, q) => { const a = pts[(q - 1 + pts.length) % pts.length], b = pts[(q + 1) % pts.length]; return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0; });
      if (simp.length >= 3) anneaux.push(simp.map(([i, j]) => [x0 + i * pas, z0 + j * pas]));
    }
  }
  return anneaux;
}

// ------------------------------------------------------------------
// Entrées depuis les GeoJSON de l'atlas (voirie OSM, lignes de flux, classement sonore), projetées en mètres locaux
// proj : creerProjection de js/geo.js (versLocal(lat, lon) → { x, z })
// ------------------------------------------------------------------
function lignesDe(geom, proj) {
  if (!geom) return [];
  const L = geom.type === 'LineString' ? [geom.coordinates] : geom.type === 'MultiLineString' ? geom.coordinates : [];
  return L.map((l) => l.map(([lon, lat]) => { const p = proj.versLocal(lat, lon); return [p.x, p.z]; })).filter((l) => l.length >= 2);
}
export function entreesDepuisGeo({ voirie, lignes, classement }, proj) {
  const routes = [];
  for (const f of voirie?.features || []) {
    const p = f.properties || {};
    lignesDe(f.geometry, proj).forEach((pts, k) => routes.push({ id: k ? `${p.osm}#${k}` : String(p.osm || `r${routes.length}`), nom: p.name || '', tags: p, pts }));
  }
  const L = [];
  for (const f of lignes?.features || []) {
    const p = f.properties || {};
    lignesDe(f.geometry, proj).forEach((pts, k) => L.push({ id: `${p.voie || L.length}${k ? `#${k}` : ''}`, mode: p.mode, lignes: p.lignes || [], pts }));
  }
  const C = [];
  for (const f of classement?.features || []) {
    const p = f.properties || {};
    if (p.source && p.source !== 'routes') continue;
    if (!(p.tmja > 0)) continue;
    lignesDe(f.geometry, proj).forEach((pts) => C.push({ id: p.id, nom: p.nom, troncon: p.troncon, pts, tmja: p.tmja, vitesse_vl: p.vitesse_vl, vitesse_pl: p.vitesse_pl, categorie: p.categorie, largeur_chaussee_m: p.largeur_chaussee_m }));
  }
  return { routes, lignes: L, classement: C };
}
