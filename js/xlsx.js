// Classeur Excel (.xlsx, Office Open XML) minimal, écrit dans le navigateur sans bibliothèque (11/11/2026, export des statistiques du climat).
// Calcul PUR (ni DOM, ni Three.js) : testable sous Node 18+. Utilisé par js/climat-export.js ; `compresser` aussi par js/pdf-rapport.js.
//
// classeurXLSX(feuilles, { titre, auteur, progression }) → Promise<Uint8Array> (contenu du fichier .xlsx)
//   feuille = { nom (≤ 31 car.), colonnes: [{ titre, largeur (caractères), format }], lignes: [[…]] | { n, ligne(i) → […] },
//               figer (ligne d'en-tête figée, défaut true), filtre (filtre automatique, défaut true) }
//   formats : 'texte' (défaut), 'long' (texte à la ligne), 'entier' (0), 'd1' (0,0), 'd2' (0,00), 'pct' (0,0 % : valeur en FRACTION,
//   0,123 → 12,3 %), 'date' (aaaa-mm-jj : numéro de série Excel), 'dateheure' (aaaa-mm-jj hh:mm), 'brut' (nombre sans format).
//   Cellules : nombre fini → cellule numérique typée ; chaîne → texte partagé (sharedStrings) ; booléen → « oui » / « non » ; null, undefined,
//   NaN, ±Infinity → cellule vide. Les nombres gardent toute leur précision (le format ne règle que l'affichage).
//   progression(fraction 0-1, texte) : appelée pendant l'écriture (feuilles longues écrites par morceaux de 4 000 lignes, avec une pause
//   entre deux morceaux pour ne pas geler l'interface).
// Fichier : [Content_Types].xml, _rels/.rels, docProps/core.xml et app.xml, xl/workbook.xml (+ _rels), xl/styles.xml, xl/sharedStrings.xml,
// xl/worksheets/sheetN.xml ; ligne 1 figée (pane), filtre automatique (autoFilter + nom _xlnm._FilterDatabase), largeurs de colonnes.
// Archive ZIP écrite ici (zipper) : « deflate » par CompressionStream (Chrome 103+, Node 18+), sinon méthode stockée ; CRC32.
// Numéro de série Excel d'un instant « heure de Paris » (ms décalés, comme H.loc de meteo-extremes.js) : serieExcel(ms) = ms / 86 400 000 + 25 569.

const enc = new TextEncoder();
export const serieExcel = (ms) => ms / 86400000 + 25569;

// ------------------------------------------------------------------ ZIP
const TABLE_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(parties) {
  let c = 0xffffffff;
  for (const d of parties) for (let i = 0; i < d.length; i++) c = TABLE_CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const concat = (parties) => { const n = parties.reduce((a, p) => a + p.length, 0), o = new Uint8Array(n); let k = 0; for (const p of parties) { o.set(p, k); k += p.length; } return o; };
// compression par l'API du navigateur (format 'deflate-raw' pour le ZIP, 'deflate' = zlib pour les flux PDF) ; null si indisponible
export async function compresser(parties, format = 'deflate-raw') {
  if (typeof CompressionStream === 'undefined' || typeof Blob === 'undefined' || typeof Response === 'undefined') return null;
  try {
    const flux = new Blob(parties).stream().pipeThrough(new CompressionStream(format));
    return new Uint8Array(await new Response(flux).arrayBuffer());
  } catch { return null; }
}
// fichiers : [{ nom, parties: [Uint8Array…] }] → Uint8Array (ZIP)
export async function zipper(fichiers, { compression = true } = {}) {
  const d = new Date();
  const heure = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const jour = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locaux = [], central = [];
  let decalage = 0;
  const entete = (taille, champs) => { const b = new Uint8Array(taille), v = new DataView(b.buffer); for (const [o, x, n] of champs) (n === 4 ? v.setUint32(o, x >>> 0, true) : v.setUint16(o, x, true)); return b; };
  for (const f of fichiers) {
    const nom = enc.encode(f.nom);
    const n = f.parties.reduce((a, p) => a + p.length, 0);
    const crc = crc32(f.parties);
    let donnees = compression && n > 256 ? await compresser(f.parties) : null;
    const methode = donnees && donnees.length < n ? 8 : 0;
    if (!methode) donnees = concat(f.parties);
    const loc = entete(30, [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, methode, 2], [10, heure, 2], [12, jour, 2], [14, crc, 4], [18, donnees.length, 4], [22, n, 4], [26, nom.length, 2], [28, 0, 2]]);
    locaux.push(loc, nom, donnees);
    central.push(entete(46, [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, methode, 2], [12, heure, 2], [14, jour, 2], [16, crc, 4], [20, donnees.length, 4], [24, n, 4], [28, nom.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, decalage, 4]]), nom);
    decalage += loc.length + nom.length + donnees.length;
  }
  const tailleCentral = central.reduce((a, b) => a + b.length, 0);
  const fin = entete(22, [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, fichiers.length, 2], [10, fichiers.length, 2], [12, tailleCentral, 4], [16, decalage, 4], [20, 0, 2]]);
  return concat([...locaux, ...central, fin]);
}

