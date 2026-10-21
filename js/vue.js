import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { easeInOutCubic, mouvementReduit } from './util.js';

// Deux manières de regarder le site : la maquette en perspective, et le plan vu de dessus,
// nord en haut, sans déformation (projection orthogonale), comme un plan masse ombré.
export function creerVue(app) {
  const cam3 = app.camera;
  const ctl3 = app.controls;
  const DEMI = 200; // demi-hauteur visible (m) au zoom 1
  const ortho = new THREE.OrthographicCamera(-DEMI, DEMI, DEMI, -DEMI, 1, 6000);
  let ctl2 = null;
  let decalage3D = new THREE.Vector3(-260, 230, 320);
  app.vue2D = false;

  function cadrerFrustum() {
    const a = window.innerWidth / window.innerHeight;
    ortho.left = -DEMI * a; ortho.right = DEMI * a; ortho.top = DEMI; ortho.bottom = -DEMI;
    ortho.updateProjectionMatrix();
  }
  window.addEventListener('resize', cadrerFrustum);
  cadrerFrustum();

  function placerOrtho(cible) {
    ortho.position.set(cible.x, 1500, cible.z + 0.01);
    ortho.lookAt(cible.x, 0, cible.z);
  }

  function basculer(vers2D = !app.vue2D) {
    if (vers2D === app.vue2D) return;
    if (vers2D) {
      if (app.parcours?.actif) app.parcours.arreter();
      if (app.coupes?.etat.actif) app.coupes.desactiver();
      const cible = ctl3.target.clone().setY(0);
      decalage3D = cam3.position.clone().sub(ctl3.target);
      const d = cam3.position.distanceTo(ctl3.target);
      const visible = 2 * d * Math.tan(THREE.MathUtils.degToRad(cam3.fov / 2));
      ortho.zoom = THREE.MathUtils.clamp((2 * DEMI) / visible, 0.25, 40);
      ortho.updateProjectionMatrix();
      placerOrtho(cible);
      ctl3.enabled = false;
      ctl2 = new OrbitControls(ortho, app.renderer.domElement);
      ctl2.enableRotate = false;
      ctl2.screenSpacePanning = true;
      ctl2.enableDamping = true;
      ctl2.dampingFactor = 0.1;
      ctl2.minZoom = 0.25;
      ctl2.maxZoom = 40;
      ctl2.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      ctl2.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
      ctl2.target.copy(cible);
      ctl2.update();
      app.camera = ortho;
      app.controls = ctl2;
    } else {
      const cible = ctl2.target.clone().setY(0);
      // hauteur de vue équivalente au zoom du plan
      const visible = (2 * DEMI) / ortho.zoom;
      const d = visible / (2 * Math.tan(THREE.MathUtils.degToRad(cam3.fov / 2)));
      ctl3.target.copy(cible);
      cam3.position.copy(cible).add(decalage3D.clone().setLength(d));
      ctl2.dispose();
      ctl2 = null;
      ctl3.enabled = true;
      ctl3.update();
      app.camera = cam3;
      app.controls = ctl3;
    }
    app.vue2D = vers2D;
    document.body.classList.toggle('vue-2d', vers2D);
    app.emettre('vue', vers2D ? '2d' : '3d');
  }

  // Déplacement doux en plan : on recentre et on ajuste le zoom
  function allerVers2D(position, cible, duree = 1400) {
    const t1 = new THREE.Vector3(cible[0], 0, cible[2]);
    const d = new THREE.Vector3(...position).distanceTo(new THREE.Vector3(...cible));
    const visible = 2 * d * Math.tan(THREE.MathUtils.degToRad(cam3.fov / 2));
    const z1 = THREE.MathUtils.clamp((2 * DEMI) / visible, 0.25, 40);
    const t0 = ctl2.target.clone(), z0 = ortho.zoom;
    return new Promise((fini) => {
      if (mouvementReduit() || duree <= 0) {
        ctl2.target.copy(t1); ortho.zoom = z1; ortho.updateProjectionMatrix(); placerOrtho(t1); ctl2.update(); fini(); return;
      }
      const debut = performance.now();
      app.animationCamera = (n) => {
        const u = Math.min((n - debut) / duree, 1);
        const e = easeInOutCubic(u);
        ctl2.target.lerpVectors(t0, t1, e);
        ortho.zoom = z0 + (z1 - z0) * e;
        ortho.updateProjectionMatrix();
        placerOrtho(ctl2.target);
        if (u >= 1) { app.animationCamera = null; fini(); }
      };
    });
  }

  function metresParPixel() {
    if (app.vue2D) return (ortho.top - ortho.bottom) / ortho.zoom / window.innerHeight;
    const d = cam3.position.distanceTo(ctl3.target);
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(cam3.fov / 2))) / window.innerHeight;
  }

  // distance équivalente (en perspective) pour décider de l'affichage des étiquettes en plan
  function distanceEquivalente() {
    return (metresParPixel() * window.innerHeight) / (2 * Math.tan(THREE.MathUtils.degToRad(cam3.fov / 2)));
  }

  return { basculer, allerVers2D, metresParPixel, distanceEquivalente, ortho, get est2D() { return app.vue2D; } };
}
