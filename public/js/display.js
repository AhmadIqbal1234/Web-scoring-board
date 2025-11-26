﻿/*Copyright © 2025 Ridwan and Team*/
const socket = io();
const board = document.getElementById("board");
const overlay = document.getElementById("overlay");
const TEAM_COUNT = 12;
let teamToggleState = Array(TEAM_COUNT).fill(true);

// Enhanced Client Logger
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
  },
  
  success: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[CLIENT:${timestamp}] ${message}`, data || '');
  }
};

// Debug semua socket events
console.log('Setting up socket debugging...');

const originalEmit = socket.emit;
socket.emit = function(event, data) {
    console.log(`[SOCKET EMIT] ${event}:`, data);
    return originalEmit.call(this, event, data);
};

const originalOn = socket.on;
socket.on = function(event, callback) {
    return originalOn.call(this, event, function(data) {
        console.log(`[SOCKET RECEIVE] ${event}:`, data);
        callback(data);
    });
};

// SISTEM AUDIO FILE
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
    
    clientLogger.success('Sistem audio tim diinisialisasi');
  }

  handleAudioError(event, teamLetter, audioFile) {
    clientLogger.error(`Error audio untuk Tim ${teamLetter}:`, { 
      audioFile, 
      error: event.target.error 
    });
    this.sedangMemutar = false;
    
    if (this.onAudioEndCallback) {
      setTimeout(() => {
        this.executeCallback(this.onAudioEndCallback);
        this.onAudioEndCallback = null;
      }, 500);
    }
  }

  putarAudio(team, onAudioEnd = null) {
    if (this.sedangMemutar) {
      clientLogger.warn('Audio sedang diputar, menghentikan yang lama');
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
      this.retryCount = 0;

      audioEl.onended = () => {
        clientLogger.success('Audio selesai diputar - executing callback');
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
            clientLogger.success(`Memutar audio untuk Tim ${getTeamLetter(team)}`);
            
            const aiMessageEl = document.getElementById("aiMessage");
            if (aiMessageEl) {
              aiMessageEl.textContent = `Tombol ditekan oleh Tim ${getTeamLetter(team)}!`;
              aiMessageEl.classList.add("show");
              
              setTimeout(() => {
                aiMessageEl.classList.remove("show");
              }, 3000);
            }
          })
          .catch(error => {
            clientLogger.error('Gagal memutar audio:', error);
            this.handlePlayError(team, onAudioEnd);
          });
      }
      
      return true;
      
    } catch (error) {
      clientLogger.error('Exception audio:', error);
      this.handlePlayError(team, onAudioEnd);
      return false;
    }
  }

  handlePlayError(team, onAudioEnd) {
    this.sedangMemutar = false;
    
    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      clientLogger.warn(`Retry ${this.retryCount} untuk audio tim ${team}`);
      setTimeout(() => this.putarAudio(team, onAudioEnd), 500);
    } else {
      if (onAudioEnd) {
        setTimeout(() => {
          this.executeCallback(onAudioEnd);
        }, 500);
      }
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
        clientLogger.success('Audio finish callback successful', data);
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
          clientLogger.success('Fallback timer start successful');
        }
      })
      .catch(e => clientLogger.error('Fallback juga gagal:', e));
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
      audioEl.onerror = (e) => {
        clientLogger.error(`Error audio timer ${file}:`, e.target.error);
      };
      this.audioElements.set(file, audioEl);
    });
    
    clientLogger.success('Sistem audio timer countdown diinisialisasi');
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
      
      const playPromise = audioEl.play();
      
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            clientLogger.success(`Memutar audio timer: ${audioFile}`);
          })
          .catch(error => {
            clientLogger.error('Gagal memutar audio timer:', error);
            this.sedangMemutar = false;
          });
      }

      audioEl.onended = () => {
        this.sedangMemutar = false;
        clientLogger.success('Audio timer selesai');
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
      audioEl.onerror = (e) => {
        clientLogger.error(`Error audio juri ${file}:`, e.target.error);
      };
      this.audioElements.set(file, audioEl);
    });
    
    clientLogger.success('Sistem audio juri diinisialisasi');
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
      
      const playPromise = audioEl.play();
      
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            clientLogger.success(`Memutar audio juri: ${audioFile}`);
          })
          .catch(error => {
            clientLogger.error('Gagal memutar audio juri:', error);
            this.sedangMemutar = false;
          });
      }

      audioEl.onended = () => {
        this.sedangMemutar = false;
        clientLogger.success('Audio juri selesai');
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
    if (!timerEl) {
      clientLogger.error('Timer element not found');
      return;
    }
    
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    timerEl.textContent = `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    
    timerEl.classList.remove('warning', 'critical');
    if (seconds <= 10) {
        timerEl.classList.add('critical');
    } else if (seconds <= 30) {
        timerEl.classList.add('warning');
    }
}

