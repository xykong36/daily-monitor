#!/usr/bin/env node
/**
 * Weekly PH Report Generator
 * Usage: node weekly-report.mjs [2026-03-24]   (Monday date, auto-detects previous Monday if omitted)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');

// ── Load .env ──
const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
const env = {};
for (const line of envFile.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
}
const DEEPSEEK_KEY = env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_KEY) { console.error('Missing DEEPSEEK_API_KEY in .env'); process.exit(1); }
const DISCORD_WEBHOOK = env.DISCORD_WEBHOOK_URL;
if (!DISCORD_WEBHOOK) { console.error('Missing DISCORD_WEBHOOK_URL in .env'); process.exit(1); }

// ── curlPost (from backfill.mjs) ──
function curlPost(url, headers, body) {
  const headerArgs = Object.entries(headers).map(([k, v]) => `-H '${k}: ${v}'`).join(' ');
  const bodyFile = path.join(__dirname, '.tmp-body.json');
  fs.writeFileSync(bodyFile, typeof body === 'string' ? body : JSON.stringify(body));
  try {
    const result = execSync(
      `curl -s -w '\\n__HTTP_STATUS__%{http_code}' -X POST ${headerArgs} -d @${bodyFile} '${url}'`,
      { maxBuffer: 10 * 1024 * 1024, timeout: 120000 }
    ).toString();
    const statusMatch = result.match(/__HTTP_STATUS__(\d+)$/);
    const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
    const responseBody = result.replace(/__HTTP_STATUS__\d+$/, '');
    return { statusCode, body: responseBody };
  } finally {
    if (fs.existsSync(bodyFile)) fs.unlinkSync(bodyFile);
  }
}

// ── Parse CLI args ──
let mondayStr = process.argv[2];
if (!mondayStr) {
  // Auto-detect previous week's Monday using Pacific Time
  const now = new Date();
  const ptDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const today = new Date(ptDateStr + 'T00:00:00Z');
  today.setUTCDate(today.getUTCDate() - 7);
  const dayOfWeek = today.getUTCDay();
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  today.setUTCDate(today.getUTCDate() - diff);
  mondayStr = today.toISOString().slice(0, 10);
  console.log(`Auto-detected previous Monday (PT): ${mondayStr}`);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(mondayStr)) {
  console.error('Usage: node weekly-report.mjs [YYYY-MM-DD]  (Monday date, optional)');
  process.exit(1);
}

// ── Step 1: Load & merge data for Mon–Sun ──
function getWeekDates(mondayStr) {
  const d = new Date(mondayStr + 'T00:00:00Z');
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(d);
    day.setUTCDate(d.getUTCDate() + i);
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

const weekDates = getWeekDates(mondayStr);
const sundayStr = weekDates[6];
console.log(`Week: ${mondayStr} ~ ${sundayStr}`);

// Load daily files
const dailyProducts = {}; // date -> products[]
const allProductsMap = new Map(); // id -> product (dedup)

for (const date of weekDates) {
  const filePath = path.join(dataDir, `ph-raw-${date}.json`);
  if (!fs.existsSync(filePath)) {
    console.log(`  ⚠ Missing: ${filePath}`);
    dailyProducts[date] = [];
    continue;
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const products = data.products || [];
  dailyProducts[date] = products;
  for (const p of products) {
    if (!allProductsMap.has(p.id) || allProductsMap.get(p.id).votesCount < p.votesCount) {
      allProductsMap.set(p.id, p);
    }
  }
  console.log(`  ${date}: ${products.length} products`);
}

const allProducts = [...allProductsMap.values()].sort((a, b) => b.votesCount - a.votesCount);
console.log(`\nTotal unique products: ${allProducts.length}`);

const totalVotes = allProducts.reduce((s, p) => s + p.votesCount, 0);
const totalComments = allProducts.reduce((s, p) => s + p.commentsCount, 0);

// ── Step 2: Category aggregation ──
const categoryMap = new Map(); // topic -> { products[], totalVotes }
for (const p of allProducts) {
  const topics = p.topics && p.topics.length > 0 ? p.topics : ['Other'];
  for (const t of topics) {
    if (!categoryMap.has(t)) categoryMap.set(t, { products: [], totalVotes: 0 });
    const cat = categoryMap.get(t);
    cat.products.push(p);
    cat.totalVotes += p.votesCount;
  }
}
const excludedCategories = new Set(['Crypto', 'Database', 'Home Services', 'Cooking']);
const categories = [...categoryMap.entries()]
  .map(([name, data]) => ({ name, products: data.products, totalVotes: data.totalVotes }))
  .filter(c => !excludedCategories.has(c.name))
  .sort((a, b) => b.totalVotes - a.totalVotes);

console.log(`Categories: ${categories.length}`);

// ── Step 3: AI Analysis ──
const dsHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` };

function callDeepSeek(systemPrompt, userPrompt) {
  console.log('  Calling DeepSeek...');
  const res = curlPost('https://api.deepseek.com/chat/completions', dsHeaders, {
    model: 'deepseek-chat',
    temperature: 0.7,
    max_tokens: 1500,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });
  if (res.statusCode !== 200) {
    console.error(`  DeepSeek error ${res.statusCode}: ${res.body.substring(0, 200)}`);
    return null;
  }
  const data = JSON.parse(res.body);
  return data?.choices?.[0]?.message?.content || null;
}

// Generate per-category insights
const categoryInsights = {};
console.log('\nGenerating category insights...');
for (const cat of categories.slice(0, 12)) { // top 12 categories
  const topProducts = cat.products.slice(0, 8).map(p =>
    `${p.name} (${p.votesCount}票): ${p.tagline}`
  ).join('\n');

  const insight = callDeepSeek(
    '你是一位科技产品分析师，用中文写作，每次回答3-4句话，简洁精炼。',
    `分析 Product Hunt 本周「${cat.name}」分类的趋势。该分类共 ${cat.products.length} 个产品，总票数 ${cat.totalVotes}。\nTop 产品:\n${topProducts}\n\n请用3-4句话总结这个分类本周的趋势和亮点。`
  );
  categoryInsights[cat.name] = insight || '暂无分析。';
  console.log(`  ${cat.name}: ${(insight || '').length} chars`);
  execSync('sleep 1');
}

// Generate overall weekly insight
console.log('\nGenerating overall weekly insight...');
const topOverall = allProducts.slice(0, 20).map((p, i) =>
  `#${i + 1} ${p.name} (${p.votesCount}票) - ${p.tagline} [${(p.topics || []).join(', ')}]`
).join('\n');

const overallInsight = callDeepSeek(
  '你是一位敏锐的科技产品分析师，用中文写作。',
  `分析 ${mondayStr} ~ ${sundayStr} 这一周的 Product Hunt 趋势。共 ${allProducts.length} 个产品，总票数 ${totalVotes}。

Top 20 产品:
${topOverall}

分类分布（Top 10）:
${categories.slice(0, 10).map(c => `${c.name}: ${c.products.length}个产品, ${c.totalVotes}票`).join('\n')}

请按以下4个板块各写3-4条（每条一句话）：
🔥 值得关注 — 最有意思的产品及原因
📈 趋势信号 — 本周技术/市场趋势
⚔️ 竞品对照 — 新产品 vs 成熟竞品的创新点
🛠 Builder 启示 — 给独立开发者的建议`
);

// ── Step 4: Build HTML ──
console.log('\nBuilding HTML...');

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getWeekNumber(dateStr) {
  // ISO 8601 week number
  const d = new Date(dateStr + 'T00:00:00Z');
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
}

const weekNum = getWeekNumber(mondayStr);
const weekLabel = `W${weekNum}`;
const maxVotes = categories.length > 0 ? categories[0].totalVotes : 1;
const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Inter", -apple-system, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
    font-size: 15px; line-height: 1.75; color: #1c1917; background: #fafaf9;
  }
  .container { max-width: 960px; margin: 0 auto; padding: 0 32px; }

  /* Cover */
  .cover { display: block; text-align: center; padding-top: 100px; min-height: 90vh; border-bottom: 1px solid #e7e5e4; margin-bottom: 48px; }
  .cover h1 { font-family: Georgia, "Noto Serif SC", serif; font-size: 44px; font-weight: 700; margin-bottom: 8px; color: #1c1917; letter-spacing: -1px; }
  .cover .accent { color: #da552f; }
  .cover .subtitle { font-size: 17px; color: #78716c; margin-bottom: 48px; }
  .cover .stats { display: inline-flex; gap: 56px; margin-bottom: 56px; }
  .cover .stat { text-align: center; }
  .cover .stat-num { font-size: 40px; font-weight: 800; color: #da552f; }
  .cover .stat-label { font-size: 12px; color: #a8a29e; text-transform: uppercase; letter-spacing: 2px; margin-top: 4px; }
  .top3 { display: inline-flex; gap: 24px; max-width: 720px; }
  .top3-card { flex: 1; background: #fff; border: 1px solid #e7e5e4; border-radius: 12px; padding: 24px 20px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.04); }
  .top3-card .rank { font-size: 24px; margin-bottom: 12px; }
  .top3-card img { width: 64px; height: 64px; border-radius: 12px; object-fit: cover; margin-bottom: 10px; }
  .top3-card .name { font-family: Georgia, serif; font-size: 15px; font-weight: 600; color: #1c1917; margin-bottom: 4px; }
  .top3-card .votes { font-size: 14px; color: #da552f; font-weight: 700; }
  .top3-card .tagline { font-size: 13px; color: #a8a29e; margin-top: 6px; }

  /* TOC */
  .toc-section { margin-bottom: 48px; }
  .toc h2 { font-family: Georgia, serif; font-size: 26px; margin-bottom: 24px; color: #1c1917; }
  .toc-grid { column-count: 2; column-gap: 32px; }
  .toc-item { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid #f5f5f4; font-size: 14px; break-inside: avoid; }
  .toc-item .label { color: #44403c; }
  .toc-item .count { color: #a8a29e; font-variant-numeric: tabular-nums; }

  /* Section headers */
  h2.section-title { font-family: Georgia, "Noto Serif SC", serif; font-size: 26px; color: #1c1917; margin-bottom: 24px; }
  h2.section-title::after { content: ''; display: block; width: 40px; height: 3px; background: #da552f; margin-top: 10px; border-radius: 2px; }
  h3.cat-title { font-size: 17px; color: #44403c; margin-bottom: 12px; font-weight: 700; }

  /* Daily Top 5 */
  .daily-block { margin-bottom: 28px; }
  .daily-block h4 { font-size: 14px; color: #da552f; margin-bottom: 10px; font-weight: 600; letter-spacing: .5px; }
  .daily-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .daily-table th { text-align: left; padding: 10px 14px; font-weight: 600; color: #78716c; border-bottom: 2px solid #e7e5e4; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
  .daily-table td { padding: 12px 14px; border-bottom: 1px solid #f5f5f4; }
  .daily-table .rank-col { width: 40px; text-align: center; color: #a8a29e; font-weight: 700; }
  .daily-table .votes-col { width: 60px; text-align: right; color: #da552f; font-weight: 700; font-size: 15px; }
  .daily-table .topics-col { color: #a8a29e; font-size: 12px; }

  /* Bar chart */
  .bar-row { display: flex; align-items: center; margin-bottom: 10px; font-size: 13px; }
  .bar-label { width: 160px; text-align: right; padding-right: 14px; font-weight: 600; color: #44403c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { flex: 1; background: #f5f5f4; height: 28px; border-radius: 6px; position: relative; overflow: hidden; }
  .bar-fill { background: linear-gradient(90deg, #da552f, #f59e0b); height: 100%; border-radius: 6px; min-width: 4px; }
  .bar-value { position: absolute; right: 10px; top: 5px; font-size: 12px; color: #78716c; font-weight: 500; }
  .bar-top1 { margin-left: 12px; color: #a8a29e; font-size: 12px; width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-top1-label { background: #da552f; color: #fff; font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 3px; letter-spacing: .5px; margin-right: 4px; }
  .bar-top1-votes { color: #da552f; font-weight: 700; font-size: 11px; margin-left: 4px; }

  /* Product cards */
  .product-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .product-card { background: #fff; border: 1px solid #e7e5e4; border-radius: 12px; padding: 20px; display: flex; gap: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.03); }
  .product-card img { width: 52px; height: 52px; border-radius: 10px; object-fit: cover; flex-shrink: 0; }
  .product-card .info { flex: 1; min-width: 0; }
  .product-card .name { font-size: 15px; font-weight: 700; color: #1c1917; }
  .product-card .meta { font-size: 12px; color: #a8a29e; margin-top: 6px; }
  .product-card .tagline { font-size: 14px; color: #78716c; margin-top: 4px; }
  .product-card .votes-badge { color: #da552f; font-weight: 800; }

  /* Full product list (compact) */
  .product-list { width: 100%; border-collapse: collapse; font-size: 13px; }
  .product-list th { text-align: left; padding: 6px 8px; font-weight: 600; color: #78716c; border-bottom: 2px solid #e7e5e4; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  .product-list td { padding: 6px 8px; border-bottom: 1px solid #f5f5f4; }
  .product-list .r { text-align: right; }

  /* Insight box */
  .insight-box { background: #fffbf5; border-left: 3px solid #da552f; padding: 16px 20px; margin: 16px 0; font-size: 14px; line-height: 1.8; border-radius: 0 8px 8px 0; }
  .insight-box p { margin-bottom: 6px; }

  /* AI section */
  .ai-section { line-height: 1.9; font-size: 15px; }
  .ai-section h3 { font-family: Georgia, serif; font-size: 20px; color: #1c1917; margin: 24px 0 12px; font-weight: 700; }
  .ai-section p, .ai-section li { margin-bottom: 10px; color: #44403c; }
  .ai-section ul { padding-left: 20px; }

  /* Rankings table */
  .rank-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .rank-table th { padding: 6px 8px; text-align: left; font-size: 11px; font-weight: 600; color: #78716c; border-bottom: 2px solid #e7e5e4; text-transform: uppercase; letter-spacing: .5px; }
  .rank-table td { padding: 5px 8px; border-bottom: 1px solid #f5f5f4; }
  .rank-table tr:nth-child(even) { background: #fafaf9; }
  .rank-table .r { text-align: right; }

  a.product-link { color: inherit; text-decoration: none; border-bottom: 1px solid #e7e5e4; transition: border-color .15s; }
  a.product-link:hover { border-color: #da552f; color: #da552f; }

  @media screen {
    .page {
      max-width: 960px;
      margin: 0 auto;
      padding: 48px 32px;
    }
    .cover {
      max-width: 960px;
      margin: 0 auto;
      padding-left: 32px;
      padding-right: 32px;
    }
  }

  /* ── Mobile responsive ── */
  @media screen and (max-width: 768px) {
    body { font-size: 14px; }

    .page {
      max-width: 100%;
      padding: 32px 16px;
    }
    .cover {
      max-width: 100%;
      padding: 60px 16px 32px;
      min-height: auto;
    }
    .cover h1 { font-size: 28px; }
    .cover .subtitle { font-size: 14px; margin-bottom: 32px; }
    .cover .stats { gap: 24px; margin-bottom: 32px; }
    .cover .stat-num { font-size: 28px; }
    .cover .stat-label { font-size: 11px; }

    .top3 { display: flex; flex-direction: column; gap: 12px; width: 100%; }
    .top3-card { padding: 16px; }
    .top3-card img { width: 48px; height: 48px; }

    h2.section-title { font-size: 20px; }

    .toc-grid { column-count: 1; }

    .daily-table, .product-list, .rank-table {
      display: block;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    .bar-row { flex-wrap: wrap; }
    .bar-label { width: 100%; text-align: left; padding-right: 0; padding-bottom: 4px; font-size: 12px; }
    .bar-top1 { display: none; }

    .product-cards { grid-template-columns: 1fr; }
    .product-card { padding: 14px; gap: 10px; }
    .product-card img { width: 40px; height: 40px; }

    .insight-box { padding: 12px 14px; font-size: 13px; }

    .ai-section h3 { font-size: 17px; }
    .ai-section { font-size: 14px; }
  }
</style>
</head>
<body>
`;

// ── Page 1: Cover ──
const top3 = allProducts.slice(0, 3);
const medals = ['🥇', '🥈', '🥉'];
html += `<div class="cover">
  <h1>Product Hunt <span class="accent">周报</span></h1>
  <div class="subtitle">${mondayStr} ~ ${sundayStr} · ${weekLabel}</div>
  <div class="stats">
    <div class="stat"><div class="stat-num">${allProducts.length}</div><div class="stat-label">Products</div></div>
    <div class="stat"><div class="stat-num">${totalVotes.toLocaleString()}</div><div class="stat-label">Votes</div></div>
    <div class="stat"><div class="stat-num">${totalComments.toLocaleString()}</div><div class="stat-label">Comments</div></div>
  </div>
  <div class="top3">
    ${top3.map((p, i) => `<div class="top3-card">
      <div class="rank">${medals[i]}</div>
      ${p.thumbnail ? `<img src="${escHtml(p.thumbnail)}" alt="">` : '<div style="width:64px;height:64px;background:#f5f5f4;border-radius:12px;margin:0 auto 10px"></div>'}
      <div class="name"><a href="${escHtml(p.website)}" class="product-link" target="_blank">${escHtml(p.name)}</a></div>
      <div class="votes">🔺 ${p.votesCount}</div>
      <div class="tagline">${escHtml(p.tagline?.substring(0, 60))}</div>
    </div>`).join('\n')}
  </div>
</div>
`;

// ── Page 2: TOC ──
html += `<div class="page">
  <h2 class="section-title">📑 目录</h2>
  <div class="toc-grid">
  <div class="toc-item"><span class="label">封面</span><span class="count">1</span></div>
  <div class="toc-item"><span class="label">目录</span><span class="count">2</span></div>
  <div class="toc-item"><span class="label">每日 Top 5 速览</span><span class="count">3-4</span></div>
  <div class="toc-item"><span class="label">分类分布</span><span class="count">5</span></div>
`;
let pageEst = 6;
for (const cat of categories.slice(0, 20).filter(c => c.products.length >= 3 || c.totalVotes >= 50)) {
  html += `  <div class="toc-item"><span class="label">${escHtml(cat.name)} (${cat.products.length})</span><span class="count">${pageEst}</span></div>\n`;
  pageEst += cat.products.length > 15 ? 2 : 1;
}
html += `  <div class="toc-item"><span class="label">全产品排行榜</span><span class="count">${pageEst}</span></div>
  <div class="toc-item"><span class="label">AI 趋势洞察</span><span class="count">${pageEst + 3}</span></div>
  </div>
</div>
`;

// ── Page 3-4: Daily Top 5 ──
html += `<div class="page">
  <h2 class="section-title">📅 每日 Top 5 速览</h2>
`;
for (let i = 0; i < weekDates.length; i++) {
  const date = weekDates[i];
  const dayProds = dailyProducts[date] || [];
  const top5 = dayProds.slice(0, 5);
  if (i === 4) html += `</div><div class="page">`; // page break after 4 days
  html += `<div class="daily-block">
    <h4>${dayNames[i]} · ${date}</h4>
    ${top5.length === 0 ? '<p style="color:#888;font-size:10px;">暂无数据</p>' : `<table class="daily-table">
      <tr><th class="rank-col">#</th><th>产品</th><th>简介</th><th class="topics-col">分类</th><th class="votes-col">票数</th></tr>
      ${top5.map((p, j) => `<tr>
        <td class="rank-col">${j + 1}</td>
        <td style="font-weight:500"><a href="${escHtml(p.website)}" class="product-link" target="_blank">${escHtml(p.name)}</a></td>
        <td>${escHtml(p.tagline?.substring(0, 40))}</td>
        <td class="topics-col">${escHtml((p.topics || []).slice(0, 2).join(', '))}</td>
        <td class="votes-col">${p.votesCount}</td>
      </tr>`).join('\n')}
    </table>`}
  </div>`;
}
html += `</div>`;

// ── Page 5: Category distribution ──
html += `<div class="page">
  <h2 class="section-title">📊 分类分布</h2>
`;
for (const cat of categories.slice(0, 20)) {
  const pct = Math.round((cat.totalVotes / maxVotes) * 100);
  const top1 = cat.products[0];
  html += `<div class="bar-row">
    <div class="bar-label">${escHtml(cat.name)}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div><div class="bar-value">${cat.products.length}个 · ${cat.totalVotes}票</div></div>
    <div class="bar-top1"><span class="bar-top1-label">TOP1</span> ${top1?.website ? `<a href="${escHtml(top1.website)}" class="product-link" target="_blank">${escHtml(top1.name)}</a>` : escHtml(top1?.name || '')} <span class="bar-top1-votes">🔺${top1?.votesCount || 0}</span></div>
  </div>`;
}
html += `</div>`;

// ── Pages 6+: Category chapters (skip categories with < 3 products) ──
const detailCategories = categories.filter(c => c.products.length >= 3 || c.totalVotes >= 50);
for (const cat of detailCategories) {
  const catTop5 = cat.products.slice(0, 5);
  html += `<div class="page">
    <h2 class="section-title">${escHtml(cat.name)}</h2>
    <p style="font-size:11px;color:#666;margin-bottom:12px;">${cat.products.length} 个产品 · 总票数 ${cat.totalVotes}</p>
    <h3 class="cat-title">Top 5 产品</h3>
    <div class="product-cards">
      ${catTop5.map((p, i) => `<div class="product-card">
        ${p.thumbnail ? `<img src="${escHtml(p.thumbnail)}" alt="">` : '<div style="width:52px;height:52px;background:#f5f5f4;border-radius:10px;flex-shrink:0"></div>'}
        <div class="info">
          <div class="name"><span class="votes-badge">#${i + 1}</span> <a href="${escHtml(p.website)}" class="product-link" target="_blank">${escHtml(p.name)}</a> <span class="votes-badge">🔺${p.votesCount}</span></div>
          <div class="tagline">${escHtml(p.tagline?.substring(0, 60))}</div>
          <div class="meta">${p.commentsCount} 评论 · ${escHtml((p.topics || []).slice(0, 3).join(', '))}</div>
        </div>
      </div>`).join('\n')}
    </div>
`;
  // Full list if > 5
  if (cat.products.length > 5) {
    html += `<h3 class="cat-title">完整列表</h3>
    <table class="product-list">
      <tr><th style="width:24px">#</th><th>产品</th><th>简介</th><th class="r" style="width:44px">票数</th><th class="r" style="width:44px">评论</th></tr>
      ${cat.products.map((p, i) => `<tr>
        <td>${i + 1}</td>
        <td style="font-weight:500"><a href="${escHtml(p.website)}" class="product-link" target="_blank">${escHtml(p.name)}</a></td>
        <td>${escHtml(p.tagline?.substring(0, 50))}</td>
        <td class="r" style="color:#da552f">${p.votesCount}</td>
        <td class="r">${p.commentsCount}</td>
      </tr>`).join('\n')}
    </table>`;
  }

  // AI insight
  if (categoryInsights[cat.name]) {
    html += `<div class="insight-box">
      <strong>💡 趋势洞察</strong><br>
      ${escHtml(categoryInsights[cat.name]).replace(/\n/g, '<br>')}
    </div>`;
  }

  html += `</div>`;
}

// ── Full rankings (paginated ~100 per page) ──
const RANKS_PER_PAGE = 100;
const totalRankPages = Math.ceil(allProducts.length / RANKS_PER_PAGE);
for (let pg = 0; pg < totalRankPages; pg++) {
  const start = pg * RANKS_PER_PAGE;
  const slice = allProducts.slice(start, start + RANKS_PER_PAGE);
  html += `<div class="page">
    ${pg === 0 ? '<h2 class="section-title">🏆 全产品排行榜</h2>' : `<h3 class="cat-title">全产品排行榜（续 ${pg + 1}/${totalRankPages}）</h3>`}
    <table class="rank-table">
      <tr><th style="width:28px">#</th><th>产品</th><th>简介</th><th style="width:100px">分类</th><th class="r" style="width:38px">票数</th><th class="r" style="width:32px">评论</th></tr>
      ${slice.map((p, i) => `<tr>
        <td>${start + i + 1}</td>
        <td style="font-weight:500"><a href="${escHtml(p.website)}" class="product-link" target="_blank">${escHtml(p.name)}</a></td>
        <td>${escHtml(p.tagline?.substring(0, 45))}</td>
        <td style="font-size:8px;color:#888">${escHtml((p.topics || []).slice(0, 2).join(', '))}</td>
        <td class="r" style="color:#da552f;font-weight:600">${p.votesCount}</td>
        <td class="r">${p.commentsCount}</td>
      </tr>`).join('\n')}
    </table>
  </div>`;
}

// ── Final page: AI Overall Insight ──
html += `<div class="page">
  <h2 class="section-title">🤖 AI 趋势洞察</h2>
  <div class="ai-section">
    ${(overallInsight || '暂无分析。').split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('#')) return `<h3>${escHtml(trimmed.replace(/^#+\s*/, ''))}</h3>`;
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) return `<p style="padding-left:12px">• ${escHtml(trimmed.substring(2))}</p>`;
      return `<p>${escHtml(trimmed)}</p>`;
    }).join('\n')}
  </div>
</div>`;

html += `</body></html>`;

// ── Step 4.5: Save HTML ──
const year = mondayStr.slice(0, 4);
const weeklyDir = path.join(dataDir, 'weekly-reports');
if (!fs.existsSync(weeklyDir)) fs.mkdirSync(weeklyDir, { recursive: true });
const htmlPath = path.join(weeklyDir, `${year}-W${String(weekNum).padStart(2, '0')}.html`);
fs.writeFileSync(htmlPath, html, 'utf-8');
console.log(`HTML saved to: ${htmlPath}`);

// ── Step 4.6: Regenerate weekly-reports index ──
function regenerateIndex() {
  const files = fs.readdirSync(weeklyDir)
    .filter(f => f.endsWith('.html') && f !== 'index.html')
    .sort()
    .reverse(); // newest first

  function weekDateRange(filename) {
    // Parse "2026-W13.html" → { year, week } → Monday–Sunday date range
    const m = filename.match(/^(\d{4})-W(\d{2})\.html$/);
    if (!m) return '';
    const yr = parseInt(m[1]);
    const wk = parseInt(m[2]);
    // ISO 8601: Week 1 contains Jan 4. Compute Monday of that week.
    const jan4 = new Date(Date.UTC(yr, 0, 4));
    const dayOfWeek = jan4.getUTCDay() || 7; // Mon=1..Sun=7
    const mon = new Date(jan4);
    mon.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (wk - 1) * 7);
    const sun = new Date(mon);
    sun.setUTCDate(mon.getUTCDate() + 6);
    const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return `${fmt(mon)} – ${fmt(sun)}`;
  }

  function buildItems(hrefPrefix) {
    return files.map(f => {
      const m2 = f.match(/^(\d{4})-W(\d{2})\.html$/);
      const label = m2 ? `${m2[1]} Week ${parseInt(m2[2])}` : f.replace('.html', '');
      const range = weekDateRange(f);
      return `    <li><a href="${hrefPrefix}${f}"><span class="week">${label}</span><span class="date">${range}</span></a></li>`;
    }).join('\n');
  }

  function buildIndexHtml(items) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Product Hunt Weekly Reports</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Inter", -apple-system, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
    font-size: 15px; line-height: 1.75; color: #1c1917; background: #fafaf9;
  }
  .container { max-width: 720px; margin: 0 auto; padding: 80px 32px; }
  h1 {
    font-family: Georgia, "Noto Serif SC", serif;
    font-size: 36px; font-weight: 700; color: #1c1917;
    letter-spacing: -0.5px; margin-bottom: 8px;
  }
  h1 .accent { color: #da552f; }
  .subtitle { font-size: 15px; color: #78716c; margin-bottom: 48px; }
  .report-list { list-style: none; }
  .report-list li {
    border-bottom: 1px solid #e7e5e4;
  }
  .report-list a {
    display: flex; justify-content: space-between; align-items: center;
    padding: 16px 0; text-decoration: none; color: #1c1917;
    transition: color 0.15s;
  }
  .report-list a:hover { color: #da552f; }
  .report-list .week {
    font-family: Georgia, serif;
    font-size: 17px; font-weight: 600;
  }
  .report-list .date {
    font-size: 13px; color: #a8a29e;
    font-variant-numeric: tabular-nums;
  }
  footer {
    margin-top: 64px; padding-top: 24px;
    border-top: 1px solid #e7e5e4;
    font-size: 12px; color: #a8a29e;
  }
</style>
</head>
<body>
<div class="container">
  <h1>Product Hunt <span class="accent">Weekly</span></h1>
  <p class="subtitle">Weekly trend reports from Product Hunt</p>
  <ul class="report-list">
${items}
  </ul>
  <footer>Auto-generated by ph-daily-monitor</footer>
</div>
</body>
</html>`;
  }

  // weekly-reports/index.html (relative links)
  const weeklyIndexPath = path.join(weeklyDir, 'index.html');
  fs.writeFileSync(weeklyIndexPath, buildIndexHtml(buildItems('')), 'utf-8');
  console.log(`Index regenerated: ${weeklyIndexPath} (${files.length} reports)`);

  // data/index.html (root landing page, links prefixed with weekly-reports/)
  const rootIndexPath = path.join(dataDir, 'index.html');
  fs.writeFileSync(rootIndexPath, buildIndexHtml(buildItems('weekly-reports/')), 'utf-8');
  console.log(`Root index regenerated: ${rootIndexPath}`);
}
regenerateIndex();

// ── Step 6: Send to Discord ──
console.log('\nSending to Discord...');
const discordMsg = `📊 **Product Hunt 周报 — ${mondayStr} ~ ${sundayStr} (${weekLabel})**\\n${allProducts.length} products · ${totalVotes.toLocaleString()} votes · ${categories.length} categories`;
try {
  const discordRes = execSync(
    `curl -s -w '\\n__HTTP_STATUS__%{http_code}' -X POST -F 'payload_json={"username":"PH Weekly Report","content":"${discordMsg}"}' -F "file=@${htmlPath}" '${DISCORD_WEBHOOK}'`,
    { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
  ).toString();
  const statusMatch = discordRes.match(/__HTTP_STATUS__(\d+)$/);
  const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
  if (statusCode >= 400) {
    console.error(`Discord error: ${statusCode}`);
  } else {
    console.log('Sent to Discord ✓');
  }
} catch (e) {
  console.error(`Discord send failed: ${e.message}`);
}

console.log(`\n✅ Done!\n   HTML: ${htmlPath}\n   Discord: sent`);
console.log(`   Products: ${allProducts.length} | Votes: ${totalVotes} | Categories: ${categories.length}`);
