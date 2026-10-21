import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { polygonesLocaux, centroide, pointDansPolygone } from './geo.js';
import { geometriesPlates, textureHachures, colorierBatiments } from './maquette.js';
import { h } from './util.js';

// Intérêt de protection relevé par le descriptif du PSMV (classement du document)
export const INTERETS = [
  { test: /^type A/i, libelle: 'Type A', couleur: '#a8743f' },
  { test: /^type B/i, libelle: 'Type B', couleur: '#d6b77e' },
  { test: /portail/i, libelle: 'Portail à conserver', couleur: '#8a8f6a' },
  { test: /sans/i, libelle: 'Sans intérêt', couleur: '#c4c7c8' },
];
const interetDe = (txt) => INTERETS.find((i) => i.test.test(txt || '')) || INTERETS[3];

export function creerCadastre(app) {
  const groupe = new THREE.Group();
  groupe.name = 'cadastre';
  app.scene.add(groupe);
  const parcelles = []; // { f, polys, bbox, cle, fichesPSMV }
  const parCle = new Map();
  let selection = null;

  const cleDe = (section, numero) => `${section}${parseInt(numero, 10)}`;

  function construire() {
    groupe.clear();
    app.etiquettes.retirerGroupe('cadastre');
    parcelles.length = 0;
    parCle.clear();
    const psmv = app.donnees.psmv?.fiches || [];
    const limite = app.config.rayonEtude * 1.05;
    for (const f of app.donnees.cadastre?.features || []) {
      const p = f.properties || {};
      const polys = polygonesLocaux(f.geometry, app.proj);
      if (!polys[0]) continue;
      const [cx, cz] = centroide(polys[0][0]);
      if (Math.hypot(cx, cz) > limite) continue;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [ext] of polys) for (const [x, z] of ext) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      const cle = cleDe(p.section, p.numero);
      const item = { f, polys, bbox: [x0, z0, x1, z1], cle, cx, cz, fichesPSMV: [] };
      parcelles.push(item);
      parCle.set(cle, item);
    }
    for (const fiche of psmv) {
      for (const n of fiche.numeros || []) {
        const it = parCle.get(cleDe(fiche.section, n));
        if (it) it.fichesPSMV.push(fiche);
      }
    }

    // Limites parcellaires
    const pos = [];
    for (const it of parcelles) {
      for (const anneau of it.polys.flat()) {
        for (let i = 0; i < anneau.length; i++) {
          const a = anneau[i], b = anneau[(i + 1) % anneau.length];
          pos.push(a[0], 0.25, a[1], b[0], 0.25, b[1]);
        }
      }
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const lignes = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x9a3d35, transparent: true, opacity: 0.55 }));
      lignes.name = 'limites';
      lignes.raycast = () => {};
      groupe.add(lignes);
    }

    // Aplats PSMV par intérêt de protection
    const parInteret = new Map();
    for (const it of parcelles) {
      if (!it.fichesPSMV.length) continue;
      const int = interetDe(it.fichesPSMV[0].interet);
      if (!parInteret.has(int)) parInteret.set(int, []);
      parInteret.get(int).push(...geometriesPlates(it.polys, 0.2));
    }
    for (const [int, geos] of parInteret) {
      const m = new THREE.Mesh(mergeGeometries(geos, false), new THREE.MeshBasicMaterial({
        color: int.couleur, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -9, polygonOffsetUnits: -9,
      }));
      m.name = 'psmv';
      m.renderOrder = 3;
      m.raycast = () => {};
      groupe.add(m);
    }

    // Parcelles citées par le programme (63 et 51), repérées dans le cadastre
    for (const pp of app.config.parcellesProgramme || []) {
      const it = parCle.get(cleDe(pp.section, pp.numero));
      if (!it) continue;
      const tex = textureHachures('rgba(47,59,69,0.65)', 10);
      tex.repeat.set(1 / 2.5, 1 / 2.5);
      const m = new THREE.Mesh(mergeGeometries(geometriesPlates(it.polys, 0.24), false), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10 }));
      m.name = 'programme';
      m.renderOrder = 4;
      m.raycast = () => {};
      groupe.add(m);
      it.programme = pp;
      app.etiquettes.ajouter({ texte: pp.libelle || `Parcelle ${pp.numero}`, position: new THREE.Vector3(it.cx, 2, it.cz), classe: 'etiquette-parcelle', fiche: pp.fiche, groupe: 'cadastre', distanceMax: 900, visibleSi: (a) => a.couches.parcelles });
      app.parcellesCadastre = true;
    }

    // Numéros des parcelles proches
    const rayonNumeros = app.config.rayonPlateau * 2;
    for (const it of parcelles) {
      if (Math.hypot(it.cx, it.cz) > rayonNumeros) continue;
      const p = it.f.properties;
      app.etiquettes.ajouter({
        texte: `${p.section} ${p.numero}`,
        position: new THREE.Vector3(it.cx, 0.5, it.cz),
        classe: it.fichesPSMV.length ? 'etiquette-cadastre psmv' : 'etiquette-cadastre',
        groupe: 'cadastre',
        distanceMax: 330,
        visibleSi: (a) => a.couches.cadastre,
        centre: true,
      });
    }
    majVisibilite();
    majBatiments(true);
  }

  // Bâtiments colorés selon la fiche PSMV de la parcelle qui les porte (option masquer / révéler)
  let dernierEtat = null;
  function majBatiments(forcer = false) {
    const actif = !!app.couches.batimentsPSMV;
    if (!forcer && actif === dernierEtat) return;
    dernierEtat = actif;
    if (!actif) { colorierBatiments(app, null); return; }
    colorierBatiments(app, (e) => {
      if (e.psmv === undefined) {
        const it = trouver(e.cx, e.cz);
        e.psmv = it?.fichesPSMV.length ? interetDe(it.fichesPSMV[0].interet).couleur : null;
      }
      return e.psmv;
    });
  }

  function majVisibilite() {
    for (const c of groupe.children) {
      if (c.name === 'limites') c.visible = app.couches.cadastre;
      else if (c.name === 'psmv') c.visible = app.couches.psmv;
      else if (c.name === 'selection') c.visible = app.couches.cadastre || app.couches.psmv;
      else if (c.name === 'programme') c.visible = app.couches.parcelles;
    }
  }

  function trouver(x, z) {
    return parcelles.find((it) => x >= it.bbox[0] && x <= it.bbox[2] && z >= it.bbox[1] && z <= it.bbox[3]
      && it.polys.some(([ext]) => pointDansPolygone(x, z, ext)));
  }

  function surligner(it) {
    if (selection) { groupe.remove(selection); selection.geometry.dispose(); selection = null; }
    if (!it) return;
    const pts = [];
    for (const anneau of it.polys.flat()) {
      for (let i = 0; i < anneau.length; i++) {
        const a = anneau[i], b = anneau[(i + 1) % anneau.length];
        pts.push(a[0], 0.35, a[1], b[0], 0.35, b[1]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    selection = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xc8372d }));
    selection.name = 'selection';
    selection.raycast = () => {};
    groupe.add(selection);
  }

  function ficheParcelle(it) {
    const p = it.f.properties;
    const texte = [];
    if (p.contenance) texte.push(`Contenance cadastrale : **${p.contenance.toLocaleString('fr-FR')} m²**.`);
    texte.push(`Identifiant : ${p.idu}.`);
    const images = [];
    const liens = [];
    for (const fi of it.fichesPSMV) {
      const num = String(fi.fiche).padStart(3, '0');
      texte.push(`**Fiche PSMV n° ${num}** : ${fi.adresse ?? ''} (parcelles ${fi.cadastre}).`);
      const lignes = [
        ['Intérêt de protection', fi.interet], ['Protection monument historique', fi.protectionMH], ['Programme d\'origine', fi.programme],
        ['Type architectural', fi.typeArchitectural], ['Datation estimée', fi.date], ['Niveaux sur rue', fi.niveauxRue],
        ['Toiture', fi.toiture], ['Façade principale', fi.facade], ['Rez-de-chaussée', fi.rdc], ['Étages', fi.etages],
        ['Propriétaire', fi.proprietaire], ['Transformations récentes', fi.transformations], ['État sanitaire', fi.etatSanitaire],
      ];
      for (const [l, v] of lignes) if (v && v !== '-') texte.push(`**${l}** : ${v}`);
      const obs = [].concat(fi.observations || []);
      if (obs.length) texte.push(`**Observations** : ${obs.join(' ; ')}`);
      images.push({ fichier: `../psmv/photos/fiche-${num}.jpg`, legende: `Fiche ${num}, ${fi.adresse ?? ''} (relevé du ${fi.releve ?? '?'})` });
      images.push({ fichier: `../psmv/planches/fiche-${num}.jpg`, legende: `Planche complète de la fiche ${num}` });
      liens.push({ titre: `Ouvrir la fiche ${num} dans le PDF (page ${fi.page})`, url: `data/${app.donnees.psmv.document}#page=${fi.page}` });
    }
    if (it.programme) texte.unshift(`**${it.programme.libelle}** : ${it.programme.note ?? ''}`);
    if (!it.fichesPSMV.length) texte.push('Pas de fiche d\'immeuble dans le descriptif PSMV fourni pour cette parcelle.');
    return {
      id: `parcelle-${p.idu}`,
      titre: `Parcelle ${p.section} ${p.numero}`,
      type: it.fichesPSMV.length ? 'Cadastre et PSMV' : 'Cadastre',
      texte, images, liens,
      source: it.fichesPSMV.length ? 'Cadastre (IGN, Parcellaire Express) ; descriptif du secteur sauvegardé, A.U.P. 2014-2016, relu automatiquement : à vérifier sur le PDF.' : 'Cadastre (IGN, Parcellaire Express).',
    };
  }

  // Clic sur le sol : ouvrir la parcelle
  function clicSol([x, z]) {
    if (!app.couches.cadastre && !app.couches.psmv && !app.couches.batimentsPSMV) return false;
    const it = trouver(x, z);
    if (!it) return false;
    surligner(it);
    majVisibilite();
    app.fiches.afficher(ficheParcelle(it));
    return true;
  }

  function ouvrirParNumero(section, numero) {
    const it = parCle.get(cleDe(section, numero));
    if (!it) return false;
    surligner(it);
    majVisibilite();
    app.fiches.afficher(ficheParcelle(it));
    return it;
  }

  function construireLegende(conteneur) {
    const n = parcelles.length;
    const avecFiche = parcelles.filter((p) => p.fichesPSMV.length).length;
    conteneur.append(
      h('p', { class: 'note' }, n
        ? `${n} parcelles, dont ${avecFiche} décrites par une fiche du PSMV. Cliquez une parcelle sur la maquette pour lire sa fiche.`
        : 'Parcelles absentes : connectez-vous, ou préparez-les avec preparer.html.'),
      h('ul', { class: 'legende' }, ...INTERETS.map((i) => h('li', {}, h('i', { style: { background: i.couleur } }), `PSMV, intérêt de protection : ${i.libelle}`))),
      h('p', { class: 'note' }, 'Les bâtiments prennent la couleur de la fiche PSMV de la parcelle qui les porte ; les autres restent blancs.'),
    );
  }

  app.on('couches', () => { majVisibilite(); majBatiments(); });

  return { construire, clicSol, majBatiments, ouvrirParNumero, construireLegende, parcelles, trouver };
}
