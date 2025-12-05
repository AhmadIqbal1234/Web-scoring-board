﻿/* Copyright © 2025 Ridwan and Team */
const socket = io();
const board = document.getElementById("board");
const overlay = document.getElementById("overlay");
const TEAM_COUNT = 12;
let teamToggleState = Array(TEAM_COUNT).fill(true);

// ===== ATOMIC LOCK STATE =====
let atomicLockState = {
  locked: false,
  activeTeam: 0,
  lockTime: 0,
  lastBuzzTime: 0,
  lockId: null
};

// ===== PERFORMANCE OPTIMIZATION =====
const BUTTON_COOLDOWN = 10; // DITURUNKAN: 50ms → 10ms
let lastButtonProcessTime = 0;
let currentActiveTeam = 0;

// Timer optimization
let lastTimerValue = 0;
let timerUpdateTimeout = null;
const TIMER_UPDATE_DEBOUNCE = 30; // DITURUNKAN: 50ms → 30ms

// ===== SISTEM AUDIO FILE =====
class SistemAudioTim {
  constructor() {
    this.audioElements = new Map();
    this.sedangMemutar = false;
    this.audioSekarang = null;
    this.onAudioEndCallback = null;
    
    this.inisialisasiAudio();
  }

  inisialisasiAudio() {
    for (let i = 1; i <= TEAM_COUNT; i++) {
      const teamLetter = getTeamLetter(i);
      const audioFile = `Tim ${teamLetter}.mp3`;
      const audioEl = new Audio(`/audio/${audioFile}`);
      
      audioEl.preload = 'auto';
      audioEl.onerror = (e) => this.handleAudioError(e, teamLetter, audioFile);
      
      this.audioElements.set(i, audioEl);
    }
    
    console.log('[AUDIO] Sistem audio tim diinisialisasi');
  }

  handleAudioError(event, teamLetter, audioFile) {
    console.error(`Error audio untuk Tim ${teamLetter}:`, event.target.error);
    this.sedangMemutar = false;
    
    if (this.onAudioEndCallback) {
      setTimeout(() => {
        this.executeCallback(this.onAudioEndCallback);
        this.onAudioEndCallback = null;
      }, 100);
    }
  }

  executeCallback(callbackData) {
    if (callbackData && callbackData.action === 'startTimer' && callbackData.team) {
      this.notifyServerAudioFinished(callbackData.team);
    }
  }

  notifyServerAudioFinished(team) {
    fetch(`/audioFinished?action=startTimer&team=${team}&type=team`)
      .catch(err => {
        console.error('Audio finish callback error:', err);
      });
  }

  putarAudio(team, onAudioEnd = null) {
    if (this.sedangMemutar && this.audioSekarang === this.audioElements.get(team)) {
      return false;
    }
    
    if (this.sedangMemutar) {
      this.berhenti();
    }

    const audioEl = this.audioElements.get(team);
    if (!audioEl) {
      if (onAudioEnd) {
        setTimeout(() => this.executeCallback(onAudioEnd), 100);
      }
      return false;
    }

    try {
      this.sedangMemutar = true;
      this.audioSekarang = audioEl;
      this.onAudioEndCallback = onAudioEnd;

      audioEl.onended = () => {
        this.sedangMemutar = false;
        
        if (this.onAudioEndCallback) {
          this.executeCallback(this.onAudioEndCallback);
          this.onAudioEndCallback = null;
        }
      };

      audioEl.currentTime = 0;
      
      const playPromise = audioEl.play();
      
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            console.log(`[AUDIO] Memutar audio untuk Tim ${getTeamLetter(team)}`);
            
            const aiMessageEl = document.getElementById("aiMessage");
            if (aiMessageEl) {
              aiMessageEl.textContent = `Tombol ditekan oleh Tim ${getTeamLetter(team)}!`;
              aiMessageEl.classList.add("show");
              
              setTimeout(() => {
                aiMessageEl.classList.remove("show");
              }, 2000);
            }
          })
          .catch(error => {
            console.error('Gagal memutar audio:', error);
            this.sedangMemutar = false;
            if (onAudioEnd) {
              setTimeout(() => this.executeCallback(onAudioEnd), 100);
            }
          });
      }
      
      return true;
      
    } catch (error) {
      console.error('Exception audio:', error);
      this.sedangMemutar = false;
      if (onAudioEnd) {
        setTimeout(() => this.executeCallback(onAudioEnd), 100);
      }
      return false;
    }
  }

  berhenti() {
    if (this.sedangMemutar && this.audioSekarang) {
      this.audioSekarang.pause();
      this.audioSekarang.currentTime = 0;
      this.sedangMemutar = false;
      this.onAudioEndCallback = null;
    }
  }
}

