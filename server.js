// server.js — Simple 5ch Viewer（完成版：403回避 + 文字コード自動判定 + ダークモード + アンカーリンク）
// 必須ENV: PROXY_URL 例) https://xxxxxx.workers.dev/
// 任意ENV: BASE_BOARD_URL 例) https://mi.5ch.net/news4vip/

const express = require('express');
const axios = require('axios');
const iconv = require('iconv-lite');
const NodeCache = require('node-cache');
const he = require('he');
const rateLimit = require('express-rate-limit');
const cheerio = require('cheerio');

const app = express();

/* ===== 基本設定 ===== */
const PORT = process.env.PORT || 3000;
const DEFAULT_BASE = (process.env.BASE_BOARD_URL || '').trim();        // 例: https://mi.5ch.net/news4vip/
const PROXY_URL   = (process.env.PROXY_URL || '').replace(/\/+$/, ''); // 例: https://xxxx.workers.dev
const cache = new NodeCache({ stdTTL: 120, checkperiod: 60 });         // 秒

/* ===== 軽い防御 ===== */
app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));
app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/* ===== Dark theme（Charcoal）共通パーツ ===== */
const THEME_STYLE = `
<style>
  :root {
    --bg: #ffffff;
    --fg: #111111;
    --muted: #666666;
    --link: #0a58ff;
    --card: #f7f7f8;
    --border: #e5e7eb;
  }
  [data-theme="dark"] {
    --bg: #131315;
    --fg: #e5e7eb;
    --muted: #a1a1aa;
    --link: #83b7ff;
    --card: #1a1b1e;
    --border: #2a2b31;
  }
  html, body { background: var(--bg); color: var(--fg); }
  body{
    font-family: system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial;
    line-height: 1.6; padding: 16px; max-width: 940px; margin: auto;
  }
  a { color: var(--link); word-break: break-all; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .muted { color: var(--muted); }
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 12px 14px;
  }
  hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
  pre {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 8px; padding: 10px 12px;
    white-space: pre-wrap; word-break: break-word;
  }
  .theme-toggle {
    position: fixed; top: 12px; right: 12px; cursor: pointer;
    font-size: 18px; background: var(--card); color: var(--fg);
    border: 1px solid var(--border); border-radius: 999px;
    padding: 6px 10px; line-height: 1;
  }
  .anc { text-decoration: underline dotted; }
</style>
`;

const THEME_SCRIPT = `
<script>
(function(){
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (saved === "dark" || (!saved && prefersDark)) {
    document.documentElement.dataset.theme = "dark";
  }
  function setIcon(){
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    const dark = document.documentElement.dataset.theme === "dark";
    btn.textContent = dark ? "☀️" : "🌙";
    btn.setAttribute("aria-label", dark ? "ライトに切替" : "ダークに切替");
  }
  function toggle(){
    const cur = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = cur;
    localStorage.setItem("theme", cur);
    setIcon();
  }
  document.addEventListener('DOMContentLoaded', function(){
    const btn = document.createElement('button');
    btn.id = 'theme-toggle'; btn.className = 'theme-toggle'; btn.onclick = toggle;
    document.body.appendChild(btn);
    setIcon();
  });
})();
</script>
`;

/* ===== ユーティリティ ===== */
const joinUrl = (base, path) =>
  `${base.replace(/\/+$/,'')}/${path.replace(/^\/+/, '')}`;

function buildReadCgiUrl(base, dat) {
  const u = new URL(base);
  const board = u.pathname.replace(/\/+$/,'').split('/').pop();
  return `${u.protocol}//${u.host}/test/read.cgi/${board}/${dat}/?guid=ON`;
}

