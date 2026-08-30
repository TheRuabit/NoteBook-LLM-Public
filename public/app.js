import * as pdfjsLib from '/vendor/pdfjs-dist/build/pdf.mjs';
import { restoreScrollTop } from './scroll-position.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-dist/build/pdf.worker.mjs';

const $ = (id) => document.getElementById(id);
const SCALE = 1.4;

let docs = [];
let currentFile = null; // 当前打开的 PDF（相对路径）
let currentFolder = ''; // 文件夹筛选，'' = 全部
let pages = []; // { num, el, viewport }
let selection = null; // { text, page, rects:[{x,y,width,height}] } PDF 坐标
let lastAnswer = null; // { summary, takeaways, notes_relation, located }
let openGeneration = 0;

// ---------- 文档列表 ----------
async function loadDocs() {
  docs = await (await fetch('/api/docs')).json();
  $('doc-count').textContent = `(${docs.length})`;
  const folders = [...new Set(docs.map((d) => d.folder).filter(Boolean))].sort();
  const sel = $('folder-filter');
  sel.innerHTML = '<option value="">全部文件夹</option>' + folders.map((f) => `<option value="${f}">${f}</option>`).join('');
  sel.value = folders.includes(currentFolder) ? currentFolder : '';
  renderDocList();
}

function renderDocList() {
  const ul = $('doc-list');
  ul.innerHTML = '';
  const shown = currentFolder ? docs.filter((d) => d.folder === currentFolder) : docs;
  for (const d of shown) {
    const li = document.createElement('li');
    li.textContent = d.folder ? `${d.folder} / ${d.name}` : d.name;
    if (d.annotated) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '已标注';
      li.appendChild(badge);
    }
    li.title = d.file;
    li.onclick = () => openDoc(d.file);
    ul.appendChild(li);
  }
}

// ---------- PDF 渲染 ----------
async function openDoc(file, savedScrollTop) {
  const generation = ++openGeneration;
  currentFile = file;
  selection = null;
  lastAnswer = null;
  pages = [];
  resetBoxSelect();
  $('current-doc').textContent = file;
  $('manual-note').value = '';
  hideAnswer();
  const container = $('pages');
  container.innerHTML = '';
  const pdf = await pdfjsLib.getDocument({ url: '/api/pdf?file=' + encodeURIComponent(file) }).promise;
  if (generation !== openGeneration) return;
  for (let num = 1; num <= pdf.numPages; num++) {
    const page = await pdf.getPage(num);
    if (generation !== openGeneration) return;
    const viewport = page.getViewport({ scale: SCALE });
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.style.width = viewport.width + 'px';
    wrap.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    wrap.appendChild(canvas);

    const layer = document.createElement('div');
    layer.className = 'textLayer';
    layer.style.setProperty('--scale-factor', viewport.scale);
    wrap.appendChild(layer);

    const annotationLayer = document.createElement('div');
    annotationLayer.className = 'annotationLayer';
    wrap.appendChild(annotationLayer);

    const numEl = document.createElement('div');
    numEl.className = 'page-num';
    numEl.textContent = `第 ${num} 页`;
    wrap.appendChild(numEl);

    container.appendChild(wrap);

    await page.render({ canvasContext: ctx, viewport }).promise;
    if (generation !== openGeneration) return;
    const textContent = await page.getTextContent();
    if (generation !== openGeneration) return;
    const textLayer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: layer, viewport });
    await textLayer.render();
    if (generation !== openGeneration) return;
    const annotations = await page.getAnnotations();
    if (generation !== openGeneration) return;
    if (annotations.length) {
      const al = new pdfjsLib.AnnotationLayer({ div: annotationLayer, page, viewport });
      // 论文常含链接批注，AnnotationLayer 需要一个最小 linkService
      const linkService = {
        addLinkAttributes(link, url) { link.href = url; link.target = '_blank'; },
        getDestinationHash() { return '#'; },
      };
      await al.render({ annotations, linkService, imageResourcesPath: '/annotation-icons/' });
      if (generation !== openGeneration) return;
    }
    pages.push({ num, el: layer, viewport });
  }
  if (generation !== openGeneration) return;
  if (savedScrollTop != null) {
    restoreScrollTop($('viewer'), savedScrollTop);
  }
}

