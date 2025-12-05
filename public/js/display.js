﻿/* Copyright © 2025 Ridwan and Team */
const socket = io();
const board = document.getElementById("board");
const overlay = document.getElementById("overlay");
const TEAM_COUNT = 12;
let teamToggleState = Array(TEAM_COUNT).fill(true);
let atomicLockState = { locked: false, activeTeam: 0, lockTime: 0 };

function getTeamLetter(index) {
  return String.fromCharCode(65 + index - 1);
}

function showActiveTeam(team) {
  if (!team || team < 1 || team > TEAM_COUNT) return;
  
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const el = document.getElementById("team-" + i);
    if (el) {
      el.classList.remove("active");
      if (i !== team) {
        el.classList.add("hidden");
      }
    }
  }
  
  overlay.classList.add("active");
  const activeEl = document.getElementById("team-" + team);
  if (activeEl) {
    activeEl.classList.add("active");
  }
}

function resetDisplay() {
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const el = document.getElementById("team-" + i);
    if (el) el.classList.remove("active", "hidden");
  }
  overlay.classList.remove("active");
}

function updateTeamDisplay() {
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const el = document.getElementById("team-" + i);
    if (el) {
      if (teamToggleState[i - 1]) {
        el.style.display = "flex";
        el.style.opacity = "1";
      } else {
        el.style.display = "none";
        el.style.opacity = "0";
      }
    }
  }
}

