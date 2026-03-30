const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;

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

async function queryPosts(filterFn) {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    sorts: [{ property: 'Publish Date', direction: 'ascending' }],
  });
  return response.results.filter(filterFn);
}

function getProperty(page, name) {
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

async function sendToSlack(blocks) {
  const fetch = (await import('node-fetch')).default;
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

async function main() {
  const today = getDateString(0);
  const in48h = getDateString(2);
  const in7d = getDateString(7);

  const allPosts = await queryPosts(page => {
    const date = getProperty(page, 'Publish Date');
    return date !== null;
  });

  // Posts due in next 48 hours that are Ready to Schedule or Scheduled
  const dueSoon = allPosts.filter(page => {
    const date = getProperty(page, 'Publish Date');
    const status = getProperty(page, 'Status');
    return date >= today && date <= in48h &&
      ['Ready to Schedule', 'Scheduled'].includes(status);
  });

  // Posts due in next 7 days that are still Idea or Script in progress (behind alert)
  const behindPosts = allPosts.filter(page => {
    const date = getProperty(page, 'Publish Date');
    const status = getProperty(page, 'Status');
    return date >= today && date <= in7d &&
      ['Idea', 'Script / Copy in progress', 'Visual in progress'].includes(status);
  });

  // Nothing to report
  if (dueSoon.length === 0 && behindPosts.length === 0) {
    console.log('Nothing due in 48 hours and no posts behind. No briefing sent.');
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
    elements: [{
      type: 'mrkdwn',
      text: `*${formatDate(today)}*  —  Daily calendar check`,
    }],
  });

  blocks.push({ type: 'divider' });

  // Due in 48 hours
  if (dueSoon.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Posts due in the next 48 hours*' },
    });

    dueSoon.forEach(page => {
      const title = getProperty(page, 'Post Title');
      const date = getProperty(page, 'Publish Date');
      const status = getProperty(page, 'Status');
      const format = getProperty(page, 'Post Format');
      const platform = getProperty(page, 'Platform');
      const assetLink = getProperty(page, 'Asset Link');
      const backupPost = getProperty(page, 'Backup Post');
      const statusEmoji = getStatusEmoji(status);
      const formatEmoji = getFormatEmoji(format);
      const pageUrl = page.url;

      let text = `${formatEmoji} *<${pageUrl}|${title}>*\n`;
      text += `${statusEmoji} ${status}  ·  📆 ${formatDate(date)}\n`;
      text += `🖥️ ${platform || 'LinkedIn'}  ·  ${format}`;
      if (assetLink) text += `\n🔗 <${assetLink}|View asset>`;
      if (backupPost && status === 'Idea') text += `\n⚠️ Backup: ${backupPost}`;

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text },
      });
    });

    blocks.push({ type: 'divider' });
  }

  // Behind schedule alert
  if (behindPosts.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*⚠️ Posts due within 7 days that need attention*',
      },
    });

    behindPosts.forEach(page => {
      const title = getProperty(page, 'Post Title');
      const date = getProperty(page, 'Publish Date');
      const status = getProperty(page, 'Status');
      const format = getProperty(page, 'Post Format');
      const pageUrl = page.url;
      const statusEmoji = getStatusEmoji(status);
      const formatEmoji = getFormatEmoji(format);

      const daysUntil = Math.ceil(
        (new Date(date + 'T00:00:00') - new Date(today + 'T00:00:00')) / (1000 * 60 * 60 * 24)
      );

      const urgency = daysUntil <= 2 ? '🔴' : daysUntil <= 4 ? '🟠' : '🟡';

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${urgency} *<${pageUrl}|${title}>*\n${statusEmoji} ${status}  ·  ${formatEmoji} ${format}  ·  📆 ${formatDate(date)} (${daysUntil}d away)`,
        },
      });
    });

    blocks.push({ type: 'divider' });
  }

  // Footer
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '🔴 Due in 1-2 days  ·  🟠 Due in 3-4 days  ·  🟡 Due in 5-7 days  ·  <https://notion.so|Open Notion>',
    }],
  });

  await sendToSlack(blocks);
  console.log(`Briefing sent. Due soon: ${dueSoon.length}. Behind: ${behindPosts.length}.`);
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
