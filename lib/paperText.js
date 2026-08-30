import fs from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const PAGE_CHAR_LIMIT = 6000; // 每页最多取 6000 字符
const TOTAL_CHAR_LIMIT = 90000; // 「结合全文」模式总上限

async function openDoc(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  return getDocument({ data, disableWorker: true, isEvalSupported: false, useSystemFonts: true }).promise;
}

/**
 * 提取指定页的文本（用于「结合本页上下文」）。
 */
export async function extractPageText(pdfPath, pageNumber) {
  const doc = await openDoc(pdfPath);
  try {
    if (pageNumber < 1 || pageNumber > doc.numPages) return '';
    const page = await doc.getPage(pageNumber);
    const tc = await page.getTextContent();
    return tc.items
      .map((it) => (typeof it.str === 'string' ? it.str : ''))
      .join('')
      .slice(0, PAGE_CHAR_LIMIT);
  } finally {
    await doc.destroy();
  }
}

/**
 * 提取整篇 PDF 的文本（用于「结合全文」，带页码标记），控制总长度。
 */
export async function extractFullText(pdfPath) {
  const doc = await openDoc(pdfPath);
  try {
    const parts = [];
    let total = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const text = tc.items
        .map((it) => (typeof it.str === 'string' ? it.str : ''))
        .join('')
        .slice(0, PAGE_CHAR_LIMIT);
      parts.push(`--- 第 ${n} 页 ---\n${text}`);
      total += text.length + 20;
      if (total >= TOTAL_CHAR_LIMIT) break;
    }
    return parts.join('\n');
  } finally {
    await doc.destroy();
  }
}
