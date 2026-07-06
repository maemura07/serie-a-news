/**
 * セリエAニュース自動収集・要約スクリプト
 * GitHub Actions から定期実行される。
 *
 * 流れ:
 *  1. sources.json のフィードを巡回
 *  2. 信頼できる媒体（trustedPublishers）以外の記事を除外
 *  3. URL・見出しベースで重複排除
 *  4. 記事ページから本文冒頭を取得（取れる場合のみ）
 *  5. Claude API で判定・日本語要約 → data/articles.json に保存
 *
 * 環境変数: ANTHROPIC_API_KEY（GitHub Secrets に設定）
 */

const fs = require("fs");
const path = require("path");
const Parser = require("rss-parser");

// ====== 設定 ======
const MAX_NEW_PER_RUN = 40;      // 1回の実行で要約する最大記事数（コスト暴走防止）
const BATCH_SIZE = 6;            // 1回のAPI呼び出しでまとめて処理する記事数
const MAX_ARTICLES_KEPT = 300;   // ページに保持する記事数の上限
const MAX_SEEN = 5000;           // 重複排除用に覚えておくURL/見出し数の上限
const MODEL = "claude-haiku-4-5-20251001";
const CLUBS = ["milan", "inter", "juventus", "roma", "lazio", "atalanta", "fiorentina"];

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
    const junk = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];
    junk.forEach((k) => url.searchParams.delete(k));
    return url.toString();
  } catch {
    return u;
  }
}

function normalizeTitle(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9\u00c0-\u024f\u3040-\u30ff\u4e00-\u9faf]+/g, "").slice(0, 120);
}

