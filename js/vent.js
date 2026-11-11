import * as THREE from 'three';
import { h, allerVers, info, lireLS, ecrireLS } from './util.js';
import {
  chargerMeteo, rose, normales, horaire, depassementsParMetre, mention, avertissement, libelleSaison, libelleTemperature, annee,
  SAISONS, TEMPERATURES, NOMS16, MOIS,
} from './meteo.js';
import { lignesLocales } from './geo.js';
import { geometriesPlates, visibiliteBatiment } from './maquette.js';
import {
  N, H, HALF, versCalcul, versAtlas, TYPES_EFFETS, preparerBatiments, creerGrille, creerSolveur, detecterEffets,
  NC, CH, CHALF, CLASSES_CONFORT, classeConfort, rapportsSecteurs, probabilitesDepassement,
  creerBibliotheque, echantillonChamp, preparerSillages, SECTEURS_BIBLIO, CONE_SILLAGE,
  HAUTEUR_PIETON, PROFIL, MELANGE, facteurProfil, filtrerHauteur, poidsMelange,
} from './vent-calcul.js';

const SEUILS = [[3, '3 m/s (pour comparer les lieux)'], [4, '4 m/s (rester assis)'], [5, '5 m/s (usage courant, NEN 8100)'], [8, '8 m/s (marche rapide)']];
const NOMS12 = ['N', 'NNE', 'ENE', 'E', 'ESE', 'SSE', 'S', 'SSO', 'OSO', 'O', 'ONO', 'NNO']; // secteurs de 30° centrés sur k × 30°
const SAISONS4 = [['hiver', 'Hiver', [11, 0, 1]], ['printemps', 'Printemps', [2, 3, 4]], ['ete', 'Été', [5, 6, 7]], ['automne', 'Automne', [8, 9, 10]]];
const COULEURS_VENT = ['#b7cbd9', '#6f93b1', '#2f4f6f']; // comme la rose de l'outil Climat
const HISTO = 8; // positions gardées par particule (traînée)
const MAX = 8000; // particules au plus
const TEMPS = 12; // accélération de l'animation (comme la page d'origine)
// hauteur du vent visualisé (07/11/2026) : 1,5 m (piéton, défaut), 5, 10, 25, 50 m, ou libre de 1 à 100 m
// (localStorage atlas-hdv-vent-hauteur, clé `hauteur` des vues ; profil et bâti à la hauteur z : js/vent-calcul.js)
export const HAUTEURS = [1.5, 5, 10, 25, 50];
const CLE_HAUTEUR = 'atlas-hdv-vent-hauteur';
const hauteurValide = (z) => { const v = Math.round(+z * 10) / 10; return Number.isFinite(v) ? Math.max(1, Math.min(100, v)) : HAUTEUR_PIETON; };
const texteHauteur = (z) => String(z).replace('.', ',');
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
// Carte de chaleur du vent (07/11/2026) : palette « turbo » (Google, approximation polynomiale de A. Mikhailov, 2019),
// bleu foncé (calme, sillage) → cyan → vert → jaune → orange → rouge (fort), comme les cartes de vitesse des logiciels de CFD.
const turbo = (x) => {
  const t = Math.max(0, Math.min(1, x)), t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
  return [
    0.13572138 + 4.6153926 * t - 42.66032258 * t2 + 132.13108234 * t3 - 152.94239396 * t4 + 59.28637943 * t5,
    0.09140261 + 2.19418839 * t + 4.84296658 * t2 - 14.18503333 * t3 + 4.27729857 * t4 + 2.82956604 * t5,
    0.1066733 + 12.64194608 * t - 60.58204836 * t2 + 110.36276771 * t3 - 89.90310912 * t4 + 27.34824973 * t5,
  ].map((v) => Math.round(255 * Math.max(0, Math.min(1, v))));
};
export const STOPS_CARTE = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map((u) => [u, turbo(u)]);
// Mode « Vitesse (m/s) » (07/11/2026, demande de l'utilisateur) : échelle CONTINUE bleu foncé → bleu → vert → jaune → orange → rouge,
// interpolée linéairement entre ces six couleurs (dégradé lisse, sans paliers) ; même table dans le shader (paletteVitesse),
// pour les particules (couleurVitesse) et dans la légende. Le mode « Rapport au vent libre » garde la palette « turbo ».
export const STOPS_VITESSE = [
  [0, [8, 29, 96]], [0.2, [33, 113, 222]], [0.42, [35, 163, 78]], [0.62, [250, 222, 40]], [0.8, [247, 136, 22]], [1, [204, 24, 30]],
];
// bornes rondes de l'échelle (m/s) : vitesse du vent libre × facteur d'accélération, arrondie à la valeur supérieure
const BORNES_RONDES = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30];
export const borneRonde = (v) => BORNES_RONDES.find((b) => b >= v - 1e-6) ?? Math.ceil(v / 5) * 5;
// pas des graduations : 4 à 6 intervalles ronds (5, 6 → 1 ; 8, 10, 12 → 2 ; 15 → 3 ; 20 → 4 ; 30 → 5)
export const pasGraduation = (max) => [0.5, 1, 2, 2.5, 3, 4, 5, 10].find((p) => max / p <= 6 && Math.abs(max / p - Math.round(max / p)) < 1e-6) ?? max / 4;
const couleurVitesse = (x) => {
  const t = Math.max(0, Math.min(1, x));
  let k = 1;
  while (k < STOPS_VITESSE.length - 1 && STOPS_VITESSE[k][0] < t) k++;
  const [u0, a] = STOPS_VITESSE[k - 1], [u1, b] = STOPS_VITESSE[k], f = (t - u0) / (u1 - u0);
  return [0, 1, 2].map((i) => (a[i] + (b[i] - a[i]) * f) / 255);
};
// sillage animé : distance parcourue par les tourbillons = 0,8 × vent libre (vitesse de convection d'une allée de Kármán),
// défilement accéléré × 4 pour la lecture : proportionnel au vent, sans plancher ni plafond (avant : 3,2 V borné à 6-30 m/s)
const DERIVE_SILLAGE = 0.8 * 4;
// emprise de la carte (07/11/2026) : rayons proposés (0 = complète), marge de calcul autour, haute résolution jusqu'à 150 m
export const EMPRISES = [50, 75, 100, 150, 200, 0];
const EMPRISE_DEFAUT = 150;
const MARGE_CALCUL = 40;
const HR_MAX = 150;
const LARG_PARAMS = 1024; // largeur de la texture des paramètres des bâtiments (2 texels par bâtiment)
const CLE_EMPRISE = 'atlas-hdv-vent-emprise';
// direction suivant la période (07/11/2026) : '0' = réglage manuel gardé d'une session à l'autre
const CLE_PERIODE = 'atlas-hdv-vent-periode';
// Carte de chaleur du vent, shader (07/11/2026, sillage fin) : vitesse de base en interpolation bicubique (B-spline, 4 lectures
// bilinéaires), masque fin du bâti, fondu de 10 m au bord de l'emprise, et perturbation QUALITATIVE du sillage évaluée à chaque
// pixel pour les (au plus 4) bâtiments « propriétaires » des cellules voisines, pondérés comme une interpolation bilinéaire
// (pas de marche aux bords des sillages) :
// - allée de tourbillons alternés (Lamb-Oseen) : centres espacés d'une demi-longueur d'onde λ/2 (λ = 3,2 W, 14 à 100 m),
//   de part et d'autre de l'axe (± 0,25 W + 0,05 s : cône qui s'élargit), cœur 0,14 W + 0,025 s + 1 m, formation sur ~0,6 W,
//   dissipation exp(-s / (0,5 Lw + 10)) ; composante de la vitesse induite dans le sens du vent (côté extérieur accéléré,
//   côté de l'axe freiné) et creux au cœur ; trois tourbillons évalués, fenêtrés le long du sillage (pas de couture) ;
// - couches de cisaillement depuis les angles de la face au vent : ralenti dedans, survitesse dehors, ondulées (Kelvin-Helmholtz
//   stylisé), entraînées sous le vent et absorbées dans le sillage ; survitesse d'angle au droit des arêtes au vent ;
// - phase uD = distance parcourue par les tourbillons (intégrée en JS : mouvement continu, sans saut quand la vitesse change).
const GLSL_CARTE = /* glsl */ `
varying vec2 vXY;
uniform sampler2D uBase, uFine, uMasque;
uniform highp sampler2D uProp, uParams;
uniform vec3 uGrille;      // demi-emprise (m), cellules par côté, pas (m)
uniform vec4 uFineBox;     // grille fine : x0, y0, côté (m), active
uniform vec4 uMasqueBox;   // masque : x0, y0, côté (m), actif
uniform vec3 uEmprise;     // centre x, y, rayon (m)
uniform vec2 uF, uC;       // sous le vent, transversal
uniform float uV, uD, uSill, uDiv, uLisse, uQualite, uSortie, uPalette;
const int LARG = ${LARG_PARAMS};

// palette du mode Vitesse : interpolation linéaire continue entre les six couleurs de STOPS_VITESSE
vec3 paletteVitesse(float x) {
  float t = clamp(x, 0.0, 1.0);
${STOPS_VITESSE.map(([u, c]) => `  const vec3 P${Math.round(u * 100)} = vec3(${c.map((v) => (v / 255).toFixed(4)).join(', ')});`).join('\n')}
  vec3 c = P0;
${STOPS_VITESSE.slice(1).map(([u, c], i) => {
    const u0 = STOPS_VITESSE[i][0];
    return `  c = mix(c, P${Math.round(u * 100)}, clamp((t - ${u0.toFixed(3)}) / ${(u - u0).toFixed(3)}, 0.0, 1.0));`;
  }).join('\n')}
  return c;
}

vec3 turboVent(float x) {
  float t = clamp(x, 0.0, 1.0), t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
  return clamp(vec3(
    0.13572138 + 4.6153926 * t - 42.66032258 * t2 + 132.13108234 * t3 - 152.94239396 * t4 + 59.28637943 * t5,
    0.09140261 + 2.19418839 * t + 4.84296658 * t2 - 14.18503333 * t3 + 4.27729857 * t4 + 2.82956604 * t5,
    0.1066733 + 12.64194608 * t - 60.58204836 * t2 + 110.36276771 * t3 - 89.90310912 * t4 + 27.34824973 * t5), 0.0, 1.0);
}
vec3 versLineaire(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec4 cubiqueB(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v, s = n * n * n;
  float x = s.x, y = s.y - 4.0 * s.x, z = s.z - 4.0 * s.y + 6.0 * s.x;
  return vec4(x, y, z, 6.0 - x - y - z) * (1.0 / 6.0);
}
// tc : coordonnées en texels (centres en i + 0,5)
float bicubique(sampler2D t, vec2 tc, float n) {
  tc -= 0.5;
  vec2 f = fract(tc); tc -= f;
  vec4 xc = cubiqueB(f.x), yc = cubiqueB(f.y);
  vec4 c = tc.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 o = (c + vec4(xc.yw, yc.yw) / s) / n;
  float s0 = texture(t, o.xz).r, s1 = texture(t, o.yz).r, s2 = texture(t, o.xw).r, s3 = texture(t, o.yw).r;
  float sx = s.x / (s.x + s.y), sy = s.z / (s.z + s.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}
float vitesseBase(vec2 p) {
  float n = uGrille.y;
  vec2 tc = (p + uGrille.x) / uGrille.z;
  float m = uLisse > 0.5 ? bicubique(uBase, tc, n) : texture(uBase, (floor(tc) + 0.5) / n).r;
  if (uFineBox.w > 0.5) {
    vec2 q = (p - uFineBox.xy) / uFineBox.z;
    float nf = float(textureSize(uFine, 0).x);
    float bord = min(min(q.x, 1.0 - q.x), min(q.y, 1.0 - q.y)) * uFineBox.z; // m jusqu'au bord de la grille fine
    if (bord > 0.0) {
      vec2 tf = q * nf;
      float mf = uLisse > 0.5 ? bicubique(uFine, tf, nf) : texture(uFine, (floor(tf) + 0.5) / nf).r;
      m = mix(m, mf, smoothstep(8.0, 24.0, bord));
    }
  }
  return max(m, 0.0);
}
vec4 paramB(int t) { return texelFetch(uParams, ivec2(t % LARG, t / LARG), 0); }

// perturbation (m/s) due au bâtiment b au point p, vent de base B
float perturbation(int b, vec2 p, float B) {
  vec4 q = paramB(2 * b), q2 = paramB(2 * b + 1);
  float f0 = q.x, f1 = q.y, cm = q.z, W = q.w, Lw = q2.x, graine = q2.y;
  float fs = dot(p, uF), sl = fs - f1, sf = fs - f0, n = dot(p, uC) - cm;
  float hw = 0.5 * W, an = abs(n);
  float Z = hw + ${CONE_SILLAGE.marge.toFixed(1)} + ${CONE_SILLAGE.ouverture} * max(sl, 0.0);
  float lat = smoothstep(Z, Z - 4.0, an) * smoothstep(Lw, 0.75 * Lw, sl) * smoothstep(-(3.0 + 0.15 * W), 0.0, sf);
  if (lat <= 0.0) return 0.0;
  float d = 0.0;
  // couches de cisaillement (angles de la face au vent → bords du sillage), ondulées et entraînées sous le vent
  float sfp = max(sf, 0.0);
  float del = 0.7 + 0.05 * sfp;
  float onde = sin(6.2832 * ((sf - 1.3 * uD) / (0.5 * W + 6.0) + graine)) * smoothstep(0.0, 0.4 * W + 2.0, sf);
  float nL = hw + 0.04 * sfp + 0.45 * del * onde;
  float x = (an - nL) / del;
  float aS = smoothstep(-2.0, 0.5, sf) * exp(-max(sl, 0.0) / (0.9 * W + 6.0));
  d += uV * aS * 0.34 * tanh(x) * exp(-0.12 * x * x);
  // survitesse au droit des arêtes de la face au vent (séparation)
  float rcn = 0.12 * W + 1.5;
  vec2 dc = vec2(sf + 0.1 * W, an - hw - 0.6);
  d += uV * 0.26 * exp(-dot(dc, dc) / (rcn * rcn));
  // allée de tourbillons alternés
  if (sl > -0.5 * W) {
    float Lf = max(0.6 * W, 4.0);
    float lam = clamp(3.2 * W, 14.0, 100.0), hl = 0.5 * lam;
    float D = uD + graine * lam;
    float m0 = floor((sl - D) / hl);
    vec2 ind = vec2(0.0);
    float coeur = 0.0;
    int kmax = uQualite > 0.5 ? 1 : 0;
    for (int k = -1; k <= 1; k++) {
      if (k > kmax || k < -kmax) continue;
      float mm = m0 + float(k);
      float sc = D + (mm + 0.5) * hl; // centre du tourbillon (abscisse sous le vent)
      float sig = mod(mm, 2.0) < 1.0 ? 1.0 : -1.0;
      float vie = smoothstep(0.2 * Lf, 1.3 * Lf, sc) * exp(-max(sc, 0.0) / (0.5 * Lw + 10.0)) * smoothstep(Lw, 0.7 * Lw, sc);
      float nv = sig * (0.25 * W + 0.05 * max(sc, 0.0));
      float rc = 0.14 * W + 0.025 * max(sc, 0.0) + 1.0;
      vec2 dr = vec2(sl - sc, n - nv);
      float r2 = dot(dr, dr) + 1e-3, r = sqrt(r2);
      // fenêtre le long du sillage : un tourbillon entre et sort de la somme à 1,5 λ/2, avec un poids nul (pas de couture)
      float fen = 1.0 - smoothstep(0.6 * hl, 1.5 * hl, abs(sl - sc));
      float vt = uV * 0.9 * vie * fen * 1.397 * (rc / r) * (1.0 - exp(-r2 / (rc * rc)));
      ind += sig * vt * vec2(dr.y, -dr.x) / r;
      coeur += uV * 0.45 * vie * fen * exp(-r2 / (0.6 * rc * rc)); // cœur du tourbillon : creux de vitesse
    }
    // le sillage ondule (méandres) : léger déplacement de son axe
    float ph = 6.2832 * ((sl - uD) / lam + graine);
    float nc = 0.22 * W * smoothstep(0.0, 1.5 * W, sl) * sin(ph);
    float sig = 0.45 * W * (1.0 + 0.5 * max(sl, 0.0) / Lw);
    float meandre = exp(-pow(n / sig, 2.0)) - exp(-pow((n - nc) / sig, 2.0));
    float env = smoothstep(0.0, Lf, sl);
    // composante de la vitesse induite dans le sens du vent (moyenne nulle : côté extérieur accéléré, côté de l'axe freiné),
    // creux au cœur des tourbillons, méandres du sillage
    d += env * (ind.x + 0.25 * abs(ind.y) - coeur + 0.35 * uV * meandre * exp(-max(sl, 0.0) / Lw));
  }
  return d * lat;
}

vec4 carteVent(vec2 p) {
  float dist = length(p - uEmprise.xy);
  float a = smoothstep(uEmprise.z, uEmprise.z - 10.0, dist);
  if (a <= 0.0) return vec4(0.0);
  float masque = 1.0;
  if (uMasqueBox.w > 0.5) {
    vec2 qm = (p - uMasqueBox.xy) / uMasqueBox.z;
    if (qm.x >= 0.0 && qm.y >= 0.0 && qm.x <= 1.0 && qm.y <= 1.0) masque = texture(uMasque, qm).r;
  }
  a *= masque;
  float B = vitesseBase(p);
  float d = 0.0;
  if (uSill > 0.5 && masque > 0.02) {
    // propriétaires des 4 cellules voisines (grille du calcul), pondérés comme une interpolation bilinéaire
    vec2 g = (p + uGrille.x) / uGrille.z - 0.5;
    ivec2 i0 = ivec2(floor(g));
    vec2 f = fract(g);
    int N = int(uGrille.y);
    if (uQualite < 0.5) {
      ivec2 ii = clamp(ivec2(floor(g + 0.5)), ivec2(0), ivec2(N - 1));
      vec2 pr = texelFetch(uProp, ii, 0).rg;
      int o = int(pr.r + 0.5) - 1;
      if (o >= 0) d = pr.g * perturbation(o, p, B);
    } else {
      int o[4]; float w[4];
      for (int k = 0; k < 4; k++) {
        ivec2 ii = clamp(i0 + ivec2(k & 1, k >> 1), ivec2(0), ivec2(N - 1));
        vec2 pr = texelFetch(uProp, ii, 0).rg;
        o[k] = int(pr.r + 0.5) - 1;
        w[k] = ((k & 1) == 1 ? f.x : 1.0 - f.x) * ((k >> 1) == 1 ? f.y : 1.0 - f.y) * pr.g;
      }
      for (int k = 0; k < 4; k++) {
        if (o[k] < 0) continue;
        bool vu = false;
        float ws = w[k];
        for (int j = 0; j < 4; j++) {
          if (j < k && o[j] == o[k]) vu = true;
          if (j > k && o[j] == o[k]) ws += w[j];
        }
        if (!vu) d += ws * perturbation(o[k], p, B);
      }
    }
  }
  float m = max(0.0, B + d * smoothstep(0.02, 0.6, masque));
  vec3 c = uPalette > 0.5 ? paletteVitesse(m / uDiv) : turboVent(m / uDiv);
  return vec4(uSortie > 0.5 ? c : versLineaire(c), a);
}
`;
const AFFICHAGES = [['particules', 'Particules'], ['carte', 'Carte de chaleur'], ['deux', 'Les deux']];
const ANIMATIONS = [['direction', 'Tour des directions'], ['journee', 'Journée type du mois choisi'], ['saisons', 'Les 4 saisons']];
// petit écran ou pointeur grossier (téléphone, tablette) : haute résolution désactivée par défaut
const petitEcran = () => {
  try { return matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700; } catch { return false; }
};
const couleurRapport = (c, rapport) => {
  const q = Math.max(0, Math.min(1, (rapport - 0.15) / 1.6)); // abrité (bleu) -> accéléré (rouge)
  return c.setHSL((210 - q * 190) / 360, 0.95, 0.42);
};

