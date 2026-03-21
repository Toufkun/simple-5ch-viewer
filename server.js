// server.js — Simple 5ch Viewer（長い完全版）
// 収録機能：
// - Cloudflare Worker 経由 (PROXY_URL) で403回避
// - subject.txt → スレ一覧、dat → 本文、NGなら read.cgi に自動フォールバック
// - 文字コード自動判定（UTF-8/CP932/EUC-JP）/ datはCP932
// - ダークモード（チャコール）とトグル記憶
// - レスは「本文だけ角丸ボックス」＋軽い影、メタは外側に表示
// - >>アンカー内部リンク化
// - 板メニュー：/menus（カテゴリタイル） /menus/c（カテゴリ内） /boards（検索UI）
// - 診断API：/__diag

const express = require('express');
const axios = require('axios');
const iconv = require('iconv-lite');
const NodeCache = require('node-cache');
const he = require('he');
const rateLimit = require('express-rate-limit');
const cheerio = require('cheerio');

const app = express();

/* ===== 基本設定 ===== */
const PORT         = process.env.PORT || 3000;
const DEFAULT_BASE = (process.env.BASE_BOARD_URL || '').trim();           // 例: https://mi.5ch.io/news4vip/
const PROXY_URL    = (process.env.PROXY_URL || '').replace(/\/+$/, '');   // 例: https://xxxx.workers.dev
const BBSMENU_ENV  = (process.env.BBSMENU_URL || '').trim();
const cache = new NodeCache({ stdTTL: 120, checkperiod: 60 });

/* ===== 軽い防御 ===== */
app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));
app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/* ===== ダークテーマ（チャコール）＋ 角丸ボックス（本文だけ） ===== */
const THEME_STYLE = `
<style>
  :root { --bg:#ffffff; --fg:#111111; --muted:#666666; --link:#0a58ff; --card:#f7f7f8; --border:#e5e7eb; }
  [data-theme="dark"] { --bg:#131315; --fg:#e5e7eb; --muted:#a1a1aa; --link:#83b7ff; --card:#1a1b1e; --border:#2a2b31; }

  html, body { background: var(--bg); color: var(--fg); }
  body{
    font-family: system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial;
    line-height: 1.6; padding: 16px; max-width: 940px; margin: auto;
  }
  a { color: var(--link); text-decoration: none; word-break: break-all; }
  a:hover { text-decoration: underline; }
  .muted { color: var(--muted); }
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 12px 14px;
  }
  hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }

  /* ===== レス（本文だけボックス） ===== */
  .post{ margin:18px 0; }
  .post .meta{ font-size:14px; margin:0 0 8px 2px; }
  .post .bodybox{
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;           /* ← 角丸しっかり */
    padding: 14px 16px;            /* ← 余白広め */
    box-shadow: 0 2px 10px rgba(0,0,0,.06);  /* ← ほんのり影 */
  }
  .post pre{
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    border-radius: inherit;        /* ← 角丸継承 */
    overflow-wrap: anywhere;       /* ← 長いURLなどで角丸を壊さない */
  }
  .anc { text-decoration: underline dotted; }

  /* /menus タイル用 */
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
  @media (max-width:560px){ .grid{grid-template-columns:1fr} }
  .tile{
    display:flex;align-items:center;gap:10px;
    background:var(--card);border:1px solid var(--border);border-radius:12px;
    padding:14px 16px;text-decoration:none;color:var(--fg)
  }
  .tile:hover{filter:brightness(1.06)}
  .icon{font-size:18px}
  .label{flex:1}
  .count{color:var(--muted)}
  .crumb{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:8px 10px;margin-bottom:10px}

  .theme-toggle {
    position: fixed; top: 12px; right: 12px; cursor: pointer;
    font-size: 18px; background: var(--card); color: var(--fg);
    border: 1px solid var(--border); border-radius: 999px;
    padding: 6px 10px; line-height: 1;
  }
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
  // モバイル互換で弾かれづらい read.cgi 形式
  return `${u.protocol}//${u.host}/test/read.cgi/${board}/${dat}/?guid=ON`;
}

function anchorizeEscapedText(txt) {
  // 既に he.escape 済みのテキストに対して >>n を内部リンクへ
  return txt.replace(/&gt;&gt;(\d+)/g, '<a class="anc" href="#r$1">&gt;&gt;$1</a>');
}

/* ---- 文字コード判定＆デコード（read.cgi） ---- */
function sniffCharsetFromHeaders(headers = {}) {
  const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  const m = ct.match(/charset\s*=\s*([^;]+)/);
  return m ? m[1].trim() : '';
}
function sniffCharsetFromHtmlHead(buf) {
  const head = Buffer.from(buf).slice(0, 4096).toString('ascii'); // 先頭だけ暫定ASCII読み
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
  const cs = fromHdr || fromMeta || 'cp932'; // 5chはSJIS系既定
  return iconv.decode(Buffer.from(binary), cs);
}