// ------------------------------------------------------------------ XML
// caractères interdits en XML 1.0 retirés ; & < > " échappés
const echapper = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lettres = (c) => { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
const nomFeuille = (n, deja) => {
  const base = String(n).replace(/[[\]:*?/\\]/g, '-').replace(/^'|'$/g, '').slice(0, 31) || 'Feuille';
  let s = base, k = 2;
  while (deja.has(s.toLowerCase())) s = `${base.slice(0, 28)} ${k++}`;
  deja.add(s.toLowerCase());
  return s;
};

// index de cellXfs
const STYLES = { texte: 0, entete: 1, entier: 2, d1: 3, d2: 4, pct: 5, date: 6, dateheure: 7, long: 8, brut: 0 };
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4"><numFmt numFmtId="164" formatCode="0.0"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="167" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDE5EC"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF7B8790"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;

const pause = () => new Promise((r) => setTimeout(r, 0));

export async function classeurXLSX(feuilles, { titre = 'Classeur', auteur = '', progression = null } = {}) {
  const partages = new Map(), listePartagees = [];
  let nRefs = 0;
  const idTexte = (s) => { nRefs++; let k = partages.get(s); if (k == null) { k = listePartagees.length; partages.set(s, k); listePartagees.push(s); } return k; };
  const total = feuilles.reduce((a, f) => a + (Array.isArray(f.lignes) ? f.lignes.length : f.lignes.n) + 1, 0);
  let faites = 0;
  const noms = new Set();
  const fichiersFeuilles = [];
  for (const [i, f] of feuilles.entries()) {
    const nom = nomFeuille(f.nom, noms);
    const cols = f.colonnes;
    const nl = Array.isArray(f.lignes) ? f.lignes.length : f.lignes.n;
    const ligne = Array.isArray(f.lignes) ? (k) => f.lignes[k] : f.lignes.ligne;
    const styleCol = cols.map((c) => STYLES[c.format] ?? 0);
    const L = cols.map((_, j) => lettres(j));
    const fin = `${L[cols.length - 1]}${nl + 1}`;
    const figer = f.figer !== false, filtre = f.filtre !== false && nl > 0;
    const parties = [];
    parties.push(enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<dimension ref="A1:${fin}"/>`
      + `<sheetViews><sheetView workbookViewId="0"${i === 0 ? ' tabSelected="1"' : ''}>${figer ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : ''}</sheetView></sheetViews>`
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + `<cols>${cols.map((c, j) => `<col min="${j + 1}" max="${j + 1}" width="${Math.max(4, Math.min(120, c.largeur ?? 12))}" customWidth="1"/>`).join('')}</cols><sheetData>`));
    parties.push(enc.encode(`<row r="1">${cols.map((c, j) => `<c r="${L[j]}1" t="s" s="${STYLES.entete}"><v>${idTexte(String(c.titre))}</v></c>`).join('')}</row>`));
    const MORCEAU = 4000;
    for (let a = 0; a < nl; a += MORCEAU) {
      let x = '';
      const b = Math.min(nl, a + MORCEAU);
      for (let k = a; k < b; k++) {
        const v = ligne(k), r = k + 2;
        x += `<row r="${r}">`;
        for (let j = 0; j < cols.length; j++) {
          let c = v[j];
          if (c == null) continue;
          if (typeof c === 'boolean') c = c ? 'oui' : 'non';
          if (typeof c === 'number') {
            if (!Number.isFinite(c)) continue;
            x += `<c r="${L[j]}${r}"${styleCol[j] ? ` s="${styleCol[j]}"` : ''}><v>${c}</v></c>`;
          } else {
            const st = cols[j].format === 'long' ? STYLES.long : 0;
            x += `<c r="${L[j]}${r}" t="s"${st ? ` s="${st}"` : ''}><v>${idTexte(String(c))}</v></c>`;
          }
        }
        x += '</row>';
      }
      parties.push(enc.encode(x));
      faites += b - a;
      if (progression) progression(0.9 * (faites / total), `feuille « ${nom} » : ${b.toLocaleString('fr-FR')} / ${nl.toLocaleString('fr-FR')} lignes`);
      if (nl > MORCEAU) await pause();
    }
    parties.push(enc.encode(`</sheetData>${filtre ? `<autoFilter ref="A1:${fin}"/>` : ''}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`));
    faites++;
    fichiersFeuilles.push({ nom, parties, filtre, fin });
  }
  const sst = [enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${nRefs}" uniqueCount="${listePartagees.length}">`)];
  for (let a = 0; a < listePartagees.length; a += 5000) sst.push(enc.encode(listePartagees.slice(a, a + 5000).map((s) => `<si><t xml:space="preserve">${echapper(s)}</t></si>`).join('')));
  sst.push(enc.encode('</sst>'));
  const n = fichiersFeuilles.length;
  const quand = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const fin$ = (ref) => ref.replace(/^([A-Z]+)(\d+)$/, '$$$1$$$2');
  const fichiers = [
    { nom: '[Content_Types].xml', texte: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${fichiersFeuilles.map((_, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
    { nom: '_rels/.rels', texte: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>' },
    { nom: 'docProps/core.xml', texte: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${echapper(titre)}</dc:title><dc:creator>${echapper(auteur)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${quand}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${quand}</dcterms:modified></cp:coreProperties>` },
    { nom: 'docProps/app.xml', texte: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Atlas du site de l'Hotel de Ville</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Feuilles de calcul</vt:lpstr></vt:variant><vt:variant><vt:i4>${n}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${n}" baseType="lpstr">${fichiersFeuilles.map((f) => `<vt:lpstr>${echapper(f.nom)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts><AppVersion>16.0300</AppVersion></Properties>` },
    { nom: 'xl/workbook.xml', texte: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15000" activeTab="0"/></bookViews><sheets>${fichiersFeuilles.map((f, k) => `<sheet name="${echapper(f.nom)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join('')}</sheets>${fichiersFeuilles.some((f) => f.filtre) ? `<definedNames>${fichiersFeuilles.map((f, k) => (f.filtre ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${k}" hidden="1">'${echapper(f.nom.replace(/'/g, "''"))}'!$A$1:${fin$(f.fin)}</definedName>` : '')).join('')}</definedNames>` : ''}<calcPr calcId="191029"/></workbook>` },
    { nom: 'xl/_rels/workbook.xml.rels', texte: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${fichiersFeuilles.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    { nom: 'xl/styles.xml', texte: STYLES_XML },
    { nom: 'xl/sharedStrings.xml', parties: sst },
    ...fichiersFeuilles.map((f, k) => ({ nom: `xl/worksheets/sheet${k + 1}.xml`, parties: f.parties })),
  ].map((f) => ({ nom: f.nom, parties: f.parties ?? [enc.encode(f.texte)] }));
  if (progression) progression(0.92, 'compression du classeur…');
  await pause();
  const octets = await zipper(fichiers);
  if (progression) progression(1, 'classeur prêt');
  return octets;
}
