// server.js  ── Simple 5ch Viewer (Render対応・同一ドメイン表示・403/IPv6対策 完成版)
const express = require('express');
const axios = require('axios');
const iconv = require('iconv-lite');
const NodeCache = require('node-cache');
const he = require('he');
const rateLimit = require('express-rate-limit');
const cheerio = require('cheerio');
const http = require('http');
const https = require('https');

const app = express();

/* ===== 基本設定 ===== */
const PORT = process.env.PORT || 3000;
const DEFAULT_BASE = (process.env.BASE_BOARD_URL || '').trim(); // 例: https://asahi.5ch.net/newsplus/
const cache = new NodeCache({ stdTTL: 120, checkperiod: 60 });   // 秒
// 専ブラ互換UA（弾かれにくい）
const UA = 'Monazilla/1.00 JaneStyle/4.0.0';

// RenderでIPv6経路が弾かれる対策としてIPv4固定
const httpAgent = new http.Agent({ keepAlive: false, family: 4 });
const httpsAgent = new https.Agent({ keepAlive: false, family: 4 });

/* ===== レート制限 & 軽いセキュリティ ===== */
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
  return `${u.protocol}//${u.host}/test/read.cgi/${board}/${dat}/`;
}

async function fetchCP932(url, referer = DEFAULT_BASE) {
  const hit = cache.get(url);
  if (hit) return hit;

  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
      'Accept-Language': 'ja-JP,ja;q=0.9',
      'Connection': 'close',
      // dat取得で重要
      'Range': 'bytes=0-',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Upgrade-Insecure-Requests': '1',
      'DNT': '1',
      ...(referer ? { Referer: referer } : {})
    },
    timeout: 10000,
    validateStatus: s => s >= 200 && s < 500, // 403/404も扱う
    httpAgent, httpsAgent,
  });

  if (res.status === 404) throw new Error('DAT_404');
  if (res.status === 403) throw new Error('DAT_403');

  const text = iconv.decode(Buffer.from(res.data), 'cp932'); // Shift_JIS/CP932
  cache.set(url, text);
  return text;
}

async function fetchUtf8(url, referer = DEFAULT_BASE) {
  const hit = cache.get(url);
  if (hit) return hit;

  const res = await axios.get(url, {
    responseType: 'text',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja-JP,ja;q=0.9',
      'Connection': 'close',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Upgrade-Insecure-Requests': '1',
      'DNT': '1',
      ...(referer ? { Referer: referer } : {})
    },
    timeout: 10000,
    validateStatus: s => s >= 200 && s < 500,
    httpAgent, httpsAgent,
  });

  if (res.status === 404) throw new Error('READCGI_404');
  if (res.status === 403) throw new Error('READCGI_403');

  const html = typeof res.data === 'string' ? res.data : res.data.toString('utf8');
  cache.set(url, html);
  return html;
}

function parseSubjectTxt(text) {
  // 1行: "1234567890.dat<>タイトル (123)"
  return text.split('\n').filter(Boolean).map(line => {
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
    const body = he.escape(bodyRaw)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/&gt;&gt;(\d+)/g, '>>$1');
    return { no: i + 1, name, mail, dateId, body };
  });
}

function parseReadCgiHtml(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const items = [];

  // 現行系のarticle/post
  $('article, .post, .postWrap').each((i, el) => {
    const name = ($(el).find('.name').text() || $(el).find('.name a').text() || '').trim();
    const dateId = ($(el).find('.date').text() || $(el).find('.info').text() || '').trim();
    const bodyHtml =
      $(el).find('.message, .post-message, .body, .messageText').html()
      || $(el).find('blockquote').html()
      || $(el).html();
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

  // 古い dt/dd 構造
  if (items.length === 0) {
    const dts = $('dt');
    const dds = $('dd');
    for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
      const head = $(dts[i]).text().trim();
      const bodyHtml = $(dds[i]).html() || '';
      items.push({
        no: i + 1,
        name: head,
        dateId: '',
        body: he.decode(
          bodyHtml
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/?[^>]+>/g, '')
        )
      });
    }
  }
  return items;
}