function stripHtml(s) {
  return (s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Google Newsのフィードは <source> タグに元媒体名が入る
function extractPublisher(item) {
  const s = item.gnSource;
  if (typeof s === "string") return s.trim();
  if (s && typeof s === "object" && s._) return String(s._).trim();
  return null;
}

// 「見出し - 媒体名」形式の末尾を除去
function cleanTitle(title, publisher) {
  if (publisher && title.endsWith(" - " + publisher)) {
    return title.slice(0, -(" - " + publisher).length).trim();
  }
  return title;
}

function isTrusted(publisher, trustedList) {
  if (!publisher) return false;
  const p = publisher.toLowerCase().trim();
  // 完全一致（大文字小文字は無視）。部分一致にすると "Inter" が "Internews24" 等の
  // まとめサイトにもマッチしてしまうため、あえて厳しくしている。
  return trustedList.some((t) => t.toLowerCase().trim() === p);
}

// ====== 記事本文の冒頭を取得（要約の材料。取れなければ空でOK） ======
async function fetchLead(url) {
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
    return paras.slice(0, 5).join(" ").slice(0, 1500);
  } catch {
    return "";
  }
}

// ====== Claude API 呼び出し ======
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
          max_tokens: 4000,
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
      return (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    } catch (e) {
      if (attempt === maxRetries) throw e;
      console.warn(`API呼び出し失敗（${attempt}回目）: ${e.message} — リトライします`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

function buildPrompt(batch) {
  const list = batch
    .map(
      (a, i) =>
        `--- 記事 ${i} ---\n媒体: ${a.publisher || a.sourceName}\nフィードのクラブタグ: ${a.feedTag}\n見出し: ${a.title}\nリード文: ${a.snippet || "(なし)"}\n本文冒頭: ${a.lead || "(取得できず)"}`
    )
    .join("\n\n");

  return `あなたはイタリアサッカー（セリエA）専門の日本語ニュース編集者です。以下の記事リスト（イタリア語または英語）を1件ずつ判定・翻訳要約してください。

【対象クラブ】セリエAの全クラブ（昇格・降格が絡む場合はセリエBクラブも可）
【対象トピック】移籍・補強／監督・フロント人事／主要選手の負傷・出場停止／審判・リーグ運営

【判定ルール】
- セリエAに関係し、かつ対象トピックに該当する記事だけ relevant を true にする。試合結果のみの記事、他リーグ・他競技の話題、コラム・雑談は false。
- club: 記事の主役クラブが ${CLUBS.join(" / ")} のいずれかならそれを選ぶ。それ以外のクラブ（ナポリ、ボローニャなど）やリーグ全体・審判関連は "altro"。複数クラブに跨る場合は最も中心的なクラブ。
- club_label_ja: 主役クラブの日本語名（例:「ナポリ」「ボローニャ」）。リーグ全体・審判関連の話題は「セリエA」とする。
- confidence（情報の確度）: "high"＝クラブ公式発表・本人の直接発言 / "medium"＝信頼できる記者の報道・交渉中など未確定情報 / "low"＝出所不明の噂・当事者が否定している話。

【翻訳・要約ルール】
- headline_ja: 日本語の見出し（35字以内、体言止め可）
- summary_ja: 3〜5文（目安120〜250字）の日本語要約。本文冒頭が取得できている場合はそれを主な材料にして、金額・契約年数・関係者名・交渉状況など具体的な事実を必ず盛り込む。本文がない場合は見出しとリード文から書ける範囲で書く。
- 無理に言い換えず、原文の意味に忠実な翻訳調で構わない。ただし不自然な日本語にならないこと（自然さ最優先）。
- 選手名・監督名は日本のサッカーメディアで一般的なカタカナ表記を使う。
- 情報を捏造しない。与えられたテキストから分かる範囲だけで書く。

【出力形式】
JSON配列のみを出力すること。説明文・マークダウンのコードフェンスは一切付けない。
[{"id": 0, "relevant": true, "club": "milan", "club_label_ja": "ミラン", "confidence": "medium", "headline_ja": "...", "summary_ja": "..."}, ...]

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
  const conf = loadJson(SOURCES_FILE, { sources: [], trustedPublishers: [] });
  const trusted = conf.trustedPublishers || [];
  const store = loadJson(DATA_FILE, { updated: null, articles: [], seenUrls: [], seenTitles: [] });
  const seenUrl = new Set(store.seenUrls || []);
  const seenTitle = new Set(store.seenTitles || []);
  (store.articles || []).forEach((a) => {
    seenUrl.add(normalizeUrl(a.url));
    if (a.titleKey) seenTitle.add(a.titleKey);
  });

  const parser = new Parser({
    timeout: 20000,
    customFields: { item: [["source", "gnSource"]] },
  });

  const candidates = [];
  const feedStatus = [];

  for (const src of conf.sources || []) {
    if (!src.enabled) continue;
    try {
      const feed = await parser.parseURL(src.url);
      let kept = 0, rejected = 0;
      const rejectedPublishers = new Set();
      for (const item of feed.items || []) {
        const url = normalizeUrl(item.link || "");
        if (!url || seenUrl.has(url)) continue;

        const publisher = extractPublisher(item);
        // ホワイトリスト方式: filterByTrusted のフィードは信頼媒体以外を捨てる
        const allowList = src.publishers || trusted;
        if (src.filterByTrusted && !isTrusted(publisher, allowList)) {
          rejected++;
          if (publisher) rejectedPublishers.add(publisher);
          seenUrl.add(url); // 次回また弾く手間を省く
          continue;
        }

        const title = cleanTitle(stripHtml(item.title), publisher);
        const titleKey = normalizeTitle(title);
        if (titleKey && seenTitle.has(titleKey)) { seenUrl.add(url); continue; } // 同一記事の媒体違い・URL違いを排除
        if (titleKey) seenTitle.add(titleKey);

        candidates.push({
          url,
          title,
          titleKey,
          publisher,
          snippet: stripHtml(item.contentSnippet || item.content || item.summary || "").slice(0, 500),
          sourceName: src.name,
          feedTag: src.tag || "altro",
          publishedAt: item.isoDate || item.pubDate || null,
        });
        kept++;
      }
      feedStatus.push({ name: src.name, ok: true, newItems: kept, filteredOut: rejected });
      console.log(`OK: ${src.name} — 新着候補 ${kept} 件（信頼媒体外として除外 ${rejected} 件）`);
      if (rejectedPublishers.size) {
        console.log(`   除外した媒体: ${[...rejectedPublishers].slice(0, 20).join(" / ")}`);
        console.log(`   ↑この中に信頼できる媒体があれば sources.json の trustedPublishers にこの表記のまま追加してください`);
      }
    } catch (e) {
      feedStatus.push({ name: src.name, ok: false, error: String(e.message).slice(0, 200) });
      console.warn(`SKIP: ${src.name} のフィード取得に失敗 — ${e.message}`);
    }
  }

  candidates.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  const targets = candidates.slice(0, MAX_NEW_PER_RUN);
  console.log(`新着候補 ${candidates.length} 件のうち ${targets.length} 件を処理します`);

  // 本文冒頭の取得（並列・失敗しても続行）
  await Promise.all(
    targets.map(async (t) => {
      t.lead = await fetchLead(t.url);
    })
  );
  console.log(`本文冒頭を取得できた記事: ${targets.filter((t) => t.lead).length}/${targets.length} 件`);

  const accepted = [];
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    try {
      const text = await callClaude(buildPrompt(batch));
      const results = parseModelJson(text);
      for (const r of results) {
        const src = batch[r.id];
        if (!src) continue;
        if (r.relevant && r.headline_ja && r.summary_ja) {
          accepted.push({
            url: src.url,
            source: src.publisher || src.sourceName,
            titleKey: src.titleKey,
            club: CLUBS.includes(r.club) ? r.club : (CLUBS.includes(src.feedTag) ? src.feedTag : "altro"),
            clubLabel: r.club_label_ja ? String(r.club_label_ja).slice(0, 20) : null,
            confidence: ["high", "medium", "low"].includes(r.confidence) ? r.confidence : "low",
            headline: String(r.headline_ja).slice(0, 70),
            summary: String(r.summary_ja).slice(0, 600),
            publishedAt: src.publishedAt,
            addedAt: new Date().toISOString(),
          });
        }
      }
      console.log(`バッチ ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} 件中 ${results.filter((r) => r.relevant).length} 件採用`);
    } catch (e) {
      console.warn(`バッチ処理失敗（このバッチはスキップ）: ${e.message}`);
    }
    batch.forEach((a) => seenUrl.add(a.url));
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

  console.log(`完了: 今回 ${accepted.length} 件追加 / 掲載合計 ${articles.length} 件`);
}

main().catch((e) => {
  console.error("致命的エラー:", e);
  process.exit(1);
});
