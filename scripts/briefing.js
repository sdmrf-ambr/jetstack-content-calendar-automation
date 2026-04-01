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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function sendToSlack(blocks) {
  const res = await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack error ${res.status}: ${text}`);
  }
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
  };
  return map[format] || '📄';
}

function getPlatformEmoji(platform) {
  const map = {
    'LinkedIn': '💼',
    'Twitter/X': '🐦',
    'Pinterest': '📌',
    'YouTube': '▶️',
    'Dev.to': '👨‍💻',
    'Tumblr': '📓',
    'Hashnode': '🔷',
  };
  return map[platform] || '🌐';
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

function getPropString(page, name) {
  const val = getProp(page, name);
  if (Array.isArray(val)) return val.join(', ');
  return val;
}

function normalizeImageUrl(url) {
  if (!url) return null;
  const driveMatch = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (driveMatch) return `https://drive.google.com/uc?export=view&id=${driveMatch[1]}`;
  if (url.includes('dropbox.com')) return url.replace('?dl=0', '?raw=1').replace('?dl=1', '?raw=1');
  return url;
}

function isImageUrl(url) {
  if (!url) return false;
  return (
    url.includes('drive.google.com') ||
    url.includes('dropbox.com') ||
    Boolean(url.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i))
  );
}

// Expand one Notion row into one entry per platform
function expandByPlatform(page) {
  const platforms = getProp(page, 'Platform');
  const platformList = Array.isArray(platforms) && platforms.length > 0
    ? platforms
    : ['LinkedIn'];

  return platformList.map(platform => ({ page, platform }));
}