// ---------- 选区捕获 ----------
function captureSelection() {
  if (boxSelectMode || boxDrag) return; // 框选模式下不处理文本选区
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const text = range.toString().replace(/\s+/g, ' ').trim();
  if (!text || text.length > 8000) return;
  const clientRects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
  if (!clientRects.length) return;

  const rects = [];
  for (const r of clientRects) {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const page = pages.find((p) => {
      const b = p.el.getBoundingClientRect();
      return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
    });
    if (!page) continue;
    const b = page.el.getBoundingClientRect();
    // v4 返回 [x, y] 数组；PDF 坐标 y 轴向上，CSS 底部对应更小的 PDF y
    const [x1, y1] = page.viewport.convertToPdfPoint(r.left - b.left, r.top - b.top);
    const [x2, y2] = page.viewport.convertToPdfPoint(r.right - b.left, r.bottom - b.top);
    rects.push({ page: page.num, x: x1, y: y2, width: x2 - x1, height: y1 - y2 });
  }
  if (!rects.length) return;

  hideAnswer(); // 清掉上一次的 AI 结果
  selection = { text, rects };
  $('selection-preview').textContent = `[第 ${rects[0].page} 页] ${text.slice(0, 300)}${text.length > 300 ? '…' : ''}`;
  $('selection-preview').classList.remove('hidden');
  setSelectionActions(true);
}

function setSelectionActions(enabled, canAsk = enabled) {
  $('btn-ask').disabled = !canAsk;
  $('btn-manual-highlight').disabled = !enabled;
  $('btn-manual-note').disabled = !enabled;
  $('manual-note').disabled = !enabled;
}

// ---------- 框选模式（截图式：可连续框选多个区域） ----------
let boxSelectMode = false; // 模式开关
let boxDrag = null; // 拖拽中的框 { wrap, num, viewport, startX, startY, overlay }
let boxRects = []; // 已确认的框 { num, pdfX,pdfY,pdfW,pdfH, overlay, text }

function toggleBoxSelect() {
  if (boxSelectMode) finishBoxSelect();
  else {
    boxSelectMode = true;
    updateBoxUI();
  }
}

// 退出框选模式：已有框选转为选区，但保留页面上的临时预览
function finishBoxSelect() {
  boxSelectMode = false;
  cancelBoxDrag();
  const boxes = boxRects;
  updateBoxUI();
  if (!boxes.length) return;
  const rects = boxes.map((bx) => ({ page: bx.num, x: bx.pdfX, y: bx.pdfY, width: bx.pdfW, height: bx.pdfH }));
  const hasText = boxes.some((bx) => bx.text);
  const text = boxes.map((bx) => `【第 ${bx.num} 页】${bx.text}`).join('\n').slice(0, 8000);
  hideAnswer();
  selection = { text, rects };
  $('selection-preview').textContent = hasText
    ? `[框选 ${boxes.length} 个区域] ${text.slice(0, 300)}${text.length > 300 ? '…' : ''}`
    : `[框选 ${boxes.length} 个区域] 未识别到文字，可直接高亮或批注`;
  $('selection-preview').classList.remove('hidden');
  setSelectionActions(true, hasText);
}

// 打开新文档时强制清空（不提交）
function resetBoxSelect() {
  boxSelectMode = false;
  cancelBoxDrag();
  for (const bx of boxRects) bx.overlay.remove();
  boxRects = [];
  updateBoxUI();
}

function clearBoxes() {
  cancelBoxDrag();
  for (const bx of boxRects) bx.overlay.remove();
  boxRects = [];
  updateBoxUI();
}

function cancelBoxDrag() {
  if (boxDrag) {
    boxDrag.overlay.remove();
    boxDrag = null;
  }
}

