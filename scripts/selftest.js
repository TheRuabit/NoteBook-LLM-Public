// 自测：用运行时生成的临时 PDF 验证 定位 → 批注 → HTTP 全链路（mock LLM，无需真实 key）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { locateSentences } from '../lib/locate.js';
import { annotatePdf } from '../lib/annotate.js';
import { pickFolder } from '../lib/folderPicker.js';

const SCROLL_HELPER = new URL('../public/scroll-position.js', import.meta.url);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(ROOT, '..', 'config.json');
const TEMP_LIBRARY = path.join(ROOT, '..', '.selftest-library');
const PDF = path.join(TEMP_LIBRARY, 'fixture.pdf');
const TEMP_STATE_DIR = path.join(ROOT, '..', '.selftest-annotation-state');
const TEMP_PDF = path.join(TEMP_LIBRARY, 'sample.pdf');
const TEMP_LEGACY_PDF = path.join(TEMP_LIBRARY, 'legacy.pdf');
const TEMP_LEGACY_ANNOTATED = path.join(TEMP_LIBRARY, 'legacy-annotated.pdf');
const TEMP_ORPHAN_ANNOTATED = path.join(TEMP_LIBRARY, 'orphan-annotated.pdf');
const TEMP_RACE_PDF = path.join(TEMP_LIBRARY, 'race.pdf');
const TEMP_VANISHED_PDF = path.join(TEMP_LIBRARY, 'vanished.pdf');
const TEMP_MIGRATED_PDF = path.join(TEMP_LIBRARY, 'migrated.pdf');
const TEMP_MIGRATED_ANNOTATED = path.join(TEMP_LIBRARY, 'migrated-annotated.pdf');
const MOCK_PORT = 18999;
const APP_PORT = 3100;

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  —  ' + extra : ''}`);
  if (!ok) failures++;
}

async function createFixturePdf() {
  fs.mkdirSync(TEMP_LIBRARY, { recursive: true });
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage([612, 792]);
  page1.drawText('PDF annotation self test verifies sentence location and portable local test data.', { x: 72, y: 700, size: 12, font });
  const page2 = doc.addPage([612, 792]);
  page2.drawText('Fixture page two supports annotation writing tests.', { x: 72, y: 700, size: 12, font });
  fs.writeFileSync(PDF, await doc.save());
}

async function pageText(pdfPath, pageNum) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await getDocument({ data, disableWorker: true, isEvalSupported: false, useSystemFonts: true }).promise;
  try {
    const page = await doc.getPage(pageNum);
    const tc = await page.getTextContent();
    return tc.items.map((i) => i.str).join(' ');
  } finally {
    await doc.destroy();
  }
}

async function pageAnnotationCount(pdfPath, pageNum = 1) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await getDocument({ data, disableWorker: true, isEvalSupported: false, useSystemFonts: true }).promise;
  try {
    return (await (await doc.getPage(pageNum)).getAnnotations()).length;
  } finally {
    await doc.destroy();
  }
}

function pickSentence(text) {
  const clean = text.replace(/\s+/g, ' ');
  const m = clean.match(/[A-Z][^.]{40,220}\./);
  return m ? m[0] : clean.slice(0, 150);
}

// ---------- 1. 句子定位 ----------
async function testLocate() {
  const text = await pageText(PDF, 1);
  const sentence = pickSentence(text);
  console.log(`\n[1] 句子定位  (页面第 1 页，样本句: "${sentence.slice(0, 80)}…")`);
  const located = await locateSentences(PDF, 1, [sentence]);
  const ok = located.length === 1 && located[0].rects.length > 0;
  check('locateSentences 返回坐标', ok, ok ? `${located[0].rects.length} 个矩形` : JSON.stringify(located));
  return located[0]?.rects ?? [{ x: 100, y: 700, width: 300, height: 12 }];
}