/* ---- プロキシ経由GET（status/data/headersを返す & キャッシュ）---- */
async function getVia(url, { binary=false, timeout=15000 } = {}) {
  const final = PROXY_URL ? `${PROXY_URL}?url=${encodeURIComponent(url)}` : url;
  const key = (binary ? 'bin:' : 'txt:') + final;
  const hit = cache.get(key);
  if (hit) return hit; // { status, data, headers }

  const res = await axios.get(final, {
    responseType: binary ? 'arraybuffer' : 'text',
    timeout,
    validateStatus: s => s >= 200 && s < 600
  });

  const pack = { status: res.status, data: res.data, headers: res.headers || {} };
  if (res.status === 200) cache.set(key, pack);
  return pack;
}

/* ===== subject.txt / dat 解析 ===== */
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
    const escaped = he.escape(bodyRaw).replace(/<br\s*\/?>/gi, '\n');  // <br>→改行
    const body = anchorizeEscapedText(escaped);
    return { no: idx + 1, name, dateId, body };
  });
}

/* ===== read.cgi HTML の緩いパーサ ===== */
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
      return bulk.split(/\n{2,}/).map((t,i)=>({
        no:i+1, name:'', dateId:'', body: anchorizeEscapedText(he.escape(t.trim()))
      })).slice(0,200);
    }
  }
  return items;
}

/* ===== BBSMENU（カテゴリ → 板） ===== */
const BBSMENU_CANDIDATES = [
  BBSMENU_ENV || null,
  'https://menu.5ch.net/bbsmenu.html',
  'https://menu.5ch.net/bbsmenu.html.gz',
];
async function fetchBbsMenuText() {
  for (const u of BBSMENU_CANDIDATES) {
    if (!u) continue;
    try {
      const r = await getVia(u, { binary:true, timeout:15000 });
      if (r.status === 200) return iconv.decode(Buffer.from(r.data), 'cp932');
    } catch(_) {}
  }
  throw new Error('BBSMENUが取得できませんでした');
}
function parseBbsMenu(html) {
  const $ = cheerio.load(html, { decodeEntities:false });
  const out=[]; let current={ category:'その他', boards:[] };
  $('body,html').find('b, a').each((_, el)=>{
    const tag = el.tagName?.toLowerCase?.() || el.name?.toLowerCase?.();
    if (tag === 'b') {
      if (current.boards.length) out.push(current);
      current = { category: $(el).text().trim() || 'カテゴリ', boards:[] };
    } else if (tag === 'a') {
      const href = ($(el).attr('href')||'').trim();
      const name = ($(el).text()||'').trim();
      if (/^https?:\/\/.+\/[^/]+\/?$/.test(href) && name) {
        current.boards.push({ name, url: href.endsWith('/')?href:href+'/' });
      }
    }
  });
  if (current.boards.length) out.push(current);
  return out;
}

