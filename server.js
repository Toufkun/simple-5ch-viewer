// server.js — Simple 5ch Viewer (Render用 完成版 / キャッシュバグ修正済)
// 必要ENV：PROXY_URL（例: https://xxxx.workers.dev/）
// 任意ENV：BASE_BOARD_URL（例: https://mi.5ch.net/news4vip/）

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
const DEFAULT_BASE = (process.env.BASE_BOARD_URL || '').trim(); // 例: https://mi.5ch.net/news4vip/
const PROXY_URL = (process.env.PROXY_URL || '').replace(/\/+$/, ''); // 例: https://xxxx.workers.dev
const cache = new NodeCache({ stdTTL: 120, checkperiod: 60 }); // 秒

/* ===== 軽い防御 ===== */
app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));
app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/* ===== ユーティリティ ===== */
const joinUrl = (base, path) =>
  `${base.replace(/\/+$/,'')}/${path.replace(/^\/+/, '')}`;

function buildReadCgiUrl(base, dat) {
  const u = new URL(base);
  const board = u.pathname.replace(/\/+$/,'').split('/').pop();
  return `${u.protocol}//${u.host}/test/read.cgi/${board}/${dat}/?guid=ON`;
}

// ★修正ポイント：status と data をセットでキャッシュ・返却
async function getVia(url, { binary=false, timeout=15000 } = {}) {
  const final = PROXY_URL ? `${PROXY_URL}?url=${encodeURIComponent(url)}` : url;
  const key = (binary ? 'bin:' : 'txt:') + final;
  const hit = cache.get(key);
  if (hit) return hit; // {status, data}

  const res = await axios.get(final, {
    responseType: binary ? 'arraybuffer' : 'text',
    timeout,
    validateStatus: s => s >= 200 && s < 600
  });

  const pack = { status: res.status, data: res.data };
  if (res.status === 200) cache.set(key, pack);
  return pack;
}

/* ===== 解析 ===== */
function parseSubjectTxt(s) {
  // 1行: "1234567890.dat<>タイトル (123)"
  return s.split('\n').filter(Boolean).map(line => {
    const [file, rest] = line.split('<>');
    if (!file || !rest) return null;
    const dat = file.replace('.dat', '');
    const m = rest.match(/^(.*)\s\((\d+)\)\s*$/);
    return { dat, title: m ? m[1] : rest, resCount: m ? Number(m[2]) : null };
  }).filter(Boolean);
}

function parseDat(text) {
  // 1行=1レス: "name<>mail<>dateID<>body<>title"
  return text.split('\n').filter(Boolean).map((line, i) => {
    const [name='', mail='', dateId='', bodyRaw=''] = line.split('<>');
    const body = he.escape(bodyRaw).replace(/<br\s*\/?>/gi, '\n').replace(/&gt;&gt;(\d+)/g, '>>$1');
    return { no: i + 1, name, dateId, body };
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
      items.push({
        no: i + 1,
        name,
        dateId,
        body: he.decode(
          bodyHtml
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/?[^>]+>/g, '')
        )
      });
    }
  });

  // 古い dl 構造の保険
  if (items.length === 0) {
    const dts = $('dt'); const dds = $('dd');
    for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
      const head = $(dts[i]).text().trim();
      const bodyHtml = $(dds[i]).html() || '';
      items.push({
        no: i + 1,
        name: head,
        dateId: '',
        body: he.decode(bodyHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[^>]+>/g, ''))
      });
    }
  }

  // 最終保険：大枠テキスト
  if (items.length === 0) {
    const bulk = $('#res, #thread, .thread, .thre, #main, #m, .content').first().text().trim();
    if (bulk) {
      return bulk.split(/\n{2,}/).map((t,i)=>({ no:i+1, name:'', dateId:'', body:t.trim() })).slice(0,200);
    }
  }
  return items;
}