function updateBoxUI() {
  const btn = $('btn-box');
  btn.classList.toggle('active', boxSelectMode);
  btn.textContent = boxSelectMode ? `完成框选（${boxRects.length}）✓` : boxRects.length ? `▭ 继续框选（${boxRects.length}）` : '▭ 框选';
  $('viewer').classList.toggle('box-select', boxSelectMode);
  $('btn-box-clear').classList.toggle('hidden', !boxRects.length);
  const hint = $('box-hint');
  hint.textContent = boxSelectMode
    ? boxRects.length
      ? `已框选 ${boxRects.length} 个区域，继续拖拽添加，或点「完成框选」`
      : '框选模式：拖拽矩形选择区域（可连续框选多个），Esc 完成'
    : boxRects.length
      ? `已保留 ${boxRects.length} 个临时选区；可继续框选或清除`
      : '';
  hint.classList.toggle('hidden', !boxSelectMode && !boxRects.length);
}

$('viewer').addEventListener('mousedown', (e) => {
  if (!boxSelectMode) return;
  const wrap = e.target.closest('.page-wrap');
  if (!wrap) return;
  e.preventDefault(); // 阻止文本选区与拖拽滚动
  const p = pages.find((pg) => pg.el === wrap.querySelector('.textLayer'));
  if (!p) return;
  const b = wrap.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.className = 'box-overlay';
  wrap.appendChild(overlay);
  const x = e.clientX - b.left;
  const y = e.clientY - b.top;
  overlay.style.left = x + 'px';
  overlay.style.top = y + 'px';
  boxDrag = { wrap, num: p.num, viewport: p.viewport, startX: x, startY: y, overlay };
});

document.addEventListener('mousemove', (e) => {
  if (!boxDrag) return;
  const b = boxDrag.wrap.getBoundingClientRect();
  const x = e.clientX - b.left;
  const y = e.clientY - b.top;
  const x1 = Math.min(boxDrag.startX, x);
  const y1 = Math.min(boxDrag.startY, y);
  Object.assign(boxDrag.overlay.style, {
    left: x1 + 'px',
    top: y1 + 'px',
    width: Math.abs(x - boxDrag.startX) + 'px',
    height: Math.abs(y - boxDrag.startY) + 'px',
  });
});

document.addEventListener('mouseup', (e) => {
  if (!boxDrag) return;
  const drag = boxDrag;
  boxDrag = null;
  const b = drag.wrap.getBoundingClientRect();
  const x = e.clientX - b.left;
  const y = e.clientY - b.top;
  const x1 = Math.min(drag.startX, x);
  const y1 = Math.min(drag.startY, y);
  const x2 = Math.max(drag.startX, x);
  const y2 = Math.max(drag.startY, y);
  if (x2 - x1 < 8 || y2 - y1 < 8) { drag.overlay.remove(); return; } // 过小视为误触
  const text = collectBoxText(drag.wrap, x1, y1, x2, y2);
  // CSS 矩形 → PDF 坐标（y 轴向上；v4 convertToPdfPoint 返回 [x, y] 数组）
  const [px1, py1] = drag.viewport.convertToPdfPoint(x1, y1);
  const [px2, py2] = drag.viewport.convertToPdfPoint(x2, y2);
  // 确认：overlay 保留为临时虚线预览，继续可框下一个
  boxRects.push({ num: drag.num, pdfX: px1, pdfY: py2, pdfW: px2 - px1, pdfH: py1 - py2, overlay: drag.overlay, text });
  updateBoxUI();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (boxDrag) { cancelBoxDrag(); return; }
  if (boxSelectMode) finishBoxSelect();
});

// 收集框选矩形（页内 CSS 坐标）覆盖到的文本：span 中心点在内即收集，
// 按渲染顺序拼接，换行（top 变化大）或行内间隙（left 跳变）补分隔
function collectBoxText(wrap, x1, y1, x2, y2) {
  const b = wrap.getBoundingClientRect();
  const parts = [];
  let lastTop = null;
  let lastRight = null;
  for (const span of wrap.querySelectorAll('.textLayer span')) {
    const r = span.getBoundingClientRect();
    const left = r.left - b.left;
    const top = r.top - b.top;
    const right = r.right - b.left;
    const bottom = r.bottom - b.top;
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    if (cx < x1 || cx > x2 || cy < y1 || cy > y2) continue;
    if (lastTop !== null && Math.abs(top - lastTop) > 4) parts.push('\n');
    else if (lastRight !== null && left - lastRight > 2) parts.push(' ');
    parts.push(span.textContent);
    lastTop = top;
    lastRight = right;
  }
  return parts.join('').trim().slice(0, 8000);
}

