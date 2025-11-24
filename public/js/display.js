﻿/*Copyright © 2025 Ridwan and Team*/
const socket = io();
const board = document.getElementById("board");
const overlay = document.getElementById("overlay");
const TEAM_COUNT = 12;
let teamToggleState = Array(TEAM_COUNT).fill(true);

// IMPROVED: Client Logger dengan lebih banyak info
const clientLogger = {
  info: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[CLIENT:${timestamp}] ${message}`, data || '');
  },
  
  warn: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[CLIENT:${timestamp}] ⚠️ ${message}`, data || '');
  },
  
  error: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[CLIENT:${timestamp}] ❌ ${message}`, data || '');
  },
  
  success: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[CLIENT:${timestamp}] ✅ ${message}`, data || '');
  }
};

// IMPROVED: SISTEM AUDIO FILE DENGAN BETTER ERROR HANDLING
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
      clientLogger.info('Executing callback despite audio error');
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

// IMPROVED: Sistem Audio untuk Timer Countdown
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

// IMPROVED: Sistem Audio untuk Juri
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

// IMPROVED: TIMER FUNCTIONS dengan better error handling
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
    
    clientLogger.info(`Timer display updated`, { seconds, display: timerEl.textContent });
}

function resetTimerDisplay() {
    const timerEl = document.querySelector('.timer');
    if (timerEl) {
        timerEl.textContent = '00:00';
        timerEl.classList.remove('warning', 'critical');
        clientLogger.info(`Timer display reset to 00:00`);
    } else {
        clientLogger.error('Timer element not found for reset');
    }
}

// IMPROVED: fungsi tampilkan tim aktif dengan validation
function showActiveTeam(team) {
    if (!team || team < 1 || team > TEAM_COUNT) {
        clientLogger.error('Invalid team for showActiveTeam:', team);
        return;
    }
    
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
    
    clientLogger.success(`Team display updated`, { activeTeam: team, activeTeamLetter: getTeamLetter(team) });
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

// IMPROVED: Update tampilan berdasarkan status toggle tim dengan better handling
function updateTeamDisplay() {
    clientLogger.info('Updating team display based on toggle state', { teamToggleState });
    
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
                clientLogger.info(`Hiding team ${i} (${getTeamLetter(i)}) because it's disabled`);
            }
        } else {
            clientLogger.warn(`Team element not found: team-${i}`);
        }
    }
    
    // Update grid layout based on visible teams
    const grid = document.querySelector('.grid');
    if (grid) {
        grid.setAttribute('data-visible-teams', visibleCount);
        
        // Force reflow untuk memastikan CSS update
        setTimeout(() => {
            grid.style.display = 'none';
            setTimeout(() => {
                grid.style.display = 'grid';
            }, 10);
        }, 50);
    }
    
    clientLogger.success(`Team display update completed - ${visibleCount} teams visible`);
}

// IMPROVED: Render tim di papan dengan better error handling
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
        clientLogger.success(`Initial teams rendered`, { teamCount: TEAM_COUNT });
        
        setTimeout(() => {
            updateTeamDisplay();
        }, 100);
    } catch (error) {
        clientLogger.error('Error rendering initial teams:', error);
    }
}

renderInitial();

