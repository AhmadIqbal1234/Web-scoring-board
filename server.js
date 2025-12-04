﻿/* Copyright © 2025 Ridwan and Team */
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const http = createServer(app);

// ===== KONFIGURASI LINGKUNGAN =====
const PORT = process.env.PORT || 8080;
const TEAM_COUNT = 12;
const isProduction = process.env.NODE_ENV === 'production';

// ===== PENGAMANAN =====
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.socket.io"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// ===== PEMBATASAN REQUEST OPTIMIZED =====
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => {
    let clientIP = req.ip || 
                  req.connection.remoteAddress || 
                  req.socket.remoteAddress ||
                  (req.connection.socket ? req.connection.socket.remoteAddress : null);
    
    // IP yang diizinkan lebih banyak request
    const whitelistIPs = [
      '192.168.1.',
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:192.168.1.',
      '172.',
      '10.'
    ];
    
    // URL yang diizinkan lebih banyak request
    const whitelistURLs = [
      '/health',
      '/esp32checkin', 
      '/esp32status',
      '/config',
      '/lockstate',
      '/update'  // Update endpoint dapat banyak request
    ];
    
    const isWhitelistedIP = whitelistIPs.some(ip => clientIP && clientIP.includes(ip));
    const isWhitelistedURL = whitelistURLs.some(url => req.url.startsWith(url));
    
    if (isWhitelistedIP || isWhitelistedURL) {
      return 5000; // Banyak request untuk IP/URL terpercaya
    }
    
    return isProduction ? 100 : 1000;
  },
  message: {
    error: 'Terlalu banyak request',
    message: 'Silakan coba lagi setelah 15 menit'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req, res) => {
    return res.statusCode < 400;
  }
});

app.use(limiter);

