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
const DEFAULT_BASE = process.env.BASE_BOARD_URL || ''; // 例: https://example.test/board
const cache = new NodeCache({ stdTTL: 120, checkperiod: 60 }); // 秒
const UA = 'Simple5chViewer/1.0 (+contact:you@example.com)';

// IPあたりのリクエスト制限（安全側）
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1分
  max: 30,             // 分あたり30リク
});
app.use(limiter);

// 軽い