// IMPROVED: Socket event handlers dengan better error handling
socket.on("connect", () => {
    clientLogger.success('Connected to server');
    
    const liveIndicator = document.querySelector('.live-indicator');
    if (liveIndicator) {
        liveIndicator.style.background = '#4caf50';
        liveIndicator.textContent = '● LIVE - Terhubung ke Server';
    }
    
    // Load initial data dengan error handling
    Promise.all([
        fetch('/scores').then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        }),
        fetch('/lockstate').then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        }),
        fetch('/teamToggleState').then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
    ])
    .then(([scoresData, lockStateData, toggleStateData]) => {
        clientLogger.success('Initial data loaded successfully');
        
        // Update scores
        if (Array.isArray(scoresData)) {
            for (let i = 0; i < scoresData.length; i++) {
                const el = document.getElementById("score-" + (i + 1));
                if (el) el.textContent = scoresData[i];
            }
            clientLogger.info('Initial scores loaded', { scores: scoresData });
        }
        
        // Update lock state
        if (lockStateData && typeof lockStateData === 'object') {
            if (lockStateData.locked && lockStateData.activeTeam) {
                showActiveTeam(lockStateData.activeTeam);
            }
            clientLogger.info('Initial lock state loaded', { lockState: lockStateData });
        }
        
        // Update team toggle state
        if (Array.isArray(toggleStateData) && toggleStateData.length === TEAM_COUNT) {
            teamToggleState = toggleStateData;
            updateTeamDisplay();
            clientLogger.info('Initial team toggle state loaded', { teamToggleState });
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

// IMPROVED: Update skor realtime dengan animation
socket.on("update", payload => {
    clientLogger.info('Score update received', payload);
    const { team, score } = payload;
    const el = document.getElementById("score-" + team);
    if (el) {
        el.textContent = score;
        el.classList.add('score-update');
        setTimeout(() => el.classList.remove('score-update'), 600);
    } else {
        clientLogger.warn('Score element not found for team:', team);
    }
});

// Reset semua skor
socket.on("reset", arr => {
    clientLogger.info('Reset scores', { scores: arr });
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
    clientLogger.info('Lock state update', state);
    if (!state.locked) {
        resetDisplay();
    } else if (state.activeTeam) {
        showActiveTeam(state.activeTeam);
    }
});

// IMPROVED: Event untuk update status toggle tim individual
socket.on("teamToggleUpdate", data => {
    clientLogger.info('Team toggle update received', data);
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
    clientLogger.info('All teams enabled received');
    teamToggleState = Array(TEAM_COUNT).fill(true);
    clientLogger.info('All teams enabled', { teamToggleState });
    updateTeamDisplay();
});

// Event untuk disable semua tim
socket.on("allTeamsDisabled", () => {
    clientLogger.info('All teams disabled received');
    teamToggleState = Array(TEAM_COUNT).fill(false);
    clientLogger.info('All teams disabled', { teamToggleState });
    updateTeamDisplay();
});

// Event untuk initial team toggle state
socket.on("teamToggleState", data => {
    clientLogger.info('Team toggle state received', data);
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
    clientLogger.info('Buzzer pressed', { team, teamLetter: getTeamLetter(team) });
    showActiveTeam(team);
});

// IMPROVED: HANDLER AUDIO dengan better error handling
socket.on("playTeamAudio", (data) => {
    clientLogger.info('Play team audio received', data);
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
    clientLogger.info('Play timer audio received', data);
    const { seconds, audioFile } = data;
    
    timerAudio.putarAudio(audioFile);
});

// IMPROVED: HANDLER AUDIO JURI dengan better feedback
socket.on("playJuryAudio", (data) => {
    clientLogger.info('Play jury audio received', data);
    const { isCorrect, audioFile } = data;

    clientLogger.info(`Memutar audio juri: ${audioFile} (${isCorrect ? 'BENAR' : 'SALAH'})`);
    
    juryAudio.putarAudio(audioFile);
    
    const aiMessageEl = document.getElementById("aiMessage");
    if (aiMessageEl) {
        const message = isCorrect ? 'JAWABAN BENAR! 🎉' : 'JAWABAN SALAH! ❌';
        aiMessageEl.textContent = message;
        aiMessageEl.classList.add("show");
        
        // Add specific class for correct/wrong
        aiMessageEl.classList.remove("correct", "wrong");
        aiMessageEl.classList.add(isCorrect ? "correct" : "wrong");
        
        setTimeout(() => {
            aiMessageEl.classList.remove("show", "correct", "wrong");
        }, 3000);
    }
});

// IMPROVED: Pesan AI dengan better styling
let aiMessageTimeout;

socket.on("aiMessage", (data) => {
    clientLogger.info('AI message received', data);
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
    
    // Remove any previous styling
    aiMessageEl.classList.remove("correct", "wrong");

    clientLogger.info('AI Message displayed', { message });
    
    aiMessageTimeout = setTimeout(() => {
        aiMessageEl.classList.remove("show");
        clientLogger.info('AI Message hidden');
    }, 4000);
});

// IMPROVED: TIMER EVENTS FROM SERVER dengan validation
socket.on("timerStart", (data) => {
    clientLogger.info('Timer start received', data);
    if (data.duration) {
        updateTimerDisplay(data.duration);
        clientLogger.info('Timer started');
    } else {
        clientLogger.warn('Timer start received without duration');
    }
});

socket.on("timerUpdate", (data) => {
    if (data.timeRemaining !== undefined) {
        updateTimerDisplay(data.timeRemaining);
    } else {
        clientLogger.warn('Timer update received without timeRemaining');
    }
});

socket.on("timerEnd", () => {
    clientLogger.info('Timer end received');
    updateTimerDisplay(0);
});

socket.on("timerReset", () => {
    clientLogger.info('Timer reset received');
    resetTimerDisplay();
});

// Initialize
document.addEventListener('DOMContentLoaded', function() {
    resetTimerDisplay();
    clientLogger.success('Display initialized - ENHANCED Audio System + Timer Sync + Jury Audio + Team Toggle');
    
    // Add CSS for AI message types
    const style = document.createElement('style');
    style.textContent = `
        .ai-message.correct {
            background: linear-gradient(135deg, #4caf50, #45a049);
            border-color: #2e7d32;
        }
        .ai-message.wrong {
            background: linear-gradient(135deg, #f44336, #d32f2f);
            border-color: #b71c1c;
        }
    `;
    document.head.appendChild(style);
});