// UTCI (Universal Thermal Climate Index, °C) : calcul pur, sans Three.js (07/11/2026).
// Polynôme d'approximation officiel « UTCI_approx » (6e ordre, 210 termes) de :
//   Bröde P., Fiala D., Błażejczyk K., Holmér I., Jendritzky G., Kampmann B., Tinz B., Havenith G. (2012),
//   « Deriving the operational procedure for the Universal Thermal Climate Index (UTCI) », Int J Biometeorol 56 : 481-494 ;
//   code de référence UTCI_a002 (www.utci.org). Coefficients transcrits automatiquement depuis la version Python de pythermalcomfort
//   (2.10.0, même polynôme), contrôlés sur des valeurs de référence (tests : node outils/utci/test-utci.mjs).
// Entrées : Ta température de l'air (°C), Tmrt température radiante moyenne (°C), va vitesse du vent À 10 M (m/s), HR humidité relative (%).
// Domaine de validité du polynôme : Ta −50…+50 °C, Tmrt − Ta −30…+70 K, va 0,5…17 m/s (pression de vapeur ≤ 5 kPa) ;
// hors domaine, `utci` borne les entrées (`dansDomaine` le signale).

// [coefficient, exposants de Ta, va, ΔTmrt (= Tmrt − Ta), Pa (kPa)] ; UTCI = Ta + Σ c · Ta^a · va^b · ΔT^c · Pa^d
export const TERMES = [
  [0.607562052, '0000'], [-0.0227712343, '1000'], [-2.2583652, '0100'], [0.398374029, '0010'],
  [5.12733497, '0001'], [0.000806470249, '2000'], [0.0880326035, '1100'], [-0.751269505, '0200'],
  [0.000183945314, '1010'], [-0.0200518269, '0110'], [0.00075504309, '0020'], [-0.312788561, '1001'],
  [0.548050612, '0101'], [-0.0369476348, '0011'], [-2.80626406, '0002'], [-0.000154271372, '3000'],
  [0.00216844454, '2100'], [-0.00408350271, '1200'], [0.158137256, '0300'], [-0.00017375451, '2010'],
  [0.000892859837, '1110'], [0.000169992415, '0210'], [-5.65095215e-05, '1020'], [0.00015454725, '0120'],
  [-1.21206673e-05, '0030'], [-0.0196701861, '2001'], [-0.00330552823, '1101'], [-0.0429223622, '0201'],
  [0.00162325322, '1011'], [0.0086420339, '0111'], [-0.00073246918, '0021'], [0.548712484, '1002'],
  [-0.308806365, '0102'], [0.0514507424, '0012'], [-0.0353874123, '0003'], [-3.24651735e-06, '4000'],
  [-1.53347087e-05, '3100'], [-5.21670675e-05, '2200'], [-6.57263143e-05, '1300'], [-0.0127762753, '0400'],
  [-7.60781159e-07, '3010'], [3.45433048e-06, '2110'], [-4.99204314e-05, '1210'], [8.49242932e-05, '0310'],
  [-4.52166564e-07, '2020'], [5.2411097e-06, '1120'], [-1.56236307e-05, '0220'], [-2.1820366e-07, '1030'],
  [1.25006734e-06, '0130'], [-1.30369025e-09, '0040'], [0.00099969087, '3001'], [-0.0016411944, '2101'],
  [0.00500845667, '1201'], [-0.00125813502, '0301'], [-3.1427968e-05, '2011'], [-0.000687405181, '1111'],
  [-3.59217476e-05, '0211'], [-1.87381964e-05, '1021'], [2.7786293e-05, '0121'], [-3.59413173e-07, '0031'],
  [-0.0039942841, '2002'], [0.0116952364, '1102'], [0.00210787756, '0202'], [-0.00432510997, '1012'],
  [-0.000266016305, '0112'], [0.000304788893, '0022'], [-0.22120119, '1003'], [0.0453433455, '0103'],
  [-0.00226921615, '0013'], [0.614155345, '0004'], [7.32602852e-08, '5000'], [-5.72983704e-07, '4100'],
  [1.94544667e-06, '3200'], [2.22697524e-07, '2300'], [9.66891875e-06, '1400'], [0.000456306672, '0500'],
  [3.77830287e-08, '4010'], [-3.77925774e-07, '3110'], [2.47417178e-07, '2210'], [1.35191328e-06, '1310'],
  [-4.99410301e-06, '0410'], [2.46688878e-08, '3020'], [-8.75874982e-08, '2120'], [-1.33895614e-07, '1220'],
  [6.51711721e-07, '0320'], [7.51269482e-09, '2030'], [-1.81584736e-09, '1130'], [-3.3651463e-08, '0230'],
  [4.13908461e-10, '1040'], [-5.08220384e-09, '0140'], [6.62154879e-10, '0050'], [9.51738512e-06, '4001'],
  [-5.16670694e-06, '3101'], [1.00601257e-06, '2201'], [-0.000179330391, '1301'], [0.000129735808, '0401'],
  [2.59835559e-06, '3011'], [-9.13863872e-06, '2111'], [3.28696511e-05, '1211'], [-1.243823e-05, '0311'],
  [4.80925239e-06, '2021'], [-5.06004592e-06, '1121'], [2.53016723e-06, '0221'], [7.04388046e-07, '1031'],
  [-4.79768731e-07, '0131'], [3.94367674e-08, '0041'], [-0.000954009191, '3002'], [0.000495271903, '2102'],
  [-0.000698445738, '1202'], [0.00041785659, '0302'], [8.99281156e-05, '2012'], [0.000263789586, '1112'],
  [-0.000106823306, '0212'], [-6.42070836e-05, '1022'], [7.68023384e-06, '0122'], [-4.36497725e-06, '0032'],
  [0.0155126038, '2003'], [-0.00432943862, '1103'], [0.00021750861, '0203'], [0.000380261982, '1013'],
  [-0.000796355448, '0113'], [0.000302122035, '0023'], [-0.0616755931, '1004'], [0.00355375387, '0104'],
  [-0.00148526421, '0014'], [0.0882773108, '0005'], [1.35959073e-09, '6000'], [-2.55090145e-09, '5100'],
  [1.14099531e-08, '4200'], [-4.16117031e-08, '3300'], [2.52785852e-09, '2400'], [-1.74202546e-07, '1500'],
  [-5.91491269e-06, '0600'], [5.43079673e-10, '5010'], [-1.69699377e-09, '4110'], [1.07596466e-08, '3210'],
  [-6.21531254e-09, '2310'], [-1.89489258e-08, '1410'], [8.15300114e-08, '0510'], [2.42674348e-10, '4020'],
  [-1.50743064e-09, '3120'], [2.49709824e-09, '2220'], [1.94960053e-09, '1320'], [-1.00361113e-08, '0420'],
  [9.79063848e-11, '3030'], [-3.52197671e-10, '2130'], [1.35908359e-10, '1230'], [4.1703262e-10, '0330'],
  [9.22652254e-12, '2040'], [-2.24730961e-11, '1140'], [1.17139133e-10, '0240'], [4.0386326e-13, '1050'],
  [1.95087203e-12, '0150'], [-4.73602469e-12, '0060'], [-4.66426341e-07, '5001'], [9.52692432e-07, '4101'],
  [-1.81748644e-06, '3201'], [2.34994441e-06, '2301'], [1.2906487e-06, '1401'], [-2.28558686e-06, '0501'],
  [-4.77136523e-08, '4011'], [5.15916806e-07, '3111'], [-7.10542454e-07, '2211'], [-7.385844e-09, '1311'],
  [2.20609296e-07, '0411'], [-8.7549204e-08, '3021'], [1.14325367e-07, '2121'], [-1.72857035e-08, '1221'],
  [-3.95079398e-08, '0321'], [-1.89309167e-08, '2031'], [7.96079978e-09, '1131'], [1.62897058e-09, '0231'],
  [-1.18566247e-09, '1041'], [3.34678041e-10, '0141'], [-1.15606447e-10, '0051'], [1.93090978e-05, '4002'],
  [-1.90710882e-05, '3102'], [2.30109073e-05, '2202'], [-1.27043871e-05, '1302'], [-3.04620472e-06, '0402'],
  [-7.14663943e-07, '3012'], [-7.01199003e-06, '2112'], [3.61341136e-06, '1212'], [2.29748967e-07, '0312'],
  [1.16257971e-06, '2022'], [-5.47446896e-07, '1122'], [-3.5993791e-08, '0222'], [1.68737969e-07, '1032'],
  [2.67489271e-08, '0132'], [3.23926897e-09, '0042'], [-0.000263917279, '3003'], [0.000145389826, '2103'],
  [-6.66724702e-05, '1203'], [3.3321714e-05, '0303'], [-5.45314314e-09, '2013'], [2.53458034e-05, '1113'],
  [-6.31223658e-06, '0213'], [-4.77403547e-06, '1023'], [1.73825715e-06, '0123'], [-4.09087898e-07, '0033'],
  [0.00133374846, '2004'], [-0.000513027851, '1104'], [0.000102449757, '0204'], [-4.11469183e-05, '1014'],
  [-6.80434415e-06, '0114'], [-9.77675906e-06, '0024'], [-0.00301859306, '1005'], [0.00104452989, '0105'],
  [0.000247090539, '0015'], [0.00148348065, '0006'],
].map(([c, e]) => [c, +e[0], +e[1], +e[2], +e[3]]);