/* ===== 画面 ===== */
app.get('/', (_req, res) => {
  res.send(`<!doctype html><meta charset="utf-8"><title>Simple 5ch Viewer</title>
${THEME_STYLE}
<h1>Simple 5ch Viewer</h1>
<p class="muted">BASE_BOARD_URL: <code>${he.escape(DEFAULT_BASE || '(未設定)')}</code></p>
<p class="muted">PROXY_URL: <code>${he.escape(PROXY_URL || '(未設定)')}</code></p>
<p><a href="/menus">板一覧（カテゴリ）</a> ／ <a href="/boards">板一覧（検索）</a></p>
<form action="/board" method="get" class="card" style="margin-top:10px">
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

    const list = threads.map(t => `
      <div class="thread">
        <a href="/thread?base=${encodeURIComponent(base)}&dat=${encodeURIComponent(t.dat)}">
          ${he.escape(t.title)}
        </a>${t.resCount !== null ? ` (${t.resCount})` : ''}
      </div>
    `).join('');

    res.send(`<!doctype html><meta charset="utf-8"><title>スレ一覧</title>
${THEME_STYLE}
<h2>スレ一覧</h2>
<div class="card">${list || 'なし'}</div>
<p style="margin-top:12px"><a href="/">← トップに戻る</a></p>
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
        <article id="r${p.no}" class="post">
          <div class="meta">
            <b>${p.no}</b> 名前：${he.escape(p.name)}
            <span class="muted">[${he.escape(p.dateId)}]</span>
          </div>
          <div class="bodybox">
            <pre>${p.body}</pre>
          </div>
        </article>
      `).join('');

      return res.send(`<!doctype html><meta charset="utf-8"><title>本文(dat)</title>
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
      <article id="r${p.no}" class="post">
        <div class="meta">
          <b>${p.no}</b> ${he.escape(p.name || '')}
          <span class="muted">${he.escape(p.dateId || '')}</span>
        </div>
        <div class="bodybox">
          <pre>${p.body || ''}</pre>
        </div>
      </article>
    `).join('');

    return res.send(`<!doctype html><meta charset="utf-8"><title>本文(read.cgi)</title>
${THEME_STYLE}
<p><a href="/board?url=${encodeURIComponent(base)}">← スレ一覧へ戻る</a></p>
${body || 'レスがありません'}
${THEME_SCRIPT}
`);
  } catch (e) {
    res.status(500).send('取得に失敗しました: ' + he.escape(String(e.message || e)));
  }
});

/* ===== 板一覧（検索UI） ===== */
app.get('/boards', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const txt = await fetchBbsMenuText();
    const groups = parseBbsMenu(txt);
    const filtered = groups.map(g => ({
      category: g.category,
      boards: g.boards.filter(b => !q || b.name.toLowerCase().includes(q) || g.category.toLowerCase().includes(q))
    })).filter(g => g.boards.length);

    const html = filtered.map(g => `
      <section class="card" style="margin:12px 0">
        <h3 style="margin:0 0 8px 0">${he.escape(g.category)}</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px">
          ${g.boards.map(b => `
            <div>
              <a href="/board?url=${encodeURIComponent(b.url)}">${he.escape(b.name)}</a>
              <span class="muted" style="font-size:12px;display:block">${he.escape(b.url)}</span>
            </div>
          `).join('')}
        </div>
      </section>
    `).join('');

    res.send(`<!doctype html><meta charset="utf-8"><title>板一覧</title>
${THEME_STYLE}
<h1>板一覧</h1>
<form method="get" class="card" style="margin-bottom:12px">
  <input name="q" placeholder="キーワード" value="${he.escape(q)}"
         style="width:360px;font-size:16px;padding:6px 10px">
  <button style="font-size:16px;padding:6px 10px;margin-left:6px">検索</button>
  <a href="/boards" class="muted" style="margin-left:10px">クリア</a>
</form>
${html || '<p class="muted">該当する板がありません</p>'}
<p style="margin-top:16px"><a href="/">← トップ</a></p>
${THEME_SCRIPT}
`);
  } catch (e) {
    res.status(500).send('板一覧の取得に失敗しました: ' + he.escape(String(e.message || e)));
  }
});

/* ===== カテゴリタイル版メニュー ===== */
app.get('/menus', async (_req, res) => {
  try {
    const html = await fetchBbsMenuText();
    const groups = parseBbsMenu(html);
    const tiles = groups.map(g => {
      const href = `/menus/c?cat=${encodeURIComponent(g.category)}`;
      const count = g.boards.length;
      return `<a class="tile" href="${href}">
        <span class="icon" aria-hidden="true">📁</span>
        <span class="label">${he.escape(g.category)}</span>
        <span class="count">(${count})</span>
      </a>`;
    }).join('');

    res.send(`<!doctype html><meta charset="utf-8"><title>板一覧 ＞ 5ch.net</title>
${THEME_STYLE}
<div class="crumb">板一覧 &gt; 5ch.net</div>
<div class="grid">${tiles}</div>
<p style="margin-top:14px"><a href="/">← トップ</a></p>
${THEME_SCRIPT}
`);
  } catch (e) {
    res.status(500).send('メニュー取得に失敗しました: ' + he.escape(String(e.message||e)));
  }
});

/* ===== カテゴリ内の板一覧 ===== */
app.get('/menus/c', async (req, res) => {
  try {
    const cat = (req.query.cat || '').toString().trim();
    if (!cat) return res.status(400).send('cat が未指定です');

    const html = await fetchBbsMenuText();
    const groups = parseBbsMenu(html);
    const hit = groups.find(g => g.category === cat);
    if (!hit) return res.status(404).send('カテゴリが見つかりません');

    const list = hit.boards.map(b => `
      <div class="row" style="padding:8px 6px;border-bottom:1px solid var(--border)">
        <a href="/board?url=${encodeURIComponent(b.url)}">${he.escape(b.name)}</a>
        <span class="muted" style="font-size:12px;display:block">${he.escape(b.url)}</span>
      </div>`).join('');

    res.send(`<!doctype html><meta charset="utf-8"><title>${he.escape(cat)} ＞ 5ch.net</title>
${THEME_STYLE}
<div class="crumb"><a href="/menus">板一覧</a> &gt; ${he.escape(cat)}</div>
<div class="card">
  ${list || '<p class="muted">板がありません</p>'}
</div>
<p style="margin-top:14px"><a href="/menus">← カテゴリに戻る</a></p>
${THEME_SCRIPT}
`);
  } catch (e) {
    res.status(500).send('カテゴリ表示に失敗しました: ' + he.escape(String(e.message||e)));
  }
});

/* ===== 診断API ===== */
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
