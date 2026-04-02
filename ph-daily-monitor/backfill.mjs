#!/usr/bin/env node
/**
 * Backfill script — fetch PH data + DeepSeek analysis for historical dates.
 * Usage: node backfill.mjs 2026-03-07 2026-03-08
 *        node backfill.mjs --force 2026-03-07   (overwrite existing files)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const PH_TOKEN = env.PRODUCTHUNT_API_TOKEN;
const DEEPSEEK_KEY = env.DEEPSEEK_API_KEY;
if (!PH_TOKEN) { console.error('Missing PRODUCTHUNT_API_TOKEN'); process.exit(1); }
if (!DEEPSEEK_KEY) { console.error('Missing DEEPSEEK_API_KEY'); process.exit(1); }

// ── Parse CLI args ──
const args = process.argv.slice(2);
const force = args.includes('--force');
const dates = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

if (dates.length === 0) {
  console.error('Usage: node backfill.mjs [--force] YYYY-MM-DD [YYYY-MM-DD ...]');
  process.exit(1);
}

// ── Helpers ──
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

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const phHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PH_TOKEN}` };

console.log(`Backfill: ${dates.length} date(s) | force=${force}\n`);

// ── Process each date sequentially ──
for (let di = 0; di < dates.length; di++) {
  const dateLabel = dates[di];
  const rawPath = path.join(dataDir, `ph-raw-${dateLabel}.json`);
  const analysisPath = path.join(dataDir, `ph-analysis-${dateLabel}.md`);

  console.log(`── [${di + 1}/${dates.length}] ${dateLabel} ──`);

  // Skip if both files exist (unless --force)
  if (!force && fs.existsSync(rawPath) && fs.existsSync(analysisPath)) {
    console.log('   Skipped (files exist, use --force to overwrite)\n');
    continue;
  }

  // ── Fetch PH data ──
  const postedAfter = `${dateLabel}T00:00:00Z`;
  const postedBefore = `${dateLabel}T23:59:59Z`;

  const query1 = `{ posts(order: VOTES, postedAfter: "${postedAfter}", postedBefore: "${postedBefore}", first: 20) { edges { node { id name slug tagline description website url votesCount commentsCount reviewsRating createdAt featuredAt thumbnail { url } user { name headline username twitterUsername } makers { name headline username twitterUsername } topics { edges { node { name slug } } } } } } }`;
  const query2 = `{ posts(order: VOTES, postedAfter: "${postedAfter}", postedBefore: "${postedBefore}", after: "MjA", first: 30) { edges { node { id name slug tagline description website url votesCount commentsCount reviewsRating createdAt featuredAt thumbnail { url } topics { edges { node { name slug } } } } } } }`;

  console.log('   Fetching PH page 1...');
  const ph1 = curlPost('https://api.producthunt.com/v2/api/graphql', phHeaders, { query: query1 });
  if (ph1.statusCode !== 200) {
    console.error(`   PH API error (page 1): ${ph1.statusCode} ${ph1.body.substring(0, 300)}`);
    continue;
  }
  const ph1Data = JSON.parse(ph1.body);
  if (ph1Data.errors) {
    console.error(`   PH GraphQL error: ${JSON.stringify(ph1Data.errors)}`);
    continue;
  }
  const edges1 = ph1Data?.data?.posts?.edges || [];
  console.log(`   Page 1: ${edges1.length} products`);

  let edges2 = [];
  if (edges1.length >= 20) {
    console.log('   Fetching PH page 2...');
    const ph2 = curlPost('https://api.producthunt.com/v2/api/graphql', phHeaders, { query: query2 });
    if (ph2.statusCode === 200) {
      const ph2Data = JSON.parse(ph2.body);
      if (!ph2Data.errors) {
        edges2 = ph2Data?.data?.posts?.edges || [];
        console.log(`   Page 2: ${edges2.length} products`);
      }
    }
  }

  const allEdges = [...edges1, ...edges2];

  // ── Process & rank ──
  const products = allEdges.map(edge => {
    const p = edge.node;
    return {
      id: p.id, name: p.name, slug: p.slug,
      tagline: p.tagline, description: p.description,
      website: p.website,
      url: p.url || `https://www.producthunt.com/posts/${p.slug}`,
      votesCount: p.votesCount || 0,
      commentsCount: p.commentsCount || 0,
      reviewsRating: p.reviewsRating || 0,
      createdAt: p.createdAt, featuredAt: p.featuredAt,
      thumbnail: p.thumbnail?.url || '',
      maker: p.user ? { name: p.user.name, headline: p.user.headline, username: p.user.username, twitter: p.user.twitterUsername } : null,
      makers: (p.makers || []).map(m => ({ name: m.name, headline: m.headline, username: m.username, twitter: m.twitterUsername })),
      topics: (p.topics?.edges || []).map(t => t.node.name),
    };
  });
  products.sort((a, b) => b.votesCount - a.votesCount);

  // ── Save raw JSON ──
  fs.writeFileSync(rawPath, JSON.stringify({ date: dateLabel, totalCount: products.length, products }, null, 2), 'utf-8');
  console.log(`   Saved ${rawPath} (${products.length} products)`);

  if (products.length === 0) {
    fs.writeFileSync(analysisPath, `# PH Daily — ${dateLabel}\n\nNo products found.\n`, 'utf-8');
    console.log(`   No products, skipping DeepSeek.\n`);
    if (di < dates.length - 1) execSync('sleep 2');
    continue;
  }

  // ── DeepSeek analysis ──
  const top15 = products.slice(0, 15);
  const aiInput = top15.map((p, i) => {
    const makers = p.makers.map(m => m.name).join(', ') || (p.maker?.name || 'Unknown');
    return `#${i + 1} ${p.name} | ${p.votesCount}票 ${p.commentsCount}评 | ${p.tagline} | ${p.description || ''} | Topics: ${p.topics.join(', ') || 'N/A'} | Makers: ${makers} | ${p.url}`;
  }).join('\n');

  const rankingList = top15.map((p, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`${String(i + 1).padStart(2)}\``;
    return `${medal} **[${p.name}](${p.url})** · 🔺${p.votesCount}`;
  }).join('\n');

  console.log('   Calling DeepSeek...');
  const dsResult = curlPost('https://api.deepseek.com/chat/completions',
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
    {
      model: 'deepseek-chat',
      temperature: 0.7,
      max_tokens: 2500,
      messages: [
        { role: 'system', content: `You are a sharp tech product analyst writing a daily digest for indie hackers. Write in Chinese. Be extremely concise — every bullet is ONE sentence max. Use markdown. When mentioning a product, always use [产品名](URL) hyperlink format.` },
        { role: 'user', content: `分析 ${dateLabel} 的 Product Hunt 发布（共 ${products.length} 个产品）。严格按以下格式输出：

# 🚀 PH Daily — ${dateLabel}  (${products.length} products)

（下面列出 Top 15，每个产品占一行，格式严格为：
奖牌/序号 **[产品名](URL)** · 🔺票数
一句中文说明这个产品到底是做什么的（不超过20字，让读者一眼判断是否感兴趣）

以下是排名和链接，请在每行后面换行追加中文摘要：
${rankingList}

---

**🔥 值得关注**
（从 Top 15 中挑最多 5 个最有意思的，每个一句话点评为什么值得关注，用 [产品名](URL) 格式）

**📈 趋势信号**
（3-4 个 bullet，每个一句话，提炼今天的技术/市场趋势）

**⚔️ 竞品对照**
（挑 3-5 个产品，各用一句话对比其成熟竞品，点明创新点和被认可的原因，格式：[新产品](URL) vs 竞品名 — 差异点）

**🛠 Builder 启示**
（3-4 个 bullet，每个一句话，给独立开发者的可执行建议）

产品原始数据（供你理解产品用途）：
${aiInput}` },
      ],
    }
  );

  if (dsResult.statusCode !== 200) {
    console.error(`   DeepSeek error ${dsResult.statusCode}: ${dsResult.body.substring(0, 300)}`);
    fs.writeFileSync(analysisPath, `# PH Daily — ${dateLabel}\n\nDeepSeek analysis failed (${dsResult.statusCode}).\n`, 'utf-8');
  } else {
    const dsData = JSON.parse(dsResult.body);
    const analysis = dsData?.choices?.[0]?.message?.content || 'Analysis unavailable.';
    fs.writeFileSync(analysisPath, analysis, 'utf-8');
    console.log(`   Saved ${analysisPath} (${analysis.length} chars)`);
  }

  console.log('');

  // Delay between dates to avoid rate limits
  if (di < dates.length - 1) {
    console.log('   Waiting 2s...');
    execSync('sleep 2');
  }
}

console.log('Backfill complete.');
