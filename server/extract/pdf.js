const path = require('path');
const fs = require('fs');
const { optionalRequire, dataUrlToBuffer, limitExtractedText, withAttachmentHeader, writeTempBuffer, cleanupTempDir, execFileText, commandExists, meaningfulExtractedText, hasUsefulText } = require('./utils');

const pdfParseLib = optionalRequire('pdf-parse');

async function extractPdfWithPdftotext(filename, buffer) {
  const { dir, file } = writeTempBuffer(buffer, filename);
  try {
    const text = await execFileText('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-']);
    if (!text.trim()) throw new Error('pdftotext 未提取到文本');
    return withAttachmentHeader('PDF', filename, 'Poppler/pdftotext', text, '解析说明：以下为使用 Poppler/pdftotext 提取到的 PDF 正文；对中文字体映射支持更稳定。');
  } finally {
    cleanupTempDir(dir);
  }
}

async function extractPdfWithPdfParse(filename, buffer) {
  if (!pdfParseLib?.PDFParse) throw new Error('pdf-parse 未安装');
  const parser = new pdfParseLib.PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    if (!String(result?.text || '').trim()) throw new Error('pdf-parse 未提取到文本');
    return withAttachmentHeader('PDF', filename, 'pdf-parse/pdf.js', result.text, '解析说明：以下为使用 pdf.js 提取到的 PDF 正文；对部分中文字体映射有支持。');
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractPdfWithOcr(filename, buffer) {
  const hasPdftoppm = await commandExists('pdftoppm');
  const hasTesseract = await commandExists('tesseract');
  if (!hasPdftoppm || !hasTesseract) {
    throw new Error('OCR 依赖不可用：需要 pdftoppm 和 tesseract');
  }
  const { dir, file } = writeTempBuffer(buffer, filename);
  try {
    const prefix = path.join(dir, 'page');
    await execFileText('pdftoppm', ['-r', '220', '-png', '-f', '1', '-l', '20', file, prefix], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
    const pages = fs.readdirSync(dir)
      .filter(name => /^page-\d+\.png$/i.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0));
    if (!pages.length) throw new Error('PDF 未能转换为页面图片');
    const chunks = [];
    for (const page of pages) {
      const imagePath = path.join(dir, page);
      const pageNo = Number(page.match(/\d+/)?.[0] || chunks.length + 1);
      try {
        const text = await execFileText('tesseract', [imagePath, 'stdout', '-l', 'chi_sim+eng', '--psm', '6'], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
        const clean = limitExtractedText(text, 20000);
        if (clean) chunks.push(`## 第 ${pageNo} 页\n${clean}`);
      } catch (err) {
        chunks.push(`## 第 ${pageNo} 页\n[OCR 失败：${err.message || String(err)}]`);
      }
    }
    const text = chunks.join('\n\n').trim();
    if (!text || !hasUsefulText(text, 20)) throw new Error('OCR 未提取到可用文本');
    return withAttachmentHeader('PDF', filename, 'Tesseract OCR chi_sim+eng', text, '解析说明：该 PDF 可能是扫描件/图片型 PDF，以下为先将页面转图片后使用 Tesseract OCR（简体中文+英文）识别到的文本。');
  } finally {
    cleanupTempDir(dir);
  }
}

async function extractPdfText(filename, dataUrl) {
  const buffer = dataUrlToBuffer(dataUrl);
  const attempts = [];
  for (const extractor of [extractPdfWithPdftotext, extractPdfWithPdfParse]) {
    try {
      const text = await extractor(filename, buffer);
      if (hasUsefulText(text)) return text;
      attempts.push(text);
    } catch (err) {
      attempts.push(err?.message || String(err));
    }
  }
  try { return await extractPdfWithOcr(filename, buffer); }
  catch (err) {
    const fallback = attempts.find(item => meaningfulExtractedText(item).clean) || '';
    if (fallback) return `${fallback}\n\n[OCR 未执行成功：${err.message || String(err)}]`;
    return withAttachmentHeader('PDF', filename, 'PDF tools', `未能从该 PDF 中提取到可用文本。它可能是扫描件/图片型 PDF；OCR 未执行成功：${err.message || String(err)}。请确认 Docker 镜像已安装 poppler-utils、tesseract-ocr、tesseract-ocr-data-chi_sim 和 tesseract-ocr-data-eng。`);
  }
}

module.exports = { extractPdfText };
