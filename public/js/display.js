﻿const socket = io();
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
  },
  
  tts: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[CLIENT:${timestamp}] TTS: ${message}`, data || '');
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
    // Preload audio elements untuk semua tim
    for (let i = 1; i <= TEAM_COUNT; i++) {
      const teamLetter = getTeamLetter(i);
      const audioFile = `Tim ${teamLetter}.mp3`;
      // Audio path: /audio/Tim A.mp3 (dalam public folder)
      const audioEl = new Audio(`/audio/${audioFile}`);
      
      audioEl.preload = 'auto';
      audioEl.onended = () => this.handleAudioEnd();
      audioEl.onerror = (e) => this.handleAudioError(e, teamLetter);
      
      this.audioElements.set(i, audioEl);
    }
    
    clientLogger.audio('Sistem audio tim diinisialisasi');
  }

  putarAudio(team, onAudioEnd = null) {
    if (this.sedangMemutar) {
      this.berhenti();
    }

    const audioEl = this.audioElements.get(team);
    if (!audioEl) {
      clientLogger.error('Audio tidak ditemukan untuk tim:', team);
      return false;
    }

    try {
      this.sedangMemutar = true;
      this.audioSekarang = audioEl;
      this.onAudioEndCallback = onAudioEnd;

      audioEl.currentTime = 0;
      audioEl.play().then(() => {
        clientLogger.audio(`Memutar audio untuk Tim ${getTeamLetter(team)}`);
      }).catch(error => {
        clientLogger.error('Gagal memutar audio:', error);
        this.sedangMemutar = false;
        this.onAudioEndCallback = null;
      });

      return true;
      
    } catch (error) {
      clientLogger.error('Exception audio:', error);
      this.sedangMemutar = false;
      this.onAudioEndCallback = null;
      return false;
    }
  }

  handleAudioEnd() {
    clientLogger.audio('Audio selesai diputar');
    this.sedangMemutar = false;
    
    // Execute callback jika ada
    if (this.onAudioEndCallback) {
      clientLogger.audio('Executing audio end callback', this.onAudioEndCallback);
      this.executeCallback(this.onAudioEndCallback);
      this.onAudioEndCallback = null;
    }
  }

  handleAudioError(event, teamLetter) {
    clientLogger.error(`Error audio untuk Tim ${teamLetter}:`, event);
    this.sedangMemutar = false;
    this.onAudioEndCallback = null;
  }

  executeCallback(callbackData) {
    if (callbackData && callbackData.action) {
      switch (callbackData.action) {
        case 'startTimer':
          if (callbackData.team) {
            clientLogger.audio(`Memulai timer untuk Tim ${getTeamLetter(callbackData.team)} setelah audio selesai`);
            fetch(`/audioFinished?action=startTimer&team=${callbackData.team}`)
              .then(r => r.json())
              .then(data => {
                clientLogger.info('Timer start callback executed', data);
              })
              .catch(err => clientLogger.error('Timer start callback error:', err));
          }
          break;
          
        default:
          clientLogger.warn('Unknown callback action:', callbackData.action);
      }
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

// SISTEM TEXT-TO-SPEECH
class SistemTTS {
  constructor() {
    this.sintesis = window.speechSynthesis;
    this.didukung = !!this.sintesis;
    this.sedangBicara = false;
    this.ucapan = null;
    
    this.inisialisasi();
  }

  inisialisasi() {
    if (!this.didukung) {
      clientLogger.error('Web Speech API tidak didukung browser ini');
      return;
    }

    // Load voices saat page load
    this.muatSuara();
    
    // Juga load voices ketika voices changed
    this.sintesis.onvoiceschanged = () => {
      this.muatSuara();
    };

    clientLogger.tts('Sistem TTS untuk Timer & Juri diinisialisasi');
  }

  muatSuara() {
    const semuaSuara = this.sintesis.getVoices();
    clientLogger.tts(`Tersedia ${semuaSuara.length} suara`);
    
    // Cari suara Indonesia atau default
    const suaraIndonesia = semuaSuara.find(suara => 
      suara.lang.includes('id-ID')
    ) || semuaSuara.find(suara => 
      suara.lang.includes('id')
    ) || semuaSuara[0];

    if (suaraIndonesia) {
      clientLogger.tts(`Menggunakan suara: ${suaraIndonesia.name} (${suaraIndonesia.lang})`);
    } else {
      clientLogger.warn('Tidak menemukan suara Indonesia, menggunakan default');
    }
  }

  bicara(teks, pengaturanSuara = {}) {
    if (!this.didukung) {
      clientLogger.error('TTS tidak didukung');
      return false;
    }

    // Stop speech yang sedang berjalan
    this.berhenti();

    try {
      this.sedangBicara = true;
      this.ucapan = new SpeechSynthesisUtterance(teks);
      
      // Set language ke Indonesia
      this.ucapan.lang = 'id-ID';
      
      // Pengaturan suara default
      this.ucapan.rate = pengaturanSuara.rate || 1.0;
      this.ucapan.pitch = pengaturanSuara.pitch || 1.0;
      this.ucapan.volume = pengaturanSuara.volume || 1.0;

      this.ucapan.onstart = () => {
        this.sedangBicara = true;
        clientLogger.tts(`Mulai berbicara: "${teks}"`);
      };

      this.ucapan.onend = () => {
        this.sedangBicara = false;
        clientLogger.tts('Selesai berbicara');
      };

      this.ucapan.onerror = (event) => {
        this.sedangBicara = false;
        clientLogger.error('Error TTS:', event.error);
      };

      // Gunakan setTimeout untuk menghindari autoplay block
      setTimeout(() => {
        this.sintesis.speak(this.ucapan);
      }, 100);
      
      return true;
      
    } catch (error) {
      this.sedangBicara = false;
      clientLogger.error('Exception TTS:', error);
      return false;
    }
  }

  berhenti() {
    if (this.sedangBicara) {
      this.sintesis.cancel();
      this.sedangBicara = false;
    }
  }
}

// Inisialisasi sistem
const audioTim = new SistemAudioTim();
const ttsSystem = new SistemTTS();

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

// Fungsi tampilkan tim aktif
function showActiveTeam(team) {
    clientLogger.info(`Showing active team`, { team, teamLetter: String.fromCharCode(64 + team) });
    
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
    clientLogger.info(`Team display updated`, { activeTeam, activeTeamLetter: String.fromCharCode(64 + team) });
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

// Socket event handlers
socket.on("connect", () => {
    clientLogger.info('Connected to server');
    
    const liveIndicator = document.querySelector('.live-indicator');
    if (liveIndicator) {
        liveIndicator.style.background = '#4caf50';
        liveIndicator.textContent = 'LIVE - Terhubung ke Server';
    }
    
    // Test TTS saat connect
    setTimeout(() => {
        if (ttsSystem.didukung) {
            ttsSystem.bicara("Sistem siap");
            clientLogger.tts('Test TTS pada koneksi');
        }
    }, 1000);
    
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
        liveIndicator.textContent = 'OFFLINE - DISCONNECTED';
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

// Suara tombol buzzer
socket.on("buzz", ({ team }) => {
    clientLogger.event('buzz', { team, teamLetter: String.fromCharCode(64 + team) });
    
    showActiveTeam(team);
});

// Event untuk memutar audio tim
socket.on("playTeamAudio", (data) => {
    clientLogger.event('playTeamAudio', data);
    const { team, audioFile, onAudioEnd } = data;

    // Tampilkan pesan di AI Message
    const aiMessageEl = document.getElementById("aiMessage");
    const message = `Tombol ditekan oleh Tim ${getTeamLetter(team)}!`;
    
    if (aiMessageEl) {
        aiMessageEl.textContent = message;
        aiMessageEl.classList.add("show");
        
        setTimeout(() => {
            aiMessageEl.classList.remove("show");
        }, 3000);
    }

    // Putar audio tim
    clientLogger.audio(`Memulai audio untuk Tim ${getTeamLetter(team)}: ${audioFile}`);
    audioTim.putarAudio(team, onAudioEnd);
});

// Pesan AI dengan TTS
let aiMessageTimeout;

socket.on("aiMessage", (data) => {
    clientLogger.event('aiMessage', data);
    const aiMessageEl = document.getElementById("aiMessage");
    const message = data.message;
    const shouldSpeak = data.shouldSpeak === true;

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

    clientLogger.info('AI Message displayed', { message, shouldSpeak });

    // JALANKAN TTS JIKA DIPERLUKAN
    if (shouldSpeak && ttsSystem.didukung) {
        clientLogger.tts('Memulai TTS untuk pesan:', message);
        ttsSystem.bicara(message);
    } else if (shouldSpeak && !ttsSystem.didukung) {
        clientLogger.warn('TTS diminta tapi tidak didukung browser');
    }
    
    aiMessageTimeout = setTimeout(() => {
        aiMessageEl.classList.remove("show");
        clientLogger.info('AI Message hidden');
    }, 4000);
});

// Suara juri (hanya visual, tanpa sound effects)
socket.on("scoring", ({ team, isCorrect }) => {
    clientLogger.event('scoring', { team, isCorrect });
    // Tidak ada sound effects untuk correct/wrong
});

// TIMER EVENTS FROM SERVER - START AFTER AUDIO
socket.on("timerStart", (data) => {
    clientLogger.event('timerStart - AFTER AUDIO', data);
    if (data.duration) {
        updateTimerDisplay(data.duration);
        clientLogger.info('Timer started AFTER AUDIO finished');
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
    clientLogger.info('Display initialized - Audio System + TTS After Audio ready');
    
    // Load voices untuk TTS
    if ('speechSynthesis' in window) {
        // Trigger voices load
        speechSynthesis.getVoices();
        setTimeout(() => {
            const voices = speechSynthesis.getVoices();
            clientLogger.info('Browser TTS voices loaded', { 
                totalVoices: voices.length,
                indonesianVoices: voices.filter(v => v.lang.includes('id')).length
            });
        }, 1000);
    }
});