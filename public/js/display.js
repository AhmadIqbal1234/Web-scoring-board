﻿/* Copyright © 2025 Ridwan and Team */
const socket = io();
const board = document.getElementById("board");
const overlay = document.getElementById("overlay");
const TEAM_COUNT = 12;

// ===== ATOMIC LOCK STATE DIPERBAIKI =====
let atomicLockState = {
  locked: false,
  activeTeam: 0,
  lockTime: 0,
  lastBuzzTime: 0,
  lockId: null,
  lockSequence: 0
};

// ===== TEAM TOGGLE STATE MANAGEMENT =====
let teamToggleState = Array(TEAM_COUNT).fill(true);
let lastServerToggleState = Array(TEAM_COUNT).fill(true);

// ===== PERFORMANCE OPTIMIZATION =====
const BUTTON_COOLDOWN = 10;
let lastButtonProcessTime = 0;
let currentActiveTeam = 0;

// Timer optimization
let lastTimerValue = 0;
let timerUpdateTimeout = null;
const TIMER_UPDATE_DEBOUNCE = 30;

// ===== SISTEM AUDIO FILE DENGAN ACKNOWLEDGMENT =====
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
    
    // Kirim acknowledgment error ke server
    this.sendAudioAcknowledgment(teamLetter, false, 'team');
    
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

  // PERBAIKAN: Kirim audio acknowledgment ke server
  sendAudioAcknowledgment(team, success, audioType, audioId = null) {
    socket.emit("audioAck", {
      audioId: audioId || `team_${team}`,
      success: success,
      team: team,
      audioType: audioType,
      timestamp: Date.now()
    });
  }

  putarAudio(team, onAudioEnd = null, audioId = null) {
    if (this.sedangMemutar && this.audioSekarang === this.audioElements.get(team)) {
      return false;
    }
    
    if (this.sedangMemutar) {
      this.berhenti();
    }

    const audioEl = this.audioElements.get(team);
    if (!audioEl) {
      // Kirim acknowledgment error
      this.sendAudioAcknowledgment(team, false, 'team', audioId);
      
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
        
        // Kirim acknowledgment sukses
        this.sendAudioAcknowledgment(team, true, 'team', audioId);
        
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
            console.log(`[AUDIO] Memutar audio untuk Tim ${getTeamLetter(team)}`, { audioId });
            
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
            
            // Kirim acknowledgment error
            this.sendAudioAcknowledgment(team, false, 'team', audioId);
            
            if (onAudioEnd) {
              setTimeout(() => this.executeCallback(onAudioEnd), 100);
            }
          });
      }
      
      return true;
      
    } catch (error) {
      console.error('Exception audio:', error);
      this.sedangMemutar = false;
      
      // Kirim acknowledgment error
      this.sendAudioAcknowledgment(team, false, 'team', audioId);
      
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

// Sistem Audio untuk Timer Countdown dengan Acknowledgment
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

  // PERBAIKAN: Tambah parameter audioId
  putarAudio(audioFile, audioId = null) {
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
        playPromise.then(() => {
          console.log(`[AUDIO] Memutar audio timer: ${audioFile}`, { audioId });
        }).catch(error => {
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

// Sistem Audio untuk Juri dengan Acknowledgment
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

  // PERBAIKAN: Tambah parameter audioId
  putarAudio(audioFile, audioId = null) {
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
        playPromise.then(() => {
          console.log(`[AUDIO] Memutar audio juri: ${audioFile}`, { audioId });
        }).catch(error => {
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
  const lockThreshold = 3;
  
  if (atomicLockState.locked) {
    const lockAge = now - atomicLockState.lockTime;
    
    if (lockAge < lockThreshold) {
      console.log(`[ATOMIC] Tim ${getTeamLetter(team)} ditolak - lock terlalu baru (${lockAge}ms)`);
      return false;
    }
    
    if (atomicLockState.activeTeam !== team) {
      console.log(`[ATOMIC] Tim ${getTeamLetter(team)} ditolak - sistem terkunci oleh Tim ${getTeamLetter(atomicLockState.activeTeam)} (${lockAge}ms yang lalu)`);
      return false;
    }
    
    if (lockAge < 100) {
      console.log(`[ATOMIC] Duplikat buzz dari Tim ${getTeamLetter(team)} diabaikan`);
      return false;
    }
  }
  
  return true;
}

function setAtomicLock(team, lockId = null, lockSequence = 0) {
  atomicLockState = {
    locked: true,
    activeTeam: team,
    lockTime: Date.now(),
    lastBuzzTime: Date.now(),
    lockId: lockId || `client_lock_${Date.now()}_${team}`,
    lockSequence: lockSequence
  };
  
  console.log(`[ATOMIC] Tim ${getTeamLetter(team)} atomic locked`, { lockId, lockSequence });
}

function clearAtomicLock() {
  atomicLockState = {
    locked: false,
    activeTeam: 0,
    lockTime: 0,
    lastBuzzTime: 0,
    lockId: null,
    lockSequence: 0
  };
  
  console.log('[ATOMIC] Lock cleared');
}

// ===== TAMPILKAN TIM AKTIF DIPERBAIKI =====
function showActiveTeam(team, lockInfo = {}) {
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
    
    // PERBAIKAN: Tambah tooltip dengan info lock
    if (lockInfo.lockId) {
      activeEl.title = `Lock ID: ${lockInfo.lockId} | Sequence: ${lockInfo.lockSequence || 0}`;
    }
  }
}

function resetDisplay() {
  currentActiveTeam = 0;
  
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const el = document.getElementById("team-" + i);
    if (el) {
      el.classList.remove("active", "hidden");
      el.title = `Tim ${getTeamLetter(i)}`;
    }
  }
  overlay.classList.remove("active");
}

// ===== UPDATE TAMPILAN TIM BERDASARKAN STATUS TOGGLE =====
function updateTeamDisplay() {
  console.log('[TOGGLE] Updating team display:', teamToggleState);
  
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const el = document.getElementById("team-" + i);
    if (el) {
      if (teamToggleState[i - 1]) {
        // Tim diaktifkan
        el.style.display = "flex";
        el.style.opacity = "1";
        el.style.visibility = "visible";
        el.style.pointerEvents = "auto";
        el.classList.remove("team-disabled");
        el.classList.remove("hidden");
      } else {
        // Tim dinonaktifkan
        el.style.display = "none";
        el.style.opacity = "0";
        el.style.visibility = "hidden";
        el.style.pointerEvents = "none";
        el.classList.add("team-disabled");
      }
    }
  }
  
  // Update atribut data untuk CSS grid responsive
  const grid = document.querySelector('.grid');
  if (grid) {
    const visibleCount = teamToggleState.filter(state => state).length;
    grid.setAttribute('data-visible-teams', visibleCount);
    console.log(`[TOGGLE] Visible teams: ${visibleCount}`);
  }
}

// ===== OPTIMIZED TIMER DISPLAY DIPERBAIKI =====
function updateTimerDisplayOptimized(seconds, lockInfo = {}) {
  const timerEl = document.querySelector('.timer');
  if (!timerEl) return;
  
  if (seconds === lastTimerValue && seconds > 0) return;
  
  if (seconds <= 0) {
    if (timerEl.textContent !== '00:00') {
      timerEl.textContent = '00:00';
      timerEl.classList.remove('normal', 'warning', 'critical');
      timerEl.classList.add('inactive');
      lastTimerValue = 0;
      
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
      
      // PERBAIKAN: Tambah tooltip dengan lock info
      if (lockInfo.lockId) {
        timerEl.title = `Lock ID: ${lockInfo.lockId} | Sequence: ${lockInfo.lockSequence || 0}`;
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
    timerEl.title = '';
    lastTimerValue = 0;
  }
}

// ===== PLAY TEAM AUDIO DENGAN ACKNOWLEDGMENT =====
function playTeamAudioDirectly(team, audioId = null) {
  const audioSuccess = audioTim.putarAudio(team, {
    action: "startTimer",
    team: team
  }, audioId);
  
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
        <div class="lock-info" id="lock-info-${i}"></div>
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

// ===== SOCKET EVENTS DIPERBAIKI =====
socket.on("connect", () => {
  console.log('[SOCKET] Connected to server - ID: ' + socket.id);
  
  const liveIndicator = document.querySelector('.live-indicator');
  if (liveIndicator) {
    liveIndicator.style.background = '#4caf50';
    liveIndicator.textContent = '● LIVE - Terhubung ke Server';
    liveIndicator.title = `Socket ID: ${socket.id}`;
  }
  
  loadInitialData();
});

// PERBAIKAN: Fungsi load data awal dengan state recovery
function loadInitialData() {
  Promise.all([
    fetch('/scores').then(r => r.json()),
    fetch('/lockstate').then(r => r.json()),
    fetch('/teamToggleState').then(r => r.json()),
    fetch('/timerstatus').then(r => r.json()),
    fetch('/fullstate').then(r => r.json())
  ])
  .then(([scoresData, lockStateData, toggleStateData, timerState, fullState]) => {
    // Update scores
    if (Array.isArray(scoresData.scores)) {
      for (let i = 0; i < scoresData.scores.length; i++) {
        const el = document.getElementById("score-" + (i + 1));
        if (el) el.textContent = scoresData.scores[i];
      }
    }
    
    // Update atomic lock state dari server
    if (lockStateData) {
      atomicLockState.locked = lockStateData.locked || false;
      atomicLockState.activeTeam = lockStateData.activeTeam || 0;
      atomicLockState.lockTime = lockStateData.lockTime || 0;
      atomicLockState.lockId = lockStateData.lockId || null;
      atomicLockState.lockSequence = lockStateData.lockSequence || 0;
      
      if (lockStateData.locked && lockStateData.activeTeam) {
        showActiveTeam(lockStateData.activeTeam, {
          lockId: lockStateData.lockId,
          lockSequence: lockStateData.lockSequence
        });
      } else {
        resetDisplay();
      }
    }
    
    // PERBAIKAN: Update toggle state dengan benar
    if (Array.isArray(toggleStateData.toggleState)) {
      teamToggleState = [...toggleStateData.toggleState];
      lastServerToggleState = [...toggleStateData.toggleState];
      updateTeamDisplay(); // PASTIKAN ini dipanggil
      console.log('[INIT] Team toggle state loaded:', teamToggleState);
    }
    
    // Sync timer dengan lock info
    if (timerState) {
      updateTimerDisplayOptimized(timerState.timeRemaining || 0, {
        lockId: timerState.lockState?.lockId,
        lockSequence: timerState.lockState?.lockSequence
      });
    }
    
    // PERBAIKAN: Update lock info display
    if (lockStateData.locked && lockStateData.activeTeam) {
      const lockInfoEl = document.getElementById(`lock-info-${lockStateData.activeTeam}`);
      if (lockInfoEl) {
        lockInfoEl.textContent = `Lock: ${lockStateData.lockSequence || 0}`;
        lockInfoEl.style.display = 'block';
      }
    }
    
    console.log('[INIT] Initial data loaded successfully', {
      lockId: lockStateData.lockId,
      lockSequence: lockStateData.lockSequence,
      fullStateChecksum: fullState.checksum
    });
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
    liveIndicator.title = '';
  }
});

// ===== ATOMIC BUZZ EVENT - OPTIMIZED DENGAN LOCK INFO =====
socket.on("buzz", ({ team, lockId, timestamp }) => {
  const now = Date.now();
  
  console.log(`[BUZZ] Event received for Team ${getTeamLetter(team)} at ${now}`, { lockId });
  
  // Cooldown check
  if (now - lastButtonProcessTime < BUTTON_COOLDOWN) {
    console.log(`[BUZZ] Cooldown active, ignoring`);
    return;
  }
  
  lastButtonProcessTime = now;
  
  // Check if team is enabled
  if (!teamToggleState[team - 1]) {
    console.log(`[BUZZ] Team ${getTeamLetter(team)} is disabled, ignoring buzz`);
    return;
  }
  
  // Atomic lock check dengan threshold 3ms
  if (!checkAtomicLock(team)) {
    console.log(`[BUZZ] Atomic lock check failed for Team ${getTeamLetter(team)}`);
    return;
  }
  
  // Set atomic lock dengan lockId dari server
  setAtomicLock(team, lockId);
  
  console.log(`[BUZZ] Processing buzz for Team ${getTeamLetter(team)}`, { lockId });
  
  if (teamToggleState[team - 1]) {
    // Immediate visual feedback - TAMPILKAN TIM YANG MENEKAN
    showActiveTeam(team, { lockId });
    
    // Update lock info display
    const lockInfoEl = document.getElementById(`lock-info-${team}`);
    if (lockInfoEl) {
      lockInfoEl.textContent = `Lock: ${atomicLockState.lockSequence || 0}`;
      lockInfoEl.style.display = 'block';
    }
  } else {
    console.log(`[BUZZ] Team ${getTeamLetter(team)} is disabled`);
  }
});

// ===== EVENT HANDLER UNTUK TOGGLE TIM =====
socket.on("teamToggleUpdate", data => {
  const { team, enabled } = data;
  
  console.log(`[TOGGLE] Server update: Team ${getTeamLetter(team)} ${enabled ? 'enabled' : 'disabled'}`, data);
  
  if (team >= 1 && team <= TEAM_COUNT) {
    // Simpan status dari server
    teamToggleState[team - 1] = enabled;
    lastServerToggleState[team - 1] = enabled;
    
    // Update tampilan
    updateTeamDisplay();
    
    // Log untuk debug
    console.log(`[TOGGLE] Current toggle state for Team ${getTeamLetter(team)}: ${teamToggleState[team - 1]}`);
    console.log(`[TOGGLE] Full toggle state:`, teamToggleState);
  }
});

socket.on("allTeamsEnabled", () => {
  console.log('[TOGGLE] Server: All teams enabled');
  teamToggleState = Array(TEAM_COUNT).fill(true);
  lastServerToggleState = Array(TEAM_COUNT).fill(true);
  updateTeamDisplay();
  console.log('[TOGGLE] After all enabled:', teamToggleState);
});

socket.on("allTeamsDisabled", () => {
  console.log('[TOGGLE] Server: All teams disabled');
  teamToggleState = Array(TEAM_COUNT).fill(false);
  lastServerToggleState = Array(TEAM_COUNT).fill(false);
  updateTeamDisplay();
  console.log('[TOGGLE] After all disabled:', teamToggleState);
});

socket.on("teamToggleState", data => {
  console.log('[TOGGLE] Initial toggle state from server:', data);
  if (Array.isArray(data)) {
    teamToggleState = [...data];
    lastServerToggleState = [...data];
    updateTeamDisplay();
    console.log('[TOGGLE] After initial load:', teamToggleState);
  }
});

// ===== EVENT PLAY PRE TEAM AUDIO (BUZZER) DENGAN ACKNOWLEDGMENT =====
socket.on("playPreTeamAudio", (data) => {
  const { team, audioFile, audioId } = data;

  console.log(`[BUZZER] Memutar audio buzzer untuk Tim ${getTeamLetter(team)}`, { audioId });
  
  // Hentikan audio tim jika sedang diputar
  audioTim.berhenti();
  
  const buzzerAudio = new Audio(`/audio/${audioFile}`);
  
  buzzerAudio.onerror = (e) => {
    console.error('Error memutar buzzer audio:', e);
    
    // Kirim acknowledgment error
    socket.emit("audioAck", {
      audioId: audioId,
      success: false,
      team: team,
      audioType: 'buzzer',
      timestamp: Date.now()
    });
    
    // Jika gagal, beritahu server
    socket.emit("preTeamAudioFinished", { team: team });
  };
  
  buzzerAudio.onended = () => {
    console.log('[BUZZER] Buzzer selesai, lanjut ke audio tim');
    
    // Kirim acknowledgment sukses
    socket.emit("audioAck", {
      audioId: audioId,
      success: true,
      team: team,
      audioType: 'buzzer',
      timestamp: Date.now()
    });
    
    // Beritahu server bahwa buzzer selesai
    socket.emit("preTeamAudioFinished", { team: team });
  };
  
  const playPromise = buzzerAudio.play();
  if (playPromise !== undefined) {
    playPromise.catch(error => {
      console.error('Gagal memutar buzzer audio:', error);
      
      // Kirim acknowledgment error
      socket.emit("audioAck", {
        audioId: audioId,
        success: false,
        team: team,
        audioType: 'buzzer',
        timestamp: Date.now()
      });
      
      socket.emit("preTeamAudioFinished", { team: team });
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

// ===== ATOMIC LOCKSTATE EVENT DIPERBAIKI =====
socket.on("lockstate", state => {
  atomicLockState.locked = state.locked || false;
  atomicLockState.activeTeam = state.activeTeam || 0;
  atomicLockState.lockTime = state.lockTime || 0;
  atomicLockState.lockId = state.lockId || null;
  atomicLockState.lockSequence = state.lockSequence || 0;
  
  console.log(`[LOCKSTATE] ${state.locked ? `Locked by Team ${getTeamLetter(state.activeTeam)} (ID: ${state.lockId}, Seq: ${state.lockSequence})` : 'Unlocked'}`);
  
  // Update lock info display
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const lockInfoEl = document.getElementById(`lock-info-${i}`);
    if (lockInfoEl) {
      if (state.locked && state.activeTeam === i) {
        lockInfoEl.textContent = `Lock: ${state.lockSequence || 0}`;
        lockInfoEl.style.display = 'block';
      } else {
        lockInfoEl.style.display = 'none';
      }
    }
  }
  
  if (!state.locked) {
    resetDisplay();
    clearAtomicLock();
  } else if (state.activeTeam) {
    // JANGAN reset display jika sistem terkunci
    // Hanya tampilkan tim aktif
    showActiveTeam(state.activeTeam, {
      lockId: state.lockId,
      lockSequence: state.lockSequence
    });
    setAtomicLock(state.activeTeam, state.lockId, state.lockSequence);
  }
});

// PlayTeamAudio event dengan acknowledgment
socket.on("playTeamAudio", (data) => {
  const { team, audioFile, timerDuration, audioId } = data;

  console.log(`[TEAM AUDIO] Memulai audio untuk Tim ${getTeamLetter(team)}`, { audioId });
  
  const audioSuccess = audioTim.putarAudio(team, {
    action: "startTimer",
    team: team,
    timerDuration: timerDuration
  }, audioId);
  
  if (!audioSuccess) {
    setTimeout(() => {
      fetch(`/audioFinished?action=startTimer&team=${team}&type=team`)
        .catch(e => console.error('Fallback failed:', e));
    }, 1000);
  }
});

// Timer Audio Events dengan audioId
socket.on("playTimerAudio", (data) => {
  const { seconds, audioFile, audioId } = data;
  console.log(`[TIMER AUDIO] Playing: ${audioFile} (${seconds}s)`, { audioId });
  timerAudio.putarAudio(audioFile, audioId);
});

// Jury Audio Events dengan audioId
socket.on("playJuryAudio", (data) => {
  const { isCorrect, audioFile, audioId } = data;
  console.log(`[JURY AUDIO] Playing: ${audioFile} (${isCorrect ? 'correct' : 'wrong'})`, { audioId });
  juryAudio.putarAudio(audioFile, audioId);
  
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

// ===== TIMER EVENTS DIPERBAIKI DENGAN LOCK INFO =====
socket.on("timerStart", (data) => {
  console.log(`[TIMER] Started: ${data.duration}s`, { lockId: data.lockId });
  if (data.duration) {
    updateTimerDisplayOptimized(data.duration, {
      lockId: data.lockId,
      lockSequence: atomicLockState.lockSequence
    });
  }
  // JANGAN reset display saat timer dimulai
  // Biarkan tampilan tetap fokus pada tim yang aktif
});

socket.on("timerUpdate", (data) => {
  if (timerUpdateTimeout) {
    clearTimeout(timerUpdateTimeout);
  }
  
  timerUpdateTimeout = setTimeout(() => {
    if (data.timeRemaining !== undefined) {
      updateTimerDisplayOptimized(data.timeRemaining, {
        lockId: data.lockId,
        lockSequence: atomicLockState.lockSequence
      });
    }
  }, TIMER_UPDATE_DEBOUNCE);
});

// ===== PERBAIKAN: Event timerReset dengan lock info =====
socket.on("timerReset", (data) => {
  console.log('[TIMER] Reset', data);
  
  if (timerUpdateTimeout) {
    clearTimeout(timerUpdateTimeout);
  }
  
  timerUpdateTimeout = setTimeout(() => {
    resetTimerDisplay();
    
    // Hanya reset display jika tidak ada kunci aktif
    if (!atomicLockState.locked) {
      resetDisplay();
      clearAtomicLock();
    } else {
      console.log('[TIMER] Sistem terkunci, tetap tampilkan tim aktif', atomicLockState);
    }
  }, TIMER_UPDATE_DEBOUNCE);
});

// ===== SYSTEM UNLOCKED EVENT DIPERBAIKI =====
socket.on("systemUnlocked", (data) => {
  console.log(`[SYSTEM] System unlocked: ${data.reason}`, data);
  
  // Clear lock info display
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const lockInfoEl = document.getElementById(`lock-info-${i}`);
    if (lockInfoEl) {
      lockInfoEl.style.display = 'none';
    }
  }
  
  clearAtomicLock();
  resetDisplay();
  resetTimerDisplay();
  
  const timerEl = document.querySelector('.timer');
  if (timerEl) {
    timerEl.textContent = '00:00';
    timerEl.classList.remove('normal', 'warning', 'critical');
    timerEl.classList.add('inactive');
    timerEl.title = '';
  }
  
  currentActiveTeam = 0;
  
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
    updateTimerDisplayOptimized(data.waktuTersisa, {
      lockId: data.statusKunci.lockId,
      lockSequence: data.statusKunci.lockSequence
    });
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
  console.log(`[ESP32] Status: ${status.connected ? 'CONNECTED' : 'DISCONNECTED'}`, {
    socketId: status.socketId,
    rssi: status.wifiRSSI
  });
  
  const esp32Indicator = document.querySelector('.esp32-indicator');
  if (esp32Indicator) {
    if (status.connected) {
      esp32Indicator.style.background = '#4caf50';
      esp32Indicator.textContent = '● ESP32 ONLINE';
      esp32Indicator.title = `Socket ID: ${status.socketId || 'HTTP'} | RSSI: ${status.wifiRSSI || 'N/A'} dBm`;
    } else {
      esp32Indicator.style.background = '#f44336';
      esp32Indicator.textContent = '● ESP32 OFFLINE';
      esp32Indicator.title = '';
    }
  }
});

// PERBAIKAN: Event untuk full state sync
socket.on("fullStateSync", (data) => {
  console.log("[DISPLAY] Full state sync received", data);
  
  // Update scores
  if (data.scores && Array.isArray(data.scores)) {
    for (let i = 0; i < data.scores.length; i++) {
      const el = document.getElementById("score-" + (i + 1));
      if (el) el.textContent = data.scores[i];
    }
  }
  
  // Update lock state
  if (data.lockState) {
    atomicLockState.locked = data.lockState.locked || false;
    atomicLockState.activeTeam = data.lockState.activeTeam || 0;
    atomicLockState.lockId = data.lockState.lockId || null;
    atomicLockState.lockSequence = data.lockState.lockSequence || 0;
    
    if (data.lockState.locked && data.lockState.activeTeam) {
      showActiveTeam(data.lockState.activeTeam, {
        lockId: data.lockState.lockId,
        lockSequence: data.lockState.lockSequence
      });
    } else {
      resetDisplay();
    }
  }
  
  // Update timer
  if (data.timer) {
    updateTimerDisplayOptimized(data.timer.remaining || 0, {
      lockId: data.lockState?.lockId,
      lockSequence: data.lockState?.lockSequence
    });
  }
  
  console.log("[DISPLAY] State sync completed", {
    checksum: data.checksum,
    lockId: data.lockState?.lockId
  });
});

// Function untuk check timer status
function checkTimerStatus() {
  socket.emit("getTimerStatus");
}

// ===== DEBUG FUNCTIONS =====
function debugToggleState() {
  console.log('=== DEBUG TOGGLE STATE ===');
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const el = document.getElementById("team-" + i);
    console.log(`Team ${getTeamLetter(i)}: ${teamToggleState[i-1] ? 'Enabled' : 'Disabled'}`);
    console.log(`  Element display: ${el ? el.style.display : 'No element'}`);
    console.log(`  Element visibility: ${el ? el.style.visibility : 'No element'}`);
  }
  console.log('==========================');
}

// ===== INITIALIZE DIPERBAIKI =====
document.addEventListener('DOMContentLoaded', function() {
  resetTimerDisplay();
  console.log('[DISPLAY] Initialized - Enhanced Version 2.1.0');
  console.log('[FEATURES] Atomic lock, state recovery, audio acknowledgment');
  console.log('[SYNC] Full state recovery supported');
  
  // Enable debug mode
  if (window.location.search.includes('debug=1')) {
    window.debugMode = true;
    console.log('[DEBUG] Debug mode enabled');
    
    // Log atomic lock state setiap 5 detik
    setInterval(() => {
      if (atomicLockState.locked) {
        const lockAge = Date.now() - atomicLockState.lockTime;
        console.log(`[DEBUG] Atomic Lock: Team ${getTeamLetter(atomicLockState.activeTeam)} (locked ${lockAge}ms ago, ID: ${atomicLockState.lockId}, Seq: ${atomicLockState.lockSequence})`);
      }
      
      // Log toggle state jika perlu debug
      debugToggleState();
    }, 5000);
  }
  
  // Check timer status setiap 5 detik
  setInterval(checkTimerStatus, 5000);
  
  // Check timer status awal
  setTimeout(checkTimerStatus, 1000);
  
  // PERBAIKAN: Request full state sync setiap 30 detik untuk recovery
  setInterval(() => {
    fetch('/fullstate')
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          console.log('[DISPLAY] Periodic state sync completed', {
            checksum: data.checksum,
            lockId: data.lockState?.lockId
          });
        }
      })
      .catch(err => console.error('Periodic state sync error:', err));
  }, 30000);
});