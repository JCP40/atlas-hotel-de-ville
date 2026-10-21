import * as THREE from 'three';

// Étiquettes HTML accrochées à des points 3D : texte net, typographie de l'atlas, cliquables.
export function creerEtiquettes(app) {
  const conteneur = document.getElementById('etiquettes');
  const liste = [];
  const v = new THREE.Vector3();

  function ajouter({ texte, position, classe = '', fiche = null, visibleSi = null, distanceMax = 1400, groupe = null, toujours = false, centre = false }) {
    const el = document.createElement(fiche ? 'button' : 'div');
    el.className = `etiquette ${classe}`;
    el.textContent = texte;
    if (fiche) {
      el.type = 'button';
      el.addEventListener('click', (e) => { e.stopPropagation(); app.fiches.ouvrir(fiche); });
    }
    conteneur.appendChild(el);
    const item = { el, position, visibleSi, distanceMax, groupe, toujours, centre };
    liste.push(item);
    return item;
  }

  function retirerGroupe(groupe) {
    for (let i = liste.length - 1; i >= 0; i--) {
      if (liste[i].groupe === groupe) { liste[i].el.remove(); liste.splice(i, 1); }
    }
  }

  function maj() {
    const w = window.innerWidth, h = window.innerHeight;
    const cam = app.camera;
    const masquer = !app.couches.etiquettes || app.parcours?.actif;
    const dPlan = app.vue2D ? app.vue.distanceEquivalente() : null;
    for (const it of liste) {
      let ok = (!masquer || it.toujours) && (!it.visibleSi || it.visibleSi(app));
      // vue maquette coupée : pas d'étiquette hors du plateau (bâtiment coupé)
      if (ok && !it.toujours && app.decoupe?.actif && !app.decoupe.dedans(it.position)) ok = false;
      if (ok) {
        v.copy(it.position);
        if (app.relief?.actif) v.y += app.relief.dz(v.x, v.z); // étiquette posée sur le terrain
        const d = dPlan ?? cam.position.distanceTo(v);
        v.project(cam);
        ok = v.z < 1 && v.z > -1 && d < it.distanceMax && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
        if (ok) {
          it.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) ${it.centre ? 'translate(-50%, -50%)' : 'translate(-50%, -100%)'}`;
        }
      }
      if (it.el.hidden === ok) it.el.hidden = !ok;
    }
  }

  return { ajouter, retirerGroupe, maj, liste };
}
