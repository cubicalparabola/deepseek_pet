// @ts-check
/**
 * 探针：聊天窗口的「文件」页签**真的能把文件显示出来**吗。
 *
 * 为什么单独写它：验收能断言桥面（列目录 / 读文本 / 读图片 / 拒绝目录外名字），
 * 但"点「查看」之后浮层里到底有没有东西"是**渲染层**的事，只能在真窗口里看：
 *   - 文件列表有没有画出那一行？
 *   - 文本类 → 浮层里出现 `<pre>`（而不是空框）？
 *   - 图片类 → 浮层里出现 `<img>`，且 `src` 是主进程给的 `data:` URL？
 *   - 「删除」之后列表里那一行有没有消失？
 *
 * 做法：往隔离数据目录的 `notes/files/` 里直接放一个 txt 与一个 1x1 png，
 * 然后真开聊天窗口，逐步点击并把每一步的 DOM 事实记下来；
 * 最后把主进程的 `dialog.showOpenDialog` 换成"永远选同一个文件"，
 * 真点一次「收纳文件…」，验证文件被**复制**进收纳夹并多出一条纸条。
 *
 * 用法：npx electron tools/probe-note-files.cjs
 * 输出：build/note-files.json
 *
 * ⚠️ 用独立的 userData / 数据目录，不会和正在运行的桌宠抢单实例锁，
 * 也不会碰到用户真实的纸条与文件。
 */
const { app, BrowserWindow, dialog } = require('electron');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'note-files.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-notefiles');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(join(dataDir, 'notes', 'files'), { recursive: true });

// 1x1 红点 PNG（134 字节）—— 够验证"图片真的被读出来并塞进 img"
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
writeFileSync(join(dataDir, 'notes', 'files', 'probe-文本.txt'), '第一行：这是收纳夹里的文本\n第二行', 'utf8');
writeFileSync(join(dataDir, 'notes', 'files', 'probe-image.png'), PNG_1X1);

/*
 * 「收纳文件…」要弹系统选择框，自动化里点不到 —— 本探针跑在**主进程**里，
 * 所以直接把 `dialog.showOpenDialog` 换成"永远选中这个文件"，
 * 这样点的是按钮 -> IPC -> `NoteService.record({file})` 的完整真实链路。
 */
const importSource = join(tmpdir(), 'desktop-pet-probe-import-source.txt');
writeFileSync(importSource, '这个文件应当被复制进收纳夹', 'utf8');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [importSource] });

