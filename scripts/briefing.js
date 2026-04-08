const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;

async function notionQuery(databaseId) {
  const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      sorts: [{ property: 'Publish Date', direction: 'ascending' }],
    }),
  });
  if (!res.ok) throw new Error(`Notion API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sendToSlack(blocks) {
  const res = await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  });
  if (!res.ok) throw new Error(`Slack error ${res.status}: ${await res.text()}`);
}

function getDateString(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
}

function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function getStatusEmoji(status) {
  const map = {
    'Idea': '💡',
    'Script / Copy in progress': '✍️',
    'Visual in progress': '🎨',
    'Ready to Schedule': '✅',
    'Scheduled': '📅',
    'Live': '🟢',
  };
  return map[status] || '⬜';
}

function getFormatEmoji(format) {
  const map = {
    'Video — Use Case': '🎬',
    'Video — Feature Demo': '🎥',
    'Carousel': '📊',
    'Single Image': '🖼️',
    'Text Only': '📝',
    'Newsletter': '📧',
  };
  return map[format] || '📄';
}

// Uses custom Slack emoji — upload :linkedin: and :x-logo: in your workspace
function getPlatformLabel(platform) {
  const map = {
    'LinkedIn': ':linkedin: LinkedIn',
    'Twitter/X': ':x-logo: Twitter/X',
    'Pinterest': '📌 Pinterest',
    'YouTube': '▶️ YouTube',
    'Dev.to': '👨‍💻 Dev.to',
    'Tumblr': '📓 Tumblr',
    'Hashnode': '🔷 Hashnode',
    'Substack': '📧 Substack',
  };
  return map[platform] || `🌐 ${platform}`;
}

function getProp(page, name) {
  const prop = page.properties[name];
  if (!prop) return null;
  if (prop.type === 'title') return prop.title?.[0]?.plain_text || null;
  if (prop.type === 'select') return prop.select?.name || null;
  if (prop.type === 'multi_select') return prop.multi_select?.map(o => o.name) || [];
  if (prop.type === 'date') return prop.date?.start || null;
  if (prop.type === 'url') return prop.url || null;
  if (prop.type === 'rich_text') return prop.rich_text?.[0]?.plain_text || null;
  return null;
}

function getPropStr(page, name) {
  const val = getProp(page, name);
  return Array.isArray(val) ? val.join(', ') : val;
}

function isNewsletter(page) {
  const format = getPropStr(page, 'Post Format');
  const type = getPropStr(page, 'Post Type');
  return format === 'Newsletter' || type === 'Newsletter';
}

function normalizeImageUrl(url) {
  if (!url) return null;
  const m = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (m) return `https://drive.google.com/uc?export=view&id=${m[1]}`;
  if (url.includes('dropbox.com')) return url.replace('?dl=0', '?raw=1').replace('?dl=1', '?raw=1');
  return url;
}

function isImageUrl(url) {
  if (!url) return false;
  return url.includes('drive.google.com') ||
    url.includes('dropbox.com') ||
    Boolean(url.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i));
}

// ─── BLOCK BUILDERS ──────────────────────────────────────────────────────────

function buildNewsletterBlock(page, showCopy = false) {
  const title = getPropStr(page, 'Post Title');
  const status = getPropStr(page, 'Status');
  const assetLink = getPropStr(page, 'Asset Link');
  const pageUrl = page.url;
  const blocks = [];

  let text = `📧 *Newsletter*  ·  ${getFormatEmoji('Newsletter')} Newsletter\n`;
  text += `*<${pageUrl}|${title}>*\n`;
  text += `${getStatusEmoji(status)} ${status}`;
  if (assetLink) text += `\n🔗 <${assetLink}|View asset>`;
  if (showCopy) text += `\n📋 <${pageUrl}|Open Notion for newsletter copy>`;

  blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  return blocks;
}

function buildPlatformBlock(page, platform, showCopy = false) {
  const title = getPropStr(page, 'Post Title');
  const publishDate = getPropStr(page, 'Publish Date');
  const status = getPropStr(page, 'Status');
  const format = getPropStr(page, 'Post Format');
  const assetLink = getPropStr(page, 'Asset Link');
  const pageUrl = page.url;
  const imageUrl = normalizeImageUrl(assetLink);
  const blocks = [];

  let text = `${getPlatformLabel(platform)}  ·  ${getFormatEmoji(format)} ${format}\n`;
  text += `*<${pageUrl}|${title}>*\n`;
  text += `${getStatusEmoji(status)} ${status}  ·  📅 *${formatDateShort(publishDate)}*`;
  if (assetLink && !isImageUrl(assetLink)) text += `\n🔗 <${assetLink}|View asset>`;
  if (showCopy) text += `\n📋 <${pageUrl}|Open Notion for copy>  ·  _Update status in page_`;

  blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });

  // Show image on LinkedIn only to avoid repetition
  if (platform === 'LinkedIn' && imageUrl && isImageUrl(assetLink)) {
    blocks.push({ type: 'image', image_url: imageUrl, alt_text: title });
  }

  return blocks;
}

