// server.js
const express = require('express');
const axios = require('axios');
const iconv = require('iconv-lite');
const NodeCache = require('node-cache');
const he = require('he');
const rateLimit = require('express-rate-limit');

const app = express();

// ====== 基本設定 ======
const PORT = process.env.PORT || 3000;
const DEFAULT_BASE = process.env.BASE_BOARD_URL || ''; // 例: https://asahi.5ch.net/newsplus/
const cache = new NodeCache({ stdTTL: 120, checkperiod: 60 }); // 秒
const UA = 'Monazilla/1.00 JaneStyle/5.0.0';

// IPあたりのリクエスト制限（安全側）
const limiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
app.use(limiter);

// 軽いセキュリティヘッダ
app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ====== ユーティリティ ======
function joinUrl(base, path) {
  return `${base.replace(/\/+$/,'')}/${path.replace(/^\/+/, '')}`;
}
async function fetchCP932(url, referer = DEFAULT_BASE) {
  const hit = cache.get(url);
  if (hit) return hit;
  const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': UA, 'Accept': '*/*', ...(referer ? { Referer: referer } : {}) },
      timeout: 10000,
    validateStatus: s => s >= 200 && s < 500
    });
  if (res.status === 404) throw new Error('404_DAT_NOT_FOUND');
  if (res.status === 403) throw new Error('403_FORBIDDEN');
  const text = iconv.decode(Buffer.from(res.data), 'cp932');
  cache.set(url, text);
  return text;
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

// ====== 画面 ======
app.get('/', (_req, res) => {
  res.send(`<!doctype html><meta charset="utf-8"><title>Simple 5ch Viewer</title>
  <style>body{font-family:system-ui;-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial;line-height:1.6;padding:16px;max-width:940px;margin:auto}
  input,button{font-size:16px;padding:6px 10px}.muted{color:#666}</style>
  <h1>Simple 5ch Viewer</h1>
  <p class="muted">環境変数 <code>BASE_BOARD_URL</code> が ${DEFAULT_BASE ? '設定済み' : '未設定'}。</p>
  <form action="/board" method="get">
    <label>板URL：</label><br>
    <input name="url" placeholder="https://asahi.5ch.net/newsplus/" style="width:480px" value="${he.escape(DEFAULT_BASE)}">
    <button>スレ一覧を表示</button>
  </form>`);
});
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// 板のスレ一覧（subject.txt）
app.get('/board', async (req, res) => {
  try {
    const base = (req.query.url || DEFAULT_BASE || '').trim();
    if (!base) return res.status(400).send('板URLが未設定です（?url= または BASE_BOARD_URL を設定）');

    const subjectUrl = joinUrl(base, 'subject.txt');
    const subjectTxt = await fetchCP932(subjectUrl, base);
    const threads = parseSubjectTxt(subjectTxt);

    const list = threads.map(t => `
      <div class="thread">
        <a href="/thread?base=${encodeURIComponent(base)}&dat=${encodeURIComponent(t.dat)}">
          ${he.escape(t.title)}
        </a> ${t.resCount !== null ? `(${t.resCount})` : ''}
      </div>`).join('');

    res.send(`<!doctype html><meta charset="utf-8"><title>板一覧</title>
    <style>body{font-family:system-ui;padding:16px;max-width:940px;margin:auto}a{word-break:break-all}</style>
    <h2>スレ一覧</h2>${list || 'なし'}<p><a href="/">← 戻る</a></p>`);
  } catch (e) {
    res.status(500).send('取得に失敗しました: ' + he.escape(e.message));
  }
});

// スレ本文（dat）
app.get('/thread', async (req, res) => {
  try {
    let base = (req.query.base || DEFAULT_BASE || '').trim();
    let dat  = (req.query.dat  || '').trim();

    // フォールバック: /thread?url=https://.../dat/12345.dat でも読めるように
    if ((!base || !dat) && req.query.url) {
      try {
        const u = new URL(req.query.url);
        const [head, tail] = u.pathname.split('/dat/');
        base = `${u.protocol}//${u.host}${head}/`;
        dat  = (tail || '').replace('.dat','');
      } catch (_) {}
    }

    if (!base || !dat) return res.status(400).send('base/dat パラメータ不足');

    const datUrl = joinUrl(base, `dat/${dat}.dat`);
    const datTxt = await fetchCP932(datUrl, base);
    const posts = parseDat(datTxt);

    const html = posts.map(p => `
      <article>
        <div><b>${p.no}</b> 名前：${he.escape(p.name)} <span class="muted">[${he.escape(p.dateId)}]</span></div>
        <pre style="white-space:pre-wrap;word-break:break-word;margin:6px 0 18px 0">${p.body}</pre>
      </article>
    `).join('<hr>');

    res.send(`<!doctype html><meta charset="utf-8"><title>スレ本文</title>
    <style>body{font-family:system-ui;padding:16px;max-width:940px;margin:auto}.muted{color:#666}</style>
    <p><a href="/board?url=${encodeURIComponent(base)}">← スレ一覧へ戻る</a></p>
    ${html || 'レスがありません'}`);
  } catch (e) {
    if (String(e.message).includes('404_DAT_NOT_FOUND')) {
        return res.status(404).send('このスレは落ちている可能性があります（dat 404）。/board に戻って別スレでお試しください。');
    }
    if (String(e.message).includes('403_FORBIDDEN')) {
        return res.status(403).send('アクセスが拒否されました（403）。少し時間を置くか、UA/Refererを変更して再試行してください。');
    }
    es.status(500).send('取得に失敗しました: ' + he.escape(e.message));
  }
  }
});

app.listen(PORT, () => console.log('listening on :' + PORT));
