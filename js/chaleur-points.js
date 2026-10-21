import * as THREE from 'three';
import { h, info, allerVers } from './util.js';
import { telecharger } from './donnees.js';
import { versLambert93 } from './export.js';

// Outil Chaleur, lot 3 : points chauds et frais, comparaison existant / projet et variantes de matériaux, exports.
// ESTIMATION PÉDAGOGIQUE. Créé par js/chaleur.js (api = fonctions de l'outil Chaleur).
// - Points chauds : mailles du sol au-dessus du 9e décile de la carte affichée (heure du soleil ou maximum du jour), regroupées par contiguïté
//   (au moins 16 m², contact par les côtés ou les coins), classées par température moyenne (à 0,5 °C près) puis par surface ; points frais : sous le 1er décile. Étiquettes « C1… » / « F1… » sur la maquette.
// - Variantes : matériaux de remplacement provisoires (élément OSM sous le clic ou disque), non enregistrés dans corrections.json.
// - Comparaison : existant (calque Projet masqué, sans variantes) / projet (bâti effectif avec le projet, variantes appliquées) : carte de l'écart.
// - Exports : PNG de la carte et de sa légende, CSV (zones et mailles, Lambert-93), DXF R12 calque CHALEUR (contours et textes).
const fmt = (v, d = 0) => v.toFixed(d).replace('.', ',');