/* ===== 画面 ===== */
app.get('/', (_req, res) => {
  res.send(`<!doctype html><meta charset="utf-8"><title>Simple 5ch Viewer</title>
  <style>
    body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial;line-height:1.6;padding:16px;max-width:940px;margin:auto}
    input,button{font-size:16px;padding:6px 10px}.muted{color:#666} a{word-break:break-all}
  </style>
  <h1>Simple 5ch Viewer</h1>
  <p class="muted">環境変数 <code>BASE_BOARD_URL</code> は ${DEFAULT_BASE ? '設定済み' : '未設定'}。</p>
  <form action="/board" method="get">
    <label>板URL：</label><br>
    <input name="url" placeholder="https://asahi.5ch.net/newsplus/" style="width:480px" value="${he.escape(DEFAULT_BASE)}">
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
    const subjectTxt = await fetchCP932(subjectUrl, base);
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

/* ===== スレ本文（dat優先→失敗時read.cgiをサーバー側で解析） ===== */
app.get('/thread', async (req, res) => {
  try {
    let base = (req.query.base || DEFAULT_BASE || '').trim();
    let dat  = (req.query.dat  || '').trim();

    // /thread?url=https://.../dat/12345.dat でもOK
    if ((!base || !dat) && req.query.url) {
      try {
        const u = new URL(req.query.url);
        const [head, tail] = u.pathname.split('/dat/');
        base = base || `${u.protocol}//${u.host}${head}/`;
        dat  = dat  || (tail || '').replace('.dat','');
      } catch (_) {}
    }
    if (!base && DEFAULT_BASE && dat) base = DEFAULT_BASE;
    if (base && !base.endsWith('/')) base += '/';

    if (!base || !dat) return res.status(400).send('base/dat パラメータ不足');

    // 1) dat直取得
    try {
      const datUrl = joinUrl(base, `dat/${dat}.dat`);
      const datTxt = await fetchCP932(datUrl, base);
      const posts = parseDat(datTxt);

      const html = posts.map(p => `
        <article>
          <div><b>${p.no}</b> 名前：${he.escape(p.name)} <span class="muted">[${he.escape(p.dateId)}]</span></div>
          <pre style="white-space:pre-wrap;word-break:break-word;margin:6px 0 18px 0">${p.body}</pre>
        </article>
      `).join('<hr>');

      return res.send(`<!doctype html><meta charset="utf-8"><title>スレ本文(dat)</title>
      <style>body{font-family:system-ui;padding:16px;max-width:940px;margin:auto}.muted{color:#666}</style>
      <p><a href="/board?url=${encodeURIComponent(base)}">← スレ一覧へ戻る</a></p>
      ${html || 'レスがありません'}`);
    } catch (_errDat) {
      // 2) read.cgi をサーバー側で取得し、外部遷移なしで描画
      const readUrl = buildReadCgiUrl(base, dat);
      const html = await fetchUtf8(readUrl, base);
      const posts = parseReadCgiHtml(html);

      const body = posts.map(p => `
        <article>
          <div><b>${p.no}</b> ${he.escape(p.name || '')} <span class="muted">${he.escape(p.dateId || '')}</span></div>
          <pre style="white-space:pre-wrap;word-break:break-word;margin:6px 0 18px 0">${he.escape(p.body || '')}</pre>
        </article>
      `).join('<hr>');

      return res.send(`<!doctype html><meta charset="utf-8"><title>スレ本文(read.cgi)</title>
      <style>body{font-family:system-ui;padding:16px;max-width:940px;margin:auto}.muted{color:#666}</style>
      <p><a href="/board?url=${encodeURIComponent(base)}">← スレ一覧へ戻る</a></p>
      ${body || 'レスがありません'}`);
    }
  } catch (e) {
    res.status(500).send('取得に失敗しました: ' + he.escape(String(e.message || e)));
  }
});

/* ===== デバッグ: 実際に取りに行くdat URL確認 ===== */
app.get('/__debug_thread_url', (req, res) => {
  const base = (req.query.base || DEFAULT_BASE || '').trim();
  const dat  = (req.query.dat  || '').trim();
  if (!base || !dat) return res.status(400).send('base/dat 必須');
  res.type('text').send(joinUrl(base, `dat/${dat}.dat`));
});

/* ===== 診断: dat / read.cgi のHTTPステータス可視化 ===== */
app.get('/__diag', async (req, res) => {
  try {
    const base = (req.query.base || DEFAULT_BASE || '').trim();
    const dat  = (req.query.dat  || '').trim();
    if (!base || !dat) return res.status(400).json({ error: 'need base & dat' });

    const datUrl  = joinUrl(base, `dat/${dat}.dat`);
    const readUrl = buildReadCgiUrl(base, dat);

    const r1 = await axios.get(datUrl, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': UA, 'Range': 'bytes=0-', Referer: base },
      timeout: 8000, validateStatus: s => true, httpAgent, httpsAgent,
    }).then(r => ({ url: datUrl,  status: r.status, len: Number(r.headers['content-length']||0) }))
      .catch(e => ({ url: datUrl,  error: String(e.message) }));

    const r2 = await axios.get(readUrl, {
      responseType: 'text',
      headers: { 'User-Agent': UA, Referer: base },
      timeout: 8000, validateStatus: s => true, httpAgent, httpsAgent,
    }).then(r => ({ url: readUrl, status: r.status, len: Number(r.headers['content-length']||0) }))
      .catch(e => ({ url: readUrl, error: String(e.message) }));

    res.json({ dat: r1, readcgi: r2 });
  } catch (e) {
    res.status(500).json({ error: String(e.message||e) });
  }
});

app.listen(PORT, () => console.log('listening on :' + PORT));
