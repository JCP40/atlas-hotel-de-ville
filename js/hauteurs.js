import * as THREE from 'three';
import { h } from './util.js';
import { pointDansPolygone } from './geo.js';
import { chargerJSON, enregistrerDonnees } from './donnees.js';

// Hauteurs corrigées bâtiment par bâtiment (onglet Bâtiments, outil Hauteurs).
// - data/hauteurs.json : { description, hauteurs: [{ cle, nom, hauteur, origine, lat, lon }] } ;
//   cle = identifiant OSM / IGN du bâtiment, sinon « g<lat>,<lon> » de son centre (même clé que les démolitions de projet.js).
// - construireBatiments (js/maquette.js) appelle app.hauteurs.valeur(id, cx, cz) : la hauteur corrigée remplace celle
//   de la BD TOPO / d'OSM / par défaut pour les bâtiments simples (extrudés) ; les ensembles à toitures détaillées gardent
//   leurs corps (data/toits/). Le bâti effectif suit donc (soleil, confort, vent, coupes, exports).
export function creerHauteurs(app) {
  const etat = { map: new Map(), sel: null, modifie: false };
  const ui = {};

  const cleXZ = (cx, cz) => { const g = app.proj.versGeo(cx, cz); return `g${g.lat.toFixed(6)},${g.lon.toFixed(6)}`; };
  const cleDe = (id, cx, cz) => (id != null ? String(id) : cleXZ(cx, cz));
  const cleEmpreinte = (e) => cleDe(e.id, e.cx, e.cz);
  const fmt = (v) => `${(Math.round(v * 10) / 10).toString().replace('.', ',')} m`;

  async function charger() {
    const d = await chargerJSON('data/hauteurs.json', null);
    etat.map.clear();
    for (const x of d?.hauteurs || []) {
      const v = parseFloat(x?.hauteur);
      if (x?.cle && Number.isFinite(v) && v > 0) etat.map.set(String(x.cle), { ...x, cle: String(x.cle), hauteur: v });
    }
  }

  // hauteur corrigée d'un bâtiment (null : pas de correction)
  function valeur(id, cx, cz) { return etat.map.get(cleDe(id, cx, cz))?.hauteur ?? null; }

  // bâtiment sous le pointeur (lancer de rayon sur le bâti fusionné, sinon emprise sous le point du sol)
  const ray = new THREE.Raycaster();
  const souris = new THREE.Vector2();
  function batimentSous(e, p) {
    const groupeBati = app.scene.getObjectByName('batiments');
    if (e && groupeBati?.visible) {
      const r = app.renderer.domElement.getBoundingClientRect();
      souris.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(souris, app.camera);
      const hit = ray.intersectObjects(groupeBati.children.filter((m) => m.isMesh && m.visible), false)[0];
      if (hit && hit.faceIndex != null) {
        const geo = hit.object.geometry;
        const v = geo.index ? geo.index.getX(hit.faceIndex * 3) : hit.faceIndex * 3;
        const em = (app.empreintes || []).find((x) => x.mesh === hit.object && v >= x.debut && v < x.debut + x.nb);
        if (em) return em;
      }
    }
    if (!p) return null;
    return (app.empreintes || []).find((x) => x.mesh?.visible !== false && x.polys.some(([ext]) => pointDansPolygone(p[0], p[1], ext))) || null;
  }
  // surbrillance : copie des sommets du bâtiment, enfant de son mesh
  const matSurvol = new THREE.MeshBasicMaterial({ color: 0xc8372d, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  let surbrillance = null, survole = null;
  function retirerSurbrillance() {
    if (surbrillance) { surbrillance.parent?.remove(surbrillance); surbrillance.geometry.dispose(); surbrillance = null; }
    survole = null;
  }
  function surligner(em) {
    if (em === survole) return;
    retirerSurbrillance();
    if (!em?.mesh) return;
    survole = em;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(em.mesh.geometry.getAttribute('position').array.slice(em.debut * 3, (em.debut + em.nb) * 3), 3));
    surbrillance = new THREE.Mesh(g, matSurvol);
    surbrillance.raycast = () => {};
    surbrillance.renderOrder = 5;
    surbrillance.userData.pasDeRelief = true;
    em.mesh.add(surbrillance);
  }

  const empreinteSel = () => (etat.sel ? (app.empreintes || []).find((e) => cleEmpreinte(e) === etat.sel) || null : null);

  function appliquer() {
    retirerSurbrillance();
    app.reconstruireBatiments();
    app.temps?.appliquer({ instantane: true });
    app.emettre('bati');
    const em = empreinteSel();
    if (em) surligner(em);
    majPanneau();
  }

  function definir(em, hauteur) {
    const v = Math.round(parseFloat(String(hauteur).replace(',', '.')) * 10) / 10;
    if (!em || !Number.isFinite(v) || v < 1 || v > 200) { app.signaler('Hauteur entre 1 et 200 m.'); return; }
    const cle = cleEmpreinte(em);
    const avant = etat.map.get(cle);
    const g = app.proj.versGeo(em.cx, em.cz);
    etat.map.set(cle, { cle, nom: em.nom || null, hauteur: v, origine: avant?.origine ?? em.hauteurOrigine ?? em.hauteur, lat: +g.lat.toFixed(6), lon: +g.lon.toFixed(6) });
    etat.modifie = true;
    appliquer();
    app.signaler(`${em.nom || 'Bâtiment'} : hauteur ${fmt(v)}.`);
  }
  function retablir(cle) {
    if (!etat.map.delete(cle)) return;
    etat.modifie = true;
    appliquer();
  }

  function serialiser() {
    return {
      description: 'Hauteurs corrigées par bâtiment (onglet Bâtiments, outil Hauteurs). cle = identifiant OSM / IGN, sinon centre g<lat>,<lon> ; hauteur en mètres au-dessus du sol ; origine = hauteur calculée avant correction.',
      hauteurs: [...etat.map.values()].map(({ cle, nom, hauteur, origine, lat, lon }) => ({ cle, nom: nom ?? null, hauteur, origine: origine != null ? Math.round(origine * 10) / 10 : null, lat, lon })),
    };
  }
  async function enregistrer() {
    await enregistrerDonnees('hauteurs.json', JSON.stringify(serialiser(), null, 2), { apres: 'relu à la prochaine ouverture' });
    etat.modifie = false;
    majPanneau();
  }

  // ------------------------------------------------------------
  // Sélection au clic (bâtiment touché en 3D, ou emprise sous le point du sol)
  // ------------------------------------------------------------
  function clic(p, e) {
    const em = batimentSous(e, p);
    if (!em) return;
    if (em.detail) { app.signaler(`${em.nom || 'Ce bâtiment'} a une toiture détaillée (data/toits/) : hauteur non modifiable ici. En représentation « simple », il redevient un volume corrigible.`); return; }
    etat.sel = cleEmpreinte(em);
    surligner(em);
    majPanneau();
    ui.champ?.focus();
  }
  clic.sansSol = true;
  function survol(p, e) {
    const em = batimentSous(e, p);
    app.renderer.domElement.style.cursor = em ? 'pointer' : 'crosshair';
    if (!etat.sel) surligner(em);
  }
  function activer() { app.captureSol = clic; app.survolCapture = survol; }
  function desactiver() {
    if (app.captureSol === clic) app.captureSol = null;
    if (app.survolCapture === survol) app.survolCapture = null;
    retirerSurbrillance();
    app.renderer.domElement.style.cursor = '';
  }
  app.on('outil', (id) => { if (id === 'hauteurs') activer(); else desactiver(); });

  // ------------------------------------------------------------
  // Panneau
  // ------------------------------------------------------------
  function majPanneau() {
    if (!ui.sel?.isConnected) return;
    const em = empreinteSel();
    if (!em) {
      ui.sel.replaceChildren(h('p', { class: 'note', 'data-garder': '' }, 'Cliquez un bâtiment sur la maquette pour corriger sa hauteur.'));
    } else {
      const corr = etat.map.get(etat.sel);
      ui.champ = h('input', { type: 'number', min: 1, max: 200, step: 0.5, value: Math.round(em.hauteur * 10) / 10, 'aria-label': 'Hauteur du bâtiment en mètres' });
      ui.champ.addEventListener('change', () => definir(em, ui.champ.value));
      ui.champ.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') definir(em, ui.champ.value); });
      ui.sel.replaceChildren(
        h('p', { class: 'resultat' }, em.nom || 'Bâtiment sans nom', h('span', { class: 'discret' }, ` (${etat.sel})`)),
        h('label', { class: 'champ' }, h('span', {}, 'Hauteur (m)'), ui.champ),
        h('p', { class: 'note', 'data-garder': '' }, corr ? `Corrigée ; hauteur calculée : ${fmt(corr.origine ?? em.hauteurOrigine ?? em.hauteur)}.` : `Hauteur calculée (${em.base ? `base ${fmt(em.base)}, ` : ''}BD TOPO, OSM ou valeur par défaut).`),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'bouton', onclick: () => definir(em, ui.champ.value) }, 'Appliquer'),
          corr ? h('button', { type: 'button', class: 'bouton discret', onclick: () => retablir(etat.sel) }, 'Rétablir') : null,
          h('button', { type: 'button', class: 'bouton discret', onclick: () => { etat.sel = null; retirerSurbrillance(); majPanneau(); } }, 'Désélectionner')),
      );
    }
    const liste = [...etat.map.values()];
    ui.liste.replaceChildren(...(liste.length ? liste.map((x) => h('li', {},
      h('span', {}, x.nom || x.cle), h('span', {}, `${x.origine != null ? `${fmt(x.origine)} → ` : ''}${fmt(x.hauteur)}`),
      h('button', { type: 'button', class: 'bouton discret petit', onclick: () => retablir(x.cle) }, 'Rétablir'))) : [h('li', {}, 'Aucune hauteur corrigée.')]));
    if (ui.enregistrer) ui.enregistrer.textContent = `Enregistrer hauteurs.json${etat.modifie ? ' *' : ''}`;
  }

  function construirePanneau(conteneur) {
    ui.sel = h('div');
    ui.liste = h('ul', { class: 'liste-donnees liste-hauteurs' });
    ui.enregistrer = app.mode === 'presentateur' ? h('button', { type: 'button', class: 'bouton', onclick: enregistrer }, 'Enregistrer hauteurs.json') : null;
    conteneur.append(
      h('h3', {}, 'Bâtiment choisi'),
      ui.sel,
      h('h3', {}, 'Hauteurs corrigées'),
      h('p', { class: 'note' }, 'Les hauteurs corrigées remplacent celles de la BD TOPO, d\'OSM ou la valeur par défaut, pour l\'affichage et pour les calculs (soleil, confort, vent, coupes, exports). Enregistrées dans data/hauteurs.json (serveur local), sinon téléchargées.'),
      ui.liste,
      h('div', { class: 'actions' }, ui.enregistrer,
        h('button', { type: 'button', class: 'bouton discret', onclick: () => { if (!etat.map.size) return; etat.map.clear(); etat.modifie = true; appliquer(); } }, 'Tout rétablir')),
    );
    majPanneau();
  }

  return { charger, valeur, definir, retablir, serialiser, enregistrer, construirePanneau, cleEmpreinte, etat };
}
