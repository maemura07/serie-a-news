/**
 * セリエAニュース自動収集・要約スクリプト v3
 *
 * 流れ:
 *  1. sources.json のフィード（globalSources ＋ clubSources）を巡回
 *  2. 信頼できる媒体（trustedPublishers）以外を除外、URL・見出しで一次重複排除
 *  3. 記事本文の冒頭を取得（直接フィードのみ。Google News経由は転送URLのため取得不可）
 *  4. Claude API で判定・要約。既掲載/同バッチ内の「同じネタ」は1枚に統合し、
 *     複数媒体が報じている記事は確度を1段階引き上げる
 *  5. data/articles.json に保存
 *
 * 確度: official（公式発表）> high（確度高）> medium（確度中）> low（確度低）
 * 環境変数: ANTHROPIC_API_KEY（GitHub Secrets に設定）
 */

const fs = require("fs");
const path = require("path");
const Parser = require("rss-parser");

// ====== 設定 ======
const MAX_NEW_PER_RUN = 40;
const BATCH_SIZE = 8;
const MAX_ARTICLES_KEPT = 300;
const MAX_SEEN = 5000;
const EXISTING_IN_PROMPT = 60; // 重複判定のためにAIへ渡す既掲載見出しの数
const MODEL = "claude-haiku-4-5-20251001";
const CLUBS = ["milan", "inter", "juventus", "roma", "lazio", "atalanta", "fiorentina"];
const CONF_LEVELS = ["low", "medium", "high", "official"];

const ROOT = path.join(__dirname, "..");
const DATA_FILE = path.join(ROOT, "data", "articles.json");
const SOURCES_FILE = path.join(ROOT, "sources.json");

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("ERROR: 環境変数 ANTHROPIC_API_KEY が設定されていません。");
  process.exit(1);
}

// ====== ユーティリティ ======
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","fbclid","gclid"].forEach((k) => url.searchParams.delete(k));
    return url.toString();
  } catch { return u; }
}

function normalizeTitle(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9\u00c0-\u024f\u3040-\u30ff\u4e00-\u9faf]+/g, "").slice(0, 120);
}

function stripHtml(s) {
  return (s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ").trim();
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function extractPublisher(item) {
  const s = item.gnSource;
  if (typeof s === "string") return s.trim();
  if (s && typeof s === "object" && s._) return String(s._).trim();
  return null;
}

function cleanTitle(title, publisher) {
  if (publisher && title.endsWith(" - " + publisher)) {
    return title.slice(0, -(" - " + publisher).length).trim();
  }
  return title;
}

function isTrusted(publisher, trustedList) {
  if (!publisher) return false;
  const p = publisher.toLowerCase().trim();
  return trustedList.some((t) => t.toLowerCase().trim() === p);
}

// 確度を1段階上げる（officialへは自動昇格しない: 公式発表は内容でのみ判定）
function bumpConfidence(c) {
  if (c === "official" || c === "high") return c === "official" ? "official" : "high";
  const i = CONF_LEVELS.indexOf(c);
  return i >= 0 ? CONF_LEVELS[Math.min(i + 1, 2)] : c;
}

// 記事に媒体を追加（既に同じ媒体があれば何もしない）。追加できたら true
function addSource(article, name, url) {
  if (!article.sources || !article.sources.length) {
    article.sources = [{ name: article.source, url: article.url }];
  }
  if (article.sources.some((s) => s.name === name)) return false;
  article.sources.push({ name, url });
  article.source = article.sources[0].name;
  article.confidence = bumpConfidence(article.confidence);
  return true;
}

// ====== 記事本文の冒頭を取得 ======
async function fetchLead(url) {
  if (/news\.google\.com/.test(url)) return ""; // 転送URLは本文が取れない
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "accept-language": "it-IT,it;q=0.9,en;q=0.6",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return "";
    const html = (await res.text()).slice(0, 400000);
    const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => stripHtml(m[1]))
      .filter((s) => s.length > 60 && !/cookie|privacy|abbonati|newsletter/i.test(s));
    return paras.slice(0, 6).join(" ").slice(0, 1800);
  } catch { return ""; }
}

