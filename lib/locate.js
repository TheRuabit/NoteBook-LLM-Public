import fs from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * 提取指定页的文本条目（含坐标），供句子定位使用。
 */
async function getPageItems(pdfPath, pageNumber) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await getDocument({ data, disableWorker: true, isEvalSupported: false, useSystemFonts: true }).promise;
  try {
    const page = await doc.getPage(pageNumber);
    const tc = await page.getTextContent();
    const items = [];
    for (const item of tc.items) {
      if (typeof item.str !== 'string' || !item.str) continue;
      items.push({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
        fs: Math.abs(item.transform[0]) || 10,
        width: item.width ?? 0,
      });
    }
    return items;
  } finally {
    await doc.destroy();
  }
}

/**
 * 构建归一化索引。
 * sep='' 时条目直接拼接（匹配浏览器选区无空格拼接的情况）；
 * sep=' ' 时条目间插空格（匹配单词级切分）。
 * map[k] = { idx: 条目序号, off: 条目内字符偏移 }，分隔符为 null。
 */
function buildIndex(items, sep) {
  let raw = '';
  const map = [];
  items.forEach((it, idx) => {
    for (let i = 0; i < it.str.length; i++) map.push({ idx, off: i });
    raw += it.str;
    if (sep && idx < items.length - 1) {
      raw += sep;
      map.push(null);
    }
  });
  let norm = '';
  const toRaw = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      if (!norm.endsWith(' ')) {
        norm += ' ';
        toRaw.push(i);
      }
    } else {
      norm += ch.toLowerCase();
      toRaw.push(i);
    }
  }
  return { norm, toRaw, map };
}

function normalizeQuery(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function exactRange(idx, q) {
  const i = idx.norm.indexOf(q);
  if (i < 0) return null;
  const start = idx.toRaw[i];
  const end = idx.toRaw[Math.min(i + q.length - 1, idx.toRaw.length - 1)] + 1;
  return { start, end };
}

// 容错匹配：按词元顺序找首尾，容忍空白/连字符差异。
// 带跨度与密度约束，防止词元散落页面两端时画出整页高亮。
function tokenRange(idx, q) {
  const tokens = q.match(/[a-z0-9]{3,}/g) ?? [];
  if (tokens.length < 2) return null;
  let pos = 0;
  const hits = [];
  for (const t of tokens) {
    const i = idx.norm.indexOf(t, pos);
    if (i < 0) continue;
    hits.push({ i, len: t.length });
    pos = i + t.length;
  }
  if (hits.length < Math.max(2, Math.ceil(tokens.length * 0.6))) return null;
  const first = hits[0];
  const last = hits[hits.length - 1];
  const span = last.i + last.len - first.i;
  if (span > Math.max(4 * q.length, 700)) return null; // 跨度远超句子长度 → 越界
  for (let k = 1; k < hits.length; k++) {
    if (hits[k].i - (hits[k - 1].i + hits[k - 1].len) > 120) return null; // 词元间隙过大 → 越界
  }
  const start = idx.toRaw[first.i];
  const end = idx.toRaw[Math.min(last.i + last.len - 1, idx.toRaw.length - 1)] + 1;
  return { start, end };
}

function rawRangeToRects(map, items, start, end) {
  const runs = [];
  let cur = null;
  for (let k = start; k < end; k++) {
    const m = map[k];
    if (!m) continue;
    const it = items[m.idx];
    const charW = it.width > 0 ? it.width / it.str.length : it.fs * 0.5;
    const x0 = it.x + m.off * charW;
    const y = it.y - it.fs * 0.2; // 基线下方留一点余量
    const h = it.fs * 1.2;
    if (cur && cur.item === m.idx && Math.abs(x0 - cur.x2) < charW * 0.5) {
      cur.x2 = x0 + charW;
    } else {
      if (cur) runs.push(cur);
      cur = { item: m.idx, x1: x0, x2: x0 + charW, y, h };
    }
  }
  if (cur) runs.push(cur);

  // 合并同一行的相邻片段
  const rects = [];
  for (const r of runs) {
    const prev = rects[rects.length - 1];
    if (prev && Math.abs(prev.y - r.y) < 1 && r.x1 - (prev.x + prev.width) < 2) {
      prev.width = r.x2 - prev.x;
      prev.height = Math.max(prev.height, r.h);
    } else {
      rects.push({ x: r.x1, y: r.y, width: r.x2 - r.x1, height: r.h });
    }
  }
  return rects;
}

/**
 * 在 PDF 指定页中定位句子，返回各句的矩形坐标。
 * @returns {Promise<Array<{sentence:string, rects:Array<{x,y,width,height}>}>>}
 */
export async function locateSentences(pdfPath, pageNumber, sentences) {
  const items = await getPageItems(pdfPath, pageNumber);
  if (!items.length) return [];
  const idx0 = buildIndex(items, '');
  const idx1 = buildIndex(items, ' ');
  const out = [];
  for (const s of sentences.slice(0, 5)) {
    const q = normalizeQuery(String(s).slice(0, 500));
    if (!q) continue;
    let found = null;
    for (const idx of [idx0, idx1]) {
      const r = exactRange(idx, q);
      if (r) { found = { ...r, map: idx.map }; break; }
    }
    if (!found) {
      for (const idx of [idx0, idx1]) {
        const r = tokenRange(idx, q);
        if (r) { found = { ...r, map: idx.map }; break; }
      }
    }
    if (!found) continue;
    const rects = rawRangeToRects(found.map, items, found.start, found.end);
    if (rects.length && rects.reduce((a, r) => a + r.width, 0) > 5) {
      out.push({ sentence: s, rects });
    }
  }
  return out;
}
