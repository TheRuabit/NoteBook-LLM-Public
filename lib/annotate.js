import { PDFDocument, PDFName, PDFString, PDFHexString, rgb } from 'pdf-lib';
import { existsSync, readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';

const DEFAULT_COLOR = [1, 0.85, 0.3]; // 高亮黄 [r,g,b] 0-1

// 注释文本 → UTF-16BE 十六进制字符串（带 BOM）。
// 必须用 PDFHexString：pdf-lib 的 PDFString.of 会把每个字符截断成低字节，
// 中文（如 "一" U+4E00）会变成 NUL 字节，产生 mojibake 并破坏文件结构。
function toUtf16Hex(s) {
  let hex = 'FEFF'; // BOM → 声明 UTF-16BE
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) {
      const hi = 0xd800 + ((code - 0x10000) >> 10);
      const lo = 0xdc00 + ((code - 0x10000) & 0x3ff);
      hex += hi.toString(16).padStart(4, '0') + lo.toString(16).padStart(4, '0');
    } else {
      hex += code.toString(16).padStart(4, '0');
    }
  }
  return hex;
}

// ---------- 小字直写（inline）模式 ----------
// pdf-lib 只能嵌入单个 TTF/OTF（TTC 集合不支持），优先用系统自带的单文件 CJK 字体
const CJK_FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\Deng.ttf', // 等线
  'C:\\Windows\\Fonts\\simfang.ttf', // 仿宋
  'C:\\Windows\\Fonts\\simkai.ttf', // 楷体
];
let cjkFontBytes = null;

function loadCjkFontBytes() {
  if (cjkFontBytes) return cjkFontBytes;
  for (const p of CJK_FONT_CANDIDATES) {
    try {
      if (existsSync(p)) return (cjkFontBytes = readFileSync(p));
    } catch { /* 尝试下一个 */ }
  }
  return null;
}

// 去掉字体基本没有的 emoji/变体选择符/控制字符，避免渲染成豆腐块
function sanitizeForPdf(s) {
  return s.replace(/[\u{1F000}-\u{1FAFF}\u{FE0F}\u{200D}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '');
}

// 中文没有空格，必须按字符逐个测量换行
function wrapLines(font, text, size, maxWidth) {
  const lines = [];
  let line = '';
  for (const ch of text) {
    if (ch === '\n') {
      lines.push(line);
      line = '';
      continue;
    }
    if (line && font.widthOfTextAtSize(line + ch, size) > maxWidth) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// 把注释文字以小字直接绘制在高亮附近，任何查看器打开都能直接看到
function drawInlineNote(page, font, bbox, note) {
  const SIZE = 7.5;
  const LINE = SIZE * 1.4;
  const PAD = 3;
  const MAX_LINES = 12;
  const maxWidth = Math.min(Math.max(bbox.maxX - bbox.minX, 140), 340);
  let lines = wrapLines(font, sanitizeForPdf(note), SIZE, maxWidth);
  if (lines.length > MAX_LINES) lines = [...lines.slice(0, MAX_LINES - 1), '…'];
  const pageH = page.getHeight();

  // 优先画在高亮下方（PDF y 向上，往下递减）；放不下则画在上方
  let y0 = bbox.minY - PAD - SIZE;
  let dir = -1;
  if (y0 - (lines.length - 1) * LINE < 2) {
    y0 = bbox.maxY + PAD + SIZE * 0.8;
    dir = 1;
  }
  if (dir === 1 && y0 + (lines.length - 1) * LINE > pageH - 2) {
    const fit = Math.max(1, Math.floor((pageH - 2 - y0) / LINE) + 1);
    if (fit < lines.length) lines = [...lines.slice(0, fit - 1), '…'];
  }
  for (let i = 0; i < lines.length; i++) {
    page.drawText(lines[i], { x: bbox.minX, y: y0 + dir * i * LINE, size: SIZE, font, color: rgb(0.2, 0.24, 0.3) });
  }
}

/**
 * 把高亮 + 文本注释写回 PDF。
 * @param {Uint8Array} inputBytes 原始 PDF 字节
 * @param {Array<{page:number, rects:Array<{x,y,width,height}>, note?:string, color?:number[], inline?:boolean}>} annotations
 *   坐标均为 PDF 用户空间（y 向上），page 从 1 开始；
 *   inline: true 时把 note 以小字直接绘制在页面上（不添加弹窗注释）
 * @returns {Promise<Uint8Array>} 标注后的 PDF 字节
 */
export async function annotatePdf(inputBytes, annotations) {
  const doc = await PDFDocument.load(inputBytes, { ignoreEncryption: true, updateMetadata: false });
  doc.registerFontkit(fontkit); // 嵌入自定义字体（小字直写模式）所需
  let count = 0;
  let font = null; // 惰性嵌入：仅当存在 inline 注释时才加载字体
  for (const a of annotations) {
    const rects = (a.rects ?? []).filter((r) => r.width > 0.5 && r.height > 0.5);
    if (a.page < 1 || a.page > doc.getPageCount() || !rects.length) continue;
    const page = doc.getPage(a.page - 1);
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.width));
    const maxY = Math.max(...rects.map((r) => r.y + r.height));

    // QuadPoints 顺序: 左上, 右上, 左下, 右下 (PDF y 向上)
    const quadPoints = [];
    for (const r of rects) quadPoints.push(r.x, r.y + r.height, r.x + r.width, r.y + r.height, r.x, r.y, r.x + r.width, r.y);

    const contents = String(a.note ?? '').slice(0, 2000);
    const color = a.color ?? DEFAULT_COLOR;

    // 注意：context.obj() 会把字符串一律转成 PDFName，中文/换行会损坏；
    // PDFString.of() 不转义且对 CJK 截断成低字节（NUL）——所以 Contents（可能含中文）
    // 必须用 PDFHexString + UTF-16BE，T（纯 ASCII）用 PDFString.of() 显式设置
    const highlight = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [minX, minY, maxX, maxY],
      QuadPoints: quadPoints,
      C: color,
      P: page.ref,
    });
    highlight.set(PDFName.of('Contents'), PDFHexString.of(toUtf16Hex(contents)));
    highlight.set(PDFName.of('T'), PDFString.of('AI Assistant'));
    page.node.addAnnot(highlight);
    count++;

    if (a.inline) {
      if (contents) {
        if (!font) {
          const fontBytes = loadCjkFontBytes();
          if (!fontBytes) throw new Error('未找到可嵌入的中文字体（Deng.ttf / simfang.ttf / simkai.ttf），请取消勾选「注释直写页面」');
          font = await doc.embedFont(fontBytes);
        }
        drawInlineNote(page, font, { minX, minY, maxX, maxY }, contents);
      }
    } else if (contents) {
      const size = 18;
      const px = Math.min(maxX + 6, page.getWidth() - size);
      const py = Math.max(minY + 6, 0);
      const note = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [px, py, px + size, py + size],
        Name: 'Comment',
        P: page.ref,
      });
      note.set(PDFName.of('Contents'), PDFHexString.of(toUtf16Hex(contents)));
      note.set(PDFName.of('T'), PDFString.of('AI Assistant'));
      page.node.addAnnot(note);
      count++;
    }
  }
  const bytes = await doc.save();
  return { bytes, count };
}
