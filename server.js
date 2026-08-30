import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from './lib/config.js';
import { chat, parseReply } from './lib/llm.js';
import { annotatePdf } from './lib/annotate.js';
import { locateSentences } from './lib/locate.js';
import { extractPageText, extractFullText } from './lib/paperText.js';
import { pickFolder } from './lib/folderPicker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAPERS_DIR = path.join(__dirname, 'Papers');
const PORT = process.env.PORT || 3000;
const ANNOTATION_STATE_DIR = process.env.ANNOTATION_STATE_DIR || path.join(PAPERS_DIR, '.annotation-state');

// 文献库：默认 PDFEditor/Papers，用户可添加任意文件夹（文章+md 混放、递归子文件夹）
function buildLibraries(dirs) {
  const list = (dirs?.length ? dirs : [PAPERS_DIR]).map((p) => {
    const requested = path.resolve(p);
    const abs = fs.existsSync(requested) ? fs.realpathSync(requested) : requested;
    return { id: toPosix(abs), name: path.basename(abs) || abs, path: abs };
  });
  const seen = new Set();
  return list.filter((l) => {
    const k = l.path.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
let LIBRARIES = buildLibraries(loadConfig().paperDirs);
const annotationQueues = new Map();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  if (req.path.endsWith('.mjs')) res.type('application/javascript');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/pdfjs-dist', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist')));
app.use('/annotation-icons', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'web', 'images')));

function toPosix(p) { return p.split(path.sep).join('/'); }

function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function resolveInLibrary(root, relPath) {
  const abs = path.resolve(root, relPath ?? '');
  if (!isWithin(root, abs)) throw new Error('非法路径');
  if (!fs.existsSync(abs)) return abs;
  const real = fs.realpathSync(abs);
  if (!isWithin(root, real)) throw new Error('非法路径');
  return real;
}

function safeResolve(rel) {
  if (typeof rel === 'string' && rel.includes('::')) {
    const sep = rel.indexOf('::');
    const id = rel.slice(0, sep);
    const relPath = rel.slice(sep + 2);
    const lib = LIBRARIES.find((l) => l.id === id);
    if (!lib) throw new Error('未知文献库');
    return resolveInLibrary(lib.path, relPath);
  }
  // 旧格式：相对默认 Papers 库
  const root = fs.existsSync(PAPERS_DIR) ? fs.realpathSync(PAPERS_DIR) : PAPERS_DIR;
  return resolveInLibrary(root, rel);
}

function libraryRef(abs) {
  const lib = LIBRARIES.find((l) => isWithin(l.path, abs));
  if (!lib) throw new Error('文件不属于已添加的文献库');
  return `${lib.id}::${toPosix(path.relative(lib.path, abs))}`;
}

function findMdSiblings(pdfAbs) {
  const dir = path.dirname(pdfAbs);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => path.join(dir, f));
}

function annotatedPath(pdfAbs) {
  const { dir, name } = path.parse(pdfAbs);
  return name.endsWith('-annotated') ? pdfAbs : path.join(dir, `${name}-annotated.pdf`);
}

function withAnnotationLock(source, task) {
  const previous = annotationQueues.get(source) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  annotationQueues.set(source, current);
  return current.finally(() => {
    if (annotationQueues.get(source) === current) annotationQueues.delete(source);
  });
}

function sourcePdfPath(pdfAbs) {
  const { dir, name, ext } = path.parse(pdfAbs);
  if (!name.endsWith('-annotated')) return pdfAbs;
  return path.join(dir, `${name.slice(0, -'-annotated'.length)}${ext}`);
}

function annotationStatePath(source, ext) {
  const key = createHash('sha256').update(process.platform === 'win32' ? source.toLowerCase() : source).digest('hex');
  return path.join(ANNOTATION_STATE_DIR, `${key}${ext}`);
}

function annotationHistoryPath(source) { return annotationStatePath(source, '.json'); }
function annotationBaselinePath(source) { return annotationStatePath(source, '.pdf'); }
function legacyAnnotationHistoryPath(source) { return `${source}.annotations.json`; }
function legacyAnnotationBaselinePath(source) { return `${source}.annotations-baseline`; }

function atomicWrite(file, data, encoding) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, data, encoding);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function atomicCopy(source, output) {
  atomicWrite(output, fs.readFileSync(source));
}