const profileDir = join(tmpdir(), 'desktop-pet-probe-notefiles-profile');
try { rmSync(profileDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
app.setPath('userData', profileDir);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function finish(payload) {
  try {
    writeFileSync(outFile, JSON.stringify(payload, null, 1), 'utf8');
  } catch (error) {
    console.error('写入探针结果失败', error);
  }
  console.log(JSON.stringify(payload, null, 1));
  app.exit(payload.ok === true ? 0 : 1);
}

app.whenReady().then(async () => {
  try {
    await wait(6000);
    const petWin = BrowserWindow.getAllWindows()[0];
    if (!petWin) throw new Error('桌宠窗口不存在');
    const pet = (js) => petWin.webContents.executeJavaScript(js, true);

    await pet(`window.petAPI.ai.openChatWindow()`);
    await wait(2500);
    const chatWin = BrowserWindow.getAllWindows().find((w) => {
      try { return w.webContents.getURL().includes('/chat/'); } catch (error) { return false; }
    });
    if (!chatWin) throw new Error('聊天窗口没打开');

    const result = await chatWin.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const shown = (id) => {
        const el = document.getElementById(id);
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && el.getBoundingClientRect().height > 0;
      };
      const rows = () => Array.from(document.querySelectorAll('#files-list .file-row')).map((row) => ({
        name: row.querySelector('.file-name')?.textContent ?? '',
        meta: row.querySelector('.file-meta')?.textContent ?? '',
        buttons: Array.from(row.querySelectorAll('button')).map((b) => b.textContent),
      }));

      document.getElementById('tab-files').click();
      await wait(600);
      const listed = { files: shown('view-files'), count: rows().length, rows: rows() };

      // 文本：点第一行的「查看」
      const textRow = Array.from(document.querySelectorAll('#files-list .file-row'))
        .find((row) => (row.querySelector('.file-name')?.textContent ?? '').endsWith('.txt'));
      const textResult = { clicked: false };
      if (textRow) {
        textResult.clicked = true;
        const view = Array.from(textRow.querySelectorAll('button')).find((b) => b.textContent === '查看');
        if (view) view.click();
        await wait(600);
        const pre = document.getElementById('preview-body').querySelector('pre');
        textResult.previewShown = shown('preview');
        textResult.name = document.getElementById('preview-name').textContent;
        textResult.hasPre = pre !== null;
        textResult.preText = pre ? pre.textContent : '';
        textResult.noHtmlInjected = document.getElementById('preview-body').querySelectorAll('script').length === 0;
        document.getElementById('preview-close').click();
        await wait(300);
        textResult.closed = shown('preview') === false;
      }

      // 图片：点 png 那一行
      const imageRow = Array.from(document.querySelectorAll('#files-list .file-row'))
        .find((row) => (row.querySelector('.file-name')?.textContent ?? '').endsWith('.png'));
      const imageResult = { clicked: false };
      if (imageRow) {
        imageResult.clicked = true;
        const view = Array.from(imageRow.querySelectorAll('button')).find((b) => b.textContent === '查看');
        if (view) view.click();
        await wait(800);
        const img = document.getElementById('preview-body').querySelector('img');
        imageResult.previewShown = shown('preview');
        imageResult.hasImg = img !== null;
        imageResult.src = img ? img.getAttribute('src') : '';
        // 图片真的解码成功了吗（naturalWidth > 0 才是"看得见"）
        imageResult.decoded = img ? img.complete && img.naturalWidth > 0 : false;
        imageResult.decodedWidth = img ? img.naturalWidth : 0;
        const closeBtn = document.getElementById('preview-close');
        if (closeBtn) closeBtn.click();
        await wait(300);
        imageResult.closed = shown('preview') === false;
      }

      /*
       * 「删除」：真点一次。
       *
       * 删除前会弹 window.confirm（原生模态，探针里点不到），
       * 所以这里**先把 confirm 换成"永远同意"**，点的是删除逻辑本身。
       */
      const beforeDelete = rows().length;
      window.confirm = () => true;
      const deleteRow = Array.from(document.querySelectorAll('#files-list .file-row'))
        .find((row) => (row.querySelector('.file-name')?.textContent ?? '').endsWith('.txt'));
      if (deleteRow) {
        const del = Array.from(deleteRow.querySelectorAll('button')).find((b) => b.textContent === '删除');
        if (del) del.click();
      }
      await wait(900);
      const deleteResult = {
        before: beforeDelete,
        after: rows().length,
        names: rows().map((row) => row.name),
        summary: document.getElementById('files-summary').textContent,
      };

      /*
       * 「收纳文件…」：真点一次（主进程的 dialog 已被探针换成"永远选同一个文件"）。
       * 期望：收纳夹里多出这个文件，纸条页里也多出一条 kind=file 的纸条。
       */
      const beforeImport = rows().length;
      document.getElementById('file-import').click();
      await wait(1500);
      const importedRows = rows();
      const importResult = {
        before: beforeImport,
        after: importedRows.length,
        names: importedRows.map((row) => row.name),
        notes: (await window.chatAPI.notes()).notes.map((n) => ({ kind: n.kind, title: n.title, file: n.file ? n.file.name : null })),
      };

      return { listed, textResult, imageResult, deleteResult, importResult };
    })()`, true);

    const ok =
      result.listed.files === true &&
      result.listed.count === 2 &&
      result.listed.rows.every((row) => row.buttons.includes('查看') && row.buttons.includes('打开') && row.buttons.includes('删除')) &&
      result.textResult.clicked === true &&
      result.textResult.previewShown === true &&
      result.textResult.hasPre === true &&
      result.textResult.preText.includes('收纳夹里的文本') &&
      result.textResult.noHtmlInjected === true &&
      result.textResult.closed === true &&
      result.imageResult.clicked === true &&
      result.imageResult.previewShown === true &&
      result.imageResult.hasImg === true &&
      result.imageResult.src.startsWith('data:image/png;base64,') &&
      result.imageResult.decoded === true &&
      result.imageResult.closed === true &&
      result.deleteResult.before === 2 &&
      result.deleteResult.after === 1 &&
      result.deleteResult.names.some((name) => name.endsWith('.txt')) === false &&
      result.deleteResult.names.some((name) => name.endsWith('.png')) === true &&
      result.importResult.after === result.importResult.before + 1 &&
      result.importResult.names.includes('desktop-pet-probe-import-source.txt') &&
      result.importResult.notes.some((note) => note.kind === 'file' && note.file === 'desktop-pet-probe-import-source.txt');

    // 复制进来的是**副本**：源文件还在，且副本内容与源一致
    const copied = join(dataDir, 'notes', 'files', 'desktop-pet-probe-import-source.txt');
    const copyFacts = {
      sourceStillThere: existsSync(importSource),
      copyExists: existsSync(copied),
      copyMatches: existsSync(copied) ? readFileSync(copied, 'utf8') === readFileSync(importSource, 'utf8') : false,
    };
    const allOk = ok && copyFacts.sourceStillThere && copyFacts.copyExists && copyFacts.copyMatches;

    finish({ ok: allOk, dataDir, copyFacts, ...result });
  } catch (error) {
    finish({ ok: false, error: String((error && error.stack) || error) });
  }
});

setTimeout(() => {
  finish({ ok: false, error: 'PROBE_TIMEOUT' });
}, 90000);
