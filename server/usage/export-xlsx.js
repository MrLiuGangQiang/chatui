const JSZip = require('jszip');
const { USAGE_TIME_ZONE } = require('./ranges');

function safeXml(value) {
  const valid = Array.from(String(value ?? '')).filter(char => {
    const code = char.codePointAt(0);
    return code === 0x09 || code === 0x0a || code === 0x0d
      || (code >= 0x20 && code <= 0xd7ff)
      || (code >= 0xe000 && code <= 0xfffd)
      || (code >= 0x10000 && code <= 0x10ffff);
  }).join('');
  return valid.replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
}

function safeSheetName(value) {
  const cleaned = String(value || '统计').replace(/[\\/?*\[\]:]/g, '').slice(0, 31);
  return cleaned || '统计';
}

function formatDateTime(value, timeZone = USAGE_TIME_ZONE) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
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
  const used = new Set();
  return names.map(name => {
    const base = safeSheetName(name);
    let candidate = base;
    let count = 1;
    while (used.has(candidate.toLocaleLowerCase('en-US'))) {
      count += 1;
      const suffix = `_${count}`;
      candidate = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
    }
    used.add(candidate.toLocaleLowerCase('en-US'));
    return candidate;
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
  return `<c r="${ref}" t="inlineStr"><is><t>${safeXml(String(value ?? '').slice(0, 32767))}</t></is></c>`;
}

function xlsxWorksheet(headers, rows) {
  const allRows = [headers, ...rows];
  const rowXml = allRows.map((row, rowIndex) => {
    const excelRow = rowIndex + 1;
    return `<row r="${excelRow}">${row.map((value, columnIndex) => xlsxCell(value, columnIndex, excelRow)).join('')}</row>`;
  }).join('');
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), headers.length);
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
    const users = Object.prototype.hasOwnProperty.call(usersByDepartment || {}, row.department_id)
      && Array.isArray(usersByDepartment[row.department_id]) ? usersByDepartment[row.department_id] : [];
    const userRows = users.map((user, index) => [index + 1, user.username, startTime, endTime, user.total_tokens, user.prompt_tokens, user.completion_tokens, user.prompt_cached_tokens, user.completion_reasoning_tokens]);
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
