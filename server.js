// --- Simple 5ch Viewer 完成版 ---
// dat直取得 → 403なら read.cgi fallback
// ダークモード + 本文だけボックス表示

const express = require("express");
const axios = require("axios");
const iconv = require("iconv-lite");
const NodeCache = require("node-cache");
const he = require("he");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 90 });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 5ch Viewer";

function j(base, path) {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

function decodeCP932(buf) {
  return iconv.decode(Buffer.from(buf), "cp932");
}

async function fetchCP932(url, referer) {
  const hit = cache.get(url);
  if (hit) return hit;
  const r = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { "User-Agent": UA, Referer: referer || url },
    timeout: 10000
  });
  const text = decodeCP932(r.data);
  cache.set(url, text);
  return text;
}

function parseSubject(text) {
  return text.split("\n").filter(Boolean).map(line => {
    const [file, rest] = line.split("<>");
    if (!file || !rest) return null;
    const dat = file.replace(".dat", "");
    const m = rest.match(/^(.*)\s\((\d+)\)$/);
    return { dat, title: m ? m[1] : rest, resCount: m ? m[2] : "" };
  }).filter(Boolean);
}

function parseDat(text) {
  return text.split("\n").filter(Boolean).map((line, i) => {
    const [name="", mail="", dateId="", bodyRaw=""] = line.split("<>");
    const body = he.escape(bodyRaw)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/&gt;&gt;(\d+)/g, '<a class="anc" href="#r$1">&gt;&gt;$1</a>');
    return { no: i+1, name, dateId, body };
  });
}

const THEME = `
<style>
body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;margin:auto;max-width:880px;padding:16px;}
a{color:#3af;word-break:break-all} .muted{color:#888}
:root { --bg:white; --fg:#111; --card:#f6f6f6; --border:#ccc; }
@media(prefers-color-scheme:dark){
  :root { --bg:#111; --fg:#eee; --card:#1a1a1a; --border:#444; }
}
body{background:var(--bg);color:var(--fg);}
.thread a{display:block;padding:6px 0;border-bottom:1px solid var(--border);}
.post{margin:18px 0;}
.post .meta{font-size:14px;margin-bottom:6px;}
.post .bodybox{
  background:var(--card);
  border:1px solid var(--border);
  border-radius:10px;
  padding:12px;
}
.post pre{margin:0;white-space:pre-wrap;word-break:break-word;}
.anc{text-decoration:underline dotted;}
</style>
`;

app.use(rateLimit({ windowMs: 60000, max: 40 }));

app.get("/", (_, res) => res.send(`
${THEME}
<h1>Simple 5ch Viewer</h1>
<form action="/board" method="get">
<input name="url" style="width:480px" placeholder="https://mi.5ch.net/news4vip/">
<button>スレ一覧</button>
</form>
`));

// --- スレ一覧 ---
app.get("/board", async (req, res) => {
  try {
    const base = (req.query.url || "").trim();
    if (!base) return res.send("板URLが必要です。");
    const txt = await fetchCP932(j(base,"subject.txt"), base);
    const list = parseSubject(txt).map(t => `
      <div class="thread">
        <a href="/thread?base=${encodeURIComponent(base)}&dat=${t.dat}">
          ${he.escape(t.title)} (${t.resCount})
        </a>
      </div>`).join("");
    res.send(`${THEME}<h2>スレ一覧</h2>${list}<p><a href="/">戻る</a></p>`);
  } catch(e){ res.send("失敗: "+e.message); }
});

// --- スレ本文 ---
app.get("/thread", async (req, res) => {
  try {
    const base = req.query.base;
    const dat = req.query.dat;
    if (!base || !dat) return res.send("引数不足");

    // 1) dat直取得
    try {
      const txt = await fetchCP932(j(base,`dat/${dat}.dat`), base);
      return sendPosts(res, parseDat(txt), base);
    } catch(e){}

    // 2) read.cgi fallback
    const r = await axios.get(
      `https://itest.5ch.net/read.cgi/${base.split("/").filter(Boolean).pop()}/${dat}/`,
      { headers:{ "User-Agent":UA }, timeout:10000 }
    );
    const body = r.data;
    const posts = [...body.matchAll(/<article[\s\S]*?<\/article>/g)].map((m,i)=>({
      no: i+1,
      name: (m[0].match(/<b>(.*?)<\/b>/)?.[1]||""),
      dateId: (m[0].match(/\[(.*?)\]/)?.[1]||""),
      body: he.escape(m[0].replace(/<[^>]*>/g,""))
    }));
    return sendPosts(res, posts, base);

  } catch(e){ res.send("失敗: "+e.message); }
});

function sendPosts(res, posts, base){
  const html = posts.map(p=>`
  <article id="r${p.no}" class="post">
    <div class="meta"><b>${p.no}</b> ${he.escape(p.name)} <span class="muted">[${he.escape(p.dateId)}]</span></div>
    <div class="bodybox"><pre>${p.body}</pre></div>
  </article>`).join("");
  res.send(`${THEME}<p><a href="/board?url=${encodeURIComponent(base)}">← スレ一覧</a></p>${html}`);
}

app.listen(PORT, () => console.log("OK :"+PORT));
