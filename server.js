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
const DEFAULT_BASE = (process.env.BASE_BOARD_URL || '').trim(); // 例: https://asahi.5ch.net/newsplus/
const cache = new NodeCache({ stdTTL: 120, checkperiod: 60 });   // 秒
// 5chのdat取得で弾かれにくいUA
const UA = 'Monazilla/1.00 JaneStyle/5.0.0';

// ---- レート制限 & 軽いセキュリティ ----
app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));
app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ====== ユーティリティ ======
const joinUrl = (base, path) =>
  `${base.replace(/\/+$/,'')}/${path.replace(/^\/+/, '')}`;

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
      ...(referer ? { Referer: referer } : {})
    },
    timeout: 10000,
    // 403/404 も捕捉して自前で扱う
    validateStatus: s => s >= 200 && s < 500
  });

  if (res.status === 404) throw new Error('DAT_404'); // 落ちスレ等
  if (res.status === 403) throw new Error('DAT_403'); // アクセス拒否

  const text = iconv.decode(Buffer.from(res.data), 'cp932'); // Shift_JIS/CP932
  cache.set(url, text);
  return text;
}

function parseSubjectTxt(text) {
  // 1行: "1234567890.dat<>タイトル (123)"
  return text.split('\n').filter(Boolean).map(line => {
    const [file, rest] = line.split('<>');
    if (!file || !rest) return null;
    const dat = file.replace('.dat', '');
    const m = rest.match(/^(.*)\s(\d+)\s*$/);
    return { dat, title: m ? m[1] : rest, resCount: m ? Number(m[2]) : null };
  }).filter(Boolean);
}

function parseDat
