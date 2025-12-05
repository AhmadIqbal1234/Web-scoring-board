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

// ===== PEMBATASAN REQUEST =====
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

// ===== KONFIGURASI SOCKET.IO =====
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
let lockState = { 
  locked: false, 
  activeTeam: null,
  lockTime: null
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
  activeTeams: 12,
  modulesDetected: 4
};

// ===== LOGGER =====
const logger = {
  info: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  error: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.error(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  esp32: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] ESP32: ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  lock: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] LOCK: ${message}`, data ? JSON.stringify(data, null, 2) : '');
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
    }
  }

  playJuryAudio(isCorrect) {
    const audioFile = isCorrect ? this.juryAudio.correct : this.juryAudio.wrong;
    if (audioFile) {
      io.emit("playJuryAudio", {
        isCorrect: isCorrect,
        audioFile: audioFile
      });
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

// ===== ATOMIC LOCK =====
function acquireAtomicLock(team) {
  const now = Date.now();
  
  if (lockState.locked) {
    const lockAge = now - (lockState.lockTime || now);
    logger.lock(`Lock DENIED untuk Tim ${getTeamLetter(team)} - ` +
               `sudah terkunci oleh Tim ${getTeamLetter(lockState.activeTeam)} ` +
               `(${lockAge}ms yang lalu)`);
    return false;
  }
  
  lockState = { 
    locked: true, 
    activeTeam: team,
    lockTime: now
  };
  
  logger.lock(`Lock ACQUIRED untuk Tim ${getTeamLetter(team)}`);
  return true;
}

function releaseAtomicLock() {
  lockState = { 
    locked: false, 
    activeTeam: null,
    lockTime: null
  };
  logger.lock('Lock RELEASED');
}

// ===== PENALTI OTOMATIS =====
function handleAutoPenalty() {
  if (!lockState.locked || !lockState.activeTeam) {
    unlockSystemOnTimerEnd();
    return;
  }

  if (!isAutoPenaltyEnabled) {
    unlockSystemOnTimerEnd();
    return;
  }

  const activeTeam = lockState.activeTeam;
  
  if (!teamToggleState[activeTeam - 1]) {
    unlockSystemOnTimerEnd();
    return;
  }

  const penaltyPoints = config.minus;
  scores[activeTeam - 1] += penaltyPoints;
  
  setImmediate(() => {
    io.emit("update", { team: activeTeam, score: scores[activeTeam - 1] });
    io.emit("scoring", { team: activeTeam, isCorrect: false });
  });
  
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
    io.emit("systemUnlocked", { reason: "auto_penalty_applied" });
    
    const feedbackMessage = `Waktu habis! Tim ${getTeamLetter(activeTeam)} tidak menjawab, dikurangi ${Math.abs(penaltyPoints)} poin!`;
    
    io.emit("aiMessage", {
      message: feedbackMessage,
      type: "warning",
      shouldSpeak: false
    });
  });
  
  logger.info(`AUTO PENALTI: Tim ${getTeamLetter(activeTeam)} -${Math.abs(penaltyPoints)} poin`);
}

function unlockSystemOnTimerEnd() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  isTimerRunning = false;
  timeRemaining = 0;
  
  if (lockState.locked) {
    releaseAtomicLock();
    
    setImmediate(() => {
      io.emit("lockstate", lockState);
      io.emit("timerReset");
      io.emit("systemUnlocked", { 
        reason: "timer_expired",
        previousActiveTeam: lockState.activeTeam 
      });
    });
  }
}

// ===== ESP32 STATUS =====
function updateESP32Status(connected, socket = null, ip = null, activityType = "unknown") {
  const previousStatus = esp32Status.connected;
  
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
  } else {
    if (activityType === "esp32_shutdown" || activityType === "socket_disconnect") {
      esp32Status.connected = false;
      esp32Status.connectionType = "terputus";
    }
  }
  
  const shouldBroadcast = 
    previousStatus !== esp32Status.connected || 
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
  
  if (!esp32Status.connected || timeSinceLastActivity > 60000) {
    updateESP32Status(true, null, ip, activityType);
  } else {
    esp32Status.lastActivity = new Date();
    esp32Status.lastCheckin = new Date();
    esp32Status.connectionType = activityType;
  }
  
  io.emit("esp32Status", esp32Status);
}

// ===== CHECK ESP32 STATUS =====
function checkESP32Status() {
  const now = Date.now();
  if (esp32Status.lastActivity) {
    const timeSinceLastActivity = now - esp32Status.lastActivity.getTime();
    
    if (timeSinceLastActivity > 90000 && esp32Status.connected) {
      esp32Status.connected = false;
      esp32Status.connectionType = "timeout";
      io.emit("esp32Status", esp32Status);
    }
  }
}

// ===== TIMER FUNCTIONS =====
function startTimer(activeTeam = null) {
  if (isTimerRunning) return;
  
  isTimerRunning = true;
  timeRemaining = config.timerDuration;
  const currentActiveTeam = activeTeam || lockState.activeTeam;

  io.emit("timerStart", { duration: config.timerDuration });
  lastTimerEvent = 'timerStart';

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
  
  io.emit("timerReset");
  lastTimerEvent = 'timerReset';
  lockState.lockTime = null;
}

// ===== BUZZER AUDIO =====
function playBuzzerThenTeamAudio(team) {
  const teamAudioFile = getTeamAudioFile(team);
  
  const buzzerPlayed = timerAudio.playPreTeamAudio(team);
  
  if (!isTimerRunning) {
    startTimer(team);
  }
  
  io.emit("playTeamAudio", {
    team: team,
    audioFile: teamAudioFile,
    timerDuration: config.timerDuration
  });
}

// ===== ENDPOINT UPDATE =====
app.get("/update", (req, res) => {
  const startTime = Date.now();
  
  if (!req.query.team) {
    return res.status(400).json({ error: "Parameter team diperlukan" });
  }

  const team = parseInt(req.query.team);
  
  if (!teamToggleState[team - 1]) {
    return res.status(403).json({ error: "Tombol tim dinonaktifkan" });
  }
  
  const add = parseInt(req.query.add) || 0;
  const isFirst = req.query.first === "1";

  if (!Number.isInteger(team) || team < 1 || team > TEAM_COUNT) {
    return res.status(400).json({ error: "Tim tidak valid" });
  }

  const ip = req.ip || req.connection.remoteAddress;
  if (ip.includes('192.168.1.') || ip.includes('172.') || ip.includes('10.')) {
    const activityType = `buzzer_${isFirst ? 'tekan_pertama' : 'scoring'}`;
    updateESP32FromHTTP(ip, activityType);
  }

  if (isFirst) {
    if (!acquireAtomicLock(team)) {
      const lockAge = Date.now() - (lockState.lockTime || Date.now());
      const currentTeam = lockState.activeTeam;
      
      return res.status(403).json({ 
        error: "Tombol terkunci",
        lockedBy: currentTeam,
        lockAge: `${lockAge}ms`,
        message: `Tim ${getTeamLetter(currentTeam)} sudah menekan tombol terlebih dahulu`
      });
    }
    
    setImmediate(() => {
      io.emit("lockstate", lockState);
      io.emit("buzz", { team });
      playBuzzerThenTeamAudio(team);
    });
  }

  if (add !== 0) {
    scores[team - 1] += add;
    
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
      
      releaseAtomicLock();
      resetTimer();
      
      io.emit("lockstate", lockState);
    });
  }

  const responseTime = Date.now() - startTime;
  
  res.json({ 
    sukses: true, 
    pesan: "OK", 
    tim: team, 
    tambah: add, 
    pertama: isFirst,
    responseTime: `${responseTime}ms`,
    locked: lockState.locked,
    lockedBy: lockState.activeTeam
  });
});

// ===== STATIC FILES =====
const possiblePublicDirs = [
  join(process.cwd(), "public"),
  join(__dirname, "public"),
  join(__dirname, "..", "public")
];

let publicDirFound = null;
for (const dir of possiblePublicDirs) {
  if (fs.existsSync(dir)) {
    publicDirFound = dir;
    break;
  }
}

if (!publicDirFound) {
  publicDirFound = join(process.cwd(), "public");
  fs.mkdirSync(publicDirFound, { recursive: true });
}

app.use(express.static(publicDirFound));

const audioDir = join(publicDirFound, "audio");
if (fs.existsSync(audioDir)) {
  app.use('/audio', express.static(audioDir));
} else {
  fs.mkdirSync(audioDir, { recursive: true });
  app.use('/audio', express.static(audioDir));
}

// ===== ROUTES =====
app.get("/", (req, res) => {
  res.json({ 
    status: "Sistem Scoring Kuis", 
    versi: "2.0.0",
    fleksibel: true,
    siap: true
  });
});

// ===== TOGGLE TEAM ROUTES =====
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
    pesan: "Semua tim diaktifkan"
  });
});

app.get("/disableAllTeams", (req, res) => {
  teamToggleState = Array(TEAM_COUNT).fill(false);
  io.emit("allTeamsDisabled");
  res.json({ 
    sukses: true, 
    pesan: "Semua tim dinonaktifkan"
  });
});

app.get("/teamToggleState", (req, res) => {
  res.json(teamToggleState);
});

// ===== ESP32 FLEXIBLE CONFIG =====
app.get("/esp32config", (req, res) => {
  const modules = parseInt(req.query.modules) || 4;
  const activeTeams = parseInt(req.query.activeTeams) || (modules * 3);
  
  esp32Status.modulesDetected = modules;
  esp32Status.activeTeams = Math.min(activeTeams, 12);
  
  const teamsToEnable = Math.min(modules * 3, 12);
  
  teamToggleState = Array(TEAM_COUNT).fill(false);
  for (let i = 0; i < teamsToEnable; i++) {
    teamToggleState[i] = true;
  }
  
  io.emit("teamToggleState", teamToggleState);
  io.emit("esp32Config", {
    modules: modules,
    activeTeams: teamsToEnable,
    teams: teamToggleState.map((enabled, idx) => ({
      team: idx + 1,
      letter: getTeamLetter(idx + 1),
      enabled: enabled
    }))
  });
  
  res.json({
    sukses: true,
    message: `Configuration updated for ${modules} modules`,
    activeTeams: teamsToEnable,
    config: {
      modules: modules,
      maxTeams: modules * 3,
      enabledTeams: teamToggleState.filter(t => t).length
    }
  });
});

// ===== ESP32 ROUTES =====
app.get("/esp32checkin", (req, res) => {
  const action = req.query.action || 'heartbeat';
  const modules = req.query.modules;
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
    
    if (modules) {
      esp32Status.modulesDetected = parseInt(modules);
      esp32Status.activeTeams = Math.min(parseInt(modules) * 3, 12);
    }
    
    io.emit("esp32Status", esp32Status);
    io.emit("esp32Activity", {
      timestamp: new Date(),
      activity: { type: action, modules: modules },
      ip: realIP,
      socketId: "HTTP_CHECKIN"
    });
  }
  
  res.json({ 
    sukses: true, 
    pesan: "Check-in diterima",
    dariESP32: !isAdmin,
    status: esp32Status.connected ? "CONTROLLER ONLINE" : "CONTROLLER OFFLINE",
    waktu: new Date().toLocaleTimeString('id-ID')
  });
});

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
    broadcasted: true
  });
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
      "Fleksibel 1-4 modul PCF8574",
      "Auto-deteksi modul",
      "Kontrol Juri (Benar/Salah)", 
      "LED Feedback",
      "Konfigurasi WiFi Manager"
    ],
    konfigurasi: {
      modules: esp32Status.modulesDetected,
      activeTeams: esp32Status.activeTeams,
      maxTeams: esp32Status.modulesDetected * 3
    },
    status: esp32Status.connected ? "CONTROLLER ONLINE" : "CONTROLLER OFFLINE",
    waktuSekarang: now.toLocaleTimeString('id-ID')
  };
  
  res.json(statusInfo);
});

// ===== AUTO PENALTY =====
app.get("/toggleAutoPenalty", (req, res) => {
  const enabled = req.query.enabled === 'true';
  isAutoPenaltyEnabled = enabled;
  io.emit("autoPenaltyToggle", { enabled: isAutoPenaltyEnabled });
  res.json({ 
    sukses: true, 
    diaktifkan: isAutoPenaltyEnabled
  });
});

app.get("/autoPenaltyStatus", (req, res) => {
  res.json({ 
    diaktifkan: isAutoPenaltyEnabled,
    poinPenalti: config.minus
  });
});

// ===== AUDIO ROUTES =====
app.get("/audioFinished", (req, res) => {
  if (audioFinishTimeout) {
    clearTimeout(audioFinishTimeout);
    audioFinishTimeout = null;
  }
  res.json({ sukses: true });
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
  res.json({ sukses: true });
});

// ===== SYSTEM CONTROL =====
app.get("/unlock", (req, res) => {
  resetTimer();
  releaseAtomicLock();
  io.emit("lockstate", lockState);
  res.json({ sukses: true, pesan: "Sistem dibuka" });
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
  res.json({ sukses: true, pesan: "Skor direset" });
});

// ===== DATA ROUTES =====
app.get("/scores", (req, res) => {
  res.json(scores);
});

app.get("/lockstate", (req, res) => {
  res.json(lockState);
});

app.get("/config", (req, res) => {
  res.json(config);
});

// ===== DEBUG ROUTES =====
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
    teamToggle: teamToggleState,
    timestamp: new Date().toISOString()
  });
});

app.get("/debug/resetlock", (req, res) => {
  logger.info("[DEBUG] Manual lock reset");
  releaseAtomicLock();
  resetTimer();
  io.emit("lockstate", lockState);
  io.emit("timerReset");
  res.json({ success: true, message: "Lock manually reset" });
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
      tersisa: timeRemaining
    },
    esp32: esp32Status,
    penaltiOtomatis: {
      diaktifkan: isAutoPenaltyEnabled,
      poinPenalti: config.minus
    },
    toggleTim: {
      status: teamToggleState,
      jumlahAktif: teamToggleState.filter(state => state).length
    },
    koneksi: io.engine.clientsCount,
    fleksibel: true
  });
});

// ===== 404 & ERROR HANDLERS =====
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

// ===== SOCKET.IO HANDLERS =====
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

  logger.info(`New connection: ${socket.id}`, { ip: clientIP, isESP32: isESP32 });

  if (isESP32) {
    updateESP32Status(true, socket, clientIP, "koneksi_socket");
    io.emit("esp32Status", esp32Status);
    
    socket.on("pingFromAdmin", (data, callback) => {
      if (callback) {
        callback({
          sukses: true,
          pesan: "ESP32 ONLINE DAN MERESPON",
          timestamp: Date.now(),
          idESP32: "MASTER_CONTROLLER",
          firmware: "ESP32_QUIZ_BUZZER_FLEX"
        });
      }
      updateESP32Status(true, socket, clientIP, "respon_test_ping");
      io.emit("esp32Status", esp32Status);
    });
  }

  // Send initial data to client
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

  // ESP32 Status request
  socket.on("getESP32Status", () => {
    socket.emit("esp32Status", esp32Status);
  });

  // Timer control
  socket.on("requestTimerReset", () => {
    resetTimer();
    socket.emit("timerResetConfirm", { sukses: true });
  });
  
  socket.on("getTimerStatus", () => {
    socket.emit("timerStatusResponse", {
      berjalan: isTimerRunning,
      waktuTersisa: timeRemaining,
      statusKunci: lockState
    });
  });

  // Audio events
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
  });
});

// ===== ESP32 MONITORING =====
setInterval(checkESP32Status, 30000);

// ===== START SERVER =====
async function startServer() {
  http.listen(PORT, async () => {
    console.log('========================================');
    console.log('SISTEM KUIS - FLEKSIBEL VERSION');
    console.log('========================================');
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin.html`);
    console.log(`Display: http://localhost:${PORT}`);
    console.log('========================================');
    console.log(`Fitur: Mendukung 1-4 modul PCF8574`);
    console.log(`Auto-deteksi modul aktif`);
    console.log(`Fleksibel jumlah tim`);
    console.log('========================================');
  });
}

startServer();