function annotationHistoryFile(source) {
  const privateFile = annotationHistoryPath(source);
  if (fs.existsSync(privateFile)) return privateFile;
  const legacyFile = legacyAnnotationHistoryPath(source);
  return fs.existsSync(legacyFile) && fs.existsSync(annotatedPath(source)) ? legacyFile : null;
}

function migrateLegacyAnnotationState(source) {
  if (fs.existsSync(annotationHistoryPath(source))) return;
  const legacyHistory = legacyAnnotationHistoryPath(source);
  if (!fs.existsSync(legacyHistory) || !fs.existsSync(annotatedPath(source))) return;
  const legacyBaseline = legacyAnnotationBaselinePath(source);
  if (fs.existsSync(legacyBaseline)) atomicCopy(legacyBaseline, annotationBaselinePath(source));
  atomicCopy(legacyHistory, annotationHistoryPath(source));
}

function loadAnnotationHistory(source) {
  const file = annotationHistoryFile(source);
  if (!file) return null;
  try {
    const history = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (history.version !== 1 || !['original', 'snapshot'].includes(history.baseline) || !Array.isArray(history.nodes) || !history.nodes.every((n) => typeof n.id === 'string' && Array.isArray(n.annotations))) throw new Error();
    return history;
  } catch {
    throw new Error('批注编辑记录已损坏');
  }
}

function saveAnnotationHistory(source, history) {
  atomicWrite(annotationHistoryPath(source), JSON.stringify(history, null, 2), 'utf8');
}

function newAnnotationHistory(source, output) {
  const existingAnnotatedOnly = path.parse(source).name.endsWith('-annotated');
  const baseline = fs.existsSync(output) && (output !== source || existingAnnotatedOnly) ? 'snapshot' : 'original';
  if (baseline === 'snapshot') atomicCopy(output, annotationBaselinePath(source));
  return { version: 1, baseline, nodes: [] };
}

function historyInputPath(source, history) {
  const input = history.baseline === 'snapshot' ? annotationBaselinePath(source) : source;
  if (!fs.existsSync(input)) throw new Error('批注基线文件不存在');
  return input;
}

async function rebuildAnnotations(source, output, history) {
  const annotations = history.nodes.flatMap((node) => node.annotations);
  const { bytes, count } = await annotatePdf(fs.readFileSync(historyInputPath(source, history)), annotations);
  atomicWrite(output, bytes);
  return count;
}

function annotationNodes(history) {
  return history.nodes.map((node) => {
    const pages = [...new Set(node.annotations.map((a) => Number(a.page)).filter(Number.isInteger))].sort((a, b) => a - b);
    const preview = node.annotations.map((a) => String(a.note ?? '').trim()).find(Boolean) ?? '';
    return { id: node.id, label: node.label, createdAt: node.createdAt, pages, count: node.annotations.length, preview: preview.slice(0, 120) };
  });
}

function listDocs() {
  const out = [];
  // 库名重复时用「父目录/库名」消歧（如 PDFEditor/Papers vs Notes/Papers）
  const nameCounts = new Map();
  for (const l of LIBRARIES) nameCounts.set(l.name, (nameCounts.get(l.name) ?? 0) + 1);
  const label = (l) => (nameCounts.get(l.name) > 1 ? `${path.basename(path.dirname(l.path))}/${l.name}` : l.name);
  const walk = (dir, lib) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, lib);
      else if (entry.name.toLowerCase().endsWith('.pdf')) {
        const rel = toPosix(path.relative(lib.path, abs));
        const relDir = path.dirname(rel);
        out.push({
          file: `${lib.id}::${rel}`,
          name: entry.name,
          folder: `${label(lib)}${relDir === '.' ? '' : '/' + relDir}`,
          annotated: fs.existsSync(annotatedPath(abs)),
        });
      }
    }
  };
  for (const lib of LIBRARIES) {
    if (fs.existsSync(lib.path)) walk(lib.path, lib);
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function notesContext(pdfAbs) {
  const files = findMdSiblings(pdfAbs);
  if (!files.length) return null;
  return files
    .map((f) => `### ${path.basename(f)}\n${fs.readFileSync(f, 'utf8').slice(0, 20000)}`)
    .join('\n\n')
    .slice(0, 40000);
}

function addLibraryDir(dir) {
  const requested = path.resolve(dir);
  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) throw new Error('路径不存在或不是文件夹');
  const abs = fs.realpathSync(requested);
  const cfg = loadConfig();
  const dirs = [...(cfg.paperDirs?.length ? cfg.paperDirs : [PAPERS_DIR])];
  const norm = (d) => path.resolve(d).toLowerCase();
  if (!dirs.some((d) => norm(d) === norm(abs))) dirs.push(abs);
  cfg.paperDirs = dirs;
  saveConfig(cfg);
  LIBRARIES = buildLibraries(dirs);
  return dirs;
}

