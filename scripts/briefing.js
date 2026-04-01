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

function getProp(page, name) {
  const prop = page.properties[name];
  if (!prop) return null;
  if (prop.type === 'title') return prop.title?.[0]?.plain_text || null;
  if (prop.type === 'select') return prop.select?.name || null;
  if (prop.type === 'multi_select') return prop.multi_select?.map(o => o.name).join(', ') || null;
  if (prop.type === 'date') return prop.date?.start || null;
  if (prop.type === 'url') return prop.url || null;
  if (prop.type === 'rich_text') return prop.rich_text?.[0]?.plain_text || null;
  return null;
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
    url.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i)
  );
}

async function main() {
  const today = getDateString(0);
  const tomorrow = getDateString(1);
  const dayAfter = getDateString(2);
  const in7d = getDateString(7);

  const data = await notionQuery(DATABASE_ID);
  const allPosts = data.results.filter(p => getProp(p, 'Publish Date') !== null);

  // Posts going live today
  const todayPosts = allPosts.filter(p => {
    const date = getProp(p, 'Publish Date');
    const status = getProp(p, 'Status');
    return date === today && status === 'Scheduled';
  });

  // Posts scheduled for tomorrow
  const tomorrowPosts = allPosts.filter(p => {
    const date = getProp(p, 'Publish Date');
    const status = getProp(p, 'Status');
    return date === tomorrow && ['Ready to Schedule', 'Scheduled'].includes(status);
  });

  // Posts scheduled for day after tomorrow
  const dayAfterPosts = allPosts.filter(p => {
    const date = getProp(p, 'Publish Date');
    const status = getProp(p, 'Status');
    return date === dayAfter && ['Ready to Schedule', 'Scheduled'].includes(status);
  });

  // Posts behind schedule — due within 7 days but not ready
  const behindPosts = allPosts.filter(p => {
    const date = getProp(p, 'Publish Date');
    const status = getProp(p, 'Status');
    return date >= today && date <= in7d &&
      ['Idea', 'Script / Copy in progress', 'Visual in progress'].includes(status);
  });

  const hasContent = todayPosts.length > 0 || tomorrowPosts.length > 0 ||
    dayAfterPosts.length > 0 || behindPosts.length > 0;

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

  // Helper to build a post block with visual due date and copy
  function buildPostBlock(p, showCopy = false) {
    const title = getProp(p, 'Post Title');
    const publishDate = getProp(p, 'Publish Date');
    const visualDueDate = getProp(p, 'Visual Due Date');
    const status = getProp(p, 'Status');
    const format = getProp(p, 'Post Format');
    const platform = getProp(p, 'Platform');
    const assetLink = getProp(p, 'Asset Link');
    const backupPost = getProp(p, 'Backup Post');
    const pageUrl = p.url;
    const imageUrl = normalizeImageUrl(assetLink);
    const postBlocks = [];

    let text = `${getFormatEmoji(format)} *<${pageUrl}|${title}>*\n`;
    text += `${getStatusEmoji(status)} ${status}  ·  🖥️ ${platform || 'LinkedIn'}\n`;
    text += `📅 Publish: *${formatDateShort(publishDate)}*`;
    if (visualDueDate) text += `  ·  🎨 Visual due: *${formatDateShort(visualDueDate)}*`;
    if (assetLink && !isImageUrl(assetLink)) text += `\n🔗 <${assetLink}|View asset>`;
    if (backupPost) text += `\n⚠️ Backup: ${backupPost}`;

    postBlocks.push({ type: 'section', text: { type: 'mrkdwn', text } });

    // Show image if asset link is an image
    if (imageUrl && isImageUrl(assetLink)) {
      postBlocks.push({ type: 'image', image_url: imageUrl, alt_text: title });
    }

    // Show LinkedIn copy for today's posts
    if (showCopy) {
      // We surface the page link prominently since full copy lives in the page body
      postBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📋 *LinkedIn copy is in the Notion page.*\n👉 <${pageUrl}|Open page to copy caption>\n\n_To update status: open the page in Notion and change the Status field._`,
        },
      });
    }

    return postBlocks;
  }

  // TODAY
  if (todayPosts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*🚀 Going live today*' },
    });
    todayPosts.forEach(p => {
      buildPostBlock(p, true).forEach(b => blocks.push(b));
    });
    blocks.push({ type: 'divider' });
  }

  // TOMORROW
  if (tomorrowPosts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📆 Tomorrow — ${formatDateShort(tomorrow)}*` },
    });
    tomorrowPosts.forEach(p => {
      buildPostBlock(p, true).forEach(b => blocks.push(b));
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
      buildPostBlock(p, false).forEach(b => blocks.push(b));
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
      const title = getProp(p, 'Post Title');
      const date = getProp(p, 'Publish Date');
      const visualDueDate = getProp(p, 'Visual Due Date');
      const status = getProp(p, 'Status');
      const format = getProp(p, 'Post Format');
      const pageUrl = p.url;

      const daysUntil = Math.ceil(
        (new Date(date + 'T00:00:00') - new Date(today + 'T00:00:00')) / (1000 * 60 * 60 * 24)
      );
      const urgency = daysUntil <= 2 ? '🔴' : daysUntil <= 4 ? '🟠' : '🟡';

      let text = `${urgency} *<${pageUrl}|${title}>*\n`;
      text += `${getStatusEmoji(status)} ${status}  ·  ${getFormatEmoji(format)} ${format}\n`;
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
  console.log(`Briefing sent. Today: ${todayPosts.length}. Tomorrow: ${tomorrowPosts.length}. Day after: ${dayAfterPosts.length}. Behind: ${behindPosts.length}.`);
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
