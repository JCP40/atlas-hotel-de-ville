// PDF minimal (22/10/2026), sans bibliothèque : une image JPEG pleine page par page, au format papier réel.
// pages : [{ largeur, hauteur (mm), jpeg: Uint8Array, px: [largeur, hauteur] en pixels }] ; renvoie un Blob application/pdf.
// L'image couvre exactement la page (MediaBox en points : 1 mm = 72 / 25,4 pt) : une planche rendue à l'échelle le reste à l'impression
// (imprimer « taille réelle », sans ajustement à la page).
const MM = 72 / 25.4;
export function pdfImages(pages, { titre = 'Planche', auteur = '' } = {}) {
  const enc = new TextEncoder();
  const morceaux = [];
  let longueur = 0;
  const offsets = [];
  const ecrire = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; morceaux.push(b); longueur += b.length; };
  const objet = (n, corps) => { offsets[n] = longueur; ecrire(`${n} 0 obj\n`); for (const c of [].concat(corps)) ecrire(c); ecrire('\nendobj\n'); };
  const texte = (s) => `(${String(s).replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?')})`;
  ecrire('%PDF-1.4\n');
  const n = pages.length;
  // 1 catalogue, 2 arbre des pages, 3 infos ; puis par page : page, contenu, image
  const idPage = (i) => 4 + i * 3;
  objet(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objet(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${idPage(i)} 0 R`).join(' ')}] >>`);
  objet(3, `<< /Title ${texte(titre)} /Author ${texte(auteur)} /Producer (Atlas du site de l'Hotel de Ville) >>`);
  pages.forEach((p, i) => {
    const W = (p.largeur * MM).toFixed(3), H = (p.hauteur * MM).toFixed(3);
    const contenu = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    objet(idPage(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${idPage(i) + 2} 0 R >> >> /Contents ${idPage(i) + 1} 0 R >>`);
    objet(idPage(i) + 1, [`<< /Length ${contenu.length} >>\nstream\n`, contenu, '\nendstream']);
    objet(idPage(i) + 2, [`<< /Type /XObject /Subtype /Image /Width ${p.px[0]} /Height ${p.px[1]} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, p.jpeg, '\nendstream']);
  });
  const total = 4 + n * 3;
  const debutXref = longueur;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let k = 1; k < total; k++) xref += `${String(offsets[k]).padStart(10, '0')} 00000 n \n`;
  ecrire(xref);
  ecrire(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${debutXref}\n%%EOF\n`);
  return new Blob(morceaux, { type: 'application/pdf' });
}