// pression de vapeur saturante (hPa) au-dessus de l'eau, formule de Hardy (ITS-90) reprise par le code UTCI_a002 : ES = 2,7150305 ln(TK) + Σ g_i TK^(i−2)
// (pythermalcomfort 2.10 écrit log1p(TK) = ln(TK + 1), soit + 0,9 % sur la pression : on garde ln(TK) du code d'origine)
const G = [-2836.5744, -6028.076559, 19.54263612, -0.02737830188, 0.000016261698, 7.0229056e-10, -1.8680009e-13];
export function pressionSaturante(ta) {
  const tk = ta + 273.15;
  let e = 2.7150305 * Math.log(tk);
  for (let i = 0; i < 7; i++) e += G[i] * tk ** (i - 2);
  return Math.exp(e) * 0.01;
}

export const BORNES = { ta: [-50, 50], dT: [-30, 70], va: [0.5, 17] };
const borner = (x, [a, b]) => Math.min(b, Math.max(a, x));
export function dansDomaine(ta, tmrt, va) {
  return ta >= -50 && ta <= 50 && tmrt - ta >= -30 && tmrt - ta <= 70 && va >= 0.5 && va <= 17;
}

// puissances 0 à 6 de chaque variable, réutilisées pour les 210 termes
const PT = new Float64Array(7), PV = new Float64Array(7), PD = new Float64Array(7), PP = new Float64Array(7);
const remplir = (P, x) => { P[0] = 1; for (let i = 1; i < 7; i++) P[i] = P[i - 1] * x; };
const NT = TERMES.length;
const C = Float64Array.from(TERMES, (t) => t[0]);
const A = Uint8Array.from(TERMES, (t) => t[1]), B = Uint8Array.from(TERMES, (t) => t[2]);
const D = Uint8Array.from(TERMES, (t) => t[3]), E = Uint8Array.from(TERMES, (t) => t[4]);