// Sistem Audio untuk Timer Countdown
class TimerAudioSystem {
  constructor() {
    this.audioElements = new Map();
    this.sedangMemutar = false;
    this.audioSekarang = null;
    
    this.inisialisasiAudio();
  }

  inisialisasiAudio() {
    const countdownFiles = [
      '30 detik.mp3', '20 detik.mp3', '10 detik.mp3',
      '5 detik.mp3', '4 detik.mp3', '3 detik.mp3', 
      '2 detik.mp3', '1 detik.mp3', 'waktu habis.mp3'
    ];
    
    countdownFiles.forEach(file => {
      const audioEl = new Audio(`/audio/${file}`);
      audioEl.preload = 'auto';
      this.audioElements.set(file, audioEl);
    });
  }

  putarAudio(audioFile) {
    if (this.sedangMemutar) {
      this.berhenti();
    }

    const audioEl = this.audioElements.get(audioFile);
    if (!audioEl) return false;

    try {
      this.sedangMemutar = true;
      this.audioSekarang = audioEl;

      audioEl.currentTime = 0;
      
      const playPromise = audioEl.play();
      
      if (playPromise !== undefined) {
        playPromise.catch(error => {
          console.error('Gagal memutar audio timer:', error);
          this.sedangMemutar = false;
        });
      }

      audioEl.onended = () => {
        this.sedangMemutar = false;
      };

      return true;
      
    } catch (error) {
      console.error('Exception audio timer:', error);
      this.sedangMemutar = false;
      return false;
    }
  }

  berhenti() {
    if (this.sedangMemutar && this.audioSekarang) {
      this.audioSekarang.pause();
      this.audioSekarang.currentTime = 0;
      this.sedangMemutar = false;
    }
  }
}

// Sistem Audio untuk Juri
class JuryAudioSystem {
  constructor() {
    this.audioElements = new Map();
    this.sedangMemutar = false;
    this.audioSekarang = null;
    
    this.inisialisasiAudio();
  }

  inisialisasiAudio() {
    const juryFiles = ['benar.mp3', 'salah.mp3'];
    
    juryFiles.forEach(file => {
      const audioEl = new Audio(`/audio/${file}`);
      audioEl.preload = 'auto';
      this.audioElements.set(file, audioEl);
    });
  }

  putarAudio(audioFile) {
    if (this.sedangMemutar) {
      this.berhenti();
    }

    const audioEl = this.audioElements.get(audioFile);
    if (!audioEl) return false;

    try {
      this.sedangMemutar = true;
      this.audioSekarang = audioEl;

      audioEl.currentTime = 0;
      
      const playPromise = audioEl.play();
      
      if (playPromise !== undefined) {
        playPromise.catch(error => {
          console.error('Gagal memutar audio juri:', error);
          this.sedangMemutar = false;
        });
      }

      audioEl.onended = () => {
        this.sedangMemutar = false;
      };

      return true;
      
    } catch (error) {
      console.error('Exception audio juri:', error);
      this.sedangMemutar = false;
      return false;
    }
  }