// ---------- 2. 批注写入 ----------
async function testAnnotate(rects) {
  console.log('\n[2] 批注写入（pdf-lib）');
  const tmp = path.join(ROOT, '..', '.selftest-annotated.pdf');
  const { bytes } = await annotatePdf(fs.readFileSync(PDF), [
    { page: 1, rects, note: '自测：AI 总结写回', color: [1, 0.85, 0.3] },
    { page: 2, rects: rects.map((r) => ({ ...r, y: r.y - 40 })), note: '自测：第 2 页' },
  ]);
  fs.writeFileSync(tmp, bytes);
  const data = new Uint8Array(fs.readFileSync(tmp));
  const doc = await getDocument({ data, disableWorker: true, isEvalSupported: false, useSystemFonts: true }).promise;
  const page = await doc.getPage(1);
  const annots = await page.getAnnotations();
  await doc.destroy();
  fs.rmSync(tmp, { force: true });
  check('标注后 PDF 可解析且含批注', annots.length >= 2, `${annots.length} 条批注`);
}

// ---------- 3. 系统文件夹选择器 ----------
async function testFolderPicker() {
  console.log('\n[3] 系统文件夹选择器');
  let command = null;
  const picked = await pickFolder(async (...args) => {
    command = args;
    return { stdout: Buffer.from('C:\\Papers', 'utf8').toString('base64') + '\r\n' };
  });
  check('选择器返回系统选择的路径', picked === 'C:\\Papers' && command?.[0]?.toLowerCase().includes('powershell'));
  const unicodePath = 'C:\\论文';
  const encodedPath = Buffer.from(unicodePath, 'utf8').toString('base64');
  const unicodePicked = await pickFolder(async () => ({ stdout: encodedPath }));
  check('选择器保留中文路径', unicodePicked === unicodePath);
  const cancelled = await pickFolder(async () => ({ stdout: '' }));
  check('取消选择器返回空路径', cancelled === '');
}

// ---------- 4. 阅读位置恢复 ----------
async function testScrollPosition() {
  console.log('\n[4] 阅读位置恢复');
  let restoreScrollTop;
  try {
    ({ restoreScrollTop } = await import(SCROLL_HELPER));
  } catch {}

  const viewer = { scrollTop: 0, scrollHeight: 1600, clientHeight: 600 };
  restoreScrollTop?.(viewer, 700);
  check('标注重载后恢复原阅读位置', viewer.scrollTop === 700);

  const shortViewer = { scrollTop: 0, scrollHeight: 800, clientHeight: 600 };
  restoreScrollTop?.(shortViewer, 700);
  check('文档变短时将位置限制在可滚动范围', shortViewer.scrollTop === 200);
}

// ---------- 5. HTTP 全链路（mock LLM） ----------
function startMockLLM(sentence) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.includes('/chat/completions')) {
        const reply = JSON.stringify({
          summary: '这是一段由 mock LLM 生成的总结：CacheWise 的核心贡献是把 serving 策略与 coding agent 工作负载特征对齐。',
          takeaways: ['prefix-aware 调度是第一杠杆', '工具元数据可预测复用时间'],
          highlight_sentences: [sentence],
          notes_relation: '与笔记中 Insight 第 1 条相关。',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
}

function startApp() {
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(ROOT, '..'), env: { ...process.env, PORT: String(APP_PORT), ANNOTATION_STATE_DIR: TEMP_STATE_DIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('应用启动超时')), 15000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('已启动')) { clearTimeout(timer); resolve(child); }
    });
    child.on('exit', (code) => reject(new Error(`应用退出 code=${code}`)));
  });
}

