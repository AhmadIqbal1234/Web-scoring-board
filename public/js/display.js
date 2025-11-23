﻿/*Copyright © 2025 Ridwan and Team*/
const socket = io();
const board = document.getElementById("board");
const overlay = document.getElementById("overlay");
const TEAM_COUNT = 12;
let teamToggleState = Array(TEAM_COUNT).fill(true);

// Client Logger
const clientLogger = {
  info: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[CLIENT:${timestamp}] ${message}`, data || '');
  },
  
  warn: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[CLIENT:${timestamp}] ${message}`, data || '');
  },
  
  error: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[CLIENT:${timestamp}] ${message}`, data || '');
  }
};

// SISTEM AUDIO FILE DENGAN CALLBACK
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
      audioEl.onerror = (e) => this.handleAudioError(e, teamLetter);
      
      this.audioElements.set(i, audioEl);
    }
    
    clientLogger.info('Sistem audio tim diinisialisasi');
  }

  putarAudio(team, onAudioEnd = null) {
    if (this.sedangMemutar) {
      clientLogger.info('Audio sedang diputar, menghentikan yang lama');
      this.berhenti();
    }

    const audioEl = this.audioElements.get(team);
    if (!audioEl) {
      clientLogger.error('Audio tidak ditemukan untuk tim:', team);
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
        clientLogger.info('Audio selesai diputar - executing callback');
        this.sedangMemutar = false;
        if (this.onAudioEndCallback) {
          this.executeCallback(this.onAudioEndCallback);
          this.onAudioEndCallback = null;
        }
      };

      audioEl.currentTime = 0;
      audioEl.play().then(() => {
        clientLogger.info(`Memutar audio untuk Tim ${getTeamLetter(team)}`);
        
        const aiMessageEl = document.getElementById("aiMessage");
        if (aiMessageEl) {
          aiMessageEl.textContent = `Tombol ditekan oleh Tim ${getTeamLetter(team)}!`;
          aiMessageEl.classList.add("show");
          
          setTimeout(() => {
            aiMessageEl.classList.remove("show");
          }, 3000);
        }
        
      }).catch(error => {
        clientLogger.error('Gagal memutar audio:', error);
        this.sedangMemutar = false;
        if (this.onAudioEndCallback) {
          setTimeout(() => {
            this.executeCallback(this.onAudioEndCallback);
            this.onAudioEndCallback = null;
          }, 500);
        }
      });

      return true;
      
    } catch (error) {
      clientLogger.error('Exception audio:', error);
      this.sedangMemutar = false;
      if (this.onAudioEndCallback) {
        setTimeout(() => {
          this.executeCallback(this.onAudioEndCallback);
          this.onAudioEndCallback = null;
        }, 500);
      }
      return false;
    }
  }

  handleAudioError(event, teamLetter) {
    clientLogger.error(`Error audio untuk Tim ${teamLetter}:`, event);
    this.sedangMemutar = false;
    
    if (this.onAudioEndCallback) {
      clientLogger.info('Executing callback despite audio error');
      setTimeout(() => {
        this.executeCallback(this.onAudioEndCallback);
        this.onAudioEndCallback = null;
      }, 500);
    }
  }

  executeCallback(callbackData) {
    if (callbackData && callbackData.action) {
      switch (callbackData.action) {
        case 'startTimer':
          if (callbackData.team) {
            clientLogger.info(`Memulai timer untuk Tim ${getTeamLetter(callbackData.team)} setelah audio selesai`);
            this.notifyServerAudioFinished(callbackData.team);
          }
          break;
          
        default:
          clientLogger.warn('Unknown callback action:', callbackData.action);
      }
    }
  }

  notifyServerAudioFinished(team) {
    fetch(`/audioFinished?action=startTimer&team=${team}&type=team`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        clientLogger.info('Audio finish callback successful', data);
      })
      .catch(err => {
        clientLogger.error('Audio finish callback error:', err);
        this.fallbackTimerStart(team);
      });
  }

  fallbackTimerStart(team) {
    clientLogger.warn('Using fallback timer start for team:', team);
    fetch(`/update?team=${team}&add=0&first=1`)
      .then(r => {
        if (r.ok) {
          clientLogger.info('Fallback timer start successful');
        }
      })
      .catch(e => clientLogger.error('Fallback also failed:', e));
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
    
    clientLogger.info('Sistem audio timer countdown diinisialisasi');
  }

  putarAudio(audioFile) {
    if (this.sedangMemutar) {
      this.berhenti();
    }

    const audioEl = this.audioElements.get(audioFile);
    if (!audioEl) {
      clientLogger.error('Audio timer tidak ditemukan:', audioFile);
      return false;
    }

    try {
      this.sedangMemutar = true;
      this.audioSekarang = audioEl;

      audioEl.currentTime = 0;
      audioEl.play().then(() => {
        clientLogger.info(`Memutar audio timer: ${audioFile}`);
      }).catch(error => {
        clientLogger.error('Gagal memutar audio timer:', error);
        this.sedangMemutar = false;
      });

      audioEl.onended = () => {
        this.sedangMemutar = false;
        clientLogger.info('Audio timer selesai');
        
        if (audioFile === 'waktu habis.mp3') {
          fetch(`/audioFinished?action=timerEnd&type=timer`)
            .catch(e => clientLogger.error('Timer end notification failed:', e));
        }
      };

      return true;
      
    } catch (error) {
      clientLogger.error('Exception audio timer:', error);
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
    const juryFiles = [
      'benar.mp3', 'salah.mp3'
    ];
    
    juryFiles.forEach(file => {
      const audioEl = new Audio(`/audio/${file}`);
      audioEl.preload = 'auto';
      this.audioElements.set(file, audioEl);
    });
    
    clientLogger.info('Sistem audio juri diinisialisasi');
  }

  putarAudio(audioFile) {
    if (this.sedangMemutar) {
      this.berhenti();
    }

    const audioEl = this.audioElements.get(audioFile);
    if (!audioEl) {
      clientLogger.error('Audio juri tidak ditemukan:', audioFile);
      return false;
    }

    try {
      this.sedangMemutar = true;
      this.audioSekarang = audioEl;

      audioEl.currentTime = 0;
      audioEl.play().then(() => {
        clientLogger.info(`Memutar audio juri: ${audioFile}`);
      }).catch(error => {
        clientLogger.error('Gagal memutar audio juri:', error);
        this.sedangMemutar = false;
      });

      audioEl.onended = () => {
        this.sedangMemutar = false;
        clientLogger.info('Audio juri selesai');
      };

      return true;
      
    } catch (error) {
      clientLogger.error('Exception audio juri:', error);
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

// TIMER FUNCTIONS
function updateTimerDisplay(seconds) {
    const timerEl = document.querySelector('.timer');
    if (!timerEl) return;
    
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    timerEl.textContent = `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    
    timerEl.classList.remove('warning', 'critical');
    if (seconds <= 10) {
        timerEl.classList.add('critical');
    } else if (seconds <= 30) {
        timerEl.classList.add('warning');
    }
    
    clientLogger.info(`Timer display updated`, { seconds, display: timerEl.textContent });
}