function buildYesterdayBlock(page) {
  const title = getPropStr(page, 'Post Title');
  const status = getPropStr(page, 'Status');
  const format = getPropStr(page, 'Post Format');
  const pageUrl = page.url;
  const newsletter = isNewsletter(page);
  const platforms = getProp(page, 'Platform');
  const blocks = [];

  if (newsletter) {
    let text = `📧 *Newsletter*\n`;
    text += `*<${pageUrl}|${title}>*\n`;
    text += `${getStatusEmoji(status)} Current status: *${status}*\n`;
    text += `_If sent: open Notion → mark as *Live*_`;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  } else {
    const platformList = Array.isArray(platforms) && platforms.length > 0 ? platforms : ['LinkedIn'];
    platformList.forEach(platform => {
      let text = `${getPlatformLabel(platform)}  ·  ${getFormatEmoji(format)} ${format}\n`;
      text += `*<${pageUrl}|${title}>*\n`;
      text += `${getStatusEmoji(status)} Current status: *${status}*\n`;
      text += `_If live: open Notion → mark as *Live*_\n`;
      text += `👉 <${pageUrl}|Open page to update status>`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
    });
  }

  return blocks;
}

function buildPostBlocks(page, showCopy = false) {
  if (isNewsletter(page)) return buildNewsletterBlock(page, showCopy);
  const platforms = getProp(page, 'Platform');
  const platformList = Array.isArray(platforms) && platforms.length > 0 ? platforms : ['LinkedIn'];
  const blocks = [];
  platformList.forEach(platform => {
    buildPlatformBlock(page, platform, showCopy).forEach(b => blocks.push(b));
  });
  return blocks;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const yesterday = getDateString(-1);
  const today = getDateString(0);
  const tomorrow = getDateString(1);

  const data = await notionQuery(DATABASE_ID);
  const all = data.results.filter(p => getPropStr(p, 'Publish Date') !== null);

  // Section 1 — Yesterday posts not marked Live
  const yesterdayPosts = all.filter(p => {
    const date = getPropStr(p, 'Publish Date');
    const status = getPropStr(p, 'Status');
    return date === yesterday && status !== 'Live';
  });

  // Section 2 — Today posts Ready to Schedule or Scheduled
  const todayPosts = all.filter(p => {
    const date = getPropStr(p, 'Publish Date');
    const status = getPropStr(p, 'Status');
    return date === today && ['Ready to Schedule', 'Scheduled'].includes(status);
  });

  // Section 3 — Tomorrow posts Ready to Schedule or Scheduled
  const tomorrowPosts = all.filter(p => {
    const date = getPropStr(p, 'Publish Date');
    const status = getPropStr(p, 'Status');
    return date === tomorrow && ['Ready to Schedule', 'Scheduled'].includes(status);
  });

  const hasContent = yesterdayPosts.length > 0 || todayPosts.length > 0 || tomorrowPosts.length > 0;

  if (!hasContent) {
    console.log('Nothing to report. No briefing sent.');
    return;
  }

  const blocks = [];

  // ── HEADER ──
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '📋 JetStack Content Briefing', emoji: true },
  });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `*${formatDate(today)}*` }],
  });
  blocks.push({ type: 'divider' });

  // ── SECTION 1: YESTERDAY ──
  if (yesterdayPosts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*🔍 Yesterday — did these go live?*' },
    });
    yesterdayPosts.forEach(p => buildYesterdayBlock(p).forEach(b => blocks.push(b)));
    blocks.push({ type: 'divider' });
  }

  // ── SECTION 2: TODAY ──
  if (todayPosts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*🚀 Going live today*' },
    });
    todayPosts.forEach(p => buildPostBlocks(p, true).forEach(b => blocks.push(b)));
    blocks.push({ type: 'divider' });
  } else {
    // Warn on posting days (Mon/Tue/Wed/Fri)
    const day = new Date().getDay();
    if ([1, 2, 3, 5].includes(day)) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*⚠️ Nothing scheduled for today*\nCheck the calendar.' },
      });
      blocks.push({ type: 'divider' });
    }
  }

  // ── SECTION 3: TOMORROW ──
  if (tomorrowPosts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📆 Tomorrow — ${formatDateShort(tomorrow)}*` },
    });
    tomorrowPosts.forEach(p => buildPostBlocks(p, true).forEach(b => blocks.push(b)));
    blocks.push({ type: 'divider' });
  }

  // ── FOOTER ──
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '<https://notion.so/9364b4cebdbc4450a6324e3b2ad454a8|Open Calendar>  ·  _To mark a post Live: open Notion page → change Status_',
    }],
  });

  await sendToSlack(blocks);
  console.log(`Briefing sent. Yesterday: ${yesterdayPosts.length}. Today: ${todayPosts.length}. Tomorrow: ${tomorrowPosts.length}.`);
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
