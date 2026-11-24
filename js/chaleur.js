import * as THREE from 'three';
import { h, info, dateDepuisJour, jourDeLAnnee, MOIS } from './util.js';
import { pointDansPolygone, polygonesLocaux, lignesLocales } from './geo.js';
import { chargerJSON, enregistrerDonnees } from './donnees.js';
import { visibiliteBatiment, feuillage, transmissionCaduc } from './maquette.js';
import { chargerMeteo, horaire, journeesTypes, sourceEPW, libellePeriode } from './meteo.js';
import { debut, fin } from './profil.js';
import { actif as gpuActif, noterCPU } from './gpu.js';
import { preparerPoints, calculerSVF, positionsSoleil, calculerMasques, simulerJournee, calculEnFond, grillePourFond, temperatureA, temperatureReference, REFERENCE, PAS_INSTANTANE, NB_INSTANTANES } from './chaleur-modele.js';
import { creerPointsChauds } from './chaleur-points.js';
import { abriCiel } from './vent-abri.js';
import { textureGrille, caseLissage, hauteResolution, zoneDetaillee, representants, etendre, blocResolution, suivreNote, noterDuree } from './lissage.js';

// Outil Chaleur (onglet Ambiance) : matériaux de surface, albédo, échauffement et points chauds au sol.
// ESTIMATION PÉDAGOGIQUE, pas une simulation certifiée (hypothèses et limites dans les boutons « i »).
// Lot 1 : carte des matériaux du sol (grille de 2 m) et des toitures, albédo, corrections au clic.
// Lot 2 : température de surface estimée (js/chaleur-modele.js : bilan d'énergie force-restore, ombres du bâti effectif et des arbres
//   par la grille des hauteurs de Soleil, ouverture au ciel, vent local de l'outil Vent s'il est calculé) au jour et à l'heure de la barre
//   Soleil ; météo : moyenne du mois (meteo_horaire.json) ou journées types data/chaleur/journees.json (outils/chaleur/journees.py).
// Lot 3 : points chauds et frais, comparaison existant / projet et variantes de matériaux, exports PNG, CSV, DXF (js/chaleur-points.js).
// - data/chaleur/materiaux.json : classes { libelle, type sol|toit, couleur, albedo, emissivite, effusivite, evaporation, transmission?, refs } + références ;
// - data/chaleur/toitures.json : classe de toiture par bâtiment (osm / ign / centre), outils/chaleur/pretraitement.py (BD TOPO + orthophoto) ;
// - data/chaleur/ortho.json : orthophoto IGN résumée en grille de 4 m (v végétal, c sol clair, . autre ; lignes codées par plages), même script ;
// - data/chaleur/corrections.json : { description, corrections: [{ id, type: 'element'|'disque'|'polygone'|'trait'|'toit', cle?, lat?, lon?, rayon?, points?, classe, phase?, date }] }
//   (WGS84 : indépendant de config.origine), écrit par enregistrerDonnees (serveur.py), sinon téléchargé.
//   phase : 'existant' (défaut : corrections du site réel) ou 'projet' (matériaux du projet, appliqués seulement en phase Projet,
//   après ceux de l'existant). Pinceau (23/10/2026) : cercle qui suit la souris, diamètre 1 à 30 m (curseur, molette pendant la peinture
//   ou Maj + molette), cliquer-glisser : un trait = une correction « trait » (points lat/lon, rayon) dans la phase affichée (js/phase.js).
// Ordre de peinture du sol : orthophoto (fond) < surfaces OSM (verts, places, parkings, eau) < trottoirs < chemins < chaussées
// < sol sous les arbres < corrections ; le bâti effectif (app.batiEffectif) masque le sol.

const LARGEURS = { // comme maquette.js
  primary: 12, secondary: 10, tertiary: 8, residential: 6.5, unclassified: 6, living_street: 5.5,
  pedestrian: 6, service: 4, footway: 2.5, path: 2, cycleway: 2, steps: 2.5, busway: 7,
};
const LARGEUR_TROTTOIR = 2.5;
const SURFACE_OSM = {
  asphalt: 'enrobe', paved: 'enrobe', chipseal: 'enrobe', metal: 'enrobe',
  paving_stones: 'paves', sett: 'paves', cobblestone: 'paves', unhewn_cobblestone: 'paves', stone: 'paves', granite: 'paves',
  concrete: 'dalles', 'concrete:plates': 'dalles', 'concrete:lanes': 'dalles', marble: 'dalles', limestone: 'dalles',
  compacted: 'stabilise', fine_gravel: 'stabilise', gravel: 'stabilise', pebblestone: 'stabilise', dirt: 'stabilise', ground: 'stabilise', earth: 'stabilise', sand: 'stabilise',
  grass: 'pelouse', grass_paver: 'pelouse', wood: 'bois',
};
const HORS = 255, BATI = 254;

