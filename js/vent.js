import * as THREE from 'three';
import { h, allerVers, info } from './util.js';
import {
  chargerMeteo, rose, normales, depassementsParMetre, mention, avertissement, libelleSaison, libelleTemperature, annee,
  SAISONS, TEMPERATURES, NOMS16, MOIS,
} from './meteo.js';
import { lignesLocales } from './geo.js';
import { geometriesPlates, visibiliteBatiment } from './maquette.js';
import {
  HALF, versCalcul, versAtlas, TYPES_EFFETS, preparerBatiments, creerGrille, creerSolveur, detecterEffets,
  NC, CH, CHALF, CLASSES_CONFORT, classeConfort, rapportsSecteurs, probabilitesDepassement,
} from './vent-calcul.js';

const SEUILS = [[3, '3 m/s (pour comparer les lieux)'], [4, '4 m/s (rester assis)'], [5, '5 m/s (usage courant, NEN 8100)'], [8, '8 m/s (marche rapide)']];
const NOMS12 = ['N', 'NNE', 'ENE', 'E', 'ESE', 'SSE', 'S', 'SSO', 'OSO', 'O', 'ONO', 'NNO']; // secteurs de 30° centrés sur k × 30°
const SAISONS4 = [['hiver', 'Hiver', [11, 0, 1]], ['printemps', 'Printemps', [2, 3, 4]], ['ete', 'Été', [5, 6, 7]], ['automne', 'Automne', [8, 9, 10]]];
const COULEURS_VENT = ['#b7cbd9', '#6f93b1', '#2f4f6f']; // comme la rose de l'outil Climat
const HISTO = 8; // positions gardées par particule (traînée)
const MAX = 8000; // particules au plus
const TEMPS = 12; // accélération de l'animation (comme la page d'origine)
const HAUTEUR = 1.5; // hauteur des particules (m) : hauteur de piéton
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...enfants) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  enfants.forEach((e) => el.append(e instanceof Node ? e : document.createTextNode(String(e))));
  return el;
};
const nombre = (v, d = 1) => (v == null ? '–' : v.toFixed(d).replace('.', ','));
const borneVitesse = (v) => Math.max(1, Math.min(15, Math.round((v || 1) * 2) / 2));
const secteur12 = (dir) => Math.round(dir / 30) % 12;
const minuscule = (t) => t.replace(/^./, (c) => c.toLowerCase());
const couleurRapport = (c, rapport) => {
  const q = Math.max(0, Math.min(1, (rapport - 0.15) / 1.6)); // abrité (bleu) -> accéléré (rouge)
  return c.setHSL((210 - q * 190) / 360, 0.95, 0.42);
};

