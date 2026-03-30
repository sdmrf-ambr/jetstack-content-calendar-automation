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

async function main() {
  const today = getDateString(0);
  const in48h = getDateString(2);
  const in7d = getDateString(7);

  const data = await notionQuery(DATABASE_ID);
  const allPosts = data.results.filter(p => getProp(p, 'Publish Date') !== null);

  const dueSoon = allPosts.filter(p => {
    const date = getProp(p, 'Publish Date');
    const status = getProp(p, 'Status');
    return date >= today && date <= in48h &&
      ['Ready to Schedule', 'Scheduled'].includes(status);
  });

  const behindPosts = allPosts.filter(p => {
    const date = getProp(p, 'Publish Date');
    const status = getProp(p, 'Status');
    return date >= today && date <= in7d &&
      ['Idea', 'Script / Copy in progress', 'Visual in progress'].includes(status);
  });

  if (dueSoon.length === 0 && behindPosts.length === 0) {
    console.log('Nothing due soon and nothing behind. No briefing sent.');
    return;
  }

  const blocks = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '📋 JetStack Content Briefing', emoji: true },
  });

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `*${formatDate(today)}*  —  Daily calendar check` }],
  });

  blocks.push({ type: 'divider' });

  if (dueSoon.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Posts due in the next 48 hours*' },
    });

    dueSoon.forEach(p => {
      const title = getProp(p, 'Post Title');
      const date = getProp(p, 'Publish Date');
      const status = getProp(p, 'Status');
      const format = getProp(p, 'Post Format');
      const platform = getProp(p, 'Platform');
      const assetLink = getProp(p, 'Asset Link');
      const backupPost = getProp(p, 'Backup Post');
      const pageUrl = p.url;

      let text = `${getFormatEmoji(format)} *<${pageUrl}|${title}>*\n`;
      text += `${getStatusEmoji(status)} ${status}  ·  📆 ${formatDate(date)}\n`;
      text += `🖥️ ${platform || 'LinkedIn'}  ·  ${format}`;
      if (assetLink) text += `\n🔗 <${assetLink}|View asset>`;
      if (backupPost) text += `\n⚠️ Backup: ${backupPost}`;

      blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
    });

    blocks.push({ type: 'divider' });
  }

  if (behindPosts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*⚠️ Posts due within 7 days that need attention*' },
    });

    behindPosts.forEach(p => {
      const title = getProp(p, 'Post Title');
      const date = getProp(p, 'Publish Date');
      const status = getProp(p, 'Status');
      const format = getProp(p, 'Post Format');
      const pageUrl = p.url;

      const daysUntil = Math.ceil(
        (new Date(date + 'T00:00:00') - new Date(today + 'T00:00:00')) / (1000 * 60 * 60 * 24)
      );
      const urgency = daysUntil <= 2 ? '🔴' : daysUntil <= 4 ? '🟠' : '🟡';

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${urgency} *<${pageUrl}|${title}>*\n${getStatusEmoji(status)} ${status}  ·  ${getFormatEmoji(format)} ${format}  ·  📆 ${formatDate(date)} (${daysUntil}d away)`,
        },
      });
    });

    blocks.push({ type: 'divider' });
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '🔴 1-2 days  ·  🟠 3-4 days  ·  🟡 5-7 days  ·  <https://notion.so|Open Notion>',
    }],
  });

  await sendToSlack(blocks);
  console.log(`Briefing sent. Due soon: ${dueSoon.length}. Behind: ${behindPosts.length}.`);
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
