const JSZip = require('jszip');

function safeXml(value) {
  return String(value ?? '').replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
}

function safeSheetName(value) {
  const cleaned = String(value || '统计').replace(/[\\/?*\[\]:]/g, '').slice(0, 31);
  return cleaned || '统计';
}

function formatDateTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function uniqueSheetNames(names = []) {
  const used = new Map();
  return names.map(name => {
    const base = safeSheetName(name);
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    if (count === 1) return base;
    const suffix = `_${count}`;
    return `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
  });
}

function columnName(index) {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const mod = (n - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    n = Math.floor((n - mod) / 26);
  }
  return name;
}

function xlsxCell(value, columnIndex, rowIndex) {
  const ref = `${columnName(columnIndex)}${rowIndex}`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t>${safeXml(value)}</t></is></c>`;
}

function xlsxWorksheet(headers, rows) {
  const allRows = [headers, ...rows];
  const rowXml = allRows.map((row, rowIndex) => {
    const excelRow = rowIndex + 1;
    return `<row r="${excelRow}">${row.map((value, columnIndex) => xlsxCell(value, columnIndex, excelRow)).join('')}</row>`;
  }).join('');
  const columnCount = Math.max(headers.length, ...rows.map(row => row.length));
  const dimension = columnCount > 0 ? `A1:${columnName(columnCount - 1)}${Math.max(1, allRows.length)}` : 'A1';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="${dimension}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

async function buildDepartmentExportWorkbook(rangeLabel, departments = [], usersByDepartment = {}, rangeBounds = {}) {
  const startTime = formatDateTime(rangeBounds.start_time);
  const endTime = formatDateTime(rangeBounds.end_time);
  const headers = ['序号', '部门名称', '开始时间', '结束时间', '总用量', '输入', '输出', '缓存输入', '推理输出'];
  const userHeaders = ['序号', '用户名称', '开始时间', '结束时间', '总用量', '输入', '输出', '缓存输入', '推理输出'];
  const departmentRows = departments.map((row, index) => [index + 1, row.department_name, startTime, endTime, row.total_tokens, row.prompt_tokens, row.completion_tokens, row.prompt_cached_tokens, row.completion_reasoning_tokens]);
  const sheetDefs = [{ name: `部门${rangeLabel}统计`, headers, rows: departmentRows }];
  departments.forEach(row => {
    const userRows = (usersByDepartment[row.department_id] || []).map((user, index) => [index + 1, user.username, startTime, endTime, user.total_tokens, user.prompt_tokens, user.completion_tokens, user.prompt_cached_tokens, user.completion_reasoning_tokens]);
    sheetDefs.push({ name: `${row.department_name || row.department_id}${rangeLabel}统计`, headers: userHeaders, rows: userRows });
  });
  const sheetNames = uniqueSheetNames(sheetDefs.map(sheet => sheet.name));
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheetDefs.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n  ')}
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetNames.map((name, index) => `<sheet name="${safeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>
</workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetDefs.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('\n  ')}
</Relationships>`);
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`);
  sheetDefs.forEach((sheet, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, xlsxWorksheet(sheet.headers, sheet.rows));
  });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = {
  buildDepartmentExportWorkbook,
  columnName,
  formatDateTime,
  safeSheetName,
  safeXml,
  uniqueSheetNames,
};