// ---------- AI 问答 ----------
async function askAI() {
  if (!selection) return;
  const btn = $('btn-ask');
  btn.disabled = true;
  btn.textContent = 'AI 思考中…';
  showError('');
  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdf: currentFile,
        page: selection.rects[0].page,
        text: selection.text,
        prompt: $('prompt-input').value.trim(),
        mode: document.querySelector('input[name="askmode"]:checked')?.value ?? 'selection',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    lastAnswer = data;
    renderAnswer(data);
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '问 AI';
  }
}

function renderAnswer(data) {
  const body = $('answer-body');
  const parts = [];
  parts.push(`**总结**\n${data.summary}`);
  if (data.takeaways?.length) parts.push(`\n**要点**\n${data.takeaways.map((t) => `• ${t}`).join('\n')}`);
  if (data.notes_relation) parts.push(`\n**与笔记的关系**\n${data.notes_relation}`);
  body.innerHTML = '';
  for (const p of parts) {
    const div = document.createElement('div');
    div.innerHTML = p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*\*(.+?)\*\*/g, '<div class="h">$1</div>').replace(/\n/g, '<br>');
    body.appendChild(div);
  }
  const locPages = [...new Set((data.located ?? []).map((l) => l.page ?? selection.rects[0].page))];
  $('located-info').textContent = data.located?.length
    ? `AI 已定位 ${data.located.length} 处高亮句（第 ${locPages.join('、')} 页），可随「写入 PDF」一并应用`
    : '（本次未定位到可高亮的句子，将仅高亮你的选区）';
  $('answer').classList.remove('hidden');
  $('download-link').classList.add('hidden');
}

// ---------- 写入 PDF ----------
function selectionAnnotations(note, inline = false) {
  const byPage = new Map();
  for (const r of selection.rects) {
    if (!byPage.has(r.page)) byPage.set(r.page, []);
    byPage.get(r.page).push(r);
  }
  return [...byPage].map(([page, rects]) => ({ page, rects, note, inline }));
}