// Signature de la géométrie réellement passée au calcul (preparerBatiments : e.polys, e.hauteur ; base filtrée) :
// sommets de chaque anneau arrondis au décimètre, hauteur et base au centimètre, mélangés en hachage 32 bits
// (FNV-1a + Math.imul). Somme des empreintes (indépendante de l'ordre) et xor de hachages décalés, rendus en base 36.
// Déterministe ; une rotation, un changement de taille ou de forme d'un volume change la signature (07/11/2026).
function signatureBati(empreintes) {
  let somme = 0, mix = 0;
  for (const e of empreintes) {
    let x = 0x811c9dc5;
    const m = (v) => { x = Math.imul(x ^ (v | 0), 0x01000193); x ^= x >>> 15; };
    m(Math.round((e.hauteur ?? 0) * 100)); m(Math.round((e.base ?? 0) * 100));
    for (const poly of e.polys || []) {
      m(0x5a5a); // séparateur de polygone
      for (const anneau of poly || []) {
        m(anneau?.length ?? 0);
        for (const p of anneau || []) { m(Math.round(p[0] * 10)); m(Math.round(p[1] * 10)); }
      }
    }
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b); x ^= x >>> 13;
    somme = (somme + x) | 0;
    mix ^= Math.imul(x, 0x9e3779b1) ^ (x >>> 7);
  }
  return `${(somme >>> 0).toString(36)}.${(mix >>> 0).toString(36)}`;
}

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
    grille: null, cleGrille: null, entree: null, effets: null, R: null, P: null, calculEnCours: false,
    // carte de chaleur du vent (07/11/2026)
    affichage: 'particules', carteValeur: 'vitesse', echelleAuto: true, opaciteCarte: 0.85, lisser: true, sillageAnime: true,
    animMode: 'direction', animVitesse: 1, animation: false,
    // emprise de la carte et haute résolution (07/11/2026) : mémorisées (localStorage atlas-hdv-vent-emprise), reprises par les vues
    emprise: EMPRISE_DEFAUT, hauteResolution: !petitEcran(), centreEmprise: null, adaptatif: true,
    // direction (et vitesse) suivant la période choisie (07/11/2026) : secteur dominant de rose(12, saison, température)
    suitPeriode: lireLS(CLE_PERIODE) !== '0',
    // hauteur du vent visualisé (m) : carte, sillage, particules, confort au vent (07/11/2026)
    hauteur: lireLS(CLE_HAUTEUR) ? hauteurValide(lireLS(CLE_HAUTEUR)) : HAUTEUR_PIETON,
  };
  // solveur de la hauteur affichée (calcul exact publié : double tampon, voir calculExact)
  Object.defineProperty(etat, 'solveurH', { get: () => etat.entree?.solveur ?? null });
  // solveur « piéton » pour les autres outils (Chaleur lit app.vent.etat.solveur) : à 1,5 m, celui de la carte ; à une autre
  // hauteur, celui de la grille à 1,5 m s'il est à jour pour la direction et la vitesse du panneau, sinon null (Chaleur estime
  // alors l'abri par l'ouverture au ciel) : jamais le champ à 25 m pour un calcul au sol
  Object.defineProperty(etat, 'solveur', { get: () => {
    if (etat.hauteur === HAUTEUR_PIETON) return etat.entree?.solveur ?? null;
    const p = [...cacheGrilles.values()].find((e) => e.z === HAUTEUR_PIETON && e.cleBati === etat.entree?.cleBati);
    const sv = p?.solveur;
    return sv && sv.etat.direction === etat.direction && sv.etat.vitesse === etat.vitesse ? sv : null;
  } });
  try {
    const m = JSON.parse(lireLS(CLE_EMPRISE) || 'null');
    if (m && EMPRISES.includes(m.rayon)) etat.emprise = m.rayon;
    if (m && typeof m.hr === 'boolean') etat.hauteResolution = m.hr;
  } catch { /* réglage illisible : défauts */ }
  const memoriserEmprise = () => ecrireLS(CLE_EMPRISE, JSON.stringify({ rayon: etat.emprise, hr: etat.hauteResolution }));
  const ui = {};
  const bilans = new Map(); // parts des classes de confort, par « avec/sans projet | saison | seuil »
  const cacheGrilles = new Map(); // grilles déjà calculées (bascule avec / sans le projet sans tout refaire)
  let mf = null; // données Météo-France (data/meteo/meteo.json, lues par js/meteo.js)
  let objets = null; // objets Three.js (créés à l'ouverture, détruits à la fermeture)
  const rayonParticules = () => Math.min(300, app.config.rayonEtude, HALF - 20);
  // vent libre à la hauteur choisie (m/s) : vent du panneau (référence 10 m) × facteur du profil (1 jusqu'à 10 m)
  const vitesseLibre = () => (etat.vitesse || 1) * facteurProfil(etat.hauteur);

  async function chargerMF() {
    if (mf === null) mf = (await chargerMeteo()) || false;
    return mf || null;
  }

  // ---------------------------------------------------------------
  // Bâti de l'atlas -> grille du calcul
  // ---------------------------------------------------------------
  // Grille du bâti pour la hauteur z (07/11/2026) : cache par « bâti | hauteur », 3 entrées au plus (la plus ancienne est
  // libérée, jamais celle affichée) ; une entrée = { cle, cleBati, z, fz, grille, solveur (calcul exact publié), travail
  // (calcul en cours), R (rapports de confort), biblio, fine, W (poids du champ du solveur, null à 1,5 m) }.
  function entreeHauteur(z) {
    // bâti effectif : existant non démoli + volumes du projet (js/projet.js), visible à l'époque affichée
    const effectif = app.batiEffectif?.() ?? app.empreintes ?? [];
    const vue = { ...app, vueMaquette: false };
    const base = effectif.filter((e) => visibiliteBatiment(vue, e.cle) && Math.hypot(e.cx, e.cz) <= HALF * Math.SQRT2 + 40);
    // signature du bâti (avant le filtre de hauteur) : la même configuration retrouve sa grille (et ses rapports de confort)
    const cleBati = `${app.etat}|${base.length}|${signatureBati(base)}`;
    const cle = `${cleBati}|z${z}`;
    let entree = cacheGrilles.get(cle);
    if (entree) { cacheGrilles.delete(cle); cacheGrilles.set(cle, entree); return entree; } // le plus récent en dernier
    // à 1,5 m : volumes dont la base est sous 2,5 m (porches, auvents surélevés laissent passer le vent), comme avant ;
    // ailleurs : volumes plus hauts que z (js/vent-calcul.js, filtrerHauteur)
    const empreintes = filtrerHauteur(base, z);
    const grille = creerGrille(preparerBatiments(empreintes));
    entree = { cle, cleBati, z, fz: facteurProfil(z), grille, solveur: creerSolveur(grille), travail: null, enCours: null, R: null, biblio: null, cleBiblio: null, fine: null, W: null };
    cacheGrilles.set(cle, entree);
    if (z !== HAUTEUR_PIETON) entree.W = poidsMelange(grille, z);
    for (const [k, e] of cacheGrilles) {
      if (cacheGrilles.size <= 3) break;
      if (k === cle || e === etat.entree) continue;
      e.biblio?.liberer(); e.fine?.biblio.liberer();
      if (e.enCours) e.enCours.annule = true;
      cacheGrilles.delete(k);
    }
    return entree;
  }
  function preparerGrille() {
    const entree = entreeHauteur(etat.hauteur);
    if (etat.grille && etat.entree === entree) return etat.grille;
    Object.assign(etat, { grille: entree.grille, R: entree.R, P: null, entree, cleGrille: entree.cle });
    carte.cleProp = null; carte.cleMasque = null;
    marquerChamp();
    return etat.grille;
  }

  // Calcul exact d'une entrée pour (direction, vitesse), par lots du générateur `etapes` (≤ 25 ms d'affilée : plus de blocage
  // de 0,12 s), dans un second solveur : le champ publié (entree.solveur) reste entier pendant le calcul, puis les deux
  // solveurs sont échangés. Une demande pour une autre direction annule celle en cours (même entrée) ; la même est partagée.
  // Renvoie le solveur à jour, ou null si le calcul a été annulé.
  function calculExact(entree, d, v, { progres = () => {}, mesure = null } = {}) {
    const pub = entree.solveur;
    if (pub.etat.direction === d && pub.etat.vitesse === v) return Promise.resolve(pub);
    const cle = `${d}|${v}`;
    if (entree.enCours?.cle === cle) return entree.enCours.promesse;
    if (entree.enCours) entree.enCours.annule = true;
    const tache = { cle, annule: false };
    tache.promesse = (async () => {
      const sv = entree.travail ??= creerSolveur(entree.grille);
      const gen = sv.etapes(d, v, 10);
      let t = performance.now(), n = 0;
      while (!gen.next().done) {
        n++;
        if (performance.now() - t > 25) {
          progres(Math.min(0.99, n / 35));
          const a = performance.now();
          await new Promise((r) => setTimeout(r, 0));
          t = performance.now();
          if (mesure) mesure.attente += t - a;
          if (tache.annule) return null;
        }
      }
      if (tache.annule) return null;
      entree.travail = entree.solveur; entree.solveur = sv;
      if (entree.enCours === tache) entree.enCours = null;
      if (entree === etat.entree) marquerChamp();
      return sv;
    })();
    entree.enCours = tache;
    return tache.promesse;
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

  // Calcul du champ et des phénomènes pour la direction et la vitesse choisies, à la hauteur choisie (par lots, voir calculExact) ;
  // renvoie false si un autre calcul l'a remplacé
  async function calculerChamp() {
    const g = preparerGrille(), e = etat.entree;
    const sv = await calculExact(e, etat.direction, etat.vitesse);
    if (!sv || e !== etat.entree || !etat.actif) return false;
    marquerChamp();
    if (etat.animation) { etat.effets = null; if (objets) dessinerEffets(); majEffetsUI(); return true; }
    etat.effets = detecterEffets(g, sv, etat.direction, etat.vitesse, { rayon: rayonParticules(), passages: passages() });
    if (objets) { reinitialiserParticules(); dessinerEffets(); }
    majEffetsUI();
    return true;
  }

  // Champ du vent pour un autre outil (UTCI de Confort, 07/11/2026) : calcul exact pour la direction et la vitesse du panneau
  // (donc la période choisie si la direction la suit), même panneau Vent fermé ; par petits lots (≤ 25 ms d'affilée, l'interface
  // reste fluide). TOUJOURS à 1,5 m (hauteur du piéton), quelle que soit la hauteur de la carte du Vent (07/11/2026).
  // Renvoie { direction, vitesse, hauteur: 1,5, attente, echantillon(x, z, out) } en repère atlas (z sud).
  async function champPour(progres = () => {}) {
    const mesure = { attente: 0 };
    let sv = null;
    for (let essai = 0; essai < 6 && !sv; essai++) {
      while (etat.calculEnCours) { const a = performance.now(); await new Promise((r) => setTimeout(r, 20)); mesure.attente += performance.now() - a; }
      sv = await calculExact(entreeHauteur(HAUTEUR_PIETON), etat.direction, etat.vitesse, { progres, mesure });
    }
    sv ??= entreeHauteur(HAUTEUR_PIETON).solveur; // curseur encore en mouvement : dernier calcul exact
    return { direction: sv.etat.direction, vitesse: sv.etat.vitesse, hauteur: HAUTEUR_PIETON, attente: mesure.attente, echantillon: (x, z, out) => sv.echantillon(x, -z, out) };
  }

  let minuterieCalcul = 0;
  function recalculer() {
    clearTimeout(minuterieCalcul);
    note(`Calcul de l'écoulement${etat.hauteur !== HAUTEUR_PIETON ? ` à ${texteHauteur(etat.hauteur)} m` : ''}…`);
    minuterieCalcul = setTimeout(async () => {
      if (!etat.actif) return;
      // (le calcul des rapports de confort, par lots lui aussi, n'est plus attendu)
      const t0 = performance.now();
      if (await calculerChamp()) note(texteCalcul(performance.now() - t0));
    }, 30);
  }
  function texteCalcul(ms) {
    const n = etat.grille.batiments.length;
    return etat.hauteur === HAUTEUR_PIETON ? `Écoulement calculé en ${Math.round(ms)} ms (${n} bâtiments).`
      : `Écoulement à ${texteHauteur(etat.hauteur)} m calculé en ${Math.round(ms)} ms (${n} bâtiment${n > 1 ? 's' : ''} plus haut${n > 1 ? 's' : ''} que ${texteHauteur(etat.hauteur)} m).`;
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
    objets.etiquette.el.textContent = etat.hauteur === HAUTEUR_PIETON ? `Vent ${texteDirection()}, ${nombre(etat.vitesse)} m/s`
      : `Vent ${texteDirection()}, ${nombre(vitesseLibre())} m/s à ${texteHauteur(etat.hauteur)} m`;
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
    libererCarte();
    app.scene.remove(objets.groupe);
    libererObjet(objets.groupe);
    app.etiquettes.retirerGroupe('vent');
    app.etiquettes.retirerGroupe('vent-fleche');
    objets = null;
  }

  // ---------------------------------------------------------------
  // Particules (repère du calcul : x est, y nord)
  // ---------------------------------------------------------------
  const out = [0, 0], pert = [0, 0];
  function bloque(x, y) { return etat.grille ? etat.grille.estPlein(x, y) : true; }

  function placer(i) {
    const R = rayonCarte(), o = objets;
    for (let t = 0; t < 12; t++) {
      const r = R * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
      const [cx, cy] = centreCarte(), x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
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
    if (!o || !etat.grille || !champ.U) return;
    o.lignes.visible = particulesVisibles();
    if (!o.lignes.visible) return;
    const R2 = rayonCarte() ** 2, n = Math.min(etat.densite, MAX);
    const CU = champ.U, CV = champ.V, [ccx, ccy] = centreCarte();
    // sillage animé (07/11/2026) : les particules suivent aussi la perturbation qualitative des tourbillons (comme la carte),
    // pour que le sillage se voie en mode « Particules » seul
    const sill = etat.sillageAnime;
    if (sill) majSillages();
    const S = sill ? carte.S : null, V = vitesseLibre(), D = carte.D;
    const echantillon = (x, y, r) => {
      if (!echantillonChamp(CU, CV, x, y, r)) return false;
      if (S && perturbationParticule(x, y, V, D, pert)) {
        r[0] += pert[0] * S.fx + pert[1] * S.cx;
        r[1] += pert[0] * S.fy + pert[1] * S.cy;
      }
      return true;
    };
    if (!etat.pause) {
      for (let i = 0; i < n; i++) {
        if (!echantillon(o.x[i], o.y[i], out)) { placer(i); continue; }
        o.x[i] += out[0] * dt * TEMPS;
        o.y[i] += out[1] * dt * TEMPS;
        o.age[i] += 1;
        if (o.age[i] > o.vie[i] || (o.x[i] - ccx) ** 2 + (o.y[i] - ccy) ** 2 > R2 || bloque(o.x[i], o.y[i])) { placer(i); continue; }
        echantillon(o.x[i], o.y[i], out);
        o.rapport[i] = Math.hypot(out[0], out[1]) / V;
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
    // couleur : mode Vitesse = même échelle continue que la carte (m/s, 0 → borne ronde) ; mode Rapport = teinte d'origine
    const enVitesse = etat.carteValeur !== 'rapport';
    if (enVitesse) majRatio();
    const ech = enVitesse ? echelleVitesse() : 1;
    const yp = etat.hauteur; // particules posées à la hauteur du vent visualisé
    for (let i = 0; i < n; i++) {
      if (enVitesse) { const c = couleurVitesse(((o.rapport[i] || 1) * V) / ech); coul.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace); } else couleurRapport(coul, o.rapport[i] || 1);
      const b = i * HISTO;
      for (let m = 0; m < HISTO - 1; m++) {
        const a0 = 1 - m / (HISTO - 1), a1 = 1 - (m + 1) / (HISTO - 1);
        for (const [q, a] of [[m, a0], [m + 1, a1]]) {
          const x = o.hx[b + q], z = o.hz[b + q];
          P[v * 3] = x; P[v * 3 + 1] = yp + (relief ? app.relief.dz(x, z) : 0); P[v * 3 + 2] = z;
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
  // Champ affiché et carte de chaleur du vent (07/11/2026 ; sillage fin, emprise réglable : 07/11/2026)
  // ---------------------------------------------------------------
  // Champ « courant » (particules et carte) : le calcul exact de la direction et de la vitesse réglées s'il est à jour,
  // sinon le mélange des deux directions voisines de la bibliothèque (vent-calcul.js, 24 directions à 1 m/s × vitesse),
  // calculée dans la seule emprise choisie (+ 40 m de marge). Haute résolution : seconde bibliothèque sur une grille de 1,75 m.
  // La carte est dessinée par un shader (matériau MeshBasic modifié) : vitesse de base en interpolation bicubique
  // (grille de 3,5 m, ou 1,75 m en haute résolution), bâti découpé au masque fin (0,75 m à 1 m, 0,5 m en haute résolution),
  // et perturbation du sillage animé évaluée à chaque pixel (tourbillons, couches de cisaillement, angles) : le CPU ne
  // renvoie au GPU que la vitesse de base (quand le champ change) et les « propriétaires » des sillages (quand la direction change).
  const tampon = { U: new Float32Array(N * N), V: new Float32Array(N * N), M: new Float32Array(N * N) };
  const champ = { U: null, V: null, M: tampon.M, source: null, approche: false, version: 0, fine: null };
  let champSale = true;
  const carte = {
    mesh: null, u: null, tex: {}, baseSale: true, echelle: 10, D: 0, cleProp: null, dirProp: null, cleMasque: null,
    ms: { base: 0, sillage: 0, masque: 0 }, prets: 0, pretsFine: 0, nbProp: 0, ordre: new Map(),
    // adaptation automatique : durées d'image (s) pendant l'animation, niveau d'allègement (0 : complet)
    durees: [], niveau: 0, message: '',
  };
  const carteVisible = () => etat.affichage !== 'particules';
  const particulesVisibles = () => etat.affichage !== 'carte';
  function marquerChamp() { champSale = true; }

  // emprise de la carte : rayon (m), centre (repère du calcul), fenêtre de cellules du calcul (null : toute la grille)
  const rayonCarte = () => (etat.emprise ? Math.min(etat.emprise, rayonParticules()) : rayonParticules());
  const centreCarte = () => etat.centreEmprise || [0, 0];
  const empriseComplete = () => !etat.emprise || etat.emprise >= rayonParticules();
  function fenetreCarte() {
    if (empriseComplete() && !etat.centreEmprise) return null;
    const [cx, cy] = centreCarte(), r = rayonCarte() + MARGE_CALCUL;
    const c = (v) => Math.floor((v + HALF) / H);
    return { i0: Math.max(0, c(cx - r)), i1: Math.min(N - 1, c(cx + r)), j0: Math.max(0, c(cy - r)), j1: Math.min(N - 1, c(cy + r)) };
  }
  const cleFenetre = (f) => (f ? `${f.i0},${f.i1},${f.j0},${f.j1}` : 'tout');
  // haute résolution : seulement dans une emprise réduite (150 m au plus) et non allégée
  const hauteResolutionActive = () => etat.hauteResolution && !empriseComplete() && rayonCarte() <= HR_MAX && carte.niveau < 1;
  const resolutionMasque = () => (hauteResolutionActive() ? 0.5 : rayonCarte() <= 150 ? 0.75 : 1);

  // bibliothèque des directions de l'emprise (refaite quand l'emprise change ; l'ancienne est libérée)
  function bibliotheque() {
    const e = etat.entree;
    if (!e || !etat.grille) return null;
    const f = fenetreCarte(), cle = cleFenetre(f);
    if (e.biblio && e.cleBiblio === cle) return e.biblio;
    e.biblio?.liberer();
    e.biblio = creerBibliotheque(etat.grille, SECTEURS_BIBLIO, { fenetre: f });
    e.cleBiblio = cle;
    carte.prets = 0;
    marquerChamp();
    return e.biblio;
  }
  // bibliothèque fine (haute résolution) : grille de 1,75 m couvrant l'emprise + 30 m, Jacobi plus long
  const tamponFine = { U: null, V: null, M: null };
  function bibliothequeFine() {
    const e = etat.entree;
    if (!e || !etat.grille || !hauteResolutionActive()) return null;
    const [cx, cy] = centreCarte(), r = rayonCarte() + 30, h = H / 2;
    const n = Math.ceil((2 * r) / h);
    const cle = `${cx},${cy},${n}`;
    if (e.fine?.cle === cle) return e.fine.biblio;
    e.fine?.biblio.liberer();
    const grille = creerGrille(etat.grille.batiments, { n, h, x0: cx - (n * h) / 2, y0: cy - (n * h) / 2 });
    e.fine = { cle, grille, biblio: creerBibliotheque(grille, SECTEURS_BIBLIO, { iterations: 500 }) };
    carte.pretsFine = 0;
    marquerChamp();
    return e.fine.biblio;
  }
  function libererFine() {
    const e = etat.entree;
    if (e?.fine) { e.fine.biblio.liberer(); e.fine = null; }
    tamponFine.U = tamponFine.V = tamponFine.M = null;
    champ.fine = null;
  }

  function actualiserChamp() {
    const sv = etat.solveurH;
    if (!sv) return;
    const exact = !etat.animation && sv.etat.direction === etat.direction && sv.etat.vitesse === etat.vitesse;
    const b = bibliotheque();
    let r = null;
    if (!exact && b) r = b.interpoler(etat.direction, etat.vitesse, tampon);
    if (r) {
      Object.assign(champ, { U: tampon.U, V: tampon.V, M: tampon.M, source: 'bibliotheque', approche: r.approche });
    } else {
      // calcul exact (ou, en attendant la bibliothèque, le dernier calcul, ramené à la vitesse réglée)
      const f = sv.etat.vitesse ? etat.vitesse / sv.etat.vitesse : 1;
      if (f === 1) { champ.U = sv.U; champ.V = sv.V; } else {
        for (let i = 0; i < N * N; i++) { tampon.U[i] = sv.U[i] * f; tampon.V[i] = sv.V[i] * f; }
        champ.U = tampon.U; champ.V = tampon.V;
      }
      for (let i = 0; i < N * N; i++) tampon.M[i] = Math.hypot(champ.U[i], champ.V[i]);
      Object.assign(champ, { M: tampon.M, source: exact ? 'exact' : 'provisoire', approche: !exact });
    }
    // haute résolution : mélange de la bibliothèque fine (dès que ses deux directions voisines sont prêtes)
    champ.fine = null;
    const bf = bibliothequeFine();
    if (bf?.prets) {
      const nn = bf.grille.n * bf.grille.n;
      if (tamponFine.M?.length !== nn) { tamponFine.U = new Float32Array(nn); tamponFine.V = new Float32Array(nn); tamponFine.M = new Float32Array(nn); }
      const rf = bf.interpoler(etat.direction, etat.vitesse, tamponFine);
      if (rf && !rf.approche) champ.fine = { M: tamponFine.M, grille: bf.grille };
    }
    melangerHauteur();
    champ.version++;
    carte.baseSale = true;
  }

  // Vent à la hauteur z (07/11/2026) : vent = fz · [w · champ du solveur + (1 − w) · vent libre] (js/vent-calcul.js) ;
  // rien à 1,5 m (W null : champ inchangé). Grille fine : poids de la maille du calcul la plus proche.
  function melangerHauteur() {
    const e = etat.entree, W = e?.W;
    if (!W || !champ.U) return;
    const fz = e.fz, V = etat.vitesse, th = (etat.direction * Math.PI) / 180, uf = -V * Math.sin(th), vf = -V * Math.cos(th);
    const sol = etat.grille.solid, U = champ.U, VV = champ.V, M = champ.M;
    for (let k = 0; k < N * N; k++) {
      if (sol[k]) { tampon.U[k] = 0; tampon.V[k] = 0; tampon.M[k] = 0; continue; }
      const w = W[k], m = fz * (w * M[k] + (1 - w) * V);
      const u = w * U[k] + (1 - w) * uf, v = w * VV[k] + (1 - w) * vf, l = Math.hypot(u, v), f = l > 1e-6 ? m / l : 0;
      tampon.U[k] = u * f; tampon.V[k] = v * f; tampon.M[k] = m;
    }
    champ.U = tampon.U; champ.V = tampon.V; champ.M = tampon.M;
    if (champ.fine) {
      const g = champ.fine.grille, n = g.n, Mf = champ.fine.M;
      for (let j = 0; j < n; j++) {
        const jj = Math.min(N - 1, Math.max(0, Math.floor((g.y0 + (j + 0.5) * g.h + HALF) / H)));
        for (let i = 0; i < n; i++) {
          const ii = Math.min(N - 1, Math.max(0, Math.floor((g.x0 + (i + 0.5) * g.h + HALF) / H)));
          const w = W[jj * N + ii], k = j * n + i;
          Mf[k] = fz * (w * Mf[k] + (1 - w) * V);
        }
      }
    }
  }

  // ordre de remplissage des cellules bâties (de proche en proche depuis les cellules libres) : la vitesse y est
  // prolongée depuis l'extérieur, pour que l'interpolation bicubique ne fonce pas les abords du bâti
  function ordreRemplissage(g) {
    if (carte.ordre.has(g)) return carte.ordre.get(g);
    const n = g.n ?? N, sol = g.solid, vu = new Uint8Array(n * n), ordre = [];
    let front = [];
    for (let k = 0; k < n * n; k++) if (!sol[k]) vu[k] = 1;
    for (let k = 0; k < n * n; k++) {
      if (!sol[k]) continue;
      const i = k % n;
      if ((i > 0 && !sol[k - 1]) || (i < n - 1 && !sol[k + 1]) || (k >= n && !sol[k - n]) || (k < n * n - n && !sol[k + n])) front.push(k);
    }
    while (front.length) {
      for (const k of front) vu[k] = 1;
      ordre.push(...front);
      const suivant = [];
      for (const k of front) {
        const i = k % n;
        for (const v of [i > 0 ? k - 1 : -1, i < n - 1 ? k + 1 : -1, k - n, k + n]) if (v >= 0 && v < n * n && !vu[v] && sol[v]) { vu[v] = 1; suivant.push(v); }
      }
      for (const k of suivant) vu[k] = 0;
      front = suivant;
    }
    const o = Int32Array.from(ordre);
    if (carte.ordre.size > 4) carte.ordre.clear();
    carte.ordre.set(g, o);
    return o;
  }
  // vitesse (m/s) → texture R16F, cellules bâties prolongées depuis leurs voisines libres
  function versDemiFlottants(g, M, sortie) {
    const n = g.n ?? N, sol = g.solid, ordre = ordreRemplissage(g);
    const tmp = carte.tmp?.length === n * n ? carte.tmp : (carte.tmp = new Float32Array(n * n));
    const ok = carte.ok?.length === n * n ? carte.ok : (carte.ok = new Uint8Array(n * n));
    for (let k = 0; k < n * n; k++) { tmp[k] = M[k]; ok[k] = sol[k] ? 0 : 1; }
    // lisser : deux passes de flou [1 2 1] sur les mailles libres (adoucit les marches du sillage estimé du calcul, en escalier)
    if (etat.lisser) {
      const F = carte.flou?.length === n * n ? carte.flou : (carte.flou = new Float32Array(n * n));
      for (let passe = 0; passe < 2; passe++) {
        for (let k = 0; k < n * n; k++) {
          if (sol[k]) { F[k] = tmp[k]; continue; }
          const i = k % n;
          let w = 2, v = 2 * tmp[k];
          if (i > 0 && !sol[k - 1]) { w++; v += tmp[k - 1]; }
          if (i < n - 1 && !sol[k + 1]) { w++; v += tmp[k + 1]; }
          F[k] = v / w;
        }
        for (let k = 0; k < n * n; k++) {
          if (sol[k]) continue;
          let w = 2, v = 2 * F[k];
          if (k >= n && !sol[k - n]) { w++; v += F[k - n]; }
          if (k < n * n - n && !sol[k + n]) { w++; v += F[k + n]; }
          tmp[k] = v / w;
        }
      }
    }
    for (let q = 0; q < ordre.length; q++) {
      const k = ordre[q], i = k % n;
      let s = 0, w = 0;
      if (i > 0 && ok[k - 1]) { s += tmp[k - 1]; w++; }
      if (i < n - 1 && ok[k + 1]) { s += tmp[k + 1]; w++; }
      if (k >= n && ok[k - n]) { s += tmp[k - n]; w++; }
      if (k < n * n - n && ok[k + n]) { s += tmp[k + n]; w++; }
      tmp[k] = w ? s / w : 0; ok[k] = 1;
    }
    for (let k = 0; k < n * n; k++) sortie[k] = THREE.DataUtils.toHalfFloat(tmp[k]);
  }
  function texture(cle, w, hh, donnees, { format = THREE.RedFormat, type = THREE.HalfFloatType, lisse = true } = {}) {
    let t = carte.tex[cle];
    if (!t || t.image.width !== w || t.image.height !== hh || t.image.data.length !== donnees.length) {
      t?.dispose();
      t = new THREE.DataTexture(donnees, w, hh, format, type);
      t.magFilter = t.minFilter = lisse ? THREE.LinearFilter : THREE.NearestFilter;
      t.generateMipmaps = false;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      carte.tex[cle] = t;
    } else t.image.data.set(donnees);
    t.needsUpdate = true;
    return t;
  }

  // vitesse de base : textures (grille du calcul, et grille fine en haute résolution) et échelle auto
  function construireBase() {
    if (!etat.grille || !champ.M) return;
    const t0 = performance.now();
    const g = etat.grille;
    carte.base16 ??= new Uint16Array(N * N);
    versDemiFlottants(g, champ.M, carte.base16);
    carte.u.uBase.value = texture('base', N, N, carte.base16);
    if (champ.fine) {
      const gf = champ.fine.grille, nf = gf.n;
      if (carte.fine16?.length !== nf * nf) carte.fine16 = new Uint16Array(nf * nf);
      versDemiFlottants(gf, champ.fine.M, carte.fine16);
      carte.u.uFine.value = texture('fine', nf, nf, carte.fine16);
      carte.u.uFineBox.value.set(gf.x0, gf.y0, nf * gf.h, 1);
    } else carte.u.uFineBox.value.w = 0;
    majRatio();
    carte.baseSale = false;
    carte.ms.base = performance.now() - t0;
  }

  // Échelle du mode Vitesse (07/11/2026) : 0 → borne ronde (5, 6, 8, 10, 12 m/s…) = vent libre du panneau × facteur d'accélération ;
  // facteur = 98e centile de la carte rapporté au vent libre (+ 0,25 pour les survitesses du sillage animé), au moins 1,3,
  // ou 2 si « Échelle ajustée » est décochée. Le rapport du 98e centile est refait quand le champ change (direction, bâti,
  // emprise) ; il ne dépend pas de la vitesse (calcul proportionnel) : l'échelle suit le curseur « Vitesse du vent libre ».
  function majRatio() {
    if (!etat.grille || !champ.M || carte.versionRatio === champ.version) return;
    carte.versionRatio = champ.version;
    const g = etat.grille, histo = new Uint32Array(301), [cx, cy] = centreCarte(), R2 = rayonCarte() ** 2, M = champ.M;
    const V = vitesseLibre(); // rapport au vent libre de la hauteur choisie
    let nb = 0;
    for (let j = 0; j < N; j++) {
      const y = (j + 0.5) * H - HALF - cy;
      for (let i = 0; i < N; i++) {
        const k = j * N + i, x = (i + 0.5) * H - HALF - cx;
        if (g.solid[k] || x * x + y * y > R2) continue;
        histo[Math.min(300, Math.round((M[k] / V) * 100))]++; nb++;
      }
    }
    let cum = 0, r98 = 1.3;
    for (let i = 0; i <= 300; i++) { cum += histo[i]; if (cum >= 0.98 * nb) { r98 = i / 100; break; } }
    carte.ratio98 = r98;
  }
  function facteurEchelle() {
    return etat.echelleAuto ? Math.max(1.3, (carte.ratio98 ?? 1.5) + (etat.sillageAnime ? 0.25 : 0)) : 2;
  }
  // borne haute de la palette (m/s) : en Vitesse, borne ronde ; en Rapport, 2 × le vent libre (rapport 0-2)
  function echelleVitesse() {
    if (etat.carteValeur === 'rapport') return 2 * vitesseLibre();
    return borneRonde(vitesseLibre() * facteurEchelle());
  }

  // propriétaires des sillages (grille du calcul) et paramètres des bâtiments, refaits quand la direction change de plus de 1°
  // (carte.S sert aussi aux particules : sillage animé visible sans la carte)
  function majSillages() {
    const g = etat.grille, f = fenetreCarte(), cle = `${etat.cleGrille}|${cleFenetre(f)}`;
    if (!g) return;
    if (carte.cleProp === cle && carte.dirProp != null && Math.abs(((etat.direction - carte.dirProp + 540) % 360) - 180) <= 1) return;
    const t0 = performance.now();
    carte.S = preparerSillages(g, etat.direction, f);
    // au-dessus des toits voisins, le sillage animé s'atténue comme l'effet du bâti (poids w du mélange, js/vent-calcul.js)
    const W = etat.entree?.W;
    if (W) for (let k = 0; k < N * N; k++) carte.S.att[k] *= W[k];
    carte.cleProp = cle; carte.dirProp = etat.direction;
    carte.propSale = true;
    carte.ms.sillage = performance.now() - t0;
  }
  function majProprietaires() {
    majSillages();
    if (!carte.propSale || !carte.u || !carte.S) return;
    carte.propSale = false;
    const S = carte.S;
    const prop = carte.prop?.length === 2 * N * N ? carte.prop : (carte.prop = new Float32Array(2 * N * N));
    let nb = 0;
    for (let k = 0; k < N * N; k++) { prop[2 * k] = S.bat[k] + 1; prop[2 * k + 1] = S.att[k]; if (S.bat[k] >= 0) nb++; }
    carte.nbProp = nb;
    carte.u.uProp.value = texture('prop', N, N, prop, { format: THREE.RGFormat, type: THREE.FloatType, lisse: false });
    const nbB = Math.max(1, S.P.length), hp = Math.ceil((2 * nbB) / LARG_PARAMS);
    const par = new Float32Array(LARG_PARAMS * hp * 4);
    S.P.forEach((p, b) => {
      par.set([p.f0, p.f1, p.cm, p.W], 8 * b);
      par.set([p.Lw, p.graine, p.h, 0], 8 * b + 4);
    });
    carte.u.uParams.value = texture('params', LARG_PARAMS, hp, par, { format: THREE.RGBAFormat, type: THREE.FloatType, lisse: false });
    carte.u.uF.value.set(S.fx, S.fy);
    carte.u.uC.value.set(S.cx, S.cy);
  }

  // Perturbation du sillage animé pour les particules (même modèle que perturbation() du shader GLSL_CARTE, un seul
  // bâtiment propriétaire : celui de la maille, pondéré par son atténuation) : out[0] dans le sens du vent, out[1] transversal (m/s).
  const lisseP = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  function perturbationParticule(x, y, V, D, out2) {
    out2[0] = 0; out2[1] = 0;
    const S = carte.S;
    if (!S) return false;
    const i = Math.floor((x + HALF) / H), j = Math.floor((y + HALF) / H);
    if (i < 0 || j < 0 || i >= N || j >= N) return false;
    const k = j * N + i, b = S.bat[k], w = S.att[k];
    if (b < 0 || !(w > 0)) return false;
    const q = S.P[b], W = q.W, Lw = q.Lw, graine = q.graine;
    const fs = x * S.fx + y * S.fy, sl = fs - q.f1, sf = fs - q.f0, n = x * S.cx + y * S.cy - q.cm;
    const hw = 0.5 * W, an = Math.abs(n);
    const Z = hw + CONE_SILLAGE.marge + CONE_SILLAGE.ouverture * Math.max(sl, 0);
    const lat = lisseP(Z, Z - 4, an) * lisseP(Lw, 0.75 * Lw, sl) * lisseP(-(3 + 0.15 * W), 0, sf);
    if (lat <= 0) return false;
    let d = 0, t = 0;
    const sfp = Math.max(sf, 0), del = 0.7 + 0.05 * sfp;
    const onde = Math.sin(6.2832 * ((sf - 1.3 * D) / (0.5 * W + 6) + graine)) * lisseP(0, 0.4 * W + 2, sf);
    const xx = (an - (hw + 0.04 * sfp + 0.45 * del * onde)) / del;
    const aS = lisseP(-2, 0.5, sf) * Math.exp(-Math.max(sl, 0) / (0.9 * W + 6));
    d += V * aS * 0.34 * Math.tanh(xx) * Math.exp(-0.12 * xx * xx);
    if (sl > -0.5 * W) {
      const Lf = Math.max(0.6 * W, 4), lam = Math.max(14, Math.min(100, 3.2 * W)), hl = 0.5 * lam, DD = D + graine * lam;
      const m0 = Math.floor((sl - DD) / hl);
      let ix = 0, iy = 0, coeur = 0;
      for (let kk = -1; kk <= 1; kk++) {
        const mm = m0 + kk, sc = DD + (mm + 0.5) * hl, sig = ((mm % 2) + 2) % 2 < 1 ? 1 : -1;
        const vie = lisseP(0.2 * Lf, 1.3 * Lf, sc) * Math.exp(-Math.max(sc, 0) / (0.5 * Lw + 10)) * lisseP(Lw, 0.7 * Lw, sc);
        const nv = sig * (0.25 * W + 0.05 * Math.max(sc, 0)), rc = 0.14 * W + 0.025 * Math.max(sc, 0) + 1;
        const drx = sl - sc, dry = n - nv, r2 = drx * drx + dry * dry + 1e-3, r = Math.sqrt(r2);
        const fen = 1 - lisseP(0.6 * hl, 1.5 * hl, Math.abs(sl - sc));
        const vt = V * 0.9 * vie * fen * 1.397 * (rc / r) * (1 - Math.exp(-r2 / (rc * rc)));
        ix += (sig * vt * dry) / r; iy += (-sig * vt * drx) / r;
        coeur += V * 0.45 * vie * fen * Math.exp(-r2 / (0.6 * rc * rc));
      }
      const env = lisseP(0, Lf, sl);
      d += env * (ix + 0.25 * Math.abs(iy) - coeur);
      t += env * iy;
    }
    out2[0] = d * lat * w; out2[1] = t * lat * w;
    return true;
  }

  // masque fin du bâti (canevas 2D antialiasé) sur le carré de l'emprise
  function majMasque() {
    const [cx, cy] = centreCarte(), R = rayonCarte() + 12, res = resolutionMasque();
    const cle = `${etat.cleGrille}|${cx},${cy},${R}|${res}`;
    if (carte.cleMasque === cle) return;
    const t0 = performance.now();
    carte.cleMasque = cle;
    const px = Math.min(4096, Math.ceil((2 * R) / res));
    const c = carte.canevas ??= document.createElement('canvas');
    c.width = px; c.height = px;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, px, px);
    // ligne 0 du canevas = nord (y maximal) ; la texture est retournée (flipY) : v = 0 au sud
    const k = px / (2 * R), X = (x) => (x - (cx - R)) * k, Y = (y) => ((cy + R) - y) * k;
    ctx.fillStyle = '#000';
    for (const b of etat.grille.batiments) {
      ctx.beginPath();
      for (const ring of b.r) ring.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      ctx.fill('evenodd');
    }
    let t = carte.tex.masque;
    if (!t || t.image !== c || t.userData.px !== px) {
      t?.dispose();
      t = new THREE.CanvasTexture(c);
      t.userData.px = px;
      t.colorSpace = THREE.NoColorSpace;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      carte.tex.masque = t;
    }
    t.needsUpdate = true;
    carte.u.uMasque.value = t;
    carte.u.uMasqueBox.value.set(cx - R, cy - R, 2 * R, 1);
    carte.ms.masque = performance.now() - t0;
  }

  function creerMeshCarte() {
    const vide = (format = THREE.RedFormat, type = THREE.HalfFloatType) => {
      const t = new THREE.DataTexture(type === THREE.FloatType ? new Float32Array(format === THREE.RGBAFormat ? 4 : format === THREE.RGFormat ? 2 : 1) : new Uint16Array(1), 1, 1, format, type);
      t.needsUpdate = true; return t;
    };
    carte.tex.vides = [vide(), vide(), vide(THREE.RGFormat, THREE.FloatType), vide(THREE.RGBAFormat, THREE.FloatType)];
    const blanc = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); blanc.needsUpdate = true;
    carte.tex.vides.push(blanc);
    const u = carte.u = {
      uBase: { value: carte.tex.vides[0] }, uFine: { value: carte.tex.vides[1] }, uProp: { value: carte.tex.vides[2] },
      uParams: { value: carte.tex.vides[3] }, uMasque: { value: blanc },
      uGrille: { value: new THREE.Vector3(HALF, N, H) }, uFineBox: { value: new THREE.Vector4(0, 0, 1, 0) },
      uMasqueBox: { value: new THREE.Vector4(-HALF, -HALF, 2 * HALF, 0) }, uEmprise: { value: new THREE.Vector3(0, 0, 300) },
      uF: { value: new THREE.Vector2(0, -1) }, uC: { value: new THREE.Vector2(1, 0) },
      uV: { value: 4 }, uD: { value: 0 }, uSill: { value: 1 }, uDiv: { value: 10 }, uLisse: { value: 1 }, uQualite: { value: 1 }, uSortie: { value: 0 }, uPalette: { value: 1 },
    };
    // ligne 0 de la grille = sud : coordonnées du calcul tirées de la position locale du plan (x est, y = -z)
    const geo = new THREE.PlaneGeometry(2 * HALF, 2 * HALF).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: etat.opaciteCarte, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -5.5, polygonOffsetUnits: -11, // au-dessus des surfaces (-5, -10)
    });
    mat.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, u);
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vXY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvXY = vec2(position.x, -position.z);');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', `#include <common>\n${GLSL_CARTE}`)
        .replace('#include <map_fragment>', 'diffuseColor *= carteVent(vXY);');
    };
    mat.customProgramCacheKey = () => 'vent-carte-sillage-fin-2';
    // planche (SVG, js/planche.js) : elle lit material.map.image { data, width, height } d'une DataTexture posée sur le plan ;
    // ici l'image est rendue à la demande par le même shader (instantane), au pas fin, sur toute l'emprise du plan.
    // La texture n'est jamais envoyée au GPU (version 0, map_fragment remplacé) : le rendu ne lit jamais cette image.
    const texPlanche = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    Object.defineProperty(texPlanche, 'image', { configurable: true, get: imagePlanche, set() {} });
    mat.map = texPlanche;
    carte.tex.planche = texPlanche;
    const m = new THREE.Mesh(geo, mat);
    // au-dessus des sols (0,03-0,08 m), sous les noms des rues (0,10 m, -6, renderOrder 3) et les cartes de confort (0,33 m)
    m.position.y = 0.09;
    m.renderOrder = 2;
    m.raycast = () => {};
    m.name = 'vent-carte';
    m.userData.planAnalyse = { width: 2 * HALF, height: 2 * HALF }; // planche : calage même quand le relief a redécoupé le plan
    objets.groupe.add(m);
    carte.mesh = m;
    carte.baseSale = true; carte.cleProp = null; carte.cleMasque = null;
  }

  function libererCarte() {
    for (const [cle, t] of Object.entries(carte.tex)) {
      if (cle === 'vides') t.forEach((x) => x.dispose()); else t?.dispose();
    }
    carte.tex = {};
    carte.mesh = null; carte.u = null; carte.canevas = null;
    carte.base16 = carte.fine16 = carte.prop = carte.tmp = carte.ok = carte.flou = null;
    cachePlanche = null;
    carte.ordre.clear();
    carte.cleProp = carte.cleMasque = null;
  }

  function majCarte(dt) {
    if (!objets) return;
    if (!carteVisible() || !etat.grille || !champ.M) { if (carte.mesh) carte.mesh.visible = false; return; }
    if (!carte.mesh) creerMeshCarte();
    const u = carte.u;
    carte.mesh.visible = true;
    carte.mesh.material.opacity = etat.opaciteCarte;
    if (carte.baseSale) construireBase();
    majMasque();
    if (etat.sillageAnime) majProprietaires();
    const [cx, cy] = centreCarte();
    u.uEmprise.value.set(cx, cy, rayonCarte());
    u.uV.value = vitesseLibre();
    u.uD.value = carte.D % 1e5;
    u.uSill.value = etat.sillageAnime ? 1 : 0;
    majRatio();
    carte.echelle = echelleVitesse();
    u.uDiv.value = carte.echelle;
    u.uPalette.value = etat.carteValeur === 'rapport' ? 0 : 1;
    u.uLisse.value = etat.lisser ? 1 : 0;
    u.uQualite.value = carte.niveau >= 2 ? 0 : 1;
  }

  // adaptation automatique : durée moyenne d'image > 33 ms pendant 2 s d'animation de la carte → allègement
  // (1 : haute résolution coupée ; 2 : sillage simplifié, un seul propriétaire par pixel), message discret
  function surveillerDuree(dt) {
    const b = etat.entree?.biblio;
    if (!etat.adaptatif || !carte.mesh?.visible || !(etat.sillageAnime || etat.animation) || etat.pause || !b?.complet || carte.niveau >= 2) { carte.durees.length = 0; return; }
    carte.durees.push(dt);
    if (carte.durees.length < 60) return;
    const moy = carte.durees.reduce((a, x) => a + x, 0) / carte.durees.length;
    carte.durees.length = 0;
    if (moy <= 0.033) return;
    carte.niveau = hauteResolutionActive() ? 1 : 2;
    if (carte.niveau === 1) { libererFine(); carte.cleMasque = null; marquerChamp(); }
    carte.message = `Affichage allégé automatiquement (≈ ${Math.round(moy * 1000)} ms par image) : ${carte.niveau === 1 ? 'haute résolution coupée' : 'sillage simplifié'}.`;
    majEmpriseUI();
  }
  function retablirQualite() {
    carte.niveau = 0; carte.message = ''; carte.durees.length = 0; carte.cleMasque = null;
    marquerChamp(); majEmpriseUI();
  }

  // image du plan entier (± HALF, centre 0, 0) pour js/planche.js, gardée 1 s (la planche la lit deux fois de suite)
  let cachePlanche = null;
  function imagePlanche() {
    if (cachePlanche && performance.now() - cachePlanche.t < 1000) return cachePlanche.image;
    const im = carte.mesh?.visible ? instantane({ R: HALF, centre: [0, 0], max: 2688 }) : null;
    const image = im ? im.canvas.getContext('2d').getImageData(0, 0, im.canvas.width, im.canvas.height) : { data: new Uint8Array(4), width: 1, height: 1 };
    cachePlanche = { t: performance.now(), image: { data: new Uint8Array(image.data.buffer), width: image.width, height: image.height } };
    return cachePlanche.image;
  }
  // Instantané de la carte pour la planche (SVG) : rendu du plan seul, vu de dessus, dans une cible de rendu,
  // au pas du masque (0,5 à 1 m) sur le carré de l'emprise ; renvoie { canvas, x, z, w, h } en mètres de l'atlas.
  function instantane({ R = rayonCarte(), centre = centreCarte(), max = 4096 } = {}) {
    if (!carte.mesh?.visible) return null;
    const r = app.renderer, [cx, cy] = centre;
    const px = Math.max(64, Math.min(max, Math.round((2 * R) / resolutionMasque())));
    const cam = new THREE.OrthographicCamera(-R, R, R, -R, 1, 5000);
    cam.position.set(cx, 2000, -cy); cam.up.set(0, 0, -1); cam.lookAt(cx, 0, -cy); cam.updateMatrixWorld();
    const rt = new THREE.WebGLRenderTarget(px, px);
    const avant = { cible: r.getRenderTarget(), clip: r.localClippingEnabled, op: carte.mesh.material.opacity, alpha: r.getClearAlpha(), couleur: r.getClearColor(new THREE.Color()) };
    const buf = new Uint8Array(px * px * 4);
    try {
      carte.mesh.material.opacity = 1;
      carte.u.uSortie.value = 1; // couleurs sRGB écrites telles quelles (pas de conversion de sortie dans une cible de rendu)
      r.localClippingEnabled = false;
      r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear();
      r.render(carte.mesh, cam);
      r.readRenderTargetPixels(rt, 0, 0, px, px, buf);
    } finally {
      carte.u.uSortie.value = 0;
      carte.mesh.material.opacity = avant.op;
      r.setRenderTarget(avant.cible); r.setClearColor(avant.couleur, avant.alpha); r.localClippingEnabled = avant.clip;
      rt.dispose();
    }
    // lignes du tampon de bas en haut (sud → nord) ; couleurs prémultipliées par l'alpha
    const c = document.createElement('canvas'); c.width = px; c.height = px;
    const img = new ImageData(px, px);
    for (let j = 0; j < px; j++) {
      const src = (px - 1 - j) * px * 4, dst = j * px * 4;
      for (let i = 0; i < px * 4; i += 4) {
        const a = buf[src + i + 3], f = a ? 255 / a : 0;
        img.data[dst + i] = Math.min(255, buf[src + i] * f); img.data[dst + i + 1] = Math.min(255, buf[src + i + 1] * f);
        img.data[dst + i + 2] = Math.min(255, buf[src + i + 2] * f); img.data[dst + i + 3] = a;
      }
    }
    c.getContext('2d').putImageData(img, 0, 0);
    return { canvas: c, x: cx - R, z: -cy - R, w: 2 * R, h: 2 * R };
  }

  // texte court du profil et du bâti à la hauteur choisie (légende, panneau)
  function noteHauteur() {
    const z = etat.hauteur, n = etat.grille?.batiments.length;
    return `Vent libre à ${texteHauteur(z)} m = ${nombre(facteurProfil(z), 2)} × le vent de référence à 10 m (profil logarithmique ${PROFIL.norme}, z0 = ${PROFIL.z0} m, zmin = ${PROFIL.zmin} m)`
      + `${n != null ? ` ; obstacles : ${n} volume${n > 1 ? 's' : ''} plus haut${n > 1 ? 's' : ''} que ${texteHauteur(z)} m` : ''} ; contournement atténué près de leur sommet.`;
  }

  // légende automatique (js/legende.js) : dégradé et graduations de la carte affichée
  function legendeCarte() {
    if (!etat.actif) return null;
    const carteAff = carteVisible() && !!carte.mesh?.visible;
    const rapport = etat.carteValeur === 'rapport';
    // particules seules : section seulement en mode Vitesse (même échelle que la carte) ; en Rapport, légende d'origine (js/legende.js)
    if (!carteAff && (rapport || !particulesVisibles() || !champ.M)) return null;
    const txt = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
    const nom = `${texteDirection()}, ${txt(etat.vitesse)} m/s`;
    const sill = etat.sillageAnime ? ', sillage animé qualitatif' : '';
    // hauteur (07/11/2026) : titre « Vent à 25 m au-dessus du sol », note du profil ; à 1,5 m, textes inchangés
    const pieton = etat.hauteur === HAUTEUR_PIETON;
    const titreH = pieton ? 'Vent à 1,5 m' : `Vent à ${texteHauteur(etat.hauteur)} m au-dessus du sol`;
    const noteH = pieton ? '' : ` ${noteHauteur()}`;
    const modele = pieton ? `écoulement 2D simplifié${sill}` : `écoulement 2D simplifié + profil vertical${sill}`;
    if (rapport) {
      const grads = [0, 0.5, 1, 1.5, 2];
      return {
        id: 'vent-carte',
        titre: `${titreH} : rapport au vent libre${pieton ? '' : ' à cette hauteur'} (vent ${nom}${pieton ? '' : ' à 10 m'})`,
        degrade: { stops: STOPS_CARTE, graduations: grads.map((v) => ({ u: v / 2, texte: v === 2 ? '2+' : txt(v) })), gauche: 'calme', droite: 'fort' },
        note: `Estimation pédagogique (${modele}) : ordres de grandeur, pas une simulation CFD.${noteH}`,
      };
    }
    majRatio();
    const max = echelleVitesse(), pas = pasGraduation(max), grads = [];
    for (let v = 0; v <= max + 1e-6; v += pas) grads.push(Math.round(v * 100) / 100);
    const quoi = carteAff ? (particulesVisibles() ? 'carte et particules' : 'carte') : 'particules';
    return {
      id: 'vent-carte',
      titre: `${titreH} : vitesse en m/s (${quoi} ; vent ${nom}${pieton ? '' : ' à 10 m'})`,
      degrade: { stops: STOPS_VITESSE, graduations: grads.map((v) => ({ u: v / max, texte: v >= max - 1e-6 ? `${txt(v)}+` : txt(v) })), gauche: 'calme', droite: 'fort' },
      note: `Échelle continue de 0 à ${txt(max)} m/s : vent libre${pieton ? '' : ` à ${texteHauteur(etat.hauteur)} m (${txt(vitesseLibre())} m/s)`} × ${nombre(facteurEchelle(), 2)}${etat.echelleAuto ? ' (98e centile de la carte)' : ''}, arrondi. Estimation pédagogique (${modele}) : ordres de grandeur, pas une simulation CFD.${noteH}`,
    };
  }

  // ---------------------------------------------------------------
  // Animation : tour des directions, journée type, 4 saisons (source météo active)
  // ---------------------------------------------------------------
  const anim = { dir: 0, heure: 0, s: 0, ui: 0, texte: '' };
  const angle = (a, b, t) => { const d = ((b - a + 540) % 360) - 180; return (a + d * t + 360) % 360; };
  const lisse = (t) => t * t * (3 - 2 * t);
  function vitesseHeure(mois, h) {
    const M = horaire()?.moyennes?.[mois];
    const n = normales();
    const v = (x) => M?.[x % 24]?.v ?? n?.FF?.[mois] ?? 4;
    const k = Math.floor(h), t = h - k;
    return v(k) * (1 - t) + v(k + 1) * t;
  }
  function dominantSaison(cle) {
    const ro = rose(12, cle, 'all');
    if (!roseFiable(ro)) return null;
    const d = ro.secteurs.slice().sort((a, b) => b.f - a.f)[0];
    return { dir: d.dir, v: vitesseSecteur(d) };
  }
  function avancerAnimation(dt) {
    const f = etat.animVitesse;
    let dir = etat.direction, vit = etat.vitesse;
    if (etat.animMode === 'direction') {
      anim.dir = (anim.dir + 15 * f * dt) % 360;
      dir = anim.dir;
      anim.texte = `Tour des directions : ${Math.round(dir)}° ${NOMS16[Math.round(dir / 22.5) % 16]}`;
    } else if (etat.animMode === 'journee') {
      anim.heure = (anim.heure + 1.2 * f * dt) % 24;
      vit = vitesseHeure(etat.mois, anim.heure);
      if (normales()) dir = dominantMois(etat.mois) * 22.5;
      const hh = Math.floor(anim.heure), mm = Math.floor((anim.heure - hh) * 60 / 15) * 15;
      anim.texte = `Journée type de ${MOIS[etat.mois]} : ${hh} h ${String(mm).padStart(2, '0')} (vent horaire moyen, direction dominante du mois)`;
    } else {
      anim.s = (anim.s + 0.12 * f * dt) % 4;
      const i = Math.floor(anim.s), t = lisse(Math.min(1, (anim.s - i) * 1.6)); // pause sur chaque saison
      const a = dominantSaison(SAISONS4[i][0]), b = dominantSaison(SAISONS4[(i + 1) % 4][0]);
      if (a && b) { dir = angle(a.dir, b.dir, t); vit = a.v + (b.v - a.v) * t; }
      anim.texte = t < 0.02 ? `Saison : ${SAISONS4[i][1]} (vent dominant)` : `${SAISONS4[i][1]} → ${SAISONS4[(i + 1) % 4][1]}`;
    }
    etat.direction = Math.round(dir) % 360;
    etat.vitesse = Math.max(0.5, Math.round(vit * 10) / 10);
    marquerChamp();
    const now = performance.now();
    if (now - anim.ui > 120) { anim.ui = now; majLibelles(); majTexteAnimation(); }
  }
  function majTexteAnimation() {
    if (!ui.animTexte?.isConnected) return;
    ui.animTexte.textContent = etat.animation ? `${anim.texte} — vent ${texteDirection()}, ${nombre(etat.vitesse)} m/s` : '';
    ui.animBouton.textContent = etat.animation ? '■ Arrêter' : '▶ Animer';
    ui.animBouton.setAttribute('aria-pressed', String(etat.animation));
  }
  function demarrerAnimation() {
    if (etat.animation || !etat.actif) return;
    etat.animation = true;
    passerEnManuel(); // l'animation fait tourner le vent : la direction ne suit plus la période
    anim.dir = etat.direction;
    anim.heure = 0;
    anim.s = 0;
    etat.effets = null; dessinerEffets(); majEffetsUI(); // phénomènes : recalculés à l'arrêt
    if (etat.affichage === 'particules') { etat.affichage = 'deux'; majAffichageUI(); }
    majTexteAnimation();
  }
  function arreterAnimation() {
    if (!etat.animation) return;
    etat.animation = false;
    majTexteAnimation();
    majLibelles();
    if (etat.actif) recalculer(); // calcul exact de la dernière direction et des phénomènes
  }
  function majAffichageUI() {
    ui.affichages?.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.aff === etat.affichage)));
    if (ui.blocCarte) ui.blocCarte.hidden = !carteVisible();
    app.emettre('legende');
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
    const entree = etat.entree;
    if (!entree.R) {
      etat.calculEnCours = true;
      try {
        entree.R = await rapportsSecteurs(entree.grille, { journal: noteConfort });
      } finally { etat.calculEnCours = false; }
    }
    // hauteur ou bâti changé pendant le calcul des 12 secteurs : le calcul de la nouvelle grille suit
    if (entree !== etat.entree) return;
    etat.R = entree.R;
    etat.P = probabilitesDepassement(etat.grille, rapportsHauteur(), S, etat.seuil);
    afficherConfort();
  }
  // rapports de confort à la hauteur choisie (07/11/2026) : fz · [w · rapport du calcul + (1 − w)] ; à 1,5 m, inchangés.
  // Le seuil et les classes restent ceux du piéton (critère défini à 1,5 m) : à une autre hauteur, simple indication.
  function rapportsHauteur() {
    const e = etat.entree, W = e?.W;
    if (!W) return etat.R;
    if (e.Rz?.R === etat.R) return e.Rz.val;
    const val = etat.R.map((arr) => {
      const o = new Float32Array(arr.length);
      for (let j = 0; j < NC; j++) for (let i = 0; i < NC; i++) {
        const k = j * NC + i, x = -CHALF + (i + 0.5) * CH, z = -CHALF + (j + 0.5) * CH;
        const ii = Math.floor((x + HALF) / H), jj = Math.floor((-z + HALF) / H);
        const w = ii < 0 || jj < 0 || ii >= N || jj >= N ? 0 : W[jj * N + ii];
        o[k] = e.fz * (w * arr[k] + (1 - w));
      }
      return o;
    });
    e.Rz = { R: etat.R, val };
    return val;
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
    const cle = (avec) => `${avec}|${etat.saison}|${etat.seuil}|${etat.hauteur}`;
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
    if (etat.hauteur !== HAUTEUR_PIETON) texte += ` Vent à ${texteHauteur(etat.hauteur)} m au-dessus du sol : critère défini pour le piéton à 1,5 m, à lire comme une simple indication.`;
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
    if (!ui.pointeur?.isConnected) return;
    if (etat.actif && carteVisible() && champ.U && !(etat.P && etat.confort)) {
      const o = [0, 0];
      if (!etat.grille || etat.grille.estPlein(x, -z) || Math.hypot(x - centreCarte()[0], -z - centreCarte()[1]) > rayonCarte() || !echantillonChamp(champ.U, champ.V, x, -z, o)) { ui.pointeur.textContent = ''; return; }
      const m = Math.hypot(o[0], o[1]);
      ui.pointeur.textContent = `Sous le pointeur : vent à ${texteHauteur(etat.hauteur)} m ≈ ${nombre(m)} m/s (${nombre(m / vitesseLibre(), 2)} × le vent libre${etat.hauteur !== HAUTEUR_PIETON ? ' à cette hauteur' : ''})${etat.sillageAnime ? ', sillage animé non compris' : ''}.`;
      return;
    }
    if (!etat.P || !etat.confort) return;
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
    if (!etat.suitPeriode) majTextePeriode();
    if (etat.hauteur !== HAUTEUR_PIETON) majHauteurUI();
  }

  function regler(direction, vitesse) {
    if (etat.animation) arreterAnimation();
    etat.direction = ((Math.round(direction) % 360) + 360) % 360;
    if (vitesse != null) etat.vitesse = borneVitesse(vitesse);
    majLibelles();
    marquerChamp();
    recalculer();
  }

  // ---------------------------------------------------------------
  // Hauteur du vent visualisé (07/11/2026, demande de l'utilisateur) : 1,5 m (défaut), 5, 10, 25, 50 m ou libre (1-100 m)
  // ---------------------------------------------------------------
  // Change la grille du bâti (volumes plus hauts que z), le profil et le mélange (js/vent-calcul.js) : la carte, le sillage animé,
  // les particules et le confort au vent suivent ; la bibliothèque des 24 directions est refaite en tâche de fond pour cette
  // hauteur (« Précalcul… », cache de 3 grilles : revenir à une hauteur récente est immédiat). L'UTCI de Confort reste à 1,5 m.
  function definirHauteur(z, { memoriser = true } = {}) {
    z = hauteurValide(z);
    if (memoriser) ecrireLS(CLE_HAUTEUR, z === HAUTEUR_PIETON ? null : String(z));
    if (z === etat.hauteur) { majHauteurUI(); return; }
    etat.hauteur = z;
    carte.cleProp = null; carte.cleMasque = null;
    if (etat.actif) {
      if (!etat.animation) { etat.effets = null; dessinerEffets(); majEffetsUI(); }
      preparerGrille();
      if (objets) reinitialiserParticules();
      majFleche();
      recalculer();
      if (etat.confort) majConfort();
    }
    majHauteurUI();
    majBiblioUI();
    app.emettre('legende');
  }
  function majHauteurUI() {
    ui.hauteurs?.forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.h === etat.hauteur)));
    if (ui.hauteurLibre?.isConnected && document.activeElement !== ui.hauteurLibre) ui.hauteurLibre.value = String(etat.hauteur);
    if (!ui.hauteurNote?.isConnected) return;
    const z = etat.hauteur, b = etat.entree?.z === z ? etat.entree.biblio : null;
    const precalc = etat.actif && b && !b.complet ? ` Précalcul des directions à ${texteHauteur(z)} m : ${b.prets} sur ${SECTEURS_BIBLIO}…` : '';
    if (z === HAUTEUR_PIETON) { ui.hauteurNote.textContent = `Hauteur du piéton (référence du calcul) : vent libre = vent du panneau.${precalc}`; return; }
    const n = etat.entree?.z === z ? etat.grille?.batiments.length : null;
    ui.hauteurNote.textContent = `Vent libre à ${texteHauteur(z)} m : ${nombre(vitesseLibre())} m/s (${nombre(facteurProfil(z), 2)} × ${nombre(etat.vitesse)} m/s à 10 m).`
      + `${n != null ? ` Obstacles : ${n} volume${n > 1 ? 's' : ''} plus haut${n > 1 ? 's' : ''} que ${texteHauteur(z)} m.` : ''} L'UTCI de l'outil Confort reste calculé avec le vent à 1,5 m.${precalc}`;
  }

  // ---------------------------------------------------------------
  // Rose des vents cliquable (12 secteurs de 30°)
  // ---------------------------------------------------------------
  const roseActive = () => rose(12, etat.saison, etat.temperature);
  const roseFiable = (ro) => ro.N >= 100 && ro.secteurs.length;
  const vitesseSecteur = (sct) => (etat.modeVitesse === 'fort' ? sct.p90 : sct.vm);

  // manuel : clic sur un secteur, « le plus énergétique » → la direction ne suit plus la période
  function appliquerSecteur(k, { manuel = false } = {}) {
    const ro = roseActive();
    if (!roseFiable(ro)) return;
    const sct = ro.secteurs[k];
    if (manuel) passerEnManuel();
    regler(sct.dir, vitesseSecteur(sct));
    majTextePeriode();
  }

  // ---------------------------------------------------------------
  // Direction suivant la période (07/11/2026, demande de l'utilisateur)
  // ---------------------------------------------------------------
  // Changer la Période (saison) ou la Température, cliquer une des 4 roses des saisons ou une ligne du tableau des saisons,
  // changer d'année ou de source météo : la direction se pose sur le secteur DOMINANT (le plus fréquent) de
  // rose(12, saison, température) de la source active (année choisie comprise), centre du secteur (d'où vient le vent) ;
  // la vitesse = vitesse moyenne du secteur (« Vent moyen ») ou vitesse dépassée 10 % du temps (« Vent fort »).
  // Case « Direction suivant la période » (cochée par défaut, localStorage atlas-hdv-vent-periode, reprise par les vues) :
  // déplacer le curseur de direction, cliquer un secteur de la rose, « Le plus énergétique », « Appliquer le vent dominant
  // du mois » ou lancer une animation la décoche (« manuel ») ; la recocher (ou « Le plus fréquent ») recalcule.
  // La carte, les particules et le sillage suivent aussitôt (bibliothèque des 24 directions), le calcul exact suit (regler).
  const DANS_SAISON = { annee: 'sur l\'année', hiver: 'en hiver', printemps: 'au printemps', ete: 'en été', automne: 'en automne' };
  function dominantPeriode() {
    const ro = roseActive();
    if (!roseFiable(ro)) return null;
    const d = ro.secteurs.reduce((a, b) => (b.f > a.f ? b : a));
    return { k: d.k, dir: d.dir, v: vitesseSecteur(d), f: d.f, annee: ro.annee, temperatureIgnoree: ro.temperatureIgnoree };
  }
  function textePeriode() {
    const d = dominantPeriode();
    const quand = `${DANS_SAISON[etat.saison] || etat.saison}${etat.temperature !== 'all' && !d?.temperatureIgnoree ? `, ${minuscule(libelleTemperature(etat.temperature))}` : ''}${d?.annee ? ` (${d.annee})` : ''}`;
    if (!d) return `Direction dominante ${quand} : trop peu de mesures, direction inchangée.`;
    const arrondi = etat.suitPeriode && borneVitesse(d.v) !== d.v ? ` (curseur, par pas de 0,5 : ${nombre(borneVitesse(d.v))} m/s)` : '';
    const v = `${nombre(d.v)} m/s ${etat.modeVitesse === 'fort' ? 'en vent fort (dépassé 10 % du temps)' : 'en moyenne'}${arrondi}`;
    const dom = `${d.dir}° (${NOMS12[d.k]}), ${v}, ${nombre(d.f, 0)} % du temps`;
    return etat.suitPeriode ? `Direction dominante ${quand} : ${dom}.` : `Manuel : ${texteDirection()}. Dominante ${quand} : ${dom}.`;
  }
  function majTextePeriode() {
    if (ui.casePeriode?.isConnected) ui.casePeriode.checked = etat.suitPeriode;
    if (ui.textePeriode?.isConnected) { ui.textePeriode.textContent = textePeriode(); ui.textePeriode.classList.toggle('manuel', !etat.suitPeriode); }
  }
  function appliquerPeriode() {
    if (etat.suitPeriode) {
      const d = dominantPeriode();
      if (d && (d.dir !== etat.direction || borneVitesse(d.v) !== etat.vitesse)) regler(d.dir, d.v);
    }
    majTextePeriode();
  }
  function passerEnManuel() {
    if (!etat.suitPeriode) return;
    etat.suitPeriode = false;
    ecrireLS(CLE_PERIODE, '0');
    majTextePeriode();
  }
  function definirSuitPeriode(v) {
    etat.suitPeriode = !!v;
    ecrireLS(CLE_PERIODE, v ? null : '0');
    appliquerPeriode();
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
        g.addEventListener('click', () => appliquerSecteur(sct.k, { manuel: true }));
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); appliquerSecteur(sct.k, { manuel: true }); } });
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
        h('button', { type: 'button', class: 'bouton discret petit', title: 'Secteur dominant de la période : la direction suit de nouveau la période', onclick: () => definirSuitPeriode(true) }, `Le plus fréquent (${NOMS12[freq.k]})`),
        h('button', { type: 'button', class: 'bouton discret petit', onclick: () => appliquerSecteur(ener.k, { manuel: true }) }, `Le plus énergétique (${NOMS12[ener.k]})`));
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
    passerEnManuel();
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
  function majBiblioUI() {
    if (!ui.biblio?.isConnected) { majHauteurUI(); return; }
    const b = etat.entree?.biblio, f = etat.entree?.fine?.biblio;
    const zone = empriseComplete() && !etat.centreEmprise ? 'toute l\'emprise' : `${rayonCarte()} m autour du centre`;
    const t = !b ? '' : b.complet ? `Carte dynamique prête : ${SECTEURS_BIBLIO} directions précalculées (${zone}, ${(b.duree / 1000).toFixed(1).replace('.', ',')} s).`
      : `Précalcul des directions pour la carte dynamique : ${b.prets} sur ${SECTEURS_BIBLIO}…`;
    const tf = !f || !hauteResolutionActive() ? '' : f.complet ? ` Haute résolution prête (mailles de 1,75 m, ${(f.duree / 1000).toFixed(1).replace('.', ',')} s).`
      : ` Haute résolution : ${f.prets} sur ${SECTEURS_BIBLIO}…`;
    ui.biblio.textContent = t + tf;
    majHauteurUI();
  }

  // emprise de la carte : rayon (EMPRISES, 0 = complète) et centre ([x, y] du calcul, null = centre de l'atlas, undefined = inchangé)
  function regleEmprise(r, centre) {
    if (EMPRISES.includes(+r)) etat.emprise = +r;
    if (centre !== undefined) {
      if (centre) {
        const lim = Math.max(0, HALF - rayonCarte() - 10), arr = (v) => Math.max(-lim, Math.min(lim, Math.round(v / H) * H));
        etat.centreEmprise = [arr(centre[0]), arr(centre[1])];
        if (!etat.centreEmprise[0] && !etat.centreEmprise[1]) etat.centreEmprise = null;
      } else etat.centreEmprise = null;
    }
    if (!hauteResolutionActive()) libererFine();
    carte.cleMasque = null; carte.cleProp = null; carte.durees.length = 0;
    marquerChamp();
    memoriserEmprise();
    if (objets) reinitialiserParticules();
    majEmpriseUI();
    majBiblioUI();
  }
  const libelleEmprise = (r) => (r ? `${Math.min(r, rayonParticules())} m` : `complète (${rayonParticules()} m)`);
  function majEmpriseUI() {
    if (!ui.empriseCur?.isConnected) return;
    ui.empriseCur.value = String(Math.max(0, EMPRISES.indexOf(etat.emprise)));
    ui.empriseVal.textContent = libelleEmprise(etat.emprise) + (etat.centreEmprise ? ', centrée sur la vue' : '');
    const hrPossible = !empriseComplete() && rayonCarte() <= HR_MAX;
    ui.caseHR.checked = etat.hauteResolution;
    ui.caseHR.disabled = !hrPossible;
    ui.caseHR.parentNode.title = hrPossible ? 'Bibliothèque fine (mailles de 1,75 m) et masque du bâti au 0,5 m dans l\'emprise'
      : 'Haute résolution : emprise de 150 m au plus';
    ui.centreAtlas.disabled = !etat.centreEmprise;
    ui.perf.hidden = !carte.message;
    ui.perfTexte.textContent = carte.message;
  }

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
    // carte dynamique : le curseur redessine aussitôt la carte (bibliothèque), le calcul exact suit au lâcher
    ui.curDir.addEventListener('input', () => { arreterAnimation(); passerEnManuel(); etat.direction = +ui.curDir.value; majLibelles(); marquerChamp(); });
    ui.curVit.addEventListener('input', () => { arreterAnimation(); etat.vitesse = +ui.curVit.value; majLibelles(); marquerChamp(); });
    ui.curDir.addEventListener('change', recalculer);
    ui.curVit.addEventListener('change', recalculer);
    curDen.addEventListener('input', () => { etat.densite = +curDen.value; majLibelles(); });
    const boutonPause = h('button', { type: 'button', class: 'bouton petit', 'aria-pressed': String(etat.pause), onclick: (e) => {
      etat.pause = !etat.pause; e.currentTarget.textContent = etat.pause ? 'Reprendre' : 'Pause'; e.currentTarget.setAttribute('aria-pressed', String(etat.pause));
    } }, etat.pause ? 'Reprendre' : 'Pause');
    const selecteur = (libelle, options, valeur, change) => h('label', { class: 'champ' }, h('span', {}, libelle),
      h('select', { onchange: (e) => change(e.target.value) }, ...options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(valeur) }, l))));
    const lSaison = selecteur('Période', SAISONS, etat.saison, (v) => { etat.saison = v; dessinerRose(); majRoseMaquette(); appliquerPeriode(); if (etat.confort) majConfort(); });
    const lTemp = selecteur('Température', TEMPERATURES, etat.temperature, (v) => { etat.temperature = v; dessinerRose(); majRoseMaquette(); appliquerPeriode(); });
    ui.casePeriode = h('input', { type: 'checkbox', checked: etat.suitPeriode, onchange: (e) => definirSuitPeriode(e.target.checked) });
    ui.textePeriode = h('p', { class: 'note texte-periode-vent', 'aria-live': 'polite', 'data-garder': '' });
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
      onclick: () => { etat.modeVitesse = m; majModeVitesse(); majTableauSaisons(); if (etat.suitPeriode) appliquerPeriode(); else appliquerSecteur(secteur12(etat.direction)); },
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
    // carte de chaleur du vent et animation (07/11/2026)
    ui.affichages = AFFICHAGES.map(([v, l]) => h('button', { type: 'button', 'data-aff': v, 'aria-pressed': String(v === etat.affichage),
      onclick: () => { etat.affichage = v; majAffichageUI(); } }, l));
    const segValeur = h('div', { class: 'segment-vent', role: 'group', 'aria-label': 'Valeur affichée (carte et particules)' },
      ...[['vitesse', 'Vitesse (m/s)'], ['rapport', 'Rapport au vent libre']].map(([v, l]) => h('button', { type: 'button', 'data-val': v, 'aria-pressed': String(v === etat.carteValeur),
        onclick: (e) => { etat.carteValeur = v; e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.val === v))); carte.baseSale = true; app.emettre('legende'); } }, l)));
    const curOpacite = h('input', { type: 'range', min: 0.2, max: 1, step: 0.05, value: etat.opaciteCarte, 'aria-label': 'Opacité de la carte',
      oninput: (e) => { etat.opaciteCarte = +e.target.value; } });
    const caseCarte = (cle, libelle, titre) => h('label', { class: 'case', title: titre }, h('input', { type: 'checkbox', checked: etat[cle],
      onchange: (e) => { etat[cle] = e.target.checked; carte.baseSale = true; app.emettre('legende'); } }), libelle);
    ui.biblio = h('p', { class: 'note', 'data-garder': '' });
    // emprise de la carte (07/11/2026) : curseur des rayons, centre, haute résolution, allègement automatique
    ui.empriseCur = h('input', { type: 'range', min: 0, max: EMPRISES.length - 1, step: 1, value: Math.max(0, EMPRISES.indexOf(etat.emprise)),
      'aria-label': 'Zone de calcul et d\'affichage de la carte',
      oninput: (e) => { ui.empriseVal.textContent = libelleEmprise(EMPRISES[+e.target.value]); },
      onchange: (e) => regleEmprise(EMPRISES[+e.target.value]) });
    ui.empriseVal = h('strong', { class: 'valeur' });
    ui.caseHR = h('input', { type: 'checkbox', checked: etat.hauteResolution, onchange: (e) => api.definirHauteResolution(e.target.checked) });
    ui.centreAtlas = h('button', { type: 'button', class: 'bouton discret petit', onclick: () => regleEmprise(etat.emprise, null) }, 'Centre de l\'atlas');
    ui.perfTexte = h('span');
    ui.perf = h('p', { class: 'note perf-vent', role: 'status', 'data-garder': '', hidden: true }, ui.perfTexte, ' ',
      h('button', { type: 'button', class: 'bouton discret petit', onclick: retablirQualite }, 'Rétablir'));
    const blocEmprise = h('div', { class: 'emprise-vent' },
      h('div', { class: 'ligne-valeur' }, h('span', {}, 'Zone de calcul et d\'affichage'), ui.empriseVal),
      ui.empriseCur,
      h('div', { class: 'actions serrees' },
        h('button', { type: 'button', class: 'bouton discret petit', title: 'Centrer la zone sur le point visé par la vue (refait le précalcul)', onclick: () => {
          const t = app.controls?.target;
          if (t) regleEmprise(etat.emprise || EMPRISE_DEFAUT, [t.x, -t.z]);
        } }, 'Centrer sur la vue'),
        ui.centreAtlas),
      h('label', { class: 'case' }, ui.caseHR, 'Haute résolution (calcul au 1,75 m, carte au 0,5 m)'),
      ui.perf);
    // valeur (Vitesse / Rapport), échelle et sillage animé : communs à la carte et aux particules, visibles dans tous les
    // modes d'affichage (07/11/2026 ; avant, cachés avec la carte en mode « Particules »)
    ui.blocValeur = h('div', { class: 'bloc-valeur-vent' },
      segValeur,
      caseCarte('echelleAuto', 'Échelle ajustée à la carte (98e centile)', 'Vitesse : de 0 à une borne ronde (5, 6, 8, 10, 12 m/s…) = vent libre × facteur d\'accélération (98e centile de la carte, au moins 1,3) ; sinon vent libre × 2. Rapport : toujours 0-2'),
      caseCarte('sillageAnime', 'Sillage animé (tourbillons alternés, qualitatif)', 'Carte et particules. Représentation qualitative des lâchers de tourbillons : pas une simulation CFD instationnaire'));
    ui.blocCarte = h('div', { class: 'bloc-carte-vent' },
      blocEmprise,
      h('div', { class: 'ligne-valeur' }, h('span', {}, 'Opacité'), curOpacite),
      caseCarte('lisser', 'Lisser (interpolation bicubique)', 'Sinon : mailles du calcul (3,5 m, ou 1,75 m en haute résolution) visibles'),
      ui.biblio);
    ui.blocCarte.hidden = !carteVisible();
    ui.animBouton = h('button', { type: 'button', class: 'bouton petit', 'aria-pressed': 'false', onclick: () => (etat.animation ? arreterAnimation() : demarrerAnimation()) }, '▶ Animer');
    ui.animTexte = h('p', { class: 'note anim-vent', 'aria-live': 'off', 'data-garder': '' });
    const curAnim = h('input', { type: 'range', min: 0.25, max: 4, step: 0.25, value: etat.animVitesse, 'aria-label': 'Vitesse de l\'animation',
      oninput: (e) => { etat.animVitesse = +e.target.value; ui.animVit.textContent = `× ${nombre(etat.animVitesse, 2)}`; } });
    ui.animVit = h('span', {}, `× ${nombre(etat.animVitesse, 2)}`);
    // hauteur du vent visualisé (07/11/2026)
    ui.hauteurs = HAUTEURS.map((z) => h('button', { type: 'button', 'data-h': z, 'aria-pressed': String(z === etat.hauteur),
      title: z === HAUTEUR_PIETON ? 'Hauteur du piéton adulte (défaut, référence du calcul)' : `${z} m au-dessus du sol`, onclick: () => definirHauteur(z) },
    `${texteHauteur(z)} m`));
    ui.hauteurLibre = h('input', { type: 'number', min: 1, max: 100, step: 0.5, value: etat.hauteur, 'aria-label': 'Autre hauteur, de 1 à 100 m',
      onchange: (e) => definirHauteur(e.target.value) });
    ui.hauteurNote = h('p', { class: 'note note-hauteur-vent', 'aria-live': 'polite', 'data-garder': '' });
    const lAnim = selecteur('Animer', ANIMATIONS, etat.animMode, (v) => { etat.animMode = v; if (etat.animation) { anim.dir = etat.direction; anim.heure = 0; anim.s = 0; } });

    conteneur.classList.add('panneau-vent');
    conteneur.append(
      // 1. Rose
      h('div', { class: 'titre-info' }, h('h3', {}, 'Rose des vents mesurée'),
        info('Cliquer un secteur de la rose, une saison ou un mois règle le vent ; les particules montrent l\'écoulement simplifié autour du bâti, à hauteur de piéton.', ui.source)),
      ...[app.meteoSource?.bloc(), app.climat?.selecteurAnnee?.()].filter(Boolean),
      h('div', { class: 'deux-champs' }, lSaison, lTemp),
      h('label', { class: 'case case-periode-vent', title: 'Décochée dès qu\'on règle la direction à la main (curseur, secteur de la rose, mois, animation)' }, ui.casePeriode, 'Direction suivant la période (vent dominant)'),
      ui.textePeriode,
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
      h('div', { class: 'titre-info' }, h('h3', {}, 'Hauteur du vent visualisé'),
        info('Hauteur au-dessus du sol du vent montré par la carte, le sillage animé et les particules, et du confort au vent. 1,5 m (piéton adulte) est la hauteur du calcul de référence : à 1,5 m, tout est identique à l\'atlas sans ce réglage.',
          `Profil vertical (EN 1991-1-4, § 4.3.2, terrain de catégorie IV, zone urbaine dense : z0 = ${PROFIL.z0} m, zmin = ${PROFIL.zmin} m) : vent libre à z = vent du panneau (référence à 10 m) × ln(max(z, 10) / 1) / ln(10). Facteur 1 jusqu'à 10 m (sous zmin, l'Eurocode garde la valeur de zmin : sous la hauteur des toits, c'est le bâti qui commande le vent), ${nombre(facteurProfil(25), 2)} à 25 m, ${nombre(facteurProfil(50), 2)} à 50 m, ${nombre(facteurProfil(100), 2)} à 100 m. Une loi en puissance d'exposant 0,25 donnerait 1,26 à 25 m et 1,50 à 50 m.`,
          'Bâti à la hauteur z : seuls les volumes plus hauts que z (base sous z + 1 m) font obstacle dans l\'écoulement 2D, avec la seule part qui dépasse z (h − (z − 1,5 m)) : leurs sillages (calculé : 6 fois cette hauteur ; animé : 3 fois cette hauteur + 4 fois la largeur, à partir de 4 m) raccourcissent, puis disparaissent quand z approche le sommet. Les bâtiments plus bas sont ignorés : le vent passe au-dessus.',
          `Près du sommet des obstacles, le contournement s'atténue (l'air passe aussi par-dessus) : vent = profil × [w × champ 2D + (1 − w) × vent libre], avec H̄ = hauteur moyenne des obstacles retenus dans un carré de ±${MELANGE.rayon} m : w = 1 tant que H̄ dépasse 2 z, puis décroît jusqu'à ${nombre(MELANGE.residu, 2)} quand z atteint H̄. Le sillage animé est atténué de la même façon.`,
          'Confort au vent : seuils et classes définis pour le piéton à 1,5 m ; à une autre hauteur, la carte n\'est qu\'une indication. L\'UTCI de l\'outil Confort reste calculé avec le vent à 1,5 m. Phénomènes : repérés sur le bâti de la hauteur choisie.',
          'Estimation pédagogique (écoulement 2D + profil vertical), pas un calcul 3D : pour un vrai champ de vent en trois dimensions (rouleaux, décollements sur les toits, descente du vent le long des tours), il faut une simulation de mécanique des fluides (CFD).')),
      h('div', { class: 'hauteur-vent' },
        h('div', { class: 'segment-vent', role: 'group', 'aria-label': 'Hauteur du vent visualisé' }, ...ui.hauteurs),
        h('label', { class: 'hauteur-libre', title: 'Autre hauteur, de 1 à 100 m' }, h('span', {}, 'Autre'), ui.hauteurLibre, h('span', {}, 'm'))),
      ui.hauteurNote,
      // 5. Vues rapides
      h('div', { class: 'actions serrees vues-vent', role: 'group', 'aria-label': 'Vues rapides' },
        h('button', { type: 'button', class: 'bouton petit', 'data-vue': 'dessus', onclick: vueDessus, title: 'Plan vu de dessus, nord en haut (comme la touche V)' }, 'Vue de dessus'),
        h('button', { type: 'button', class: 'bouton petit', 'data-vue': 'perspective', onclick: vuePerspective, title: 'Maquette en perspective' }, 'Perspective'),
        h('button', { type: 'button', class: 'bouton petit', 'data-vue': 'nord', onclick: vueNord, title: 'Tourner la maquette, nord en haut' }, 'Nord en haut')),
      // 6. Carte de chaleur (heatmap) et animation
      h('div', { class: 'titre-info' }, h('h3', {}, 'Affichage du vent'),
        info('Carte de chaleur : vitesse du vent à la hauteur choisie (1,5 m, hauteur de piéton, par défaut) d\'après l\'écoulement 2D simplifié de l\'atlas, en mode « Vitesse (m/s) » sur une échelle continue bleu foncé → bleu → vert → jaune → orange → rouge, de 0 à une borne ronde (5, 6, 8, 10, 12 m/s…) égale au vent libre réglé × un facteur d\'accélération (98e centile de la carte) : l\'échelle suit la vitesse choisie ; en mode « Rapport au vent libre », palette « turbo » de 0 à 2 fois le vent libre. Les particules prennent les mêmes couleurs en mode Vitesse. Elle suit aussitôt la direction et la vitesse : pendant un glissement de curseur ou une animation, elle mélange les deux directions voisines d\'une bibliothèque de 24 champs (tous les 15°) calculés une fois pour 1 m/s puis multipliés par la vitesse (le calcul est proportionnel à la vitesse) ; au lâcher du curseur, le calcul exact de la direction remplace le mélange. Écart du mélange avec le calcul exact : environ 0,04 fois le vent libre en moyenne au pire angle (7,5° des directions calculées), davantage au bord des sillages.',
          'Sillage animé : représentation QUALITATIVE, pas une simulation de mécanique des fluides instationnaire. Dessinée à chaque pixel par la carte graphique, au-dessus du champ calculé : derrière chaque bâtiment (sur une longueur de 3 fois sa hauteur plus 4 fois sa largeur, 150 m au plus), une allée de tourbillons alternés (comme une allée de Kármán, espacement 3,2 fois la largeur) se forme à environ 0,6 largeur, alterne de part et d\'autre de l\'axe, s\'élargit en cône et s\'efface avec la distance ; des couches de cisaillement ondulées partent des angles de la face au vent (survitesse dehors, ralenti dedans) et sont entraînées dans le sillage. Les tourbillons dérivent sous le vent (direction du panneau : d\'où vient le vent, azimut géographique) à 0,8 fois le vent libre, défilement accéléré × 4 pour la lecture : leur cadence est proportionnelle à la vitesse choisie. Les particules suivent aussi ce sillage (visible en mode « Particules » seul). Les valeurs absolues restent des ordres de grandeur : à lire pour comparer les lieux, pas une norme.',
          'Zone de calcul et d\'affichage : la carte et les particules se limitent à ce cercle (fondu de 10 m au bord) ; la bibliothèque des 24 directions n\'est calculée que dans ce cercle et 40 m autour (précalcul plus court, animation plus fluide). « Centrer sur la vue » déplace le cercle sur le point visé. Haute résolution (emprise de 150 m au plus) : seconde bibliothèque sur des mailles de 1,75 m et bâti découpé au 0,5 m (sinon 3,5 m et 0,75 à 1 m). Si l\'affichage ralentit (plus de 33 ms par image en moyenne), il est allégé automatiquement (haute résolution coupée, puis sillage simplifié) : « Rétablir » revient au plein détail. Les phénomènes, le confort et le calcul exact au lâcher des curseurs portent toujours sur toute l\'emprise.',
          'Animer : « Tour des directions » fait tourner le vent (15° par seconde à × 1) ; « Journée type » applique heure par heure le vent moyen du mois choisi dans le graphique mensuel (source météo active), avec sa direction dominante ; « Les 4 saisons » passe d\'une saison à l\'autre avec leur vent dominant. Les phénomènes sont recalculés à l\'arrêt.')),
      h('p', { class: 'note vent-bandeau', 'data-garder': '' }, h('strong', {}, 'Estimation pédagogique'), ' : écoulement 2D + profil vertical, ordres de grandeur ; pas une simulation CFD (un vrai calcul 3D demande la CFD).'),
      h('div', { class: 'segment-vent', role: 'group', 'aria-label': 'Affichage du vent' }, ...ui.affichages),
      ui.blocValeur,
      ui.blocCarte,
      lAnim,
      h('div', { class: 'ligne-valeur' }, h('span', {}, 'Vitesse de l\'animation'), ui.animVit),
      curAnim,
      h('div', { class: 'actions serrees' }, ui.animBouton),
      ui.animTexte,
      // 7. Particules, confort, phénomènes, légende
      h('h3', {}, 'Particules'),
      h('div', { class: 'ligne-valeur' }, h('span', {}, 'Nombre'), ui.den),
      curDen,
      h('div', { class: 'actions serrees' }, boutonPause,
        app.export ? h('button', { type: 'button', class: 'bouton discret petit', onclick: () => app.export.exporterImage() }, 'Enregistrer l\'image') : null),
      ui.etat,
      h('h3', {}, 'Confort au vent piéton'),
      h('label', { class: 'case' }, curConfort, 'Afficher la carte de confort au sol'),
      selecteur('Seuil', SEUILS, etat.seuil, (v) => { etat.seuil = +v; majConfort(); }),
      ui.projet,
      ui.noteProjet,
      ui.confort,
      ui.pointeur,
      h('div', { class: 'titre-action' }, h('div', { class: 'titre-info' }, h('h3', {}, 'Phénomènes de vent'), ui.aPropos), toutEffets),
      ui.effets,
    );
    ui.aPropos.querySelector('.info-panneau').append(
        h('p', { class: 'note' }, 'Écoulement simplifié en 2D : le vent contourne les bâtiments, s\'accélère entre eux et ralentit derrière (sillage estimé). Ce n\'est pas une simulation de mécanique des fluides : à lire pour comparer les lieux entre eux. Couleur des particules : en mode « Vitesse », vitesse locale en m/s sur l\'échelle continue de la carte (bleu foncé, calme ; rouge, fort) ; en mode « Rapport », vitesse rapportée au vent libre (bleu, abrité ; rouge, accéléré jusqu\'à 2,5 fois).'),
        h('p', { class: 'note' }, 'Rose : 12 secteurs de 30°, en % de toutes les heures (calmes compris) ; partie foncée : heures au-dessus de 5 m/s. « Vent fort » applique la vitesse dépassée 10 % du temps dans le secteur. Mois : direction dominante sur 16 secteurs et vent moyen du mois.'),
        h('p', { class: 'note' }, 'Confort : part du temps où le vent à hauteur de piéton dépasse le seuil, d\'après les rapports du calcul 2D pour les 12 secteurs et les dépassements mesurés de la période choisie (sans découpage par température ; toujours la moyenne 2016-2025, même quand une année est choisie), vent libre à 2 m en ville estimé à 0,70 fois le vent de la station ; mailles de 4 m.'),
        h('p', { class: 'note' }, 'Phénomènes : repérage géométrique d\'après la forme et la hauteur des bâtiments et le champ calculé (classement du CSTB) : des indices à vérifier sur place, pas des mesures.'),
        ui.mentionLongue);
    majLibelles();
    majModeVitesse();
    majBoutonsProjet();
    majTexteAnimation();
    majBiblioUI();
    majEmpriseUI();
    majEffetsUI();
    majToutEffets();
    majHauteurUI();
    ui.rose.append(h('p', { class: 'note' }, 'Lecture des mesures…'));
    chargerMF().then((d) => {
      if (!ui.rose.isConnected) return;
      if (!d) { ui.rose.replaceChildren(h('p', { class: 'resultat alerte' }, mention())); return; }
      ui.source.textContent = `Source : ${mention({ court: true, annee: true })}`;
      ui.mentionLongue.textContent = mention({ annee: true });
      dessinerRose();
      dessinerMois();
      appliquerPeriode(); // direction et vitesse du vent dominant de la période (si la case est cochée)
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
      setTimeout(async () => {
        if (!etat.actif) return;
        const t0 = performance.now();
        note(`Calcul de l'écoulement${etat.hauteur !== HAUTEUR_PIETON ? ` à ${texteHauteur(etat.hauteur)} m` : ''}…`);
        if (await calculerChamp()) note(texteCalcul(performance.now() - t0));
        if (etat.confort && etat.actif) majConfort();
      }, 30);
    } else {
      majConfort();
    }
  }

  function fermer() {
    if (!etat.actif) return;
    etat.animation = false; // arrêt de l'animation (changement d'ambiance, js/ambiances.js)
    etat.actif = false;
    detruireObjets();
    if (etat.roseMaquette) app.climat?.reglerRose({ visible: false });
  }

  function batiChange() {
    etat.grille = null;
    majBoutonsProjet();
    if (etat.actif) { recalculer(); if (etat.confort) setTimeout(majConfort, 60); }
  }
  // fermeture : quand une autre analyse d'Ambiance s'ouvre (js/ambiances.js) ; gardé pendant Export, Vues, bascule 3D / plan
  // période des mesures changée (Moyenne 2016-2025 / année, js/climat.js) : rose, saisons, mois et rose posée suivent
  app.on('meteoAnnee', () => {
    if (!ui.rose?.isConnected) return;
    ui.majTemp?.();
    ui.source.textContent = `Source : ${mention({ court: true, annee: true })}`;
    ui.mentionLongue.textContent = mention({ annee: true });
    dessinerRose(); majTableauSaisons(); dessinerMois(); majRoseMaquette(); appliquerPeriode();
  });
  // source météo changée (base Météo-France / EPW) : mesures relues, rose, saisons, mois, confort au vent recalculé
  app.on('meteoSource', async () => {
    mf = null;
    await chargerMF();
    bilans.clear();
    if (etat.actif && etat.confort) majConfort();
    if (!ui.rose?.isConnected) { majRoseMaquette(); return; }
    ui.majTemp?.();
    ui.source.textContent = `Source : ${mention({ court: true, annee: true })}`;
    ui.mentionLongue.textContent = mention({ annee: true });
    dessinerRose(); majTableauSaisons(); dessinerMois(); majRoseMaquette(); appliquerPeriode();
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

  const api = {
    construirePanneau, etat, entitesDXF, fermer, regler, appliquerSecteur, legendeCarte, dominantPeriode, definirSuitPeriode, appliquerPeriode, champPour, demarrerAnimation, arreterAnimation,
    definirHauteur, HAUTEURS,
    definirAffichage(v) { if (AFFICHAGES.some(([a]) => a === v)) { etat.affichage = v; majAffichageUI(); } },
    get actif() { return etat.actif; },
    get champ() { return champ; },
    get perfCarte() {
      const b = etat.entree?.biblio, f = etat.entree?.fine?.biblio;
      return { ...carte.ms, mailles: N * N, proprietaires: carte.nbProp, ratio98: carte.ratio98, echelle: echelleVitesse(), derive: DERIVE_SILLAGE * vitesseLibre(), hauteur: etat.hauteur, facteurProfil: facteurProfil(etat.hauteur), batiments: etat.grille?.batiments.length ?? 0, niveau: carte.niveau, rayon: rayonCarte(), hauteResolution: hauteResolutionActive(),
        masque: resolutionMasque(), precalcul: b?.duree ?? 0, precalculFin: f?.duree ?? 0, fenetre: cleFenetre(fenetreCarte()), fine: etat.entree?.fine?.grille.n ?? 0 };
    },
    bibliotheque, bibliothequeFine, instantane, retablirQualite,
    definirEmprise(r, centre) { regleEmprise(r, centre); },
    definirHauteResolution(v) { etat.hauteResolution = !!v; if (!v) libererFine(); carte.cleMasque = null; marquerChamp(); memoriserEmprise(); majEmpriseUI(); },
    maj(dt) {
      // premier calcul exact de la hauteur choisie pas encore publié (calcul par lots) : rien à dessiner
      if (!objets || etat.solveurH?.etat.direction == null) return;
      const dtBrut = dt;
      dt = Math.min(dt, 0.05);
      if (etat.animation) avancerAnimation(dt);
      // bibliothèques des directions : calculées par petits lots (8 ms par image au plus, partagés avec la bibliothèque fine)
      const b = bibliotheque();
      let budget = 8;
      if (b && !b.complet) {
        const t0 = performance.now();
        b.avancer(budget, etat.direction);
        budget -= performance.now() - t0;
        if (b.prets !== carte.prets) { carte.prets = b.prets; if (champ.source !== 'exact') marquerChamp(); majBiblioUI(); }
      }
      const bf = carteVisible() ? bibliothequeFine() : null;
      if (bf && !bf.complet && budget > 1) {
        bf.avancer(budget, etat.direction);
        if (bf.prets !== carte.pretsFine) { carte.pretsFine = bf.prets; marquerChamp(); majBiblioUI(); }
      }
      if (!bf && carte.pretsFine) { carte.pretsFine = 0; majBiblioUI(); }
      if (champSale) { champSale = false; actualiserChamp(); }
      // phase du sillage animé (carte et particules) : distance parcourue par les tourbillons (m), proportionnelle au vent libre,
      // intégrée : pas de saut quand la vitesse change
      if (etat.sillageAnime && !etat.pause) carte.D += DERIVE_SILLAGE * (etat.vitesse ? vitesseLibre() : 0) * dt;
      majCarte(dt);
      majParticules(dt);
      surveillerDuree(dtBrut);
    },
  };
  return api;
}