function resetTimerDisplay() {
    const timerEl = document.querySelector('.timer');
    if (timerEl) {
        timerEl.textContent = '00:00';
        timerEl.classList.remove('warning', 'critical');
    }
}

// fungsi tampilkan tim aktif
function showActiveTeam(team) {
    if (!team || team < 1 || team > TEAM_COUNT) {
        clientLogger.error('Invalid team for showActiveTeam:', team);
        return;
    }
    
    clientLogger.info(`Showing active team ${team}`);
    
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
}

// Fungsi reset tampilan
function resetDisplay() {
    clientLogger.info(`Resetting display`);
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
    clientLogger.info('Updating team display based on toggle state');
    
    let visibleCount = 0;
    
    for (let i = 1; i <= TEAM_COUNT; i++) {
        const el = document.getElementById("team-" + i);
        if (el) {
            if (teamToggleState[i - 1]) {
                el.style.display = "flex";
                el.style.visibility = "visible";
                el.style.opacity = "1";
                el.style.pointerEvents = "auto";
                visibleCount++;
            } else {
                el.style.display = "none";
                el.style.visibility = "hidden";
                el.style.opacity = "0";
                el.style.pointerEvents = "none";
            }
        }
    }
    
    const grid = document.querySelector('.grid');
    if (grid) {
        grid.setAttribute('data-visible-teams', visibleCount);
    }
    
    clientLogger.success(`${visibleCount} teams visible`);
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
        clientLogger.success(`Initial teams rendered`);
        
        setTimeout(() => {
            updateTeamDisplay();
        }, 100);
    } catch (error) {
        clientLogger.error('Error rendering initial teams:', error);
    }
}

renderInitial();

// Socket event handlers
socket.on("connect", () => {
    clientLogger.success('Connected to server - Socket ID: ' + socket.id);
    
    const liveIndicator = document.querySelector('.live-indicator');
    if (liveIndicator) {
        liveIndicator.style.background = '#4caf50';
        liveIndicator.textContent = '● LIVE - Terhubung ke Server';
    }
    
    socket.emit('ping', { timestamp: Date.now(), message: 'Hello from client!' });
    
    loadInitialData();
});