// Outil Vent : écoulement simplifié autour du bâti de l'atlas, particules animées à hauteur de piéton,
// confort au vent (fréquences Météo-France) et phénomènes aérodynamiques.
// Panneau dans l'ordre d'usage : rose cliquable (période, température, vent moyen ou fort), saisons, mois,
// direction et vitesse, vues rapides, particules, confort (avec ou sans le projet), phénomènes.
// Tout ce qui est posé sur la maquette est retiré (et libéré) à la fermeture du panneau.
export function creerVent(app) {
  const etat = {
    direction: 240, vitesse: 4, densite: 4000, pause: false, actif: false,
    saison: 'annee', temperature: 'all', modeVitesse: 'moyen', mois: new Date().getMonth(),
    seuil: 4, confort: false, roseMaquette: false, effetsVisibles: Object.fromEntries(TYPES_EFFETS.map((t) => [t.t, true])),
    grille: null, cleGrille: null, solveur: null, entree: null, effets: null, R: null, P: null, calculEnCours: false,
  };
  const ui = {};
  const bilans = new Map(); // parts des classes de confort, par « avec/sans projet | saison | seuil »
  const cacheGrilles = new Map(); // grilles déjà calculées (bascule avec / sans le projet sans tout refaire)
  let mf = null; // données Météo-France (data/meteo/meteo.json, lues par js/meteo.js)
  let objets = null; // objets Three.js (créés à l'ouverture, détruits à la fermeture)
  const rayonParticules = () => Math.min(300, app.config.rayonEtude, HALF - 20);

  async function chargerMF() {
    if (mf === null) mf = (await chargerMeteo()) || false;
    return mf || null;
  }

  // ---------------------------------------------------------------
  // Bâti de l'atlas -> grille du calcul
  // ---------------------------------------------------------------
  function preparerGrille() {
    // bâti effectif : existant non démoli + volumes du projet (js/projet.js)
    const effectif = app.batiEffectif?.() ?? app.empreintes ?? [];
    const vue = { ...app, vueMaquette: false };
    // bâti visible à l'époque affichée ; les volumes surélevés (base > 2,5 m, porches, auvents) laissent passer le vent
    const empreintes = effectif.filter((e) => visibiliteBatiment(vue, e.cle) && (e.base ?? 0) <= 2.5
      && Math.hypot(e.cx, e.cz) <= HALF * Math.SQRT2 + 40);
    // signature du bâti retenu : la même configuration retrouve sa grille (et ses rapports de confort)
    let somme = 0;
    for (const e of empreintes) somme += e.cx * 1.37 + e.cz * 0.71 + e.hauteur * 3.1;
    const cle = `${app.etat}|${empreintes.length}|${somme.toFixed(1)}`;
    if (etat.grille && etat.cleGrille === cle) return etat.grille;
    let entree = cacheGrilles.get(cle);
    if (!entree) {
      const grille = creerGrille(preparerBatiments(empreintes));
      entree = { grille, solveur: creerSolveur(grille), R: null };
      cacheGrilles.set(cle, entree);
      if (cacheGrilles.size > 3) cacheGrilles.delete(cacheGrilles.keys().next().value);
    }
    Object.assign(etat, { grille: entree.grille, solveur: entree.solveur, R: entree.R, P: null, entree, cleGrille: cle });
    return etat.grille;
  }

  function passages() {
    const res = [];
    for (const f of app.donnees.osm?.voirie?.features || []) {
      const p = f.properties || {};
      if (p.tunnel !== 'building_passage' && p.covered !== 'yes') continue;
      for (const l of lignesLocales(f.geometry, app.proj)) if (l.length >= 2) res.push(l.map(versCalcul));
    }
    return res;
  }

  // Calcul du champ et des phénomènes pour la direction et la vitesse choisies
  function calculerChamp() {
    const g = preparerGrille();
    etat.solveur.resoudre(etat.direction, etat.vitesse);
    etat.effets = detecterEffets(g, etat.solveur, etat.direction, etat.vitesse, { rayon: rayonParticules(), passages: passages() });
    if (objets) { reinitialiserParticules(); dessinerEffets(); }
    majEffetsUI();
  }

  let minuterieCalcul = 0;
  function recalculer() {
    clearTimeout(minuterieCalcul);
    note('Calcul de l\'écoulement…');
    minuterieCalcul = setTimeout(() => {
      if (!etat.actif) return;
      if (etat.calculEnCours) { recalculer(); return; }
      const t0 = performance.now();
      calculerChamp();
      note(`Écoulement calculé en ${Math.round(performance.now() - t0)} ms (${etat.grille.batiments.length} bâtiments).`);
    }, 30);
  }

  // ---------------------------------------------------------------
  // Objets Three.js
  // ---------------------------------------------------------------
  function creerObjets() {
    const groupe = new THREE.Group();
    groupe.name = 'vent';
    // particules : segments (traînée de HISTO positions), couleur RGBA par sommet
    const nbSeg = MAX * (HISTO - 1);
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(nbSeg * 2 * 3);
    const col = new Float32Array(nbSeg * 2 * 4);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const lignes = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    lignes.frustumCulled = false;
    lignes.renderOrder = 11;
    lignes.raycast = () => {};
    lignes.userData.pasDeRelief = true; // posées sur le relief à chaque image
    groupe.add(lignes);
    const effets = new THREE.Group();
    effets.name = 'vent-effets';
    groupe.add(effets);
    // flèche de direction, au vent du cercle des particules, pointée vers où va le vent
    const forme = new THREE.Shape([[0, 26], [15, 2], [5, 6], [5, -24], [-5, -24], [-5, 6], [-15, 2]].map(([x, y]) => new THREE.Vector2(x, y)));
    const fleche = new THREE.Mesh(new THREE.ShapeGeometry(forme).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: COULEURS_VENT[2], transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
    fleche.name = 'vent-fleche';
    fleche.renderOrder = 12;
    fleche.raycast = () => {};
    fleche.userData.pasDeRelief = true;
    groupe.add(fleche);
    app.scene.add(groupe);
    const posEtiquette = new THREE.Vector3();
    const etiquette = app.etiquettes.ajouter({ texte: '', position: posEtiquette, classe: 'etiquette-vent etiquette-fleche-vent', groupe: 'vent-fleche', distanceMax: 3000, centre: true });
    objets = {
      groupe, lignes, effets, fleche, etiquette, posEtiquette, confort: null,
      x: new Float32Array(MAX), y: new Float32Array(MAX), age: new Float32Array(MAX), vie: new Float32Array(MAX),
      hx: new Float32Array(MAX * HISTO), hz: new Float32Array(MAX * HISTO), rapport: new Float32Array(MAX),
    };
    majFleche();
  }

  // flèche sur la maquette : direction de la bascule (repère atlas : x est, z sud)
  function majFleche() {
    if (!objets) return;
    const a = THREE.MathUtils.degToRad(etat.direction), r = rayonParticules() + 34;
    const x = Math.sin(a) * r, z = -Math.cos(a) * r;
    const dz = app.relief?.actif ? app.relief.dz(x, z) : 0;
    objets.fleche.position.set(x, 2.2 + dz, z);
    objets.fleche.rotation.y = -THREE.MathUtils.degToRad(etat.direction + 180);
    const re = r + 32;
    objets.posEtiquette.set(Math.sin(a) * re, 2, -Math.cos(a) * re);
    objets.etiquette.el.textContent = `Vent ${texteDirection()}, ${nombre(etat.vitesse)} m/s`;
  }

  function libererObjet(o) {
    o.traverse((x) => {
      x.geometry?.dispose();
      const mats = Array.isArray(x.material) ? x.material : x.material ? [x.material] : [];
      for (const m of mats) { m.map?.dispose(); m.dispose(); }
    });
  }

  function detruireObjets() {
    if (!objets) return;
    app.scene.remove(objets.groupe);
    libererObjet(objets.groupe);
    app.etiquettes.retirerGroupe('vent');
    app.etiquettes.retirerGroupe('vent-fleche');
    objets = null;
  }

  // ---------------------------------------------------------------
  // Particules (repère du calcul : x est, y nord)
  // ---------------------------------------------------------------
  const out = [0, 0];
  function bloque(x, y) { return etat.grille ? etat.grille.estPlein(x, y) : true; }

  function placer(i) {
    const R = rayonParticules(), o = objets;
    for (let t = 0; t < 12; t++) {
      const r = R * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
      const x = r * Math.cos(a), y = r * Math.sin(a);
      if (!bloque(x, y)) { o.x[i] = x; o.y[i] = y; break; }
    }
    o.age[i] = 0;
    o.vie[i] = 90 + Math.random() * 120;
    for (let m = 0; m < HISTO; m++) { o.hx[i * HISTO + m] = o.x[i]; o.hz[i * HISTO + m] = -o.y[i]; }
  }

  function reinitialiserParticules() {
    if (!objets) return;
    for (let i = 0; i < MAX; i++) { placer(i); objets.age[i] = Math.random() * objets.vie[i]; }
  }

  const coul = new THREE.Color();
  function majParticules(dt) {
    const o = objets;
    if (!o || !etat.grille) return;
    const R2 = rayonParticules() ** 2, n = Math.min(etat.densite, MAX);
    const sv = etat.solveur;
    if (!etat.pause) {
      for (let i = 0; i < n; i++) {
        if (!sv.echantillon(o.x[i], o.y[i], out)) { placer(i); continue; }
        o.x[i] += out[0] * dt * TEMPS;
        o.y[i] += out[1] * dt * TEMPS;
        o.age[i] += 1;
        if (o.age[i] > o.vie[i] || o.x[i] * o.x[i] + o.y[i] * o.y[i] > R2 || bloque(o.x[i], o.y[i])) { placer(i); continue; }
        sv.echantillon(o.x[i], o.y[i], out);
        o.rapport[i] = Math.hypot(out[0], out[1]) / etat.vitesse;
        // décalage de la traînée
        const b = i * HISTO;
        for (let m = HISTO - 1; m > 0; m--) { o.hx[b + m] = o.hx[b + m - 1]; o.hz[b + m] = o.hz[b + m - 1]; }
        o.hx[b] = o.x[i];
        o.hz[b] = -o.y[i];
      }
    }
    // géométrie : HISTO - 1 segments par particule, de plus en plus transparents
    const pos = o.lignes.geometry.getAttribute('position'), col = o.lignes.geometry.getAttribute('color');
    const P = pos.array, C = col.array;
    const relief = app.relief?.actif;
    let v = 0;
    for (let i = 0; i < n; i++) {
      couleurRapport(coul, o.rapport[i] || 1);
      const b = i * HISTO;
      for (let m = 0; m < HISTO - 1; m++) {
        const a0 = 1 - m / (HISTO - 1), a1 = 1 - (m + 1) / (HISTO - 1);
        for (const [q, a] of [[m, a0], [m + 1, a1]]) {
          const x = o.hx[b + q], z = o.hz[b + q];
          P[v * 3] = x; P[v * 3 + 1] = HAUTEUR + (relief ? app.relief.dz(x, z) : 0); P[v * 3 + 2] = z;
          C[v * 4] = coul.r; C[v * 4 + 1] = coul.g; C[v * 4 + 2] = coul.b; C[v * 4 + 3] = a * 0.95;
          v++;
        }
      }
    }
    o.lignes.geometry.setDrawRange(0, v);
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  // ---------------------------------------------------------------
  // Phénomènes : zones au sol et étiquettes
  // ---------------------------------------------------------------
  function dessinerEffets() {
    if (!objets) return;
    libererObjet(objets.effets);
    objets.effets.clear();
    app.etiquettes.retirerGroupe('vent');
    if (!etat.effets) return;
    for (const it of etat.effets.items) {
      const type = TYPES_EFFETS[it.t - 1];
      const polys = it.polys.map((p) => [p.map(versAtlas)]);
      const mat = new THREE.MeshBasicMaterial({ color: type.couleur, transparent: true, opacity: 0.38, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -13, polygonOffsetUnits: -13 });
      for (const g of geometriesPlates(polys, 0.38)) {
        const m = new THREE.Mesh(g, mat);
        m.renderOrder = 7;
        m.raycast = () => {};
        m.userData.typeVent = it.t;
        m.visible = etat.effetsVisibles[it.t];
        objets.effets.add(m);
      }
      const [x, z] = versAtlas([it.x, it.y]);
      const e = app.etiquettes.ajouter({ texte: type.nom, position: new THREE.Vector3(x, 2.5, z), classe: 'etiquette-vent', groupe: 'vent', distanceMax: 700, visibleSi: () => etat.effetsVisibles[it.t] });
      e.el.style.borderColor = type.couleur;
      e.el.style.boxShadow = `inset 3px 0 0 ${type.couleur}`;
    }
  }

  function majVisibiliteEffets() {
    objets?.effets.children.forEach((m) => { m.visible = etat.effetsVisibles[m.userData.typeVent]; });
  }

  // ---------------------------------------------------------------
  // Carte de confort au vent (Météo-France)
  // ---------------------------------------------------------------
  // dépassements par secteur de 30° pour la période choisie (meteo.json ne les découpe pas par température)
  const jeuDepassements = () => (mf ? depassementsParMetre(12, etat.saison) : null);
  const avecProjet = () => app.projet?.visible !== false;
  const projetVide = () => !app.projet || (!app.projet.etat.demolis.size && !app.projet.etat.formes.some((f) => f.vis));

  async function calculerConfort() {
    if (!await chargerMF()) { noteConfort(mention()); return; }
    const S = jeuDepassements();
    if (!S || avertissement(S.N)) { effacerConfort(); noteConfort(avertissement(S?.N ?? 0, 'cette saison') ?? 'Trop peu de mesures.'); return; }
    preparerGrille();
    if (!etat.R) {
      const entree = etat.entree;
      etat.calculEnCours = true;
      try {
        etat.R = await rapportsSecteurs(etat.grille, { journal: noteConfort });
        if (entree) entree.R = etat.R;
      } finally { etat.calculEnCours = false; }
    }
    etat.P = probabilitesDepassement(etat.grille, etat.R, S, etat.seuil);
    afficherConfort();
  }

  function afficherConfort() {
    if (!objets || !etat.P || !etat.confort) return;
    const px = new Uint8Array(NC * NC * 4);
    const R2 = CHALF * CHALF;
    const parts = [0, 0, 0, 0, 0];
    const classes = new Int8Array(NC * NC).fill(-1); // classe par maille (comparaison avec / sans le projet)
    let total = 0;
    for (let j = 0; j < NC; j++) for (let i = 0; i < NC; i++) {
      const k = j * NC + i, p = etat.P[k];
      const x = -CHALF + (i + 0.5) * CH, z = -CHALF + (j + 0.5) * CH;
      if (p < 0 || x * x + z * z > R2) continue;
      const c = classeConfort(p);
      classes[k] = c;
      px.set([...CLASSES_CONFORT[c].c, 175], k * 4);
      if (x * x + z * z <= rayonParticules() ** 2) { parts[c]++; total++; }
    }
    if (!objets.confort) {
      const tex = new THREE.DataTexture(px, NC, NC, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.NearestFilter;
      tex.needsUpdate = true;
      const geo = new THREE.PlaneGeometry(2 * CHALF, 2 * CHALF).rotateX(-Math.PI / 2);
      // la ligne 0 de la texture est au nord (z minimal)
      const uv = geo.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -11, polygonOffsetUnits: -11 }));
      m.position.y = 0.33;
      m.renderOrder = 6;
      m.raycast = () => {};
      m.name = 'vent-confort';
      objets.groupe.add(m);
      objets.confort = m;
    } else {
      objets.confort.material.map.image.data.set(px);
      objets.confort.material.map.needsUpdate = true;
      objets.confort.visible = true;
    }
    const pct = parts.map((n) => Math.round((100 * n) / Math.max(total, 1)));
    const cle = (avec) => `${avec}|${etat.saison}|${etat.seuil}`;
    bilans.set(cle(avecProjet()), { pct, classes });
    const ligne = (p) => CLASSES_CONFORT.map((c, k) => `${c.t.split(',')[0]} ${p[k]} %`).join(', ');
    const lib = { annee: 'toute l\'année', hiver: 'l\'hiver', printemps: 'le printemps', ete: 'l\'été', automne: 'l\'automne' }[etat.saison];
    let texte = `Seuil de ${etat.seuil} m/s, ${lib} (${jeuDepassements().N.toLocaleString('fr-FR')} h de mesures), ${avecProjet() ? 'avec' : 'sans'} le projet. Dans le cercle de ${Math.round(rayonParticules() * 2)} m : ${ligne(pct)}.`;
    const autre = bilans.get(cle(!avecProjet()));
    if (autre && !projetVide()) {
      let changees = 0;
      for (let k = 0; k < classes.length; k++) if (classes[k] >= 0 && autre.classes[k] >= 0 && classes[k] !== autre.classes[k]) changees++;
      texte += ` ${avecProjet() ? 'Sans' : 'Avec'} le projet : ${ligne(autre.pct)} ; ${changees.toLocaleString('fr-FR')} mailles de 4 m changent de classe.`;
    }
    noteConfort(`${texte} Survolez la carte pour lire un point.`);
  }

  function effacerConfort() {
    etat.P = null;
    if (objets?.confort) objets.confort.visible = false;
  }

  async function majConfort() {
    majBoutonsProjet();
    if (!etat.confort) { effacerConfort(); noteConfort(''); return; }
    try { await calculerConfort(); } catch (e) { noteConfort(`Calcul impossible : ${e.message}`); }
  }

  // valeur sous le pointeur
  app.on('pointeurSol', ([x, z]) => {
    if (!etat.P || !etat.confort || !ui.pointeur?.isConnected) return;
    const i = Math.floor((x + CHALF) / CH), j = Math.floor((z + CHALF) / CH);
    if (i < 0 || j < 0 || i >= NC || j >= NC) { ui.pointeur.textContent = ''; return; }
    const p = etat.P[j * NC + i];
    ui.pointeur.textContent = p < 0 ? 'Sous le pointeur : dans un bâtiment.'
      : `Sous le pointeur : classe ${CLASSES_CONFORT[classeConfort(p)].t}, plus de ${etat.seuil} m/s environ ${nombre(p * 100, p < 0.1 ? 1 : 0)} % du temps.`;
  });

  // ---------------------------------------------------------------
  // Réglage du vent (direction, vitesse) depuis le panneau
  // ---------------------------------------------------------------
  const note = (t) => { if (ui.etat?.isConnected) ui.etat.textContent = t; };
  const noteConfort = (t) => { if (ui.confort?.isConnected) ui.confort.textContent = t; };
  const texteDirection = () => `${etat.direction}° ${NOMS16[Math.round(etat.direction / 22.5) % 16]}`;

  function majLibelles() {
    majFleche();
    if (!ui.dir?.isConnected) return;
    ui.dir.textContent = texteDirection();
    ui.vit.textContent = `${nombre(etat.vitesse)} m/s (${Math.round(etat.vitesse * 3.6)} km/h)`;
    ui.den.textContent = `${etat.densite}`;
    ui.boussole.style.transform = `rotate(${etat.direction + 180}deg)`;
    ui.curDir.value = etat.direction;
    ui.curVit.value = etat.vitesse;
    majSelectionRose();
  }

  function regler(direction, vitesse) {
    etat.direction = ((Math.round(direction) % 360) + 360) % 360;
    if (vitesse != null) etat.vitesse = borneVitesse(vitesse);
    majLibelles();
    recalculer();
  }

  // ---------------------------------------------------------------
  // Rose des vents cliquable (12 secteurs de 30°)
  // ---------------------------------------------------------------
  const roseActive = () => rose(12, etat.saison, etat.temperature);
  const roseFiable = (ro) => ro.N >= 100 && ro.secteurs.length;
  const vitesseSecteur = (sct) => (etat.modeVitesse === 'fort' ? sct.p90 : sct.vm);

  function appliquerSecteur(k) {
    const ro = roseActive();
    if (!roseFiable(ro)) return;
    const sct = ro.secteurs[k];
    regler(sct.dir, vitesseSecteur(sct));
  }

  function dessinerRose() {
    if (!ui.rose?.isConnected) return;
    const T = 240, c = T / 2, RM = 86;
    const svg = s('svg', { viewBox: `0 0 ${T} ${T}`, class: 'graphique rose-vent', role: 'group', 'aria-label': 'Rose des vents : choisir un secteur règle la direction et la vitesse' });
    const ro = roseActive();
    const ok = roseFiable(ro);
    const maxF = ok ? Math.max(...ro.secteurs.map((x) => x.f)) : 10;
    const axe = Math.max(10, Math.ceil(maxF / 5) * 5), pasAxe = axe > 25 ? 10 : 5;
    for (let p = pasAxe; p <= axe; p += pasAxe) {
      const r = (RM * p) / axe;
      svg.append(s('circle', { cx: c, cy: c, r, class: 'grille' }), s('text', { x: c + 3, y: c - r + 9, class: 'axe' }, `${p} %`));
    }
    svg.append(s('line', { x1: c, y1: c - RM - 4, x2: c, y2: c + RM + 4, class: 'grille' }), s('line', { x1: c - RM - 4, y1: c, x2: c + RM + 4, y2: c, class: 'grille' }));
    const pol = (r, d) => { const t = THREE.MathUtils.degToRad(d); return [c + r * Math.sin(t), c - r * Math.cos(t)]; };
    const coin = (r, d) => { if (r < 0.5) return ''; const [x0, y0] = pol(r, d - 15), [x1, y1] = pol(r, d + 15); return `M${c} ${c} L${x0.toFixed(1)} ${y0.toFixed(1)} A${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z`; };
    ui.secteurs = [];
    if (ok) {
      for (const sct of ro.secteurs) {
        const nom = `${NOMS12[sct.k]} (${sct.dir}°)`;
        const g = s('g', { tabindex: 0, role: 'button', class: 'secteur', 'aria-label': `${nom} : ${nombre(sct.f)} % du temps, ${nombre(sct.vm)} m/s en moyenne` },
          s('title', {}, `${nom} : ${nombre(sct.f)} % du temps, ${nombre(sct.vm)} m/s en moyenne, ${nombre(sct.p90)} m/s dépassés 10 % du temps`),
          s('path', { d: coin((RM * sct.f) / axe, sct.dir), class: 'tout' }),
          s('path', { d: coin((RM * sct.f * (sct.p5 ?? 0)) / 100 / axe, sct.dir), class: 'fort' }),
          s('path', { d: coin(RM, sct.dir), class: 'cible' }));
        g.addEventListener('click', () => appliquerSecteur(sct.k));
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); appliquerSecteur(sct.k); } });
        svg.append(g);
        ui.secteurs[sct.k] = g;
      }
    }
    for (const [txt, az] of [['N', 0], ['E', 90], ['S', 180], ['O', 270]]) {
      const [x, y] = pol(RM + 16, az);
      svg.append(s('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'axe cardinal' }, txt));
    }
    // aiguille : direction réglée (d'où vient le vent)
    ui.aiguille = s('line', { x1: c, y1: c, x2: c, y2: c - RM - 6, class: 'aiguille' });
    svg.append(ui.aiguille, s('circle', { cx: c, cy: c, r: 3, class: 'moyeu' }));
    ui.rose.replaceChildren(svg);
    // résumé, alerte et boutons « le plus fréquent », « le plus énergétique »
    const quoi = `${libelleSaison(etat.saison)}, ${minuscule(libelleTemperature(etat.temperature))}`;
    const alerte = avertissement(ro.N, `la case « ${quoi} »`);
    ui.alerte.textContent = alerte ?? '';
    ui.alerte.hidden = !alerte;
    if (ro.temperatureIgnoree) { ui.alerte.textContent = `Année ${ro.annee} seule : rose toutes températures (le choix de température est ignoré).`; ui.alerte.hidden = false; }
    ui.raccourcis.replaceChildren();
    if (ok) {
      const tri = (cle) => ro.secteurs.slice().sort((a, b) => b[cle] - a[cle])[0];
      const freq = tri('f'), ener = tri('e');
      ui.raccourcis.append(
        h('button', { type: 'button', class: 'bouton discret petit', onclick: () => appliquerSecteur(freq.k) }, `Le plus fréquent (${NOMS12[freq.k]})`),
        h('button', { type: 'button', class: 'bouton discret petit', onclick: () => appliquerSecteur(ener.k) }, `Le plus énergétique (${NOMS12[ener.k]})`));
    }
    majSelectionRose();
    majTableauSaisons();
  }

  function majSelectionRose() {
    if (!ui.rose?.isConnected) return;
    const k = secteur12(etat.direction);
    ui.secteurs?.forEach((g, i) => g?.classList.toggle('actif', i === k));
    ui.aiguille?.setAttribute('transform', `rotate(${etat.direction} 120 120)`);
    const ro = roseActive();
    if (!roseFiable(ro)) { ui.infoRose.textContent = ro.N ? 'Rose non dessinée : trop peu de mesures pour cette case. Choisir une autre période ou température.' : ''; return; }
    const sct = ro.secteurs[k];
    ui.infoRose.textContent = `${NOMS12[k]} (${(sct.dir + 345) % 360} à ${(sct.dir + 15) % 360}°) : ${nombre(sct.f)} % du temps, ${nombre(sct.vm)} m/s en moyenne, ${nombre(sct.p90)} m/s dépassés 10 % du temps, ${nombre(sct.p5, 0)} % des heures au-dessus de 5 m/s. ${ro.N.toLocaleString('fr-FR')} h de mesures, calme ${nombre(ro.calmes, 0)} %.`;
  }

  function majModeVitesse() {
    ui.modes?.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === etat.modeVitesse)));
  }

  // ---------------------------------------------------------------
  // Tableau des saisons
  // ---------------------------------------------------------------
  function majTableauSaisons() {
    if (!ui.saisons?.isConnected) return;
    const n = normales();
    ui.saisons.replaceChildren(...SAISONS4.map(([cle, lib, mois]) => {
      const ro = rose(12, cle, 'all');
      if (!roseFiable(ro)) return h('tr', {}, h('td', {}, lib), h('td', { colspan: 4 }, '–'));
      const dom = ro.secteurs.slice().sort((a, b) => b.f - a.f)[0];
      const t = n ? mois.reduce((a, i) => a + n.T[i], 0) / 3 : null;
      const actif = etat.saison === cle && etat.temperature === 'all';
      const tr = h('tr', { tabindex: 0, class: actif ? 'actif' : null, title: `Choisir ${minuscule(lib)} et appliquer son vent dominant` },
        h('td', {}, lib), h('td', {}, nombre(t)), h('td', {}, NOMS12[dom.k]), h('td', {}, nombre(vitesseSecteur(dom))), h('td', {}, `${nombre(dom.f, 0)} %`));
      const choisir = () => {
        etat.saison = cle; etat.temperature = 'all';
        ui.selSaison.value = cle; ui.selTemp.value = 'all';
        dessinerRose(); majRoseMaquette();
        appliquerSecteur(dom.k);
        if (etat.confort) majConfort();
      };
      tr.addEventListener('click', choisir);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choisir(); } });
      return tr;
    }));
  }

  // ---------------------------------------------------------------
  // Graphique mensuel cliquable : températures et vent moyen
  // ---------------------------------------------------------------
  const dominantMois = (i) => { const f = normales().f16[i]; return f.indexOf(Math.max(...f)); };

  function dessinerMois() {
    if (!ui.mois?.isConnected) return;
    const n = normales();
    if (!n) { ui.mois.replaceChildren(h('p', { class: 'note' }, mention())); return; }
    const L = 300, H = 170, g = 26, bas = 104, haut = 10, tMin = -2, tMax = 28;
    const y = (t) => bas - ((t - tMin) / (tMax - tMin)) * (bas - haut);
    const pas = (L - g - 4) / 12, y0 = H - 4, kv = 8;
    const svg = s('svg', { viewBox: `0 0 ${L} ${H}`, class: 'graphique graphique-mois', role: 'group', 'aria-label': 'Températures et vent moyens par mois : choisir un mois' });
    svg.append(s('rect', { x: g + etat.mois * pas, y: 2, width: pas, height: H - 4, class: 'mois-actif' }));
    for (const t of [0, 10, 20]) svg.append(s('line', { x1: g, x2: L - 4, y1: y(t), y2: y(t), class: 'grille' }), s('text', { x: g - 4, y: y(t) + 3, 'text-anchor': 'end', class: 'axe' }, `${t}°`));
    let ligne = '';
    n.T.forEach((t, i) => {
      const x = g + i * pas, actif = i === etat.mois;
      svg.append(s('rect', { x: x + pas * 0.28, y: y(n.Tmax[i]), width: pas * 0.44, height: y(n.Tmin[i]) - y(n.Tmax[i]), rx: 2, class: actif ? 'temp actif' : 'temp' }));
      svg.append(s('rect', { x: x + pas * 0.25, y: y0 - n.FF[i] * kv, width: pas * 0.5, height: n.FF[i] * kv, fill: actif ? COULEURS_VENT[2] : COULEURS_VENT[1] }));
      svg.append(s('text', { x: x + pas / 2, y: bas + 11, 'text-anchor': 'middle', class: actif ? 'axe actif' : 'axe' }, MOIS[i][0].toUpperCase()));
      ligne += `${ligne ? 'L' : 'M'}${(x + pas / 2).toFixed(1)} ${y(t).toFixed(1)}`;
    });
    svg.append(s('path', { d: ligne, fill: 'none', stroke: '#2f3b45', 'stroke-width': 1.3 }));
    svg.append(s('line', { x1: g, x2: L - 4, y1: y0, y2: y0, class: 'grille' }), s('line', { x1: g, x2: L - 4, y1: y0 - 4 * kv, y2: y0 - 4 * kv, class: 'grille', 'stroke-dasharray': '2 2' }));
    svg.append(s('text', { x: g - 4, y: y0 - 4 * kv + 3, 'text-anchor': 'end', class: 'axe' }, '4'), s('text', { x: L - 4, y: y0 - 4 * kv - 3, 'text-anchor': 'end', class: 'axe' }, 'vent moyen (m/s)'));
    n.T.forEach((t, i) => {
      const r = s('rect', { x: g + i * pas, y: 0, width: pas, height: H, class: 'cible', tabindex: 0, role: 'button', 'aria-label': MOIS[i] },
        s('title', {}, `${MOIS[i]} : ${nombre(t)} °C, vent ${nombre(n.FF[i])} m/s, dominant ${NOMS16[dominantMois(i)]}`));
      const choisir = () => { etat.mois = i; dessinerMois(); };
      r.addEventListener('click', choisir);
      r.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choisir(); } });
      svg.append(r);
    });
    ui.mois.replaceChildren(svg);
    const i = etat.mois;
    const top = n.f16[i].map((f, k) => [f, k]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([f, k]) => `${NOMS16[k]} ${nombre(f, 0)} %`);
    ui.infoMois.textContent = `${MOIS[i].replace(/^./, (c) => c.toUpperCase())} : ${nombre(n.T[i])} °C en moyenne (${nombre(n.Tmin[i])} à ${nombre(n.Tmax[i])} °C), vent moyen ${nombre(n.FF[i])} m/s, rafale maximale ${nombre(n.FXImax[i])} m/s. Vents dominants : ${top.join(', ')}.`;
    ui.boutonMois.textContent = `Appliquer le vent dominant de ${MOIS[i]} (${NOMS16[dominantMois(i)]}, ${nombre(borneVitesse(n.FF[i]))} m/s)`;
  }

  function appliquerMois() {
    const n = normales();
    if (!n) return;
    regler(dominantMois(etat.mois) * 22.5, n.FF[etat.mois]);
  }

  // ---------------------------------------------------------------
  // Vues rapides (caméra de l'atlas : app.vue, comme la touche V)
  // ---------------------------------------------------------------
  function vueDessus() { if (!app.vue2D) app.vue.basculer(true); }

  function vuePerspective() {
    if (app.vue2D) { app.vue.basculer(false); return; }
    const t = app.controls.target, d = Math.max(app.camera.position.distanceTo(t), 120);
    const v = new THREE.Vector3(-260, 230, 320).setLength(d);
    allerVers(app, [t.x + v.x, t.y + v.y, t.z + v.z], [t.x, t.y, t.z], 900);
  }

  function vueNord() {
    if (app.vue2D) return; // le plan est toujours nord en haut
    const t = app.controls.target, p = app.camera.position;
    const hauteur = p.y - t.y, horiz = Math.sqrt(Math.max(p.distanceToSquared(t) - hauteur * hauteur, 1));
    allerVers(app, [t.x, p.y, t.z + horiz], [t.x, t.y, t.z], 700);
  }

  // ---------------------------------------------------------------
  // Confort : avec ou sans le projet (calque Projet de l'onglet Bâtiments)
  // ---------------------------------------------------------------
  function majBoutonsProjet() {
    if (!ui.projet?.isConnected) return;
    const vide = projetVide();
    ui.projet.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String((b.dataset.avec === '1') === avecProjet()));
      b.disabled = !app.projet || vide;
    });
    ui.noteProjet.textContent = !app.projet ? '' : vide
      ? 'Projet vide : aucune démolition ni aucun volume (onglet Bâtiments > Projet). La carte montre le bâti existant.'
      : 'Bascule le calque Projet de l\'onglet Bâtiments : la maquette, l\'écoulement et la carte suivent.';
  }

  function choisirProjet(avec) {
    if (!app.projet || avec === avecProjet()) return;
    app.projet.definirVisible(avec); // émet « bati » : écoulement et carte recalculés
  }

  // ---------------------------------------------------------------
  // Panneau
  // ---------------------------------------------------------------
  function majEffetsUI() {
    if (!ui.effets?.isConnected) return;
    for (const t of TYPES_EFFETS) {
      const n = etat.effets?.nombres[t.t] || 0;
      ui.effets.querySelector(`[data-type="${t.t}"]`).textContent = n ? `× ${n}` : 'aucun';
    }
  }

  function construirePanneau(conteneur) {
    if (!document.querySelector('link[href="css/vent.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: 'css/vent.css' }));
    ui.etat = h('p', { class: 'note', 'aria-live': 'polite' });
    ui.confort = h('p', { class: 'note', 'aria-live': 'polite' });
    ui.pointeur = h('p', { class: 'coordonnees' });
    ui.dir = h('strong', { class: 'valeur' });
    ui.vit = h('strong', { class: 'valeur' });
    ui.den = h('span');
    ui.rose = h('div', { class: 'rose-conteneur' });
    ui.infoRose = h('p', { class: 'note info-vent', 'aria-live': 'polite' });
    ui.alerte = h('p', { class: 'resultat alerte', hidden: true });
    ui.raccourcis = h('div', { class: 'actions serrees' });
    ui.source = h('p', { class: 'note source-vent' });
    ui.saisons = h('tbody');
    ui.mois = h('div');
    ui.infoMois = h('p', { class: 'note info-vent', 'aria-live': 'polite' });
    ui.boutonMois = h('button', { type: 'button', class: 'bouton petit', onclick: appliquerMois }, 'Appliquer le vent dominant du mois');
    ui.boussole = s('g', { class: 'fleche-boussole' }, s('path', { d: 'M18 6 L24 21 L18 17.5 L12 21 Z' }));
    const boussole = s('svg', { viewBox: '0 0 36 36', class: 'boussole-vent', 'aria-hidden': 'true' },
      s('circle', { cx: 18, cy: 18, r: 17 }), s('text', { x: 18, y: 6.5, 'text-anchor': 'middle' }, 'N'), ui.boussole);
    ui.curDir = h('input', { type: 'range', min: 0, max: 359, step: 1, value: etat.direction, 'aria-label': 'Direction d\'où vient le vent' });
    ui.curVit = h('input', { type: 'range', min: 1, max: 15, step: 0.5, value: etat.vitesse, 'aria-label': 'Vitesse du vent' });
    const curDen = h('input', { type: 'range', min: 1000, max: MAX, step: 500, value: etat.densite, 'aria-label': 'Nombre de particules' });
    ui.curDir.addEventListener('input', () => { etat.direction = +ui.curDir.value; majLibelles(); });
    ui.curVit.addEventListener('input', () => { etat.vitesse = +ui.curVit.value; majLibelles(); });
    ui.curDir.addEventListener('change', recalculer);
    ui.curVit.addEventListener('change', recalculer);
    curDen.addEventListener('input', () => { etat.densite = +curDen.value; majLibelles(); });
    const boutonPause = h('button', { type: 'button', class: 'bouton petit', 'aria-pressed': String(etat.pause), onclick: (e) => {
      etat.pause = !etat.pause; e.currentTarget.textContent = etat.pause ? 'Reprendre' : 'Pause'; e.currentTarget.setAttribute('aria-pressed', String(etat.pause));
    } }, etat.pause ? 'Reprendre' : 'Pause');
    const selecteur = (libelle, options, valeur, change) => h('label', { class: 'champ' }, h('span', {}, libelle),
      h('select', { onchange: (e) => change(e.target.value) }, ...options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(valeur) }, l))));
    const lSaison = selecteur('Période', SAISONS, etat.saison, (v) => { etat.saison = v; dessinerRose(); majRoseMaquette(); if (etat.confort) majConfort(); });
    const lTemp = selecteur('Température', TEMPERATURES, etat.temperature, (v) => { etat.temperature = v; dessinerRose(); majRoseMaquette(); });
    const caseRose = h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: etat.roseMaquette, onchange: (e) => { etat.roseMaquette = e.target.checked; majRoseMaquette(); } }),
      'Poser la rose des vents sur la maquette');
    const toutEffets = h('button', { type: 'button', class: 'bouton discret petit', onclick: () => {
      const tous = TYPES_EFFETS.every((t) => etat.effetsVisibles[t.t]);
      for (const t of TYPES_EFFETS) etat.effetsVisibles[t.t] = !tous;
      ui.effets.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = !tous; });
      majVisibiliteEffets(); majToutEffets();
    } });
    const majToutEffets = () => { toutEffets.textContent = TYPES_EFFETS.every((t) => etat.effetsVisibles[t.t]) ? 'Tout masquer' : 'Tout afficher'; };
    ui.majToutEffets = majToutEffets;
    ui.selSaison = lSaison.querySelector('select');
    ui.selTemp = lTemp.querySelector('select');
    // une année seule (sélecteur de Climat, js/meteo.js) : rose toutes températures
    ui.majTemp = () => { ui.selTemp.disabled = !!annee(); ui.selTemp.title = annee() ? 'Une année seule : rose toutes températures' : ''; };
    ui.majTemp();
    ui.modes = [['moyen', 'Vent moyen'], ['fort', 'Vent fort']].map(([m, l]) => h('button', {
      type: 'button', 'data-mode': m, 'aria-pressed': String(m === etat.modeVitesse),
      title: m === 'fort' ? 'Un clic sur un secteur applique la vitesse dépassée 10 % du temps (p90)' : 'Un clic sur un secteur applique la vitesse moyenne du secteur',
      onclick: () => { etat.modeVitesse = m; majModeVitesse(); majTableauSaisons(); appliquerSecteur(secteur12(etat.direction)); },
    }, l));
    ui.effets = h('ul', { class: 'legende' }, ...TYPES_EFFETS.map((t) => h('li', {},
      h('label', { class: 'case' },
        h('input', { type: 'checkbox', checked: etat.effetsVisibles[t.t], onchange: (e) => { etat.effetsVisibles[t.t] = e.target.checked; majVisibiliteEffets(); ui.majToutEffets?.(); } }),
        h('i', { style: { background: t.couleur, opacity: 0.7 } }),
        h('span', { title: t.desc }, t.nom), h('em', { 'data-type': t.t, style: { marginLeft: 'auto' } }, '')))));
    ui.projet = h('div', { class: 'segment-vent', role: 'group', 'aria-label': 'Bâti pris en compte' },
      ...[['1', 'Avec le projet'], ['0', 'Sans le projet']].map(([a, l]) => h('button', { type: 'button', 'data-avec': a, 'aria-pressed': 'false', onclick: () => choisirProjet(a === '1') }, l)));
    ui.noteProjet = h('p', { class: 'note' });
    ui.mentionLongue = h('p', { class: 'note' });
    ui.aPropos = info();
    ui.aPropos.querySelector('.info-bouton').title = 'À propos du calcul et des données';
    const curConfort = h('input', { type: 'checkbox', checked: etat.confort, onchange: (e) => { etat.confort = e.target.checked; majConfort(); } });

    conteneur.classList.add('panneau-vent');
    conteneur.append(
      // 1. Rose
      h('div', { class: 'titre-info' }, h('h3', {}, 'Rose des vents mesurée'),
        info('Cliquer un secteur de la rose, une saison ou un mois règle le vent ; les particules montrent l\'écoulement simplifié autour du bâti, à hauteur de piéton.', ui.source)),
      ...[app.climat?.selecteurAnnee?.()].filter(Boolean),
      h('div', { class: 'deux-champs' }, lSaison, lTemp),
      ui.rose,
      h('div', { class: 'segment-vent', role: 'group', 'aria-label': 'Vitesse appliquée au clic sur un secteur' }, ...ui.modes),
      ui.infoRose,
      ui.alerte,
      ui.raccourcis,
      caseRose,
      // 2. Saisons
      h('table', { class: 'tableau-vent' },
        h('caption', {}, 'Par saison (cliquer pour appliquer le vent dominant)'),
        h('thead', {}, h('tr', {}, h('th', {}, 'Saison'), h('th', {}, '°C'), h('th', {}, 'Dominant'), h('th', {}, 'm/s'), h('th', {}, 'Fréq.'))),
        ui.saisons),
      // 3. Mois
      h('h3', {}, 'Température et vent par mois'),
      ui.mois,
      ui.infoMois,
      h('div', { class: 'actions serrees' }, ui.boutonMois),
      // 4. Direction et vitesse
      h('h3', {}, 'Vent appliqué'),
      h('div', { class: 'ligne-valeur' }, h('span', {}, 'Direction d\'où vient le vent'), ui.dir),
      h('div', { class: 'ligne-direction' }, ui.curDir, boussole),
      h('div', { class: 'ligne-valeur' }, h('span', {}, 'Vitesse du vent libre'), ui.vit),
      ui.curVit,
      // 5. Vues rapides
      h('div', { class: 'actions serrees vues-vent', role: 'group', 'aria-label': 'Vues rapides' },
        h('button', { type: 'button', class: 'bouton petit', 'data-vue': 'dessus', onclick: vueDessus, title: 'Plan vu de dessus, nord en haut (comme la touche V)' }, 'Vue de dessus'),
        h('button', { type: 'button', class: 'bouton petit', 'data-vue': 'perspective', onclick: vuePerspective, title: 'Maquette en perspective' }, 'Perspective'),
        h('button', { type: 'button', class: 'bouton petit', 'data-vue': 'nord', onclick: vueNord, title: 'Tourner la maquette, nord en haut' }, 'Nord en haut')),
      // 6. Particules, confort, phénomènes, légende
      h('h3', {}, 'Particules'),
      h('div', { class: 'ligne-valeur' }, h('span', {}, 'Nombre'), ui.den),
      curDen,
      h('div', { class: 'actions serrees' }, boutonPause,
        app.export ? h('button', { type: 'button', class: 'bouton discret petit', onclick: () => app.export.exporterImage() }, 'Enregistrer l\'image') : null),
      h('div', { class: 'legende-soleil' }, h('span', {}, 'abrité'),
        h('i', { style: { background: 'linear-gradient(90deg, hsl(210 95% 42%), hsl(150 95% 42%) 30%, hsl(85 95% 42%) 55%, hsl(20 95% 42%))' } }), h('span', {}, 'accéléré')),
      ui.etat,
      h('h3', {}, 'Confort au vent piéton'),
      h('label', { class: 'case' }, curConfort, 'Afficher la carte de confort au sol'),
      selecteur('Seuil', SEUILS, etat.seuil, (v) => { etat.seuil = +v; majConfort(); }),
      ui.projet,
      ui.noteProjet,
      h('ul', { class: 'legende' }, ...CLASSES_CONFORT.map((c) => h('li', {}, h('i', { style: { background: `rgb(${c.c.join(',')})` } }), `${c.t} : seuil dépassé ${c.l}`))),
      ui.confort,
      ui.pointeur,
      h('div', { class: 'titre-action' }, h('div', { class: 'titre-info' }, h('h3', {}, 'Phénomènes de vent'), ui.aPropos), toutEffets),
      ui.effets,
    );
    ui.aPropos.querySelector('.info-panneau').append(
        h('p', { class: 'note' }, 'Écoulement simplifié en 2D : le vent contourne les bâtiments, s\'accélère entre eux et ralentit derrière (sillage estimé). Ce n\'est pas une simulation de mécanique des fluides : à lire pour comparer les lieux entre eux. Couleur des particules : vitesse rapportée au vent libre (bleu, abrité ; rouge, accéléré jusqu\'à 2,5 fois).'),
        h('p', { class: 'note' }, 'Rose : 12 secteurs de 30°, en % de toutes les heures (calmes compris) ; partie foncée : heures au-dessus de 5 m/s. « Vent fort » applique la vitesse dépassée 10 % du temps dans le secteur. Mois : direction dominante sur 16 secteurs et vent moyen du mois.'),
        h('p', { class: 'note' }, 'Confort : part du temps où le vent à hauteur de piéton dépasse le seuil, d\'après les rapports du calcul 2D pour les 12 secteurs et les dépassements mesurés de la période choisie (sans découpage par température ; toujours la moyenne 2016-2025, même quand une année est choisie), vent libre à 2 m en ville estimé à 0,70 fois le vent de la station ; mailles de 4 m.'),
        h('p', { class: 'note' }, 'Phénomènes : repérage géométrique d\'après la forme et la hauteur des bâtiments et le champ calculé (classement du CSTB) : des indices à vérifier sur place, pas des mesures.'),
        ui.mentionLongue);
    majLibelles();
    majModeVitesse();
    majBoutonsProjet();
    majEffetsUI();
    majToutEffets();
    ui.rose.append(h('p', { class: 'note' }, 'Lecture des mesures…'));
    chargerMF().then((d) => {
      if (!ui.rose.isConnected) return;
      if (!d) { ui.rose.replaceChildren(h('p', { class: 'resultat alerte' }, mention())); return; }
      ui.source.textContent = `Source : ${mention({ court: true, annee: true })}`;
      ui.mentionLongue.textContent = mention({ annee: true });
      dessinerRose();
      dessinerMois();
    });
    ouvrir();
  }

  // Rose des vents posée sur la maquette (dessinée par js/climat.js, 12 secteurs comme la rose du panneau)
  function majRoseMaquette() {
    app.climat?.reglerRose({ n: 12, saison: etat.saison, temperature: etat.temperature, visible: etat.roseMaquette && etat.actif });
  }

  // ---------------------------------------------------------------
  // Ouverture et fermeture
  // ---------------------------------------------------------------
  function ouvrir() {
    if (!etat.actif) {
      etat.actif = true;
      creerObjets();
      if (etat.roseMaquette) majRoseMaquette();
      setTimeout(() => {
        if (!etat.actif) return;
        const t0 = performance.now();
        calculerChamp();
        note(`Écoulement calculé en ${Math.round(performance.now() - t0)} ms (${etat.grille.batiments.length} bâtiments).`);
        if (etat.confort) majConfort();
      }, 30);
    } else {
      majConfort();
    }
  }

  function fermer() {
    if (!etat.actif) return;
    etat.actif = false;
    detruireObjets();
    if (etat.roseMaquette) app.climat?.reglerRose({ visible: false });
  }

  function batiChange() {
    etat.grille = null;
    majBoutonsProjet();
    if (etat.actif) { recalculer(); if (etat.confort) setTimeout(majConfort, 60); }
  }
  app.on('outil', (id) => { if (id !== 'vent') fermer(); });
  // période des mesures changée (Moyenne 2016-2025 / année, js/climat.js) : rose, saisons, mois et rose posée suivent
  app.on('meteoAnnee', () => {
    if (!ui.rose?.isConnected) return;
    ui.majTemp?.();
    ui.source.textContent = `Source : ${mention({ court: true, annee: true })}`;
    ui.mentionLongue.textContent = mention({ annee: true });
    dessinerRose(); majTableauSaisons(); dessinerMois(); majRoseMaquette();
  });
  app.on('etat', batiChange);
  // bâti modifié par le projet (démolitions, volumes, calque Projet) : écoulement et confort recalculés
  app.on('bati', batiChange);

  // ---------------------------------------------------------------
  // Export DXF : couches du dernier calcul (repère atlas [x, z])
  // ---------------------------------------------------------------
  function entitesDXF() {
    const res = { polys: [], textes: [] };
    for (const it of etat.effets?.items || []) {
      const calque = `VENT_${TYPES_EFFETS[it.t - 1].nom.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`.slice(0, 31);
      for (const p of it.polys) res.polys.push({ calque, pts: p.map(versAtlas) });
      res.textes.push({ calque, pt: versAtlas([it.x, it.y]), texte: TYPES_EFFETS[it.t - 1].nom });
    }
    if (etat.P && etat.confort) {
      // bandes de cellules de même classe, ligne par ligne
      for (let j = 0; j < NC; j++) {
        let i0 = 0, c0 = null;
        for (let i = 0; i <= NC; i++) {
          const xc = -CHALF + (i + 0.5) * CH, zc = -CHALF + (j + 0.5) * CH;
          const p = i < NC && xc * xc + zc * zc <= CHALF * CHALF ? etat.P[j * NC + i] : -1;
          const c = p < 0 ? null : classeConfort(p);
          if (c !== c0) {
            if (c0 !== null) {
              const x0 = -CHALF + i0 * CH, x1 = -CHALF + i * CH, z0 = -CHALF + j * CH, z1 = z0 + CH;
              res.polys.push({ calque: `VENT_CONFORT_${'ABCDE'[c0]}`, pts: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] });
            }
            i0 = i; c0 = c;
          }
        }
      }
    }
    return res;
  }

  return {
    construirePanneau, etat, entitesDXF, fermer, regler, appliquerSecteur,
    get actif() { return etat.actif; },
    maj(dt) { if (objets && etat.solveur?.etat.direction != null) majParticules(Math.min(dt, 0.05)); },
  };
}
