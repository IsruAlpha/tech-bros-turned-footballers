import fetch from "node-fetch";
import cron from "node-cron";
import fs from "fs";
import "dotenv/config";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const DATA_FILE = "./state.json";

const API_URL =
  "https://fantasy.premierleague.com/api/leagues-classic/1843498/standings/";

async function fetchGameweekTopScorer(gameweek) {
  const res = await fetch(
    `https://fantasy.premierleague.com/api/event/${gameweek}/live/`
  );
  const data = await res.json();

  let top = { entry: null, points: 0 };

  Object.values(data.elements).forEach(el => {
    if (el.stats.total_points > top.points) {
      top = {
        entry: el.id,
        points: el.stats.total_points,
      };
    }
  });

  return top;
}

function loadState() {
  if (!fs.existsSync(DATA_FILE)) {
    return { rankings: null, messageId: null };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function saveState(state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

async function fetchRankings() {
  const res = await fetch(API_URL);
  const data = await res.json();

  return data.standings.results.map(player => ({
    entry: player.entry,
    name: player.player_name,
    points: player.total,
    rank: player.rank,
  }));
}

function getBiggestMover(newRanks, oldRanks) {
  if (!oldRanks) return null;

  let biggestMover = null;
  let maxClimb = 0;

  newRanks.forEach(p => {
    const old = oldRanks.find(o => o.entry === p.entry);
    if (!old) return;

    const climb = old.rank - p.rank;
    if (climb > maxClimb) {
      maxClimb = climb;
      biggestMover = { name: p.name, climb };
    }
  });

  return biggestMover && maxClimb > 0 ? biggestMover : null;
}

function buildMessage(newRanks, oldRanks) {
  let msg = "🏆 FPL League Rankings\n\n";

  newRanks.forEach((p, i) => {
    let movement = "➖";

    if (oldRanks) {
      const old = oldRanks.find(o => o.entry === p.entry);
      if (old) {
        if (p.rank < old.rank) movement = `⬆️ +${old.rank - p.rank}`;
        if (p.rank > old.rank) movement = `⬇️ -${p.rank - old.rank}`;
      }
    }

    // Top 3 styling
    if (i === 0) {
      msg += `🥇 ${p.name} — ${p.points} pts ${movement}\n`;
    } else if (i === 1) {
      msg += `🥈 ${p.name} — ${p.points} pts ${movement}\n`;
    } else if (i === 2) {
      msg += `🥉 ${p.name} — ${p.points} pts ${movement}\n`;
    } else {
      msg += `${i + 1}. ${p.name} — ${p.points} pts ${movement}\n`;
    }
  });

  const biggestMover = getBiggestMover(newRanks, oldRanks);
  if (biggestMover) {
    msg += `\n🔥 Biggest Climber: ${biggestMover.name} (+${biggestMover.climb})`;
  }

  msg += `\n\nUpdated automatically`;
  return msg;
}

async function sendMessage(text) {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        text,
      }),
    }
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${JSON.stringify(data)}`);
  }

  if (!data || data.ok === false) {
    throw new Error(`Telegram API error: ${data && data.description ? data.description : JSON.stringify(data)}`);
  }

  if (!data.result) {
    throw new Error(`Unexpected Telegram response, no result: ${JSON.stringify(data)}`);
  }

  return data.result.message_id;
}

async function editMessage(text, messageId) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHANNEL_ID,
      message_id: messageId,
      text,
    }),
  });

  const data = await res.json();
  if (!res.ok || (data && data.ok === false)) {
    throw new Error(`Failed to edit message: ${res.status} ${res.statusText} - ${JSON.stringify(data)}`);
  }
}

function rankingsChanged(oldRanks, newRanks) {
  return JSON.stringify(oldRanks) !== JSON.stringify(newRanks);
}

async function checkAndUpdate() {
  try {
    const state = loadState();
    const newRanks = await fetchRankings();
    const CURRENT_GAMEWEEK = 23; // update weekly
    const topScorer = await fetchGameweekTopScorer(CURRENT_GAMEWEEK);

    if (!state.rankings) {
      let text = buildMessage(newRanks, null);
      if (topScorer && typeof topScorer.points === 'number') {
        text += `\n🎯 GW${CURRENT_GAMEWEEK} Top Scorer: ${topScorer.points} pts`;
      }
      const messageId = await sendMessage(text);
      saveState({ rankings: newRanks, messageId });
      console.log("Initial rankings posted");
      return;
    }

    if (rankingsChanged(state.rankings, newRanks)) {
      let text = buildMessage(newRanks, state.rankings);
      if (topScorer && typeof topScorer.points === 'number') {
        text += `\n🎯 GW${CURRENT_GAMEWEEK} Top Scorer: ${topScorer.points} pts`;
      }
      await editMessage(text, state.messageId);
      saveState({ rankings: newRanks, messageId: state.messageId });
      console.log("Rankings updated");
    } else {
      console.log("No changes");
    }
  } catch (err) {
    console.error("Error:", err && err.stack ? err.stack : err);
  }
}

/**
 * Run every 1 hour
 * (Safe for FPL + avoids spam)
 */
cron.schedule("0 * * * *", checkAndUpdate);

// Run once on startup
checkAndUpdate();