// Function untuk load initial data
function loadInitialData() {
    console.log('Loading initial data from server...');
    
    Promise.all([
        fetch('/scores').then(r => {
            console.log('Scores response status:', r.status);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        }),
        fetch('/lockstate').then(r => {
            console.log('Lockstate response status:', r.status);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        }),
        fetch('/teamToggleState').then(r => {
            console.log('ToggleState response status:', r.status);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
    ])
    .then(([scoresData, lockStateData, toggleStateData]) => {
        console.log('All initial data loaded successfully');
        console.log('Scores:', scoresData);
        console.log('LockState:', lockStateData);
        console.log('ToggleState:', toggleStateData);
        
        if (Array.isArray(scoresData)) {
            for (let i = 0; i < scoresData.length; i++) {
                const el = document.getElementById("score-" + (i + 1));
                if (el) el.textContent = scoresData[i];
            }
        }
        
        if (lockStateData && lockStateData.locked && lockStateData.activeTeam) {
            console.log('Active team from lockstate:', lockStateData.activeTeam);
            showActiveTeam(lockStateData.activeTeam);
        }
        
        if (Array.isArray(toggleStateData)) {
            teamToggleState = toggleStateData;
            updateTeamDisplay();
        }
    })
    .catch(err => {
        console.error('Error loading initial data:', err);
    });
}

socket.on("pong", (data) => {
    console.log('Pong received from server:', data);
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
    console.log('Score update received from server:', payload);
    const { team, score } = payload;
    
    if (team && score !== undefined && team >= 1 && team <= TEAM_COUNT) {
        const el = document.getElementById("score-" + team);
        if (el) {
            el.textContent = score;
            el.classList.add('score-update');
            setTimeout(() => el.classList.remove('score-update'), 600);
            
            clientLogger.success(`Score updated for team ${team}: ${score}`);
        } else {
            clientLogger.error(`Score element not found for team: ${team}`);
        }
    } else {
        clientLogger.error('Invalid score update payload:', payload);
    }
});

// Reset semua skor
socket.on("reset", arr => {
    console.log('Reset scores received:', arr);
    if (Array.isArray(arr)) {
        arr.forEach((s, idx) => {
            const el = document.getElementById("score-" + (idx + 1));
            if (el) el.textContent = s;
        });
    }
});

// Status kunci tim
socket.on("lockstate", state => {
    console.log('Lock state update:', state);
    if (!state.locked) {
        resetDisplay();
    } else if (state.activeTeam) {
        showActiveTeam(state.activeTeam);
    }
});

// Event untuk update status toggle tim individual
socket.on("teamToggleUpdate", data => {
    console.log('Team toggle update:', data);
    const { team, enabled } = data;
    
    if (team >= 1 && team <= TEAM_COUNT) {
        teamToggleState[team - 1] = enabled;
        updateTeamDisplay();
        clientLogger.info(`Team ${getTeamLetter(team)} ${enabled ? 'enabled' : 'disabled'}`);
    }
});

// Event untuk enable semua tim
socket.on("allTeamsEnabled", () => {
    console.log('All teams enabled received');
    teamToggleState = Array(TEAM_COUNT).fill(true);
    updateTeamDisplay();
    clientLogger.info('All teams enabled');
});

// Event untuk disable semua tim
socket.on("allTeamsDisabled", () => {
    console.log('All teams disabled received');
    teamToggleState = Array(TEAM_COUNT).fill(false);
    updateTeamDisplay();
    clientLogger.info('All teams disabled');
});

// Event untuk initial team toggle state
socket.on("teamToggleState", data => {
    console.log('Team toggle state received:', data);
    if (Array.isArray(data)) {
        teamToggleState = data;
        updateTeamDisplay();
        clientLogger.info('Team toggle state initialized from server');
    }
});

// Buzz event
socket.on("buzz", ({ team }) => {
    console.log('BUZZ EVENT RECEIVED - Team:', team);
    console.log('Current teamToggleState:', teamToggleState);
    
    if (teamToggleState[team - 1]) {
        console.log('Team is enabled, showing active team');
        showActiveTeam(team);
    } else {
        console.log('Team is disabled, ignoring buzz');
    }
});

// PlayTeamAudio event
socket.on("playTeamAudio", (data) => {
    console.log('PLAY TEAM AUDIO EVENT:', data);
    const { team, audioFile, timerDuration } = data;

    console.log(`Starting audio for Team ${getTeamLetter(team)}: ${audioFile}`);
    
    const audioSuccess = audioTim.putarAudio(team, {
        action: "startTimer",
        team: team,
        timerDuration: timerDuration
    });
    
    console.log('Audio playback result:', audioSuccess);
    
    if (!audioSuccess) {
        console.warn('Audio playback failed, using fallback');
        setTimeout(() => {
            console.log('Executing fallback timer start');
            fetch(`/audioFinished?action=startTimer&team=${team}&type=team`)
                .then(r => r.json())
                .then(data => console.log('Fallback result:', data))
                .catch(e => console.error('Fallback failed:', e));
        }, 1000);
    }
});

socket.on("playTimerAudio", (data) => {
    console.log('Play timer audio:', data);
    const { seconds, audioFile } = data;
    
    timerAudio.putarAudio(audioFile);
});

// HANDLER AUDIO JURI
socket.on("playJuryAudio", (data) => {
    console.log('Play jury audio:', data);
    const { isCorrect, audioFile } = data;

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

// Pesan AI
let aiMessageTimeout;

socket.on("aiMessage", (data) => {
    console.log('AI message:', data);
    const aiMessageEl = document.getElementById("aiMessage");
    const message = data.message;

    if (!message) return;

    if (aiMessageTimeout) {
        clearTimeout(aiMessageTimeout);
        aiMessageEl.classList.remove("show");
    }

    aiMessageEl.textContent = message;
    aiMessageEl.classList.add("show");
    
    aiMessageTimeout = setTimeout(() => {
        aiMessageEl.classList.remove("show");
    }, 4000);
});

// TIMER EVENTS FROM SERVER
socket.on("timerStart", (data) => {
    console.log('Timer start:', data);
    if (data.duration) {
        updateTimerDisplay(data.duration);
    }
});

socket.on("timerUpdate", (data) => {
    if (data.timeRemaining !== undefined) {
        updateTimerDisplay(data.timeRemaining);
    }
});

socket.on("timerEnd", () => {
    console.log('Timer end received');
    updateTimerDisplay(0);
});

socket.on("timerReset", () => {
    console.log('Timer reset received');
    resetTimerDisplay();
});

// Initialize
document.addEventListener('DOMContentLoaded', function() {
    resetTimerDisplay();
    console.log('Display initialized - Enhanced debugging enabled');
});