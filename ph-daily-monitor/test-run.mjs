#!/usr/bin/env node
/**
 * Standalone test script — replicates the n8n workflow logic.
 * Usage: node test-run.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env manually
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
const DISCORD_WEBHOOK = env.DISCORD_WEBHOOK_URL;

if (!PH_TOKEN) { console.error('Missing PRODUCTHUNT_API_TOKEN'); process.exit(1); }
if (!DEEPSEEK_KEY) { console.error('Missing DEEPSEEK_API_KEY'); process.exit(1); }
if (!DISCORD_WEBHOOK) { console.error('Missing DISCORD_WEBHOOK_URL'); process.exit(1); }

// Helper: use curl for HTTP requests (more reliable than Node fetch behind proxies)
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

// ── Step 1: Build Date Range ──
const now = new Date();
const yesterday = new Date(now);
yesterday.setUTCDate(now.getUTCDate() - 1);
const year = yesterday.getUTCFullYear();
const month = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
const day = String(yesterday.getUTCDate()).padStart(2, '0');
const dateLabel = `${year}-${month}-${day}`;
const postedAfter = `${dateLabel}T00:00:00Z`;
const postedBefore = `${dateLabel}T23:59:59Z`;
console.log(`[1/7] Date range: ${dateLabel} (${postedAfter} → ${postedBefore})`);

// ── Step 2: Product Hunt GraphQL API ──
// Split into 2 requests to stay under PH complexity limit (500K)
console.log('[2/7] Fetching from Product Hunt API...');
const query1 = `{ posts(order: VOTES, postedAfter: "${postedAfter}", postedBefore: "${postedBefore}", first: 20) { edges { node { id name slug tagline description website url votesCount commentsCount reviewsRating createdAt featuredAt thumbnail { url } user { name headline username twitterUsername } makers { name headline username twitterUsername } topics { edges { node { name slug } } } } } } }`;
const query2 = `{ posts(order: VOTES, postedAfter: "${postedAfter}", postedBefore: "${postedBefore}", after: "MjA", first: 30) { edges { node { id name slug tagline description website url votesCount commentsCount reviewsRating createdAt featuredAt thumbnail { url } topics { edges { node { name slug } } } } } } }`;

const phHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PH_TOKEN}` };

const ph1 = curlPost('https://api.producthunt.com/v2/api/graphql', phHeaders, { query: query1 });
if (ph1.statusCode !== 200) {
  console.error(`PH API error (page 1): ${ph1.statusCode} ${ph1.body.substring(0, 300)}`);
  process.exit(1);
}
const ph1Data = JSON.parse(ph1.body);
if (ph1Data.errors) {
  console.error(`PH GraphQL error: ${JSON.stringify(ph1Data.errors)}`);
  process.exit(1);
}
const edges1 = ph1Data?.data?.posts?.edges || [];
console.log(`   Page 1: ${edges1.length} products`);

// Page 2 (only if page 1 returned full 20)
let edges2 = [];
if (edges1.length >= 20) {
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
console.log(`   Total: ${allEdges.length} products`);

// ── Step 3: Process & Rank ──
console.log('[3/7] Processing & ranking...');
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
const top10 = products.slice(0, 15);
console.log(`   Top product: ${top10[0]?.name} (${top10[0]?.votesCount} votes)`);

// ── Step 4: Save Raw JSON ──
console.log('[4/7] Saving raw JSON...');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const rawPath = path.join(dataDir, `ph-raw-${dateLabel}.json`);
fs.writeFileSync(rawPath, JSON.stringify({ date: dateLabel, totalCount: products.length, products }, null, 2), 'utf-8');
console.log(`   Saved to ${rawPath}`);

// ── Step 5: Check empty ──
if (products.length === 0) {
  console.log('[5/7] No products found, sending empty notice...');
  curlPost(DISCORD_WEBHOOK, { 'Content-Type': 'application/json' },
    { username: 'PH Daily Monitor', content: `📭 **Product Hunt Daily Report — ${dateLabel}**\n\nNo products found for yesterday.` });
  console.log('Done (empty).');
  process.exit(0);
}

// ── Step 6: DeepSeek Analysis ──
console.log('[5/7] Calling DeepSeek for analysis...');
const aiInput = top10.map((p, i) => {
  const makers = p.makers.map(m => m.name).join(', ') || (p.maker?.name || 'Unknown');
  return `#${i + 1} ${p.name} | ${p.votesCount}票 ${p.commentsCount}评 | ${p.tagline} | ${p.description || ''} | Topics: ${p.topics.join(', ') || 'N/A'} | Makers: ${makers} | ${p.url}`;
}).join('\n');

// Build ranking list with medals for DeepSeek to annotate
const rankingList = top10.map((p, i) => {
  const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`${String(i + 1).padStart(2)}\``;
  return `${medal} **[${p.name}](${p.url})** · 🔺${p.votesCount}`;
}).join('\n');

const dsResult = curlPost('https://api.deepseek.com/chat/completions',
  { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
  {
    model: 'deepseek-chat',
    temperature: 0.7,
    max_tokens: 2500,
    messages: [
      { role: 'system', content: `You are a sharp tech product analyst writing a daily digest for indie hackers. Write in Chinese. Be extremely concise — every bullet is ONE sentence max. Use Discord markdown. When mentioning a product, always use [产品名](URL) hyperlink format.` },
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
  console.error(`DeepSeek API error ${dsResult.statusCode}: ${dsResult.body.substring(0, 300)}`);
  process.exit(1);
}

const dsData = JSON.parse(dsResult.body);
const analysis = dsData?.choices?.[0]?.message?.content || 'Analysis unavailable.';
console.log(`   Analysis received (${analysis.length} chars)`);

const analysisPath = path.join(dataDir, `ph-analysis-${dateLabel}.md`);
fs.writeFileSync(analysisPath, analysis, 'utf-8');
console.log(`   Saved to ${analysisPath}`);

// ── Step 7: Format & Send to Discord ──
console.log('[6/7] Formatting Discord messages...');

const MAX_LEN = 1900;
const messages = [];
const paragraphs = analysis.split('\n');
let currentChunk = '';
for (const para of paragraphs) {
  if ((currentChunk + '\n' + para).length > MAX_LEN) {
    if (currentChunk.trim()) messages.push(currentChunk.trim());
    if (para.length > MAX_LEN) {
      let remaining = para;
      while (remaining.length > MAX_LEN) { messages.push(remaining.substring(0, MAX_LEN)); remaining = remaining.substring(MAX_LEN); }
      currentChunk = remaining;
    } else {
      currentChunk = para;
    }
  } else {
    currentChunk += (currentChunk ? '\n' : '') + para;
  }
}
if (currentChunk.trim()) messages.push(currentChunk.trim());
messages.push(`-# 🤖 PH Daily Monitor · DeepSeek`);

console.log(`[7/7] Sending ${messages.length} messages to Discord...`);
for (let i = 0; i < messages.length; i++) {
  const res = curlPost(DISCORD_WEBHOOK, { 'Content-Type': 'application/json' },
    { username: 'PH Daily Monitor', content: messages[i] });

  if (res.statusCode === 429) {
    const retryAfter = JSON.parse(res.body).retry_after || 2;
    console.log(`   Rate limited, waiting ${retryAfter}s...`);
    execSync(`sleep ${Math.ceil(retryAfter)}`);
    i--; // retry
    continue;
  } else if (res.statusCode >= 400) {
    console.error(`   Discord error on msg ${i + 1}: ${res.statusCode} ${res.body.substring(0, 200)}`);
  } else {
    console.log(`   Sent message ${i + 1}/${messages.length}`);
  }
  // Small delay between messages to avoid rate limit
  if (i < messages.length - 1) execSync('sleep 1');
}

console.log('\n✅ Done! Check your Discord channel.');
