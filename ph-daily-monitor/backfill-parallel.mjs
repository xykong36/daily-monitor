#!/usr/bin/env node
/**
 * Parallel backfill script — fetch PH data + DeepSeek analysis for a date range.
 * Usage: node backfill-parallel.mjs --from 2026-01-01 --to 2026-03-31 --concurrency 5
 *        node backfill-parallel.mjs --from 2026-01-01 --to 2026-01-07 --force
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
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
function getArg(name, defaultVal) {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}
const fromDate = getArg('--from', null);
const toDate = getArg('--to', null);
const concurrency = parseInt(getArg('--concurrency', '5'), 10);
const force = args.includes('--force');

if (!fromDate || !toDate) {
  console.error('Usage: node backfill-parallel.mjs --from YYYY-MM-DD --to YYYY-MM-DD [--concurrency N] [--force]');
  process.exit(1);
}

// ── Generate date range ──
function generateDates(from, to) {
  const dates = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const allDates = generateDates(fromDate, toDate);

// ── Filter to dates that need work ──
const datesToProcess = allDates.filter(dateLabel => {
  if (force) return true;
  const rawPath = path.join(dataDir, `ph-raw-${dateLabel}.json`);
  const analysisPath = path.join(dataDir, `ph-analysis-${dateLabel}.md`);
  return !(fs.existsSync(rawPath) && fs.existsSync(analysisPath));
});

console.log(`Date range: ${fromDate} ~ ${toDate} (${allDates.length} dates total)`);
console.log(`To process: ${datesToProcess.length} dates (skipping ${allDates.length - datesToProcess.length} with existing data)`);
console.log(`Concurrency: ${concurrency} | Force: ${force}\n`);

if (datesToProcess.length === 0) {
  console.log('Nothing to do — all dates already have data.');
  process.exit(0);
}

// ── PH API adaptive rate limiter ──
// Baseline: 2.1s between calls (~28/min, safe under 450/15min).
// Adapts using X-Rate-Limit-* response headers from PH API.
let phLastCallTime = 0;
let phMinIntervalMs = 2100;
let phRateRemaining = null;
let phRateLimit = null;
let phRateResetSec = null;

function parseRateLimitHeaders(headerFile) {
  if (!fs.existsSync(headerFile)) return null;
  const raw = fs.readFileSync(headerFile, 'utf-8');
  const limit = raw.match(/X-Rate-Limit-Limit:\s*(\d+)/i);
  const remaining = raw.match(/X-Rate-Limit-Remaining:\s*(\d+)/i);
  const reset = raw.match(/X-Rate-Limit-Reset:\s*(\d+)/i);
  return {
    limit: limit ? parseInt(limit[1]) : null,
    remaining: remaining ? parseInt(remaining[1]) : null,
    reset: reset ? parseInt(reset[1]) : null,
  };
}

function updateRateState(rateLimits) {
  if (!rateLimits) return;
  if (rateLimits.remaining !== null) phRateRemaining = rateLimits.remaining;
  if (rateLimits.limit !== null) phRateLimit = rateLimits.limit;
  if (rateLimits.reset !== null) phRateResetSec = rateLimits.reset;

  // Adaptive interval
  if (phRateRemaining !== null) {
    if (phRateRemaining < 50) {
      phMinIntervalMs = -1; // signal: hard pause until reset
    } else if (phRateRemaining < 200) {
      phMinIntervalMs = 4000;
    } else {
      phMinIntervalMs = 2100;
    }
  }
}

async function phRateLimitedCall(url, headers, body, tmpFile) {
  // Hard pause if remaining < 50
  if (phMinIntervalMs === -1 && phRateResetSec !== null) {
    const sleepMs = (phRateResetSec + 2) * 1000;
    console.log(`    🛑 PH quota critically low (${phRateRemaining}/${phRateLimit}), sleeping ${phRateResetSec + 2}s until reset...`);
    await new Promise(r => setTimeout(r, sleepMs));
    phMinIntervalMs = 2100; // reset to baseline after sleeping
  }

  // Enforce minimum gap
  const now = Date.now();
  const wait = phMinIntervalMs - (now - phLastCallTime);
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
  phLastCallTime = Date.now();

  const result = await curlPostAsync(url, headers, body, tmpFile, true);

  // Parse rate limit headers and update state
  if (result.rateLimits) {
    updateRateState(result.rateLimits);
    console.log(`    📊 PH quota: ${phRateRemaining ?? '?'}/${phRateLimit ?? '?'} remaining, resets in ${phRateResetSec ?? '?'}s (interval: ${phMinIntervalMs}ms)`);
  }

  // On 429: sleep until reset and retry once
  if (result.statusCode === 429) {
    const sleepSec = (phRateResetSec || 60) + 2;
    console.log(`    ⚠️ 429 rate limited! Sleeping ${sleepSec}s then retrying...`);
    await new Promise(r => setTimeout(r, sleepSec * 1000));
    phLastCallTime = Date.now();
    phMinIntervalMs = 2100;
    return curlPostAsync(url, headers, body, tmpFile, true);
  }

  return result;
}

// ── Async curl helper ──
const phHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PH_TOKEN}` };

async function curlPostAsync(url, headers, body, tmpFile, captureHeaders = false) {
  const headerArgs = Object.entries(headers).map(([k, v]) => `-H '${k}: ${v}'`).join(' ');
  fs.writeFileSync(tmpFile, typeof body === 'string' ? body : JSON.stringify(body));
  const headerFile = captureHeaders ? tmpFile + '.headers' : null;
  try {
    const dumpFlag = headerFile ? `-D '${headerFile}'` : '';
    const { stdout } = await execAsync(
      `curl -s ${dumpFlag} -w '\\n__HTTP_STATUS__%{http_code}' -X POST ${headerArgs} -d @${tmpFile} '${url}'`,
      { maxBuffer: 10 * 1024 * 1024, timeout: 120000 }
    );
    const statusMatch = stdout.match(/__HTTP_STATUS__(\d+)$/);
    const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
    const responseBody = stdout.replace(/__HTTP_STATUS__\d+$/, '');
    const rateLimits = headerFile ? parseRateLimitHeaders(headerFile) : null;
    return { statusCode, body: responseBody, rateLimits };
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    if (headerFile && fs.existsSync(headerFile)) fs.unlinkSync(headerFile);
  }
}

// ── Process a single date ──
async function processDate(dateLabel) {
  const rawPath = path.join(dataDir, `ph-raw-${dateLabel}.json`);
  const analysisPath = path.join(dataDir, `ph-analysis-${dateLabel}.md`);
  const tmpFile = path.join(__dirname, `.tmp-body-${dateLabel}.json`);

  // Phase 1: Fetch PH data (skip if raw exists and we only need analysis)
  let products;
  const rawExists = fs.existsSync(rawPath);
  const analysisExists = fs.existsSync(analysisPath);

  if (!force && rawExists) {
    // Raw exists, just load it
    const data = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
    products = data.products || [];
  } else {
    // Fetch from PH API
    const postedAfter = `${dateLabel}T00:00:00Z`;
    const postedBefore = `${dateLabel}T23:59:59Z`;

    const query1 = `{ posts(order: VOTES, postedAfter: "${postedAfter}", postedBefore: "${postedBefore}", first: 20) { edges { node { id name slug tagline description website url votesCount commentsCount reviewsRating createdAt featuredAt thumbnail { url } user { name headline username twitterUsername } makers { name headline username twitterUsername } topics { edges { node { name slug } } } } } } }`;
    const query2 = `{ posts(order: VOTES, postedAfter: "${postedAfter}", postedBefore: "${postedBefore}", after: "MjA", first: 30) { edges { node { id name slug tagline description website url votesCount commentsCount reviewsRating createdAt featuredAt thumbnail { url } topics { edges { node { name slug } } } } } } }`;

    const ph1 = await phRateLimitedCall('https://api.producthunt.com/v2/api/graphql', phHeaders, { query: query1 }, tmpFile);
    if (ph1.statusCode !== 200) {
      return { date: dateLabel, status: 'error', msg: `PH API error (page 1): ${ph1.statusCode}` };
    }
    const ph1Data = JSON.parse(ph1.body);
    if (ph1Data.errors) {
      return { date: dateLabel, status: 'error', msg: `PH GraphQL error: ${JSON.stringify(ph1Data.errors)}` };
    }
    const edges1 = ph1Data?.data?.posts?.edges || [];

    let edges2 = [];
    if (edges1.length >= 20) {
      const ph2 = await phRateLimitedCall('https://api.producthunt.com/v2/api/graphql', phHeaders, { query: query2 }, tmpFile);
      if (ph2.statusCode === 200) {
        const ph2Data = JSON.parse(ph2.body);
        if (!ph2Data.errors) {
          edges2 = ph2Data?.data?.posts?.edges || [];
        }
      }
    }

    const allEdges = [...edges1, ...edges2];
    products = allEdges.map(edge => {
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

    fs.writeFileSync(rawPath, JSON.stringify({ date: dateLabel, totalCount: products.length, products }, null, 2), 'utf-8');
  }

  // Phase 2: DeepSeek analysis (skip if analysis exists)
  if (!force && analysisExists) {
    return { date: dateLabel, status: 'skipped-analysis', products: products.length };
  }

  if (products.length === 0) {
    fs.writeFileSync(analysisPath, `# PH Daily — ${dateLabel}\n\nNo products found.\n`, 'utf-8');
    return { date: dateLabel, status: 'ok', products: 0 };
  }

  const top15 = products.slice(0, 15);
  const aiInput = top15.map((p, i) => {
    const makers = p.makers.map(m => m.name).join(', ') || (p.maker?.name || 'Unknown');
    return `#${i + 1} ${p.name} | ${p.votesCount}票 ${p.commentsCount}评 | ${p.tagline} | ${p.description || ''} | Topics: ${p.topics.join(', ') || 'N/A'} | Makers: ${makers} | ${p.url}`;
  }).join('\n');

  const rankingList = top15.map((p, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`${String(i + 1).padStart(2)}\``;
    return `${medal} **[${p.name}](${p.url})** · 🔺${p.votesCount}`;
  }).join('\n');

  const dsResult = await curlPostAsync('https://api.deepseek.com/chat/completions',
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
    },
    tmpFile
  );

  if (dsResult.statusCode !== 200) {
    fs.writeFileSync(analysisPath, `# PH Daily — ${dateLabel}\n\nDeepSeek analysis failed (${dsResult.statusCode}).\n`, 'utf-8');
    return { date: dateLabel, status: 'ds-error', products: products.length, msg: `DeepSeek ${dsResult.statusCode}` };
  }

  const dsData = JSON.parse(dsResult.body);
  const analysis = dsData?.choices?.[0]?.message?.content || 'Analysis unavailable.';
  fs.writeFileSync(analysisPath, analysis, 'utf-8');
  return { date: dateLabel, status: 'ok', products: products.length, analysisLen: analysis.length };
}

// ── Concurrency pool ──
async function runPool(items, concurrencyLimit, fn) {
  let completed = 0;
  const total = items.length;
  const results = [];
  const executing = new Set();

  for (const item of items) {
    const p = fn(item).then(result => {
      completed++;
      const pct = Math.round((completed / total) * 100);
      const statusIcon = result.status === 'ok' ? '✓' : result.status === 'error' || result.status === 'ds-error' ? '✗' : '○';
      console.log(`  [${String(completed).padStart(3)}/${total}] ${statusIcon} ${result.date} — ${result.status}${result.products !== undefined ? ` (${result.products} products)` : ''}${result.msg ? ` ${result.msg}` : ''}`);
      executing.delete(p);
      return result;
    });
    results.push(p);
    executing.add(p);

    if (executing.size >= concurrencyLimit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// ── Main ──
const startTime = Date.now();
console.log('Starting parallel backfill...\n');

const results = await runPool(datesToProcess, concurrency, processDate);

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
const ok = results.filter(r => r.status === 'ok').length;
const errors = results.filter(r => r.status === 'error' || r.status === 'ds-error').length;
const skipped = results.filter(r => r.status === 'skipped-analysis').length;

console.log(`\n── Done in ${elapsed}s ──`);
console.log(`  OK: ${ok} | Errors: ${errors} | Partial skip: ${skipped}`);
if (errors > 0) {
  console.log('\nFailed dates:');
  for (const r of results.filter(r => r.status === 'error' || r.status === 'ds-error')) {
    console.log(`  ${r.date}: ${r.msg}`);
  }
}