async function writeAnnotations(annotations, label = '批注') {
  try {
    const res = await fetch('/api/annotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf: currentFile, annotations, label }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadDocs();
    const savedScrollTop = $('viewer').scrollTop;
    await openDoc(data.file, savedScrollTop); // 刷新显示标注版
    $('download-link').href = '/api/pdf?file=' + encodeURIComponent(data.file) + '&download=1';
    $('download-link').textContent = `下载标注版（${data.annotations} 处批注）`;
    $('download-link').classList.remove('hidden');
    return true;
  } catch (e) {
    showError(e.message);
    return false;
  }
}

async function annotatePDF() {
  if (!selection || !lastAnswer) return;
  const inline = $('chk-inline').checked;
  const note = [`AI 总结：${lastAnswer.summary}`];
  if (lastAnswer.takeaways?.length) note.push('要点：' + lastAnswer.takeaways.join('；'));
  if (lastAnswer.notes_relation) note.push('与笔记：' + lastAnswer.notes_relation);
  const annotations = selectionAnnotations(note.join('\n'), inline);
  for (const loc of lastAnswer.located ?? []) {
    annotations.push({ page: loc.page ?? selection.rects[0].page, rects: loc.rects, note: 'AI 定位句：' + loc.sentence.slice(0, 200), color: [0.6, 0.85, 0.4], inline });
  }
  await writeAnnotations(annotations, 'AI 批注');
}

async function highlightSelection() {
  if (selection) await writeAnnotations(selectionAnnotations(''), '高亮');
}

async function annotateSelection() {
  if (!selection) return;
  const note = $('manual-note').value.trim();
  if (!note) return showError('请输入批注内容');
  if (await writeAnnotations(selectionAnnotations(note), '文字批注')) $('manual-note').value = '';
}

async function refreshAnnotations() {
  const list = $('annotation-list');
  if (!currentFile) return (list.textContent = '打开 PDF 后可管理写入的批注。');
  try {
    const res = await fetch('/api/annotations?pdf=' + encodeURIComponent(currentFile));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    list.innerHTML = '';
    if (!data.nodes.length) return (list.textContent = '暂无可编辑批注。');
    for (const node of data.nodes) {
      const item = document.createElement('div');
      item.className = 'annotation-item';
      const title = document.createElement('strong');
      title.textContent = node.label;
      const meta = document.createElement('span');
      meta.textContent = `第 ${node.pages.join('、') || '?'} 页 · ${node.count} 处`;
      const preview = document.createElement('p');
      preview.textContent = node.preview || '高亮';
      const remove = document.createElement('button');
      remove.textContent = '删除';
      remove.onclick = () => deleteAnnotation(node.id);
      item.append(title, meta, preview, remove);
      list.appendChild(item);
    }
  } catch (e) {
    list.textContent = e.message;
  }
}

async function deleteAnnotation(id) {
  if (!confirm('删除这条批注？标注版会按剩余批注重建。')) return;
  try {
    const res = await fetch('/api/annotations/' + encodeURIComponent(id), {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pdf: currentFile }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const savedScrollTop = $('viewer').scrollTop;
    await loadDocs();
    await openDoc(data.file, savedScrollTop);
    await refreshAnnotations();
  } catch (e) {
    showError(e.message);
  }
}

// ---------- 笔记 ----------
async function refreshNotes() {
  if (!currentFile) return;
  try {
    const res = await fetch('/api/notes?file=' + encodeURIComponent(currentFile));
    const data = await res.json();
    const list = $('notes-list');
    if (!data.files?.length) {
      list.textContent = '（该文献暂无笔记文件，AI 结果将保存到 <文件名>-notes.md）';
      return;
    }
    list.textContent = data.files.map((f) => `--- ${f.name} ---\n${f.content}`).join('\n\n');
  } catch { /* ignore */ }
}

async function appendNote(section) {
  if (!section) return;
  try {
    const res = await fetch('/api/notes/append', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf: currentFile, section }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    $('note-input').value = '';
    await refreshNotes();
  } catch (e) {
    showError(e.message);
  }
}

function saveAItoNotes() {
  if (!selection || !lastAnswer) return;
  const selPages = [...new Set(selection.rects.map((r) => r.page))];
  const section = [
    `**选区**（第 ${selPages.join('、')} 页）：`,
    `> ${selection.text.slice(0, 500)}`,
    '',
    `**AI 总结**：${lastAnswer.summary}`,
    lastAnswer.takeaways?.length ? `**要点**：\n${lastAnswer.takeaways.map((t) => `- ${t}`).join('\n')}` : '',
    lastAnswer.notes_relation ? `**与笔记的关系**：${lastAnswer.notes_relation}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  appendNote(section);
}

// ---------- 设置 ----------
async function openSettings() {
  const cfg = await (await fetch('/api/settings')).json();
  $('cfg-baseurl').value = cfg.baseURL;
  $('cfg-apikey').value = '';
  $('cfg-apikey').placeholder = cfg.hasApiKey ? '已保存；留空则不修改' : 'sk-...';
  $('cfg-model').value = cfg.model;
  $('modal').classList.remove('hidden');
}

async function saveSettings() {
  await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseURL: $('cfg-baseurl').value.trim(),
      apiKey: $('cfg-apikey').value.trim(),
      model: $('cfg-model').value.trim(),
    }),
  });
  $('modal').classList.add('hidden');
}

// ---------- 工具函数 ----------
// 弹窗默认紧贴注释右侧展开（pdf.js 的 #setPosition）：水平方向允许溢出 A4 页面，
// 溢出部分落在页面外的空白区（overflow: visible + 最高 z-index 保证可见）。
// 只做竖直修正：弹窗底部不越过本页底部，避免盖住下一页的正文。
function fixPopupOverflow() {
  for (const sec of document.querySelectorAll('.annotationLayer .popupAnnotation')) {
    const wrap = sec.closest('.page-wrap');
    const wrapRect = wrap.getBoundingClientRect();
    const secRect = sec.getBoundingClientRect();
    if (!secRect.width && !secRect.height) continue; // 弹窗未显示
    const bottom = secRect.bottom - wrapRect.top;
    if (bottom > wrapRect.height - 2) {
      const top = parseFloat(sec.style.top);
      if (Number.isNaN(top)) continue;
      sec.style.top = Math.max(0, top - ((bottom - wrapRect.height + 2) / wrapRect.height) * 100) + '%';
    }
  }
}
function hideAnswer() {
  $('answer').classList.add('hidden');
  $('download-link').classList.add('hidden');
  setSelectionActions(false);
  $('selection-preview').classList.add('hidden');
}
function showError(msg) {
  const box = $('error-box');
  if (!msg) { box.classList.add('hidden'); return; }
  box.textContent = msg;
  box.classList.remove('hidden');
}

// ---------- 文献库管理 ----------
async function addDir() {
  const p = $('dir-input').value.trim();
  if (!p) return;
  try {
    const res = await fetch('/api/dirs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    $('dir-input').value = '';
    await loadDocs();
  } catch (e) {
    showError(e.message);
  }
}

async function pickDir() {
  const btn = $('btn-pick-dir');
  btn.disabled = true;
  try {
    const res = await fetch('/api/dirs/pick', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (!data.cancelled) await loadDocs();
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- 事件绑定 ----------
// 弹窗在显示时才被 pdf.js 设置 left/top，故在 hover/click 后延迟修正出界位置
document.addEventListener('mouseover', (e) => { if (e.target.closest('.annotationLayer')) setTimeout(fixPopupOverflow, 60); });
document.addEventListener('click', (e) => { if (e.target.closest('.annotationLayer')) setTimeout(fixPopupOverflow, 60); });
$('folder-filter').onchange = (e) => { currentFolder = e.target.value; renderDocList(); };
$('btn-add-dir').onclick = addDir;
$('btn-pick-dir').onclick = pickDir;
$('dir-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addDir(); });
$('btn-box').onclick = toggleBoxSelect;
$('btn-box-clear').onclick = clearBoxes;
$('btn-ask').onclick = askAI;
$('btn-annotate').onclick = annotatePDF;
$('btn-manual-highlight').onclick = highlightSelection;
$('btn-manual-note').onclick = annotateSelection;
$('btn-save-notes').onclick = saveAItoNotes;
$('btn-note-append').onclick = () => appendNote($('note-input').value.trim());
$('btn-settings').onclick = openSettings;
$('btn-cfg-save').onclick = saveSettings;
$('btn-cfg-cancel').onclick = () => $('modal').classList.add('hidden');
$('tab-ai').onclick = () => { $('tab-ai').classList.add('active'); $('tab-notes').classList.remove('active'); $('tab-annotations').classList.remove('active'); $('tab-ai-body').classList.remove('hidden'); $('tab-notes-body').classList.add('hidden'); $('tab-annotations-body').classList.add('hidden'); };
$('tab-notes').onclick = () => { $('tab-notes').classList.add('active'); $('tab-ai').classList.remove('active'); $('tab-annotations').classList.remove('active'); $('tab-notes-body').classList.remove('hidden'); $('tab-ai-body').classList.add('hidden'); $('tab-annotations-body').classList.add('hidden'); refreshNotes(); };
$('tab-annotations').onclick = () => { $('tab-annotations').classList.add('active'); $('tab-ai').classList.remove('active'); $('tab-notes').classList.remove('active'); $('tab-annotations-body').classList.remove('hidden'); $('tab-ai-body').classList.add('hidden'); $('tab-notes-body').classList.add('hidden'); refreshAnnotations(); };
$('viewer').addEventListener('mouseup', captureSelection);

loadDocs();