/* ===== 画面 ===== */
app.get('/', (_req, res) => {
  res.send(`<!doctype html><meta charset="utf-8"><title>Simple 5ch Viewer</title>
  <style>
    body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial;line-height:1.6;padding:16px;max-width:940px;margin:auto}
    input,button{font-size:16px;padding:6px 10px}
    .muted{color:#666} a{word-break:break-all}
  </style>
  <h1>Simple 5ch Viewer</h1>
  <p class="muted">BASE_BOARD_URL: <code>${he.escape(DEFAULT_BASE || '(未設定)')}</code></p>
  <p class="muted">PROXY_URL: <code>${he.escape(PROXY_URL || '(未設定)')}</code></p>
  <form action="/board" method="get">
    <label>板URL：</label><br>
    <input name="url" placeholder="https://mi.5ch.net/news4vip/" style="width:480px" value="${he.escape(DEFAULT_BASE)}">
    <button>スレ一覧を表示</button>
  </form>`);
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
    <style>body{font-family:system-ui;padding:16px;max-width:940px;margin:auto}a{word-break:break-all}</style>
    <h2>スレ一覧</h2>${list || 'なし'}<p><a href="/">← 戻る</a></p>`);
  } catch (e) {
    res.status(500).send('取得に失敗しました: ' + he.escape(String(e.message || e)));
  }
});

/* ===== スレ本文：dat優先 → NGなら read.cgi ===== */
app.get('/thread', async (req, res) => {
  try {
    let base = (req.query.base || DEFAULT_BASE || '').trim();
    let dat  = (req.query.dat  || '').trim();

    // /thread?url=.../dat/xxxx.dat でもOK
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

    // 1) dat 直
    const datUrl = joinUrl(base, `dat/${dat}.dat`);
    const rDat = await getVia(datUrl, { binary: true });
    if (rDat.status === 200) {
      const datTxt = iconv.decode(Buffer.from(rDat.data), 'cp932');
      const posts = parseDat(datTxt);
      const html = posts.map(p => `
        <article>
          <div><b>${p.no}</b> 名前：${he.escape(p.name)} <span class="muted">[${he.escape(p.dateId)}]</span></div>
          <pre style="white-space:pre-wrap;word-break:break-word;margin:6px 0 18px 0">${p.body}</pre>
        </article>
      `).join('<hr>');

      return res.send(`<!doctype html><meta charset="utf-8"><title>スレ本文(dat)</title>
      <style>body{font-family:system-ui;padding:16px;max-width:940px;margin:auto}.muted{color:#666}</style>
      <p><a href="/board?url=${encodeURIComponent(base)}">← スレ一覧へ戻る</a></p>${html || 'レスがありません'}`);
    }

    // 2) read.cgi 経由
    const readUrl = buildReadCgiUrl(base, dat);
    const rHtml = await getVia(readUrl, { binary: false });
    if (rHtml.status !== 200) {
      return res.status(rHtml.status).send('取得に失敗しました: READCGI_' + rHtml.status);
    }

    const posts = parseReadCgiHtml(typeof rHtml.data === 'string' ? rHtml.data : rHtml.data.toString('utf8'));
    const body = posts.map(p => `
      <article>
        <div><b>${p.no}</b> ${he.escape(p.name || '')} <span class="muted">${he.escape(p.dateId || '')}</span></div>
        <pre style="white-space:pre-wrap;word-break:break-word;margin:6px 0 18px 0">${he.escape(p.body || '')}</pre>
      </article>
    `).join('<hr>');

    return res.send(`<!doctype html><meta charset="utf-8"><title>スレ本文(read.cgi)</title>
    <style>body{font-family:system-ui;padding:16px;max-width:940px;margin:auto}.muted{color:#666}</style>
    <p><a href="/board?url=${encodeURIComponent(base)}">← スレ一覧へ戻る</a></p>${body || 'レスがありません'}`);
  } catch (e) {
    res.status(500).send('取得に失敗しました: ' + he.escape(String(e.message || e)));
  }
});

/* ===== 診断（必ずプロキシ経由の状態を数値で確認） ===== */
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
      getVia(readUrl,    { binary:false}).then(x=>x.status).catch(()=>0),
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