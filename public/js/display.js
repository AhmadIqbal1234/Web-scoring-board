﻿/* Copyright © 2025 Ridwan and Team */
const socket = io();
const board = document.getElementById("board");
const overlay = document.getElementById("overlay");
const TEAM_COUNT = 12;
let teamToggleState = Array(TEAM_COUNT).fill(true);

// ===== OPTIMASI PERFORMANCE =====
const performanceLogger = {
  log: (message, data = null) => {
    if (window.performanceMode !== 'debug') return;
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[PERF:${timestamp}] ${message}`, data || '');
  }
};

// Variabel untuk mencegah double processing
let isProcessingButton = false;
let lastButtonPressTime = 0;
const BUTTON_COOLDOWN = 50; // 50ms cooldown untuk mencegah double processing
let currentActiveTeam = 0;

// Timer optimization
let lastTimerValue = 0;
let timerUpdateTimeout = null;
const TIMER_UPDATE_DEBOUNCE = 50; // Debounce timer updates

// ===== SISTEM AUDIO FILE OPTIMIZED =====
class SistemAudioTim {
  constructor() {
    this.audioElements = new Map();
    this.sedangMemutar = false;
    this.audioSekarang = null;
    this.onAudioEndCallback = null;
    this.retryCount = 0;
    this.maxRetries = 2;
    
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
    
    performanceLogger.log('Sistem audio tim diinisialisasi');
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
    if (callbackData && callbackData.action) {
      switch (callbackData.action) {
        case 'startTimer':
          if (callbackData.team) {
            this.notifyServerAudioFinished(callbackData.team);
          }
          break;
      }
    }
  }

  notifyServerAudioFinished(team) {
    fetch(`/audioFinished?action=startTimer&team=${team}&type=team`)
      .catch(err => {
        console.error('Audio finish callback error:', err);
      });
  }

  putarAudio(team, onAudioEnd = null) {
    // Cek apakah audio sedang diputar
    if (this.sedangMemutar && this.audioSekarang === this.audioElements.get(team)) {
      return false;
    }
    
    // Hentikan audio sebelumnya jika ada
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
      this.retryCount = 0;

      audioEl.onended = () => {
        this.sedangMemutar = false;
        this.retryCount = 0;
        
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
            performanceLogger.log(`Memutar audio untuk Tim ${getTeamLetter(team)}`);
            
            // Update AI message
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
            this.handlePlayError(team, onAudioEnd);
          });
      }
      
      return true;
      
    } catch (error) {
      console.error('Exception audio:', error);
      this.handlePlayError(team, onAudioEnd);
      return false;
    }
  }

  handlePlayError(team, onAudioEnd) {
    this.sedangMemutar = false;
    
    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      setTimeout(() => this.putarAudio(team, onAudioEnd), 200);
    } else {
      if (onAudioEnd) {
        setTimeout(() => {
          this.executeCallback(onAudioEnd);
        }, 100);
      }
    }
  }

  berhenti() {
    if (this.sedangMemutar && this.audioSekarang) {
      this.audioSekarang.pause();
      this.audioSekarang.currentTime = 0;
      this.sedangMemutar = false;
      this.onAudioEndCallback = null;
      this.retryCount = 0;
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

// ===== FUNGSI SINKRONISASI TIMER =====
function syncTimerWithServer() {
  fetch('/timerstate')
    .then(r => r.text())
    .then(timerState => {
      const time = parseInt(timerState);
      if (!isNaN(time)) {
        updateTimerDisplayOptimized(time);
      }
    })
    .catch(err => {
      console.error('Error syncing timer:', err);
    });
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

// ===== OPTIMIZED TIMER DISPLAY =====
function updateTimerDisplayOptimized(seconds) {
  const timerEl = document.querySelector('.timer');
  if (!timerEl) return;
  
  // Only update if value changed
  if (seconds === lastTimerValue && seconds > 0) return;
  
  // Format waktu
  if (seconds <= 0) {
    if (timerEl.textContent !== '00:00') {
      timerEl.textContent = '00:00';
      timerEl.classList.remove('normal', 'warning', 'critical');
      timerEl.classList.add('inactive');
      lastTimerValue = 0;
    }
  } else {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const newTime = `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    
    if (timerEl.textContent !== newTime) {
      timerEl.textContent = newTime;
      
      // Update warna
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

// ===== TAMPILKAN TIM AKTIF OPTIMIZED =====
function showActiveTeam(team) {
  if (!team || team < 1 || team > TEAM_COUNT) return;
  
  currentActiveTeam = team;
  
  // Hide all teams
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const el = document.getElementById("team-" + i);
    if (el) {
      el.classList.remove("active");
      if (i !== team) {
        el.classList.add("hidden");
      }
    }
  }
  
  // Show active team
  overlay.classList.add("active");
  const activeEl = document.getElementById("team-" + team);
  if (activeEl) {
    activeEl.classList.add("active");
  }
}

// Reset tampilan
function resetDisplay() {
  currentActiveTeam = 0;
  
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const el = document.getElementById("team-" + i);
    if (el) el.classList.remove("active", "hidden");
  }
  overlay.classList.remove("active");
}

// Helper tim
function getTeamLetter(index) {
  return String.fromCharCode(65 + index - 1);
}

function getTeamAudioFile(teamNumber) {
  const teamLetter = getTeamLetter(teamNumber);
  return `Tim ${teamLetter}.mp3`;
}

// Update tampilan berdasarkan status toggle tim
function updateTeamDisplay() {
  let visibleCount = 0;
  
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

// Render tim di papan
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

// ===== SOCKET EVENTS OPTIMIZED =====
socket.on("connect", () => {
  console.log('Connected to server - Socket ID: ' + socket.id);
  
  const liveIndicator = document.querySelector('.live-indicator');
  if (liveIndicator) {
    liveIndicator.style.background = '#4caf50';
    liveIndicator.textContent = '● LIVE - Terhubung ke Server';
  }
  
  loadInitialData();
  
  // Sync timer
  syncTimerWithServer();
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
    
    // Update lock state
    if (lockStateData && lockStateData.locked && lockStateData.activeTeam) {
      showActiveTeam(lockStateData.activeTeam);
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
  })
  .catch(err => {
    console.error('Error loading initial data:', err);
  });
}

socket.on("disconnect", () => {
  console.log('Disconnected from server');
  const liveIndicator = document.querySelector('.live-indicator');
  if (liveIndicator) {
    liveIndicator.style.background = '#ff4444';
    liveIndicator.textContent = '● OFFLINE - DISCONNECTED';
  }
});

// ===== BUZZ EVENT OPTIMIZED =====
socket.on("buzz", ({ team }) => {
  const now = Date.now();
  
  // Cooldown check untuk mencegah double processing
  if (now - lastButtonPressTime < BUTTON_COOLDOWN) {
    return;
  }
  
  // Check if already processing
  if (isProcessingButton) {
    return;
  }
  
  isProcessingButton = true;
  lastButtonPressTime = now;
  
  console.log('BUZZ EVENT - Team:', getTeamLetter(team));
  
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
  }
  
  // Reset processing flag setelah delay kecil
  setTimeout(() => {
    isProcessingButton = false;
  }, BUTTON_COOLDOWN);
});

// Play pre-team audio (buzzer)
socket.on("playPreTeamAudio", (data) => {
  const { team, audioFile } = data;

  console.log(`Memutar buzzer audio untuk Tim ${getTeamLetter(team)}`);
  
  // Hentikan audio tim yang sedang diputar jika ada
  audioTim.berhenti();
  
  // Memutar audio buzzer
  const buzzerAudio = new Audio(`/audio/${audioFile}`);
  
  buzzerAudio.onerror = (e) => {
    console.error('Error memutar buzzer audio:', e);
    // Jika buzzer gagal, langsung lanjut ke audio tim
    playTeamAudioDirectly(team);
  };
  
  buzzerAudio.onended = () => {
    console.log('Buzzer audio selesai, melanjutkan ke audio tim');
    // Setelah buzzer selesai, mainkan audio tim
    playTeamAudioDirectly(team);
    
    // Beri tahu server bahwa buzzer selesai
    socket.emit("preTeamAudioFinished", { team: team });
  };
  
  const playPromise = buzzerAudio.play();
  if (playPromise !== undefined) {
    playPromise.catch(error => {
      console.error('Gagal memutar buzzer audio:', error);
      // Fallback: langsung ke audio tim
      playTeamAudioDirectly(team);
    });
  }
});

// Update skor realtime
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

// Reset semua skor
socket.on("reset", arr => {
  if (Array.isArray(arr)) {
    arr.forEach((s, idx) => {
      const el = document.getElementById("score-" + (idx + 1));
      if (el) el.textContent = s;
    });
  }
});

// Status kunci tim
socket.on("lockstate", state => {
  if (!state.locked) {
    resetDisplay();
  } else if (state.activeTeam) {
    showActiveTeam(state.activeTeam);
  }
});

// Event untuk update status toggle tim
socket.on("teamToggleUpdate", data => {
  const { team, enabled } = data;
  
  if (team >= 1 && team <= TEAM_COUNT) {
    teamToggleState[team - 1] = enabled;
    updateTeamDisplay();
  }
});

// Event untuk enable semua tim
socket.on("allTeamsEnabled", () => {
  teamToggleState = Array(TEAM_COUNT).fill(true);
  updateTeamDisplay();
});

// Event untuk disable semua tim
socket.on("allTeamsDisabled", () => {
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

  console.log(`Starting audio for Team ${getTeamLetter(team)}`);
  
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
  timerAudio.putarAudio(audioFile);
});

// Jury Audio Events
socket.on("playJuryAudio", (data) => {
  const { isCorrect, audioFile } = data;
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
  
  // Tambahkan class berdasarkan tipe pesan
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
  if (data.duration) {
    updateTimerDisplayOptimized(data.duration);
  }
});

socket.on("timerUpdate", (data) => {
  // Debounce timer updates untuk performance
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
  // Gunakan debouncing untuk mencegah flikering
  if (timerUpdateTimeout) {
    clearTimeout(timerUpdateTimeout);
  }
  
  timerUpdateTimeout = setTimeout(() => {
    resetTimerDisplay();
    resetDisplay();
  }, TIMER_UPDATE_DEBOUNCE);
});

// Event untuk system unlocked
socket.on("systemUnlocked", (data) => {
  resetDisplay();
  resetTimerDisplay();
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
    }
  } else {
    updateTimerDisplayOptimized(data.waktuTersisa);
  }
});

// Event untuk auto penalty
socket.on("autoPenaltyToggle", (data) => {
  console.log(`Penalti otomatis ${data.enabled ? 'diaktifkan' : 'dinonaktifkan'}`);
});

socket.on("autoPenaltyStatus", (data) => {
  console.log(`Penalti otomatis: ${data.enabled ? 'AKTIF' : 'NONAKTIF'}`);
});

// Function untuk check timer status
function checkTimerStatus() {
  socket.emit("getTimerStatus");
}

// ===== INITIALIZE =====
document.addEventListener('DOMContentLoaded', function() {
  resetTimerDisplay();
  console.log('Display initialized - Optimized for fast response');
  
  // Enable debug mode dengan URL parameter
  if (window.location.search.includes('debug=1')) {
    window.performanceMode = 'debug';
    console.log('Performance debug mode enabled');
  }
  
  // Check timer status setiap 5 detik
  setInterval(checkTimerStatus, 5000);
  
  // Sync timer dengan server setiap 3 detik
  setInterval(syncTimerWithServer, 3000);
  
  // Check timer status awal
  setTimeout(checkTimerStatus, 1000);
});