/* 文字コード判定＆デコード */
function sniffCharsetFromHeaders(headers = {}) {
  const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  const m = ct.match(/charset\s*=\s*([^;]+)/);
  return m ? m[1].trim() : '';
}
function sniffCharsetFromHtmlHead(buf) {
  const head = Buffer.from(buf).slice(0, 4096).toString('ascii');
  const m = head.match(/charset\s*=\s*["']?\s*([a-zA-Z0-9_\-]+)/i);
  return m ? m[1].toLowerCase() : '';
}
function normalizeCharset(cs) {
  cs = (cs || '').toLowerCase();
  if (/(shift[_\-]?jis|sjis|cp932)/.test(cs)) return 'cp932';
  if (/(euc[_\-]?jp)/.test(cs)) return 'euc-jp';
  if (/utf/.test(cs)) return 'utf-8';
  return '';
}
function decodeHtmlBinary(binary, headers) {
  const fromHdr  = normalizeCharset(sniffCharsetFromHeaders(headers));
  const fromMeta = normalizeCharset(sniffCharsetFromHtmlHead(binary));
  const cs = fromHdr || fromMeta || 'cp932';
  return iconv.decode(Buffer.from(binary), cs);
}

/* プロキシ経由GET（status/data/headers & キャッシュ） */
async function getVia(url, { binary=false, timeout=15000 } = {}) {
  const final = PROXY_URL ? `${PROXY_URL}?url=${encodeURIComponent(url)}` : url;
  const key = (binary ? 'bin:' : 'txt:') + final;
  const hit = cache.get(key);
  if (hit) return hit;

  const res = await axios.get(final, {
    responseType: binary ? 'arraybuffer' : 'text',
    timeout,
    validateStatus: s => s >= 200 && s < 600
  });

  const pack = { status: res.status, data: res.data, headers: res.headers || {} };
  if (res.status === 200) cache.set(key, pack);
  return pack;
}

/* ===== 解析 ===== */
function anchorizeEscapedText(txt) {
  // 既に he.escape 済みのテキストに対して >>n を内部リンクへ
  return txt.replace(/&gt;&gt;(\d+)/g, '<a class="anc" href="#r$1">&gt;&gt;$1</a>');
}

function parseSubjectTxt(s) {
  return s.split('\n').filter(Boolean).map(line => {
    const [file, rest] = line.split('<>');
    if (!file || !rest) return null;
    const dat = file.replace('.dat', '');
    const m = rest.match(/^(.*)\s\((\d+)\)\s*$/);
    return { dat, title: m ? m[1] : rest, resCount: m ? Number(m[2]) : null };
  }).filter(Boolean);
}

function parseDat(text) {
  const rows = text.split('\n').filter(Boolean);
  return rows.map((line, idx) => {
    const [name='', mail='', dateId='', bodyRaw=''] = line.split('<>');
    const escaped = he.escape(bodyRaw).replace(/<br\s*\/?>/gi, '\n');  // ← 正しい形
    const body = anchorizeEscapedText(escaped);
    return { no: idx + 1, name, dateId, body };
  });
}

function parseReadCgiHtml(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const items = [];

  $('article, .post, .postWrap, .postContainer, li.post, .res, .reply').each((i, el) => {
    const name = (
      $(el).find('.name').text() ||
      $(el).find('.name a').text() ||
      $(el).find('.username').text() ||
      $(el).find('.poster').text() ||
      ''
    ).trim();
    const dateId = (
      $(el).find('.date').text() ||
      $(el).find('.info').text() ||
      $(el).find('.meta').text() ||
      ''
    ).trim();
    const bodyHtml =
      $(el).find('.message, .post-message, .body, .messageText, .content, .message .text').html() ||
      $(el).find('blockquote').html() ||
      $(el).find('.mes, .msg, .resbody').html() ||
      $(el).html();

    if (bodyHtml) {
      // HTML → 素文 → エスケープ → >>n をアンカー化
      const plain = bodyHtml
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?[^>]+>/g, '');
      const body = anchorizeEscapedText(he.escape(plain));
      items.push({ no: i + 1, name, dateId, body });
    }
  });

  // 古い dl 構造の保険
  if (items.length === 0) {
    const dts = $('dt'); const dds = $('dd');
    for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
      const head = $(dts[i]).text().trim();
      const plain = ( $(dds[i]).html() || '' ).replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[^>]+>/g, '');
      const body = anchorizeEscapedText(he.escape(plain));
      items.push({ no: i + 1, name: head, dateId: '', body });
    }
  }

  if (items.length === 0) {
    const bulk = $('#res, #thread, .thread, .thre, #main, #m, .content').first().text().trim();
    if (bulk) {
      return bulk.split(/\n{2,}/).map((t,i)=>{
        return { no:i+1, name:'', dateId:'', body: anchorizeEscapedText(he.escape(t.trim())) };
      }).slice(0,200);
    }
  }
  return items;
}

/* ===== 画面 ===== */
app.get('/', (_req, res) => {
  res.send(`<!doctype html><meta charset="utf-8"><title>Simple 5ch Viewer</title>
  ${THEME_STYLE}
  <h1>Simple 5ch Viewer</h1>
  <p class="muted">BASE_BOARD_URL: <code>${he.escape(DEFAULT_BASE || '(未設定)')}</code></p>
  <p class="muted">PROXY_URL: <code>${he.escape(PROXY_URL || '(未設定)')}</code></p>
  <form action="/board" method="get" class="card">
    <label>板URL：</label><br>
    <input name="url" placeholder="https://mi.5ch.net/news4vip/" style="width:480px;font-size:16px;padding:6px 10px">
    <button style="font-size:16px;padding:6px 10px;margin-left:6px">スレ一覧を表示</button>
  </form>
  ${THEME_SCRIPT}
  `);
});

app.get('/healthz', (_req, res) => res.type('text').send('ok'));

