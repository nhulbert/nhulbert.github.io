(function () {
  const matchupEl = document.getElementById('matchup');
  const resultsEl = document.getElementById('results');
  const progressText = document.getElementById('progress-text');
  const progressFill = document.getElementById('progress-fill');
  const controlsEl = document.getElementById('controls');

  // ---------- movie data ----------
  // Edit movies.json for the source-of-truth, then copy into this array.
  // Each entry: { title: "...", thumbnail: "thumbnails/...png" } or just { title: "..." }
  const movies = [
    {"title": "Troy", "thumbnail": "thumbnails/image13.png"},
    {"title": "Master and Commander: The Far Side of the World", "thumbnail": "thumbnails/image7.png"},
    {"title": "Jonah: A VeggieTales Movie", "thumbnail": "thumbnails/image20.png"},
    {"title": "Captain Phillips", "thumbnail": "thumbnails/image27.png"},
    {"title": "Jaws", "thumbnail": "thumbnails/image28.png"},
    {"title": "Treasure Planet", "thumbnail": "thumbnails/image22.png"},
    {"title": "Greyhound", "thumbnail": "thumbnails/image17.png"},
    {"title": "Waterworld", "thumbnail": "thumbnails/image11.png"},
    {"title": "Pirates of the Caribbean", "thumbnail": "thumbnails/image12.png"},
    {"title": "Forrest Gump", "thumbnail": "thumbnails/image26.png"},
    {"title": "Castaway", "thumbnail": "thumbnails/image8.png"},
    {"title": "Triangle of Sadness", "thumbnail": "thumbnails/image1.png"},
    {"title": "The boys in the boat", "thumbnail": "thumbnails/image23.png"},
    {"title": "The perfect storm", "thumbnail": "thumbnails/image15.png"},
    {"title": "Titanic", "thumbnail": "thumbnails/image24.png"},
    {"title": "Pressure", "thumbnail": "thumbnails/image4.png"},
    {"title": "Das Boot", "thumbnail": "thumbnails/image19.png"},
    {"title": "Water Boy", "thumbnail": "thumbnails/image3.png"},
    {"title": "Hunt for red October", "thumbnail": "thumbnails/image2.png"},
    {"title": "Lighthouse", "thumbnail": "thumbnails/image18.png"},
    {"title": "Life Aquatic with Steve Zissou", "thumbnail": "thumbnails/image5.png"},
    {"title": "Knock Off", "thumbnail": "thumbnails/image14.png"},
    {"title": "All is Lost", "thumbnail": "thumbnails/image25.png"},
    {"title": "Captain Ron", "thumbnail": "thumbnails/image10.png"},
    {"title": "50 first dates", "thumbnail": "thumbnails/image6.png"},
    {"title": "Face Off", "thumbnail": "thumbnails/image9.png"},
    {"title": "Sirat", "thumbnail": "thumbnails/image29.png"},
    {"title": "Moana", "thumbnail": "thumbnails/image16.png"},
    {"title": "Banshees of Inisherin", "thumbnail": "thumbnails/image21.png"}
  ];

  const n = movies.length;
  const totalPairs = (n * (n - 1)) / 2;

  // pairs list: [ [i,j], ... ]  i < j
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairs.push([i, j]);
    }
  }
  // Fisher-Yates shuffle
  for (let k = pairs.length - 1; k > 0; k--) {
    const r = Math.floor(Math.random() * (k + 1));
    [pairs[k], pairs[r]] = [pairs[r], pairs[k]];
  }

  // ---------- state ----------
  const tally = Array.from({ length: n }, () => Array(n).fill(0));
  let voterCount = 0;

  let currentVoterResults = Array.from({ length: n }, () => Array(n).fill(null));
  let currentPairIdx = 0;
  let votingInProgress = false;

  // ---------- UI helpers ----------
  function showControls(html) {
    controlsEl.innerHTML = html;
    controlsEl.style.display = 'block';
  }

  function hideControls() {
    controlsEl.style.display = 'none';
  }

  function resetVoterState() {
    currentVoterResults = Array.from({ length: n }, () => Array(n).fill(null));
    currentPairIdx = 0;
    votingInProgress = false;
  }

  // ---------- start a new voter ----------
  function startVoter() {
    resetVoterState();
    voterCount++;
    votingInProgress = true;
    hideControls();
    resultsEl.style.display = 'none';
    renderMatchup();
  }

  // ---------- render matchup ----------
  function renderMatchup() {
    if (currentPairIdx >= totalPairs) {
      finishVoter();
      return;
    }

    const [i, j] = pairs[currentPairIdx];
    const a = movies[i];
    const b = movies[j];

    progressText.textContent =
      `Voter ${voterCount} — Matchup ${currentPairIdx + 1} of ${totalPairs}`;
    progressFill.style.width = `${(currentPairIdx / totalPairs) * 100}%`;

    matchupEl.innerHTML = `
      <div class="matchup-card" data-winner="a">
        ${thumbnail(a)}
        <div class="title">${esc(a.title)}</div>
      </div>
      <div class="vs">VS</div>
      <div class="matchup-card" data-winner="b">
        ${thumbnail(b)}
        <div class="title">${esc(b.title)}</div>
      </div>
    `;

    matchupEl.querySelectorAll('.matchup-card').forEach(card => {
      card.addEventListener('click', () => {
        const winner = card.dataset.winner;
        if (winner === 'a') currentVoterResults[i][j] = true;
        else currentVoterResults[i][j] = false;
        currentPairIdx++;
        renderMatchup();
      });
    });
  }

  function thumbnail(m) {
    if (m.thumbnail) {
      return `<img src="${esc(m.thumbnail)}" alt="${esc(m.title)}" loading="lazy" />`;
    }
    return `<div class="no-image">No image</div>`;
  }

  function esc(s) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(s));
    return div.innerHTML;
  }

  // ---------- finish voter, merge into tally ----------
  function finishVoter() {
    votingInProgress = false;
    progressText.textContent = `Voter ${voterCount} completed all matchups!`;
    progressFill.style.width = '100%';

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const pref = currentVoterResults[i][j];
        if (pref === true) tally[i][j]++;
        else if (pref === false) tally[j][i]++;
      }
    }

    showControls(`
      <p style="margin:10px 0">${voterCount} ${voterCount === 1 ? 'voter has' : 'voters have'} voted so far.</p>
      <button class="btn-reset" id="btn-add-voter">Add another voter</button>
      <button class="btn-reset" id="btn-view-results" style="margin-left:10px">View results</button>
    `);

    document.getElementById('btn-add-voter').addEventListener('click', startVoter);
    document.getElementById('btn-view-results').addEventListener('click', showResults);
    matchupEl.innerHTML = '';
  }

  // ---------- aggregate results ----------
  function showResults() {
    hideControls();
    progressText.textContent = `${voterCount} ${voterCount === 1 ? 'voter has' : 'voters have'} voted. Results:`;
    progressFill.style.width = '100%';

    const scores = movies.map((_, idx) => {
      let wins = 0;
      for (let k = 0; k < n; k++) {
        if (k === idx) continue;
        const i = Math.min(idx, k);
        const j = Math.max(idx, k);
        const iPrefers = idx < k ? tally[i][j] : tally[j][i];
        const kPrefers = idx < k ? tally[j][i] : tally[i][j];
        if (iPrefers > kPrefers) wins++;
      }
      return { idx, wins };
    });

    scores.sort((a, b) => b.wins - a.wins);
    const condorcetWinner = scores.find(s => s.wins === n - 1);

    let html = `<h2>${condorcetWinner
      ? `🏆 Condorcet Winner: ${esc(movies[condorcetWinner.idx].title)}`
      : '⚠️ No Condorcet Winner (cycle detected)'}</h2>`;

    if (!condorcetWinner) {
      html += `<p class="detail">No candidate beats every other candidate. Showing most pairwise wins.</p>`;
    } else {
      html += `<p class="detail">${esc(movies[condorcetWinner.idx].title)} beats all ${n - 1} other movies head-to-head.</p>`;
    }

    html += `<table><thead><tr><th>Rank</th><th>Movie</th><th>Wins</th><th>Losses</th></tr></thead><tbody>`;

    scores.forEach((s, rank) => {
      const losses = n - 1 - s.wins;
      const rowClass = condorcetWinner && s.idx === condorcetWinner.idx ? ' class="winner-row"' : '';
      const nameClass = condorcetWinner && s.idx === condorcetWinner.idx ? ' class="winner"' : '';
      html += `<tr${rowClass}><td>${rank + 1}</td><td${nameClass}>${esc(movies[s.idx].title)}</td><td>${s.wins}</td><td>${losses}</td></tr>`;
    });

    html += `</tbody></table>`;

    html += `<h3 style="margin-top:20px">Head-to-head tally</h3>`;
    html += `<table><thead><tr><th>Matchup</th><th>Preferences</th></tr></thead><tbody>`;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const aPrefers = tally[i][j];
        const bPrefers = tally[j][i];
        const winner = aPrefers > bPrefers ? movies[i].title : (bPrefers > aPrefers ? movies[j].title : 'Tie');
        html += `<tr><td>${esc(movies[i].title)} vs ${esc(movies[j].title)}</td><td>${aPrefers}–${bPrefers} (${esc(winner)} leads)</td></tr>`;
      }
    }
    html += `</tbody></table>`;

    html += `<button class="btn-reset" onclick="location.reload()">Start over</button>`;
    html += `<button class="btn-reset" id="btn-back-vote" style="margin-left:10px">Add more voters</button>`;

    resultsEl.innerHTML = html;
    resultsEl.style.display = 'block';

    document.getElementById('btn-back-vote').addEventListener('click', () => {
      resultsEl.style.display = 'none';
      showControls(`
        <p style="margin:10px 0">${voterCount} ${voterCount === 1 ? 'voter has' : 'voters have'} voted so far.</p>
        <button class="btn-reset" id="btn-add-voter2">Add another voter</button>
        <button class="btn-reset" id="btn-view-results2" style="margin-left:10px">View results</button>
      `);
      document.getElementById('btn-add-voter2').addEventListener('click', startVoter);
      document.getElementById('btn-view-results2').addEventListener('click', showResults);
    });
  }

  // ---------- init ----------
  startVoter();
})();