app.get('/api/docs', (_req, res) => res.json(listDocs()));

app.get('/api/pdf', (req, res) => {
  try {
    const abs = safeResolve(req.query.file || '');
    if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件不存在' });
    if (req.query.download) return res.download(abs, path.basename(abs));
    res.setHeader('Content-Type', 'application/pdf');
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/notes', (req, res) => {
  try {
    const abs = safeResolve(req.query.file || '');
    if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件不存在' });
    const files = findMdSiblings(abs).map((f) => ({
      name: path.basename(f),
      content: fs.readFileSync(f, 'utf8'),
    }));
    res.json({ files });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/notes/append', (req, res) => {
  try {
    const { pdf, section } = req.body;
    const abs = safeResolve(pdf);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'PDF 不存在' });
    const { dir, name } = path.parse(abs);
    const notesFile = findMdSiblings(abs).find((f) => path.basename(f).includes('-notes')) ?? path.join(dir, `${name}-notes.md`);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const block = `\n\n---\n\n## AI 笔记 · ${stamp}\n\n${String(section).trim()}\n`;
    fs.appendFileSync(notesFile, block, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/ask', async (req, res) => {
  try {
    // mode: 'full' 结合全文 / 'page' 结合本页 / 'selection'（默认）仅框选；三种模式都必定携带用户笔记
    const { pdf, page, text, prompt, mode } = req.body;
    if (!pdf || !text || !text.trim()) return res.status(400).json({ error: '缺少选中文本' });
    const abs = safeResolve(pdf);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'PDF 不存在' });
    const cfg = loadConfig();
    const context = notesContext(abs);
    let paperCtx = null;
    if (mode === 'full') paperCtx = await extractFullText(abs);
    else if (mode === 'page') paperCtx = await extractPageText(abs, Number(page) || 1);
    const system = `你是一名科研文献阅读助手。用户正在阅读论文，通过"框选"方式选中了一处或多处区域（类似截图工具框选），每处区域以「【第 N 页】」标记开头。这些片段都是用户关注的内容——可能是同一主题的不同段落、跨页的相关论述，或需要对比的部分；框选区域内的文字可能因矩形覆盖而不完整，请基于内容整体理解。若提供了论文全文或本页上下文，请结合它们理解选中片段（选中片段可能不完整，上下文用于补全信息）。用户可能附有此前保存的笔记。
任务：
1. 用中文简洁总结这些片段的整体核心内容（150-250字），保留论文术语原文；若有多个片段，说明它们之间的关系（如并列、递进、对比、分属不同章节）。
2. 给出 2-4 条要点（takeaways），每条一句话。
3. 如果这些文字中存在值得高亮的关键句，从选中文本中逐字摘录 1-3 句（不得改写、不得超出选中文本范围），用于在 PDF 中定位高亮；若没有合适的，返回空数组。
4. 若提供了用户笔记，指出这些内容与笔记相关或可补充笔记之处。
只输出一个 JSON 对象：{"summary": string, "takeaways": string[], "highlight_sentences": string[], "notes_relation": string}。不要使用 markdown 代码块，不要输出 JSON 以外的任何文字。`;
    const user = [
      `论文文件：${pdf}`,
      paperCtx
        ? (mode === 'full' ? '论文全文（节选，含页码标记）：\n"""' : `第 ${page} 页上下文：\n"""`) + paperCtx + '"""'
        : null,
      `选中段落（第 ${page} 页）：`,
      `"""${String(text).slice(0, 8000)}"""`,
      context ? `用户已有笔记：\n"""${context}"""` : null,
      prompt ? `用户附加要求：${prompt}` : null,
    ]
      .filter(Boolean)
      .join('\n\n');
    const raw = await chat(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    const parsed = parseReply(raw);
    const located = [];
    // 文本中可能含多个「【第 N 页】」标记（多框选跨页）：对每个出现过的页码尝试定位
    const pageNums = [...new Set([Number(page), ...[...String(text).matchAll(/【第\s*(\d+)\s*页】/g)].map((m) => Number(m[1]))])];
    for (const s of (parsed.highlight_sentences ?? []).slice(0, 3)) {
      for (const p of pageNums) {
        const hits = await locateSentences(abs, p, [s]);
        if (hits.length) { located.push({ ...hits[0], page: p }); break; }
      }
    }
    res.json({
      summary: parsed.summary ?? '',
      takeaways: parsed.takeaways ?? [],
      notes_relation: parsed.notes_relation ?? '',
      highlight_sentences: parsed.highlight_sentences ?? [],
      located,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/annotate', async (req, res) => {
  try {
    const { pdf, annotations, label } = req.body;
    if (!pdf || !Array.isArray(annotations) || !annotations.length) return res.status(400).json({ error: '缺少批注数据' });
    const abs = safeResolve(pdf);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'PDF 不存在' });
    const source = sourcePdfPath(abs);
    const outPath = annotatedPath(source);
    const result = await withAnnotationLock(source, async () => {
      migrateLegacyAnnotationState(source);
      const history = loadAnnotationHistory(source) ?? newAnnotationHistory(source, outPath);
      history.nodes.push({
        id: randomUUID(),
        label: String(label ?? '').trim().slice(0, 60) || '批注',
        createdAt: new Date().toISOString(),
        annotations,
      });
      saveAnnotationHistory(source, history);
      const count = await rebuildAnnotations(source, outPath, history);
      return { file: libraryRef(outPath), annotations: count };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/annotations', (req, res) => {
  try {
    const source = sourcePdfPath(safeResolve(req.query.pdf || ''));
    const history = loadAnnotationHistory(source);
    res.json({ nodes: history ? annotationNodes(history) : [] });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/annotations/:id', async (req, res) => {
  try {
    const source = sourcePdfPath(safeResolve(req.body?.pdf || ''));
    const result = await withAnnotationLock(source, async () => {
      migrateLegacyAnnotationState(source);
      const history = loadAnnotationHistory(source);
      if (!history) throw Object.assign(new Error('没有可编辑的批注记录'), { status: 404 });
      const nodes = history.nodes.filter((node) => node.id !== req.params.id);
      if (nodes.length === history.nodes.length) throw Object.assign(new Error('批注节点不存在'), { status: 404 });
      history.nodes = nodes;
      const outPath = annotatedPath(source);
      if (nodes.length) {
        saveAnnotationHistory(source, history);
        const count = await rebuildAnnotations(source, outPath, history);
        return { file: libraryRef(outPath), nodes: nodes.length, annotations: count };
      }
      if (history.baseline === 'snapshot') {
        saveAnnotationHistory(source, history);
        atomicCopy(annotationBaselinePath(source), outPath);
        return { file: libraryRef(outPath), nodes: 0, annotations: 0 };
      }
      if (!fs.existsSync(source)) throw Object.assign(new Error('原始 PDF 不存在，已保留标注版'), { status: 409 });
      fs.rmSync(outPath, { force: true });
      fs.rmSync(annotationHistoryPath(source), { force: true });
      fs.rmSync(annotationBaselinePath(source), { force: true });
      return { file: libraryRef(source), nodes: 0, annotations: 0 };
    });
    res.json(result);
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

app.post('/api/dirs', (req, res) => {
  try {
    const p = String(req.body?.path ?? '').trim();
    if (!p) return res.status(400).json({ error: '路径不能为空' });
    res.json({ ok: true, dirs: addLibraryDir(p) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/dirs/pick', async (_req, res) => {
  try {
    const dir = await pickFolder();
    if (!dir) return res.json({ cancelled: true });
    res.json({ ok: true, dirs: addLibraryDir(dir) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', (_req, res) => {
  const { baseURL, model, apiKey } = loadConfig();
  res.json({ baseURL, model, hasApiKey: Boolean(apiKey) });
});

app.put('/api/settings', (req, res) => {
  const { baseURL, apiKey, model } = req.body;
  const cfg = loadConfig();
  if (typeof baseURL === 'string' && baseURL.trim()) cfg.baseURL = baseURL.trim();
  if (typeof model === 'string' && model.trim()) cfg.model = model.trim();
  if (typeof apiKey === 'string' && apiKey.trim()) cfg.apiKey = apiKey.trim();
  saveConfig(cfg);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`PDF AI 批注工具已启动: http://localhost:${PORT}`));
