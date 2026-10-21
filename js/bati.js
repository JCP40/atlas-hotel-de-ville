import * as THREE from 'three';
import { h, info } from './util.js';

const CLE = 'atlas-hdv-bati';

// Affichage du bâti existant : opaque, transparent (pour lire le sol, les parcelles, le relief
// et les réseaux au travers) ou masqué ; et photo aérienne plaquée sur les toits.
export function creerBati(app) {
  const memoire = (() => { try { return JSON.parse(localStorage.getItem(CLE) || '{}'); } catch { return {}; } })();
  const etat = {
    mode: memoire.mode || 'opaque', // opaque | transparent | masque
    opacite: memoire.opacite ?? 0.35,
    monumentsOpaques: memoire.monumentsOpaques ?? true,
    toits: false,
  };
  const toits = {
    carte: { value: new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1) },
    bornes: { value: new THREE.Vector4(0, 0, 1, 1) },
    actif: { value: 0 },
  };
  toits.carte.value.needsUpdate = true;

  // Injection dans le shader du matériau : les faces tournées vers le ciel lisent la photo aérienne
  function preparerMateriau(mat) {
    if (mat.userData.toitsPrets) return;
    mat.userData.toitsPrets = true;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.carteToits = toits.carte;
      shader.uniforms.bornesToits = toits.bornes;
      shader.uniforms.toitsActifs = toits.actif;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vPosToit;\nvarying float vHautToit;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPosToit = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvHautToit = normalize(mat3(modelMatrix) * objectNormal).y;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D carteToits;\nuniform vec4 bornesToits;\nuniform float toitsActifs;\nvarying vec3 vPosToit;\nvarying float vHautToit;')
        .replace('#include <color_fragment>', `#include <color_fragment>
if (toitsActifs > 0.5 && vHautToit > 0.6) {
  vec2 uvToit = vec2((vPosToit.x - bornesToits.x) / (bornesToits.z - bornesToits.x), 1.0 - (vPosToit.z - bornesToits.y) / (bornesToits.w - bornesToits.y));
  if (uvToit.x > 0.0 && uvToit.x < 1.0 && uvToit.y > 0.0 && uvToit.y < 1.0) diffuseColor.rgb = texture2D(carteToits, uvToit).rgb;
}`);
    };
    mat.customProgramCacheKey = () => 'toits-photo';
    mat.needsUpdate = true;
  }

  function materiaux() {
    return [app.materiaux?.batiment, app.materiaux?.remarquable].filter(Boolean);
  }

  function appliquer() {
    const groupe = app.scene.getObjectByName('batiments');
    if (!groupe) return;
    materiaux().forEach(preparerMateriau);
    groupe.visible = etat.mode !== 'masque';
    const transp = etat.mode === 'transparent';
    for (const mat of materiaux()) {
      const garder = mat === app.materiaux.remarquable && etat.monumentsOpaques;
      const t = transp && !garder;
      if (mat.transparent !== t) { mat.transparent = t; mat.needsUpdate = true; }
      mat.opacity = t ? etat.opacite : 1;
      mat.depthWrite = !t;
    }
    groupe.traverse((o) => {
      if (o.isMesh) {
        const garder = o.material === app.materiaux.remarquable && etat.monumentsOpaques;
        o.castShadow = !(transp && !garder);
        o.renderOrder = transp && !garder ? 1 : 0;
      }
      if (o.isLineSegments && o.material) o.material.opacity = transp ? Math.min(0.55, (o.userData.opaciteInitiale ??= o.material.opacity) + 0.2) : (o.userData.opaciteInitiale ?? o.material.opacity);
    });
    localStorage.setItem(CLE, JSON.stringify({ mode: etat.mode, opacite: etat.opacite, monumentsOpaques: etat.monumentsOpaques }));
    majUI();
  }

  // Photo aérienne sur les toits, à partir du fond au sol principal
  function majToits() {
    const fond = app.calques?.textureFond?.('principal');
    const possible = !!fond;
    toits.actif.value = etat.toits && possible ? 1 : 0;
    if (possible) {
      toits.carte.value = fond.texture;
      const no = app.proj.versLocal(fond.bornes.nord, fond.bornes.ouest);
      const se = app.proj.versLocal(fond.bornes.sud, fond.bornes.est);
      toits.bornes.value.set(no.x, no.z, se.x, se.z);
    }
    if (ui.toits) { ui.toits.disabled = !possible; ui.toitsLigne.classList.toggle('indisponible', !possible); }
  }

  // ---------------------------------------------------------------
  // Même point de vue dans Google Earth ou Google Maps (onglet séparé, sans clé)
  // ---------------------------------------------------------------
  function pointDeVue() {
    const cible = app.controls.target;
    const g = app.proj.versGeo(cible.x, cible.z);
    const alt = app.topo?.disponible && Number.isFinite(app.topo.altitude(cible.x, cible.z)) ? app.topo.altitude(cible.x, cible.z) : 10;
    let distance, cap, inclinaison;
    if (app.vue2D) {
      distance = app.vue.distanceEquivalente();
      cap = 0; inclinaison = 0;
    } else {
      const dir = new THREE.Vector3().subVectors(cible, app.camera.position);
      distance = dir.length();
      cap = (THREE.MathUtils.radToDeg(Math.atan2(dir.x, -dir.z)) + 360) % 360;
      inclinaison = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, -dir.y / distance)));
    }
    return { lat: g.lat.toFixed(6), lon: g.lon.toFixed(6), alt: Math.round(alt), distance: Math.round(distance), cap: Math.round(cap), inclinaison: Math.round(inclinaison) };
  }

  function ouvrirGoogleEarth() {
    const v = pointDeVue();
    window.open(`https://earth.google.com/web/@${v.lat},${v.lon},${v.alt}a,${v.distance}d,35y,${v.cap}h,${v.inclinaison}t,0r`, '_blank', 'noopener');
  }

  function ouvrirGoogleMaps() {
    const v = pointDeVue();
    window.open(`https://www.google.com/maps/@${v.lat},${v.lon},${v.distance}a,35y,${v.cap}h,${v.inclinaison}t/data=!3m1!1e3`, '_blank', 'noopener');
  }

  // ---------------------------------------------------------------
  // Panneau (dans Couches)
  // ---------------------------------------------------------------
  const ui = {};
  function majUI() {
    if (!ui.modes?.isConnected) return;
    ui.modes.querySelectorAll('input').forEach((i) => { i.checked = i.value === etat.mode; });
    ui.reglages.hidden = etat.mode !== 'transparent';
  }

  function construireCommandes(conteneur) {
    ui.modes = h('div', { class: 'choix', role: 'radiogroup', 'aria-label': 'Affichage du bâti' },
      ...[['opaque', 'Opaque'], ['transparent', 'Transparent'], ['masque', 'Masqué']].map(([v, l]) => h('label', {},
        h('input', { type: 'radio', name: 'mode-bati', value: v, checked: etat.mode === v, onchange: () => { etat.mode = v; appliquer(); } }), l)));
    const curseur = h('input', { type: 'range', min: 0.05, max: 0.9, step: 0.05, value: etat.opacite, 'aria-label': 'Opacité du bâti' });
    curseur.addEventListener('input', () => { etat.opacite = +curseur.value; appliquer(); });
    ui.reglages = h('div', {},
      h('div', { class: 'ligne-valeur' }, h('span', {}, 'Opacité')),
      curseur,
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: etat.monumentsOpaques, onchange: (e) => { etat.monumentsOpaques = e.target.checked; appliquer(); } }), 'Garder les monuments opaques (mairie, cathédrale, tour)'));
    ui.toits = h('input', { type: 'checkbox', checked: etat.toits, onchange: (e) => { etat.toits = e.target.checked; majToits(); } });
    ui.toitsLigne = h('label', { class: 'case' }, ui.toits, 'Photo aérienne sur les toits (choisir d\'abord un fond photo)');
    app.toits?.construireCommandes(conteneur);
    conteneur.append(
      h('div', { class: 'titre-info' }, h('h3', {}, 'Affichage'),
        info('Transparent : le sol, les parcelles, le relief et les réseaux se lisent au travers ; les bâtiments transparents ne portent plus d\'ombre. Touche B pour changer de mode.')),
      ui.modes,
      ui.reglages,
      ui.toitsLigne,
    );
    conteneur.append(
      h('div', { class: 'titre-info' }, h('h3', {}, 'Vue photographique en 3D'),
        info('La 3D photographique de Google ne peut pas être intégrée à l\'atlas depuis l\'Europe. Ces boutons ouvrent le même point de vue dans un autre onglet.')),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton', onclick: ouvrirGoogleEarth }, 'Ouvrir dans Google Earth'),
        h('button', { type: 'button', class: 'bouton discret', onclick: ouvrirGoogleMaps }, 'Google Maps 3D')),
    );
    majUI();
    majToits();
  }

  function modeSuivant() {
    etat.mode = { opaque: 'transparent', transparent: 'masque', masque: 'opaque' }[etat.mode];
    appliquer();
    app.signaler(`Bâti ${{ opaque: 'opaque', transparent: 'transparent', masque: 'masqué' }[etat.mode]}.`);
  }

  app.on('fond', majToits);

  return { appliquer, construireCommandes, modeSuivant, majToits, ouvrirGoogleEarth, etat, get masque() { return etat.mode === 'masque'; } };
}