// UTCI (°C) ; entrées bornées au domaine du polynôme (vent sous 0,5 m/s → 0,5 m/s, comme le recommande la procédure)
export function utci(ta, tmrt, va, hr) {
  const t = borner(ta, BORNES.ta);
  const dT = borner(tmrt - ta, BORNES.dT);
  const v = borner(va, BORNES.va);
  const pa = Math.min(5, (pressionSaturante(t) * Math.min(100, Math.max(0, hr))) / 100 / 10); // hPa → kPa
  remplir(PT, t); remplir(PV, v); remplir(PD, dT); remplir(PP, pa);
  let s = t;
  for (let i = 0; i < NT; i++) s += C[i] * PT[A[i]] * PV[B[i]] * PD[D[i]] * PP[E[i]];
  return s;
}

// Classes de stress thermique de l'UTCI (Błażejczyk et al. 2013) : bornes en °C, palette bleu → vert → jaune → orange → rouge
export const CLASSES_UTCI = [
  { max: -40, libelle: 'stress de froid extrême', couleur: [16, 26, 92] },
  { max: -27, libelle: 'stress de froid très fort', couleur: [24, 62, 160] },
  { max: -13, libelle: 'stress de froid fort', couleur: [38, 110, 210] },
  { max: 0, libelle: 'stress de froid modéré', couleur: [82, 162, 232] },
  { max: 9, libelle: 'stress de froid léger', couleur: [150, 206, 236] },
  { max: 26, libelle: 'aucun stress thermique', couleur: [104, 186, 96] },
  { max: 32, libelle: 'stress de chaleur modéré', couleur: [246, 214, 64] },
  { max: 38, libelle: 'stress de chaleur fort', couleur: [245, 150, 40] },
  { max: 46, libelle: 'stress de chaleur très fort', couleur: [222, 70, 34] },
  { max: Infinity, libelle: 'stress de chaleur extrême', couleur: [150, 20, 30] },
];
export const classeUTCI = (u) => CLASSES_UTCI.find((c) => u < c.max) ?? CLASSES_UTCI[CLASSES_UTCI.length - 1];