function updateTimerDisplay(seconds) {
  const timerEl = document.querySelector('.timer');
  if (!timerEl) return;
  
  if (seconds <= 0) {
    timerEl.textContent = '00:00';
    timerEl.classList.remove('normal', 'warning', 'critical');
    timerEl.classList.add('inactive');
  } else {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    timerEl.textContent = `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    
    timerEl.classList.remove('normal', 'warning', 'critical', 'inactive');
    
    if (seconds <= 10) {
      timerEl.classList.add('critical');
    } else if (seconds <= 30) {
      timerEl.classList.add('warning');
    } else {
      timerEl.classList.add('normal');
    }
  }
}

function resetTimerDisplay() {
  const timerEl = document.querySelector('.timer');
  if (timerEl) {
    timerEl.textContent = '00:00';
    timerEl.classList.remove('normal', 'warning', 'critical');
    timerEl.classList.add('inactive');
  }
}

function renderInitial() {
  try {
    board.innerHTML = "";
    for (let i = 1; i <= TEAM_COUNT; i++) {
      const el = document.createElement("div");
      el.className = "team";
      el.id = "team-" + i;
      el.innerHTML = `
        <h2>Tim ${getTeamLetter(i)}</h2>
        <div class="score" id="score-${i}">0</div>
      `;
      board.appendChild(el);
    }
    
    setTimeout(() => {
      updateTeamDisplay();
    }, 100);
  } catch (error) {
    console.error('Error rendering teams:', error);
  }
}

renderInitial();

// ===== SOCKET EVENTS =====
socket.on("connect", () => {
  console.log('[DISPLAY] Connected to server');
  
  const liveIndicator = document.querySelector('.live-indicator');
  if (liveIndicator) {
    liveIndicator.style.background = '#4caf50';
    liveIndicator.textContent = '● LIVE';
  }
  
  loadInitialData();
});

function loadInitialData() {
  Promise.all([
    fetch('/scores').then(r => r.json()),
    fetch('/lockstate').then(r => r.json()),
    fetch('/teamToggleState').then(r => r.json()),
    fetch('/timerstate').then(r => r.text())
  ])
  .then(([scoresData, lockStateData, toggleStateData, timerState]) => {
    if (Array.isArray(scoresData)) {
      for (let i = 0; i < scoresData.length; i++) {
        const el = document.getElementById("score-" + (i + 1));
        if (el) el.textContent = scoresData[i];
      }
    }
    
    if (lockStateData) {
      atomicLockState.locked = lockStateData.locked || false;
      atomicLockState.activeTeam = lockStateData.activeTeam || 0;
      
      if (lockStateData.locked && lockStateData.activeTeam) {
        showActiveTeam(lockStateData.activeTeam);
      } else {
        resetDisplay();
      }
    }
    
    if (Array.isArray(toggleStateData)) {
      teamToggleState = toggleStateData;
      updateTeamDisplay();
    }
    
    const time = parseInt(timerState);
    if (!isNaN(time)) {
      updateTimerDisplay(time);
    }
    
    console.log('[DISPLAY] Initial data loaded');
  })
  .catch(err => {
    console.error('Error loading initial data:', err);
  });
}

socket.on("disconnect", () => {
  console.log('[DISPLAY] Disconnected from server');
  const liveIndicator = document.querySelector('.live-indicator');
  if (liveIndicator) {
    liveIndicator.style.background = '#ff4444';
    liveIndicator.textContent = '● OFFLINE';
  }
});

socket.on("buzz", ({ team }) => {
  console.log(`[BUZZ] Team ${getTeamLetter(team)} pressed`);
  
  if (teamToggleState[team - 1]) {
    showActiveTeam(team);
  }
});

socket.on("update", payload => {
  const { team, score } = payload;
  
  if (team && score !== undefined && team >= 1 && team <= TEAM_COUNT) {
    const el = document.getElementById("score-" + team);
    if (el) {
      el.textContent = score;
      el.classList.add('score-update');
      setTimeout(() => el.classList.remove('score-update'), 600);
    }
  }
});

socket.on("reset", arr => {
  if (Array.isArray(arr)) {
    arr.forEach((s, idx) => {
      const el = document.getElementById("score-" + (idx + 1));
      if (el) el.textContent = s;
    });
  }
});

socket.on("lockstate", state => {
  atomicLockState.locked = state.locked || false;
  atomicLockState.activeTeam = state.activeTeam || 0;
  
  if (!state.locked) {
    resetDisplay();
  } else if (state.activeTeam) {
    showActiveTeam(state.activeTeam);
  }
});

socket.on("teamToggleUpdate", data => {
  const { team, enabled } = data;
  if (team >= 1 && team <= TEAM_COUNT) {
    teamToggleState[team - 1] = enabled;
    updateTeamDisplay();
  }
});

socket.on("allTeamsEnabled", () => {
  teamToggleState = Array(TEAM_COUNT).fill(true);
  updateTeamDisplay();
});

socket.on("allTeamsDisabled", () => {
  teamToggleState = Array(TEAM_COUNT).fill(false);
  updateTeamDisplay();
});

socket.on("teamToggleState", data => {
  if (Array.isArray(data)) {
    teamToggleState = data;
    updateTeamDisplay();
  }
});

socket.on("timerStart", (data) => {
  if (data.duration) {
    updateTimerDisplay(data.duration);
  }
});

socket.on("timerUpdate", (data) => {
  if (data.timeRemaining !== undefined) {
    updateTimerDisplay(data.timeRemaining);
  }
});

socket.on("timerReset", () => {
  resetTimerDisplay();
  if (!atomicLockState.locked) {
    resetDisplay();
  }
});

socket.on("systemUnlocked", () => {
  resetDisplay();
  resetTimerDisplay();
});

socket.on("aiMessage", (data) => {
  const aiMessageEl = document.getElementById("aiMessage");
  const message = data.message;

  if (!message || !aiMessageEl) return;

  aiMessageEl.textContent = message;
  aiMessageEl.classList.add("show");
  
  setTimeout(() => {
    aiMessageEl.classList.remove("show");
  }, 3000);
});

// ===== ESP32 STATUS =====
socket.on("esp32Status", (status) => {
  console.log(`[ESP32] ${status.connected ? 'Connected' : 'Disconnected'}`);
});

document.addEventListener('DOMContentLoaded', function() {
  resetTimerDisplay();
  console.log('[DISPLAY] Initialized - Flexible Version');
});