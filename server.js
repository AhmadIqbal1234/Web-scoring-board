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
      '/update',
      '/checktimer',
      '/timerstatus',
      '/synctimer',
      '/ping',
      '/debug/monitoring'
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
  pingInterval: 25000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true
  }
});

// ===== DATA STATE DENGAN ATOMIC LOCK =====
let scores = Array(TEAM_COUNT).fill(0);
let config = { plus: 5, minus: -2, timerDuration: 30 };
let lockState = { 
  locked: false, 
  activeTeam: null,
  lockTime: null,
  lockId: null,
  lockSequence: 0  // Ditambahkan: sequence number untuk atomic lock
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
  heartbeatCount: 0,
  modulesDetected: 0,
  activeTeams: 0,
  wifiRSSI: 0,
  lastRSSIUpdate: null,  // Ditambahkan: timestamp RSSI
  rssiHistory: []        // Ditambahkan: history RSSI untuk monitoring
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

// ===== SISTEM AUDIO DENGAN ACKNOWLEDGMENT =====
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

  playCountdownAudio(seconds, callback = null) {
    const audioFile = this.audioFiles[seconds];
    if (audioFile) {
      io.emit("playTimerAudio", {
        seconds: seconds,
        audioFile: audioFile,
        audioId: `countdown_${Date.now()}_${seconds}`
      });
      
      logger.audio(`Memutar countdown audio: ${audioFile}`, { audioId: seconds });
      
      // Jika ada callback, eksekusi setelah delay (simulasi audio selesai)
      if (callback) {
        setTimeout(callback, 1000);
      }
    }
  }

  playJuryAudio(isCorrect, callback = null) {
    const audioFile = isCorrect ? this.juryAudio.correct : this.juryAudio.wrong;
    if (audioFile) {
      const audioId = `jury_${Date.now()}_${isCorrect ? 'correct' : 'wrong'}`;
      io.emit("playJuryAudio", {
        isCorrect: isCorrect,
        audioFile: audioFile,
        audioId: audioId
      });
      
      logger.audio(`Memutar audio juri: ${audioFile}`, { audioId: audioId });
      
      if (callback) {
        setTimeout(callback, 800);
      }
    }
  }

  playPreTeamAudio(team, callback = null) {
    if (this.preTeamAudio) {
      const audioId = `preteam_${Date.now()}_${team}`;
      io.emit("playPreTeamAudio", {
        team: team,
        audioFile: this.preTeamAudio,
        audioId: audioId
      });
      
      logger.audio(`Memutar buzzer untuk Tim ${getTeamLetter(team)}`, { audioId: audioId });
      
      if (callback) {
        setTimeout(callback, 500); // Buzzer biasanya pendek
      }
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

// ===== ATOMIC LOCK FUNCTIONS DIPERBAIKI =====
function acquireAtomicLock(team) {
  const now = Date.now();
  const lockThreshold = 50; // DITINGKATKAN dari 10ms ke 50ms
  
  if (lockState.locked) {
    const lockAge = now - (lockState.lockTime || now);
    
    // PERBAIKAN: Validasi lock sequence
    if (lockAge < lockThreshold) {
      logger.lock(`Lock DITOLAK - Tim ${getTeamLetter(team)} terlambat ${lockAge}ms (threshold: ${lockThreshold}ms)`);
      return { success: false, reason: 'lock_too_new', lockAge };
    }
    
    if (lockState.activeTeam !== team) {
      logger.lock(`Lock DENIED untuk Tim ${getTeamLetter(team)} - sudah terkunci oleh Tim ${getTeamLetter(lockState.activeTeam)} (${lockAge}ms yang lalu)`);
      return { success: false, reason: 'already_locked', lockedBy: lockState.activeTeam, lockAge };
    }
    
    if (lockAge < 100) {
      logger.lock(`Duplikat buzz dari Tim ${getTeamLetter(team)} diabaikan`);
      return { success: false, reason: 'duplicate', lockAge };
    }
  }
  
  // PERBAIKAN: Tambah sequence number untuk tracking
  lockState.lockSequence++;
  lockState = { 
    locked: true, 
    activeTeam: team,
    lockTime: now,
    lockId: `lock_${now}_${lockState.lockSequence}_${team}_${Math.random().toString(36).substr(2, 9)}`,
    lockSequence: lockState.lockSequence
  };
  
  logger.lock(`Lock ACQUIRED untuk Tim ${getTeamLetter(team)}`, {
    lockId: lockState.lockId,
    timestamp: now,
    sequence: lockState.lockSequence
  });
  
  return { success: true, lockId: lockState.lockId, sequence: lockState.lockSequence };
}

function releaseAtomicLock() {
  const previousActive = lockState.activeTeam;
  const previousLockId = lockState.lockId;
  
  lockState = { 
    locked: false, 
    activeTeam: null,
    lockTime: null,
    lockId: null,
    lockSequence: lockState.lockSequence // Pertahankan sequence
  };
  
  logger.lock(`Lock RELEASED`, {
    previousActive: previousActive ? getTeamLetter(previousActive) : 'none',
    previousLockId: previousLockId
  });
}

// ===== SISTEM PENALTI OTOMATIS =====
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
  
  scores[activeTeam - 1] += penaltyPoints;
  
  setImmediate(() => {
    io.emit("update", { team: activeTeam, score: scores[activeTeam - 1] });
    io.emit("scoring", { team: activeTeam, isCorrect: false });
  });
  
  const previousActiveTeam = lockState.activeTeam;
  const previousLockId = lockState.lockId;
  releaseAtomicLock();
  
  isTimerRunning = false;
  timeRemaining = 0;
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  setImmediate(() => {
    io.emit("lockstate", lockState);
    io.emit("timerReset");
    io.emit("systemUnlocked", { 
      reason: "auto_penalty_applied",
      previousLockId: previousLockId
    });
    
    const feedbackMessage = `Waktu habis! Tim ${getTeamLetter(activeTeam)} tidak menjawab, dikurangi ${Math.abs(penaltyPoints)} poin!`;
    
    io.emit("aiMessage", {
      message: feedbackMessage,
      type: "warning",
      shouldSpeak: false
    });
  });
  
  logger.info(`AUTO PENALTI diterapkan`, {
    tim: getTeamLetter(activeTeam),
    poinPenalti: penaltyPoints,
    skorSebelum: previousScore,
    skorSekarang: scores[activeTeam - 1],
    lockIdSebelum: previousLockId
  });
}

// ===== FUNGSI BUKA KUNCI SISTEM =====
function unlockSystemOnTimerEnd() {
  logger.performance("Unlock system - timer ended");
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  isTimerRunning = false;
  timeRemaining = 0;
  
  if (lockState.locked) {
    const previousActiveTeam = lockState.activeTeam;
    const previousLockId = lockState.lockId;
    releaseAtomicLock();
    
    setImmediate(() => {
      io.emit("lockstate", lockState);
      io.emit("timerReset");
      io.emit("systemUnlocked", { 
        reason: "timer_expired",
        previousActiveTeam: previousActiveTeam,
        previousLockId: previousLockId
      });
    });
    
    logger.info(`Sistem dibuka karena timer habis`, {
      timSebelum: previousActiveTeam ? getTeamLetter(previousActiveTeam) : 'none',
      lockIdSebelum: previousLockId
    });
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

// ===== UPDATE ESP32 STATUS DENGAN MONITORING RSSI =====
function updateESP32FromHTTP(ip, activityType = "http_activity", data = {}) {
  const now = Date.now();
  
  esp32Status.connected = true;
  esp32Status.lastActivity = new Date();
  esp32Status.lastCheckin = new Date();
  esp32Status.connectionType = activityType;
  esp32Status.ip = ip;
  
  // Update data yang diperlukan: modul, tim aktif, dan RSSI
  if (data.modules !== undefined && data.modules !== null) esp32Status.modulesDetected = data.modules;
  if (data.teams !== undefined && data.teams !== null) esp32Status.activeTeams = data.teams;
  
  // PERBAIKAN: Update RSSI dengan timestamp
  if (data.rssi !== undefined && data.rssi !== null) {
    esp32Status.wifiRSSI = data.rssi;
    esp32Status.lastRSSIUpdate = new Date();
    
    // Simpan history RSSI (max 10 entri)
    esp32Status.rssiHistory.push({
      rssi: data.rssi,
      timestamp: new Date(),
      activityType: activityType
    });
    
    if (esp32Status.rssiHistory.length > 10) {
      esp32Status.rssiHistory = esp32Status.rssiHistory.slice(-10);
    }
  }
  
  // Update heartbeat count jika ada
  if (data.count !== undefined && data.count !== null) {
    esp32Status.heartbeatCount = data.count;
    esp32Status.lastHeartbeat = new Date();
  }
  
  // PERBAIKAN: Kirim notifikasi jika RSSI buruk
  if (esp32Status.wifiRSSI < -80) {
    logger.esp32(`PERINGATAN: Sinyal WiFi lemah: ${esp32Status.wifiRSSI} dBm`);
    
    // Kirim notifikasi ke admin
    io.to('admin').emit('esp32Warning', {
      type: 'weak_signal',
      rssi: esp32Status.wifiRSSI,
      message: `Sinyal WiFi ESP32 lemah: ${esp32Status.wifiRSSI} dBm`
    });
  }
  
  io.emit("esp32Status", esp32Status);
  
  logger.esp32(`ESP32 update: ${activityType}`, {
    ip: ip,
    modules: esp32Status.modulesDetected,
    teams: esp32Status.activeTeams,
    rssi: esp32Status.wifiRSSI,
    heartbeatCount: esp32Status.heartbeatCount,
    rssiHistory: esp32Status.rssiHistory.length
  });
  
  return esp32Status;
}

// ===== CHECK ESP32 STATUS =====
function checkESP32Status() {
  const now = Date.now();
  if (esp32Status.lastActivity) {
    const timeSinceLastActivity = now - esp32Status.lastActivity.getTime();
    
    if (timeSinceLastActivity > 300000 && esp32Status.connected) {
      logger.esp32("ESP32 status timeout - marking as disconnected", {
        lastActivity: esp32Status.lastActivity,
        secondsInactive: Math.floor(timeSinceLastActivity / 1000),
        lastRSSI: esp32Status.wifiRSSI
      });
      
      esp32Status.connected = false;
      esp32Status.connectionType = "timeout";
      io.emit("esp32Status", esp32Status);
      
      // Kirim notifikasi ke admin
      io.to('admin').emit('esp32Warning', {
        type: 'timeout',
        message: `ESP32 tidak aktif selama ${Math.floor(timeSinceLastActivity / 1000)} detik`,
        lastActivity: esp32Status.lastActivity
      });
    }
  }
}

// ===== SISTEM TIMER DIPERBAIKI =====
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

  io.emit("timerStart", { 
    duration: config.timerDuration,
    lockId: lockState.lockId,
    startTime: Date.now()
  });
  lastTimerEvent = 'timerStart';
  
  logger.performance("Timer dimulai", { 
    waktuTersisa: timeRemaining, 
    timAktif: currentActiveTeam,
    hurufTim: getTeamLetter(currentActiveTeam),
    lockId: lockState.lockId
  });

  timerInterval = setInterval(() => {
    timeRemaining--;
    
    io.emit("timerUpdate", { 
      timeRemaining,
      lockId: lockState.lockId
    });
    lastTimerEvent = 'timerUpdate';

    if ([30, 20, 10, 5, 4, 3, 2, 1, 0].includes(timeRemaining)) {
      // PERBAIKAN: Tambah callback untuk acknowledgment
      timerAudio.playCountdownAudio(timeRemaining, () => {
        if (timeRemaining === 0) {
          logger.audio(`Audio countdown 0 selesai, lanjut penalti otomatis`);
        }
      });
    }

    if (timeRemaining <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      isTimerRunning = false;
      
      logger.performance('Timer mencapai 0', {
        lockState: lockState,
        autoPenaltyEnabled: isAutoPenaltyEnabled,
        lockId: lockState.lockId
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
  
  if (lockState.locked) {
    releaseAtomicLock();
  }
  
  io.emit("timerReset", { lockId: lockState.lockId || 'none' });
  io.emit("lockstate", lockState);
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
  
  if (lockState.locked) {
    releaseAtomicLock();
  }
  
  io.emit("timerReset", { lockId: lockState.lockId || 'none' });
  io.emit("lockstate", lockState);
  lastTimerEvent = 'timerReset';
  
  lockState.lockTime = null;
  
  logger.performance("Timer direset manual", {
    lockState: lockState
  });
}

// ===== FUNGSI BUKA KUNCI PAKSA =====
function forceUnlockSystem() {
  logger.info("BUKA KUNCI PAKSA: Buka kunci manual atau darurat");
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  isTimerRunning = false;
  timeRemaining = 0;
  
  const previousLockId = lockState.lockId;
  releaseAtomicLock();
  
  setImmediate(() => {
    io.emit("lockstate", lockState);
    io.emit("timerReset", { lockId: previousLockId || 'none' });
    io.emit("systemUnlocked", { 
      reason: "buka_kunci_manual",
      previousLockId: previousLockId
    });
  });
  
  logger.performance("Sistem dibuka paksa", { previousLockId });
}

// ===== MEMUTAR AUDIO BUZZER DAN TIM DENGAN ACKNOWLEDGMENT =====
function playBuzzerThenTeamAudio(team) {
  logger.audio(`Memulai urutan audio buzzer untuk Tim ${getTeamLetter(team)}`);
  
  // PERBAIKAN: Gunakan callback untuk sequence yang tepat
  timerAudio.playPreTeamAudio(team, () => {
    // Setelah buzzer selesai, mulai audio tim
    logger.audio(`Buzzer selesai, mulai audio tim ${getTeamLetter(team)}`);
    
    const teamAudioFile = getTeamAudioFile(team);
    io.emit("playTeamAudio", {
      team: team,
      audioFile: teamAudioFile,
      timerDuration: config.timerDuration,
      audioId: `team_${Date.now()}_${team}`
    });
  });
}

// ===== FUNGSI RESET TIMER TANPA LOCK =====
function resetTimerOnly() {
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
  
  // PERBAIKAN: Jangan kirim timerReset jika sistem masih terkunci
  // Hanya kirim event timerReset jika tidak ada kunci
  if (!lockState.locked) {
    io.emit("timerReset", { lockId: 'timer_only_reset' });
  }
  
  lastTimerEvent = 'timerReset';
  
  logger.performance("Timer direset (hanya timer)", {
    lockState: lockState
  });
}

// ===== ENDPOINT BARU: FULL STATE RECOVERY =====
app.get("/fullstate", (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  
  // Update ESP32 activity jika dari ESP32
  if (clientIP.includes('192.168.1.') || clientIP.includes('172.') || clientIP.includes('10.')) {
    updateESP32FromHTTP(clientIP, "full_state_request");
  }
  
  const response = {
    success: true,
    timestamp: Date.now(),
    serverTime: new Date().toLocaleTimeString('id-ID'),
    
    // State lengkap untuk recovery
    scores: scores,
    lockState: lockState,
    timer: {
      isRunning: isTimerRunning,
      remaining: timeRemaining,
      duration: config.timerDuration
    },
    config: config,
    teamToggleState: teamToggleState,
    autoPenalty: {
      enabled: isAutoPenaltyEnabled,
      points: config.minus
    },
    esp32Status: {
      connected: esp32Status.connected,
      lastActivity: esp32Status.lastActivity,
      modulesDetected: esp32Status.modulesDetected,
      activeTeams: esp32Status.activeTeams,
      wifiRSSI: esp32Status.wifiRSSI,
      lastRSSIUpdate: esp32Status.lastRSSIUpdate
    },
    
    // Metadata
    version: "2.1.0",
    recoverySupported: true,
    checksum: `state_${Date.now()}_${lockState.lockSequence}`
  };
  
  logger.info("Full state recovery requested", {
    clientIP: clientIP,
    lockId: lockState.lockId,
    timerRunning: isTimerRunning
  });
  
  res.json(response);
});

// ===== ENDPOINT PING =====
app.get("/ping", (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const heap = parseInt(req.query.heap);
  const rssi = parseInt(req.query.rssi);
  const temp = parseFloat(req.query.temp);
  const uptime = parseInt(req.query.uptime);
  
  // Update ESP32 activity
  if (clientIP.includes('192.168.1.') || clientIP.includes('172.') || clientIP.includes('10.')) {
    updateESP32FromHTTP(clientIP, "keep_alive_ping", { 
      heap, 
      rssi, 
      temperature: temp,
      uptime: uptime 
    });
  }
  
  res.json({ 
    status: "OK", 
    timestamp: new Date().toISOString(),
    message: "Ping received",
    serverTime: new Date().toLocaleTimeString('id-ID'),
    lockState: lockState,
    timerRunning: isTimerRunning
  });
});

// ===== ENDPOINT: CHECK TIMER STATUS UNTUK ESP32 =====
app.get("/checktimer", (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const team = parseInt(req.query.team) || 0;
  
  // Update ESP32 activity
  if (clientIP.includes('192.168.1.') || clientIP.includes('172.') || clientIP.includes('10.')) {
    updateESP32FromHTTP(clientIP, `timer_check_team${team}`);
  }
  
  // Prepare response
  const response = {
    timerActive: isTimerRunning,
    lockActive: lockState.locked,
    timeRemaining: timeRemaining,
    lockedByTeam: lockState.activeTeam,
    lockId: lockState.lockId,
    lockSequence: lockState.lockSequence,
    timestamp: Date.now(),
    serverTime: new Date().toLocaleTimeString('id-ID'),
    
    // PERBAIKAN: Tambah informasi untuk recovery
    shouldUnlock: (!isTimerRunning && !lockState.locked) || 
                  (isTimerRunning && timeRemaining <= 0),
    checksum: `timer_${Date.now()}_${lockState.lockSequence}`
  };
  
  logger.performance("Check timer request", {
    team: team,
    clientIP: clientIP,
    response: response
  });
  
  res.setHeader('Content-Type', 'application/json');
  res.json(response);
});

// ===== ENDPOINT: GET TIMER STATUS =====
app.get("/timerstatus", (req, res) => {
  const response = {
    timerRunning: isTimerRunning,
    timeRemaining: timeRemaining,
    lockState: lockState,
    config: config,
    timestamp: Date.now()
  };
  
  res.json(response);
});

// ===== ENDPOINT: FORCE TIMER SYNC =====
app.get("/synctimer", (req, res) => {
  const action = req.query.action || 'status';
  
  let response = {
    success: true,
    message: "Timer status",
    timestamp: Date.now(),
    timer: {
      isRunning: isTimerRunning,
      remaining: timeRemaining,
      lockId: lockState.lockId
    },
    lock: lockState
  };
  
  if (action === 'stop') {
    stopTimer();
    response.message = "Timer stopped manually";
  } else if (action === 'reset') {
    resetTimer();
    response.message = "Timer reset manually";
  } else if (action === 'recover') {
    // Recovery mode: force unlock jika timer habis tapi masih locked
    if (!isTimerRunning && timeRemaining <= 0 && lockState.locked) {
      forceUnlockSystem();
      response.message = "Timer recovery applied - force unlocked";
      response.recoveryApplied = true;
    }
  }
  
  console.log(`[SYNCTIMER] ${action} request:`, response);
  res.json(response);
});

// ===== ENDPOINT UPDATE DIPERBAIKI =====
app.get("/update", (req, res) => {
  const startTime = Date.now();
  const requestTime = Date.now();
  const clientIP = req.ip || req.connection.remoteAddress;
  
  if (!req.query.team) {
    logger.error("UPDATE: Missing team parameter");
    return res.status(400).json({ error: "Parameter team diperlukan" });
  }

  const team = parseInt(req.query.team);
  
  if (!Number.isInteger(team) || team < 1 || team > TEAM_COUNT) {
    logger.error(`UPDATE: Invalid team ${team}`);
    return res.status(400).json({ error: "Tim tidak valid" });
  }
  
  // Cek toggle state
  if (!teamToggleState[team - 1]) {
    logger.error(`UPDATE: Team ${team} disabled`);
    return res.status(403).json({ 
      error: "Tombol tim dinonaktifkan",
      message: `Tim ${getTeamLetter(team)} saat ini dinonaktifkan oleh admin`
    });
  }
  
  const add = parseInt(req.query.add) || 0;
  const isFirst = req.query.first === "1";

  logger.esp32(`UPDATE from IP: ${clientIP}, Team: ${team}, First: ${isFirst}`);
  
  if (clientIP.includes('192.168.1.') || clientIP.includes('172.') || clientIP.includes('10.')) {
    const activityType = `buzzer_${isFirst ? 'tekan_pertama' : 'scoring'}`;
    updateESP32FromHTTP(clientIP, activityType);
  }

  if (isFirst) {
    const lockResult = acquireAtomicLock(team);
    
    if (!lockResult.success) {
      const lockAge = Date.now() - (lockState.lockTime || Date.now());
      const currentTeam = lockState.activeTeam;
      
      logger.lock(`Request DITOLAK: Tim ${getTeamLetter(team)} - ${lockResult.reason}`, {
        lockedBy: currentTeam,
        lockAge: `${lockAge}ms`,
        lockId: lockState.lockId
      });
      
      return res.status(403).json({ 
        error: "Tombol terkunci",
        reason: lockResult.reason,
        lockedBy: currentTeam,
        lockId: lockState.lockId,
        lockAge: `${lockAge}ms`,
        message: `Tim ${getTeamLetter(currentTeam)} lebih cepat ${lockAge}ms`,
        responseTime: `${Date.now() - startTime}ms`
      });
    }
    
    logger.lock(`Request DITERIMA: Tim ${getTeamLetter(team)} berhasil terkunci`, {
      lockId: lockResult.lockId,
      sequence: lockResult.sequence
    });
    
    setImmediate(() => {
      io.emit("lockstate", lockState);
      io.emit("buzz", { 
        team,
        lockId: lockResult.lockId,
        timestamp: Date.now()
      });
      
      playBuzzerThenTeamAudio(team);
    });
  }

  if (add !== 0) {
    logger.info(`Scoring: Team ${team} add ${add} points`, {
      lockId: lockState.lockId,
      sequence: lockState.lockSequence
    });
    
    scores[team - 1] += add;
    
    setImmediate(() => {
      io.emit("update", { team, score: scores[team - 1] });
      io.emit("scoring", { team, isCorrect: add > 0 });
      
      // PERBAIKAN: Tambah callback untuk acknowledgment audio juri
      timerAudio.playJuryAudio(add > 0, () => {
        logger.audio(`Audio juri selesai untuk Tim ${getTeamLetter(team)}`);
      });
      
      const feedbackMessage = generateFeedbackMessage(team, add > 0, add);
      io.emit("aiMessage", {
        message: feedbackMessage,
        type: add > 0 ? "success" : "penalty",
        shouldSpeak: false
      });
      
      releaseAtomicLock();
      resetTimer();
      
      io.emit("lockstate", lockState);
    });
  }

  const responseTime = Date.now() - startTime;
  
  logger.performance(`UPDATE Response time: ${responseTime}ms`, { 
    tim: team, 
    pertama: isFirst,
    add: add,
    locked: isFirst ? true : lockState.locked,
    lockId: lockState.lockId,
    responseTime: responseTime
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
    lockId: lockState.lockId,
    lockSequence: lockState.lockSequence,
    timestamp: Date.now()
  });
});

// ===== ENDPOINT PING =====
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
  
  io.emit("timerReset", { lockId: 'debug_fix' });
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

// ===== ENDPOINT: FORCE UNLOCK ALL =====
app.get("/forceUnlockAll", (req, res) => {
  logger.info("Force unlock all requested");
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  isTimerRunning = false;
  timeRemaining = 0;
  
  const previousLockId = lockState.lockId;
  releaseAtomicLock();
  
  lockState = { 
    locked: false, 
    activeTeam: null,
    lockTime: null,
    lockId: null,
    lockSequence: lockState.lockSequence
  };
  
  io.emit("lockstate", lockState);
  io.emit("timerReset", { lockId: previousLockId || 'force_unlock' });
  io.emit("systemUnlocked", { 
    reason: "force_unlock_all",
    previousLockId: previousLockId
  });
  
  // Kirim notifikasi ke semua ESP32 yang terhubung via WebSocket
  io.to('esp32').emit('forceUnlockNotification', {
    timestamp: Date.now(),
    reason: 'admin_forced'
  });
  
  res.json({
    sukses: true,
    pesan: "Semua kunci dibuka paksa",
    lockState: lockState,
    timerRunning: isTimerRunning,
    previousLockId: previousLockId
  });
});

// ===== ENDPOINT: ESP32STATUS =====
app.get("/esp32status", (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const modules = parseInt(req.query.modules);
  const activeTeams = parseInt(req.query.activeTeams);
  const rssi = parseInt(req.query.rssi);
  
  // Update ESP32 status dengan data baru
  if (clientIP.includes('192.168.1.') || clientIP.includes('172.') || clientIP.includes('10.')) {
    const data = {
      modules: modules,
      teams: activeTeams,
      rssi: rssi
    };
    
    updateESP32FromHTTP(clientIP, "monitoring_update", data);
    
    logger.esp32(`Monitoring update from ${clientIP}`, {
      modules: modules,
      teams: activeTeams,
      rssi: rssi
    });
  }
  
  res.json({
    success: true,
    received: {
      modules: modules,
      teams: activeTeams,
      rssi: rssi
    },
    message: "Data monitoring diterima",
    serverTime: new Date().toLocaleTimeString('id-ID'),
    esp32Status: {
      connected: esp32Status.connected,
      lastActivity: esp32Status.lastActivity
    }
  });
});

// ===== ENDPOINT: DEBUG MONITORING =====
app.get("/debug/monitoring", (req, res) => {
  res.json({
    esp32Status: esp32Status,
    rssiHistory: esp32Status.rssiHistory,
    lastUpdate: new Date().toLocaleTimeString('id-ID'),
    fields: {
      modulesDetected: esp32Status.modulesDetected,
      activeTeams: esp32Status.activeTeams,
      wifiRSSI: esp32Status.wifiRSSI,
      lastRSSIUpdate: esp32Status.lastRSSIUpdate
    }
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
    versi: "2.1.0",  // Updated version
    lingkungan: isProduction ? "produksi" : "pengembangan",
    siap: true,
    features: {
      atomicLock: true,
      stateRecovery: true,
      audioAcknowledgment: true,
      esp32WebSocket: true
    }
  });
});

// ===== ROUTE UNTUK TOGGLE TIM =====
app.get("/toggleTeam", (req, res) => {
  const team = parseInt(req.query.team);
  const enabled = req.query.enabled === 'true';
  
  if (!Number.isInteger(team) || team < 1 || team > TEAM_COUNT) {
    return res.status(400).json({ error: "Tim tidak valid" });
  }
  
  // Update state
  teamToggleState[team - 1] = enabled;
  
  logger.info(`Team ${getTeamLetter(team)} ${enabled ? 'enabled' : 'disabled'}`, {
    team: team,
    enabled: enabled,
    currentState: teamToggleState,
    lockState: lockState
  });
  
  io.emit("teamToggleUpdate", {
    team: team,
    enabled: enabled,
    timestamp: Date.now()
  });
  
  // Kirim notifikasi ke ESP32 jika terkoneksi via WebSocket
  io.to('esp32').emit('teamToggleNotification', {
    team: team,
    enabled: enabled,
    timestamp: Date.now()
  });
  
  res.json({ 
    sukses: true, 
    tim: team, 
    diaktifkan: enabled,
    pesan: `Tim ${getTeamLetter(team)} ${enabled ? 'diaktifkan' : 'dinonaktifkan'}`,
    timestamp: Date.now()
  });
});

app.get("/enableAllTeams", (req, res) => {
  teamToggleState = Array(TEAM_COUNT).fill(true);
  
  logger.info("All teams enabled", { lockState: lockState });
  
  io.emit("allTeamsEnabled");
  io.to('esp32').emit('allTeamsEnabledNotification', { timestamp: Date.now() });
  
  res.json({ 
    sukses: true, 
    pesan: "Semua tim diaktifkan",
    statusToggleTim: teamToggleState,
    timestamp: Date.now()
  });
});

app.get("/disableAllTeams", (req, res) => {
  teamToggleState = Array(TEAM_COUNT).fill(false);
  
  logger.info("All teams disabled", { lockState: lockState });
  
  io.emit("allTeamsDisabled");
  io.to('esp32').emit('allTeamsDisabledNotification', { timestamp: Date.now() });
  
  res.json({ 
    sukses: true, 
    pesan: "Semua tim dinonaktifkan",
    statusToggleTim: teamToggleState,
    timestamp: Date.now()
  });
});

app.get("/teamToggleState", (req, res) => {
  res.json({
    toggleState: teamToggleState,
    timestamp: Date.now(),
    checksum: `toggle_${Date.now()}_${teamToggleState.filter(t => t).length}`
  });
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
    // Parse data monitoring
    const modules = parseInt(req.query.modules);
    const teams = parseInt(req.query.teams);
    const rssi = parseInt(req.query.rssi);
    const count = parseInt(req.query.count);
    
    const data = {
      modules: modules,
      teams: teams,
      rssi: rssi,
      count: count
    };
    
    updateESP32FromHTTP(realIP, `heartbeat_${action}`, data);
    
    logger.esp32(`ESP32 heartbeat received from ${realIP}`, {
      action: action,
      team: team,
      modules: modules,
      teams: teams,
      rssi: rssi,
      heartbeatCount: esp32Status.heartbeatCount
    });
    
    io.emit("esp32Status", esp32Status);
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
    heartbeatCount: esp32Status.heartbeatCount,
    lockState: lockState,
    timerRunning: isTimerRunning
  });
});

// ===== ENDPOINT: ESP32 ACTIVITY =====
app.get("/esp32activity", (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const activityType = req.query.type || 'activity';
  const team = req.query.team;
  
  updateESP32FromHTTP(ip, `http_${activityType}_team${team}`);
  
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
      `${Math.floor((now - esp32Status.lastActivity) / 1000)} detik` : "N/A",
    modulTerdeteksi: esp32Status.modulesDetected || 0,
    timAktif: esp32Status.activeTeams || 0,
    sinyalWiFi: esp32Status.wifiRSSI || 0,
    rssiHistory: esp32Status.rssiHistory
  });
});

// ===== ROUTE UNTUK KONTROL PENALTI OTOMATIS =====
app.get("/toggleAutoPenalty", (req, res) => {
  const enabled = req.query.enabled === 'true';
  isAutoPenaltyEnabled = enabled;
  
  io.emit("autoPenaltyToggle", { enabled: isAutoPenaltyEnabled });
  io.to('esp32').emit('autoPenaltyNotification', { 
    enabled: isAutoPenaltyEnabled,
    timestamp: Date.now()
  });
  
  res.json({ 
    sukses: true, 
    diaktifkan: isAutoPenaltyEnabled,
    pesan: `Penalti otomatis ${enabled ? 'diaktifkan' : 'dinonaktifkan'}`,
    timestamp: Date.now()
  });
});

app.get("/autoPenaltyStatus", (req, res) => {
  res.json({ 
    diaktifkan: isAutoPenaltyEnabled,
    poinPenalti: config.minus,
    deskripsi: "Penalti otomatis diterapkan saat timer habis tanpa respon juri",
    timestamp: Date.now()
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
    timerDimulai: isTimerRunning,
    timestamp: Date.now()
  });
});

// ===== ENDPOINT: PRE TEAM AUDIO FINISHED (BUZZER SELESAI) =====
app.get("/preTeamAudioFinished", (req, res) => {
  const team = parseInt(req.query.team);
  
  if (team) {
    const teamAudioFile = getTeamAudioFile(team);
    
    // Reset timer jika sedang berjalan, tanpa melepaskan kunci
    if (isTimerRunning) {
      resetTimerOnly();
    }
    startTimer(team);
    
    io.emit("playTeamAudio", {
      team: team,
      audioFile: teamAudioFile,
      timerDuration: config.timerDuration,
      audioId: `team_${Date.now()}_${team}`
    });
  }
  
  res.json({ 
    sukses: true, 
    pesan: "Audio buzzer selesai, audio tim dan timer dimulai",
    tim: team,
    timestamp: Date.now()
  });
});

app.get("/triggerAudio", (req, res) => {
  const team = parseInt(req.query.team);
  
  if (!Number.isInteger(team) || team < 1 || team > TEAM_COUNT) {
    return res.status(400).json({ error: "Tim tidak valid" });
  }
  
  playBuzzerThenTeamAudio(team);
  
  res.json({ 
    sukses: true, 
    tim: team, 
    aksi: "urutan_buzzer_dipicu",
    timestamp: Date.now()
  });
});

app.get("/unlock", (req, res) => {
  const previousLockId = lockState.lockId;
  resetTimer();
  releaseAtomicLock();
  io.emit("lockstate", lockState);
  
  // Kirim notifikasi unlock ke ESP32
  io.to('esp32').emit('manualUnlockNotification', {
    previousLockId: previousLockId,
    timestamp: Date.now()
  });
  
  res.json({ 
    sukses: true, 
    pesan: "Sistem dibuka dan timer direset", 
    statusKunci: lockState,
    previousLockId: previousLockId
  });
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
  
  // Kirim notifikasi konfigurasi ke ESP32
  io.to('esp32').emit('configUpdate', {
    config: config,
    timestamp: Date.now()
  });
  
  res.json({ 
    sukses: true, 
    konfigurasi: config,
    timestamp: Date.now()
  });
});

app.get("/reset", (req, res) => {
  scores = Array(TEAM_COUNT).fill(0);
  resetTimer();
  releaseAtomicLock();
  io.emit("reset", scores);
  io.emit("lockstate", lockState);
  
  // Kirim notifikasi reset ke ESP32
  io.to('esp32').emit('scoreResetNotification', {
    timestamp: Date.now()
  });
  
  res.json({ 
    sukses: true, 
    pesan: "Skor direset dan timer direset", 
    skor: scores,
    timestamp: Date.now()
  });
});

app.get("/scores", (req, res) => {
  res.json({
    scores: scores,
    timestamp: Date.now(),
    checksum: `scores_${Date.now()}_${scores.reduce((a, b) => a + b, 0)}`
  });
});

app.get("/lockstate", (req, res) => {
  res.json({
    ...lockState,
    timestamp: Date.now(),
    checksum: `lock_${Date.now()}_${lockState.lockSequence}`
  });
});

app.get("/config", (req, res) => {
  res.json({
    ...config,
    timestamp: Date.now(),
    autoPenaltyEnabled: isAutoPenaltyEnabled
  });
});

// ===== ENDPOINT: TEST KONEKSI ESP32 =====
app.get("/testESP32Connection", (req, res) => {
  const now = new Date();
  const timeSinceLastActivity = esp32Status.lastActivity ? 
    Math.floor((now - esp32Status.lastActivity) / 1000) : Infinity;
  
  const isRecentlyActive = timeSinceLastActivity < 300;
  
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
      sejakAktivitasTerakhir: `${timeSinceLastActivity} detik`,
      modulTerdeteksi: esp32Status.modulesDetected,
      timAktif: esp32Status.activeTeams,
      sinyalWiFi: esp32Status.wifiRSSI,
      rssiStability: esp32Status.rssiHistory.length > 0 ? 
        `Rata-rata: ${Math.round(esp32Status.rssiHistory.reduce((a, b) => a + b.rssi, 0) / esp32Status.rssiHistory.length)} dBm` : "Tidak ada data"
    },
    waktuRespon: new Date().toLocaleTimeString('id-ID'),
    saran: !isRecentlyActive ? "Cek koneksi WiFi ESP32 atau restart ESP32" : null,
    lockState: lockState,
    timerRunning: isTimerRunning
  });
});

// ===== DEBUG ENDPOINT =====
app.get("/debug/connections", (req, res) => {
  const sockets = Array.from(io.sockets.sockets.values());
  
  res.json({
    totalConnections: io.engine.clientsCount,
    sockets: sockets.map(s => ({
      id: s.id,
      clientType: s.handshake.query.clientType || 'unknown',
      ip: s.handshake.address,
      rooms: Array.from(s.rooms),
      connectedAt: s.handshake.time
    })),
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
  const previousLockId = lockState.lockId;
  releaseAtomicLock();
  resetTimer();
  io.emit("lockstate", lockState);
  io.emit("timerReset", { lockId: previousLockId || 'debug_reset' });
  
  res.json({ 
    success: true, 
    message: "Lock manually reset",
    lockState: lockState,
    previousLockId: previousLockId
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
      lastTimerEvent: lastTimerEvent,
      lockId: lockState.lockId
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
    lingkungan: isProduction ? "produksi" : "pengembangan",
    versi: "2.1.0",
    checksum: `health_${Date.now()}_${lockState.lockSequence}`
  });
});

// ===== HANDLER 404 DAN ERROR =====
app.use((req, res) => {
  res.status(404).json({ 
    error: "Route tidak ditemukan",
    timestamp: Date.now(),
    availableEndpoints: [
      "/", "/health", "/fullstate", "/config", "/scores", "/lockstate",
      "/update", "/checktimer", "/timerstatus", "/synctimer",
      "/toggleTeam", "/teamToggleState", "/esp32checkin", "/esp32status",
      "/debug/esp32", "/debug/monitoring", "/debug/connections"
    ]
  });
});

app.use((err, req, res, next) => {
  logger.error('Error server:', err);
  res.status(500).json({ 
    error: "Internal server error",
    pesan: isProduction ? "Terjadi kesalahan" : err.message,
    timestamp: Date.now(),
    requestId: `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  });
});

// ===== SOCKET.IO HANDLERS DIPERBAIKI =====
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
  
  const isAdmin = clientType === 'admin' || 
                  userAgent.toLowerCase().includes('mozilla') ||
                  userAgent.toLowerCase().includes('chrome');

  logger.info(`New connection: ${socket.id}`, {
    ip: clientIP,
    userAgent: userAgent,
    clientType: clientType,
    isESP32: isESP32,
    isAdmin: isAdmin
  });

  // Join room berdasarkan tipe client
  if (isESP32) {
    socket.join('esp32');
    logger.esp32(`ESP32 joined room: ${socket.id}`);
    
    // PERBAIKAN: Update ESP32 status untuk WebSocket connection
    esp32Status.connected = true;
    esp32Status.lastActivity = new Date();
    esp32Status.socketId = socket.id;
    esp32Status.ip = clientIP;
    esp32Status.connectionType = "websocket_connection";
    
    io.emit("esp32Status", esp32Status);
    
    // Kirim state lengkap ke ESP32 untuk recovery
    socket.emit("fullStateSync", {
      scores: scores,
      lockState: lockState,
      timer: {
        isRunning: isTimerRunning,
        remaining: timeRemaining
      },
      config: config,
      teamToggleState: teamToggleState,
      autoPenalty: isAutoPenaltyEnabled,
      timestamp: Date.now(),
      checksum: `sync_${Date.now()}_${lockState.lockSequence}`
    });
    
    // Handler untuk ping dari ESP32 via WebSocket
    socket.on("pingFromESP32", (data, callback) => {
      esp32Status.lastActivity = new Date();
      
      if (data && data.rssi) {
        esp32Status.wifiRSSI = data.rssi;
        esp32Status.lastRSSIUpdate = new Date();
      }
      
      io.emit("esp32Status", esp32Status);
      
      if (callback) {
        callback({
          sukses: true,
          pesan: "PONG",
          timestamp: Date.now(),
          lockState: lockState,
          timerRunning: isTimerRunning,
          timeRemaining: timeRemaining
        });
      }
    });
    
    // Handler untuk audio acknowledgment dari ESP32
    socket.on("audioAcknowledgment", (data) => {
      logger.audio(`Audio acknowledgment from ESP32: ${data.audioId} - ${data.success ? 'success' : 'failed'}`);
      
      if (!data.success) {
        logger.error(`Audio failed on ESP32: ${data.audioId}`, data);
        
        // Jika audio team gagal, fallback ke server timer start
        if (data.audioType === 'team' && data.team) {
          logger.audio(`Fallback: Starting timer for team ${data.team} due to audio failure`);
          startTimer(data.team);
        }
      }
    });
    
    // Handler untuk state recovery request dari ESP32
    socket.on("requestStateRecovery", (data, callback) => {
      logger.esp32(`State recovery requested by ESP32`, data);
      
      if (callback) {
        callback({
          success: true,
          state: {
            scores: scores,
            lockState: lockState,
            timer: {
              isRunning: isTimerRunning,
              remaining: timeRemaining
            },
            config: config,
            teamToggleState: teamToggleState,
            checksum: `recovery_${Date.now()}_${lockState.lockSequence}`
          }
        });
      }
    });
    
    // Handler untuk force unlock acknowledgment dari ESP32
    socket.on("forceUnlockAcknowledgment", (data) => {
      logger.esp32(`ESP32 acknowledged force unlock`, data);
      
      // Reset state lokal jika perlu
      if (data.success && lockState.locked) {
        logger.esp32(`Resetting local lock state after ESP32 acknowledgment`);
        releaseAtomicLock();
        io.emit("lockstate", lockState);
      }
    });
    
  } else if (isAdmin) {
    socket.join('admin');
    logger.info(`Admin joined room: ${socket.id}`);
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
    socket.emit("timerStart", { 
      duration: timeRemaining,
      lockId: lockState.lockId 
    });
  }

  // Handler untuk audio acknowledgment dari display
  socket.on("audioAck", (data) => {
    logger.audio(`Audio acknowledgment from display`, {
      audioId: data.audioId,
      success: data.success,
      team: data.team,
      audioType: data.audioType
    });
    
    // Jika audio tim berhasil diputar, pastikan timer sudah mulai
    if (data.audioType === 'team' && data.success && data.team && !isTimerRunning) {
      logger.audio(`Starting timer for team ${data.team} after audio acknowledgment`);
      startTimer(data.team);
    }
  });

  socket.on("getESP32Status", () => {
    socket.emit("esp32Status", esp32Status);
  });

  // Event untuk kontrol timer
  socket.on("requestTimerReset", () => {
    const previousLockId = lockState.lockId;
    resetTimer();
    socket.emit("timerResetConfirm", { 
      sukses: true,
      previousLockId: previousLockId
    });
  });
  
  socket.on("getTimerStatus", () => {
    socket.emit("timerStatusResponse", {
      berjalan: isTimerRunning,
      waktuTersisa: timeRemaining,
      statusKunci: lockState,
      lastTimerEvent: lastTimerEvent,
      checksum: `timerstatus_${Date.now()}_${lockState.lockSequence}`
    });
  });

  // Event untuk menandai buzzer selesai
  socket.on("preTeamAudioFinished", (data) => {
    const team = data.team;
    
    if (team) {
      const teamAudioFile = getTeamAudioFile(team);
      
      // Reset timer jika sedang berjalan, tanpa melepaskan kunci
      if (isTimerRunning) {
        resetTimerOnly();
      }
      startTimer(team);
      
      io.emit("playTeamAudio", {
        team: team,
        audioFile: teamAudioFile,
        timerDuration: config.timerDuration,
        audioId: `team_${Date.now()}_${team}`
      });
    }
  });

  // Handler untuk force unlock dari admin via WebSocket
  socket.on("forceUnlockRequest", (data, callback) => {
    logger.info(`Force unlock requested via WebSocket from ${socket.id}`);
    
    forceUnlockSystem();
    
    if (callback) {
      callback({
        success: true,
        message: "System force unlocked",
        timestamp: Date.now(),
        previousLockId: lockState.lockId
      });
    }
  });

  socket.on("disconnect", (reason) => {
    const wasESP32 = clientType === 'esp32' || 
                     clientIP.includes('192.168.1.') || 
                     clientIP.includes('172.') || 
                     clientIP.includes('10.');
                     
    if (wasESP32) {
      // Jangan langsung mark as disconnected, tunggu timeout
      logger.esp32(`ESP32 WebSocket disconnected: ${socket.id}`, { reason: reason });
      
      // Hanya update connection type, biarkan checkESP32Status handle timeout
      esp32Status.connectionType = "websocket_disconnected";
      
      // Kirim notifikasi ke admin
      io.to('admin').emit('esp32Warning', {
        type: 'websocket_disconnected',
        message: `ESP32 WebSocket terputus: ${reason}`,
        socketId: socket.id,
        timestamp: new Date()
      });
    }
    
    logger.info(`Disconnect: ${socket.id}`, { 
      reason: reason, 
      wasESP32: wasESP32,
      clientType: clientType 
    });
  });
});

// ===== MONITORING ESP32 DIPERBAIKI =====
setInterval(checkESP32Status, 30000); // Setiap 30 detik

// ===== STATE RECOVERY CLEANUP =====
setInterval(() => {
  // Bersihkan rssiHistory yang terlalu lama (lebih dari 1 jam)
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  esp32Status.rssiHistory = esp32Status.rssiHistory.filter(
    entry => new Date(entry.timestamp).getTime() > oneHourAgo
  );
}, 3600000); // Setiap 1 jam

// ===== MEMULAI SERVER =====
async function startServer() {
  validateAudioFiles();
  
  http.listen(PORT, async () => {
    console.log('========================================');
    console.log('SISTEM KUIS Ridwan and Team - VERSI 2.1.0');
    console.log('========================================');
    console.log(`Lingkungan: ${isProduction ? 'PRODUKSI' : 'PENGEMBANGAN'}`);
    console.log(`Tampilan: http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin.html`);
    console.log(`Debug Monitoring: http://localhost:${PORT}/debug/monitoring`);
    console.log(`Full State Recovery: http://localhost:${PORT}/fullstate`);
    console.log('========================================');
  });
}

startServer();