export function creerPointsChauds(app, api) {
  const etat = { zones: null, variantes: [], classeVariante: 'dalles', capture: null, ecart: null, comparaison: false };
  const ui = {};

  // ------------------------------------------------------------
  // Détection
  // ------------------------------------------------------------
  function quantile(trie, q) { return trie[Math.min(trie.length - 1, Math.max(0, Math.floor(q * (trie.length - 1))))]; }
  function composantes(G, garder) {
    const vu = new Uint8Array(G.n * G.n), res = [];
    for (let k0 = 0; k0 < vu.length; k0++) {
      if (vu[k0] || !garder(k0)) continue;
      const pile = [k0], cellules = [];
      vu[k0] = 1;
      while (pile.length) {
        const k = pile.pop();
        cellules.push(k);
        const i = k % G.n, j = (k - i) / G.n;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= G.n || b >= G.n) continue;
          const q = b * G.n + a;
          if (!vu[q] && garder(q)) { vu[q] = 1; pile.push(q); }
        }
      }
      res.push(cellules);
    }
    return res;
  }
  function detecter() {
    const res = api.etat.temp, V = api.etat.valeursT;
    if (!res || !V) return null;
    const G = res.G, t = app.soleil.etat.heure, mode = api.etat.vueTemp;
    const vals = [...V.sol].filter(Number.isFinite).sort((a, b) => a - b);
    if (vals.length < 20) return null;
    const p90 = quantile(vals, 0.9), p10 = quantile(vals, 0.1);
    const min = Math.ceil(16 / (G.pas * G.pas));
    const decrire = (cellules, type) => {
      let s = 0, mx = -1e9, mn = 1e9, ombre = 0, x = 0, z = 0;
      const nb = new Map();
      for (const k of cellules) {
        const v = V.sol[k];
        s += v; mx = Math.max(mx, v); mn = Math.min(mn, v);
        const c = G.cls[k]; nb.set(c, (nb.get(c) || 0) + 1);
        const i = res.idx[k];
        ombre += mode === 'max' ? api.partOmbreJour(res, i) : (api.soleilA(res, i, t) < 0.5 ? 1 : 0);
        x += G.x0 + ((k % G.n) + 0.5) * G.pas; z += G.z0 + (Math.floor(k / G.n) + 0.5) * G.pas;
      }
      const n = cellules.length;
      x /= n; z /= n;
      // point d'étiquette : la maille de la zone la plus proche du centre
      let best = cellules[0], dmin = Infinity;
      for (const k of cellules) { const cx = G.x0 + ((k % G.n) + 0.5) * G.pas, cz = G.z0 + (Math.floor(k / G.n) + 0.5) * G.pas, d = (cx - x) ** 2 + (cz - z) ** 2; if (d < dmin) { dmin = d; best = k; } }
      const dom = [...nb.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return {
        type, cellules, surface: n * G.pas * G.pas, tmoy: s / n, tmax: mx, tmin: mn, ombre: ombre / n,
        materiau: api.classes()[dom].libelle, x: G.x0 + ((best % G.n) + 0.5) * G.pas, z: G.z0 + (Math.floor(best / G.n) + 0.5) * G.pas,
      };
    };
    const chauds = composantes(G, (k) => V.sol[k] >= p90).filter((c) => c.length >= min).map((c) => decrire(c, 'chaud')).sort((a, b) => Math.round(b.tmoy * 2) - Math.round(a.tmoy * 2) || b.surface - a.surface).slice(0, 6);
    const frais = composantes(G, (k) => V.sol[k] <= p10).filter((c) => c.length >= min).map((c) => decrire(c, 'frais')).sort((a, b) => Math.round(a.tmoy * 2) - Math.round(b.tmoy * 2) || b.surface - a.surface).slice(0, 4);
    chauds.forEach((z, i) => { z.code = `C${i + 1}`; });
    frais.forEach((z, i) => { z.code = `F${i + 1}`; });
    return { G, chauds, frais, p90, p10, t, mode, d: res.d };
  }

  function etiqueter(Z) {
    app.etiquettes.retirerGroupe('chaleur');
    if (!Z) return;
    for (const z of [...Z.chauds, ...Z.frais]) {
      app.etiquettes.ajouter({ texte: `${z.code} ${fmt(z.tmoy)} °C`, position: new THREE.Vector3(z.x, 1.2, z.z), classe: `etiquette-chaleur ${z.type}`, groupe: 'chaleur', toujours: true, distanceMax: 3000 });
    }
  }

  function reperer() {
    const Z = detecter();
    etat.zones = Z;
    etiqueter(Z);
    majListe();
    if (!Z) api.note('Calculez d\'abord une carte de température.');
  }

  function majListe() {
    if (!ui.liste) return;
    const Z = etat.zones;
    if (!Z) { ui.liste.replaceChildren(); return; }
    const ligne = (z) => h('li', { class: z.type },
      h('b', {}, z.code),
      h('span', {}, `${fmt(z.tmoy)} °C en moyenne (max ${fmt(z.tmax)} °C) · ${Math.round(z.surface)} m²`,
        h('em', {}, `${z.materiau} · ${Z.mode === 'max' ? 'ombre sur la journée' : 'à l\'ombre'} : ${Math.round(z.ombre * 100)} %`)),
      h('button', { type: 'button', class: 'mini', title: 'Aller à la zone', 'aria-label': `Aller à la zone ${z.code}`, onclick: () => allerVers(app, [z.x, 70, z.z + 60], [z.x, 0, z.z], 1200) }, '→'));
    ui.liste.replaceChildren(
      h('li', { class: 'vide' }, `Les plus chaudes (au-dessus de ${fmt(Z.p90)} °C, 9e décile) :`), ...Z.chauds.map(ligne),
      h('li', { class: 'vide' }, `Les plus fraîches (sous ${fmt(Z.p10)} °C, 1er décile) :`), ...Z.frais.map(ligne));
  }

  // ------------------------------------------------------------
  // Variantes et comparaison existant / projet
  // ------------------------------------------------------------
  function clicVariante(p) {
    if (!p) return;
    const z = api.zoneSous(p[0], p[1]);
    if (!z) { app.signaler('Cliquez sur le sol libre du cercle d\'analyse.'); return; }
    const g = app.proj.versGeo(p[0], p[1]);
    const v = z.cle
      ? { type: 'element', cle: z.cle, nom: z.nom, classe: etat.classeVariante }
      : { type: 'disque', lat: g.lat, lon: g.lon, rayon: 6, nom: 'disque de 6 m', classe: etat.classeVariante };
    etat.variantes = etat.variantes.filter((x) => !(x.cle && x.cle === v.cle)).concat([v]);
    app.signaler(`Variante : ${v.nom} en ${api.classe(v.classe).libelle.toLowerCase()}.`);
    majVariantes();
  }
  function basculerCapture() {
    if (etat.capture) { arreterCapture(); return; }
    etat.capture = (p) => clicVariante(p);
    app.captureSol = etat.capture;
    majVariantes();
  }
  function arreterCapture() {
    if (etat.capture && app.captureSol === etat.capture) app.captureSol = null;
    etat.capture = null;
    majVariantes();
  }
  function majVariantes() {
    if (!ui.variantes) return;
    ui.boutonVariante.textContent = etat.capture ? 'Arrêter' : 'Choisir des zones au clic';
    ui.boutonVariante.classList.toggle('actif', !!etat.capture);
    ui.variantes.replaceChildren(...(etat.variantes.length ? etat.variantes.map((v) => h('li', {},
      h('i', { style: { background: api.classe(v.classe).couleur } }),
      h('span', {}, `${v.nom} → ${api.classe(v.classe).libelle}`),
      h('button', { type: 'button', class: 'mini', title: 'Retirer', 'aria-label': 'Retirer la variante', onclick: () => { etat.variantes = etat.variantes.filter((x) => x !== v); majVariantes(); } }, '×')))
      : [h('li', { class: 'vide' }, 'Aucune variante : la comparaison porte sur le bâti du projet seul.')]));
  }

  async function comparer() {
    if (etat.comparaison) return;
    etat.comparaison = true;
    ui.boutonComparer.disabled = true;
    const projet = app.projet;
    const visible0 = projet?.visible;
    const aProjet = !!projet && (projet.formesVisibles?.().length || projet.etat?.demolis?.size || app.imports?.nombre?.());
    api.etat.suspendu = true; // les événements « bati » de la bascule ne relancent pas l'outil
    try {
      api.note('Comparaison : état existant…');
      if (aProjet) projet.definirVisible(false);
      const A = await api.calculerTemperature({ grilleMat: api.construireGrille(), garder: false });
      api.note('Comparaison : projet et variantes…');
      if (aProjet) projet.definirVisible(true);
      const B = await api.calculerTemperature({ grilleMat: api.construireGrille({ corrections: [...api.etat.corrections, ...etat.variantes] }), garder: false });
      const t = app.soleil.etat.heure, mode = api.etat.vueTemp;
      const VA = api.valeursTemperature(A, t, mode), VB = api.valeursTemperature(B, t, mode);
      const N = VA.sol.length, D = new Float32Array(N).fill(NaN);
      let s = 0, n = 0, bati = 0, libere = 0;
      for (let k = 0; k < N; k++) {
        const a = VA.sol[k], b = VB.sol[k];
        if (Number.isFinite(a) && Number.isFinite(b)) { D[k] = b - a; s += D[k]; n++; } else if (Number.isFinite(a)) bati++; else if (Number.isFinite(b)) libere++;
      }
      // effet des variantes, zone par zone
      const parVar = etat.variantes.map((v) => {
        const G1 = B.G;
        const cells = [];
        for (let k = 0; k < N; k++) if (Number.isFinite(D[k]) && api.dansVariante(G1, k, v)) cells.push(k);
        const moy = (V) => cells.reduce((x, k) => x + V.sol[k], 0) / Math.max(cells.length, 1);
        return { v, n: cells.length, avant: moy(VA), apres: moy(VB) };
      });
      etat.ecart = { D, A, B, G: B.G, moy: n ? s / n : 0, bati, libere, parVar, t, mode, aProjet };
      api.afficherEcart(etat.ecart);
      majEcart();
      api.note('');
    } catch (e) {
      api.note(`Comparaison impossible : ${e.message}`);
      console.warn(e);
    } finally {
      if (aProjet && projet.visible !== visible0) projet.definirVisible(visible0);
      if (aProjet) api.etat.grille = null; // bâti reconstruit : grille des matériaux à refaire au prochain affichage
      setTimeout(() => { api.etat.suspendu = false; }, 400); // après l'événement « bati » différé de projet.js
      etat.comparaison = false;
      ui.boutonComparer.disabled = false;
    }
  }
  function majEcart() {
    const E = etat.ecart;
    if (!ui.ecart || !E) return;
    const m2 = E.G.pas * E.G.pas;
    const quand = E.mode === 'max' ? 'maximum de la journée' : `à ${String(E.t).replace('.', ',')} h`;
    ui.ecart.replaceChildren(
      h('p', { class: 'resultat' }, `Projet − existant (${quand}) : ${E.moy >= 0 ? '+' : ''}${fmt(E.moy, 1)} °C en moyenne sur le sol commun${E.aProjet ? '' : ' (aucun volume ni démolition dans le projet : seules les variantes changent)'} ; ${Math.round(E.bati * m2)} m² de sol bâtis par le projet, ${Math.round(E.libere * m2)} m² libérés.`),
      ...E.parVar.filter((x) => x.n).map((x) => h('p', { class: 'resultat' }, `${x.v.nom} → ${api.classe(x.v.classe).libelle.toLowerCase()} : ${fmt(x.avant, 1)} → ${fmt(x.apres, 1)} °C (${x.apres - x.avant >= 0 ? '+' : ''}${fmt(x.apres - x.avant, 1)} °C sur ${Math.round(x.n * m2)} m²).`)),
      h('div', { class: 'legende-soleil' }, h('span', {}, '−10 °C'), h('i', { style: { background: 'linear-gradient(90deg, rgb(33,102,172), rgb(146,197,222) 35%, rgb(247,247,247) 50%, rgb(244,165,130) 65%, rgb(178,24,43))' } }), h('span', {}, '+10 °C')));
  }

  // ------------------------------------------------------------
  // Exports
  // ------------------------------------------------------------
  const horodatage = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  function exporterPNG() {
    const tex = api.etat.calque?.material?.map;
    if (!tex) { app.signaler('Aucune carte affichée.'); return; }
    const { data, width: n } = tex.image;
    const echelle = Math.max(2, Math.floor(900 / n));
    const marge = 150;
    const c = document.createElement('canvas');
    c.width = n * echelle; c.height = n * echelle + marge;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    const img = new ImageData(new Uint8ClampedArray(data.buffer.slice(0)), n, n);
    const tmp = document.createElement('canvas'); tmp.width = n; tmp.height = n;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, n * echelle, n * echelle);
    // étiquettes des zones
    const G = api.etat.temp?.G || etat.zones?.G;
    if (etat.zones && G) {
      ctx.font = 'bold 13px sans-serif';
      for (const z of [...etat.zones.chauds, ...etat.zones.frais]) {
        const px = ((z.x - G.x0) / G.pas) * echelle, py = ((z.z - G.z0) / G.pas) * echelle;
        ctx.fillStyle = z.type === 'chaud' ? '#b2182b' : '#2166ac';
        ctx.fillRect(px - 4, py - 15, ctx.measureText(z.code).width + 8, 18);
        ctx.fillStyle = '#fff'; ctx.fillText(z.code, px, py);
      }
    }
    const y0 = n * echelle;
    ctx.fillStyle = '#2f3b45'; ctx.font = 'bold 15px sans-serif';
    ctx.fillText(`Atlas de l'Hôtel de Ville — outil Chaleur : ${api.titreCarte()}`, 12, y0 + 24);
    ctx.font = '13px sans-serif';
    const lignes = api.texteLegende().split('\n');
    lignes.slice(0, 4).forEach((l, i) => ctx.fillText(l.slice(0, 150), 12, y0 + 46 + i * 18));
    ctx.fillStyle = '#a5281b'; ctx.font = 'bold 13px sans-serif';
    ctx.fillText('ESTIMATION PÉDAGOGIQUE — ordres de grandeur, pas une simulation certifiée. Nord en haut.', 12, y0 + marge - 14);
    c.toBlob((b) => telecharger(`atlas-chaleur-${horodatage()}.png`, b, 'image/png'), 'image/png');
  }

  const l93 = (x, z) => { const g = app.proj.versGeo(x, z); return versLambert93(g.lat, g.lon); };
  function exporterCSV() {
    const Z = etat.zones;
    const res = api.etat.temp, V = api.etat.valeursT;
    if (!res || !V) { app.signaler('Calculez d\'abord une carte de température.'); return; }
    const L = ['# Atlas de l\'Hôtel de Ville, outil Chaleur — ESTIMATION PÉDAGOGIQUE (ordres de grandeur, pas une simulation certifiée)',
      `# ${api.titreCarte()} ; coordonnées Lambert-93 (EPSG:2154) ; séparateur ;`,
      'type;code;x_l93;y_l93;surface_m2;t_moy_c;t_max_c;materiau_dominant;part_ombre_pct'];
    for (const z of Z ? [...Z.chauds, ...Z.frais] : []) {
      const [X, Y] = l93(z.x, z.z);
      L.push([z.type, z.code, X.toFixed(1), Y.toFixed(1), Math.round(z.surface), fmt(z.tmoy, 1), fmt(z.tmax, 1), z.materiau, Math.round(z.ombre * 100)].join(';'));
    }
    L.push('', 'maille;x_l93;y_l93;materiau;albedo;t_c;t_max_jour_c');
    const G = res.G, cl = api.classes();
    for (let i = 0; i < res.P.nSol; i++) {
      const k = res.P.k[i];
      const [X, Y] = l93(res.P.x[i], res.P.z[i]);
      L.push([k, X.toFixed(1), Y.toFixed(1), cl[G.cls[k]].libelle, fmt(cl[G.cls[k]].albedo, 2), fmt(V.sol[k], 1), fmt(res.R.Tmax[i], 1)].join(';'));
    }
    telecharger(`atlas-chaleur-${horodatage()}.csv`, `﻿${L.join('\r\n')}`, 'text/csv');
  }

  // DXF R12, calque CHALEUR : contour des mailles de chaque zone (bandes par ligne) et texte
  function exporterDXF() {
    const Z = etat.zones;
    if (!Z) { app.signaler('Repérez d\'abord les points chauds.'); return; }
    const out = [];
    const g = (c, v) => out.push(String(c), String(v));
    const asc = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?');
    g(999, asc('Atlas de l\'Hotel de Ville, outil Chaleur : points chauds et frais (ESTIMATION PEDAGOGIQUE), Lambert-93 EPSG:2154'));
    g(0, 'SECTION'); g(2, 'TABLES'); g(0, 'TABLE'); g(2, 'LAYER'); g(70, 1);
    g(0, 'LAYER'); g(2, 'CHALEUR'); g(70, 0); g(62, 1); g(6, 'CONTINUOUS');
    g(0, 'ENDTAB'); g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'ENTITIES');
    const G = Z.G;
    const poly = (pts) => {
      g(0, 'POLYLINE'); g(8, 'CHALEUR'); g(66, 1); g(70, 1); g(10, 0); g(20, 0); g(30, 0);
      for (const [x, z] of pts) { const [X, Y] = l93(x, z); g(0, 'VERTEX'); g(8, 'CHALEUR'); g(10, X.toFixed(3)); g(20, Y.toFixed(3)); g(30, 0); }
      g(0, 'SEQEND'); g(8, 'CHALEUR');
    };
    for (const zz of [...Z.chauds, ...Z.frais]) {
      const set = new Set(zz.cellules);
      for (let j = 0; j < G.n; j++) {
        let i0 = -1;
        for (let i = 0; i <= G.n; i++) {
          const dedans = i < G.n && set.has(j * G.n + i);
          if (dedans && i0 < 0) i0 = i;
          if (!dedans && i0 >= 0) {
            const xa = G.x0 + i0 * G.pas, xb = G.x0 + i * G.pas, za = G.z0 + j * G.pas, zb = za + G.pas;
            poly([[xa, za], [xb, za], [xb, zb], [xa, zb]]);
            i0 = -1;
          }
        }
      }
      const [X, Y] = l93(zz.x, zz.z);
      g(0, 'TEXT'); g(8, 'CHALEUR'); g(10, X.toFixed(3)); g(20, Y.toFixed(3)); g(30, 0); g(40, 1.5);
      g(1, asc(`${zz.code} ${fmt(zz.tmoy)} C ${Math.round(zz.surface)} m2 ${zz.materiau}`));
    }
    g(0, 'ENDSEC'); g(0, 'EOF');
    telecharger(`atlas-chaleur-${horodatage()}.dxf`, out.join('\r\n'), 'application/dxf');
  }

  // ------------------------------------------------------------
  // Panneau (section ajoutée par chaleur.js)
  // ------------------------------------------------------------
  function construireSection() {
    ui.liste = h('ul', { class: 'liste-chauds' });
    ui.variantes = h('ul', { class: 'liste-corrections' });
    ui.ecart = h('div');
    const selVar = h('select', { 'aria-label': 'Matériau de la variante', onchange: () => { etat.classeVariante = selVar.value; } },
      ...api.classes().filter((c) => c.type === 'sol').map((c) => h('option', { value: c.id }, c.libelle)));
    selVar.value = etat.classeVariante;
    ui.boutonVariante = h('button', { type: 'button', class: 'bouton discret', onclick: basculerCapture }, 'Choisir des zones au clic');
    ui.boutonComparer = h('button', { type: 'button', class: 'bouton', onclick: comparer }, 'Comparer existant / projet');
    const section = h('div', { class: 'section-temperature' },
      h('div', { class: 'titre-info' }, h('h3', {}, 'Points chauds et frais'), info(
        'Sur la carte de température affichée (heure du soleil ou maximum de la journée) : mailles du sol au-dessus du 9e décile (points chauds) ou sous le 1er décile (points frais), regroupées quand elles se touchent (16 m² au moins), classées par température moyenne (à 0,5 °C près) puis par surface. Pour chaque zone : surface, températures moyenne et maximale, matériau dominant, part d\'ombre (à l\'heure choisie, ou sur la journée de 9 h à 19 h pour le maximum).',
        'Exports : PNG de la carte (nord en haut) avec les codes des zones ; CSV des zones et de toutes les mailles (Lambert-93) ; DXF R12, calque CHALEUR (contours des zones par bandes de mailles et textes), à superposer au plan DXF de l\'onglet Export.')),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton', onclick: reperer }, 'Repérer les points chauds et frais'),
        h('button', { type: 'button', class: 'bouton discret', onclick: () => { etat.zones = null; etiqueter(null); majListe(); } }, 'Effacer les repères')),
      ui.liste,
      h('div', { class: 'titre-info' }, h('h3', {}, 'Comparer : existant, projet, variantes'), info(
        'Existant : calque Projet masqué (bâti actuel), matériaux corrigés. Projet : bâti effectif (volumes ajoutés, démolitions, imports) et variantes de matériaux ci-dessous, provisoires (non enregistrées). Même jour, même heure, même météo. La carte montre l\'écart projet − existant (bleu : plus frais).',
        'Les nouveaux volumes changent les ombres et l\'ouverture au ciel ; un matériau plus clair ou végétal baisse la température de surface. Ordres de grandeur seulement.')),
      h('label', { class: 'champ' }, h('span', {}, 'Matériau de remplacement'), selVar),
      h('div', { class: 'actions' }, ui.boutonVariante),
      ui.variantes,
      h('div', { class: 'actions' }, ui.boutonComparer),
      ui.ecart,
      h('div', { class: 'titre-info' }, h('h3', {}, 'Exporter la carte')),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton discret', onclick: exporterPNG }, 'PNG'),
        h('button', { type: 'button', class: 'bouton discret', onclick: exporterCSV }, 'CSV'),
        h('button', { type: 'button', class: 'bouton discret', onclick: exporterDXF }, 'DXF (calque CHALEUR)')));
    majListe(); majVariantes(); majEcart();
    return section;
  }

  app.on('outil', (id) => { if (id !== 'chaleur') arreterCapture(); });

  return {
    etat, construireSection, reperer, comparer, exporterPNG, exporterCSV, exporterDXF, arreterCapture,
    effacer() { etat.zones = null; etiqueter(null); majListe(); },
  };
}