function resetTimerDisplay() {
    const timerEl = document.querySelector('.timer');
    if (timerEl) {
        timerEl.textContent = '00:00';
        timerEl.classList.remove('warning', 'critical');
        clientLogger.info(`Timer display reset to 00:00`);
    }
}

// fungsi tampilkan tim aktif
function showActiveTeam(team) {
    clientLogger.info(`Showing active team`, { team, teamLetter: getTeamLetter(team) });
    
    for (let i = 1; i <= TEAM_COUNT; i++) {
        const el = document.getElementById("team-" + i);
        if (el) {
            el.classList.remove("active", "hidden");
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
    
    clientLogger.info(`Team display updated`, { activeTeam: team, activeTeamLetter: getTeamLetter(team) });
}

// Fungsi reset tampilan
function resetDisplay() {
    clientLogger.info(`Resetting display - unlocking all teams`);
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

// Update tampilan berdasarkan status toggle tim
function updateTeamDisplay() {
    clientLogger.info('Updating team display based on toggle state', { teamToggleState });
    
    for (let i = 1; i <= TEAM_COUNT; i++) {
        const el = document.getElementById("team-" + i);
        if (el) {
            if (teamToggleState[i - 1]) {
                el.style.display = "flex";
                el.style.visibility = "visible";
                el.style.opacity = "1";
                el.style.pointerEvents = "auto";
            } else {
                el.style.display = "none";
                el.style.visibility = "hidden";
                el.style.opacity = "0";
                el.style.pointerEvents = "none";
                clientLogger.info(`Hiding team ${i} (${getTeamLetter(i)}) because it's disabled`);
            }
        } else {
            clientLogger.warn(`Team element not found: team-${i}`);
        }
    }
    
    setTimeout(() => {
        const grid = document.querySelector('.grid');
        if (grid) {
            grid.style.display = 'none';
            setTimeout(() => {
                grid.style.display = 'grid';
            }, 10);
        }
    }, 50);
    
    clientLogger.info('Team display update completed');
}

// Render tim di papan dengan memperhitungkan status toggle
function renderInitial() {
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
    clientLogger.info(`Initial teams rendered`, { teamCount: TEAM_COUNT });
    
    setTimeout(() => {
        updateTeamDisplay();
    }, 100);
}

renderInitial();

// Socket event handlers
socket.on("connect", () => {
    clientLogger.info('Connected to server');
    
    const liveIndicator = document.querySelector('.live-indicator');
    if (liveIndicator) {
        liveIndicator.style.background = '#4caf50';
        liveIndicator.textContent = '● LIVE - Terhubung ke Server';
    }
    
    Promise.all([
        fetch('/scores').then(r => r.json()),
        fetch('/lockstate').then(r => r.json()),
        fetch('/teamToggleState').then(r => r.json())
    ])
    .then(([scoresData, lockStateData, toggleStateData]) => {
        clientLogger.info('Initial scores loaded', { scores: scoresData });
        for (let i = 0; i < scoresData.length; i++) {
            const el = document.getElementById("score-" + (i + 1));
            if (el) el.textContent = scoresData[i];
        }
        
        clientLogger.info('Initial lock state loaded', { lockState: lockStateData });
        if (lockStateData.locked && lockStateData.activeTeam) {
            showActiveTeam(lockStateData.activeTeam);
        }
        
        clientLogger.info('Initial team toggle state loaded', { teamToggleState: toggleStateData });
        if (Array.isArray(toggleStateData) && toggleStateData.length === TEAM_COUNT) {
            teamToggleState = toggleStateData;
            updateTeamDisplay();
        }
    })
    .catch(err => {
        clientLogger.error('Error loading initial data:', err);
    });
});

socket.on("disconnect", () => {
    clientLogger.warn('Disconnected from server');
    const liveIndicator = document.querySelector('.live-indicator');
    if (liveIndicator) {
        liveIndicator.style.background = '#ff4444';
        liveIndicator.textContent = '● OFFLINE - DISCONNECTED';
    }
});

// Update skor realtime
socket.on("update", payload => {
    clientLogger.info('update', payload);
    const { team, score } = payload;
    const el = document.getElementById("score-" + team);
    if (el) {
        el.textContent = score;
        el.classList.add('score-update');
        setTimeout(() => el.classList.remove('score-update'), 600);
    }
});

// Reset semua skor
socket.on("reset", arr => {
    clientLogger.info('reset', { scores: arr });
    if (Array.isArray(arr)) {
        arr.forEach((s, idx) => {
            const el = document.getElementById("score-" + (idx + 1));
            if (el) el.textContent = s;
        });
    } else {
        for (let i = 1; i <= TEAM_COUNT; i++) {
            const el = document.getElementById("score-" + i);
            if (el) el.textContent = "0";
        }
    }
});

// Status kunci tim
socket.on("lockstate", state => {
    clientLogger.info('lockstate', state);
    if (!state.locked) {
        resetDisplay();
    } else if (state.activeTeam) {
        showActiveTeam(state.activeTeam);
    }
});

// Event untuk update status toggle tim individual
socket.on("teamToggleUpdate", data => {
    clientLogger.info('teamToggleUpdate', data);
    const { team, enabled } = data;
    
    if (team >= 1 && team <= TEAM_COUNT) {
        teamToggleState[team - 1] = enabled;
        clientLogger.info('Team toggle state updated', { 
            team, 
            teamLetter: getTeamLetter(team),
            enabled, 
            teamToggleState 
        });
        updateTeamDisplay();
    } else {
        clientLogger.error('Invalid team number in teamToggleUpdate', data);
    }
});

// Event untuk enable semua tim
socket.on("allTeamsEnabled", () => {
    clientLogger.info('allTeamsEnabled');
    teamToggleState = Array(TEAM_COUNT).fill(true);
    clientLogger.info('All teams enabled', { teamToggleState });
    updateTeamDisplay();
});

// Event untuk disable semua tim
socket.on("allTeamsDisabled", () => {
    clientLogger.info('allTeamsDisabled');
    teamToggleState = Array(TEAM_COUNT).fill(false);
    clientLogger.info('All teams disabled', { teamToggleState });
    updateTeamDisplay();
});

// Event untuk initial team toggle state
socket.on("teamToggleState", data => {
    clientLogger.info('teamToggleState', data);
    if (Array.isArray(data) && data.length === TEAM_COUNT) {
        teamToggleState = data;
        clientLogger.info('Team toggle state received from server', { teamToggleState });
        updateTeamDisplay();
    } else {
        clientLogger.error('Invalid team toggle state data received', data);
    }
});

// Suara tombol buzzer
socket.on("buzz", ({ team }) => {
    clientLogger.info('buzz', { team, teamLetter: getTeamLetter(team) });
    
    showActiveTeam(team);
});

// HANDLER AUDIO
socket.on("playTeamAudio", (data) => {
    clientLogger.info('playTeamAudio', data);
    const { team, audioFile, timerDuration } = data;

    clientLogger.info(`Memulai audio untuk Tim ${getTeamLetter(team)}: ${audioFile}`);
    
    const audioSuccess = audioTim.putarAudio(team, {
        action: "startTimer",
        team: team,
        timerDuration: timerDuration
    });
    
    if (!audioSuccess) {
        clientLogger.warn('Audio playback failed, using fallback');
        setTimeout(() => {
            fetch(`/audioFinished?action=startTimer&team=${team}&type=team`)
                .catch(e => clientLogger.error('Fallback audio finish failed:', e));
        }, 1000);
    }
});

socket.on("playTimerAudio", (data) => {
    clientLogger.info('playTimerAudio', data);
    const { seconds, audioFile } = data;
    
    timerAudio.putarAudio(audioFile);
});

// HANDLER AUDIO JURI
socket.on("playJuryAudio", (data) => {
    clientLogger.info('playJuryAudio', data);
    const { isCorrect, audioFile } = data;

    clientLogger.info(`Memutar audio juri: ${audioFile} (${isCorrect ? 'BENAR' : 'SALAH'})`);
    
    juryAudio.putarAudio(audioFile);
    
    const aiMessageEl = document.getElementById("aiMessage");
    if (aiMessageEl) {
        const message = isCorrect ? 'JAWABAN BENAR!' : 'JAWABAN SALAH!';
        aiMessageEl.textContent = message;
        aiMessageEl.classList.add("show");
        
        setTimeout(() => {
            aiMessageEl.classList.remove("show");
        }, 3000);
    }
});

// Pesan AI tanpa TTS
let aiMessageTimeout;

socket.on("aiMessage", (data) => {
    clientLogger.info('aiMessage', data);
    const aiMessageEl = document.getElementById("aiMessage");
    const message = data.message;

    if (!message) {
        clientLogger.info('No AI message to display');
        return;
    }

    if (aiMessageTimeout) {
        clearTimeout(aiMessageTimeout);
        aiMessageEl.classList.remove("show");
    }

    aiMessageEl.textContent = message;
    aiMessageEl.classList.add("show");

    clientLogger.info('AI Message displayed', { message });
    
    aiMessageTimeout = setTimeout(() => {
        aiMessageEl.classList.remove("show");
        clientLogger.info('AI Message hidden');
    }, 4000);
});

// TIMER EVENTS FROM SERVER
socket.on("timerStart", (data) => {
    clientLogger.info('timerStart', data);
    if (data.duration) {
        updateTimerDisplay(data.duration);
        clientLogger.info('Timer started');
    }
});

socket.on("timerUpdate", (data) => {
    clientLogger.info('timerUpdate', data);
    if (data.timeRemaining !== undefined) {
        updateTimerDisplay(data.timeRemaining);
    }
});

socket.on("timerEnd", () => {
    clientLogger.info('timerEnd');
    updateTimerDisplay(0);
});

socket.on("timerReset", () => {
    clientLogger.info('timerReset');
    resetTimerDisplay();
});

// Initialize
document.addEventListener('DOMContentLoaded', function() {
    resetTimerDisplay();
    clientLogger.info('Display initialized - IMPROVED Audio System + Timer Sync + Jury Audio + Team Toggle');
});