async function testHttp(sentence) {
  console.log('\n[5] HTTP 全链路（mock LLM @ :18999）');
  const mock = startMockLLM(sentence);
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  // 备份已有 config.json，测试后还原（不删除用户的真实配置）
  const hadConfig = fs.existsSync(CONFIG);
  const backup = hadConfig ? fs.readFileSync(CONFIG) : null;
  fs.writeFileSync(CONFIG, JSON.stringify({ baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'test', model: 'mock' }));
  let app = null;
  try {
    fs.rmSync(TEMP_STATE_DIR, { recursive: true, force: true });
    app = await startApp();
    const settings = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/settings`)).json();
    check('GET /api/settings 不返回 API Key', settings.hasApiKey === true && !Object.hasOwn(settings, 'apiKey'));

    await fetch(`http://127.0.0.1:${APP_PORT}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL: settings.baseURL, apiKey: settings.apiKey ?? '', model: 'mock-updated' }),
    });
    check('保存设置时保留未修改的 API Key', JSON.parse(fs.readFileSync(CONFIG, 'utf8')).apiKey === 'test');

    fs.mkdirSync(TEMP_LIBRARY, { recursive: true });
    fs.copyFileSync(PDF, TEMP_PDF);
    fs.copyFileSync(PDF, TEMP_LEGACY_PDF);
    const legacy = await annotatePdf(fs.readFileSync(TEMP_LEGACY_PDF), [
      { page: 1, rects: [{ x: 100, y: 700, width: 300, height: 12 }], note: '旧批注基线' },
    ]);
    fs.writeFileSync(TEMP_LEGACY_ANNOTATED, legacy.bytes);
    fs.copyFileSync(TEMP_LEGACY_ANNOTATED, TEMP_ORPHAN_ANNOTATED);
    fs.copyFileSync(PDF, TEMP_RACE_PDF);
    fs.copyFileSync(PDF, TEMP_VANISHED_PDF);
    fs.copyFileSync(PDF, TEMP_MIGRATED_PDF);
    const migrated = await annotatePdf(fs.readFileSync(TEMP_MIGRATED_PDF), [
      { page: 1, rects: [{ x: 100, y: 560, width: 300, height: 12 }] },
    ]);
    fs.writeFileSync(TEMP_MIGRATED_ANNOTATED, migrated.bytes);
    fs.writeFileSync(`${TEMP_MIGRATED_PDF}.annotations.json`, JSON.stringify({
      version: 1,
      baseline: 'original',
      nodes: [{ id: 'old-node', label: '旧批注', createdAt: '2026-01-01T00:00:00.000Z', annotations: [{ page: 1, rects: [{ x: 100, y: 560, width: 300, height: 12 }] }] }],
    }));
    const sampleBaseCount = await pageAnnotationCount(TEMP_PDF);
    const legacyBaselineCount = await pageAnnotationCount(TEMP_LEGACY_ANNOTATED);
    await fetch(`http://127.0.0.1:${APP_PORT}/api/dirs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: TEMP_LIBRARY }),
    });

    const docs = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/docs`)).json();
    const external = docs.find((d) => d.file.endsWith('::sample.pdf'));
    const legacyEntry = docs.find((d) => d.file.endsWith('::legacy.pdf'));
    const orphanEntry = docs.find((d) => d.file.endsWith('::orphan-annotated.pdf'));
    const raceEntry = docs.find((d) => d.file.endsWith('::race.pdf'));
    const vanishedEntry = docs.find((d) => d.file.endsWith('::vanished.pdf'));
    const migratedEntry = docs.find((d) => d.file.endsWith('::migrated.pdf'));
    check('GET /api/docs 列出外部文献库', !!external, external?.file);
    check('GET /api/docs 列出旧标注文献', !!legacyEntry, legacyEntry?.file);
    check('GET /api/docs 列出无原稿的标注版', !!orphanEntry, orphanEntry?.file);
    check('GET /api/docs 列出并发测试文献', !!raceEntry, raceEntry?.file);
    check('GET /api/docs 列出原稿消失测试文献', !!vanishedEntry, vanishedEntry?.file);
    check('GET /api/docs 列出旧编辑记录测试文献', !!migratedEntry, migratedEntry?.file);

    const text = await pageText(PDF, 1);
    const askRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf: external.file, page: 1, text: text.slice(0, 1200), prompt: '' }),
    });
    const ask = await askRes.json();
    check('POST /api/ask 返回总结', !!ask.summary, ask.summary ? ask.summary.slice(0, 40) + '…' : ask.error);
    check('AI 定位到高亮句', ask.located?.length >= 1, `${ask.located?.length} 处`);

    const annotateRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdf: external.file,
        annotations: [
          { page: 1, rects: ask.located?.[0]?.rects ?? [{ x: 100, y: 700, width: 300, height: 12 }], note: `AI 总结：${ask.summary}` },
          { page: 1, rects: [{ x: 100, y: 670, width: 300, height: 12 }] },
        ],
        label: 'AI 批注',
      }),
    });
    const ann = await annotateRes.json();
    const externalAnnotated = external.file.replace(/\.pdf$/, '-annotated.pdf');
    check('POST /api/annotate 写入高亮并返回外部库引用', ann.annotations >= 2 && ann.file === externalAnnotated, ann.file);
    check('编辑记录不写入外部文献库', !fs.existsSync(`${TEMP_PDF}.annotations.json`) && fs.existsSync(TEMP_STATE_DIR));

    const oldHistoryRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotations?pdf=${encodeURIComponent(migratedEntry.file)}`);
    const oldHistory = oldHistoryRes.ok ? await oldHistoryRes.json() : {};
    const migratedAddRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf: migratedEntry.file, annotations: [{ page: 1, rects: [{ x: 100, y: 540, width: 300, height: 12 }] }], label: '新高亮' }),
    });
    const migratedAdd = migratedAddRes.ok ? await migratedAddRes.json() : {};
    const migratedHistoryRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotations?pdf=${encodeURIComponent(migratedAdd.file ?? migratedEntry.file)}`);
    const migratedHistory = migratedHistoryRes.ok ? await migratedHistoryRes.json() : {};
    const privateHistoryCount = fs.readdirSync(TEMP_STATE_DIR).filter((name) => name.endsWith('.json')).length;
    check('旧编辑记录可读且首次写入后迁入私有目录', oldHistory.nodes?.[0]?.id === 'old-node' && migratedAddRes.ok && migratedHistory.nodes?.length === 2 && privateHistoryCount >= 2 && fs.existsSync(`${TEMP_MIGRATED_PDF}.annotations.json`));
    let migratedFile = migratedAdd.file ?? migratedEntry.file;
    let migratedDeleteOk = true;
    for (const node of migratedHistory.nodes ?? []) {
      const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotations/${encodeURIComponent(node.id)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pdf: migratedFile }),
      });
      const data = res.ok ? await res.json() : {};
      migratedDeleteOk &&= res.ok;
      migratedFile = data.file ?? migratedFile;
    }
    const migratedFinalRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotations?pdf=${encodeURIComponent(migratedEntry.file)}`);
    const migratedFinal = migratedFinalRes.ok ? await migratedFinalRes.json() : {};
    check('删空迁移记录后不会从旧备份复活', migratedDeleteOk && migratedFinal.nodes?.length === 0 && !fs.existsSync(TEMP_MIGRATED_ANNOTATED) && fs.existsSync(`${TEMP_MIGRATED_PDF}.annotations.json`));

    const repeatRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdf: ann.file,
        annotations: [{ page: 1, rects: [{ x: 100, y: 640, width: 300, height: 12 }] }],
        label: '高亮',
      }),
    });
    const repeated = await repeatRes.json();
    check('重复批注复用同一标注版', repeated.file === externalAnnotated, repeated.file);

    const historyRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotations?pdf=${encodeURIComponent(repeated.file)}`);
    const history = historyRes.ok ? await historyRes.json() : {};
    check('GET /api/annotations 返回可删节点', historyRes.ok && history.nodes?.length === 2 && history.nodes[0].label === 'AI 批注' && history.nodes[1].label === '高亮');

    const firstNodeId = history.nodes?.[0]?.id ?? 'missing';
    const deleteRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotations/${encodeURIComponent(firstNodeId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf: repeated.file }),
    });
    const deleted = deleteRes.ok ? await deleteRes.json() : {};
    check('DELETE /api/annotations 删除指定节点并保留其余标注', deleteRes.ok && deleted.file === externalAnnotated && deleted.nodes === 1 && deleted.annotations === 1);
    check('删除节点后 PDF 仅保留未删除的高亮', await pageAnnotationCount(path.join(TEMP_LIBRARY, 'sample-annotated.pdf')) === sampleBaseCount + 1);

    const legacyAddRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdf: legacyEntry.file,
        annotations: [{ page: 1, rects: [{ x: 100, y: 640, width: 300, height: 12 }] }],
        label: '新高亮',
      }),
    });
    const legacyAdd = await legacyAddRes.json();
    const legacyHistoryRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotations?pdf=${encodeURIComponent(legacyAdd.file ?? legacyEntry.file)}`);
    const legacyHistory = legacyHistoryRes.ok ? await legacyHistoryRes.json() : {};
    const legacyNodeId = legacyHistory.nodes?.[0]?.id ?? 'missing';
    const legacyDeleteRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotations/${encodeURIComponent(legacyNodeId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf: legacyAdd.file ?? legacyEntry.file }),
    });
    const legacyDeleted = legacyDeleteRes.ok ? await legacyDeleteRes.json() : {};
    check('旧标注基线在删除新节点后仍保留', legacyDeleteRes.ok && legacyDeleted.nodes === 0 && legacyDeleted.file.endsWith('::legacy-annotated.pdf') && await pageAnnotationCount(TEMP_LEGACY_ANNOTATED) === legacyBaselineCount);

    const orphanAddRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf: orphanEntry.file, annotations: [{ page: 1, rects: [{ x: 100, y: 620, width: 300, height: 12 }] }], label: '新高亮' }),
    });
    const orphanAdd = await orphanAddRes.json();
    const orphanHistoryRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotations?pdf=${encodeURIComponent(orphanAdd.file ?? orphanEntry.file)}`);
    const orphanHistory = orphanHistoryRes.ok ? await orphanHistoryRes.json() : {};
    const orphanDeleteRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotations/${encodeURIComponent(orphanHistory.nodes?.[0]?.id ?? 'missing')}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf: orphanAdd.file ?? orphanEntry.file }),
    });
    const orphanDeleted = orphanDeleteRes.ok ? await orphanDeleteRes.json() : {};
    check('无原稿的标注版删除节点后仍保留文件', orphanDeleteRes.ok && orphanDeleted.nodes === 0 && fs.existsSync(TEMP_ORPHAN_ANNOTATED) && await pageAnnotationCount(TEMP_ORPHAN_ANNOTATED) === legacyBaselineCount);

    const vanishedAddRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf: vanishedEntry.file, annotations: [{ page: 1, rects: [{ x: 100, y: 600, width: 300, height: 12 }] }], label: '高亮' }),
    });
    const vanishedAdd = vanishedAddRes.ok ? await vanishedAddRes.json() : {};
    const vanishedHistoryRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotations?pdf=${encodeURIComponent(vanishedAdd.file ?? vanishedEntry.file)}`);
    const vanishedHistory = vanishedHistoryRes.ok ? await vanishedHistoryRes.json() : {};
    fs.rmSync(TEMP_VANISHED_PDF, { force: true });
    const vanishedDeleteRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotations/${encodeURIComponent(vanishedHistory.nodes?.[0]?.id ?? 'missing')}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf: vanishedAdd.file ?? vanishedEntry.file }),
    });
    check('原稿消失时拒绝删除最后节点并保留标注版', vanishedDeleteRes.status === 409 && fs.existsSync(path.join(TEMP_LIBRARY, 'vanished-annotated.pdf')));

    const [raceA, raceB] = await Promise.all([
      fetch(`http://127.0.0.1:${APP_PORT}/api/annotate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdf: raceEntry.file, annotations: [{ page: 1, rects: [{ x: 100, y: 600, width: 300, height: 12 }] }], label: '并发 A' }),
      }),
      fetch(`http://127.0.0.1:${APP_PORT}/api/annotate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdf: raceEntry.file, annotations: [{ page: 1, rects: [{ x: 100, y: 580, width: 300, height: 12 }] }], label: '并发 B' }),
      }),
    ]);
    const raceResultA = await raceA.json();
    const raceResultB = await raceB.json();
    const raceHistoryRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/annotations?pdf=${encodeURIComponent(raceResultA.file ?? raceResultB.file ?? raceEntry.file)}`);
    const raceHistory = raceHistoryRes.ok ? await raceHistoryRes.json() : {};
    check('并发写入保留两个批注节点', raceA.ok && raceB.ok && raceHistory.nodes?.length === 2 && new Set(raceHistory.nodes.map((node) => node.label)).size === 2);

    const dl = await fetch(`http://127.0.0.1:${APP_PORT}/api/pdf?file=${encodeURIComponent(repeated.file)}&download=1`);
    check('GET /api/pdf 可下载外部库标注版', dl.status === 200 && (await dl.arrayBuffer()).byteLength > 1000);
  } finally {
    app?.kill();
    mock.close();
    if (hadConfig) fs.writeFileSync(CONFIG, backup);
    else fs.rmSync(CONFIG, { force: true });
    fs.rmSync(TEMP_LIBRARY, { recursive: true, force: true });
    fs.rmSync(TEMP_STATE_DIR, { recursive: true, force: true });
  }
}

await createFixturePdf();
check('自测使用独立临时 PDF', fs.existsSync(PDF));
const rects = await testLocate();
await testAnnotate(rects);
await testFolderPicker();
await testScrollPosition();
const text = await pageText(PDF, 1);
await testHttp(pickSentence(text));
console.log(failures ? `\n${failures} 项失败` : '\n全部通过 ✅');
process.exit(failures ? 1 : 0);