  berhenti() {
    if (this.sedangMemutar && this.audioSekarang) {
      this.audioSekarang.pause();
      this.audioSekarang.currentTime = 0;
      this.sedangMemutar = false;
    }
  }
}

// Inisialisasi sistem audio
const audioTim = new SistemAudioTim();
const timerAudio = new TimerAudioSystem();
const juryAudio = new JuryAudioSystem();

// ===== FUNGSI BANTU =====
function getTeamLetter(index) {
  return String.fromCharCode(65 + index - 1);
}

function getTeamAudioFile(teamNumber) {
  const teamLetter = getTeamLetter(teamNumber);
  return `Tim ${teamLetter}.mp3`;
}

// ===== ATOMIC LOCK FUNCTIONS - OPTIMIZED =====
function checkAtomicLock(team) {
  const now = Date.now();
  const lockThreshold = 3; // Threshold 3ms untuk responsivitas maksimal
  
  if (atomicLockState.locked) {
    const lockAge = now - atomicLockState.lockTime;
    
    // Jika lock sangat baru (dalam threshold), langsung tolak
    if (lockAge < lockThreshold) {
      console.log(`[ATOMIC] Tim ${getTeamLetter(team)} ditolak - lock terlalu baru (${lockAge}ms)`);
      return false;
    }
    
    // Jika sudah terkunci oleh tim lain
    if (atomicLockState.activeTeam !== team) {
      console.log(`[ATOMIC] Tim ${getTeamLetter(team)} ditolak - ` +
                 `sistem terkunci oleh Tim ${getTeamLetter(atomicLockState.activeTeam)} ` +
                 `(${lockAge}ms yang lalu)`);
      return false;
    }
    
    // Jika terkunci oleh tim yang sama tapi baru saja
    if (lockAge < 100) {
      console.log(`[ATOMIC] Duplikat buzz dari Tim ${getTeamLetter(team)} diabaikan`);
      return false;
    }
  }
  
  return true;
}

function setAtomicLock(team) {
  atomicLockState = {
    locked: true,
    activeTeam: team,
    lockTime: Date.now(),
    lastBuzzTime: Date.now(),
    lockId: `client_lock_${Date.now()}_${team}`
  };
  
  console.log(`[ATOMIC] Tim ${getTeamLetter(team)} atomic locked`);
}

function clearAtomicLock() {
  atomicLockState = {
    locked: false,
    activeTeam: 0,
    lockTime: 0,
    lastBuzzTime: 0,
    lockId: null
  };
  
  console.log('[ATOMIC] Lock cleared');
}

// ===== TAMPILKAN TIM AKTIF =====
function showActiveTeam(team) {
  if (!team || team < 1 || team > TEAM_COUNT) return;
  
  currentActiveTeam = team;
  
  // Sembunyikan semua tim
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const el = document.getElementById("team-" + i);
    if (el) {
      el.classList.remove("active");
      if (i !== team) {
        el.classList.add("hidden");
      }
    }
  }
  
  // Tampilkan tim aktif
  overlay.classList.add("active");
  const activeEl = document.getElementById("team-" + team);
  if (activeEl) {
    activeEl.classList.add("active");
  }
}

function resetDisplay() {
  currentActiveTeam = 0;
  
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const el = document.getElementById("team-" + i);
    if (el) el.classList.remove("active", "hidden");
  }
  overlay.classList.remove("active");
}

// Update tampilan berdasarkan status toggle tim
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

