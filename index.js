import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import cron from 'node-cron';
import http from 'http';
import fs from 'fs';
import dotenv from 'dotenv';
const dotenvResult = dotenv.config({ path: '.env', override: true });
console.log('dotenv result:', dotenvResult && dotenvResult.parsed ? Object.keys(dotenvResult.parsed) : dotenvResult);

console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
console.log('SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'loaded' : 'missing');

// Fallback: if dotenv didn't parse the supabase vars for some reason,
// try to read and parse `.env` manually and set them on `process.env`.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  try {
    const raw = fs.readFileSync('.env', 'utf8');
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      const idx = l.indexOf('=');
      if (idx === -1) continue;
      const key = l.slice(0, idx).trim();
      let val = l.slice(idx + 1).trim();
      if ((key === 'SUPABASE_URL' || key === 'SUPABASE_ANON_KEY') && val) {
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
    console.log('Fallback supabase loaded:', !!process.env.SUPABASE_URL, !!process.env.SUPABASE_ANON_KEY);
  } catch (e) {
    console.error('Fallback .env parse failed:', e && e.message ? e.message : e);
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const LEAGUE_ID = "1843498"; // fixed league ID

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing Supabase configuration. Please set SUPABASE_URL and SUPABASE_ANON_KEY in your .env or environment.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const API_URL = `https://fantasy.premierleague.com/api/leagues-classic/1843498/standings/`;

// Fetch rankings from FPL API
async function fetchRankings() {
  const res = await fetch(API_URL);
  return res.json();
}

// Load last stored rankings from Supabase
async function loadLastData() {
  const { data, error } = await supabase
    .from('fantasy_rankings')
    .select('data')
    .eq('league_id', LEAGUE_ID)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Supabase load error:', error);
    return null;
  }

  return data ? data.data : null;
}

// Save new rankings to Supabase
async function saveData(newData) {
  const { error } = await supabase
    .from('fantasy_rankings')
    .upsert({
      league_id: LEAGUE_ID,
      data: newData,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'league_id' });

  if (error) {
    console.error('Supabase save error:', error);
  }
}

// Check if rankings changed by comparing JSON strings
function rankingsChanged(oldData, newData) {
  return JSON.stringify(oldData) !== JSON.stringify(newData);
}

// Format message to send on Telegram (matching previous style)
function formatMessage(standings, gameweek, topScorer) {
  const leagueSize = standings.length;
  const leader = standings[0];
  const bottom = standings[leagueSize - 1];

  let msg = `🏆 FPL League Rankings — GW${gameweek}\n`;
  msg += `👥 (${leagueSize} Managers)\n\n`;

  msg += `Current Leader: ${leader.player_name} (${leader.total} pts)\n\n`;

  standings.forEach((player, i) => {
    let rankText = '';
    if (i === 0) rankText = '🥇 ';
    else if (i === 1) rankText = '🥈 ';
    else if (i === 2) rankText = '🥉 ';
    else rankText = `${i + 1}. `;

    msg += `${rankText}${player.player_name} — ${player.total} pts ➖\n`;

    if ([9, 19, 29, 39].includes(i)) {
      msg += `──────────────\n`;
    }
  });

  msg += `\n⚠️ Bottom of the table: ${bottom.player_name} (${bottom.total} pts)\n`;

  const topName = topScorer?.player_name || topScorer?.name || topScorer?.entry_name || 'Unknown';
  const topPoints = topScorer?.event_points ?? topScorer?.event_total ?? topScorer?.event_total_points ?? 0;
  msg += `\n🎯 GW${gameweek} Top Scorer: ${topName} (${topPoints} pts)\n`;

  msg += `\n📊 Updated automatically`;

  return msg;
}

// Fetch current gameweek from bootstrap-static
async function fetchCurrentGameweek() {
  try {
    const res = await fetch('https://fantasy.premierleague.com/api/bootstrap-static/');
    const data = await res.json();
    const currentEvent = data.events && data.events.find(e => e.is_current);
    if (currentEvent) return currentEvent.id;
    const nextEvent = data.events && data.events.find(e => e.is_next);
    return nextEvent ? nextEvent.id : 'Unknown';
  } catch (e) {
    console.error('Failed to fetch bootstrap-static:', e && e.message ? e.message : e);
    return 'Unknown';
  }
}

// Send message to Telegram channel
async function postToTelegram(text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHANNEL_ID,
      text,
      parse_mode: 'Markdown',
    }),
  });
}

async function checkAndPost() {
  try {
    const newData = await fetchRankings();
    const standings = newData.standings.results;
    const gameweek = await fetchCurrentGameweek();

    // Find top scorer for this GW (robust to different field names)
    let topScorer = standings.reduce((max, player) => {
      const pPoints = player.event_points ?? player.event_total ?? player.event_total_points ?? 0;
      const mPoints = max ? (max.event_points ?? max.event_total ?? max.event_total_points ?? 0) : 0;
      return pPoints > mPoints ? player : max;
    }, standings[0]);

    const oldData = await loadLastData();

    if (!oldData || rankingsChanged(oldData, standings)) {
      const message = formatMessage(standings, gameweek, topScorer);
      await postToTelegram(message);
      await saveData(standings);
      console.log('Posted update');
    } else {
      console.log('No changes');
    }
  } catch (err) {
    console.error(err);
  }
}

// Schedule every 30 minutes
cron.schedule('*/30 * * * *', checkAndPost);

// Run immediately on start
checkAndPost();

// Minimal HTTP server for health checks (Koyeb expects port 8000)
const port = process.env.PORT || 8000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

server.listen(port, () => console.log(`Server running on port ${port}`));
