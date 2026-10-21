import * as THREE from 'three';
import { polygonesLocaux, lignesLocales, centroide } from './geo.js';
import {
  COULEURS, geometriesExtrudees, geometriesPlates, aretes, textureHachures,
} from './maquette.js';

export const CERTITUDES = {
  atteste: { libelle: 'Attesté (plan ou photo)', opacite: 0.5 },
  restitue: { libelle: 'Restitué (déduit)', opacite: 0.32 },
  hypothetique: { libelle: 'Hypothétique', opacite: 0.16 },
};

function nombre(v, defaut) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : defaut;
}

function vider(app, nom) {
  const g = app.groupes[nom];
  if (!g) return;
  g.traverse((o) => {
    app.temps.retirer(o);
    const i = app.pickables.indexOf(o);
    if (i >= 0) app.pickables.splice(i, 1);
  });
  app.etiquettes.retirerGroupe(nom);
  app.scene.remove(g);
  delete app.groupes[nom];
}

function nouveauGroupe(app, nom) {
  vider(app, nom);
  const g = new THREE.Group();
  g.name = nom;
  app.groupes[nom] = g;
  app.scene.add(g);
  return g;
}

// Repère « à caler » sur les éléments provisoires, visible seulement quand la couche l'est
const signalerProvisoire = (app, f, position, nom, visibleSi) => {
  if (!f.properties?.provisoire) return;
  app.etiquettes.ajouter({ texte: 'à caler', position, classe: 'etiquette-provisoire', groupe: nom, distanceMax: 350, visibleSi });
};

// ------------------------------------------------------------------
// Bâti détruit en 1943, restitué en fantôme
// ------------------------------------------------------------------

export function construireFantomes(app) {
  const g = nouveauGroupe(app, 'fantomes');
  for (const f of app.donnees.fantomes.features) {
    const p = f.properties || {};
    const polys = polygonesLocaux(f.geometry, app.proj);
    const base = nombre(p.base, 0);
    const h = nombre(p.hauteur, nombre(p.niveaux, 4) * app.config.hauteurNiveau);
    const geos = geometriesExtrudees(polys, Math.max(h - base, 0.5), base);
    const cert = CERTITUDES[p.certitude] || CERTITUDES.restitue;
    for (const geo of geos) {
      const mat = new THREE.MeshStandardMaterial({
        color: COULEURS.fantome, transparent: true, opacity: cert.opacite, depthWrite: false, roughness: 0.6,
      });
      const m = new THREE.Mesh(geo, mat);
      const ar = aretes(geo, p.certitude === 'hypothetique' ? 0.35 : 0.75, 0x415a7a);
      if (p.certitude === 'hypothetique') {
        ar.material = new THREE.LineDashedMaterial({ color: 0x415a7a, dashSize: 1.2, gapSize: 0.8, transparent: true, opacity: 0.6 });
        ar.computeLineDistances();
      }
      m.add(ar);
      m.renderOrder = 2;
      m.userData = { fiche: p.fiche, nom: p.nom || 'Bâti disparu en 1943', infobulle: `${cert.libelle}${p.source ? ` d'après ${p.source}` : ''}`, feature: f, couche: 'fantomes' };
      g.add(m);
      app.pickables.push(m);
      // visible avant 1943, ou quand la couche « mémoire » est activée
      app.temps.enregistrer(m, (a) => a.etat === 'avant' || a.couches.fantomes, 'hauteur');
      m.castShadow = true;
    }
    if (polys[0]) {
      const [cx, cz] = centroide(polys[0][0]);
      signalerProvisoire(app, f, new THREE.Vector3(cx, h + 2, cz), 'fantomes', (a) => a.etat === 'avant' || a.couches.fantomes);
    }
  }
  // Les fantômes ne projettent d'ombre que dans l'état « avant 1943 », quand ils étaient bien réels.
  const ombres = () => app.groupes.fantomes?.traverse((o) => { if (o.isMesh) o.castShadow = app.etat === 'avant'; });
  if (!app._ombresFantomes) { app._ombresFantomes = true; app.on('etat', ombres); }
  ombres();
}

// ------------------------------------------------------------------
// Parcelles vacantes (63, 51…)
// ------------------------------------------------------------------

export function construireParcelles(app) {
  const g = nouveauGroupe(app, 'parcelles');
  const tex = textureHachures('rgba(47,59,69,0.6)', 10);
  tex.repeat.set(1 / 2.5, 1 / 2.5);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 });
  for (const f of app.donnees.parcelles.features) {
    const p = f.properties || {};
    const polys = polygonesLocaux(f.geometry, app.proj);
    for (const geo of geometriesPlates(polys, 0.16)) {
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = 3;
      m.userData = { fiche: p.fiche, nom: `Parcelle ${p.numero ?? ''}`.trim(), feature: f, couche: 'parcelles' };
      g.add(m);
      app.pickables.push(m);
      app.temps.enregistrer(m, (a) => a.couches.parcelles, 'aucune');
      const contour = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(polys[0][0].map(([x, z]) => new THREE.Vector3(x, 0.2, z))),
        new THREE.LineBasicMaterial({ color: COULEURS.trait })
      );
      m.add(contour);
    }
    if (polys[0]) {
      const [cx, cz] = centroide(polys[0][0]);
      app.etiquettes.ajouter({ texte: `Parcelle ${p.numero ?? ''}`, position: new THREE.Vector3(cx, 1.5, cz), classe: 'etiquette-parcelle', fiche: p.fiche, groupe: 'parcelles', distanceMax: 700, visibleSi: (a) => a.couches.parcelles });
      signalerProvisoire(app, f, new THREE.Vector3(cx, 6, cz), 'parcelles', (a) => a.couches.parcelles);
    }
  }
}

// ------------------------------------------------------------------
// Points d'intérêt : les fiches qui ont une position reçoivent un repère
// ------------------------------------------------------------------

export function construirePOI(app) {
  app.etiquettes.retirerGroupe('poi');
  for (const fiche of app.donnees.fiches.fiches || []) {
    if (!fiche.position) continue;
    const { x, z } = app.proj.versLocal(fiche.position[0], fiche.position[1]);
    const etats = fiche.etatsVisibles;
    app.etiquettes.ajouter({
      texte: fiche.titre,
      position: new THREE.Vector3(x, fiche.hauteurRepere ?? 6, z),
      classe: 'etiquette-poi',
      fiche: fiche.id,
      groupe: 'poi',
      distanceMax: 900,
      visibleSi: (a) => a.couches.poi && (!etats || etats.includes(a.etat)),
    });
  }
}

export const CONSTRUCTEURS = {
  fantomes: construireFantomes,
  parcelles: construireParcelles,
};