// ===== OPTIMIZED TIMER DISPLAY =====
function updateTimerDisplayOptimized(seconds) {
  const timerEl = document.querySelector('.timer');
  if (!timerEl) return;
  
  if (seconds === lastTimerValue && seconds > 0) return;
  
  if (seconds <= 0) {
    if (timerEl.textContent !== '00:00') {
      timerEl.textContent = '00:00';
      timerEl.classList.remove('normal', 'warning', 'critical');
      timerEl.classList.add('inactive');
      lastTimerValue = 0;
      
      // Saat timer 0, reset display juga
      if (!atomicLockState.locked) {
        resetDisplay();
      }
    }
  } else {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const newTime = `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    
    if (timerEl.textContent !== newTime) {
      timerEl.textContent = newTime;
      
      timerEl.classList.remove('normal', 'warning', 'critical', 'inactive');
      
      if (seconds <= 10) {
        timerEl.classList.add('critical');
      } else if (seconds <= 30) {
        timerEl.classList.add('warning');
      } else {
        timerEl.classList.add('normal');
      }
      
      lastTimerValue = seconds;
    }
  }
}

function resetTimerDisplay() {
  const timerEl = document.querySelector('.timer');
  if (timerEl) {
    timerEl.textContent = '00:00';
    timerEl.classList.remove('normal', 'warning', 'critical');
    timerEl.classList.add('inactive');
    lastTimerValue = 0;
  }
}

// ===== PLAY TEAM AUDIO =====
function playTeamAudioDirectly(team) {
  const audioSuccess = audioTim.putarAudio(team, {
    action: "startTimer",
    team: team
  });
  
  if (!audioSuccess) {
    setTimeout(() => {
      socket.emit("preTeamAudioFinished", { team: team });
    }, 300);
  }
}

// ===== RENDER TIM =====
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
    console.error('Error rendering initial teams:', error);
  }
}

renderInitial();

// ===== SOCKET EVENTS =====
socket.on("connect", () => {
  console.log('[SOCKET] Connected to server - ID: ' + socket.id);
  
  const liveIndicator = document.querySelector('.live-indicator');
  if (liveIndicator) {
    liveIndicator.style.background = '#4caf50';
    liveIndicator.textContent = '● LIVE - Terhubung ke Server';
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
    // Update scores
    if (Array.isArray(scoresData)) {
      for (let i = 0; i < scoresData.length; i++) {
        const el = document.getElementById("score-" + (i + 1));
        if (el) el.textContent = scoresData[i];
      }
    }
    
    // Update atomic lock state dari server
    if (lockStateData) {
      atomicLockState.locked = lockStateData.locked || false;
      atomicLockState.activeTeam = lockStateData.activeTeam || 0;
      atomicLockState.lockTime = lockStateData.lockTime || 0;
      atomicLockState.lockId = lockStateData.lockId || null;
      
      if (lockStateData.locked && lockStateData.activeTeam) {
        showActiveTeam(lockStateData.activeTeam);
      } else {
        resetDisplay();
      }
    }
    
    // Update toggle state
    if (Array.isArray(toggleStateData)) {
      teamToggleState = toggleStateData;
      updateTeamDisplay();
    }
    
    // Sync timer
    const time = parseInt(timerState);
    if (!isNaN(time)) {
      updateTimerDisplayOptimized(time);
    }
    
    console.log('[INIT] Initial data loaded successfully');
  })
  .catch(err => {
    console.error('Error loading initial data:', err);
  });
}

socket.on("disconnect", () => {
  console.log('[SOCKET] Disconnected from server');
  const liveIndicator = document.querySelector('.live-indicator');
  if (liveIndicator) {
    liveIndicator.style.background = '#ff4444';
    liveIndicator.textContent = '● OFFLINE - DISCONNECTED';
  }
});

// ===== ATOMIC BUZZ EVENT - OPTIMIZED =====
socket.on("buzz", ({ team }) => {
  const now = Date.now();
  
  console.log(`[BUZZ] Event received for Team ${getTeamLetter(team)} at ${now}`);
  
  // Cooldown check
  if (now - lastButtonProcessTime < BUTTON_COOLDOWN) {
    console.log(`[BUZZ] Cooldown active, ignoring`);
    return;
  }
  
  lastButtonProcessTime = now;
  
  // Atomic lock check dengan threshold 3ms
  if (!checkAtomicLock(team)) {
    console.log(`[BUZZ] Atomic lock check failed for Team ${getTeamLetter(team)}`);
    return;
  }
  
  // Set atomic lock
  setAtomicLock(team);
  
  console.log(`[BUZZ] Processing buzz for Team ${getTeamLetter(team)}`);
  
  if (teamToggleState[team - 1]) {
    // Immediate visual feedback
    showActiveTeam(team);
    
    // Play audio
    const audioSuccess = audioTim.putarAudio(team, {
      action: "startTimer",
      team: team
    });
    
    if (!audioSuccess) {
      setTimeout(() => {
        socket.emit("preTeamAudioFinished", { team: team });
      }, 300);
    }
  } else {
    console.log(`[BUZZ] Team ${getTeamLetter(team)} is disabled`);
  }
});

// Play pre-team audio (buzzer)
socket.on("playPreTeamAudio", (data) => {
  const { team, audioFile } = data;

  console.log(`[BUZZER] Memutar audio buzzer untuk Tim ${getTeamLetter(team)}`);
  
  audioTim.berhenti();
  
  const buzzerAudio = new Audio(`/audio/${audioFile}`);
  
  buzzerAudio.onerror = (e) => {
    console.error('Error memutar buzzer audio:', e);
    playTeamAudioDirectly(team);
  };
  
  buzzerAudio.onended = () => {
    console.log('[BUZZER] Buzzer selesai, lanjut ke audio tim');
    playTeamAudioDirectly(team);
    socket.emit("preTeamAudioFinished", { team: team });
  };
  
  const playPromise = buzzerAudio.play();
  if (playPromise !== undefined) {
    playPromise.catch(error => {
      console.error('Gagal memutar buzzer audio:', error);
      playTeamAudioDirectly(team);
    });
  }
});

// Update skor realtime
socket.on("update", payload => {
  const { team, score } = payload;
  
  console.log(`[UPDATE] Team ${getTeamLetter(team)} score: ${score}`);
  
  if (team && score !== undefined && team >= 1 && team <= TEAM_COUNT) {
    const el = document.getElementById("score-" + team);
    if (el) {
      el.textContent = score;
      el.classList.add('score-update');
      setTimeout(() => el.classList.remove('score-update'), 600);
    }
  }
});

// Reset semua skor
socket.on("reset", arr => {
  console.log('[RESET] All scores reset');
  
  if (Array.isArray(arr)) {
    arr.forEach((s, idx) => {
      const el = document.getElementById("score-" + (idx + 1));
      if (el) el.textContent = s;
    });
  }
});

// ===== ATOMIC LOCKSTATE EVENT =====
socket.on("lockstate", state => {
  // Update atomic lock state dari server
  atomicLockState.locked = state.locked || false;
  atomicLockState.activeTeam = state.activeTeam || 0;
  atomicLockState.lockTime = state.lockTime || 0;
  atomicLockState.lockId = state.lockId || null;
  
  console.log(`[LOCKSTATE] ${state.locked ? `Locked by Team ${getTeamLetter(state.activeTeam)} (ID: ${state.lockId})` : 'Unlocked'}`);
  
  if (!state.locked) {
    resetDisplay();
    clearAtomicLock();
  } else if (state.activeTeam) {
    showActiveTeam(state.activeTeam);
    setAtomicLock(state.activeTeam);
  }
});

// Event untuk update status toggle tim
socket.on("teamToggleUpdate", data => {
  const { team, enabled } = data;
  
  console.log(`[TOGGLE] Team ${getTeamLetter(team)} ${enabled ? 'enabled' : 'disabled'}`);
  
  if (team >= 1 && team <= TEAM_COUNT) {
    teamToggleState[team - 1] = enabled;
    updateTeamDisplay();
  }
});

// Event untuk enable semua tim
socket.on("allTeamsEnabled", () => {
  console.log('[TOGGLE] All teams enabled');
  teamToggleState = Array(TEAM_COUNT).fill(true);
  updateTeamDisplay();
});

// Event untuk disable semua tim
socket.on("allTeamsDisabled", () => {
  console.log('[TOGGLE] All teams disabled');
  teamToggleState = Array(TEAM_COUNT).fill(false);
  updateTeamDisplay();
});

// Event untuk initial team toggle state
socket.on("teamToggleState", data => {
  if (Array.isArray(data)) {
    teamToggleState = data;
    updateTeamDisplay();
  }
});

// PlayTeamAudio event
socket.on("playTeamAudio", (data) => {
  const { team, audioFile, timerDuration } = data;

  console.log(`[TEAM AUDIO] Memulai audio untuk Tim ${getTeamLetter(team)}`);
  
  const audioSuccess = audioTim.putarAudio(team, {
    action: "startTimer",
    team: team,
    timerDuration: timerDuration
  });
  
  if (!audioSuccess) {
    setTimeout(() => {
      fetch(`/audioFinished?action=startTimer&team=${team}&type=team`)
        .catch(e => console.error('Fallback failed:', e));
    }, 1000);
  }
});

// Timer Audio Events
socket.on("playTimerAudio", (data) => {
  const { seconds, audioFile } = data;
  console.log(`[TIMER AUDIO] Playing: ${audioFile} (${seconds}s)`);
  timerAudio.putarAudio(audioFile);
});

// Jury Audio Events
socket.on("playJuryAudio", (data) => {
  const { isCorrect, audioFile } = data;
  console.log(`[JURY AUDIO] Playing: ${audioFile} (${isCorrect ? 'correct' : 'wrong'})`);
  juryAudio.putarAudio(audioFile);
  
  const aiMessageEl = document.getElementById("aiMessage");
  if (aiMessageEl) {
    const message = isCorrect ? 'JAWABAN BENAR!' : 'JAWABAN SALAH!';
    aiMessageEl.textContent = message;
    aiMessageEl.classList.add("show");
    
    setTimeout(() => {
      aiMessageEl.classList.remove("show");
    }, 2000);
  }
});

// ===== PESAN AI =====
let aiMessageTimeout;

socket.on("aiMessage", (data) => {
  const aiMessageEl = document.getElementById("aiMessage");
  const message = data.message;
  const messageType = data.type || "info";

  if (!message) return;

  if (aiMessageTimeout) {
    clearTimeout(aiMessageTimeout);
    aiMessageEl.classList.remove("show");
    aiMessageEl.classList.remove("penalty-message", "warning-message", "success-message");
  }

  aiMessageEl.textContent = message;
  
  if (messageType === "penalty") {
    aiMessageEl.classList.add("penalty-message");
  } else if (messageType === "warning") {
    aiMessageEl.classList.add("warning-message");
  } else if (messageType === "success") {
    aiMessageEl.classList.add("success-message");
  }
  
  aiMessageEl.classList.add("show");
  
  aiMessageTimeout = setTimeout(() => {
    aiMessageEl.classList.remove("show");
    aiMessageEl.classList.remove("penalty-message", "warning-message", "success-message");
  }, 3000);
});

// ===== TIMER EVENTS =====
socket.on("timerStart", (data) => {
  console.log(`[TIMER] Started: ${data.duration}s`);
  if (data.duration) {
    updateTimerDisplayOptimized(data.duration);
  }
});

socket.on("timerUpdate", (data) => {
  if (timerUpdateTimeout) {
    clearTimeout(timerUpdateTimeout);
  }
  
  timerUpdateTimeout = setTimeout(() => {
    if (data.timeRemaining !== undefined) {
      updateTimerDisplayOptimized(data.timeRemaining);
    }
  }, TIMER_UPDATE_DEBOUNCE);
});

socket.on("timerReset", () => {
  console.log('[TIMER] Reset');
  
  if (timerUpdateTimeout) {
    clearTimeout(timerUpdateTimeout);
  }
  
  timerUpdateTimeout = setTimeout(() => {
    resetTimerDisplay();
    // Selalu reset display saat timer direset
    resetDisplay();
    clearAtomicLock();
  }, TIMER_UPDATE_DEBOUNCE);
});

// ===== SYSTEM UNLOCKED EVENT =====
socket.on("systemUnlocked", (data) => {
  console.log(`[SYSTEM] System unlocked: ${data.reason}`);
  
  // Reset semua state lokal
  clearAtomicLock();
  resetDisplay();
  resetTimerDisplay();
  
  // Update UI
  const timerEl = document.querySelector('.timer');
  if (timerEl) {
    timerEl.textContent = '00:00';
    timerEl.classList.remove('normal', 'warning', 'critical');
    timerEl.classList.add('inactive');
  }
  
  // Reset active team
  currentActiveTeam = 0;
  
  // Log untuk debugging
  console.log(`[SYSTEM] Display reset completed for reason: ${data.reason}`);
});

// Event untuk timer reset confirm
socket.on("timerResetConfirm", (data) => {
  resetTimerDisplay();
});

// Event untuk timer status response
socket.on("timerStatusResponse", (data) => {
  if (!data.berjalan) {
    if (lastTimerValue > 0) {
      resetTimerDisplay();
    }
    if (!data.statusKunci.locked) {
      resetDisplay();
      clearAtomicLock();
    }
  } else {
    updateTimerDisplayOptimized(data.waktuTersisa);
  }
});

// Event untuk auto penalty
socket.on("autoPenaltyToggle", (data) => {
  console.log(`[AUTO-PENALTY] ${data.enabled ? 'Enabled' : 'Disabled'}`);
});

socket.on("autoPenaltyStatus", (data) => {
  console.log(`[AUTO-PENALTY] Status: ${data.enabled ? 'ACTIVE' : 'INACTIVE'}`);
});

// ===== ESP32 STATUS EVENTS =====
socket.on("esp32Status", (status) => {
  console.log(`[ESP32] Status: ${status.connected ? 'CONNECTED' : 'DISCONNECTED'}`);
  
  // Update indikator di halaman utama jika ada
  const esp32Indicator = document.querySelector('.esp32-indicator');
  if (esp32Indicator) {
    if (status.connected) {
      esp32Indicator.style.background = '#4caf50';
      esp32Indicator.textContent = '● ESP32 ONLINE';
    } else {
      esp32Indicator.style.background = '#f44336';
      esp32Indicator.textContent = '● ESP32 OFFLINE';
    }
  }
});

// Function untuk check timer status
function checkTimerStatus() {
  socket.emit("getTimerStatus");
}

// ===== INITIALIZE =====
document.addEventListener('DOMContentLoaded', function() {
  resetTimerDisplay();
  console.log('[DISPLAY] Initialized - Responsive Button Version');
  console.log('[OPTIMIZATION] Button cooldown: 10ms, Lock threshold: 3ms');
  
  // Enable debug mode
  if (window.location.search.includes('debug=1')) {
    window.debugMode = true;
    console.log('[DEBUG] Debug mode enabled');
    
    // Log atomic lock state setiap 5 detik
    setInterval(() => {
      if (atomicLockState.locked) {
        const lockAge = Date.now() - atomicLockState.lockTime;
        console.log(`[DEBUG] Atomic Lock: Team ${getTeamLetter(atomicLockState.activeTeam)} ` +
                   `(locked ${lockAge}ms ago, ID: ${atomicLockState.lockId})`);
      }
    }, 5000);
  }
  
  // Check timer status setiap 5 detik
  setInterval(checkTimerStatus, 5000);
  
  // Check timer status awal
  setTimeout(checkTimerStatus, 1000);
});