/* ===== スレ一覧（subject.txt） ===== */
app.get('/board', async (req, res) => {
  try {
    const base = (req.query.url || DEFAULT_BASE || '').trim();
    if (!base) return res.status(400).send('板URLが未設定です（?url= または BASE_BOARD_URL を設定）');

    const subjectUrl = joinUrl(base, 'subject.txt');
    const r = await getVia(subjectUrl, { binary: true }); // CP932
    if (r.status !== 200) return res.status(r.status).send('取得に失敗しました: SUBJECT_' + r.status);

    const subjectTxt = iconv.decode(Buffer.from(r.data), 'cp932');
    const threads = parseSubjectTxt(subjectTxt);

    const list = threads.map(t => {
      const href = `/thread?base=${encodeURIComponent(base)}&dat=${encodeURIComponent(t.dat)}`;
      return `<div class="thread"><a href="${href}">${he.escape(t.title)}</a>${t.resCount !== null ? ` (${t.resCount})` : ''}</div>`;
    }).join('');

    res.send(`<!doctype html><meta charset="utf-8"><title>板一覧</title>
${THEME_STYLE}
<h2>スレ一覧</h2>
<div class="card">
  ${list || 'なし'}
</div>
<p style="margin-top:12px"><a href="/">← 戻る</a></p>
${THEME_SCRIPT}
`);
  } catch (e) {
    res.status(500).send('取得に失敗しました: ' + he.escape(String(e.message || e)));
  }
});

/* ===== スレ本文：dat優先 → NGなら read.cgi ===== */
app.get('/thread', async (req, res) => {
  try {
    let base = (req.query.base || DEFAULT_BASE || '').trim();
    let dat  = (req.query.dat  || '').trim();

    // /thread?url=.../dat/xxxx.dat でもOKにする
    if ((!base || !dat) && req.query.url) {
      try {
        const u = new URL(req.query.url);
        const [head, tail] = u.pathname.split('/dat/');
        base = base || `${u.protocol}//${u.host}${head}/`;
        dat  = dat  || (tail || '').replace('.dat','');
      } catch {}
    }
    if (base && !base.endsWith('/')) base += '/';
    if (!base || !dat) return res.status(400).send('base/dat パラメータ不足');

    // 1) dat直取得
    const datUrl = joinUrl(base, `dat/${dat}.dat`);
    const rDat = await getVia(datUrl, { binary: true });
    if (rDat.status === 200) {
      const datTxt = iconv.decode(Buffer.from(rDat.data), 'cp932');
      const posts = parseDat(datTxt);
      const html = posts.map(p => `
        <article id="r${p.no}" class="card">
          <div><b>${p.no}</b> 名前：${he.escape(p.name)} <span class="muted">[${he.escape(p.dateId)}]</span></div>
          <pre>${p.body}</pre>
        </article>
      `).join('<hr>');

      return res.send(`<!doctype html><meta charset="utf-8"><title>スレ本文(dat)</title>
${THEME_STYLE}
<p><a href="/board?url=${encodeURIComponent(base)}">← スレ一覧へ戻る</a></p>
${html || 'レスがありません'}
${THEME_SCRIPT}
`);
    }

    // 2) read.cgi（バイナリ→charset判定decode）
    const readUrl = buildReadCgiUrl(base, dat);
    const rHtml = await getVia(readUrl, { binary: true });
    if (rHtml.status !== 200) {
      return res.status(rHtml.status).send('取得に失敗しました: READCGI_' + rHtml.status);
    }
    const htmlText = decodeHtmlBinary(rHtml.data, rHtml.headers);
    const posts = parseReadCgiHtml(htmlText);

    const body = posts.map(p => `
      <article id="r${p.no}" class="card">
        <div><b>${p.no}</b> ${he.escape(p.name || '')} <span class="muted">${he.escape(p.dateId || '')}</span></div>
        <pre>${p.body || ''}</pre>
      </article>
    `).join('<hr>');

    return res.send(`<!doctype html><meta charset="utf-8"><title>スレ本文(read.cgi)</title>
${THEME_STYLE}
<p><a href="/board?url=${encodeURIComponent(base)}">← スレ一覧へ戻る</a></p>
${body || 'レスがありません'}
${THEME_SCRIPT}
`);
  } catch (e) {
    res.status(500).send('取得に失敗しました: ' + he.escape(String(e.message || e)));
  }
});

/* ===== 診断 ===== */
app.get('/__diag', async (req, res) => {
  try {
    const base = (req.query.base || DEFAULT_BASE || '').trim();
    const dat  = (req.query.dat  || '').trim();
    if (!base || !dat) return res.status(400).json({ error: 'need base & dat' });

    const subjectUrl = joinUrl(base, 'subject.txt');
    const datUrl  = joinUrl(base, `dat/${dat}.dat`);
    const readUrl = buildReadCgiUrl(base, dat);

    const [s, d, r] = await Promise.all([
      getVia(subjectUrl, { binary:true }).then(x=>x.status).catch(()=>0),
      getVia(datUrl,     { binary:true }).then(x=>x.status).catch(()=>0),
      getVia(readUrl,    { binary:true }).then(x=>x.status).catch(()=>0),
    ]);

    res.json({
      proxy_url: PROXY_URL || null,
      subject_status: s,
      dat_status: d,
      readcgi_status: r
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log('listening on :' + PORT));