// ====== Claude API ======
async function callClaude(prompt, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 8000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        console.warn(`API ${res.status} — ${attempt}回目、リトライします`);
        await new Promise((r) => setTimeout(r, 5000 * attempt));
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`API error ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = await res.json();
      return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    } catch (e) {
      if (attempt === maxRetries) throw e;
      console.warn(`API呼び出し失敗（${attempt}回目）: ${e.message} — リトライします`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

function buildPrompt(batch, existingHeadlines) {
  const list = batch
    .map(
      (a, i) =>
        `--- 記事 ${i} ---\n媒体: ${a.publisher || a.sourceName}\nフィードのクラブタグ: ${a.feedTag}\n見出し: ${a.title}\nリード文: ${a.snippet || "(なし)"}\n本文冒頭: ${a.lead || "(取得できず)"}`
    )
    .join("\n\n");

  const existing = existingHeadlines.length
    ? existingHeadlines.map((e) => `${e.key}: ${e.headline}`).join("\n")
    : "(なし)";

  return `あなたはイタリアサッカー（セリエA）専門の日本語ニュース編集者です。以下の新着記事リスト（イタリア語または英語）を1件ずつ判定・翻訳要約してください。

【対象クラブ】セリエAの全クラブ（昇格・降格が絡む場合はセリエBクラブも可）
【対象トピック】移籍・補強／監督・フロント人事／主要選手の負傷・出場停止／審判・リーグ運営

【重複判定 — 最初に必ずやること】
下の「掲載済み記事一覧」と新着記事リストを見比べて、同じ出来事・同じネタを報じている記事（媒体や言い回しが違うだけのもの）を特定する。
- 新着記事が掲載済み記事と同じネタ → same_as にその記事のキー（例: "E3"）を入れる
- 新着記事同士が同じネタ → 後の記事の same_as に先の記事の番号（例: 2）を入れる
- 独立したネタ → same_as は null
続報（同じ話題でも交渉進展・正式決定など新しい事実がある場合）は重複ではなく独立記事として扱う。

【掲載済み記事一覧】
${existing}

【判定ルール】
- セリエAに関係し、かつ対象トピックに該当する記事だけ relevant を true にする。試合結果のみの記事、他リーグ・他競技の話題、コラム・雑談は false。same_as が付く記事は relevant の判定不要（true でよい）。
- club: 主役クラブが ${CLUBS.join(" / ")} のいずれかならそれ、それ以外のクラブやリーグ全体・審判関連は "altro"。
- club_label_ja: 主役クラブの日本語名（例:「ナポリ」）。リーグ全体・審判関連は「セリエA」。
- confidence（情報の確度・内容から判断する）:
  "official"＝クラブ・リーグ・連盟の公式発表、本人が公の場で明言した内容
  "high"＝一次取材に定評のある記者・媒体による確定的な報道（合意済み・メディカル日程確定など）
  "medium"＝信頼できる媒体の報道だが未確定（交渉中・関心・候補段階）
  "low"＝出所が曖昧な噂・憶測・当事者が否定している話

【翻訳・要約ルール】
- headline_ja: 日本語の見出し（35字以内、体言止め可）
- summary_ja: 4〜6文（200〜350字目安）の日本語要約。本文冒頭がある場合はそれを主材料に、移籍金・契約年数・関係者名・交渉状況・経緯など具体的な事実を盛り込む。本文がない場合は見出しとリード文の内容を丁寧に説明し、確実に知っている一般的な背景（選手の所属・ポジション・年齢など）を1文まで補足してよい。不確かな背景は書かない。
- 原文の意味に忠実な翻訳調で構わないが、自然な日本語を最優先。選手名・監督名は日本のサッカーメディアで一般的なカタカナ表記。
- 情報を捏造しない。

【出力形式】
JSON配列のみを出力。説明文・コードフェンス禁止。
[{"id": 0, "same_as": null, "relevant": true, "club": "milan", "club_label_ja": "ミラン", "confidence": "medium", "headline_ja": "...", "summary_ja": "..."}, {"id": 1, "same_as": "E3", "relevant": true, "club": "milan", "club_label_ja": "ミラン", "confidence": "medium", "headline_ja": "", "summary_ja": ""}, ...]

【新着記事リスト】
${list}`;
}

function parseModelJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("JSON配列が見つかりません: " + clean.slice(0, 200));
  return JSON.parse(clean.slice(start, end + 1));
}

// ====== メイン ======
async function main() {
  const conf = loadJson(SOURCES_FILE, {});
  const trusted = conf.trustedPublishers || [];

  // フィード一覧を組み立て（旧形式 "sources" にも対応）
  const feeds = [];
  (conf.globalSources || conf.sources || []).forEach((s) => feeds.push({ ...s, tag: s.tag || "altro" }));
  Object.entries(conf.clubSources || {}).forEach(([club, list]) =>
    (list || []).forEach((s) => feeds.push({ ...s, tag: club }))
  );

  const store = loadJson(DATA_FILE, { updated: null, articles: [], seenUrls: [], seenTitles: [] });
  const seenUrl = new Set(store.seenUrls || []);
  const seenTitle = new Set(store.seenTitles || []);
  (store.articles || []).forEach((a) => {
    seenUrl.add(normalizeUrl(a.url));
    (a.sources || []).forEach((s) => seenUrl.add(normalizeUrl(s.url)));
    if (a.titleKey) seenTitle.add(a.titleKey);
  });

  const parser = new Parser({ timeout: 20000, customFields: { item: [["source", "gnSource"]] } });

  const candidates = [];
  const feedStatus = [];

  for (const src of feeds) {
    if (!src.enabled) continue;
    try {
      const feed = await parser.parseURL(src.url);
      let kept = 0, rejected = 0;
      const rejectedPublishers = new Set();
      for (const item of feed.items || []) {
        const url = normalizeUrl(item.link || "");
        if (!url || seenUrl.has(url)) continue;

        const publisher = extractPublisher(item);
        const allowList = src.publishers || trusted;
        if (src.filterByTrusted && !isTrusted(publisher, allowList)) {
          rejected++;
          if (publisher) rejectedPublishers.add(publisher);
          seenUrl.add(url);
          continue;
        }

        const title = cleanTitle(stripHtml(item.title), publisher);
        const titleKey = normalizeTitle(title);
        if (titleKey && seenTitle.has(titleKey)) { seenUrl.add(url); continue; }
        if (titleKey) seenTitle.add(titleKey);

        candidates.push({
          url, title, titleKey,
          publisher: publisher || src.name, // 直接フィードはフィード名＝媒体名
          snippet: stripHtml(item.contentSnippet || item.content || item.summary || "").slice(0, 500),
          sourceName: src.name,
          feedTag: src.tag || "altro",
          publishedAt: item.isoDate || item.pubDate || null,
        });
        kept++;
      }
      feedStatus.push({ name: src.name, tag: src.tag, ok: true, newItems: kept, filteredOut: rejected });
      console.log(`OK: ${src.name} [${src.tag}] — 新着候補 ${kept} 件（信頼媒体外として除外 ${rejected} 件）`);
      if (rejectedPublishers.size) {
        console.log(`   除外した媒体: ${[...rejectedPublishers].slice(0, 20).join(" / ")}`);
        console.log(`   ↑信頼できる媒体があれば sources.json の trustedPublishers にこの表記のまま追加`);
      }
    } catch (e) {
      feedStatus.push({ name: src.name, ok: false, error: String(e.message).slice(0, 200) });
      console.warn(`SKIP: ${src.name} のフィード取得に失敗 — ${e.message}`);
    }
  }

  candidates.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  const targets = candidates.slice(0, MAX_NEW_PER_RUN);
  console.log(`新着候補 ${candidates.length} 件のうち ${targets.length} 件を処理します`);

  await Promise.all(targets.map(async (t) => { t.lead = await fetchLead(t.url); }));
  console.log(`本文冒頭を取得できた記事: ${targets.filter((t) => t.lead).length}/${targets.length} 件`);

  // 重複判定用: 既掲載記事（新しい順）を E0, E1, ... として参照できるようにする
  const existingRefs = (store.articles || []).slice(0, EXISTING_IN_PROMPT).map((a, i) => ({
    key: "E" + i, headline: a.headline, article: a,
  }));

  const accepted = [];       // 今回の新規カード
  let mergedCount = 0;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    // 既掲載＋今回すでに採用した記事を重複判定の対象にする
    const promptExisting = [
      ...existingRefs.map((e) => ({ key: e.key, headline: e.headline })),
      ...accepted.map((a, k) => ({ key: "N" + k, headline: a.headline })),
    ];
    const batchArticles = {}; // このバッチ内 id → 生成した記事
    try {
      const text = await callClaude(buildPrompt(batch, promptExisting));
      const results = parseModelJson(text);
      for (const r of results) {
        const src = batch[r.id];
        if (!src) continue;
        seenUrl.add(src.url);

        // ---- 同じネタの統合 ----
        let mergeTarget = null;
        if (typeof r.same_as === "string" && /^E\d+$/.test(r.same_as)) {
          const ref = existingRefs[parseInt(r.same_as.slice(1), 10)];
          mergeTarget = ref && ref.article;
        } else if (typeof r.same_as === "string" && /^N\d+$/.test(r.same_as)) {
          mergeTarget = accepted[parseInt(r.same_as.slice(1), 10)];
        } else if (typeof r.same_as === "number") {
          mergeTarget = batchArticles[r.same_as];
        }
        if (mergeTarget) {
          if (addSource(mergeTarget, src.publisher, src.url)) mergedCount++;
          continue;
        }

        if (r.relevant && r.headline_ja && r.summary_ja) {
          const art = {
            url: src.url,
            source: src.publisher,
            sources: [{ name: src.publisher, url: src.url }],
            titleKey: src.titleKey,
            club: CLUBS.includes(r.club) ? r.club : (CLUBS.includes(src.feedTag) ? src.feedTag : "altro"),
            clubLabel: r.club_label_ja ? String(r.club_label_ja).slice(0, 20) : null,
            confidence: CONF_LEVELS.includes(r.confidence) ? r.confidence : "low",
            headline: String(r.headline_ja).slice(0, 70),
            summary: String(r.summary_ja).slice(0, 800),
            publishedAt: src.publishedAt,
            addedAt: new Date().toISOString(),
          };
          accepted.push(art);
          batchArticles[r.id] = art;
        }
      }
      console.log(`バッチ ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} 件処理`);
    } catch (e) {
      console.warn(`バッチ処理失敗（このバッチはスキップ）: ${e.message}`);
      batch.forEach((a) => seenUrl.add(a.url));
    }
  }

  const articles = [...accepted, ...(store.articles || [])].slice(0, MAX_ARTICLES_KEPT);
  const newStore = {
    updated: new Date().toISOString(),
    feedStatus,
    articles,
    seenUrls: [...seenUrl].slice(-MAX_SEEN),
    seenTitles: [...seenTitle].slice(-MAX_SEEN),
  };
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(newStore, null, 1), "utf8");
  fs.writeFileSync(path.join(ROOT, "data", "last_run.txt"), new Date().toISOString() + "\n", "utf8");

  console.log(`完了: 新規 ${accepted.length} 件 / 既存記事への媒体追加（統合） ${mergedCount} 件 / 掲載合計 ${articles.length} 件`);
}

main().catch((e) => {
  console.error("致命的エラー:", e);
  process.exit(1);
});
