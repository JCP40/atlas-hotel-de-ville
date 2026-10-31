import * as THREE from 'three';

// Création d'éléments : h('button', { class: 'x', onclick: fn }, 'texte', enfant…)
export function h(tag, attrs = {}, ...enfants) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const e of enfants.flat()) {
    if (e == null || e === false) continue;
    el.append(e instanceof Node ? e : document.createTextNode(String(e)));
  }
  return el;
}

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export const mouvementReduit = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Déplacement de caméra en douceur (position et cible)
export function allerVers(app, position, cible, duree = 1800) {
  if (app.vue2D && app.vue) return app.vue.allerVers2D(position, cible, Math.min(duree, 1400));
  return new Promise((fini) => {
    const p0 = app.camera.position.clone();
    const c0 = app.controls.target.clone();
    const p1 = new THREE.Vector3(...position);
    const c1 = new THREE.Vector3(...cible);
    if (mouvementReduit() || duree <= 0) {
      app.camera.position.copy(p1);
      app.controls.target.copy(c1);
      app.controls.update();
      fini();
      return;
    }
    const t0 = performance.now();
    app.animationCamera = (maintenant) => {
      const t = Math.min((maintenant - t0) / duree, 1);
      const e = easeInOutCubic(t);
      app.camera.position.lerpVectors(p0, p1, e);
      // légère élévation en milieu de trajet, pour survoler plutôt que traverser
      app.camera.position.y += Math.sin(Math.PI * e) * Math.min(p0.distanceTo(p1) * 0.15, 120);
      app.controls.target.lerpVectors(c0, c1, e);
      if (t >= 1) { app.animationCamera = null; fini(); }
    };
  });
}

// Position de caméra décrite en « lat/lon/hauteur » ou en mètres locaux [x,y,z]
export function versVecteur(app, v, hauteurDefaut = 0) {
  if (Array.isArray(v)) return v;
  if (v && v.lat != null) {
    const { x, z } = app.proj.versLocal(v.lat, v.lon);
    return [x, v.hauteur ?? hauteurDefaut, z];
  }
  return [0, hauteurDefaut, 0];
}

export const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export function jourDeLAnnee(d) {
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 86400000);
}

export function dateDepuisJour(annee, jour) {
  const d = new Date(Date.UTC(annee, 0, jour));
  return { annee, mois: d.getUTCMonth(), jour: d.getUTCDate() };
}

export function echapper(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Mise en forme légère des textes de fiches : **gras**, *italique*, [lien](url)
export function texteRiche(s) {
  return echapper(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+|[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// Petite icône « i » : infobulle au survol (title), panneau lisible au clic ou au clavier (Entrée, Espace),
// fermé par Échap ou un nouveau clic. Remplace les textes explicatifs, sources et références des panneaux.
export function info(...contenu) {
  const textes = contenu.flat().filter((c) => c != null && c !== false);
  const resume = textes.map((c) => (c instanceof Node ? c.textContent : String(c))).join(' ').replace(/\s+/g, ' ').trim();
  const panneau = h('div', { class: 'info-panneau', role: 'note', hidden: true },
    ...textes.map((c) => (c instanceof Node ? c : h('p', {}, String(c)))));
  const bouton = h('button', {
    type: 'button', class: 'info-bouton', 'aria-expanded': 'false', 'aria-label': 'Informations et sources',
    title: resume.length > 260 ? `${resume.slice(0, 257)}…` : resume,
    onclick: () => { const ouvert = panneau.hidden; panneau.hidden = !ouvert; bouton.setAttribute('aria-expanded', String(ouvert)); },
    onkeydown: (e) => { if (e.key === 'Escape' && !panneau.hidden) { panneau.hidden = true; bouton.setAttribute('aria-expanded', 'false'); } },
  }, 'i');
  return h('span', { class: 'info' }, bouton, panneau);
}

// localStorage protégé : null (lecture) ou rien (écriture) si le stockage est indisponible
// (navigation privée, site bloqué, quota) ; ecrireLS(k, null) retire la clé.
export const lireLS = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
export function ecrireLS(k, v) {
  try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* stockage indisponible */ }
}

// Vide un groupe Three.js en libérant géométries, matériaux et textures de ses objets
// (à n'utiliser que pour des groupes dont les matériaux ne sont pas partagés ailleurs).
export function viderGroupe(g) {
  g.traverse((o) => {
    if (o === g) return;
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { m.map?.dispose(); m.dispose(); }
  });
  g.clear();
}
