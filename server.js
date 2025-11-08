﻿/*Copyright © 2025 Ridwan and Team*/
const socket = io();
const board = document.getElementById("board");
const overlay = document.getElementById("overlay");
const TEAM_COUNT = 12;
let activeTeam = null;

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
  },
  
  event: (eventName, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[CLIENT:${timestamp}] EVENT: ${eventName}`, data || '');
  },
  
  audio: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[CLIENT:${timestamp}] AUDIO: ${message}`, data || '');
  }
};

// SISTEM AUDIO FILE DENGAN CALLBACK - IMPROVED
class SistemAudioTim {
  constructor() {
    this.audioElements = new Map();
    this.sedangMemutar = false;
    this.audioSekarang = null;
    this.onAudioEndCallback = null;
    
    this.inisialisasiAudio();
  }

  inisialisasiAudio() {
    // Preload audio elements untuk semua tim
    for (let i = 1; i <= TEAM_COUNT; i++) {
      const teamLetter = getTeamLetter(i);
      const audioFile = `Tim ${teamLetter}.mp3`;
      const audioEl = new Audio(`/audio/${audioFile}`);
      
      audioEl.preload = 'auto';
      audioEl.onerror = (e) => this.handleAudioError(e, teamLetter);
      
      this.audioElements.set(i, audioEl);
    }
    
    clientLogger.audio('Sistem audio tim diinisialisasi - 12 file audio tim');
  }

  putarAudio(team, onAudioEnd = null) {
    if (this.sedangMemutar) {
      clientLogger.audio('Audio sedang diputar, menghentikan yang lama');
      this.berhenti();
    }

    const audioEl = this.audioElements.get(team);
    if (!audioEl) {
      clientLogger.error('Audio tidak ditemukan untuk tim:', team);
      // Jika audio tidak ada, langsung trigger callback
      if (onAudioEnd) {
        setTimeout(() => this.executeCallback(onAudioEnd), 100);
      }
      return false;
    }

    try {
      this.sedangMemutar = true;
      this.audioSekarang = audioEl;
      this.onAudioEndCallback = onAudioEnd;

      // Set handler untuk ketika audio selesai
      audioEl.onended = () => {
        clientLogger.audio('Audio selesai diputar - executing callback');
        this.sedangMemutar = false;
        if (this.onAudioEndCallback) {
          this.executeCallback(this.onAudioEndCallback);
          this.onAudioEndCallback = null;
        }
      };

      audioEl.currentTime = 0;
      audioEl.play().then(() => {
        clientLogger.audio(`Memutar audio tim: Tim ${getTeamLetter(team)}.mp3`);
        
        // Tampilkan pesan AI
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
        // Jika gagal play, langsung trigger callback setelah delay
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
    
    // Jika ada callback, eksekusi meski audio error
    if (this.onAudioEndCallback) {
      clientLogger.audio('Executing callback despite audio error');
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
            clientLogger.audio(`Memulai timer untuk Tim ${getTeamLetter(callbackData.team)} setelah audio selesai`);
            // Beri tahu server bahwa audio selesai dan timer bisa mulai
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
        // Fallback: coba start timer langsung jika server error
        this.fallbackTimerStart(team);
      });
  }

  fallbackTimerStart(team) {
    clientLogger.warn('Using fallback timer start for team:', team);
    // Kirim request tambahan untuk memastikan timer mulai
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

// Sistem Audio untuk Timer Countdown - IMPROVED
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
    
    clientLogger.audio('Sistem audio timer diinisialisasi - 9 file countdown');
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
        clientLogger.audio(`Memutar audio timer: ${audioFile}`);
      }).catch(error => {
        clientLogger.error('Gagal memutar audio timer:', error);
        this.sedangMemutar = false;
      });

      audioEl.onended = () => {
        this.sedangMemutar = false;
        clientLogger.audio('Audio timer selesai');
        
        // Beri tahu server bahwa audio timer selesai
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

// Sistem Audio untuk Juri - BARU
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
    
    clientLogger.audio('Sistem audio juri diinisialisasi - 2 file feedback');
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
        clientLogger.audio(`Memutar audio efek: ${audioFile}`);
      }).catch(error => {
        clientLogger.error('Gagal memutar audio juri:', error);
        this.sedangMemutar = false;
      });

      audioEl.onended = () => {
        this.sedangMemutar = false;
        clientLogger.audio('Audio juri selesai');
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
    
    activeTeam = team;
    clientLogger.info(`Team display updated`, { activeTeam, activeTeamLetter: getTeamLetter(team) });
}

// Fungsi reset tampilan
function resetDisplay() {
    clientLogger.info(`Resetting display - unlocking all teams`);
    for (let i = 1; i <= TEAM_COUNT; i++) {
        const el = document.getElementById("team-" + i);
        if (el) el.classList.remove("active", "hidden");
    }
    overlay.classList.remove("active");
    activeTeam = null;
}

// Helper tim
function getTeamLetter(index) {
    return String.fromCharCode(65 + index - 1);
}

// Render tim di papan
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
}