// palette continue (−40 → 50 °C), mêmes teintes, interpolée entre les milieux de classes
export const STOPS_UTCI = [[-40, [16, 26, 92]], [-20, [38, 110, 210]], [-6, [82, 162, 232]], [4.5, [150, 206, 236]], [17.5, [104, 186, 96]],
  [29, [246, 214, 64]], [35, [245, 150, 40]], [42, [222, 70, 34]], [50, [150, 20, 30]]];
export function couleurContinue(u) {
  const S = STOPS_UTCI;
  if (!(u > S[0][0])) return S[0][1].slice();
  for (let k = 1; k < S.length; k++) {
    if (u <= S[k][0]) {
      const [u0, a] = S[k - 1], [u1, b] = S[k], f = (u - u0) / (u1 - u0);
      return a.map((x, i) => Math.round(x + (b[i] - x) * f));
    }
  }
  return S[S.length - 1][1].slice();
}

// Vent à 10 m équivalent : le polynôme attend la vitesse à 10 m au-dessus du sol. Vent local à hauteur de piéton (1,1-1,5 m)
// ramené à 10 m par une loi en puissance d'exposant 0,18 (terrain ouvert à périurbain) : v10 = v(z) · (10 / z)^0,18
// (≈ 1,49 × v(1,1 m)). Convention de la procédure UTCI et des outils comme Ladybug (vent à 10 m sur site ouvert).
export const versDixMetres = (v, z = 1.1, alpha = 0.18) => v * (10 / z) ** alpha;

// Température radiante moyenne simplifiée d'une personne debout (méthode des facteurs d'angle : moitié haute, moitié basse,
// VDI 3787 / Thorsson et al. 2007), flux en W/m² : Tmrt = (Sstr / (εp σ))^¼ − 273,15 avec
//   Sstr = αk (fp I + ½ D SVF + ½ ρ G↓) + εp [½ (SVF L_ciel + (1 − SVF) L_murs) + ½ L_sol]
export const SIGMA = 5.67e-8;
export function tmrtSimplifiee({ I = 0, D = 0, fp = 0.308, svf = 1, albedoSol = 0.2, Gsol = 0, Lciel, Lmurs, Lsol, ak = 0.7, ep = 0.97 }) {
  const K = ak * (fp * I + 0.5 * D * svf + 0.5 * albedoSol * Gsol);
  const L = ep * (0.5 * (svf * Lciel + (1 - svf) * Lmurs) + 0.5 * Lsol);
  return Math.pow((K + L) / (ep * SIGMA), 0.25) - 273.15;
}
