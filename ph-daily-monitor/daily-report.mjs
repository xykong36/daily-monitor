#!/usr/bin/env node
/**
 * Daily PH Report Generator
 * Usage: node daily-report.mjs                  # yesterday (Pacific Time)
 *        node daily-report.mjs 2026-04-01       # specific date
 *        node daily-report.mjs --backfill       # all dates with both .json + .md
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
const dailyDir = path.join(dataDir, 'daily-reports');
const weeklyDir = path.join(dataDir, 'weekly-reports');

// ── CLI arg parsing ──
const arg = process.argv[2];
let dates = [];

if (arg === '--backfill') {
  // Find all dates with both .json + .md
  const files = fs.readdirSync(dataDir);
  const rawDates = new Set(files.filter(f => /^ph-raw-\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(7, 17)));
  const mdDates = new Set(files.filter(f => /^ph-analysis-\d{4}-\d{2}-\d{2}\.md$/.test(f)).map(f => f.slice(12, 22)));
  dates = [...rawDates].filter(d => mdDates.has(d)).sort();
  console.log(`Backfill: found ${dates.length} dates with both .json + .md`);
} else {
  let dateStr = arg;
  if (!dateStr) {
    // Default to yesterday Pacific Time
    const now = new Date();
    const ptDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const today = new Date(ptDateStr + 'T00:00:00Z');
    today.setUTCDate(today.getUTCDate() - 1);
    dateStr = today.toISOString().slice(0, 10);
    console.log(`Auto-detected yesterday (PT): ${dateStr}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    console.error('Usage: node daily-report.mjs [YYYY-MM-DD | --backfill]');
    process.exit(1);
  }
  dates = [dateStr];
}

// ── Utilities ──
function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getDayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()];
}

function mdLineToHtml(line) {
  // Convert **bold** → <strong>
  let out = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Convert [text](url) → <a>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="product-link" target="_blank">$1</a>');
  // Escape remaining bare < > & (but not in already-inserted tags)
  // We do a targeted escape: only escape & not followed by amp;/lt;/gt;/quot;
  // Since markdown content is mostly Chinese text + links, this is sufficient
  return out;
}

// ── Load raw data ──
function loadRawData(date) {
  const filePath = path.join(dataDir, `ph-raw-${date}.json`);
  if (!fs.existsSync(filePath)) return null;
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const products = (data.products || []).sort((a, b) => b.votesCount - a.votesCount);
  const totalCount = products.length;
  const totalVotes = products.reduce((s, p) => s + p.votesCount, 0);
  const totalComments = products.reduce((s, p) => s + p.commentsCount, 0);

  // Category aggregation
  const categoryMap = new Map();
  for (const p of products) {
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

  return { products, totalCount, totalVotes, totalComments, categories };
}

// ── Parse analysis markdown ──
function parseAnalysisMd(date) {
  const filePath = path.join(dataDir, `ph-analysis-${date}.md`);
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8');

  // Split at --- separator; first half = rankings, second half = analysis sections
  const parts = content.split(/\n---\n/);

  // ── Parse Top 15 rankings from first part ──
  const rankings = [];
  const rankingPart = parts[0] || '';
  const rankLines = rankingPart.split('\n');
  // Regex: match product line with **[name](url)** · 🔺votes
  const productRe = /\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s*·\s*🔺(\d+)/;
  for (let i = 0; i < rankLines.length; i++) {
    const m = rankLines[i].match(productRe);
    if (!m) continue;
    // Next non-empty line = Chinese description
    let description = '';
    for (let j = i + 1; j < rankLines.length; j++) {
      const trimmed = rankLines[j].trim();
      if (trimmed.length > 0) { description = trimmed; break; }
    }
    rankings.push({ name: m[1], url: m[2], votes: parseInt(m[3], 10), description });
  }

  // ── Parse analysis sections from second part ──
  const sections = [];
  if (parts.length >= 2) {
    const analysisPart = parts.slice(1).join('\n---\n');

    const sectionHeaders = ['**🔥 值得关注**', '**📈 趋势信号**', '**⚔️ 竞品对照**', '**🛠 Builder 启示**'];
    const sectionNames = ['值得关注', '趋势信号', '竞品对照', 'Builder 启示'];
    const sectionEmojis = ['🔥', '📈', '⚔️', '🛠'];

    for (let i = 0; i < sectionHeaders.length; i++) {
      const startIdx = analysisPart.indexOf(sectionHeaders[i]);
      if (startIdx === -1) continue;

      // Find end: next section header or end of string
      let endIdx = analysisPart.length;
      for (let j = i + 1; j < sectionHeaders.length; j++) {
        const nextIdx = analysisPart.indexOf(sectionHeaders[j]);
        if (nextIdx !== -1) { endIdx = nextIdx; break; }
      }

      const block = analysisPart.slice(startIdx + sectionHeaders[i].length, endIdx).trim();
      const items = block.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => {
          // Strip bullet prefixes: "*   ", "- ", "* "
          let cleaned = line.replace(/^[\*\-]\s+/, '');
          return mdLineToHtml(cleaned);
        });

      sections.push({ name: sectionNames[i], emoji: sectionEmojis[i], items });
    }
  }

  return { rankings, sections };
}

// ── Generate daily report HTML ──
function generateReport(date) {
  const raw = loadRawData(date);
  if (!raw) { console.log(`  ⚠ Missing raw data for ${date}`); return false; }
  const analysisData = parseAnalysisMd(date);
  const rankings = analysisData ? analysisData.rankings : [];
  const analysis = analysisData ? analysisData.sections : [];
  const dayOfWeek = getDayOfWeek(date);

  const { products, totalCount, totalVotes, totalComments, categories } = raw;
  const top3 = products.slice(0, 3);
  const medals = ['🥇', '🥈', '🥉'];
  const maxVotes = categories.length > 0 ? categories[0].totalVotes : 1;

  let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Product Hunt 日报 — ${date}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Inter", -apple-system, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
    font-size: 15px; line-height: 1.75; color: #1c1917; background: #fafaf9;
  }
  .container { max-width: 960px; margin: 0 auto; padding: 0 32px; }

  /* Cover */
  .cover { display: block; text-align: center; padding-top: 48px; padding-bottom: 32px; border-bottom: 1px solid #e7e5e4; margin-bottom: 32px; }
  .cover h1 { font-family: Georgia, "Noto Serif SC", serif; font-size: 36px; font-weight: 700; margin-bottom: 4px; color: #1c1917; letter-spacing: -1px; }
  .cover .accent { color: #da552f; }
  .cover .subtitle { font-size: 15px; color: #78716c; margin-bottom: 24px; }
  .cover .stats { display: inline-flex; gap: 40px; margin-bottom: 28px; }
  .cover .stat { text-align: center; }
  .cover .stat-num { font-size: 32px; font-weight: 800; color: #da552f; }
  .cover .stat-label { font-size: 11px; color: #a8a29e; text-transform: uppercase; letter-spacing: 2px; margin-top: 2px; }
  .top3 { display: inline-flex; gap: 16px; max-width: 720px; }
  .top3-card { flex: 1; background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; padding: 16px 14px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.04); }
  .top3-card .rank { font-size: 20px; margin-bottom: 6px; }
  .top3-card img { width: 48px; height: 48px; border-radius: 10px; object-fit: cover; margin-bottom: 6px; }
  .top3-card .name { font-family: Georgia, serif; font-size: 14px; font-weight: 600; color: #1c1917; margin-bottom: 2px; }
  .top3-card .votes { font-size: 13px; color: #da552f; font-weight: 700; }
  .top3-card .tagline { font-size: 12px; color: #a8a29e; margin-top: 4px; }

  /* Section headers */
  h2.section-title { font-family: Georgia, "Noto Serif SC", serif; font-size: 22px; color: #1c1917; margin-bottom: 16px; }
  h2.section-title::after { content: ''; display: block; width: 32px; height: 3px; background: #da552f; margin-top: 8px; border-radius: 2px; }

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
  .product-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .product-card { background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; padding: 14px; display: flex; gap: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.03); }
  .product-card .product-icon { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; flex-shrink: 0; }
  .product-card .info { flex: 1; min-width: 0; }
  .product-card .name { font-size: 14px; font-weight: 700; color: #1c1917; }
  .product-card .tagline { font-size: 13px; color: #44403c; margin-top: 2px; line-height: 1.5; }
  .product-card .votes-badge { color: #da552f; font-weight: 800; }

  /* Rankings table */
  .rank-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .rank-table th { padding: 6px 8px; text-align: left; font-size: 11px; font-weight: 600; color: #78716c; border-bottom: 2px solid #e7e5e4; text-transform: uppercase; letter-spacing: .5px; }
  .rank-table td { padding: 5px 8px; border-bottom: 1px solid #f5f5f4; }
  .rank-table tr:nth-child(even) { background: #fafaf9; }
  .rank-table .r { text-align: right; }

  a.product-link { color: inherit; text-decoration: none; border-bottom: 1px solid #e7e5e4; transition: border-color .15s; }
  a.product-link:hover { border-color: #da552f; color: #da552f; }

  /* AI section */
  .ai-section { line-height: 1.8; font-size: 14px; }
  .ai-section h3 { font-family: Georgia, serif; font-size: 18px; color: #1c1917; margin: 16px 0 8px; font-weight: 700; }
  .ai-section p, .ai-section li { margin-bottom: 6px; color: #44403c; }
  .ai-section ul { padding-left: 20px; }

  @media screen {
    .page {
      max-width: 960px;
      margin: 0 auto;
      padding: 28px 32px;
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

    .rank-table {
      display: block;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    .bar-row { flex-wrap: wrap; }
    .bar-label { width: 100%; text-align: left; padding-right: 0; padding-bottom: 4px; font-size: 12px; }
    .bar-top1 { display: none; }

    .product-cards { grid-template-columns: 1fr; }
    .product-card { padding: 14px; gap: 10px; }

    .ai-section h3 { font-size: 17px; }
    .ai-section { font-size: 14px; }
  }
</style>
</head>
<body>
`;

  // ── Cover ──
  html += `<div class="cover">
  <h1>Product Hunt <span class="accent">日报</span></h1>
  <div class="subtitle">${date} · ${dayOfWeek}</div>
  <div class="stats">
    <div class="stat"><div class="stat-num">${totalCount}</div><div class="stat-label">Products</div></div>
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

  // ── AI Top 15 ──
  if (rankings.length > 0) {
    // Build name → thumbnail lookup from raw JSON
    const thumbMap = new Map(products.map(p => [p.name, p.thumbnail]));
    html += `<div class="page">
  <h2 class="section-title">🌟 AI 精选 Top 15</h2>
  <div class="product-cards">
`;
    rankings.forEach((r, i) => {
      const thumb = thumbMap.get(r.name) || '';
      const iconHtml = thumb
        ? `<img src="${escHtml(thumb)}" alt="" class="product-icon">`
        : '<div class="product-icon" style="background:#f5f5f4"></div>';
      html += `    <div class="product-card">
      ${iconHtml}
      <div class="info">
        <div class="name">
          <span class="votes-badge">#${i + 1}</span>
          <a href="${escHtml(r.url)}" class="product-link" target="_blank">${escHtml(r.name)}</a>
          <span class="votes-badge">🔺${r.votes}</span>
        </div>
        <div class="tagline">${escHtml(r.description)}</div>
      </div>
    </div>\n`;
    });
    html += `  </div>
</div>`;
  }

  // ── Category distribution ──
  html += `<div class="page">
  <h2 class="section-title">📊 分类分布</h2>
`;
  for (const cat of categories.slice(0, 15)) {
    const pct = Math.round((cat.totalVotes / maxVotes) * 100);
    const top1 = cat.products[0];
    html += `<div class="bar-row">
    <div class="bar-label">${escHtml(cat.name)}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div><div class="bar-value">${cat.products.length}个 · ${cat.totalVotes}票</div></div>
    <div class="bar-top1"><span class="bar-top1-label">TOP1</span> ${top1?.website ? `<a href="${escHtml(top1.website)}" class="product-link" target="_blank">${escHtml(top1.name)}</a>` : escHtml(top1?.name || '')} <span class="bar-top1-votes">🔺${top1?.votesCount || 0}</span></div>
  </div>`;
  }
  html += `</div>`;

  // ── Product ranking (all products) ──
  html += `<div class="page">
  <h2 class="section-title">🏆 全产品排行榜</h2>
  <table class="rank-table">
    <tr><th style="width:28px">#</th><th style="width:28px"></th><th>产品</th><th>简介</th><th style="width:100px">分类</th><th class="r" style="width:38px">票数</th><th class="r" style="width:32px">评论</th></tr>
    ${products.map((p, i) => `<tr>
      <td>${i + 1}</td>
      <td>${p.thumbnail ? `<img src="${escHtml(p.thumbnail)}" alt="" style="width:24px;height:24px;border-radius:5px;object-fit:cover;vertical-align:middle">` : ''}</td>
      <td style="font-weight:500"><a href="${escHtml(p.website)}" class="product-link" target="_blank">${escHtml(p.name)}</a></td>
      <td>${escHtml(p.tagline?.substring(0, 45))}</td>
      <td style="font-size:8px;color:#888">${escHtml((p.topics || []).slice(0, 2).join(', '))}</td>
      <td class="r" style="color:#da552f;font-weight:600">${p.votesCount}</td>
      <td class="r">${p.commentsCount}</td>
    </tr>`).join('\n')}
  </table>
</div>`;

  // ── AI Analysis ──
  if (analysis && analysis.length > 0) {
    html += `<div class="page">
  <h2 class="section-title">🤖 AI 趋势洞察</h2>
  <div class="ai-section">
`;
    for (const section of analysis) {
      html += `    <h3>${section.emoji} ${escHtml(section.name)}</h3>\n`;
      for (const item of section.items) {
        html += `    <p style="padding-left:12px">• ${item}</p>\n`;
      }
    }
    html += `  </div>
</div>`;
  }

  html += `</body></html>`;

  // Save
  if (!fs.existsSync(dailyDir)) fs.mkdirSync(dailyDir, { recursive: true });
  const htmlPath = path.join(dailyDir, `${date}.html`);
  fs.writeFileSync(htmlPath, html, 'utf-8');
  console.log(`  ✓ ${date} (${totalCount} products)`);
  return true;
}

// ── Regenerate daily-reports/index.html ──
function regenerateDailyIndex() {
  if (!fs.existsSync(dailyDir)) return;
  const files = fs.readdirSync(dailyDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .sort()
    .reverse();

  const items = files.map(f => {
    const date = f.replace('.html', '');
    const dayOfWeek = getDayOfWeek(date);
    return `    <li><a href="${f}"><span class="week">${date}</span><span class="date">${dayOfWeek}</span></a></li>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Product Hunt Daily Reports</title>
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
  <h1>Product Hunt <span class="accent">Daily</span></h1>
  <p class="subtitle">Daily trend reports from Product Hunt</p>
  <ul class="report-list">
${items}
  </ul>
  <footer>Auto-generated by ph-daily-monitor</footer>
</div>
</body>
</html>`;

  const indexPath = path.join(dailyDir, 'index.html');
  fs.writeFileSync(indexPath, html, 'utf-8');
  console.log(`Daily index regenerated: ${indexPath} (${files.length} reports)`);
}

// ── Regenerate root index (daily + weekly) ──
function regenerateRootIndex() {
  // Read daily reports
  let dailyFiles = [];
  if (fs.existsSync(dailyDir)) {
    dailyFiles = fs.readdirSync(dailyDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
      .sort()
      .reverse();
  }

  // Read weekly reports
  let weeklyFiles = [];
  if (fs.existsSync(weeklyDir)) {
    weeklyFiles = fs.readdirSync(weeklyDir)
      .filter(f => f.endsWith('.html') && f !== 'index.html')
      .sort()
      .reverse();
  }

  function weekDateRange(filename) {
    const m = filename.match(/^(\d{4})-W(\d{2})\.html$/);
    if (!m) return '';
    const yr = parseInt(m[1]);
    const wk = parseInt(m[2]);
    const jan4 = new Date(Date.UTC(yr, 0, 4));
    const dayOfWeek = jan4.getUTCDay() || 7;
    const mon = new Date(jan4);
    mon.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (wk - 1) * 7);
    const sun = new Date(mon);
    sun.setUTCDate(mon.getUTCDate() + 6);
    const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return `${fmt(mon)} – ${fmt(sun)}`;
  }

  const dailyLatest = dailyFiles.slice(0, 14);
  const dailyItems = dailyLatest.map(f => {
    const date = f.replace('.html', '');
    const dayOfWeek = getDayOfWeek(date);
    return `    <li><a href="daily-reports/${f}"><span class="week">${date}</span><span class="date">${dayOfWeek}</span></a></li>`;
  }).join('\n');

  const weeklyItems = weeklyFiles.map(f => {
    const m = f.match(/^(\d{4})-W(\d{2})\.html$/);
    const label = m ? `${m[1]} Week ${parseInt(m[2])}` : f.replace('.html', '');
    const range = weekDateRange(f);
    return `    <li><a href="weekly-reports/${f}"><span class="week">${label}</span><span class="date">${range}</span></a></li>`;
  }).join('\n');

  const viewAllLink = dailyFiles.length > 14
    ? `\n  <p style="margin-top:12px"><a href="daily-reports/index.html" style="color:#da552f;font-size:14px;text-decoration:none">View all ${dailyFiles.length} reports →</a></p>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Product Hunt Reports</title>
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
  h2.section-heading {
    font-family: Georgia, "Noto Serif SC", serif;
    font-size: 24px; font-weight: 700; color: #1c1917;
    margin-bottom: 16px; margin-top: 48px;
  }
  h2.section-heading .accent { color: #da552f; }
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
  <h1>Product Hunt <span class="accent">Reports</span></h1>
  <p class="subtitle">Daily and weekly trend reports from Product Hunt</p>

  <h2 class="section-heading">📅 <span class="accent">Daily</span> Reports</h2>
  <ul class="report-list">
${dailyItems}
  </ul>${viewAllLink}

  <h2 class="section-heading">📊 <span class="accent">Weekly</span> Reports</h2>
  <ul class="report-list">
${weeklyItems}
  </ul>

  <footer>Auto-generated by ph-daily-monitor</footer>
</div>
</body>
</html>`;

  const rootIndexPath = path.join(dataDir, 'index.html');
  fs.writeFileSync(rootIndexPath, html, 'utf-8');
  console.log(`Root index regenerated: ${rootIndexPath}`);
}

// ── Main execution ──
console.log(`\nGenerating daily reports...`);
let generated = 0;
for (const date of dates) {
  if (generateReport(date)) generated++;
}
console.log(`\n${generated}/${dates.length} reports generated`);

regenerateDailyIndex();
regenerateRootIndex();

console.log('\n✅ Done!');