export function creerChaleur(app) {
  if (!document.querySelector('link[href$="css/chaleur.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: 'css/chaleur.css' }));
  const etat = {
    pret: null, mat: null, classes: [], idx: {}, toitures: null, ortho: null, corrections: [], modifie: false,
    grille: null, affichage: 'materiaux', calque: null, toitsColores: false,
    capture: null, classeChoisie: 'paves', modeCorrection: 'pinceau', diametre: 4, polygone: [],
    journees: null, temp: null, meteo: 'mois', vueTemp: 'heure', calcul: false, suspendu: false,
    coloration: 'materiaux', provisoire: false, // carte « Matériaux » : coloration choisie ; correction provisoire (variante, non enregistrée)
  };
  const ui = {};
  const rayon = () => Math.min(app.config.rayonConfort || app.config.rayonPlateau, 300);
  const note = (t) => { if (ui.etat) ui.etat.textContent = t; suivreNote(t); };
  const fmt = (v, d = 0) => v.toFixed(d).replace('.', ',');
  const r7 = (v) => Math.round(v * 1e7) / 1e7;

  // ------------------------------------------------------------
  // Données
  // ------------------------------------------------------------
  function charger() {
    if (etat.pret) return etat.pret;
    etat.pret = (async () => {
      const [mat, toitures, ortho, corr, journees] = await Promise.all([
        chargerJSON('data/chaleur/materiaux.json', null), chargerJSON('data/chaleur/toitures.json', null),
        chargerJSON('data/chaleur/ortho.json', null), chargerJSON('data/chaleur/corrections.json', null),
        chargerJSON('data/chaleur/journees.json', null),
      ]);
      etat.journees = journees?.profils ? journees : null;
      if (!mat?.classes) throw new Error('data/chaleur/materiaux.json absent');
      etat.mat = mat;
      etat.classes = Object.entries(mat.classes).map(([id, c]) => ({ id, ...c, rgb: hexRGB(c.couleur) }));
      etat.classes.forEach((c, i) => { etat.idx[c.id] = i; c.tref = temperatureReference(c); });
      const tr = etat.classes.map((c) => c.tref);
      etat.ech = { min: Math.floor(Math.min(...tr)), max: Math.ceil(Math.max(...tr)) };
      etat.toitures = indexerToitures(toitures);
      etat.ortho = decoderOrtho(ortho);
      etat.corrections = (corr?.corrections || []).filter((c) => c && etat.idx[c.classe] != null);
    })();
    etat.pret.catch(() => { etat.pret = null; });
    return etat.pret;
  }
  const hexRGB = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const classe = (id) => etat.classes[etat.idx[id]];

  const SOURCES_TOIT = { o: 'OSM (roof:material)', b: 'BD TOPO, confirmée par l\'orthophoto', d: 'orthophoto (BD TOPO démentie)', p: 'orthophoto (couleur du toit)', f: 'OSM (toit plat)', x: 'défaut' };
  function indexerToitures(d) {
    const parCle = new Map(), points = [];
    for (const [cle, cl, src, bdtopo, lat, lon] of d?.t || []) {
      const t = { cle, classe: cl, source: SOURCES_TOIT[src] || src, bdtopo: bdtopo || null, lat, lon };
      parCle.set(cle, t);
      if (lat != null) points.push(t); // bâtiments BD TOPO sans équivalent OSM : retrouvés par leur centre
    }
    return { parCle, points, source: d?.sources || '', description: d?.description || '' };
  }
  // orthophoto : lignes codées par plages (« 12. » = 12 mailles « . ») décodées une fois
  function decoderOrtho(o) {
    if (!o?.lignes) return null;
    const lignes = o.lignes.map((l) => l.replace(/(\d+)(\D)/g, (_, n, c) => c.repeat(+n)));
    return { ...o, lignes };
  }

  // orthophoto résumée : lettre de la maille sous (x, z)
  function orthoEn(x, z) {
    const o = etat.ortho;
    if (!o) return '';
    const g = app.proj.versGeo(x, z), E = o.emprise;
    const i = Math.floor(((g.lon - E.ouest) / (E.est - E.ouest)) * o.nx), j = Math.floor(((E.nord - g.lat) / (E.nord - E.sud)) * o.ny);
    return i < 0 || j < 0 || i >= o.nx || j >= o.ny ? '' : o.lignes[j][i];
  }

  // clé d'un bâtiment : OSM / IGN, sinon centre géographique (volumes du projet compris)
  function cleBatiment(e) {
    if (e.id) return String(e.id);
    const g = app.proj.versGeo(e.cx, e.cz);
    return `g${g.lat.toFixed(6)},${g.lon.toFixed(6)}`;
  }

  // matériau de toiture : correction > corps détaillés (data/toits) > toitures.json > terrasse (projet) > ardoise
  function classeToit(e, corrections) {
    const cle = cleBatiment(e);
    const c = corrections.findLast((k) => k.type === 'toit' && k.cle === cle); // projet après existant
    if (c) return { id: c.classe, source: 'correction' };
    const corps = e.detail?.corps ? [].concat(e.detail.corps) : [];
    if (corps.length) {
      const n = {};
      for (const k of corps) { const t = k?.materiaux?.toit; if (t && etat.idx[t] != null) n[t] = (n[t] || 0) + 1; }
      const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
      if (best) return { id: best[0], source: 'toitures détaillées de l\'atlas' };
    }
    if (e.projet) return { id: 'terrasse', source: 'volume du projet (terrasse par défaut)' };
    const t = etat.toitures?.parCle.get(cle) || etat.toitures?.points.find((p) => {
      const q = app.proj.versLocal(p.lat, p.lon);
      return Math.abs(q.x - e.cx) < 40 && Math.abs(q.z - e.cz) < 40 && e.polys.some(([ext]) => pointDansPolygone(q.x, q.z, ext));
    });
    if (t && etat.idx[t.classe] != null) return { id: t.classe, source: t.source, bdtopo: t.bdtopo, ortho: t.ortho };
    return { id: 'ardoise', source: 'défaut (ardoise, majoritaire dans le secteur)' };
  }

  // ------------------------------------------------------------
  // Grille des matériaux (maille de 2 m, 3 m au-delà de 150 m de rayon)
  // ------------------------------------------------------------
  function construireGrille({ corrections = correctionsActives(), bati = null } = {}) {
    corrections = ordonner(corrections);
    const r = rayon();
    const hr = hauteResolution(); // haute résolution : mailles de 1 m, points de calcul par blocs hors de la zone détaillée (js/lissage.js)
    const pas = hr ? 1 : r <= 150 ? 2 : 3;
    const n = Math.ceil((2 * r) / pas), x0 = -r, z0 = -r, N = n * n;
    const cls = new Uint8Array(N).fill(HORS), zone = new Int32Array(N).fill(-1), arbre = new Uint8Array(N), bat = new Int32Array(N).fill(-1);
    const zones = [{ type: 'ortho', nom: 'Sol non décrit par OSM (classé d\'après l\'orthophoto)' }];
    const I = etat.idx;
    const cx = (i) => x0 + (i + 0.5) * pas, cz = (j) => z0 + (j + 0.5) * pas;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = cx(i), z = cz(j);
      if (x * x + z * z > r * r) continue;
      const o = orthoEn(x, z);
      cls[j * n + i] = o === 'v' ? I.pelouse : o === 'c' ? I.dalles : I.enrobe;
      zone[j * n + i] = 0;
    }
    const plage = (a, b) => [Math.max(0, Math.floor((a - x0) / pas - 0.5)), Math.min(n - 1, Math.ceil((b - x0) / pas - 0.5))];
    function pourPolygone([ext, ...trous], fn) {
      let xa = Infinity, xb = -Infinity, za = Infinity, zb = -Infinity;
      for (const [x, z] of ext) { xa = Math.min(xa, x); xb = Math.max(xb, x); za = Math.min(za, z); zb = Math.max(zb, z); }
      const [i0, i1] = plage(xa, xb), [j0, j1] = plage(za, zb);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * n + i;
        if (cls[k] === HORS) continue;
        const x = cx(i), z = cz(j);
        if (pointDansPolygone(x, z, ext) && !trous.some((t) => pointDansPolygone(x, z, t))) fn(k, x, z);
      }
    }
    function pourRuban(pts, w, fn) {
      for (let s = 1; s < pts.length; s++) {
        const [ax, az] = pts[s - 1], [bx, bz] = pts[s];
        const [i0, i1] = plage(Math.min(ax, bx) - w, Math.max(ax, bx) + w), [j0, j1] = plage(Math.min(az, bz) - w, Math.max(az, bz) + w);
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const k = j * n + i;
          if (cls[k] === HORS) continue;
          const x = cx(i), z = cz(j);
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          if ((x - ax - t * dx) ** 2 + (z - az - t * dz) ** 2 <= w * w) fn(k, x, z);
        }
      }
    }
    const parElement = new Map(corrections.filter((c) => c.type === 'element').map((c) => [c.cle, c.classe]));
    const peindre = (z, regle) => (k, x, zz) => { const c = parElement.get(zones[z].cle); cls[k] = c ? I[c] : regle(orthoEn(x, zz)); zone[k] = z; };
    const nouvelleZone = (o) => zones.push(o) - 1;

    // surfaces OSM (espaces verts, places piétonnes, parkings, voirie surfacique, eau)
    const regleSurface = {
      vegetal: (o) => (o === 'c' ? I.stabilise : I.pelouse),
      pietonne: (o) => (o === 'c' ? I.dalles : I.paves),
      parking: () => I.enrobe, voirie: () => I.enrobe, eau: () => I.eau,
    };
    const NOMS_SURF = { vegetal: 'Espace vert', pietonne: 'Place ou espace piéton', parking: 'Stationnement', voirie: 'Voirie', eau: 'Eau' };
    for (const f of app.donnees?.osm?.surfaces?.features || []) {
      const p = f.properties || {}, regle = regleSurface[p.surface];
      if (!regle) continue;
      const z = nouvelleZone({ type: 'surface', cle: p.osm || null, nom: p.name || NOMS_SURF[p.surface], osm: p.osm });
      for (const poly of polygonesLocaux(f.geometry, app.proj)) pourPolygone(poly, peindre(z, regle));
    }
    // voirie (rubans des voies, bande de trottoir de part et d'autre des chaussées)
    const chaussees = [], chemins = [];
    for (const f of app.donnees?.osm?.voirie?.features || []) {
      const p = f.properties || {}, hw = p.highway;
      if (!hw || p.tunnel === 'yes' || p.layer < 0) continue;
      const largeur = LARGEURS[hw] ?? 3;
      const lignes = lignesLocales(f.geometry, app.proj).filter((pts) => pts.some(([x, z]) => Math.abs(x) < r + 20 && Math.abs(z) < r + 20));
      if (!lignes.length) continue;
      (largeur >= 4 && hw !== 'pedestrian' ? chaussees : chemins).push({ p, hw, largeur, lignes });
    }
    const tag = (p) => SURFACE_OSM[String(p.surface || '').toLowerCase()];
    const regleTrottoir = (o) => (o === 'c' ? I.dalles : I.enrobe);
    for (const v of chaussees) {
      const z = nouvelleZone({ type: 'trottoir', cle: v.p.osm ? `${v.p.osm}#trottoir` : null, nom: `Trottoir${v.p.name ? `, ${v.p.name}` : ''}`, osm: v.p.osm });
      for (const pts of v.lignes) pourRuban(pts, v.largeur / 2 + LARGEUR_TROTTOIR, peindre(z, regleTrottoir));
    }
    for (const v of chemins) {
      const t = tag(v.p);
      const regle = t ? () => I[t] : v.hw === 'pedestrian' || v.hw === 'steps' ? (o) => (o === 'c' ? I.dalles : I.paves) : regleTrottoir;
      const z = nouvelleZone({ type: 'voie', cle: v.p.osm || null, nom: `${v.hw === 'steps' ? 'Escalier' : v.hw === 'pedestrian' ? 'Rue piétonne' : 'Cheminement'}${v.p.name ? `, ${v.p.name}` : ''}`, osm: v.p.osm, surface: v.p.surface });
      for (const pts of v.lignes) pourRuban(pts, v.largeur / 2, peindre(z, regle));
    }
    for (const v of chaussees) {
      const t = tag(v.p);
      const z = nouvelleZone({ type: 'voie', cle: v.p.osm || null, nom: `Chaussée${v.p.name ? `, ${v.p.name}` : ''}`, osm: v.p.osm, surface: v.p.surface });
      for (const pts of v.lignes) pourRuban(pts, v.largeur / 2, peindre(z, () => I[t || 'enrobe']));
    }
    // arbres : couronne au-dessus ; sol végétal ou stabilisé dessous -> « sol sous arbres » (matériau, toute l'année) ;
    // arbre[k] = 1 sous un persistant (ou un magnolia), 2 sous un caduc seulement (lumière filtrée selon la saison, simulerJournee)
    for (const [lot, liste] of Object.entries(app.arbres?.lots || {})) {
      const code = lot === 'caduc' ? 2 : 1;
      for (const a of liste) {
        const rr = a.d / 2;
        if (Math.abs(a.x) > r + rr || Math.abs(a.z) > r + rr) continue;
        const cercle = [];
        for (let q = 0; q < 12; q++) cercle.push([a.x + rr * Math.cos((q / 12) * 2 * Math.PI), a.z + rr * Math.sin((q / 12) * 2 * Math.PI)]);
        pourPolygone([cercle], (k) => { if (arbre[k] !== 1) arbre[k] = code; if (cls[k] === I.pelouse || cls[k] === I.stabilise) cls[k] = I.sousArbres; });
      }
    }
    // corrections dessinées (disques, polygones, traits de pinceau) ; matériaux du projet après ceux de l'existant
    const disque = (la, lo, rr) => { const p = app.proj.versLocal(la, lo); return Array.from({ length: 16 }, (_, q) => [p.x + rr * Math.cos((q / 16) * 2 * Math.PI), p.z + rr * Math.sin((q / 16) * 2 * Math.PI)]); };
    for (const c of corrections) {
      if (c.type === 'trait') {
        const z = nouvelleZone({ type: 'correction', id: c.id, nom: c.phase === 'projet' ? 'Matériau du projet' : 'Zone corrigée' });
        for (const [la, lo] of c.points || []) pourPolygone([disque(la, lo, c.rayon)], (k) => { cls[k] = I[c.classe]; zone[k] = z; });
        continue;
      }
      if (c.type !== 'disque' && c.type !== 'polygone') continue;
      const z = nouvelleZone({ type: 'correction', id: c.id, nom: c.phase === 'projet' ? 'Matériau du projet' : 'Zone corrigée' });
      const pts = c.type === 'disque'
        ? Array.from({ length: 16 }, (_, q) => { const p = app.proj.versLocal(c.lat, c.lon); return [p.x + c.rayon * Math.cos((q / 16) * 2 * Math.PI), p.z + c.rayon * Math.sin((q / 16) * 2 * Math.PI)]; })
        : c.points.map(([la, lo]) => { const p = app.proj.versLocal(la, lo); return [p.x, p.z]; });
      if (pts.length >= 3) pourPolygone([pts], (k) => { cls[k] = I[c.classe]; zone[k] = z; });
    }
    // bâti effectif (existant non démoli + projet) : masque le sol, toitures à part
    const batiments = [];
    for (const e of bati || app.batiEffectif?.() || app.empreintes || []) {
      if (!visibiliteBatiment({ ...app, vueMaquette: false }, e.cle)) continue;
      if (Math.abs(e.cx) > r + 80 || Math.abs(e.cz) > r + 80) continue;
      const b = batiments.length;
      const t = classeToit(e, corrections);
      batiments.push({ e, toit: t.id, source: t.source, bdtopo: t.bdtopo, cellules: [] });
      for (const poly of e.polys) pourPolygone(poly, (k) => { cls[k] = BATI; bat[k] = b; batiments[b].cellules.push(k); });
    }
    // rep : maille de calcul de chaque maille du sol (haute résolution seulement ; sans rep, chaque maille est calculée)
    const rep = hr ? representants({ nx: n, nz: n, x0, z0, pas, garder: (k) => cls[k] < BATI }) : null;
    return { r, pas, n, x0, z0, cls, zone, zones, arbre, bat, batiments, rep, zoneDetaillee: hr ? zoneDetaillee() : 0 };
  }

  function grille() {
    if (!etat.grille) etat.grille = construireGrille();
    return etat.grille;
  }
  function invalider() {
    etat.grille = null;
    const avaitTemp = !!etat.temp;
    etat.temp = null;
    if (etat.affichage === 'temperature') {
      if (avaitTemp && ui.temp?.isConnected) planifierCalcul(); else { effacerTout(); }
    } else if (etat.calque || etat.toitsColores) afficher();
  }

  // ------------------------------------------------------------
  // Affichage : texture au sol (comme Confort), toitures en couleurs par sommet
  // ------------------------------------------------------------
  function couleurCellule(G, k, mode, vals) {
    const c = G.cls[k];
    if (c === HORS || c === BATI) return null;
    if (mode === 'materiaux') return etat.classes[c].rgb;
    if (mode === 'albedo') return rampeAlbedo(etat.classes[c].albedo);
    if (mode === 'echauffement') return rampeEchauffement(etat.classes[c].tref);
    return vals ? (Number.isFinite(vals[k]) ? vals.couleur(vals[k]) : null) : null;
  }
  // albédo : dégradé continu sur une échelle fixe (plage de materiaux.json), du rouge (albédo faible : absorbe, plus chaud)
  // au bleu (albédo élevé : réfléchit, plus frais) en passant par une teinte claire neutre, comme la carte de température
  const ALB_MIN = 0.05, ALB_MAX = 0.5;
  const PALETTE_ALB = [[0, [165, 0, 38]], [0.25, [244, 109, 67]], [0.5, [255, 247, 214]], [0.75, [116, 173, 209]], [1, [49, 54, 149]]];
  const rampeAlbedo = (a) => {
    const t = Math.min(1, Math.max(0, (a - ALB_MIN) / (ALB_MAX - ALB_MIN)));
    for (let q = 1; q < PALETTE_ALB.length; q++) {
      if (t <= PALETTE_ALB[q][0]) { const [u0, c0] = PALETTE_ALB[q - 1], [u1, c1] = PALETTE_ALB[q], u = (t - u0) / (u1 - u0); return c0.map((v, i) => Math.round(v + (c1[i] - v) * u)); }
    }
    return PALETTE_ALB[PALETTE_ALB.length - 1][1];
  };
  const DEGRADE_ALB = `linear-gradient(90deg, ${PALETTE_ALB.map(([u, c]) => `rgb(${c.join(',')}) ${u * 100}%`).join(', ')})`;
  const GRADUATIONS_ALB = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5];
  // indice d'échauffement : température de surface de référence de chaque classe (temperatureReference, chaleur-modele.js),
  // du bleu (plus frais) au rouge (plus chaud) en passant par un blanc cassé, échelle sur la plage des valeurs des classes
  const PALETTE_ECH = [[0, [49, 54, 149]], [0.3, [69, 117, 180]], [0.5, [255, 247, 214]], [0.75, [244, 109, 67]], [1, [165, 0, 38]]];
  const interpoler = (P, t) => {
    t = Math.min(1, Math.max(0, t));
    for (let q = 1; q < P.length; q++) {
      if (t <= P[q][0]) { const [u0, c0] = P[q - 1], [u1, c1] = P[q], u = (t - u0) / (u1 - u0); return c0.map((v, i) => Math.round(v + (c1[i] - v) * u)); }
    }
    return P[P.length - 1][1];
  };
  const rampeEchauffement = (T) => interpoler(PALETTE_ECH, (T - etat.ech.min) / (etat.ech.max - etat.ech.min || 1));
  const graduationsEch = () => { const { min, max } = etat.ech, pas = max - min > 24 ? 10 : 5, L = [min]; for (let v = Math.ceil((min + 1) / pas) * pas; v < max; v += pas) L.push(v); L.push(max); return L; };
  // description du dégradé affiché (légende du panneau et export PNG de chaleur-points.js)
  function degradeActif() {
    if (etat.affichage === 'albedo') {
      return { palette: PALETTE_ALB, min: ALB_MIN, max: ALB_MAX, graduations: GRADUATIONS_ALB, texte: (a) => fmt(a, 2),
        gauche: '◀ plus chaud (albédo faible, absorbe)', droite: 'plus frais (albédo élevé, réfléchit) ▶' };
    }
    if (etat.affichage === 'echauffement' && etat.ech) {
      return { palette: PALETTE_ECH, min: etat.ech.min, max: etat.ech.max, graduations: graduationsEch(), texte: (t) => `${fmt(t)} °C`,
        gauche: '◀ plus frais', droite: 'plus chaud ▶' };
    }
    return null;
  }

  const couleurClasse = (c, mode) => (mode === 'albedo' ? rampeAlbedo(c.albedo) : mode === 'echauffement' ? rampeEchauffement(c.tref) : c.rgb);

  // continu = { valeur(k), couleur(v) } : carte continue, lissée si « Lisser la carte » (js/lissage.js) ; sinon couleurDe(k) maille par maille
  function poserTexture(G, couleurDe, continu = null) {
    effacerCalque();
    etat.pose = [G, couleurDe, continu]; // redessin au changement de « Lisser la carte »
    const { n, x0, z0, pas } = G;
    const tex = textureGrille({ nx: n, nz: n, alpha: 225, couleurBrute: couleurDe, ...(continu || {}) });
    const geo = new THREE.PlaneGeometry(n * pas, n * pas).rotateX(-Math.PI / 2);
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -11, polygonOffsetUnits: -11 }));
    m.position.set(x0 + (n * pas) / 2, 0.33, z0 + (n * pas) / 2);
    m.name = 'chaleur-carte';
    m.renderOrder = 6;
    m.raycast = () => {};
    app.scene.add(m);
    etat.calque = m;
    points.majExport(); // bloc « Exporter cette carte » : PNG et CSV disponibles
  }
  function effacerCalque() {
    if (!etat.calque) return;
    app.scene.remove(etat.calque);
    etat.calque.geometry.dispose();
    etat.calque.material.map.dispose();
    etat.calque.material.dispose();
    etat.calque = null;
    points.majExport();
  }

  // toits : couleur par bâtiment sur les sommets des pans (normale vers le haut), murs inchangés
  function colorierToits(G, couleurBat) {
    effacerToits(false);
    const col = new THREE.Color(), nrm = new THREE.Vector3();
    const modifies = new Set();
    for (let b = 0; b < G.batiments.length; b++) {
      const { e } = G.batiments[b];
      if (!e.mesh) continue;
      const c = couleurBat(b);
      if (!c) continue;
      const attr = e.mesh.geometry.getAttribute('color'), nor = e.mesh.geometry.getAttribute('normal');
      if (!attr || !nor) continue;
      col.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
      for (let v = e.debut; v < e.debut + e.nb; v++) {
        nrm.fromBufferAttribute(nor, v);
        if (nrm.y > 0.55) attr.setXYZ(v, col.r, col.g, col.b);
      }
      modifies.add(attr);
    }
    modifies.forEach((a) => { a.needsUpdate = true; });
    etat.toitsColores = true;
  }
  function effacerToits(restaurer = true) {
    if (!etat.toitsColores) return;
    etat.toitsColores = false;
    if (restaurer) app.cadastre?.majBatiments(true);
  }

  function afficher() {
    if (!etat.mat) return;
    if (etat.affichage === 'temperature') { if (etat.temp) afficherTemperature(); else lancerCalcul(); return; }
    // écart projet − existant : dernière comparaison (chaleur-points.js) ; sans comparaison, retour à la carte des matériaux
    if (etat.affichage === 'ecart') { if (points.etat.ecart) { afficherEcart(points.etat.ecart); return; } etat.affichage = etat.coloration; majChoix(); }
    const G = grille();
    const mode = etat.affichage;
    // albédo et échauffement : valeur de la classe, lissable ; matériaux : catégories, jamais lissées
    const continu = mode === 'albedo' || mode === 'echauffement' ? {
      valeur: (k) => { const c = G.cls[k]; return c === HORS || c === BATI ? NaN : mode === 'albedo' ? etat.classes[c].albedo : etat.classes[c].tref; },
      couleur: mode === 'albedo' ? rampeAlbedo : rampeEchauffement } : null;
    poserTexture(G, (k) => couleurCellule(G, k, mode), continu);
    if (ui.toits?.checked) colorierToits(G, (b) => couleurClasse(classe(G.batiments[b].toit), mode));
    else effacerToits();
    majLegende(G);
  }
  function effacerTout() {
    effacerCalque();
    effacerToits();
    points?.effacer();
    if (ui.legende) ui.legende.replaceChildren();
  }

  // ------------------------------------------------------------
  // Légende et statistiques
  // ------------------------------------------------------------
  function statistiques(G) {
    const nb = new Map();
    let total = 0;
    for (let k = 0; k < G.cls.length; k++) { const c = G.cls[k]; if (c < BATI) { nb.set(c, (nb.get(c) || 0) + 1); total++; } }
    const toits = new Map();
    for (const b of G.batiments) toits.set(b.toit, (toits.get(b.toit) || 0) + b.cellules.length);
    return { nb, total, toits };
  }
  function majLegende(G) {
    if (!ui.legende) return;
    const s = statistiques(G);
    const m2 = G.pas * G.pas;
    let albMoy = 0;
    s.nb.forEach((v, c) => { albMoy += etat.classes[c].albedo * v; });
    albMoy /= Math.max(s.total, 1);
    const ech = etat.affichage === 'echauffement';
    const ligne = (c, nCell) => h('li', {}, // sans pastille de couleur : couleurs dans la légende automatique (js/legende.js), 15/11/2026
      `${c.libelle} — ${ech ? `${fmt(c.tref)} °C de référence, ` : ''}albédo ${fmt(c.albedo, 2)}${nCell ? ` · ${Math.round((nCell * m2) / 10) * 10} m²` : ''}`);
    const sol = etat.classes.filter((c) => c.type === 'sol' && s.nb.get(etat.idx[c.id]));
    const toits = etat.classes.filter((c) => c.type === 'toit' && s.toits.get(c.id));
    ui.legende.replaceChildren(
      h('p', { class: 'resultat' }, `Sol libre du cercle d'analyse : ${Math.round((s.total * m2) / 100) * 100} m², albédo moyen ${fmt(albMoy, 2)} (maille de ${G.pas} m).`),
      h('p', { class: 'legende-titre' }, 'Sol'),
      h('ul', { class: 'legende legende-chaleur' }, ...sol.map((c) => ligne(c, s.nb.get(etat.idx[c.id])))),
      h('p', { class: 'legende-titre' }, ui.toits?.checked ? 'Toitures (colorées sur la maquette)' : 'Toitures (cocher « Colorer les toitures »)'),
      h('ul', { class: 'legende legende-chaleur' }, ...toits.map((c) => ligne(c, s.toits.get(c.id)))),
      ech ? h('p', { class: 'note' }, `Couleur = température de surface d'équilibre de chaque matériau dans les mêmes conditions de référence (plein soleil ${REFERENCE.K} W/m², air ${REFERENCE.ta} °C, vent ${REFERENCE.v} m/s, ciel clair, sans ombre ; sol sous arbres : ${Math.round(REFERENCE.ombreArbres * 100)} % du rayonnement), d'après l'albédo, l'émissivité, l'évaporation et l'inertie de materiaux.json. L'herbe reste fraîche malgré un albédo moyen (${fmt(classe('pelouse')?.albedo ?? 0.23, 2)}) parce qu'elle évapore de l'eau (évapotranspiration) ; l'eau, par sa grande inertie ; le zinc chauffe faute d'émissivité et d'inertie.`) : null,
    );
  }

  // valeur sous le pointeur
  app.on('pointeurSol', ([x, z]) => {
    if (!ui.pointeur?.isConnected || !etat.grille || (!etat.calque && !etat.toitsColores)) return;
    ui.pointeur.textContent = decrire(x, z) || '';
  });
  function cellule(G, x, z) {
    const i = Math.floor((x - G.x0) / G.pas), j = Math.floor((z - G.z0) / G.pas);
    return i < 0 || j < 0 || i >= G.n || j >= G.n ? -1 : j * G.n + i;
  }
  function decrire(x, z) {
    const G = etat.grille, k = cellule(G, x, z);
    if (k < 0 || G.cls[k] === HORS) return '';
    if (G.cls[k] === BATI) {
      const b = G.batiments[G.bat[k]], c = classe(b.toit);
      return `${c.libelle} (albédo ${fmt(c.albedo, 2)}, émissivité ${fmt(c.emissivite, 2)}) — ${b.source}${b.bdtopo ? `, BD TOPO ${b.bdtopo}` : ''}`;
    }
    const c = etat.classes[G.cls[k]], zz = G.zones[G.zone[k]];
    const T = etat.affichage === 'temperature' && etat.temp?.G === G ? texteTemperature(k) : '';
    return `${T}${c.libelle} (albédo ${fmt(c.albedo, 2)}) — ${zz?.nom || ''}${zz?.surface ? ` (OSM surface=${zz.surface})` : ''}`;
  }

  // ------------------------------------------------------------
  // Corrections au clic
  // ------------------------------------------------------------
  const nouvelId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  // phase affichée (js/phase.js) : en Projet, les corrections sont des matériaux du projet
  const phaseCourante = () => app.phase?.phase || (app.projet?.visible === false ? 'existant' : 'projet');
  const phaseDe = (c) => (c.phase === 'projet' ? 'projet' : 'existant');
  // variantes provisoires (case « Provisoire », non enregistrées : points.etat.variantes) : matériaux du projet, après les corrections enregistrées
  const variantes = () => points?.etat.variantes || [];
  function correctionsActives() {
    const L = etat.corrections.filter((c) => phaseDe(c) === 'existant' || app.projet?.visible !== false);
    return app.projet?.visible !== false && variantes().length ? L.concat(variantes()) : L;
  }
  function ordonner(L) { return [...L].sort((a, b) => (phaseDe(a) === 'projet') - (phaseDe(b) === 'projet')); }
  function ajouterCorrection(c) {
    if (etat.provisoire) { // variante : comparaison existant / projet (chaleur-points.js), jamais dans corrections.json
      const v = { id: nouvelId(), ...c, phase: 'projet', provisoire: true };
      v.nom = v.nom || decrireCorrection(v);
      points.etat.variantes = variantes().filter((k) => !(k.type === v.type && v.cle && k.cle === v.cle)).concat([v]);
      invalider();
      majCorrections();
      return;
    }
    c.phase = phaseCourante();
    const liste = etat.corrections.filter((k) => !(k.type === c.type && c.cle && k.cle === c.cle && phaseDe(k) === c.phase));
    liste.push({ id: nouvelId(), ...c, date: new Date().toISOString().slice(0, 10) });
    etat.corrections = liste;
    etat.modifie = true;
    invalider();
    majCorrections();
  }
  function clic(p) {
    if (!p) return;
    const G = grille(), k = cellule(G, p[0], p[1]);
    if (k < 0 || G.cls[k] === HORS) { app.signaler('Hors du cercle d\'analyse.'); return; }
    const cl = classe(etat.classeChoisie);
    const g = app.proj.versGeo(p[0], p[1]);
    if (G.cls[k] === BATI) {
      if (cl.type !== 'toit') { app.signaler('Bâtiment : choisissez un matériau de toiture.'); return; }
      const b = G.batiments[G.bat[k]];
      ajouterCorrection({ type: 'toit', cle: cleBatiment(b.e), lat: r7(g.lat), lon: r7(g.lon), classe: cl.id });
      app.signaler(`Toiture corrigée : ${cl.libelle}.`);
      return;
    }
    if (cl.type !== 'sol') { app.signaler('Sol : choisissez un matériau de sol.'); return; }
    if (etat.modeCorrection === 'pinceau') return; // tracé par le pinceau (pointerdown / pointermove)
    if (etat.modeCorrection === 'polygone') {
      etat.polygone.push([r7(g.lat), r7(g.lon)]);
      dessinerPolygone();
      majCorrections();
      return;
    }
    // élément OSM sous le clic (le mode « Disque » a été retiré le 15/11/2026 : le pinceau le remplace ; les anciens disques restent lus)
    const zz = G.zones[G.zone[k]];
    if (zz?.cle) {
      ajouterCorrection({ type: 'element', cle: zz.cle, nom: zz.nom, lat: r7(g.lat), lon: r7(g.lon), classe: cl.id });
      app.signaler(`${zz.nom} : ${cl.libelle}${etat.provisoire ? ' (provisoire)' : ''}.`);
    } else app.signaler('Aucun élément OSM sous le clic : utilisez le pinceau ou une zone dessinée.');
  }
  // tracé provisoire du polygone
  const ligneTrace = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xd4452a, depthTest: false }));
  ligneTrace.renderOrder = 9; ligneTrace.visible = false; ligneTrace.raycast = () => {}; ligneTrace.userData.pasDeRelief = true;
  app.scene.add(ligneTrace);
  function dessinerPolygone() {
    const pts = etat.polygone.map(([la, lo]) => { const q = app.proj.versLocal(la, lo); return new THREE.Vector3(q.x, (app.relief?.dz?.(q.x, q.z) || 0) + 0.6, q.z); });
    if (pts.length > 2) pts.push(pts[0].clone());
    ligneTrace.geometry.dispose();
    ligneTrace.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    ligneTrace.visible = pts.length > 1;
  }
  function terminerPolygone() {
    if (etat.polygone.length >= 3) {
      ajouterCorrection({ type: 'polygone', points: etat.polygone, classe: etat.classeChoisie });
      app.signaler(`Zone de ${etat.polygone.length} sommets : ${classe(etat.classeChoisie).libelle}${etat.provisoire ? ' (provisoire)' : ''}.`);
    }
    etat.polygone = [];
    dessinerPolygone();
    majCorrections();
  }
  // ------------------------------------------------------------
  // Pinceau circulaire (23/10/2026) : anneau qui suit la souris, cliquer-glisser pour peindre la classe choisie ;
  // diamètre 1 à 30 m (curseur ; molette pendant la peinture ou Maj + molette). Aperçu en disques pendant le trait,
  // une correction « trait » à la fin (grille recalculée une fois).
  // ------------------------------------------------------------
  const pinceau = (() => {
    const anneau = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xd4452a, transparent: true, opacity: 0.95, depthTest: false }));
    anneau.name = 'pinceau-chaleur'; anneau.renderOrder = 12; anneau.visible = false; anneau.raycast = () => {}; anneau.userData.pasDeRelief = true;
    const apercu = new THREE.Group();
    apercu.name = 'pinceau-chaleur-trait'; apercu.userData.pasDeRelief = true;
    app.scene.add(anneau, apercu);
    const disqueGeo = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plan = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), q = new THREE.Vector3();
    let trait = null, dernier = null;
    const actif = () => !!etat.capture && etat.modeCorrection === 'pinceau';
    const dz = (x, z) => (app.relief?.dz ? app.relief.dz(x, z) || 0 : 0);
    function solSous(e) {
      const cv = app.renderer.domElement, R = cv.getBoundingClientRect();
      ndc.set(((e.clientX - R.left) / R.width) * 2 - 1, -((e.clientY - R.top) / R.height) * 2 + 1);
      ray.setFromCamera(ndc, app.camera);
      plan.constant = -dz(0, 0);
      if (!ray.ray.intersectPlane(plan, q)) return null;
      return [q.x, q.z];
    }
    function placer(p) {
      const r = etat.diametre / 2;
      anneau.position.set(p[0], dz(p[0], p[1]) + 0.7, p[1]);
      anneau.scale.setScalar(r);
      anneau.visible = true;
    }
    function diametre(d) {
      etat.diametre = Math.min(30, Math.max(1, Math.round(d)));
      if (ui.diametre) ui.diametre.value = etat.diametre;
      if (ui.texteDiametre) ui.texteDiametre.textContent = `${etat.diametre} m`;
      if (dernier) placer(dernier);
      if (trait) trait.rayon = Math.max(trait.rayon, etat.diametre / 2);
    }
    function ajouterPoint(p, force = false) {
      const r = etat.diametre / 2;
      const prec = trait.local[trait.local.length - 1];
      if (!force && prec && Math.hypot(p[0] - prec[0], p[1] - prec[1]) < r * 0.45) return;
      trait.local.push(p);
      const g = app.proj.versGeo(p[0], p[1]);
      trait.points.push([r7(g.lat), r7(g.lon)]);
      trait.rayons.push(r);
      const m = new THREE.Mesh(disqueGeo, trait.mat);
      m.position.set(p[0], dz(p[0], p[1]) + 0.6, p[1]); m.scale.setScalar(r); m.renderOrder = 11; m.raycast = () => {};
      apercu.add(m);
    }
    function finir() {
      const t = trait;
      trait = null;
      if (app.controls) app.controls.enabled = true;
      apercu.clear();
      t?.mat.dispose();
      if (!t?.points.length) return;
      // un trait par diamètre : les points peints avec un autre diamètre (molette) gardent le leur
      const groupes = new Map();
      t.points.forEach((pt, i) => { const r = t.rayons[i]; if (!groupes.has(r)) groupes.set(r, []); groupes.get(r).push(pt); });
      for (const [r, pts] of groupes) ajouterCorrection({ type: 'trait', points: pts, rayon: r, classe: t.classe });
      app.signaler(`Pinceau : ${classe(t.classe).libelle}${etat.provisoire ? ' (provisoire)' : phaseCourante() === 'projet' ? ' (matériau du projet)' : ''}.`);
    }
    function brancher() {
      const cv = app.renderer?.domElement;
      if (!cv || cv.dataset.pinceau) return;
      cv.dataset.pinceau = '1';
      cv.addEventListener('pointermove', (e) => {
        if (!actif()) { if (anneau.visible) anneau.visible = false; return; }
        const p = solSous(e);
        if (!p) return;
        dernier = p;
        placer(p);
        if (trait && (e.buttons & 1)) ajouterPoint(p);
      }, { passive: true });
      cv.addEventListener('pointerdown', (e) => {
        if (!actif() || e.button !== 0) return;
        const cl = classe(etat.classeChoisie);
        if (cl?.type !== 'sol') return; // toiture : clic ordinaire sur le bâtiment
        const p = solSous(e);
        if (!p) return;
        e.stopImmediatePropagation(); e.preventDefault();
        if (app.controls) app.controls.enabled = false;
        const c = classe(etat.classeChoisie);
        trait = { classe: c.id, points: [], rayons: [], local: [], rayon: etat.diametre / 2, mat: new THREE.MeshBasicMaterial({ color: c.couleur, transparent: true, opacity: 0.75, depthTest: false }) };
        ajouterPoint(p, true);
      }, { capture: true });
      window.addEventListener('pointerup', () => { if (trait) finir(); });
      cv.addEventListener('wheel', (e) => {
        if (!actif() || !(trait || e.shiftKey)) return;
        e.preventDefault(); e.stopImmediatePropagation();
        diametre(etat.diametre + ((e.deltaY || e.deltaX) < 0 ? 1 : -1));
      }, { capture: true, passive: false });
    }
    return {
      brancher, diametre, finir,
      cacher() { anneau.visible = false; if (trait) finir(); },
      peindre(pts, cl = etat.classeChoisie) { // pour les essais : trait sur des points locaux [[x, z]]
        const c = classe(cl);
        trait = { classe: c.id, points: [], rayons: [], local: [], rayon: etat.diametre / 2, mat: new THREE.MeshBasicMaterial({ color: c.couleur }) };
        pts.forEach((p, i) => ajouterPoint(p, i === 0));
        finir();
      },
    };
  })();

  function commencerCapture() {
    pinceau.brancher();
    if (!etat.calque) { etat.affichage = ['albedo', 'echauffement'].includes(etat.affichage) ? etat.affichage : 'materiaux'; majChoix(); afficher(); }
    const f = (p) => clic(p);
    app.captureSol = f;
    etat.capture = f;
    majCorrections();
  }
  function arreterCapture() {
    if (etat.capture && app.captureSol === etat.capture) app.captureSol = null;
    etat.capture = null;
    pinceau.cacher();
    if (etat.polygone.length) { etat.polygone = []; dessinerPolygone(); }
    majCorrections();
  }
  async function enregistrer() {
    const d = { description: 'Corrections des matériaux de l\'outil Chaleur (onglet Ambiance) : type element (élément OSM, clé osm ou osm#trottoir), disque (centre lat/lon, rayon m), polygone (points lat/lon), trait (pinceau : points lat/lon, rayon m) ou toit (clé du bâtiment) ; classe = clé de materiaux.json ; phase = existant (site réel, défaut) ou projet (matériaux du projet, appliqués en phase Projet).', corrections: etat.corrections };
    await enregistrerDonnees('chaleur/corrections.json', JSON.stringify(d, null, 1));
    etat.modifie = false;
    majCorrections();
  }
  const decrireCorrection = (c) => (c.type === 'toit' ? 'toiture' : c.type === 'element' ? (c.nom || c.cle) : c.type === 'disque' ? `disque de ${fmt(2 * c.rayon)} m` : c.type === 'trait' ? `trait de pinceau (⌀ ${fmt(2 * c.rayon)} m, ${c.points.length} points)` : `zone de ${c.points.length} sommets`);
  function majCorrections() {
    if (!ui.corrections) return;
    ui.boutonCapture.textContent = etat.capture ? 'Arrêter la correction' : 'Corriger au clic';
    ui.boutonCapture.classList.toggle('actif', !!etat.capture);
    ui.terminer.hidden = !(etat.capture && etat.modeCorrection === 'polygone');
    ui.terminer.textContent = `Terminer la zone (${etat.polygone.length} points)`;
    ui.rayon.hidden = etat.modeCorrection === 'polygone' || etat.modeCorrection === 'element';
    if (ui.provisoire) ui.provisoire.checked = etat.provisoire;
    if (ui.notePhase) ui.notePhase.textContent = etat.provisoire
      ? 'Provisoire : variantes de matériaux, non enregistrées, appliquées en phase Projet et dans « Comparer existant / projet » (perdues au rechargement).'
      : phaseCourante() === 'projet'
        ? 'Phase Projet (en haut à droite) : les corrections sont enregistrées comme matériaux du projet, appliqués seulement en phase Projet.'
        : 'Phase Existant (en haut à droite) : les corrections décrivent le site réel (communes aux deux phases).';
    const L = ordonner(etat.corrections);
    const supprimer = (c) => {
      if (c.provisoire) points.etat.variantes = variantes().filter((k) => k !== c);
      else { etat.corrections = etat.corrections.filter((k) => k !== c); etat.modifie = true; }
      invalider(); majCorrections();
    };
    const ligne = (c) => h('li', { class: c.provisoire ? 'correction-provisoire' : phaseDe(c) === 'projet' ? 'correction-projet' : null },
      h('i', { style: { background: classe(c.classe)?.couleur } }),
      h('span', {}, `${classe(c.classe)?.libelle} — ${decrireCorrection(c)}${c.provisoire ? ' · provisoire' : phaseDe(c) === 'projet' ? ' · projet' : ''}`),
      h('button', { type: 'button', class: 'mini', title: 'Supprimer', 'aria-label': c.provisoire ? 'Retirer la variante' : 'Supprimer la correction', onclick: () => supprimer(c) }, '×'));
    const tout = [...L, ...variantes()];
    ui.corrections.replaceChildren(...(tout.length ? tout.map(ligne) : [h('li', { class: 'vide' }, 'Aucune correction.')]));
    ui.enregistrer.disabled = !etat.modifie;
    ui.enregistrer.textContent = etat.modifie ? 'Enregistrer les corrections' : 'Corrections enregistrées';
  }

  // ------------------------------------------------------------
  // Lot 2 : température de surface
  // ------------------------------------------------------------
  const PALETTE_T = [[15, [49, 54, 149]], [22, [69, 117, 180]], [28, [116, 173, 209]], [33, [171, 217, 233]], [38, [254, 224, 144]], [44, [253, 174, 97]], [50, [244, 109, 67]], [56, [215, 48, 39]], [63, [165, 0, 38]], [70, [103, 0, 31]]];
  function couleurT(t) {
    const P = PALETTE_T;
    if (t <= P[0][0]) return P[0][1];
    for (let q = 1; q < P.length; q++) {
      if (t <= P[q][0]) { const [a, ca] = P[q - 1], [b, cb] = P[q], u = (t - a) / (b - a); return ca.map((v, i) => Math.round(v + (cb[i] - v) * u)); }
    }
    return P[P.length - 1][1];
  }
  const DEGRADE_T = `linear-gradient(90deg, ${PALETTE_T.map(([t, c]) => `rgb(${c.join(',')}) ${Math.round(((t - 15) / 55) * 100)}%`).join(', ')})`;
  const fmtH = (t) => { const hh = Math.floor(t + 1e-6), mm = Math.round((t - hh) * 60); return `${hh} h${mm ? ` ${String(mm).padStart(2, '0')}` : ''}`; };

  // journées types : tirées de l'EPW actif (js/meteo.js), sinon data/chaleur/journees.json (Météo-France)
  const profils = () => journeesTypes()?.profils ?? etat.journees?.profils ?? {};
  function sourcesMeteo() {
    const L = [['mois', sourceEPW() ? `Moyenne du mois (EPW, ${libellePeriode()})` : 'Moyenne du mois (Météo-France 2016-2025)']];
    for (const [k, p] of Object.entries(profils())) L.push([k, p.libelle]);
    return L;
  }
  function jourSoleil() {
    const S = app.soleil.etat;
    return { ...dateDepuisJour(S.annee, S.jour), cle: `${S.annee}-${S.jour}` };
  }
  function heuresMeteo(source, d) {
    if (source !== 'mois' && profils()[source]) return profils()[source].heures;
    return horaire()?.moyennes?.[d.mois] || null;
  }

  // calcul complet (grille, ouverture au ciel, ombres, journée) au jour de la barre Soleil
  let minuterieCalcul = 0;
  function planifierCalcul() { clearTimeout(minuterieCalcul); minuterieCalcul = setTimeout(() => lancerCalcul(), 600); }
  async function lancerCalcul() {
    fin('Chaleur : demandes de calcul', debut(), { enCours: !!etat.calcul });
    if (etat.calcul) { etat.relancer = true; return; }
    etat.calcul = true;
    points?.effacer();
    ui.boutonsTemp?.forEach((b) => { b.disabled = true; });
    try {
      do { etat.relancer = false; const t0 = debut(); await calculerTemperature(); fin('Chaleur : calcul complet', t0); } while (etat.relancer);
      const t1 = debut();
      afficherTemperature();
      fin('Chaleur : affichage', t1);
      note('');
    } catch (e) { note(`Calcul impossible : ${e.message}`); console.warn(e); } finally {
      etat.calcul = false;
      ui.boutonsTemp?.forEach((b) => { b.disabled = false; });
    }
  }
  async function calculerTemperature({ grilleMat = null, garder = true } = {}) {
    const tDebut = performance.now();
    await chargerMeteo();
    const d = jourSoleil();
    const heures = heuresMeteo(etat.meteo, d);
    if (!heures) throw new Error('météo horaire absente (data/meteo/meteo_horaire.json)');
    let t0 = debut();
    const G = grilleMat || grille();
    fin('Chaleur : calcul complet / grille des matériaux', t0); t0 = debut();
    const S = app.soleil;
    const g = S.grilleHauteurs({ x0: -G.r, z0: -G.r, x1: G.r, z1: G.r });
    fin('Chaleur : calcul complet / grille des hauteurs', t0); t0 = debut();
    // haute résolution : un point de calcul par bloc (G.rep) ; les autres mailles du sol sont écartées ici (copie de cls), leur valeur
    // est recopiée de celle du bloc (idx, valeursTemperature)
    const P = preparerPoints(G.rep ? { ...G, cls: G.cls.map((c, k) => (c < BATI && G.rep[k] !== k ? HORS : c)) } : G, etat.classes, { HORS, BATI });
    fin('Chaleur : calcul complet / preparerPoints', t0, { points: P.n, sol: P.nSol });
    // vent local (app.vent.ventLocal, référence unique, 15/11/2026) : champ 2D que l'outil Vent a déjà calculé (rapport ≤ 1,6),
    // sinon repli abriCiel (vitesse réduite selon l'ouverture au ciel)
    const VL = (await app.vent?.ventLocal?.({ calculer: false, plafond: 1.6 })) || null;
    const champ = !!VL;
    const { lat, lon } = app.config.soleil;
    const positions = positionsSoleil({ annee: d.annee, mois: d.mois, jour: d.jour, lat, lon });
    // feuillage des caducs au jour calculé (même règle que l'affichage et la grille des hauteurs de Soleil)
    const f = feuillage({ mois: d.mois, jour: d.jour });
    const options = { tauCaduc: transmissionCaduc(f), caducsDansGrille: (app.arbres?.f ?? f) >= 0.5 };
    const fvCiel = () => { for (let i = 0; i < P.n; i++) P.fv[i] = abriCiel(P.svf[i]); };
    // vent du champ de l'outil Vent : ne dépend pas de l'ouverture au ciel (mailles hors du champ : repli, rempli après)
    const horsChamp = [];
    if (champ) for (let i = 0; i < P.n; i++) { const r = VL.rapport(P.x[i], P.z[i]); if (Number.isFinite(r)) P.fv[i] = r; else horsChamp.push(i); }
    const fvReste = () => { if (!champ) fvCiel(); else for (const i of horsChamp) P.fv[i] = abriCiel(P.svf[i]); };
    // carte graphique (WebGPU) : ouverture au ciel et ombres sur le fil principal (rapides) ; sinon tout le calcul en arrière-plan
    const surGPU = await gpuActif();
    let M = null, R = null;
    if (surGPU) {
      t0 = debut();
      const modeSVF = await calculerSVF(P, g, S.hauteurEn, note);
      fvReste();
      fin('Chaleur : calcul complet / calculerSVF', t0, { mode: modeSVF }); t0 = debut();
      M = await calculerMasques(P, g, S.hauteurEn, positions, note);
      fin('Chaleur : calcul complet / calculerMasques', t0);
    }
    // 08/11/2026 : calcul dans un Web Worker (js/chaleur-worker.js) : l'interface reste fluide et le calcul n'attend plus
    // une image de la maquette à chaque pause ; mêmes fonctions (chaleur-modele.js), mêmes résultats
    t0 = debut();
    const classes = etat.classes.map(({ id, type, albedo, transmission, emissivite, effusivite, evaporation }) => ({ id, type, albedo, transmission, emissivite, effusivite, evaporation }));
    const tache = calculEnFond('journee', { P, g: grillePourFond(g), positions, classes, heures, options, svf: !surGPU, fvCiel: surGPU ? false : champ ? Int32Array.from(horsChamp) : true, M }, [],
      (p) => note(`${p.etape} : ${Math.round(p.u * 100)} %`));
    if (tache) {
      try {
        const r = await tache;
        if (!surGPU) {
          P.svf.set(r.svf);
          P.fv.set(r.fv); // vent : champ de l'outil Vent, sinon 0,35 + 0,65 SVF (calculé par le worker après l'ouverture au ciel)
          noterCPU('ouverture au ciel', r.ms.svf);
        }
        M = r.M; R = r.R;
        fin('Chaleur : calcul complet / arrière-plan', t0, r.ms);
        if (r.ms.svf != null) fin('Chaleur : calcul complet / dont ouverture au ciel (worker)', debut() - r.ms.svf);
        if (r.ms.masques != null) fin('Chaleur : calcul complet / dont ombres (worker)', debut() - r.ms.masques);
        fin('Chaleur : calcul complet / dont simulerJournee (worker)', debut() - r.ms.journee);
      } catch (e) { if (!e.indisponible) throw e; }
    }
    if (!R) { // sans worker : fil principal, comme avant
      if (!surGPU) {
        t0 = debut();
        const modeSVF = await calculerSVF(P, g, S.hauteurEn, note);
        fvReste();
        fin('Chaleur : calcul complet / calculerSVF', t0, { mode: modeSVF }); t0 = debut();
        M = await calculerMasques(P, g, S.hauteurEn, positions, note);
        fin('Chaleur : calcul complet / calculerMasques', t0);
      }
      note('Bilan d\'énergie de la journée…'); await new Promise((r) => setTimeout(r, 0));
      t0 = debut();
      R = simulerJournee(P, etat.classes, heures, positions, M, options);
      fin('Chaleur : calcul complet / simulerJournee', t0, { points: P.n });
    }
    const idx = new Int32Array(G.n * G.n).fill(-1);
    for (let i = 0; i < P.nSol; i++) idx[P.k[i]] = i;
    if (G.rep) for (let k = 0; k < idx.length; k++) { const q = G.rep[k]; if (q >= 0 && q !== k) idx[k] = idx[q]; } // blocs hors zone détaillée
    noterDuree('chaleur', performance.now() - tDebut, P.n);
    const res = { G, P, R, M, positions, heures, d, feuillage: f, source: etat.meteo, champ, idx, cle: d.cle, ta: (t) => heures[Math.min(23, Math.round(t))]?.ta };
    if (garder) etat.temp = res;
    return res;
  }

  // valeurs d'une carte : à l'heure t ou maximum du jour ; sol (par maille) et toits (moyenne par bâtiment)
  function valeursTemperature(res, t, mode) {
    const { G, P, R } = res;
    const sol = new Float32Array(G.n * G.n).fill(NaN);
    const toits = new Float64Array(G.batiments.length), nb = new Uint16Array(G.batiments.length);
    for (let i = 0; i < P.n; i++) {
      const v = mode === 'max' ? R.Tmax[i] : temperatureA(R, P.n, i, t);
      if (i < P.nSol) sol[P.k[i]] = v; else { toits[P.bat[i]] += v; nb[P.bat[i]]++; }
    }
    for (let b = 0; b < toits.length; b++) toits[b] = nb[b] ? toits[b] / nb[b] : NaN;
    etendre(sol, G.rep); // haute résolution : valeur du point de calcul du bloc
    return { sol, toits };
  }
  // part d'ombre d'une maille de 9 h à 19 h (points chauds en mode « maximum de la journée »)
  function partOmbreJour(res, i) {
    let o = 0, n = 0;
    for (let t = 9; t <= 19; t += PAS_INSTANTANE) { o += soleilA(res, i, t) < 0.5 ? 1 : 0; n++; }
    return o / n;
  }
  function soleilA(res, i, t) {
    const sf = t / PAS_INSTANTANE, s0 = Math.min(NB_INSTANTANES - 1, Math.floor(sf)), s1 = Math.min(NB_INSTANTANES - 1, s0 + 1), w = sf - s0;
    return res.M[s0 * res.P.n + i] * (1 - w) + res.M[s1 * res.P.n + i] * w;
  }

  function afficherTemperature() {
    const res = etat.temp;
    if (!res) return;
    const t = app.soleil.etat.heure, mode = etat.vueTemp;
    const V = valeursTemperature(res, t, mode);
    etat.valeursT = V;
    poserTexture(res.G, (k) => (Number.isFinite(V.sol[k]) ? couleurT(V.sol[k]) : null), { valeur: (k) => V.sol[k], couleur: couleurT });
    if (ui.toits?.checked) colorierToits(res.G, (b) => (Number.isFinite(V.toits[b]) ? couleurT(V.toits[b]) : null)); else effacerToits();
    majLegendeTemperature(res, V, t, mode);
  }

  function texteTemperature(k) {
    const res = etat.temp, i = res?.idx[k];
    if (i == null || i < 0) return '';
    const t = app.soleil.etat.heure;
    return `${fmt(temperatureA(res.R, res.P.n, i, t), 1)} °C à ${fmtH(t)} (maximum ${fmt(res.R.Tmax[i], 1)} °C vers ${fmtH(res.R.hMax[i])}) · `;
  }

  // tableau par matériau : moyenne au soleil et à l'ombre
  function parMateriau(res, V, t, mode) {
    const acc = new Map();
    for (let i = 0; i < res.P.nSol; i++) {
      const v = V.sol[res.P.k[i]];
      if (!Number.isFinite(v)) continue;
      const c = res.P.cls[i];
      const ombre = mode !== 'max' && soleilA(res, i, t) < 0.5;
      const a = acc.get(c) || { s: 0, ns: 0, o: 0, no: 0, max: -1e9 };
      if (ombre) { a.o += v; a.no++; } else { a.s += v; a.ns++; }
      a.max = Math.max(a.max, v);
      acc.set(c, a);
    }
    return [...acc.entries()].sort((a, b) => (b[1].ns + b[1].no) - (a[1].ns + a[1].no));
  }

  function majLegendeTemperature(res, V, t, mode) {
    if (!ui.legende) return;
    const ok = [...V.sol].filter(Number.isFinite);
    const moy = ok.reduce((a, b) => a + b, 0) / Math.max(ok.length, 1);
    const min = Math.min(...ok), max = Math.max(...ok);
    const ta = mode === 'max' ? Math.max(...res.heures.filter(Boolean).map((x) => x.ta)) : res.ta(t);
    const lib = sourcesMeteo().find(([k]) => k === res.source)?.[1] || '';
    const titre = mode === 'max' ? `Maximum de la journée du ${res.d.jour} ${MOIS[res.d.mois]}` : `Le ${res.d.jour} ${MOIS[res.d.mois]} à ${fmtH(t)}`;
    const lignes = parMateriau(res, V, t, mode);
    const toitsOk = [...V.toits].filter(Number.isFinite);
    ui.legende.replaceChildren(
      h('p', { class: 'resultat' }, `${titre} : sol entre ${fmt(min)} et ${fmt(max)} °C (moyenne ${fmt(moy)} °C) pour un air à ${fmt(ta, 1)} °C${toitsOk.length ? ` ; toits jusqu'à ${fmt(Math.max(...toitsOk))} °C` : ''}. Météo : ${lib.toLowerCase()}.`),
      h('table', { class: 'table-chaleur' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Matériau'), h('th', {}, mode === 'max' ? 'Moyenne' : 'Au soleil'), h('th', {}, mode === 'max' ? 'Maximum' : 'À l\'ombre'))),
        h('tbody', {}, ...lignes.map(([c, a]) => h('tr', {},
          h('td', {}, etat.classes[c].libelle),
          h('td', {}, mode === 'max' ? `${fmt((a.s + a.o) / Math.max(a.ns + a.no, 1))} °C` : a.ns ? `${fmt(a.s / a.ns)} °C` : '—'),
          h('td', {}, mode === 'max' ? `${fmt(a.max)} °C` : a.no ? `${fmt(a.o / a.no)} °C` : '—'))))),
      h('p', { class: 'note', 'data-garder': '' }, `Vent : ${res.champ ? 'champ local de l\'outil Vent' : 'vitesse mesurée réduite selon l\'ouverture au ciel (calculer le vent dans l\'outil Vent pour l\'affiner)'}.`),
    );
  }

  // la barre Soleil pilote la carte : même jour -> nouvel affichage instantané ; autre jour -> nouveau calcul
  let attenteSoleil = 0;
  app.on('soleil', () => {
    if (etat.affichage !== 'temperature' || !etat.temp || !ui.temp?.isConnected) return;
    if (etat.temp.cle === jourSoleil().cle) { cancelAnimationFrame(attenteSoleil); attenteSoleil = requestAnimationFrame(afficherTemperature); }
    else planifierCalcul();
  });

  function prereglage(cle) {
    const p = profils()[cle];
    const [mm, jj] = String(cle === 'chaude' ? '06-21' : p?.date || '07-18').split('-').map(Number);
    etat.meteo = cle;
    if (ui.selMeteo) ui.selMeteo.value = cle;
    etat.affichage = 'temperature';
    majChoix();
    const an = app.soleil.etat.annee;
    etat.temp = null;
    app.soleil.regler({ jour: jourDeLAnnee(new Date(an, mm - 1, jj)), heure: 15 });
    lancerCalcul();
  }

  function infoTemperature() {
    return info(
      'Bilan d\'énergie de surface simplifié, maille par maille (2 m) : rayonnement solaire direct (ombres réelles du bâti effectif — existant non démoli et volumes du projet — et des arbres, à la date de la barre Soleil) et diffus (pondéré par l\'ouverture au ciel), absorbé selon l\'albédo ; infrarouge du ciel (formule de Brutsaert, corrigée de la nébulosité estimée) et des façades voisines ; émission selon l\'émissivité ; convection h = 5,7 + 3,8 v avec le vent local ; évapotranspiration des sols végétaux (part fixe du rayonnement net) ; inertie par la méthode force-restore (effusivité du matériau).',
      'Météo (source choisie en tête du panneau) : moyenne horaire du mois (par défaut Météo-France, Nantes-Bouguenais, 2016-2025 ; ou fichier EPW, rayonnement direct et diffus du fichier), journée chaude type (moyenne heure par heure des jours d\'été à 30 °C ou plus) ou jour le plus chaud mesuré ; rayonnement direct et diffus estimés depuis le global mesuré (modèle d\'Erbs). La journée est simulée deux fois pour la mise en régime ; « Maximum de la journée » garde la valeur la plus haute de chaque maille.',
      'Toitures : quelques points par toit, sans pente ni orientation des pans (toit traité comme horizontal), toujours bien ventilés (vent × 0,8).',
      h('strong', {}, 'Limites : '), 'estimation pédagogique, à ±5 °C au mieux ; pas de réflexions multiples ni d\'ombre des façades sur elles-mêmes, pas d\'humidité du sol ni d\'arrosage, lumière filtrée par les arbres fixe (persistants 12 % ; caducs de 12 % en feuilles à 65 % sans feuilles, selon la date), pas de chaleur anthropique (circulation, climatisation), air supposé uniforme (pas d\'îlot de chaleur de l\'air), vent simplifié. Pour une étude : Ladybug Tools / ENVI-met avec un fichier EPW.',
      h('ol', { class: 'refs' }, ...(etat.mat?.modele || []).map((r) => h('li', {}, r))),
    );
  }

  function construireSectionTemperature() {
    ui.selMeteo = h('select', { 'aria-label': 'Journée de référence', onchange: () => { etat.meteo = ui.selMeteo.value; if (etat.temp) { etat.temp = null; if (etat.affichage === 'temperature') lancerCalcul(); } } },
      ...sourcesMeteo().map(([k, l]) => h('option', { value: k }, l)));
    ui.selMeteo.value = etat.meteo;
    // 15/11/2026 : plus de bouton « Calculer au jour et à l'heure du soleil » (doublon de la carte Température, qui suit la barre Soleil) ;
    // « Recalculer » refait la journée avec les réglages actuels (vent calculé entre-temps, journée de référence…)
    const bCalc = h('button', { type: 'button', class: 'bouton discret', title: 'Refaire le calcul de la journée (après un calcul du vent, par exemple)', onclick: () => { etat.affichage = 'temperature'; majChoix(); etat.temp = null; lancerCalcul(); } }, 'Recalculer');
    const bChaude = h('button', { type: 'button', class: 'bouton discret', onclick: () => prereglage('chaude') }, 'Journée chaude type (21 juin, 15 h)');
    const rec = profils().record;
    const bRecord = rec ? h('button', { type: 'button', class: 'bouton discret', onclick: () => prereglage('record') }, `Jour le plus chaud (${rec.date.split('-').reverse().join('/')}, 15 h)`) : null;
    ui.boutonsTemp = [bChaude, bRecord, bCalc].filter(Boolean);
    const choixVue = h('div', { class: 'choix-chaleur', role: 'group', 'aria-label': 'Valeur affichée' },
      ...[['heure', 'À l\'heure du soleil'], ['max', 'Maximum de la journée']].map(([id, lib]) => h('button', {
        type: 'button', class: `bouton discret${etat.vueTemp === id ? ' actif' : ''}`, 'data-vue-temp': id,
        onclick: (e) => { etat.vueTemp = id; choixVue.querySelectorAll('button').forEach((b) => b.classList.toggle('actif', b === e.currentTarget)); if (etat.affichage === 'temperature' && etat.temp) afficherTemperature(); },
      }, lib)));
    ui.temp = h('div', { class: 'section-temperature' },
      h('div', { class: 'titre-info' }, h('h3', {}, 'Température de surface'), infoTemperature()),
      h('label', { class: 'champ' }, h('span', {}, 'Journée de référence', info(
        'Profil météo heure par heure de la journée simulée : moyenne du mois de la date choisie dans la barre Soleil, journée chaude type ou jour le plus chaud mesuré.',
        'Ces profils sont tirés de la source météo choisie plus haut (« Source météo » : base Météo-France ou fichier EPW).')), ui.selMeteo),
      h('div', { class: 'actions' }, ...ui.boutonsTemp),
      choixVue,
      h('p', { class: 'note', 'data-garder': '' }, 'Date et heure : barre Soleil en haut à droite (la carte suit l\'heure ; un autre jour relance le calcul).'));
    return ui.temp;
  }

  // ------------------------------------------------------------
  // Lot 3 : écart projet - existant, titre et légende pour les exports (js/chaleur-points.js)
  // ------------------------------------------------------------
  const DIVERGENT = [[-10, [33, 102, 172]], [-3.5, [146, 197, 222]], [0, [247, 247, 247]], [3.5, [244, 165, 130]], [10, [178, 24, 43]]];
  function couleurEcart(d) {
    const P = DIVERGENT;
    if (d <= P[0][0]) return P[0][1];
    for (let q = 1; q < P.length; q++) if (d <= P[q][0]) { const [a, ca] = P[q - 1], [b, cb] = P[q], u = (d - a) / (b - a); return ca.map((v, i) => Math.round(v + (cb[i] - v) * u)); }
    return P[P.length - 1][1];
  }
  function afficherEcart(E) {
    etat.affichage = 'ecart';
    majChoix();
    poserTexture(E.G, (k) => (Number.isFinite(E.D[k]) ? couleurEcart(E.D[k]) : null), { valeur: (k) => E.D[k], couleur: couleurEcart });
    effacerToits();
    if (ui.legende) ui.legende.replaceChildren(h('p', { class: 'resultat' }, 'Carte : écart de température de surface projet − existant (voir « Comparer » plus bas).'));
  }
  function titreCarte() {
    const res = etat.temp;
    if (etat.affichage === 'ecart') return 'écart projet − existant';
    if (etat.affichage !== 'temperature' || !res) return { albedo: 'albédo des surfaces', echauffement: `échauffement des matériaux (température de surface de référence, plein soleil, air ${REFERENCE.ta} °C)` }[etat.affichage] || 'matériaux des surfaces';
    const lib = sourcesMeteo().find(([k]) => k === res.source)?.[1] || '';
    return `${etat.vueTemp === 'max' ? 'maximum de la journée du' : 'température de surface le'} ${res.d.jour} ${MOIS[res.d.mois]}${etat.vueTemp === 'max' ? '' : ` à ${fmtH(app.soleil.etat.heure)}`} (${lib.toLowerCase()})`;
  }
  // légende automatique (js/legende.js) : la carte affichée, avec ses couleurs (mêmes palettes que le panneau)
  function legendeAuto() {
    if (!etat.calque || !etat.mat) return null;
    const titre = `Chaleur : ${titreCarte()}`;
    const D = degradeActif();
    if (D) return { id: 'chaleur', titre, note: 'Estimation pédagogique.',
      degrade: { stops: D.palette, graduations: D.graduations.map((a) => ({ u: (a - D.min) / (D.max - D.min), texte: D.texte(a) })), gauche: D.gauche.replace('◀ ', ''), droite: D.droite.replace(' ▶', '') } };
    if (etat.affichage === 'temperature') return { id: 'chaleur', titre, note: 'Estimation pédagogique, ±5 °C au mieux.',
      degrade: { stops: PALETTE_T.map(([t, c]) => [(t - 15) / 55, c]), graduations: [15, 30, 45, 60, 70].map((t) => ({ u: (t - 15) / 55, texte: `${t} °C` })) } };
    if (etat.affichage === 'ecart') return { id: 'chaleur', titre, note: 'Bleu : plus frais avec le projet.',
      degrade: { stops: DIVERGENT.map(([d, c]) => [(d + 10) / 20, c]), graduations: [-10, -5, 0, 5, 10].map((d) => ({ u: (d + 10) / 20, texte: `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)} °C` })) } };
    const G = etat.grille;
    const presents = new Set();
    if (G) { for (let k = 0; k < G.cls.length; k++) if (G.cls[k] < BATI) presents.add(G.cls[k]); if (etat.toitsColores) for (const b of G.batiments) presents.add(etat.idx[b.toit]); }
    return { id: 'chaleur', titre, items: etat.classes.filter((c, i) => !G || presents.has(i)).map((c) => ({ libelle: `${c.libelle} (albédo ${fmt(c.albedo, 2)})`, couleur: c.couleur, forme: 'aplat' })) };
  }
  function texteLegende() {
    const L = [...(ui.legende?.querySelectorAll('.resultat, tr, li') || [])].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (etat.affichage === 'ecart' && points?.etat.ecart) L.unshift(...[...document.querySelectorAll('.section-temperature .resultat')].map((e) => e.textContent));
    return L.slice(0, 4).join('\n');
  }
  function zoneSous(x, z) {
    const G = grille(), k = cellule(G, x, z);
    if (k < 0 || G.cls[k] >= BATI) return null;
    return G.zones[G.zone[k]] || { nom: 'sol' };
  }
  function dansVariante(G, k, v) {
    if (v.type === 'element') return G.zones[G.zone[k]]?.cle === v.cle;
    if (v.type === 'toit') return false; // sol seulement
    const x = G.x0 + ((k % G.n) + 0.5) * G.pas, z = G.z0 + (Math.floor(k / G.n) + 0.5) * G.pas;
    const loc = ([la, lo]) => { const q = app.proj.versLocal(la, lo); return [q.x, q.z]; };
    if (v.type === 'trait') return (v.points || []).some((pt) => { const [px, pz] = loc(pt); return Math.hypot(x - px, z - pz) <= v.rayon; });
    if (v.type === 'polygone') return pointDansPolygone(x, z, v.points.map(loc));
    const p = app.proj.versLocal(v.lat, v.lon);
    return Math.hypot(x - p.x, z - p.z) <= v.rayon;
  }
  const points = creerPointsChauds(app, {
    etat, note, classes: () => etat.classes, classe, soleilA, partOmbreJour, calculerTemperature, construireGrille, valeursTemperature,
    zoneSous, dansVariante, afficherEcart, titreCarte, texteLegende,
    degradeActif,
  });

  // ------------------------------------------------------------
  // Panneau
  // ------------------------------------------------------------
  function bandeau() {
    return h('p', { class: 'chaleur-bandeau', 'data-garder': '' }, h('strong', {}, 'Estimation pédagogique'), ' : ordres de grandeur (température de surface à ±5 °C au mieux) pour comparer des matériaux et des situations, pas une simulation thermique certifiée ; hypothèses et limites dans les boutons « i ».');
  }
  function infoMateriaux() {
    const refs = etat.mat?.references || [];
    return info(
      'Cartes : Matériaux = la table des classes (sans date ni ombre), colorée par classe, par échauffement (température de surface d\'équilibre de chaque matériau dans les mêmes conditions de référence) ou par albédo ; Température = température de surface estimée au jour et à l\'heure de la barre Soleil ; Écart = projet − existant de la dernière comparaison (« Comparer existant / projet »).',
      'Classes de matériaux déduites d\'OpenStreetMap (surface=*, landuse, leisure ; voirie de l\'atlas : chaussées, bandes de trottoir de 2,5 m, cheminements), complétées par l\'orthophoto IGN (végétal, sol clair) là où OSM ne dit rien, puis du sol sous les arbres et de vos corrections.',
      `Toitures : ${etat.toitures?.description || ''} Sources : ${etat.toitures?.source || ''}.`,
      etat.mat?.verification || '',
      'Albédo = part du rayonnement solaire réfléchie (0 = noir, 1 = blanc) ; émissivité = aptitude à rayonner sa chaleur en infrarouge ; effusivité = inertie (un matériau effusif se réchauffe lentement).',
      h('ol', { class: 'refs' }, ...refs.map((r) => h('li', { value: r.n }, r.texte))),
      'Valeurs moyennes de matériaux en place (vieillis) : un enrobé neuf est plus sombre, une dalle encrassée moins claire. Table modifiable dans data/chaleur/materiaux.json.',
    );
  }

  // 15/11/2026 (doublons) : trois cartes (Matériaux avec sa coloration, Température, Écart), une seule interface de correction
  // (case « Provisoire » pour les variantes), un seul bloc d'export ; les valeurs de etat.affichage ne changent pas (points de vue)
  const COLORATIONS = [['materiaux', 'Classes de matériaux'], ['echauffement', 'Échauffement (température de surface de référence)'], ['albedo', 'Albédo']];
  const estMateriaux = (a) => COLORATIONS.some(([id]) => id === a);
  function construirePanneau(conteneur) {
    ui.etat = h('p', { class: 'note', role: 'status' });
    ui.legende = h('div');
    ui.pointeur = h('p', { class: 'coordonnees' });
    ui.toits = h('input', { type: 'checkbox', checked: etat.toitsColores, onchange: () => afficher() });
    if (estMateriaux(etat.affichage)) etat.coloration = etat.affichage;
    const choixAffichage = h('div', { class: 'choix-chaleur', role: 'group', 'aria-label': 'Carte affichée' },
      ...[['materiaux', 'Matériaux'], ['temperature', 'Température de surface'], ['ecart', 'Écart']].map(([id, lib]) => h('button', {
        type: 'button', class: 'bouton discret', 'data-carte': id,
        onclick: () => {
          if (id === 'ecart' && !points.etat.ecart) return;
          etat.affichage = id === 'materiaux' ? etat.coloration : id;
          majChoix(); afficher();
        },
      }, lib)));
    ui.choix = choixAffichage;
    ui.selColoration = h('select', { 'aria-label': 'Coloration de la carte des matériaux', onchange: () => { etat.coloration = etat.affichage = ui.selColoration.value; majChoix(); afficher(); } },
      ...COLORATIONS.map(([v, l]) => h('option', { value: v }, l)));
    ui.coloration = h('label', { class: 'champ' }, h('span', {}, 'Coloration'), ui.selColoration);
    // corrections
    const selClasse = h('select', { 'aria-label': 'Matériau à appliquer', onchange: () => { etat.classeChoisie = selClasse.value; } },
      h('optgroup', { label: 'Sol' }, ...etat.classes.filter((c) => c.type === 'sol').map((c) => h('option', { value: c.id }, c.libelle))),
      h('optgroup', { label: 'Toiture (clic sur un bâtiment)' }, ...etat.classes.filter((c) => c.type === 'toit').map((c) => h('option', { value: c.id }, c.libelle))));
    selClasse.value = etat.classeChoisie;
    if (etat.modeCorrection === 'disque') etat.modeCorrection = 'pinceau'; // mode retiré le 15/11/2026
    const selMode = h('select', { 'aria-label': 'Étendue de la correction', onchange: () => { etat.modeCorrection = selMode.value; if (etat.polygone.length) { etat.polygone = []; dessinerPolygone(); } if (etat.modeCorrection !== 'pinceau') pinceau.cacher(); majCorrections(); } },
      h('option', { value: 'pinceau' }, 'Pinceau (cercle, cliquer-glisser)'),
      h('option', { value: 'element' }, 'Élément OSM sous le clic (rue, place, jardin…)'),
      h('option', { value: 'polygone' }, 'Zone dessinée (clics successifs)'));
    selMode.value = etat.modeCorrection;
    ui.diametre = h('input', { type: 'range', min: 1, max: 30, step: 1, value: etat.diametre, 'aria-label': 'Diamètre du pinceau (m)', oninput: () => pinceau.diametre(+ui.diametre.value) });
    ui.texteDiametre = h('output', { class: 'valeur' }, `${etat.diametre} m`);
    ui.rayon = h('label', { class: 'champ champ-pinceau' }, h('span', {}, 'Diamètre (m)'), ui.diametre, ui.texteDiametre);
    ui.provisoire = h('input', { type: 'checkbox', checked: etat.provisoire, onchange: () => { etat.provisoire = ui.provisoire.checked; majCorrections(); } });
    ui.notePhase = h('p', { class: 'note', 'data-garder': '' });
    ui.boutonCapture = h('button', { type: 'button', class: 'bouton', onclick: () => (etat.capture ? arreterCapture() : commencerCapture()) }, 'Corriger au clic');
    ui.terminer = h('button', { type: 'button', class: 'bouton', hidden: true, onclick: terminerPolygone }, 'Terminer la zone');
    ui.enregistrer = h('button', { type: 'button', class: 'bouton discret', onclick: enregistrer }, 'Enregistrer les corrections');
    ui.corrections = h('ul', { class: 'liste-corrections' });

    conteneur.append(
      bandeau(),
      app.meteoSource?.barre?.() ?? app.meteoSource?.bloc(), // barre « Données météo » commune (js/meteo-source.js)
      h('div', { class: 'titre-info' }, h('h3', {}, 'Carte affichée'), infoMateriaux()),
      choixAffichage,
      ui.coloration,
      h('label', { class: 'case' }, ui.toits, ' Colorer les toitures'),
      caseLissage(app),
      // rayon d'analyse commun avec Confort (js/confort.js champRayon : une valeur, événement « rayonAnalyse »)
      ...[app.confort?.champRayon?.({ outil: 'chaleur' })].filter(Boolean),
      blocResolution(app, { outil: 'chaleur', rayon }),
      ui.legende,
      ui.pointeur,
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton discret', onclick: effacerTout }, 'Effacer la carte')),
      ui.etat,
      construireSectionTemperature(),
      // bloc « Calcul : carte graphique (WebGPU) » commun avec Confort (js/confort.js app.gpu.bloc), inséré ici explicitement
      ...[app.gpu?.bloc?.()].filter(Boolean),
      points.construireSection(),
      h('div', { class: 'titre-info section-temperature' }, h('h3', {}, 'Corriger un matériau'), info(
        'Choisir le matériau, l\'étendue, puis « Corriger au clic » : au pinceau, un cercle suit la souris ; cliquer-glisser peint le matériau (diamètre de 1 à 30 m : curseur, ou molette pendant la peinture, ou Maj + molette). Ou cliquer un élément OSM (toute la rue, la place ou le jardin), ou dessiner une zone point par point (« Terminer la zone »). Un clic sur un bâtiment corrige sa toiture (choisir un matériau de toiture).',
        'Phase Existant : corrections du site réel. Phase Projet : matériaux du projet, enregistrés à part (champ phase) et appliqués seulement en phase Projet ; la comparaison existant / projet en tient compte.',
        'Case « Provisoire » : variantes à essayer, non enregistrées (perdues au rechargement), appliquées comme matériaux du projet : en phase Projet et dans « Comparer existant / projet », qui donne leur effet zone par zone.',
        'Les corrections sont enregistrées dans data/chaleur/corrections.json (coordonnées WGS84) par le serveur local de l\'atlas, sinon le fichier est téléchargé : le copier dans data/chaleur/. Les anciennes corrections en disque restent lues.')),
      h('label', { class: 'champ' }, h('span', {}, 'Matériau'), selClasse),
      h('label', { class: 'champ' }, h('span', {}, 'Étendue'), selMode),
      ui.rayon,
      h('label', { class: 'case' }, ui.provisoire, ' Provisoire (variante, non enregistrée)'),
      ui.notePhase,
      h('div', { class: 'actions' }, ui.boutonCapture, ui.terminer),
      ui.corrections,
      h('div', { class: 'actions' }, ui.enregistrer),
      points.blocExport(),
    );
    majCorrections();
    majChoix();
    afficher();
  }

  function majChoix() {
    if (estMateriaux(etat.affichage)) etat.coloration = etat.affichage;
    const carte = estMateriaux(etat.affichage) ? 'materiaux' : etat.affichage;
    ui.choix?.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('actif', b.dataset.carte === carte);
      if (b.dataset.carte === 'ecart') {
        const ok = !!points.etat.ecart;
        b.disabled = !ok;
        b.title = ok ? 'Écart projet − existant de la dernière comparaison' : 'Lancer d\'abord « Comparer existant / projet » (plus bas)';
      }
    });
    if (ui.selColoration) { ui.selColoration.value = etat.coloration; ui.coloration.hidden = carte !== 'materiaux'; }
    points.majExport?.();
  }

  async function construire(conteneur) {
    try { await charger(); } catch (e) { conteneur.append(h('p', { class: 'note', 'data-garder': '' }, `Outil Chaleur indisponible : ${e.message}.`)); return; }
    construirePanneau(conteneur);
  }

  app.on('outil', (id) => { if (id !== 'chaleur') { arreterCapture(); } });
  app.on('phase', () => majCorrections());
  app.on('resolution', () => { if (etat.grille || etat.temp) invalider(); });
  // rayon d'analyse changé (champ commun Confort / Chaleur) : grille des matériaux et température à refaire
  app.on('rayonAnalyse', () => { if (etat.grille || etat.temp) invalider(); });
  app.on('lissage', () => { if (etat.calque && etat.pose) poserTexture(...etat.pose); });
  app.on('bati', () => { if (etat.grille && !etat.suspendu) invalider(); });
  app.on('arbres', () => { if (etat.grille) invalider(); }); // arbres relevés ajoutés ou supprimés (outil Relevé)
  // source météo changée (base / EPW) : section Température refaite (journées types), journée recalculée si affichée
  app.on('meteoSource', () => {
    if (!sourcesMeteo().some(([k]) => k === etat.meteo)) etat.meteo = 'mois';
    const avait = !!etat.temp;
    etat.temp = null;
    if (ui.temp?.isConnected) ui.temp.replaceWith(construireSectionTemperature());
    if (avait && etat.affichage === 'temperature') lancerCalcul();
  });
  app.on('etat', () => { if (etat.grille) invalider(); });

  return {
    etat, charger, construire, construireGrille, afficher, effacerTout, decrire, enregistrer,
    calculerTemperature, lancerCalcul, prereglage, valeursTemperature, points, legendeAuto, degradeActif, pinceau, correctionsActives,
    classes: () => etat.classes,
  };
}