// ===== KONFIGURASI CORS UNTUK SOCKET.IO =====
const io = new Server(http, {
  cors: {
    origin: isProduction 
      ? [process.env.FRONTEND_URL, "https://*.railway.app", "https://*.up.railway.app"] 
      : ["http://localhost:8080", "http://192.168.1.5:8080", "http://192.168.1.100:8080"],
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// ===== DATA STATE =====
let scores = Array(TEAM_COUNT).fill(0);
let config = { plus: 5, minus: -2, timerDuration: 30 };
let lockState = { locked: false, activeTeam: null };
let teamToggleState = Array(TEAM_COUNT).fill(true);
let isAutoPenaltyEnabled = true;

// ===== STATE TIMER =====
let timerInterval = null;
let timeRemaining = 0;
let isTimerRunning = false;
let audioFinishTimeout = null;
let lastTimerEvent = null;

// ===== STATE ESP32 =====
let esp32Status = {
  connected: false,
  lastActivity: null,
  socketId: null,
  ip: null,
  lastCheckin: null,
  connectionType: null,
  lastBroadcast: null
};

// ===== SISTEM LOG OPTIMIZED =====
const logger = {
  info: (message, data = null) => {
    if (isProduction) return; // Kurangi log di production
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  error: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  audio: (message, data = null) => {
    if (isProduction) return;
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] AUDIO: ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  esp32: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] ESP32: ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  performance: (message, data = null) => {
    if (!isProduction) {
      const timestamp = new Date().toLocaleTimeString('id-ID');
      console.log(`[${timestamp}] PERF: ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
  }
};

// ===== SISTEM AUDIO =====
class TimerAudioSystem {
  constructor() {
    this.audioFiles = {
      30: '30 detik.mp3',
      20: '20 detik.mp3', 
      10: '10 detik.mp3',
      5: '5 detik.mp3',
      4: '4 detik.mp3',
      3: '3 detik.mp3',
      2: '2 detik.mp3',
      1: '1 detik.mp3',
      0: 'waktu habis.mp3'
    };
    
    this.juryAudio = {
      correct: 'benar.mp3',
      wrong: 'salah.mp3'
    };

    this.preTeamAudio = 'buzzer.mp3';
  }

  playCountdownAudio(seconds) {
    const audioFile = this.audioFiles[seconds];
    if (audioFile) {
      io.emit("playTimerAudio", {
        seconds: seconds,
        audioFile: audioFile
      });
      logger.audio(`Memutar countdown audio: ${audioFile}`);
    }
  }

  playJuryAudio(isCorrect) {
    const audioFile = isCorrect ? this.juryAudio.correct : this.juryAudio.wrong;
    if (audioFile) {
      io.emit("playJuryAudio", {
        isCorrect: isCorrect,
        audioFile: audioFile
      });
      logger.audio(`Memutar audio juri: ${audioFile}`);
    }
  }

  playPreTeamAudio(team) {
    if (this.preTeamAudio) {
      io.emit("playPreTeamAudio", {
        team: team,
        audioFile: this.preTeamAudio
      });
      return true;
    }
    return false;
  }
}

const timerAudio = new TimerAudioSystem();

// ===== FUNGSI BANTU =====
function getTeamLetter(teamNumber) {
  return String.fromCharCode(64 + teamNumber);
}

function getTeamAudioFile(teamNumber) {
  const teamLetter = getTeamLetter(teamNumber);
  return `Tim ${teamLetter}.mp3`;
}

function generateFeedbackMessage(team, isCorrect, points) {
  const teamLetter = getTeamLetter(team);
  
  if (isCorrect) {
    const messages = [
      `Bagus! Tim ${teamLetter} benar! Dapat ${points} poin!`,
      `Hebat! Jawaban tepat dari Tim ${teamLetter}! Tambah ${points} poin!`,
      `Benar! Poin ${points} untuk Tim ${teamLetter}!`,
      `Mantap! Tim ${teamLetter} dapat ${points} poin!`,
      `Yes! Tim ${teamLetter} benar! ${points} poin!`
    ];
    return messages[Math.floor(Math.random() * messages.length)];
  } else {
    const messages = [
      `Sayang sekali, Tim ${teamLetter} kurang tepat. Kurang ${Math.abs(points)} poin!`,
      `Masih salah, Tim ${teamLetter}. ${points} poin!`,
      `Bukan itu jawabannya, Tim ${teamLetter}. ${points} poin!`,
      `Coba lagi, Tim ${teamLetter}. ${points} poin!`,
      `Oops, salah Tim ${teamLetter}. ${points} poin!`
    ];
    return messages[Math.floor(Math.random() * messages.length)];
  }
}

// ===== SISTEM PENALTI OTOMATIS OPTIMIZED =====
function handleAutoPenalty() {
  if (!lockState.locked || !lockState.activeTeam) {
    logger.info('Auto penalty: Tidak ada tim aktif, lewati penalti');
    unlockSystemOnTimerEnd();
    return;
  }

  if (!isAutoPenaltyEnabled) {
    logger.info('Auto penalty: Fitur dimatikan, hanya buka kunci');
    unlockSystemOnTimerEnd();
    return;
  }

  const activeTeam = lockState.activeTeam;
  
  if (!teamToggleState[activeTeam - 1]) {
    logger.info(`Auto penalty: Tim ${getTeamLetter(activeTeam)} dinonaktifkan, lewati penalti`);
    unlockSystemOnTimerEnd();
    return;
  }

  const penaltyPoints = config.minus;
  const previousScore = scores[activeTeam - 1];
  
  // Terapkan penalti
  scores[activeTeam - 1] += penaltyPoints;
  
  // Broadcast secara async untuk performance
  setImmediate(() => {
    io.emit("update", { team: activeTeam, score: scores[activeTeam - 1] });
    io.emit("scoring", { team: activeTeam, isCorrect: false });
  });
  
  // Reset semua state dengan cepat
  const previousActiveTeam = lockState.activeTeam;
  lockState = { locked: false, activeTeam: null };
  
  // Hentikan timer
  isTimerRunning = false;
  timeRemaining = 0;
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  // Broadcast semua event sekaligus
  setImmediate(() => {
    io.emit("lockstate", lockState);
    io.emit("timerReset");
    io.emit("systemUnlocked", { reason: "auto_penalty_applied" });
    
    const feedbackMessage = `Waktu habis! Tim ${getTeamLetter(activeTeam)} tidak menjawab, dikurangi ${Math.abs(penaltyPoints)} poin!`;
    
    io.emit("aiMessage", {
      message: feedbackMessage,
      type: "warning",
      shouldSpeak: false
    });
  });
  
  logger.info(`AUTO PENALTI: Tim ${getTeamLetter(activeTeam)} -${Math.abs(penaltyPoints)} poin`, {
    poinPenalti: penaltyPoints,
    skorSebelum: previousScore,
    skorSekarang: scores[activeTeam - 1]
  });
}

// ===== FUNGSI BUKA KUNCI SISTEM OPTIMIZED =====
function unlockSystemOnTimerEnd() {
  logger.performance("Unlock system - timer ended");
  
  // Hentikan timer
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  isTimerRunning = false;
  timeRemaining = 0;
  
  // Buka kunci jika masih terkunci
  if (lockState.locked) {
    const previousActiveTeam = lockState.activeTeam;
    lockState = { locked: false, activeTeam: null };
    
    // Broadcast cepat
    setImmediate(() => {
      io.emit("lockstate", lockState);
      io.emit("timerReset");
      io.emit("systemUnlocked", { 
        reason: "timer_expired",
        previousActiveTeam: previousActiveTeam 
      });
    });
    
    logger.info(`Sistem dibuka karena timer habis. Tim sebelumnya: ${previousActiveTeam}`);
  }
}

// ===== VALIDASI FILE AUDIO =====
function validateAudioFiles() {
  const possibleDirs = [
    join(process.cwd(), "public", "audio"),
    join(__dirname, "public", "audio"),
    join(__dirname, "..", "public", "audio")
  ];
  
  let audioDirFound = null;
  
  for (const dir of possibleDirs) {
    if (fs.existsSync(dir)) {
      audioDirFound = dir;
      logger.info(`Direktori audio ditemukan: ${dir}`);
      break;
    }
  }
  
  if (!audioDirFound) {
    logger.error('Direktori audio tidak ditemukan! Membuat public/audio...');
    const defaultDir = join(process.cwd(), "public", "audio");
    fs.mkdirSync(defaultDir, { recursive: true });
    audioDirFound = defaultDir;
  }
  
  const requiredFiles = [
    'Tim A.mp3', 'Tim B.mp3', 'Tim C.mp3', 'Tim D.mp3', 'Tim E.mp3', 'Tim F.mp3',
    'Tim G.mp3', 'Tim H.mp3', 'Tim I.mp3', 'Tim J.mp3', 'Tim K.mp3', 'Tim L.mp3',
    '30 detik.mp3', '20 detik.mp3', '10 detik.mp3', '5 detik.mp3', '4 detik.mp3',
    '3 detik.mp3', '2 detik.mp3', '1 detik.mp3', 'waktu habis.mp3',
    'benar.mp3', 'salah.mp3', 'buzzer.mp3'
  ];
  
  logger.info("Memvalidasi file audio...");
  
  let missingFiles = [];
  let foundFiles = [];
  
  requiredFiles.forEach(file => {
    const filePath = join(audioDirFound, file);
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.size > 0) {
        foundFiles.push(file);
      } else {
        missingFiles.push(file);
      }
    } else {
      missingFiles.push(file);
    }
  });
  
  logger.info(`Hasil validasi audio: ${foundFiles.length}/${requiredFiles.length} file ditemukan`);
  if (missingFiles.length > 0) {
    logger.error(`File yang hilang: ${missingFiles.join(', ')}`);
  }
  
  return audioDirFound;
}

// ===== SISTEM STATUS ESP32 =====
function updateESP32Status(connected, socket = null, ip = null, activityType = "unknown") {
  const previousStatus = esp32Status.connected;
  const previousIP = esp32Status.ip;
  
  if (connected) {
    esp32Status.connected = true;
    esp32Status.lastActivity = new Date();
    esp32Status.lastCheckin = new Date();
    esp32Status.connectionType = activityType;
    
    if (socket) {
      esp32Status.socketId = socket.id;
    }
    
    if (ip) {
      esp32Status.ip = ip;
    }
    
    logger.esp32(`Aktivitas ESP32 - ${activityType}`, {
      ip: ip,
      socketId: socket ? socket.id : 'HTTP',
      waktu: esp32Status.lastActivity.toLocaleTimeString('id-ID')
    });
    
  } else {
    if (activityType === "esp32_shutdown" || activityType === "socket_disconnect") {
      esp32Status.connected = false;
      esp32Status.connectionType = "terputus";
    }
  }
  
  const shouldBroadcast = 
    previousStatus !== esp32Status.connected || 
    previousIP !== esp32Status.ip ||
    !esp32Status.lastBroadcast || 
    (Date.now() - esp32Status.lastBroadcast.getTime() > 30000);
  
  if (shouldBroadcast) {
    esp32Status.lastBroadcast = new Date();
    io.emit("esp32Status", esp32Status);
  }
}

function updateESP32FromHTTP(ip, activityType = "http_activity") {
  const now = Date.now();
  const timeSinceLastActivity = esp32Status.lastActivity ? now - esp32Status.lastActivity.getTime() : Infinity;
  
  if (!esp32Status.connected || timeSinceLastActivity > 10000) {
    updateESP32Status(true, null, ip, activityType);
  } else {
    esp32Status.lastActivity = new Date();
    esp32Status.lastCheckin = new Date();
  }
}

// ===== SISTEM TIMER OPTIMIZED =====
function startTimer(activeTeam = null) {
  if (isTimerRunning) {
    logger.performance("Timer sudah berjalan, abaikan", {
      waktuTersisa: timeRemaining,
      timAktif: activeTeam
    });
    return;
  }
  
  isTimerRunning = true;
  timeRemaining = config.timerDuration;
  const currentActiveTeam = activeTeam || lockState.activeTeam;

  // Emit timer start dengan cepat
  io.emit("timerStart", { duration: config.timerDuration });
  lastTimerEvent = 'timerStart';
  
  logger.performance("Timer dimulai", { 
    waktuTersisa: timeRemaining, 
    timAktif: currentActiveTeam,
    hurufTim: getTeamLetter(currentActiveTeam)
  });

  timerInterval = setInterval(() => {
    timeRemaining--;
    
    // Optimasi: hanya emit jika berubah
    io.emit("timerUpdate", { timeRemaining });
    lastTimerEvent = 'timerUpdate';

    // Play audio countdown
    if ([30, 20, 10, 5, 4, 3, 2, 1, 0].includes(timeRemaining)) {
      timerAudio.playCountdownAudio(timeRemaining);
    }

    if (timeRemaining <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      isTimerRunning = false;
      
      logger.performance('Timer mencapai 0', {
        lockState: lockState,
        autoPenaltyEnabled: isAutoPenaltyEnabled
      });
      
      // Proses setelah timer habis dengan setTimeout untuk non-blocking
      setTimeout(() => {
        if (isAutoPenaltyEnabled && lockState.locked && lockState.activeTeam) {
          handleAutoPenalty();
        } else {
          unlockSystemOnTimerEnd();
        }
      }, 10); // Delay minimal
    }
  }, 1000);
}

function stopTimer(activeTeam = null) {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  if (audioFinishTimeout) {
    clearTimeout(audioFinishTimeout);
    audioFinishTimeout = null;
  }
  
  isTimerRunning = false;
  
  // Reset timer di client
  io.emit("timerReset");
  lastTimerEvent = 'timerReset';

  logger.performance("Timer dihentikan", { 
    timAktif: activeTeam,
    lastTimerEvent: lastTimerEvent
  });
}

function resetTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  if (audioFinishTimeout) {
    clearTimeout(audioFinishTimeout);
    audioFinishTimeout = null;
  }
  
  isTimerRunning = false;
  timeRemaining = 0;
  
  // Reset timer di client
  io.emit("timerReset");
  lastTimerEvent = 'timerReset';
  
  logger.performance("Timer direset manual");
}

// ===== FUNGSI BUKA KUNSI PAKSA =====
function forceUnlockSystem() {
  logger.info("BUKA KUNCI PAKSA: Buka kunci manual atau darurat");
  
  // Hentikan timer
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  // Reset semua state
  isTimerRunning = false;
  timeRemaining = 0;
  
  // Buka kunci sistem
  lockState = { locked: false, activeTeam: null };
  
  // Broadcast semua sekaligus
  setImmediate(() => {
    io.emit("lockstate", lockState);
    io.emit("timerReset");
    io.emit("systemUnlocked", { reason: "buka_kunci_manual" });
  });
  
  logger.performance("Sistem dibuka paksa");
}

// ===== MEMUTAR AUDIO BUZZER DAN TIM OPTIMIZED =====
function playBuzzerThenTeamAudio(team) {
  const teamAudioFile = getTeamAudioFile(team);
  
  // Mainkan buzzer audio
  const buzzerPlayed = timerAudio.playPreTeamAudio(team);
  
  // LANGSUNG mulai timer tanpa menunggu audio
  if (!isTimerRunning) {
    startTimer(team);
    logger.performance("Timer langsung dimulai", { tim: team });
  }
  
  // Audio tim tetap diputar
  io.emit("playTeamAudio", {
    team: team,
    audioFile: teamAudioFile,
    timerDuration: config.timerDuration
  });
}

// ===== ENDPOINT TEST KONEKSI ESP32 =====
app.get("/testESP32Connection", async (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const realIP = req.headers['x-forwarded-for'] || 
                 req.headers['x-real-ip'] || 
                 req.connection.remoteAddress || 
                 req.socket.remoteAddress ||
                 clientIP;
  
  logger.esp32('Test koneksi ESP32 diminta dari admin');
  
  if (esp32Status.connected && esp32Status.socketId) {
    try {
      const socket = io.sockets.sockets.get(esp32Status.socketId);
      if (socket && socket.connected) {
        socket.emit("pingFromAdmin", {
          waktu: new Date().toISOString(),
          idTest: Date.now(),
          dari: "admin_panel"
        }, (response) => {
          if (response && response.success) {
            res.json({
              success: true,
              message: "ESP32 MERESPON - CONTROLLER ONLINE",
              tipeKoneksi: "SOCKET.IO",
              waktuRespon: `${Date.now() - response.timestamp}ms`,
              statusESP32: esp32Status,
              detail: "ESP32 terhubung langsung via WebSocket"
            });
          } else {
            res.json({
              success: false,
              message: "ESP32 TIDAK MERESPON - ADA MASALAH KONEKSI",
              tipeKoneksi: "SOCKET.IO (Tidak Merespon)",
              statusESP32: esp32Status,
              saran: "Periksa koneksi WiFi ESP32 dan daya"
            });
          }
        });
        
        setTimeout(() => {
          if (!res.headersSent) {
            res.json({
              success: false,
              message: "ESP32 TIMEOUT - TIDAK MERESPON DALAM 3 DETIK",
              tipeKoneksi: "SOCKET.IO (Timeout)",
              statusESP32: esp32Status,
              saran: "ESP32 mungkin offline atau sedang restart"
            });
          }
        }, 3000);
        
        return;
      }
    } catch (error) {
      logger.esp32('Error dalam test ping ESP32:', error);
    }
  }
  
  if (esp32Status.connected && esp32Status.ip) {
    res.json({
      success: true,
      message: "ESP32 TERDETEKSI VIA HTTP - MUNGKIN ONLINE",
      tipeKoneksi: "HTTP Detak Jantung",
      peringatan: "Koneksi Socket tidak terbentuk",
      statusESP32: esp32Status,
      aktivitasTerakhir: esp32Status.lastActivity ? 
        `Terakhir: ${new Date(esp32Status.lastActivity).toLocaleTimeString('id-ID')}` : "Tidak diketahui"
    });
  } else {
    res.json({
      success: false,
      message: "ESP32 OFFLINE - TIDAK ADA KONEKSI TERDETEKSI",
      tipeKoneksi: "TERPUTUS",
      statusESP32: esp32Status,
      saran: "1. Periksa daya ESP32\n2. Periksa koneksi WiFi\n3. Restart ESP32"
    });
  }
});

// ===== ENDPOINT LAINNYA =====
app.get("/timerstate", (req, res) => {
  // Response sangat cepat
  res.send(isTimerRunning ? timeRemaining.toString() : "0");
});

app.get("/debug/timer", (req, res) => {
  res.json({
    timerBerjalan: isTimerRunning,
    waktuTersisa: timeRemaining,
    lastTimerEvent: lastTimerEvent,
    statusKunci: lockState,
    konfigurasi: config,
    waktu: new Date().toLocaleTimeString('id-ID')
  });
});

app.get("/debug/timer/fix", (req, res) => {
  logger.info("Perbaikan timer manual diminta");
  
  // Reset paksa semua
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  if (audioFinishTimeout) {
    clearTimeout(audioFinishTimeout);
    audioFinishTimeout = null;
  }
  
  isTimerRunning = false;
  timeRemaining = 0;
  lockState = { locked: false, activeTeam: null };
  
  io.emit("timerReset");
  io.emit("lockstate", lockState);
  io.emit("systemUnlocked", { reason: "debug_perbaikan" });
  
  res.json({
    sukses: true,
    pesan: "Timer direset paksa",
    timer: {
      berjalan: isTimerRunning,
      waktuTersisa: timeRemaining,
      lastTimerEvent: lastTimerEvent
    },
    statusKunci: lockState
  });
});

// ===== MELAYANI FILE STATIS =====
const possiblePublicDirs = [
  join(process.cwd(), "public"),
  join(__dirname, "public"),
  join(__dirname, "..", "public")
];

let publicDirFound = null;
for (const dir of possiblePublicDirs) {
  if (fs.existsSync(dir)) {
    publicDirFound = dir;
    logger.info(`Direktori public ditemukan: ${dir}`);
    break;
  }
}

if (!publicDirFound) {
  publicDirFound = join(process.cwd(), "public");
  fs.mkdirSync(publicDirFound, { recursive: true });
  logger.info(`Membuat direktori public: ${publicDirFound}`);
}

app.use(express.static(publicDirFound));

const audioDir = join(publicDirFound, "audio");
if (fs.existsSync(audioDir)) {
  app.use('/audio', express.static(audioDir));
} else {
  logger.error('Direktori audio tidak ditemukan, membuat...');
  fs.mkdirSync(audioDir, { recursive: true });
  app.use('/audio', express.static(audioDir));
}

// ===== ROUTE UTAMA =====
app.get("/", (req, res) => {
  res.json({ 
    status: "Sistem Scoring Kuis", 
    versi: "2.0.0",
    lingkungan: isProduction ? "produksi" : "pengembangan",
    siap: true
  });
});

// ===== ROUTE UNTUK TOGGLE TIM =====
app.get("/toggleTeam", (req, res) => {
  const team = parseInt(req.query.team);
  const enabled = req.query.enabled === 'true';
  
  if (!Number.isInteger(team) || team < 1 || team > TEAM_COUNT) {
    return res.status(400).json({ error: "Tim tidak valid" });
  }
  
  teamToggleState[team - 1] = enabled;
  
  io.emit("teamToggleUpdate", {
    team: team,
    enabled: enabled
  });
  
  res.json({ 
    sukses: true, 
    tim: team, 
    diaktifkan: enabled,
    pesan: `Tim ${getTeamLetter(team)} ${enabled ? 'diaktifkan' : 'dinonaktifkan'}` 
  });
});

app.get("/enableAllTeams", (req, res) => {
  teamToggleState = Array(TEAM_COUNT).fill(true);
  
  io.emit("allTeamsEnabled");
  
  res.json({ 
    sukses: true, 
    pesan: "Semua tim diaktifkan",
    statusToggleTim: teamToggleState
  });
});

app.get("/disableAllTeams", (req, res) => {
  teamToggleState = Array(TEAM_COUNT).fill(false);
  
  io.emit("allTeamsDisabled");
  
  res.json({ 
    sukses: true, 
    pesan: "Semua tim dinonaktifkan",
    statusToggleTim: teamToggleState
  });
});

app.get("/teamToggleState", (req, res) => {
  res.json(teamToggleState);
});

// ===== ROUTE UNTUK ESP32 =====
app.get("/esp32checkin", (req, res) => {
  const action = req.query.action || 'heartbeat';
  const team = req.query.team;
  const ip = req.ip || req.connection.remoteAddress;
  
  const realIP = req.headers['x-forwarded-for'] || 
                 req.headers['x-real-ip'] || 
                 req.connection.remoteAddress || 
                 req.socket.remoteAddress ||
                 ip;
  
  const isAdmin = req.headers['user-agent'] && 
                 (req.headers['user-agent'].includes('Mozilla') || 
                  req.headers['user-agent'].includes('Chrome') ||
                  action.includes('admin'));
  
  if (!isAdmin) {
    updateESP32FromHTTP(realIP, `http_${action}`);
  }
  
  res.json({ 
    sukses: true, 
    pesan: "Check-in diterima",
    dariESP32: !isAdmin,
    status: esp32Status.connected ? "CONTROLLER ONLINE" : "CONTROLLER OFFLINE",
    waktu: new Date().toLocaleTimeString('id-ID'),
    ipAnda: realIP
  });
});

app.get("/debug/esp32", (req, res) => {
  const now = new Date();
  res.json({
    waktuSekarang: now.toLocaleTimeString('id-ID'),
    statusESP32: esp32Status,
    terhubung: esp32Status.connected,
    aktivitasTerakhir: esp32Status.lastActivity ? 
      new Date(esp32Status.lastActivity).toLocaleTimeString('id-ID') : "Tidak ada",
    socketId: esp32Status.socketId,
    ip: esp32Status.ip,
    sejakAktivitasTerakhir: esp32Status.lastActivity ? 
      `${Math.floor((now - esp32Status.lastActivity) / 1000)} detik` : "N/A"
  });
});

// ===== ROUTE UNTUK KONTROL PENALTI OTOMATIS =====
app.get("/toggleAutoPenalty", (req, res) => {
  const enabled = req.query.enabled === 'true';
  isAutoPenaltyEnabled = enabled;
  
  io.emit("autoPenaltyToggle", { enabled: isAutoPenaltyEnabled });
  
  res.json({ 
    sukses: true, 
    diaktifkan: isAutoPenaltyEnabled,
    pesan: `Penalti otomatis ${enabled ? 'diaktifkan' : 'dinonaktifkan'}` 
  });
});

app.get("/autoPenaltyStatus", (req, res) => {
  res.json({ 
    diaktifkan: isAutoPenaltyEnabled,
    poinPenalti: config.minus,
    deskripsi: "Penalti otomatis diterapkan saat timer habis tanpa respon juri"
  });
});

// ====== ENDPOINT UPDATE YANG SANGAT CEPAT ======
app.get("/update", (req, res) => {
  const startTime = Date.now();
  
  if (!req.query.team) {
    return res.status(400).json({ error: "Parameter team diperlukan" });
  }

  const team = parseInt(req.query.team);
  
  // Cek toggle state dengan cepat
  if (!teamToggleState[team - 1]) {
    return res.status(403).json({ error: "Tombol tim dinonaktifkan" });
  }
  
  const add = parseInt(req.query.add) || 0;
  const isFirst = req.query.first === "1";

  // Update ESP32 status tanpa log berat
  const ip = req.ip || req.connection.remoteAddress;
  if (ip.includes('192.168.1.') || ip.includes('172.') || ip.includes('10.')) {
    const activityType = `buzzer_${isFirst ? 'tekan_pertama' : 'scoring'}`;
    updateESP32Status(true, null, ip, activityType);
  }

  // Validasi cepat
  if (!Number.isInteger(team) || team < 1 || team > TEAM_COUNT) {
    return res.status(400).json({ error: "Tim tidak valid" });
  }

  // Cek lock state dengan atomic operation
  if (lockState.locked && team !== lockState.activeTeam) {
    return res.status(403).json({ error: "Tombol terkunci" });
  }

  // Handle first press - atomic lock
  if (isFirst && !lockState.locked) {
    // Atomic set lock
    lockState = { locked: true, activeTeam: team };
    
    // Broadcast ke semua client SECARA ASYNC untuk performance
    setImmediate(() => {
      io.emit("lockstate", lockState);
      io.emit("buzz", { team });
      
      // Timer langsung dimulai TANPA DELAY
      playBuzzerThenTeamAudio(team);
    });
  }

  // Handle scoring
  if (add !== 0) {
    scores[team - 1] += add;
    
    // Broadcast updates ASYNC untuk performance
    setImmediate(() => {
      io.emit("update", { team, score: scores[team - 1] });
      io.emit("scoring", { team, isCorrect: add > 0 });
      
      // Audio juri
      timerAudio.playJuryAudio(add > 0);
      
      // Feedback message
      const feedbackMessage = generateFeedbackMessage(team, add > 0, add);
      io.emit("aiMessage", {
        message: feedbackMessage,
        type: add > 0 ? "success" : "penalty",
        shouldSpeak: false
      });
      
      // Reset semua state
      resetTimer();
      lockState = { locked: false, activeTeam: null };
      io.emit("lockstate", lockState);
    });
  }

  // Response INSTANT (<5ms target)
  const responseTime = Date.now() - startTime;
  
  if (responseTime > 20 && !isProduction) {
    logger.performance(`Response time: ${responseTime}ms`, { 
      tim: team, 
      pertama: isFirst,
      add: add 
    });
  }
  
  res.json({ 
    sukses: true, 
    pesan: "OK", 
    tim: team, 
    tambah: add, 
    pertama: isFirst,
    responseTime: `${responseTime}ms`
  });
});

app.get("/audioFinished", (req, res) => {
  const action = req.query.action;
  const team = parseInt(req.query.team);
  const audioType = req.query.type || 'team';
  
  if (audioFinishTimeout) {
    clearTimeout(audioFinishTimeout);
    audioFinishTimeout = null;
  }
  
  if (action === "startTimer" && team && audioType === 'team') {
    // Timer sudah dimulai lebih awal, abaikan callback
  }
  
  res.json({ 
    sukses: true, 
    pesan: "Audio selesai diproses",
    timerDimulai: isTimerRunning
  });
});

app.get("/preTeamAudioFinished", (req, res) => {
  const team = parseInt(req.query.team);
  
  if (team) {
    const teamAudioFile = getTeamAudioFile(team);
    
    io.emit("playTeamAudio", {
      team: team,
      audioFile: teamAudioFile,
      timerDuration: config.timerDuration
    });
  }
  
  res.json({ 
    sukses: true, 
    pesan: "Audio pre-tim selesai, audio tim dimulai",
    tim: team
  });
});

app.get("/triggerAudio", (req, res) => {
  const team = parseInt(req.query.team);
  
  if (!Number.isInteger(team) || team < 1 || team > TEAM_COUNT) {
    return res.status(400).json({ error: "Tim tidak valid" });
  }
  
  playBuzzerThenTeamAudio(team);
  
  res.json({ sukses: true, tim: team, aksi: "urutan_buzzer_dipicu" });
});

app.get("/unlock", (req, res) => {
  resetTimer();
  lockState = { locked: false, activeTeam: null };
  io.emit("lockstate", lockState);
  
  res.json({ sukses: true, pesan: "Sistem dibuka dan timer direset", statusKunci: lockState });
});

app.get("/setconfig", (req, res) => {
  const plus = parseInt(req.query.plus);
  const minus = parseInt(req.query.minus);
  const timerDuration = parseInt(req.query.timerDuration);
  
  if (!Number.isNaN(plus)) config.plus = plus;
  if (!Number.isNaN(minus)) config.minus = minus;
  if (!Number.isNaN(timerDuration) && timerDuration >= 5 && timerDuration <= 300) {
    config.timerDuration = timerDuration;
  }
  
  io.emit("config", config);
  
  io.emit("autoPenaltyConfig", { 
    diaktifkan: isAutoPenaltyEnabled,
    poinPenalti: config.minus 
  });
  
  res.json({ sukses: true, konfigurasi: config });
});

app.get("/reset", (req, res) => {
  scores = Array(TEAM_COUNT).fill(0);
  resetTimer();
  lockState = { locked: false, activeTeam: null };
  io.emit("reset", scores);
  io.emit("lockstate", lockState);
  res.json({ sukses: true, pesan: "Skor direset dan timer direset", skor: scores });
});

app.get("/scores", (req, res) => {
  res.json(scores);
});

app.get("/lockstate", (req, res) => {
  res.json(lockState);
});

app.get("/config", (req, res) => {
  res.json(config);
});

app.get("/esp32status", (req, res) => {
  const now = new Date();
  const statusInfo = {
    terhubung: esp32Status.connected,
    aktivitasTerakhir: esp32Status.lastActivity,
    checkinTerakhir: esp32Status.lastCheckin,
    socketId: esp32Status.socketId,
    ip: esp32Status.ip,
    tipeKoneksi: esp32Status.connectionType,
    controller: "ESP32 Master Controller",
    fitur: [
      "12 Tombol Buzzer Tim",
      "Kontrol Juri (Benar/Salah)", 
      "LED Feedback",
      "Konfigurasi WiFi Manager",
      "Dukungan Audio Trigger"
    ],
    status: esp32Status.connected ? "CONTROLLER ONLINE" : "CONTROLLER OFFLINE",
    uptime: esp32Status.lastActivity ? 
      `${Math.floor((now - esp32Status.lastActivity) / 1000)} detik` : "N/A",
    waktuSekarang: now.toLocaleTimeString('id-ID')
  };
  
  res.json(statusInfo);
});

app.get("/health", (req, res) => {
  const now = new Date();
  res.json({ 
    status: "OK", 
    skor: scores, 
    statusKunci: lockState, 
    konfigurasi: config,
    timer: {
      berjalan: isTimerRunning,
      tersisa: timeRemaining,
      lastTimerEvent: lastTimerEvent
    },
    esp32: esp32Status,
    penaltiOtomatis: {
      diaktifkan: isAutoPenaltyEnabled,
      poinPenalti: config.minus
    },
    toggleTim: {
      status: teamToggleState,
      jumlahAktif: teamToggleState.filter(state => state).length,
      jumlahNonaktif: teamToggleState.filter(state => !state).length
    },
    koneksi: io.engine.clientsCount,
    lingkungan: isProduction ? "produksi" : "pengembangan"
  });
});

// ===== HANDLER 404 DAN ERROR =====
app.use((req, res) => {
  res.status(404).json({ error: "Route tidak ditemukan" });
});

app.use((err, req, res, next) => {
  logger.error('Error server:', err);
  res.status(500).json({ 
    error: "Internal server error",
    pesan: isProduction ? "Terjadi kesalahan" : err.message
  });
});

// ===== SOCKET.IO HANDLERS OPTIMIZED =====
io.on("connection", (socket) => {
  const clientType = socket.handshake.query.clientType || 'unknown';
  const clientIP = socket.handshake.address;
  const userAgent = socket.handshake.headers['user-agent'] || 'unknown';
  
  const isESP32 = clientType === 'esp32' || 
                  clientIP.includes('192.168.1.') || 
                  clientIP.includes('172.') || 
                  clientIP.includes('10.') ||
                  userAgent.toLowerCase().includes('esp32') ||
                  userAgent.toLowerCase().includes('arduino');

  if (isESP32) {
    updateESP32Status(true, socket, clientIP, "koneksi_socket");
    
    // Handler untuk ping test dari admin
    socket.on("pingFromAdmin", (data, callback) => {
      if (callback) {
        callback({
          sukses: true,
          pesan: "ESP32 ONLINE DAN MERESPON",
          timestamp: Date.now(),
          dataDiterima: data,
          idESP32: "MASTER_CONTROLLER",
          firmware: "ESP32_QUIZ_BUZZER_V2"
        });
      }
      
      updateESP32Status(true, socket, clientIP, "respon_test_ping");
    });
    
    socket.on("esp32Heartbeat", (data) => {
      updateESP32Status(true, socket, clientIP, "detak_jantung");
    });
    
    socket.on("esp32Activity", (data) => {
      updateESP32Status(true, socket, clientIP, "aktivitas");
    });
  }

  // Kirim data awal ke client - dikurangi yang tidak perlu
  socket.emit("scores", scores);
  socket.emit("config", config);
  socket.emit("lockstate", lockState);
  socket.emit("teamToggleState", teamToggleState);
  socket.emit("esp32Status", esp32Status);
  socket.emit("autoPenaltyStatus", { 
    diaktifkan: isAutoPenaltyEnabled,
    poinPenalti: config.minus 
  });
  
  if (isTimerRunning) {
    socket.emit("timerStart", { duration: timeRemaining });
  }

  // Event untuk kontrol timer
  socket.on("requestTimerReset", () => {
    resetTimer();
    socket.emit("timerResetConfirm", { sukses: true });
  });
  
  socket.on("getTimerStatus", () => {
    socket.emit("timerStatusResponse", {
      berjalan: isTimerRunning,
      waktuTersisa: timeRemaining,
      statusKunci: lockState,
      lastTimerEvent: lastTimerEvent
    });
  });

  socket.on("preTeamAudioFinished", (data) => {
    const team = data.team;
    
    if (team) {
      const teamAudioFile = getTeamAudioFile(team);
      
      io.emit("playTeamAudio", {
        team: team,
        audioFile: teamAudioFile,
        timerDuration: config.timerDuration
      });
    }
  });

  socket.on("disconnect", (reason) => {
    const wasESP32 = clientType === 'esp32' || 
                     clientIP.includes('192.168.1.') || 
                     clientIP.includes('172.') || 
                     clientIP.includes('10.');
                     
    if (wasESP32) {
      updateESP32Status(false, null, null, "socket_terputus");
    }
  });
});

// ===== MONITORING ESP32 =====
setInterval(() => {
  if (esp32Status.connected && esp32Status.lastActivity) {
    const timeSinceLastActivity = Date.now() - esp32Status.lastActivity.getTime();
    if (timeSinceLastActivity > 120000) {
      logger.esp32("INFO: Tidak ada aktivitas ESP32 baru", {
        aktivitasTerakhir: esp32Status.lastActivity,
        menitTidakAktif: Math.floor(timeSinceLastActivity / 60000)
      });
    }
  }
}, 60000);

// ===== MEMULAI SERVER =====
async function startServer() {
  validateAudioFiles();
  
  http.listen(PORT, async () => {
    console.log('========================================');
    console.log('SISTEM KUIS - Ridwan and Team');
    console.log('========================================');
    console.log(`Lingkungan: ${isProduction ? 'PRODUKSI' : 'PENGEMBANGAN'}`);
    console.log(`Tampilan: http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin.html`);
    console.log('========================================');
    console.log(`Server optimized for fast button response`);
    console.log(`Target response time: <20ms`);
    console.log('========================================');
  });
}

startServer();