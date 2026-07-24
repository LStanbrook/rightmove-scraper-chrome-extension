// Minimal, dependency-free .xlsx (Office Open XML) writer. Builds a single-
// sheet workbook by hand as an uncompressed ("stored") ZIP - no third-party
// spreadsheet library needed, so nothing to bundle or fetch remotely.

function xlsxColumnLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function xlsxXmlEscape(value) {
  return String(value).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

const XLSX_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function xlsxCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = XLSX_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function xlsxDosDateTime(date) {
  const dosTime = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

// Builds an uncompressed ("stored" method, i.e. no deflate needed) ZIP
// archive from a { path: textContent } map - all a spreadsheet's internal
// files are XML, so no binary entries are needed.
function xlsxBuildZip(files) {
  const encoder = new TextEncoder();
  const { dosTime, dosDate } = xlsxDosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let count = 0;

  for (const path of Object.keys(files)) {
    const nameBytes = encoder.encode(path);
    const dataBytes = encoder.encode(files[path]);
    const crc = xlsxCrc32(dataBytes);
    const size = dataBytes.length;

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true);
    localHeader.setUint16(6, 0, true);
    localHeader.setUint16(8, 0, true);
    localHeader.setUint16(10, dosTime, true);
    localHeader.setUint16(12, dosDate, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, size, true);
    localHeader.setUint32(22, size, true);
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true);
    localParts.push(new Uint8Array(localHeader.buffer), nameBytes, dataBytes);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(4, 20, true);
    centralHeader.setUint16(6, 20, true);
    centralHeader.setUint16(8, 0, true);
    centralHeader.setUint16(10, 0, true);
    centralHeader.setUint16(12, dosTime, true);
    centralHeader.setUint16(14, dosDate, true);
    centralHeader.setUint32(16, crc, true);
    centralHeader.setUint32(20, size, true);
    centralHeader.setUint32(24, size, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint16(30, 0, true);
    centralHeader.setUint16(32, 0, true);
    centralHeader.setUint16(34, 0, true);
    centralHeader.setUint16(36, 0, true);
    centralHeader.setUint32(38, 0, true);
    centralHeader.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(centralHeader.buffer), nameBytes);

    offset += localHeader.byteLength + nameBytes.length + dataBytes.length;
    count++;
  }

  const centralStart = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, new Uint8Array(end.buffer)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

// columns: [key, label, isNumber?, isUrl?][]. rows: plain objects keyed by
// column key. Numbers are written as real numeric cells (so Excel sorts/
// formats them correctly); everything else is written as an inline string,
// which avoids needing a separate sharedStrings.xml part. isUrl columns get
// a real hyperlink relationship (styled blue/underlined) so links work
// immediately rather than needing Excel to be told to treat them as such.
function buildXlsx(columns, rows) {
  const headerCells = columns
    .map(([, label], i) => `<c r="${xlsxColumnLetter(i)}1" t="inlineStr"><is><t>${xlsxXmlEscape(label)}</t></is></c>`)
    .join('');
  const sheetRows = [`<row r="1">${headerCells}</row>`];
  const hyperlinks = []; // { ref, rId }

  rows.forEach((row, rowIdx) => {
    const r = rowIdx + 2;
    const cells = columns
      .map(([key, , isNumber, isUrl], i) => {
        const ref = `${xlsxColumnLetter(i)}${r}`;
        const value = row[key];
        if (value === '' || value === null || value === undefined) return `<c r="${ref}"/>`;
        if (isNumber && Number.isFinite(Number(value))) {
          return `<c r="${ref}"><v>${Number(value)}</v></c>`;
        }
        if (isUrl) {
          const rId = `rIdHlink${hyperlinks.length + 1}`;
          hyperlinks.push({ ref, rId, target: value });
          return `<c r="${ref}" t="inlineStr" s="1"><is><t>${xlsxXmlEscape(value)}</t></is></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t>${xlsxXmlEscape(value)}</t></is></c>`;
      })
      .join('');
    sheetRows.push(`<row r="${r}">${cells}</row>`);
  });

  const hyperlinksXml = hyperlinks.length
    ? `<hyperlinks>${hyperlinks.map((h) => `<hyperlink ref="${h.ref}" r:id="${h.rId}"/>`).join('')}</hyperlinks>`
    : '';
  const sheetRelsXml = hyperlinks.length
    ? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      hyperlinks
        .map(
          (h) =>
            `<Relationship Id="${h.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xlsxXmlEscape(h.target)}" TargetMode="External"/>`
        )
        .join('') +
      '</Relationships>'
    : null;

  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
    'xl/styles.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><sz val="11"/><name val="Calibri"/><color rgb="FF0563C1"/><u/></font>' +
      '</fonts>' +
      '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheetData>${sheetRows.join('')}</sheetData>${hyperlinksXml}</worksheet>`,
  };

  if (sheetRelsXml) {
    files['xl/worksheets/_rels/sheet1.xml.rels'] = sheetRelsXml;
  }

  return xlsxBuildZip(files);
}