renderInitial();

// Socket event handlers - DIPERBAIKI
socket.on("connect", () => {
    clientLogger.info('Connected to server');
    
    const liveIndicator = document.querySelector('.live-indicator');
    if (liveIndicator) {
        liveIndicator.style.background = '#4caf50';
        liveIndicator.textContent = '● LIVE - Terhubung ke Server';
    }
    
    fetch('/scores')
        .then(r => r.json())
        .then(data => {
            clientLogger.info('Initial scores loaded', { scores: data });
            for (let i = 0; i < data.length; i++) {
                const el = document.getElementById("score-" + (i + 1));
                if (el) el.textContent = data[i];
            }
        })
        .catch(err => clientLogger.error('Error fetching scores:', err));
        
    fetch('/lockstate')
        .then(r => r.json())
        .then(data => {
            clientLogger.info('Initial lock state loaded', { lockState: data });
            if (data.locked && data.activeTeam) {
                showActiveTeam(data.activeTeam);
            }
        })
        .catch(err => clientLogger.error('Error fetching lockstate:', err));
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
    clientLogger.event('update', payload);
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
    clientLogger.event('reset', { scores: arr });
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
    clientLogger.event('lockstate', state);
    if (!state.locked) {
        resetDisplay();
    } else if (state.activeTeam && !activeTeam) {
        showActiveTeam(state.activeTeam);
    }
});

// Suara tombol buzzer - DIPERBAIKI
socket.on("buzz", ({ team }) => {
    clientLogger.event('buzz', { team, teamLetter: getTeamLetter(team) });
    
    showActiveTeam(team);
    
    // GUNAKAN audio tim spesifik untuk buzzer
    const audioSuccess = audioTim.putarAudio(team, {
        action: "startTimer",
        team: team,
        timerDuration: config.timerDuration
    });
    
    if (!audioSuccess) {
        clientLogger.warn('Audio tim gagal, fallback ke audio benar.mp3');
        juryAudio.putarAudio('benar.mp3');
    }
});

// HANDLER AUDIO YANG DIPERBAIKI
socket.on("playTeamAudio", (data) => {
    clientLogger.event('playTeamAudio', data);
    const { team, audioFile, timerDuration } = data;

    clientLogger.audio(`Memulai audio untuk Tim ${getTeamLetter(team)}: ${audioFile}`);
    
    // Putar audio tim dengan callback untuk mulai timer setelah selesai
    const audioSuccess = audioTim.putarAudio(team, {
        action: "startTimer",
        team: team,
        timerDuration: timerDuration
    });
    
    if (!audioSuccess) {
        clientLogger.warn('Audio playback failed, using fallback');
        // Fallback: langsung mulai timer jika audio gagal
        setTimeout(() => {
            fetch(`/audioFinished?action=startTimer&team=${team}&type=team`)
                .catch(e => clientLogger.error('Fallback audio finish failed:', e));
        }, 1000);
    }
});

socket.on("playTimerAudio", (data) => {
    clientLogger.event('playTimerAudio', data);
    const { seconds, audioFile } = data;
    
    timerAudio.putarAudio(audioFile);
});

// HANDLER AUDIO JURI - BARU
socket.on("playJuryAudio", (data) => {
    clientLogger.event('playJuryAudio', data);
    const { isCorrect, audioFile } = data;

    clientLogger.audio(`Memutar audio juri: ${audioFile} (${isCorrect ? 'BENAR' : 'SALAH'})`);
    
    // Putar audio juri
    juryAudio.putarAudio(audioFile);
    
    // Tampilkan pesan AI untuk juri
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
    clientLogger.event('aiMessage', data);
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

// Suara juri - DIPERBAIKI
socket.on("scoring", ({ team, isCorrect }) => {
    clientLogger.event('scoring', { team, isCorrect });
    
    // GUNAKAN juryAudio untuk feedback juri
    const audioFile = isCorrect ? 'benar.mp3' : 'salah.mp3';
    juryAudio.putarAudio(audioFile);
});

// TIMER EVENTS FROM SERVER
socket.on("timerStart", (data) => {
    clientLogger.event('timerStart', data);
    if (data.duration) {
        updateTimerDisplay(data.duration);
        clientLogger.info('Timer started');
    }
});

socket.on("timerUpdate", (data) => {
    clientLogger.event('timerUpdate', data);
    if (data.timeRemaining !== undefined) {
        updateTimerDisplay(data.timeRemaining);
    }
});

socket.on("timerEnd", () => {
    clientLogger.event('timerEnd');
    updateTimerDisplay(0);
});

socket.on("timerReset", () => {
    clientLogger.event('timerReset');
    resetTimerDisplay();
});

// Initialize
document.addEventListener('DOMContentLoaded', function() {
    resetTimerDisplay();
    clientLogger.info('Display initialized - SIMPLIFIED Audio System');
    clientLogger.info('Removed: Legacy audio elements (buzzSound, correctSound, wrongSound)');
    clientLogger.info('Using: 3-class audio system (Team, Timer, Jury)');
});