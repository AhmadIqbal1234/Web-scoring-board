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

// VARIABEL GLOBAL UNTUK MENCEGAH DOUBLE AUDIO
let isPlayingAudio = false;
let currentPlayingAudio = null;
let isBuzzerPlaying = false;

// TIMER STABILIZATION VARIABLES
let lastTimerValue = 0;
let timerStableTimeout = null;
let lastTimerEventTime = 0;
const TIMER_EVENT_DEBOUNCE = 50; // ms

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
    
    // Reset global flags
    isPlayingAudio = false;
    currentPlayingAudio = null;
    isBuzzerPlaying = false;
    
    if (this.onAudioEndCallback) {
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

  putarAudio(team, onAudioEnd = null) {
    // Cek apakah audio sedang diputar
    if (isPlayingAudio && currentPlayingAudio === team) {
      console.log('Audio untuk tim ini sudah diputar, mengabaikan');
      return false;
    }
    
    // Hentikan audio sebelumnya jika ada
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
      
      // Set global flag
      isPlayingAudio = true;
      currentPlayingAudio = team;
      isBuzzerPlaying = false; // Reset buzzer flag

      audioEl.onended = () => {
        clientLogger.success('Audio selesai diputar - executing callback');
        this.sedangMemutar = false;
        this.retryCount = 0;
        
        // Reset global flags
        isPlayingAudio = false;
        currentPlayingAudio = null;
        
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
            
            // Reset global flags jika error
            isPlayingAudio = false;
            currentPlayingAudio = null;
            isBuzzerPlaying = false;
            
            this.handlePlayError(team, onAudioEnd);
          });
      }
      
      return true;
      
    } catch (error) {
      clientLogger.error('Exception audio:', error);
      
      // Reset global flags jika error
      isPlayingAudio = false;
      currentPlayingAudio = null;
      isBuzzerPlaying = false;
      
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
      // Reset global flags
      isPlayingAudio = false;
      currentPlayingAudio = null;
      isBuzzerPlaying = false;
      
      if (onAudioEnd) {
        setTimeout(() => {
          this.executeCallback(onAudioEnd);
        }, 500);
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
      
      // Reset global flags
      isPlayingAudio = false;
      currentPlayingAudio = null;
      isBuzzerPlaying = false;
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

// ===== FUNGSI SINKRONISASI TIMER DENGAN SERVER =====
function syncTimerWithServer() {
    fetch('/timerstate')
        .then(r => r.text())
        .then(timerState => {
            const time = parseInt(timerState);
            if (!isNaN(time)) {
                const timerEl = document.querySelector('.timer');
                if (timerEl) {
                    if (time <= 0) {
                        timerEl.textContent = '00:00';
                        lastTimerValue = 0;
                    } else {
                        const minutes = Math.floor(time / 60);
                        const seconds = time % 60;
                        timerEl.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                        lastTimerValue = time;
                    }
                    
                    // Update warna timer
                    updateTimerColor(time);
                }
            }
        })
        .catch(err => {
            clientLogger.error('Error syncing timer:', err);
        });
}

// ===== HANDLER BARU UNTUK PRE-TEAM AUDIO (BUZZER) =====
function playTeamAudioDirectly(team) {
    clientLogger.info('Memutar audio tim langsung untuk Tim', getTeamLetter(team));
    
    const audioSuccess = audioTim.putarAudio(team, {
        action: "startTimer",
        team: team
    });
    
    if (!audioSuccess) {
        clientLogger.warn('Audio playback failed, using fallback');
        setTimeout(() => {
            // Beritahu server untuk mulai timer
            socket.emit("preTeamAudioFinished", { team: team });
        }, 500);
    }
}

// ===== FUNGSI UPDATE WARNA TIMER =====
function updateTimerColor(seconds) {
    const timerEl = document.querySelector('.timer');
    if (!timerEl) return;
    
    // Hapus semua class warna sebelumnya
    timerEl.classList.remove('normal', 'warning', 'critical', 'inactive');
    
    if (seconds <= 0) {
        // Timer 00:00 atau tidak aktif - HIJAU TANPA ANIMASI
        timerEl.classList.add('inactive');
    } else if (seconds <= 10) {
        // ≤10 detik - MERAH dengan animasi
        timerEl.classList.add('critical');
    } else if (seconds <= 30) {
        // ≤30 detik - ORANGE dengan animasi
        timerEl.classList.add('warning');
    } else {
        // >30 detik - HIJAU normal
        timerEl.classList.add('normal');
    }
}

// TIMER FUNCTIONS
function updateTimerDisplay(seconds) {
    const timerEl = document.querySelector('.timer');
    if (!timerEl) {
      clientLogger.error('Timer element not found');
      return;
    }
    
    // Format yang konsisten
    if (seconds <= 0) {
        timerEl.textContent = '00:00';
    } else {
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        timerEl.textContent = `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    
    // Update warna berdasarkan waktu tersisa
    updateTimerColor(seconds);
    
    lastTimerValue = seconds;
}

function resetTimerDisplay() {
    const timerEl = document.querySelector('.timer');
    if (timerEl) {
        timerEl.textContent = '00:00';
        timerEl.classList.remove('normal', 'warning', 'critical');
        timerEl.classList.add('inactive'); // PASTIKAN HIJAU SAAT RESET
        lastTimerValue = 0;
        clientLogger.info('Timer display reset to 00:00 (inactive green)');
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
    clientLogger.info('Display reset - all teams visible');
}

// Helper tim
function getTeamLetter(index) {
    return String.fromCharCode(65 + index - 1);
}

// Get audio file name untuk tim
function getTeamAudioFile(teamNumber) {
    const teamLetter = getTeamLetter(teamNumber);
    return `Tim ${teamLetter}.mp3`;
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
    
    // Sync timer saat pertama connect
    syncTimerWithServer();
});

// Function untuk load initial data
function loadInitialData() {
    clientLogger.info('Loading initial data from server...');
    
    Promise.all([
        fetch('/scores').then(r => {
            clientLogger.info('Scores response status:', r.status);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        }),
        fetch('/lockstate').then(r => {
            clientLogger.info('Lockstate response status:', r.status);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        }),
        fetch('/teamToggleState').then(r => {
            clientLogger.info('ToggleState response status:', r.status);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        }),
        fetch('/timerstate').then(r => {
            clientLogger.info('Timerstate response status:', r.status);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.text();
        })
    ])
    .then(([scoresData, lockStateData, toggleStateData, timerState]) => {
        clientLogger.info('All initial data loaded successfully');
        
        if (Array.isArray(scoresData)) {
            for (let i = 0; i < scoresData.length; i++) {
                const el = document.getElementById("score-" + (i + 1));
                if (el) el.textContent = scoresData[i];
            }
        }
        
        if (lockStateData && lockStateData.locked && lockStateData.activeTeam) {
            clientLogger.info('Active team from lockstate:', lockStateData.activeTeam);
            showActiveTeam(lockStateData.activeTeam);
        }
        
        if (Array.isArray(toggleStateData)) {
            teamToggleState = toggleStateData;
            updateTeamDisplay();
        }
        
        // Sync timer dari server
        const time = parseInt(timerState);
        if (!isNaN(time)) {
            updateTimerDisplay(time);
        }
    })
    .catch(err => {
        clientLogger.error('Error loading initial data:', err);
    });
}

socket.on("pong", (data) => {
    clientLogger.info('Pong received from server:', data);
});

socket.on("disconnect", () => {
    clientLogger.warn('Disconnected from server');
    const liveIndicator = document.querySelector('.live-indicator');
    if (liveIndicator) {
        liveIndicator.style.background = '#ff4444';
        liveIndicator.textContent = '● OFFLINE - DISCONNECTED';
    }
});

// ===== HANDLER UNTUK PRE-TEAM AUDIO (BUZZER) =====
socket.on("playPreTeamAudio", (data) => {
    clientLogger.info('PLAY PRE-TEAM AUDIO (BUZZER):', data);
    const { team, audioFile } = data;

    clientLogger.info(`Memutar buzzer audio: ${audioFile} untuk Tim ${getTeamLetter(team)}`);
    
    // Hentikan audio tim yang sedang diputar jika ada
    audioTim.berhenti();
    
    // Set flag bahwa buzzer sedang diputar
    isBuzzerPlaying = true;
    
    // Memutar audio buzzer
    const buzzerAudio = new Audio(`/audio/${audioFile}`);
    
    buzzerAudio.onerror = (e) => {
        clientLogger.error('Error memutar buzzer audio:', e);
        // Reset flag
        isBuzzerPlaying = false;
        // Jika buzzer gagal, langsung lanjut ke audio tim
        playTeamAudioDirectly(team);
    };
    
    buzzerAudio.onended = () => {
        clientLogger.info('Buzzer audio selesai, melanjutkan ke audio tim');
        // Reset flag
        isBuzzerPlaying = false;
        // Setelah buzzer selesai, mainkan audio tim
        playTeamAudioDirectly(team);
        
        // Beri tahu server bahwa buzzer selesai (optional)
        socket.emit("preTeamAudioFinished", { team: team });
    };
    
    const playPromise = buzzerAudio.play();
    if (playPromise !== undefined) {
        playPromise.catch(error => {
            clientLogger.error('Gagal memutar buzzer audio:', error);
            // Reset flag
            isBuzzerPlaying = false;
            // Fallback: langsung ke audio tim
            playTeamAudioDirectly(team);
        });
    }
});

// Update skor realtime
socket.on("update", payload => {
    clientLogger.info('Score update received from server:', payload);
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
    clientLogger.info('Reset scores received:', arr);
    if (Array.isArray(arr)) {
        arr.forEach((s, idx) => {
            const el = document.getElementById("score-" + (idx + 1));
            if (el) el.textContent = s;
        });
    }
});

// Status kunci tim
socket.on("lockstate", state => {
    clientLogger.info('Lock state update:', state);
    if (!state.locked) {
        resetDisplay();
    } else if (state.activeTeam) {
        showActiveTeam(state.activeTeam);
    }
});

// Event untuk update status toggle tim individual
socket.on("teamToggleUpdate", data => {
    clientLogger.info('Team toggle update:', data);
    const { team, enabled } = data;
    
    if (team >= 1 && team <= TEAM_COUNT) {
        teamToggleState[team - 1] = enabled;
        updateTeamDisplay();
        clientLogger.info(`Team ${getTeamLetter(team)} ${enabled ? 'enabled' : 'disabled'}`);
    }
});

// Event untuk enable semua tim
socket.on("allTeamsEnabled", () => {
    clientLogger.info('All teams enabled received');
    teamToggleState = Array(TEAM_COUNT).fill(true);
    updateTeamDisplay();
    clientLogger.info('All teams enabled');
});

// Event untuk disable semua tim
socket.on("allTeamsDisabled", () => {
    clientLogger.info('All teams disabled received');
    teamToggleState = Array(TEAM_COUNT).fill(false);
    updateTeamDisplay();
    clientLogger.info('All teams disabled');
});

// Event untuk initial team toggle state
socket.on("teamToggleState", data => {
    clientLogger.info('Team toggle state received:', data);
    if (Array.isArray(data)) {
        teamToggleState = data;
        updateTeamDisplay();
        clientLogger.info('Team toggle state initialized from server');
    }
});

// Buzz event
socket.on("buzz", ({ team }) => {
    clientLogger.info('BUZZ EVENT RECEIVED - Team:', team);
    
    if (teamToggleState[team - 1]) {
        clientLogger.info('Team is enabled, showing active team');
        showActiveTeam(team);
    } else {
        clientLogger.info('Team is disabled, ignoring buzz');
    }
});

// PlayTeamAudio event - HANYA SEBAGAI BACKUP
socket.on("playTeamAudio", (data) => {
    clientLogger.info('PLAY TEAM AUDIO EVENT (BACKUP):', data);
    const { team, audioFile, timerDuration } = data;

    clientLogger.info(`Starting audio for Team ${getTeamLetter(team)}: ${audioFile} (BACKUP SYSTEM)`);
    
    // Cek apakah audio sudah diputar oleh sistem utama
    if (!isPlayingAudio || currentPlayingAudio !== team) {
        const audioSuccess = audioTim.putarAudio(team, {
            action: "startTimer",
            team: team,
            timerDuration: timerDuration
        });
        
        clientLogger.info('Audio playback result:', audioSuccess);
        
        if (!audioSuccess) {
            clientLogger.warn('Audio playback failed, using fallback');
            setTimeout(() => {
                clientLogger.info('Executing fallback timer start');
                fetch(`/audioFinished?action=startTimer&team=${team}&type=team`)
                    .then(r => r.json())
                    .then(data => clientLogger.info('Fallback result:', data))
                    .catch(e => clientLogger.error('Fallback failed:', e));
            }, 1000);
        }
    } else {
        clientLogger.info('Audio sudah diputar oleh sistem utama, mengabaikan backup');
    }
});

// Timer Audio Events
socket.on("playTimerAudio", (data) => {
    clientLogger.info('Play timer audio:', data);
    const { seconds, audioFile } = data;
    
    timerAudio.putarAudio(audioFile);
});

// HANDLER AUDIO JURI
socket.on("playJuryAudio", (data) => {
    clientLogger.info('Play jury audio:', data);
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

// ===== PESAN AI DENGAN TYPE SUPPORT =====
let aiMessageTimeout;

socket.on("aiMessage", (data) => {
    clientLogger.info('AI message:', data);
    const aiMessageEl = document.getElementById("aiMessage");
    const message = data.message;
    const messageType = data.type || "info"; // Default ke info jika tidak ada type

    if (!message) return;

    if (aiMessageTimeout) {
        clearTimeout(aiMessageTimeout);
        aiMessageEl.classList.remove("show");
        aiMessageEl.classList.remove("penalty-message");
        aiMessageEl.classList.remove("warning-message");
        aiMessageEl.classList.remove("success-message");
    }

    aiMessageEl.textContent = message;
    
    // Hapus semua class pesan sebelumnya
    aiMessageEl.classList.remove("penalty-message", "warning-message", "success-message");
    
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
        aiMessageEl.classList.remove("penalty-message");
        aiMessageEl.classList.remove("warning-message");
        aiMessageEl.classList.remove("success-message");
    }, 4000);
});

// ===== TIMER EVENTS FROM SERVER =====
socket.on("timerStart", (data) => {
    clientLogger.info('Timer start CLIENT:', data, 'at', Date.now());
    if (data.duration) {
        lastTimerEventTime = Date.now();
        updateTimerDisplay(data.duration);
    }
});

socket.on("timerUpdate", (data) => {
    clientLogger.info('Timer update:', data, 'at', Date.now());
    
    // Debouncing untuk mencegah update terlalu cepat
    const now = Date.now();
    if (now - lastTimerEventTime < TIMER_EVENT_DEBOUNCE) {
        clientLogger.info('Debouncing timer update, terlalu cepat');
        return;
    }
    
    lastTimerEventTime = now;
    
    if (data.timeRemaining !== undefined) {
        updateTimerDisplay(data.timeRemaining);
    }
});

socket.on("timerReset", () => {
    const now = Date.now();
    clientLogger.info('Timer reset received - resetting display to 00:00 at', now);
    
    // Gunakan debouncing untuk mencegah flikering
    if (timerStableTimeout) {
        clearTimeout(timerStableTimeout);
    }
    
    timerStableTimeout = setTimeout(() => {
        resetTimerDisplay(); // Reset ke hijau
        resetDisplay();
        clientLogger.info('Timer display reset to 00:00 (green) after debouncing');
    }, TIMER_EVENT_DEBOUNCE);
});

// Event untuk system unlocked
socket.on("systemUnlocked", (data) => {
    clientLogger.info('System unlocked:', data);
    
    // Reset tampilan
    resetDisplay();
    
    // Reset timer ke hijau
    resetTimerDisplay();
    
    // Tampilkan notifikasi jika ada
    if (data.reason === "timer_expired") {
        clientLogger.info('System unlocked due to timer expiration');
    } else if (data.reason === "auto_penalty_applied") {
        clientLogger.info('System unlocked after auto penalty');
    }
});

// Event untuk timer reset confirm
socket.on("timerResetConfirm", (data) => {
    clientLogger.info('Timer reset confirmed:', data);
    resetTimerDisplay();
});

// Event untuk timer status response
socket.on("timerStatusResponse", (data) => {
    clientLogger.info('Timer status response:', data);
    if (!data.berjalan) {
        // Hanya reset jika benar-benar tidak berjalan
        if (lastTimerValue > 0) {
            resetTimerDisplay();
        }
        if (!data.statusKunci.locked) {
            resetDisplay();
        }
    } else {
        updateTimerDisplay(data.waktuTersisa);
    }
});

// Event untuk auto penalty
socket.on("autoPenaltyToggle", (data) => {
    clientLogger.info('Auto penalty toggle:', data);
    const status = data.enabled ? 'diaktifkan' : 'dinonaktifkan';
    clientLogger.info(`Penalti otomatis ${status}`);
});

socket.on("autoPenaltyStatus", (data) => {
    clientLogger.info('Auto penalty status:', data);
    clientLogger.info(`Penalti otomatis: ${data.enabled ? 'AKTIF' : 'NONAKTIF'} (${data.poinPenalti} poin)`);
});

socket.on("autoPenaltyConfig", (data) => {
    clientLogger.info('Auto penalty config:', data);
    clientLogger.info(`Konfigurasi penalti: ${data.diaktifkan ? 'AKTIF' : 'NONAKTIF'} (${data.poinPenalti} poin)`);
});

// Function untuk request timer reset jika diperlukan
function requestTimerReset() {
    socket.emit("requestTimerReset");
}

// Function untuk check timer status
function checkTimerStatus() {
    socket.emit("getTimerStatus");
}

// Initialize
document.addEventListener('DOMContentLoaded', function() {
    resetTimerDisplay();
    clientLogger.info('Display initialized - Enhanced debugging enabled');
    clientLogger.info('Fitur penalti otomatis: Siap menerima notifikasi penalti saat timer habis');
    
    // Check timer status setiap 5 detik untuk sinkronisasi
    setInterval(checkTimerStatus, 5000);
    
    // Sync timer dengan server setiap 3 detik
    setInterval(syncTimerWithServer, 3000);
    
    // Check timer status awal
    setTimeout(checkTimerStatus, 1000);
    
    // Auto-reset safety: jika timer masih stuck setelah 2 menit, reset manual
    setTimeout(() => {
        checkTimerStatus();
        clientLogger.info('Safety check: Verifying timer state...');
    }, 120000);
});