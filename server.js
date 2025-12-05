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
    
    const whitelistIPs = [
      '192.168.1.',
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:192.168.1.',
      '172.',
      '10.'
    ];
    
    const whitelistURLs = [
      '/health',
      '/esp32checkin', 
      '/esp32status',
      '/config',
      '/lockstate',
      '/update'
    ];
    
    const isWhitelistedIP = whitelistIPs.some(ip => clientIP && clientIP.includes(ip));
    const isWhitelistedURL = whitelistURLs.some(url => req.url.startsWith(url));
    
    if (isWhitelistedIP || isWhitelistedURL) {
      return 5000;
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

// ===== DATA STATE DENGAN ATOMIC LOCK =====
let scores = Array(TEAM_COUNT).fill(0);
let config = { plus: 5, minus: -2, timerDuration: 30 };
let lockState = { 
  locked: false, 
  activeTeam: null,
  lockTime: null,  // Timestamp ketika terkunci
  lockId: null     // ID unik untuk lock
};
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
  lastBroadcast: null,
  lastHeartbeat: null,
  heartbeatCount: 0
};

// ===== SISTEM LOG OPTIMIZED =====
const logger = {
  info: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  error: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.error(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  audio: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] AUDIO: ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  esp32: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] ESP32: ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  lock: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] LOCK: ${message}`, data ? JSON.stringify(data, null, 2) : '');
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
      logger.audio(`Memutar buzzer untuk Tim ${getTeamLetter(team)}`);
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

// ===== ATOMIC LOCK FUNCTIONS - OPTIMIZED FOR RESPONSIVENESS =====
function acquireAtomicLock(team) {
  const now = Date.now();
  const lockThreshold = 3; // Threshold 3ms untuk responsivitas maksimal
  
  if (lockState.locked) {
    const lockAge = now - (lockState.lockTime || now);
    
    // Jika lock sangat baru (dalam threshold), abaikan semua request lain
    if (lockAge < lockThreshold) {
      logger.lock(`Lock DITOLAK - Tim ${getTeamLetter(team)} terlambat ${lockAge}ms`);
      return false;
    }
    
    // Jika sudah terkunci oleh tim lain
    if (lockState.activeTeam !== team) {
      const lockAge = now - (lockState.lockTime || now);
      logger.lock(`Lock DENIED untuk Tim ${getTeamLetter(team)} - ` +
                 `sudah terkunci oleh Tim ${getTeamLetter(lockState.activeTeam)} ` +
                 `(${lockAge}ms yang lalu)`);
      return false;
    }
    
    // Jika terkunci oleh tim yang sama tapi baru saja (anti-duplicate)
    if (lockAge < 100) {
      logger.lock(`Duplikat buzz dari Tim ${getTeamLetter(team)} diabaikan`);
      return false;
    }
  }
  
  // ATOMIC: Set lock dengan timestamp presisi dan ID unik
  lockState = { 
    locked: true, 
    activeTeam: team,
    lockTime: now,
    lockId: `lock_${now}_${team}_${Math.random().toString(36).substr(2, 9)}`
  };
  
  logger.lock(`Lock ACQUIRED untuk Tim ${getTeamLetter(team)} pada ${now}`, {
    lockId: lockState.lockId,
    timestamp: now
  });
  return true;
}

function releaseAtomicLock() {
  const previousActive = lockState.activeTeam;
  lockState = { 
    locked: false, 
    activeTeam: null,
    lockTime: null,
    lockId: null
  };
  logger.lock(`Lock RELEASED (previous active: ${previousActive ? getTeamLetter(previousActive) : 'none'})`);
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
  
  // Broadcast secara async
  setImmediate(() => {
    io.emit("update", { team: activeTeam, score: scores[activeTeam - 1] });
    io.emit("scoring", { team: activeTeam, isCorrect: false });
  });
  
  // Release atomic lock
  const previousActiveTeam = lockState.activeTeam;
  releaseAtomicLock();
  
  // Hentikan timer
  isTimerRunning = false;
  timeRemaining = 0;
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  // Broadcast semua event
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
    releaseAtomicLock();
    
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
    
    // Update heartbeat jika tipe heartbeat
    if (activityType.includes('heartbeat') || activityType.includes('checkin')) {
      esp32Status.lastHeartbeat = new Date();
      esp32Status.heartbeatCount = (esp32Status.heartbeatCount || 0) + 1;
    }
    
    if (socket) {
      esp32Status.socketId = socket.id;
    }
    
    if (ip) {
      esp32Status.ip = ip;
    }
    
    logger.esp32(`Aktivitas ESP32 - ${activityType}`, {
      ip: ip,
      socketId: socket ? socket.id : 'HTTP',
      waktu: esp32Status.lastActivity.toLocaleTimeString('id-ID'),
      heartbeatCount: esp32Status.heartbeatCount
    });
    
  } else {
    if (activityType === "esp32_shutdown" || activityType === "socket_disconnect") {
      esp32Status.connected = false;
      esp32Status.connectionType = "terputus";
    }
  }
  
  // SELALU BROADCAST STATUS
  io.emit("esp32Status", esp32Status);
  esp32Status.lastBroadcast = new Date();
}

function updateESP32FromHTTP(ip, activityType = "http_activity") {
  const now = Date.now();
  
  // PERBAIKAN: Selalu update status jika ada aktivitas HTTP
  esp32Status.connected = true;
  esp32Status.lastActivity = new Date();
  esp32Status.lastCheckin = new Date();
  esp32Status.connectionType = activityType;
  esp32Status.ip = ip;
  
  // Broadcast status
  io.emit("esp32Status", esp32Status);
  logger.esp32(`ESP32 HTTP activity - ${activityType}`, {
    ip: ip,
    status: 'ONLINE'
  });
  
  return esp32Status;
}

// ===== CHECK ESP32 STATUS =====
function checkESP32Status() {
  const now = Date.now();
  if (esp32Status.lastActivity) {
    const timeSinceLastActivity = now - esp32Status.lastActivity.getTime();
    
    // Timeout diperpanjang dari 90 detik → 300 detik (5 menit)
    if (timeSinceLastActivity > 300000 && esp32Status.connected) {
      logger.esp32("ESP32 status timeout - marking as disconnected", {
        lastActivity: esp32Status.lastActivity,
        secondsInactive: Math.floor(timeSinceLastActivity / 1000)
      });
      
      esp32Status.connected = false;
      esp32Status.connectionType = "timeout";
      io.emit("esp32Status", esp32Status);
    }
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

  io.emit("timerStart", { duration: config.timerDuration });
  lastTimerEvent = 'timerStart';
  
  logger.performance("Timer dimulai", { 
    waktuTersisa: timeRemaining, 
    timAktif: currentActiveTeam,
    hurufTim: getTeamLetter(currentActiveTeam)
  });

  timerInterval = setInterval(() => {
    timeRemaining--;
    
    io.emit("timerUpdate", { timeRemaining });
    lastTimerEvent = 'timerUpdate';

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
      
      setTimeout(() => {
        if (isAutoPenaltyEnabled && lockState.locked && lockState.activeTeam) {
          handleAutoPenalty();
        } else {
          unlockSystemOnTimerEnd();
        }
      }, 10);
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
  
  // PERBAIKAN: Selalu buka kunci saat timer dihentikan
  if (lockState.locked) {
    releaseAtomicLock();
  }
  
  io.emit("timerReset");
  io.emit("lockstate", lockState); // Kirim state terbaru
  lastTimerEvent = 'timerReset';

  logger.performance("Timer dihentikan", { 
    timAktif: activeTeam,
    lastTimerEvent: lastTimerEvent,
    lockState: lockState
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
  
  // PERBAIKAN: Selalu buka kunci saat timer direset
  if (lockState.locked) {
    releaseAtomicLock();
  }
  
  io.emit("timerReset");
  io.emit("lockstate", lockState); // Kirim state terbaru
  lastTimerEvent = 'timerReset';
  
  // Reset lockTime juga
  lockState.lockTime = null;
  
  logger.performance("Timer direset manual", {
    lockState: lockState
  });
}

// ===== FUNGSI BUKA KUNCI PAKSA =====
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
  releaseAtomicLock();
  
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
  
  logger.audio(`Memulai urutan audio untuk Tim ${getTeamLetter(team)}`);
  
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

// ===== ENDPOINT UPDATE DENGAN ATOMIC LOCK OPTIMIZED =====
app.get("/update", (req, res) => {
  const startTime = Date.now();
  const requestTime = Date.now();
  const clientIP = req.ip || req.connection.remoteAddress;
  
  // EXTREME FAST PATH: Validasi cepat
  if (!req.query.team) {
    logger.error("UPDATE: Missing team parameter");
    return res.status(400).json({ error: "Parameter team diperlukan" });
  }

  const team = parseInt(req.query.team);
  
  // Validasi ultra-cepat
  if (!Number.isInteger(team) || team < 1 || team > TEAM_COUNT) {
    logger.error(`UPDATE: Invalid team ${team}`);
    return res.status(400).json({ error: "Tim tidak valid" });
  }
  
  // Cek toggle state - cache lokal untuk kecepatan
  if (!teamToggleState[team - 1]) {
    logger.error(`UPDATE: Team ${team} disabled`);
    return res.status(403).json({ error: "Tombol tim dinonaktifkan" });
  }
  
  const add = parseInt(req.query.add) || 0;
  const isFirst = req.query.first === "1";

  // Update ESP32 status
  logger.esp32(`UPDATE from IP: ${clientIP}, Team: ${team}, First: ${isFirst}`);
  
  if (clientIP.includes('192.168.1.') || clientIP.includes('172.') || clientIP.includes('10.')) {
    const activityType = `buzzer_${isFirst ? 'tekan_pertama' : 'scoring'}`;
    updateESP32FromHTTP(clientIP, activityType);
  }

  // ===== ATOMIC LOCK HANDLING ULTRA-FAST =====
  if (isFirst) {
    // Coba acquire atomic lock dengan threshold 3ms
    if (!acquireAtomicLock(team)) {
      const lockAge = Date.now() - (lockState.lockTime || Date.now());
      const currentTeam = lockState.activeTeam;
      
      logger.lock(`Request DITOLAK: Tim ${getTeamLetter(team)} - ` +
                 `sistem sudah terkunci oleh Tim ${getTeamLetter(currentTeam)} ` +
                 `(${lockAge}ms yang lalu)`);
      
      return res.status(403).json({ 
        error: "Tombol terkunci",
        lockedBy: currentTeam,
        lockAge: `${lockAge}ms`,
        message: `Tim ${getTeamLetter(currentTeam)} lebih cepat ${lockAge}ms`,
        responseTime: `${Date.now() - startTime}ms`
      });
    }
    
    // Lock berhasil diacquire, lanjutkan proses
    logger.lock(`Request DITERIMA: Tim ${getTeamLetter(team)} berhasil terkunci`);
    
    // Async broadcast untuk performance
    setImmediate(() => {
      io.emit("lockstate", lockState);
      io.emit("buzz", { team });
      
      // Timer langsung dimulai
      playBuzzerThenTeamAudio(team);
    });
  }

  // Handle scoring dengan optimasi
  if (add !== 0) {
    logger.info(`Scoring: Team ${team} add ${add} points`);
    scores[team - 1] += add;
    
    // Async broadcast untuk performance
    setImmediate(() => {
      io.emit("update", { team, score: scores[team - 1] });
      io.emit("scoring", { team, isCorrect: add > 0 });
      
      timerAudio.playJuryAudio(add > 0);
      
      const feedbackMessage = generateFeedbackMessage(team, add > 0, add);
      io.emit("aiMessage", {
        message: feedbackMessage,
        type: add > 0 ? "success" : "penalty",
        shouldSpeak: false
      });
      
      // Release lock dan reset timer
      releaseAtomicLock();
      resetTimer();
      
      io.emit("lockstate", lockState);
    });
  }

  // Response ultra-cepat
  const responseTime = Date.now() - startTime;
  
  logger.performance(`UPDATE Response time: ${responseTime}ms`, { 
    tim: team, 
    pertama: isFirst,
    add: add,
    locked: isFirst ? true : lockState.locked
  });
  
  res.json({ 
    sukses: true, 
    pesan: "OK", 
    tim: team, 
    tambah: add, 
    pertama: isFirst,
    responseTime: `${responseTime}ms`,
    locked: lockState.locked,
    lockedBy: lockState.activeTeam,
    lockId: lockState.lockId
  });
});

// ===== ENDPOINT LAINNYA =====
app.get("/timerstate", (req, res) => {
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
  releaseAtomicLock();
  
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

// ===== ENDPOINT BARU: FORCE UNLOCK ALL =====
app.get("/forceUnlockAll", (req, res) => {
  logger.info("Force unlock all requested");
  
  // Reset semua state
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  isTimerRunning = false;
  timeRemaining = 0;
  
  // Buka semua kunci
  releaseAtomicLock();
  
  // Pastikan lock state benar-benar reset
  lockState = { 
    locked: false, 
    activeTeam: null,
    lockTime: null,
    lockId: null
  };
  
  // Broadcast ke semua client
  io.emit("lockstate", lockState);
  io.emit("timerReset");
  io.emit("systemUnlocked", { reason: "force_unlock_all" });
  
  res.json({
    sukses: true,
    pesan: "Semua kunci dibuka paksa",
    lockState: lockState,
    timerRunning: isTimerRunning
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
  
  if (!Number.isInteger(team) || team < 1 || team <= TEAM_COUNT) {
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
    // Update status ESP32 dengan heartbeat
    const status = updateESP32FromHTTP(realIP, `heartbeat_${action}`);
    
    // Log heartbeat
    logger.esp32(`ESP32 heartbeat received`, {
      ip: realIP,
      action: action,
      team: team,
      heartbeatCount: status.heartbeatCount
    });
    
    // Broadcast ke semua client
    io.emit("esp32Status", status);
    io.emit("esp32Activity", {
      timestamp: new Date(),
      activity: { type: action, team: team },
      ip: realIP,
      socketId: "HTTP_HEARTBEAT"
    });
  }
  
  res.json({ 
    sukses: true, 
    pesan: "Check-in diterima",
    dariESP32: !isAdmin,
    status: esp32Status.connected ? "CONTROLLER ONLINE" : "CONTROLLER OFFLINE",
    waktu: new Date().toLocaleTimeString('id-ID'),
    ipAnda: realIP,
    heartbeatCount: esp32Status.heartbeatCount
  });
});

// ===== ENDPOINT BARU: ESP32 ACTIVITY REAL-TIME =====
app.get("/esp32activity", (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const activityType = req.query.type || 'activity';
  const team = req.query.team;
  
  // Update status dengan aktivitas terbaru
  updateESP32FromHTTP(ip, `http_${activityType}_team${team}`);
  
  // BROADCAST LANGSUNG ke semua client
  io.emit("esp32Status", esp32Status);
  io.emit("esp32Activity", {
    timestamp: new Date(),
    activity: { type: activityType, team: team },
    ip: ip,
    socketId: "HTTP_ACTIVITY"
  });
  
  res.json({
    sukses: true,
    status: esp32Status,
    broadcasted: true,
    waktu: new Date().toLocaleTimeString('id-ID')
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
    heartbeatTerakhir: esp32Status.lastHeartbeat ?
      new Date(esp32Status.lastHeartbeat).toLocaleTimeString('id-ID') : "Tidak ada",
    heartbeatCount: esp32Status.heartbeatCount || 0,
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

app.get("/audioFinished", (req, res) => {
  const action = req.query.action;
  const team = parseInt(req.query.team);
  const audioType = req.query.type || 'team';
  
  if (audioFinishTimeout) {
    clearTimeout(audioFinishTimeout);
    audioFinishTimeout = null;
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
  releaseAtomicLock();
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
  releaseAtomicLock();
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
    heartbeatTerakhir: esp32Status.lastHeartbeat,
    heartbeatCount: esp32Status.heartbeatCount || 0,
    socketId: esp32Status.socketId,
    ip: esp32Status.ip,
    tipeKoneksi: esp32Status.connectionType,
    controller: "ESP32 Master Controller",
    fitur: [
      "12 Tombol Buzzer Tim",
      "Kontrol Juri (Benar/Salah)", 
      "LED Feedback",
      "Konfigurasi WiFi Manager",
      "Dukungan Audio Trigger",
      "Heartbeat System"
    ],
    status: esp32Status.connected ? "CONTROLLER ONLINE" : "CONTROLLER OFFLINE",
    uptime: esp32Status.lastActivity ? 
      `${Math.floor((now - esp32Status.lastActivity) / 1000)} detik` : "N/A",
    waktuSekarang: now.toLocaleTimeString('id-ID')
  };
  
  res.json(statusInfo);
});

// ===== ENDPOINT BARU: TEST KONEKSI ESP32 =====
app.get("/testESP32Connection", (req, res) => {
  const now = new Date();
  const timeSinceLastActivity = esp32Status.lastActivity ? 
    Math.floor((now - esp32Status.lastActivity) / 1000) : Infinity;
  
  const isRecentlyActive = timeSinceLastActivity < 300; // 300 detik (5 menit)
  
  res.json({
    sukses: isRecentlyActive,
    tipeKoneksi: esp32Status.connectionType || "unknown",
    pesan: isRecentlyActive ? 
      "ESP32 terdeteksi aktif dalam 5 menit terakhir" : 
      "ESP32 tidak aktif dalam 5 menit terakhir",
    detail: {
      terhubung: esp32Status.connected,
      aktivitasTerakhir: esp32Status.lastActivity,
      heartbeatCount: esp32Status.heartbeatCount,
      ip: esp32Status.ip,
      sejakAktivitasTerakhir: `${timeSinceLastActivity} detik`
    },
    waktuRespon: new Date().toLocaleTimeString('id-ID'),
    saran: !isRecentlyActive ? "Cek koneksi WiFi ESP32 atau restart ESP32" : null
  });
});

// ===== DEBUG ENDPOINT =====
app.get("/debug/connections", (req, res) => {
  res.json({
    totalConnections: io.engine.clientsCount,
    esp32Status: esp32Status,
    lockState: lockState,
    timerRunning: isTimerRunning,
    timeRemaining: timeRemaining,
    scores: scores,
    config: config,
    autoPenalty: isAutoPenaltyEnabled,
    timestamp: new Date().toISOString()
  });
});

app.get("/debug/resetlock", (req, res) => {
  logger.info("[DEBUG] Manual lock reset");
  releaseAtomicLock();
  resetTimer();
  io.emit("lockstate", lockState);
  io.emit("timerReset");
  
  res.json({ 
    success: true, 
    message: "Lock manually reset",
    lockState: lockState 
  });
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

  logger.info(`New connection: ${socket.id}`, {
    ip: clientIP,
    userAgent: userAgent,
    isESP32: isESP32
  });

  if (isESP32) {
    updateESP32Status(true, socket, clientIP, "koneksi_socket");
    
    // BROADCAST LANGSUNG
    io.emit("esp32Status", esp32Status);
    
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
      io.emit("esp32Status", esp32Status);
    });
    
    socket.on("esp32Heartbeat", (data) => {
      updateESP32Status(true, socket, clientIP, "detak_jantung");
      io.emit("esp32Status", esp32Status);
    });
    
    socket.on("esp32Activity", (data) => {
      updateESP32Status(true, socket, clientIP, "aktivitas");
      io.emit("esp32Status", esp32Status);
    });
  }

  // Kirim data awal ke client
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

  // ===== EVENT BARU: REQUEST STATUS ESP32 =====
  socket.on("getESP32Status", () => {
    socket.emit("esp32Status", esp32Status);
  });

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
      io.emit("esp32Status", esp32Status);
    }
    
    logger.info(`Disconnect: ${socket.id}`, { reason: reason, wasESP32: wasESP32 });
  });
});

// ===== MONITORING ESP32 =====
setInterval(checkESP32Status, 60000); // Cek setiap 60 detik

// ===== MEMULAI SERVER =====
async function startServer() {
  validateAudioFiles();
  
  http.listen(PORT, async () => {
    console.log('========================================');
    console.log('SISTEM KUIS');
    console.log('========================================');
    console.log(`Lingkungan: ${isProduction ? 'PRODUKSI' : 'PENGEMBANGAN'}`);
    console.log(`Tampilan: http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin.html`);
    console.log('========================================');
  });
}

startServer();