// Build Slack blocks for a single platform entry
function buildPlatformBlock(page, platform, showCopyLink = false) {
  const title = getPropString(page, 'Post Title');
  const publishDate = getPropString(page, 'Publish Date');
  const visualDueDate = getPropString(page, 'Visual Due Date');
  const status = getPropString(page, 'Status');
  const format = getPropString(page, 'Post Format');
  const assetLink = getPropString(page, 'Asset Link');
  const backupPost = getPropString(page, 'Backup Post');
  const pageUrl = page.url;
  const imageUrl = normalizeImageUrl(assetLink);
  const postBlocks = [];

  const platformEmoji = getPlatformEmoji(platform);
  const formatEmoji = getFormatEmoji(format);
  const statusEmoji = getStatusEmoji(status);

  let text = `${platformEmoji} *${platform}*  ·  ${formatEmoji} ${format}\n`;
  text += `*<${pageUrl}|${title}>*\n`;
  text += `${statusEmoji} ${status}`;
  text += `  ·  📅 *${formatDateShort(publishDate)}*`;
  if (visualDueDate) text += `  ·  🎨 Visual: *${formatDateShort(visualDueDate)}*`;
  if (assetLink && !isImageUrl(assetLink)) text += `\n🔗 <${assetLink}|View asset>`;
  if (backupPost) text += `\n⚠️ Backup: ${backupPost}`;

  postBlocks.push({ type: 'section', text: { type: 'mrkdwn', text } });

  // Show image inline for today and tomorrow on LinkedIn
  if (platform === 'LinkedIn' && imageUrl && isImageUrl(assetLink)) {
    postBlocks.push({ type: 'image', image_url: imageUrl, alt_text: title });
  }

  // Show copy link for today and tomorrow
  if (showCopyLink) {
    postBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📋 <${pageUrl}|Open Notion for ${platform} copy>  ·  _Update status in the page_`,
      },
    });
  }

  return postBlocks;
}

async function main() {
  const yesterday = getDateString(-1);
  const today = getDateString(0);
  const tomorrow = getDateString(1);
  const dayAfter = getDateString(2);
  const in7d = getDateString(7);

  const data = await notionQuery(DATABASE_ID);
  const allPosts = data.results.filter(p => getPropString(p, 'Publish Date') !== null);

  // Yesterday's posts not marked Live
  const yesterdayPosts = allPosts.filter(p => {
    const date = getPropString(p, 'Publish Date');
    const status = getPropString(p, 'Status');
    return date === yesterday && status !== 'Live';
  });

  // Today's posts
  const todayPosts = allPosts.filter(p => {
    const date = getPropString(p, 'Publish Date');
    const status = getPropString(p, 'Status');
    return date === today && ['Ready to Schedule', 'Scheduled'].includes(status);
  });

  // Tomorrow's posts
  const tomorrowPosts = allPosts.filter(p => {
    const date = getPropString(p, 'Publish Date');
    const status = getPropString(p, 'Status');
    return date === tomorrow && ['Ready to Schedule', 'Scheduled'].includes(status);
  });

  // Day after tomorrow
  const dayAfterPosts = allPosts.filter(p => {
    const date = getPropString(p, 'Publish Date');
    const status = getPropString(p, 'Status');
    return date === dayAfter && ['Ready to Schedule', 'Scheduled'].includes(status);
  });

  // Behind schedule
  const behindPosts = allPosts.filter(p => {
    const date = getPropString(p, 'Publish Date');
    const status = getPropString(p, 'Status');
    return date >= today && date <= in7d &&
      ['Idea', 'Script / Copy in progress', 'Visual in progress'].includes(status);
  });

  const hasContent =
    yesterdayPosts.length > 0 ||
    todayPosts.length > 0 ||
    tomorrowPosts.length > 0 ||
    dayAfterPosts.length > 0 ||
    behindPosts.length > 0;

  if (!hasContent) {
    console.log('Nothing to report. No briefing sent.');
    return;
  }

  const blocks = [];

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '📋 JetStack Content Briefing', emoji: true },
  });

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `*${formatDate(today)}*  —  Daily calendar check` }],
  });

  blocks.push({ type: 'divider' });

  // YESTERDAY CHECK
  if (yesterdayPosts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*🔍 Yesterday — did these go live?*' },
    });

    yesterdayPosts.forEach(p => {
      const entries = expandByPlatform(p);
      entries.forEach(({ page, platform }) => {
        const title = getPropString(page, 'Post Title');
        const status = getPropString(page, 'Status');
        const format = getPropString(page, 'Post Format');
        const pageUrl = page.url;
        const platformEmoji = getPlatformEmoji(platform);

        const text =
          `${platformEmoji} *${platform}*  ·  ${getFormatEmoji(format)} ${format}\n` +
          `*<${pageUrl}|${title}>*\n` +
          `${getStatusEmoji(status)} Current status: *${status}*\n` +
          `_If live: open page in Notion → mark as *Live*_`;

        blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
      });
    });

    blocks.push({ type: 'divider' });
  }

  // TODAY
  if (todayPosts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*🚀 Going live today*' },
    });

    todayPosts.forEach(p => {
      const entries = expandByPlatform(p);
      entries.forEach(({ page, platform }) => {
        buildPlatformBlock(page, platform, true).forEach(b => blocks.push(b));
      });
    });

    blocks.push({ type: 'divider' });
  }

  // No posts today warning on posting days
  if (todayPosts.length === 0 && yesterdayPosts.length === 0) {
    const dayOfWeek = new Date().getDay();
    if ([1, 3, 5].includes(dayOfWeek)) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*⚠️ Nothing scheduled for today*\nCheck the calendar — a post may be missing or not yet Scheduled.` },
      });
      blocks.push({ type: 'divider' });
    }
  }

  // TOMORROW
  if (tomorrowPosts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📆 Tomorrow — ${formatDateShort(tomorrow)}*` },
    });

    tomorrowPosts.forEach(p => {
      const entries = expandByPlatform(p);
      entries.forEach(({ page, platform }) => {
        buildPlatformBlock(page, platform, true).forEach(b => blocks.push(b));
      });
    });

    blocks.push({ type: 'divider' });
  }

  // DAY AFTER TOMORROW
  if (dayAfterPosts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📆 ${formatDateShort(dayAfter)}*` },
    });

    dayAfterPosts.forEach(p => {
      const entries = expandByPlatform(p);
      entries.forEach(({ page, platform }) => {
        buildPlatformBlock(page, platform, false).forEach(b => blocks.push(b));
      });
    });

    blocks.push({ type: 'divider' });
  }

  // BEHIND SCHEDULE
  if (behindPosts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*⚠️ Needs attention — due within 7 days*' },
    });

    behindPosts.forEach(p => {
      const title = getPropString(p, 'Post Title');
      const date = getPropString(p, 'Publish Date');
      const visualDueDate = getPropString(p, 'Visual Due Date');
      const status = getPropString(p, 'Status');
      const format = getPropString(p, 'Post Format');
      const platforms = getProp(p, 'Platform');
      const platformList = Array.isArray(platforms) && platforms.length > 0
        ? platforms.map(pl => `${getPlatformEmoji(pl)} ${pl}`).join('  ·  ')
        : '💼 LinkedIn';
      const pageUrl = p.url;

      const daysUntil = Math.ceil(
        (new Date(date + 'T00:00:00') - new Date(today + 'T00:00:00')) / (1000 * 60 * 60 * 24)
      );
      const urgency = daysUntil <= 2 ? '🔴' : daysUntil <= 4 ? '🟠' : '🟡';

      let text = `${urgency} *<${pageUrl}|${title}>*\n`;
      text += `${getStatusEmoji(status)} ${status}  ·  ${getFormatEmoji(format)} ${format}\n`;
      text += `${platformList}\n`;
      text += `📅 Publish: *${formatDateShort(date)}* (${daysUntil}d away)`;
      if (visualDueDate) text += `  ·  🎨 Visual due: *${formatDateShort(visualDueDate)}*`;

      blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
    });

    blocks.push({ type: 'divider' });
  }

  // Footer
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '🔴 1-2 days  ·  🟠 3-4 days  ·  🟡 5-7 days  ·  <https://notion.so/9364b4cebdbc4450a6324e3b2ad454a8|Open Calendar>',
    }],
  });

  await sendToSlack(blocks);
  console.log(`Briefing sent. Yesterday: ${yesterdayPosts.length}. Today: ${todayPosts.length}. Tomorrow: ${tomorrowPosts.length}. Day after: ${dayAfterPosts.length}. Behind: ${behindPosts.length}.`);
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
