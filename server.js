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

// ===== ENVIRONMENT CONFIG =====
const PORT = process.env.PORT || 8080;
const TEAM_COUNT = 12;
const isProduction = process.env.NODE_ENV === 'production';

// ===== SECURITY MIDDLEWARE =====
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

// ===== RATE LIMITING =====
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
      return 10000;
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

// CORS setup
const io = new Server(http, {
  cors: {
    origin: isProduction 
      ? [process.env.FRONTEND_URL, "https://*.railway.app", "https://*.up.railway.app"] 
      : ["http://localhost:8080", "http://192.168.1.5:8080", "http://192.168.1.100:8080"],
    methods: ["GET", "POST"]
  }
});

let scores = Array(TEAM_COUNT).fill(0);
let config = { plus: 5, minus: -2, timerDuration: 30 };
let lockState = { locked: false, activeTeam: null };

// Team Toggle State
let teamToggleState = Array(TEAM_COUNT).fill(true);

let timerInterval = null;
let timeRemaining = 0;
let isTimerRunning = false;
let audioPlaying = false;
let audioFinishTimeout = null;

// ESP32 Status Tracking
let esp32Status = {
  connected: false,
  lastActivity: null,
  socketId: null,
  ip: null,
  lastCheckin: null,
  connectionType: null,
  lastBroadcast: null
};

const logger = {
  info: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  error: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  audio: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] AUDIO: ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  esp32: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] ESP32: ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }
};

// Audio System untuk Timer Countdown dan Juri
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
      logger.audio(`Memutar audio juri: ${audioFile} (${isCorrect ? 'BENAR' : 'SALAH'})`);
    }
  }

  playPreTeamAudio(team) {
    if (this.preTeamAudio) {
      io.emit("playPreTeamAudio", {
        team: team,
        audioFile: this.preTeamAudio
      });
      logger.audio(`Memutar pre-team audio: ${this.preTeamAudio} untuk tim ${team}`);
      return true;
    }
    return false;
  }
}

const timerAudio = new TimerAudioSystem();

// Helper function untuk nama tim
function getTeamLetter(teamNumber) {
  return String.fromCharCode(64 + teamNumber);
}

// Get audio file name untuk tim
function getTeamAudioFile(teamNumber) {
  const teamLetter = getTeamLetter(teamNumber);
  return `Tim ${teamLetter}.mp3`;
}

// Generate feedback messages untuk juri
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

// Validasi file audio
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
      logger.info(`Audio directory found: ${dir}`);
      break;
    }
  }
  
  if (!audioDirFound) {
    logger.error('No audio directory found! Creating public/audio...');
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
  
  logger.info("Validating audio files...");
  
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
        logger.error(`Audio file is empty: ${file}`);
      }
    } else {
      missingFiles.push(file);
      logger.error(`Audio file missing: ${file}`);
    }
  });
  
  logger.info(`Audio validation result: ${foundFiles.length}/${requiredFiles.length} files found`);
  if (missingFiles.length > 0) {
    logger.error(`Missing files: ${missingFiles.join(', ')}`);
  }
  
  return audioDirFound;
}

// ===== ESP32 STATUS SYSTEM - OPTIMIZED =====
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
    
    logger.esp32(`ESP32 Activity - ${activityType}`, {
      ip: ip,
      socketId: socket ? socket.id : 'HTTP',
      timestamp: esp32Status.lastActivity.toISOString()
    });
    
  } else {
    if (activityType === "esp32_shutdown" || activityType === "socket_disconnect") {
      esp32Status.connected = false;
      esp32Status.connectionType = "disconnected";
      logger.esp32("ESP32 Explicit Disconnect", { reason: activityType });
    }
  }
  
  // HANYA broadcast jika status berubah atau 30 detik telah berlalu sejak broadcast terakhir
  const shouldBroadcast = 
    previousStatus !== esp32Status.connected || 
    previousIP !== esp32Status.ip ||
    !esp32Status.lastBroadcast || 
    (Date.now() - esp32Status.lastBroadcast.getTime() > 30000);
  
  if (shouldBroadcast) {
    esp32Status.lastBroadcast = new Date();
    io.emit("esp32Status", esp32Status);
    
    if (previousStatus !== esp32Status.connected) {
      logger.esp32(`ESP32 Status Changed: ${previousStatus ? 'ONLINE' : 'OFFLINE'} -> ${esp32Status.connected ? 'ONLINE' : 'OFFLINE'}`);
    }
  }
}

function updateESP32FromHTTP(ip, activityType = "http_activity") {
  // Batasi update terlalu sering dari HTTP requests
  const now = Date.now();
  const timeSinceLastActivity = esp32Status.lastActivity ? now - esp32Status.lastActivity.getTime() : Infinity;
  
  // Hanya update jika:
  // 1. Status sebelumnya OFFLINE, ATAU
  // 2. Lebih dari 10 detik sejak aktivitas terakhir
  if (!esp32Status.connected || timeSinceLastActivity > 10000) {
    updateESP32Status(true, null, ip, activityType);
  } else {
    // Silent update tanpa broadcast untuk aktivitas rutin
    esp32Status.lastActivity = new Date();
    esp32Status.lastCheckin = new Date();
    
    // Log saja tanpa broadcast
    logger.esp32(`ESP32 Silent Heartbeat - ${activityType}`, {
      ip: ip,
      timestamp: new Date().toISOString()
    });
  }
}

// Monitoring only - no auto-disconnect
setInterval(() => {
  if (esp32Status.connected && esp32Status.lastActivity) {
    const timeSinceLastActivity = Date.now() - esp32Status.lastActivity.getTime();
    if (timeSinceLastActivity > 120000) {
      logger.esp32("INFO: ESP32 no recent activity, but connection maintained", {
        lastActivity: esp32Status.lastActivity,
        inactiveMinutes: Math.floor(timeSinceLastActivity / 60000)
      });
    }
  }
}, 60000);

// TIMER SYSTEM
function startTimer(activeTeam = null) {
  if (isTimerRunning) {
    logger.info("Timer already running, ignoring start request");
    return;
  }
  
  isTimerRunning = true;
  timeRemaining = config.timerDuration;
  const currentActiveTeam = activeTeam || lockState.activeTeam;

  io.emit("timerStart", { duration: config.timerDuration });
  
  logger.info("Timer started", { 
    timeRemaining, 
    activeTeam: currentActiveTeam,
    teamLetter: getTeamLetter(currentActiveTeam)
  });

  timerInterval = setInterval(() => {
    timeRemaining--;
    io.emit("timerUpdate", { timeRemaining });

    if ([30, 20, 10, 5, 4, 3, 2, 1, 0].includes(timeRemaining)) {
      timerAudio.playCountdownAudio(timeRemaining);
    }

    if (timeRemaining <= 0) {
      stopTimer(currentActiveTeam);
    }
  }, 1000);
}

function stopTimer(activeTeam = null) {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  isTimerRunning = false;
  io.emit("timerEnd");

  lockState = { locked: false, activeTeam: null };
  io.emit("lockstate", lockState);
  
  logger.info("Timer stopped", { activeTeam });
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
  
  logger.info("Timer reset");
}

// Function untuk memutar audio buzzer terlebih dahulu, kemudian audio tim
function playBuzzerThenTeamAudio(team) {
  const teamAudioFile = getTeamAudioFile(team);
  
  logger.audio(`Memulai sequence audio: buzzer -> ${teamAudioFile}`, { team });
  
  const buzzerPlayed = timerAudio.playPreTeamAudio(team);
  
  if (!buzzerPlayed) {
    logger.error('Buzzer audio tidak dapat diputar, langsung memutar audio tim');
    io.emit("playTeamAudio", {
      team: team,
      audioFile: teamAudioFile,
      timerDuration: config.timerDuration
    });
    return;
  }
  
  setTimeout(() => {
    if (!isTimerRunning) {
      logger.audio("Safety timeout: Memutar audio tim setelah 3 detik (buzzer mungkin gagal)");
      io.emit("playTeamAudio", {
        team: team,
        audioFile: teamAudioFile,
        timerDuration: config.timerDuration
      });
    }
  }, 3000);
}

// Start timer setelah audio selesai
function startTimerAfterAudio(team) {
  logger.info("Starting timer after audio finished", { team });
  
  audioFinishTimeout = setTimeout(() => {
    if (!isTimerRunning) {
      logger.info("SAFETY TIMEOUT: Starting timer after 5 seconds (audio might have failed)", { team });
      startTimer(team);
    }
  }, 5000);
}

// ===== STATIC FILE SERVING =====
const possiblePublicDirs = [
  join(process.cwd(), "public"),
  join(__dirname, "public"),
  join(__dirname, "..", "public")
];

let publicDirFound = null;
for (const dir of possiblePublicDirs) {
  if (fs.existsSync(dir)) {
    publicDirFound = dir;
    logger.info(`Public directory found: ${dir}`);
    break;
  }
}

if (!publicDirFound) {
  publicDirFound = join(process.cwd(), "public");
  fs.mkdirSync(publicDirFound, { recursive: true });
  logger.info(`Created public directory: ${publicDirFound}`);
}

app.use(express.static(publicDirFound));

const audioDir = join(publicDirFound, "audio");
if (fs.existsSync(audioDir)) {
  app.use('/audio', express.static(audioDir));
  logger.info(`Audio static serving from: ${audioDir}`);
} else {
  logger.error('Audio directory not found, creating...');
  fs.mkdirSync(audioDir, { recursive: true });
  app.use('/audio', express.static(audioDir));
}

// Root route untuk health check
app.get("/", (req, res) => {
  res.json({ 
    status: "Quiz Scoring System API", 
    version: "2.0.0",
    environment: isProduction ? "production" : "development",
    ready: true
  });
});

// ===== ROUTES UNTUK TEAM TOGGLE =====
app.get("/toggleTeam", (req, res) => {
  const team = parseInt(req.query.team);
  const enabled = req.query.enabled === 'true';
  
  if (!Number.isInteger(team) || team < 1 || team > TEAM_COUNT) {
    return res.status(400).json({ error: "Tim tidak valid" });
  }
  
  teamToggleState[team - 1] = enabled;
  
  logger.info("Team toggle updated", { 
    team: team, 
    teamLetter: getTeamLetter(team),
    enabled: enabled 
  });
  
  io.emit("teamToggleUpdate", {
    team: team,
    enabled: enabled
  });
  
  res.json({ 
    success: true, 
    team: team, 
    enabled: enabled,
    message: `Tim ${getTeamLetter(team)} ${enabled ? 'diaktifkan' : 'dinonaktifkan'}`
  });
});

app.get("/enableAllTeams", (req, res) => {
  teamToggleState = Array(TEAM_COUNT).fill(true);
  
  logger.info("All teams enabled");
  
  io.emit("allTeamsEnabled");
  
  res.json({ 
    success: true, 
    message: "Semua tim diaktifkan",
    teamToggleState: teamToggleState
  });
});

app.get("/disableAllTeams", (req, res) => {
  teamToggleState = Array(TEAM_COUNT).fill(false);
  
  logger.info("All teams disabled");
  
  io.emit("allTeamsDisabled");
  
  res.json({ 
    success: true, 
    message: "Semua tim dinonaktifkan",
    teamToggleState: teamToggleState
  });
});

app.get("/teamToggleState", (req, res) => {
  res.json(teamToggleState);
});

// ===== ROUTES UNTUK ESP32 =====
app.get("/esp32checkin", (req, res) => {
  const action = req.query.action || 'heartbeat';
  const team = req.query.team;
  const ip = req.ip || req.connection.remoteAddress;
  
  const realIP = req.headers['x-forwarded-for'] || 
                 req.headers['x-real-ip'] || 
                 req.connection.remoteAddress || 
                 req.socket.remoteAddress ||
                 ip;
  
  updateESP32FromHTTP(realIP, `http_${action}`);
  
  // Hanya log jika bukan heartbeat rutin
  if (action !== 'heartbeat') {
    logger.esp32(`ESP32 Check-in: ${action}`, {
      team: team,
      ip: realIP,
      timestamp: new Date().toISOString()
    });
  }
  
  res.json({ 
    success: true, 
    message: "ESP32 check-in received",
    status: esp32Status.connected ? "CONTROLLER ONLINE" : "CONTROLLER OFFLINE",
    timestamp: new Date().toISOString(),
    yourIP: realIP
  });
});

// Debug endpoint untuk ESP32
app.get("/debug/esp32", (req, res) => {
  const now = new Date();
  res.json({
    realTime: now.toISOString(),
    esp32Status: esp32Status,
    connected: esp32Status.connected,
    lastActivity: esp32Status.lastActivity,
    socketId: esp32Status.socketId,
    ip: esp32Status.ip,
    timeSinceLastActivity: esp32Status.lastActivity ? Math.floor((now - esp32Status.lastActivity) / 1000) + " seconds" : "N/A"
  });
});

// ===== ROUTE UTAMA UPDATE =====
app.get("/update", async (req, res) => {
  if (!req.query.team) {
    logger.error('Missing team parameter');
    return res.status(400).json({ error: "Parameter team diperlukan" });
  }

  const team = parseInt(req.query.team);
  
  if (!teamToggleState[team - 1]) {
    logger.error('Team is disabled', { team });
    return res.status(403).json({ error: "Tombol tim dinonaktifkan" });
  }
  
  const add = parseInt(req.query.add) || 0;
  const isFirst = req.query.first === "1";
  const ip = req.ip || req.connection.remoteAddress;

  logger.info('/update called', { team, add, isFirst, ip });

  // Optimized ESP32 status update - hanya update jika perlu
  if (ip.includes('192.168.1.') || ip.includes('172.') || ip.includes('10.')) {
    const activityType = `buzzer_${isFirst ? 'first_press' : 'scoring'}`;
    
    // Untuk aktivitas buzzer, SELALU update status (karena ini event penting)
    updateESP32Status(true, null, ip, activityType);
    
    logger.esp32("ESP32 Buzzer Activity", {
      type: "buzzer",
      team: team,
      action: isFirst ? "first_press" : "scoring",
      points: add,
      ip: ip,
      timestamp: new Date().toISOString()
    });
  }

  if (!Number.isInteger(team) || team < 1 || team > TEAM_COUNT) {
    logger.error('Invalid team', { team });
    return res.status(400).json({ error: "Tim tidak valid" });
  }

  if (lockState.locked && team !== lockState.activeTeam) {
    logger.error('Team locked', { team, activeTeam: lockState.activeTeam });
    return res.status(403).json({ error: "Tombol terkunci" });
  }

  if (isFirst && !lockState.locked) {
    lockState = { locked: true, activeTeam: team };
    io.emit("lockstate", lockState);
    io.emit("buzz", { team });
    
    playBuzzerThenTeamAudio(team);
    startTimerAfterAudio(team);
  }

  if (add !== 0) {
    scores[team - 1] += add;
    io.emit("update", { team, score: scores[team - 1] });
    io.emit("scoring", { team, isCorrect: add > 0 });
    
    timerAudio.playJuryAudio(add > 0);
    
    const feedbackMessage = generateFeedbackMessage(team, add > 0, add);
    io.emit("aiMessage", {
      message: feedbackMessage,
      shouldSpeak: false
    });
    
    logger.info(`JURI: "${feedbackMessage}"`);
    
    resetTimer();
    lockState = { locked: false, activeTeam: null };
    io.emit("lockstate", lockState);
  }

  res.json({ success: true, message: "OK", team, add, isFirst });
});

app.get("/audioFinished", (req, res) => {
  const action = req.query.action;
  const team = parseInt(req.query.team);
  const audioType = req.query.type || 'team';
  
  logger.info("Audio finished callback received", { action, team, audioType });
  
  if (audioFinishTimeout) {
    clearTimeout(audioFinishTimeout);
    audioFinishTimeout = null;
  }
  
  if (action === "startTimer" && team && audioType === 'team') {
    if (!isTimerRunning) {
      logger.info("Starting timer AFTER team audio finished", { team });
      startTimer(team);
    } else {
      logger.info("Timer already running, cannot start again");
    }
  }
  
  res.json({ 
    success: true, 
    message: "Audio finished processed",
    timerStarted: isTimerRunning
  });
});

app.get("/preTeamAudioFinished", (req, res) => {
  const team = parseInt(req.query.team);
  
  logger.info("Pre-team audio (buzzer) finished via HTTP", { team });
  
  if (team) {
    const teamAudioFile = getTeamAudioFile(team);
    
    io.emit("playTeamAudio", {
      team: team,
      audioFile: teamAudioFile,
      timerDuration: config.timerDuration
    });
    
    logger.audio(`Memutar "${teamAudioFile}" setelah buzzer selesai (HTTP callback)`);
  }
  
  res.json({ 
    success: true, 
    message: "Pre-team audio finished, team audio started",
    team: team
  });
});

app.get("/triggerAudio", (req, res) => {
  const team = parseInt(req.query.team);
  
  if (!Number.isInteger(team) || team < 1 || team > TEAM_COUNT) {
    return res.status(400).json({ error: "Tim tidak valid" });
  }
  
  playBuzzerThenTeamAudio(team);
  
  logger.audio(`Manual audio trigger for team ${team}`);
  res.json({ success: true, team: team, action: "buzzer_sequence_triggered" });
});

app.get("/unlock", (req, res) => {
  resetTimer();
  lockState = { locked: false, activeTeam: null };
  io.emit("lockstate", lockState);
  io.emit("timerReset");
  
  logger.info("Manual unlock applied");
  res.json({ success: true, message: "System unlocked", lockState });
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
  res.json({ success: true, config: config });
});

app.get("/reset", (req, res) => {
  scores = Array(TEAM_COUNT).fill(0);
  resetTimer();
  lockState = { locked: false, activeTeam: null };
  io.emit("reset", scores);
  io.emit("lockstate", lockState);
  res.json({ success: true, message: "Scores reset", scores: scores });
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
    connected: esp32Status.connected,
    lastActivity: esp32Status.lastActivity,
    lastCheckin: esp32Status.lastCheckin,
    socketId: esp32Status.socketId,
    ip: esp32Status.ip,
    connectionType: esp32Status.connectionType,
    controller: "ESP32 Master Controller",
    features: [
      "12 Team Buzzer Buttons",
      "Jury Controls (Correct/Wrong)", 
      "LED Feedback",
      "WiFi Manager Configuration",
      "Audio Trigger Support"
    ],
    status: esp32Status.connected ? "CONTROLLER ONLINE" : "CONTROLLER OFFLINE",
    uptime: esp32Status.lastActivity ? Math.floor((now - esp32Status.lastActivity) / 1000) + " seconds" : "N/A",
    realTime: now.toISOString()
  };
  
  res.json(statusInfo);
});

app.get("/health", (req, res) => {
  const now = new Date();
  res.json({ 
    status: "OK", 
    scores, 
    lockState, 
    config,
    timer: {
      running: isTimerRunning,
      remaining: timeRemaining
    },
    esp32: esp32Status,
    teamToggle: {
      state: teamToggleState,
      activeCount: teamToggleState.filter(state => state).length,
      disabledCount: teamToggleState.filter(state => !state).length
    },
    connections: io.engine.clientsCount,
    environment: isProduction ? "production" : "development"
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Error Handler
app.use((err, req, res, next) => {
  logger.error('Server error:', err);
  res.status(500).json({ 
    error: "Internal server error",
    message: isProduction ? "Something went wrong" : err.message
  });
});

// Socket connection
io.on("connection", (socket) => {
  const clientType = socket.handshake.query.clientType || 'unknown';
  const clientIP = socket.handshake.address;
  const userAgent = socket.handshake.headers['user-agent'] || 'unknown';
  
  logger.info("Client connected", { 
    socketId: socket.id,
    clientType: clientType,
    ip: clientIP,
    userAgent: userAgent
  });

  const isESP32 = clientType === 'esp32' || 
                  clientIP.includes('192.168.1.') || 
                  clientIP.includes('172.') || 
                  clientIP.includes('10.') ||
                  userAgent.toLowerCase().includes('esp32') ||
                  userAgent.toLowerCase().includes('arduino');

  if (isESP32) {
    updateESP32Status(true, socket, clientIP, "socket_connection");
    logger.esp32("ESP32 Controller detected via Socket.IO", {
      socketId: socket.id,
      ip: clientIP,
      userAgent: userAgent,
      clientType: clientType
    });
    
    socket.on("esp32Heartbeat", (data) => {
      updateESP32Status(true, socket, clientIP, "heartbeat");
      logger.esp32("ESP32 Heartbeat received", data);
    });
    
    socket.on("esp32Activity", (data) => {
      updateESP32Status(true, socket, clientIP, "activity");
      logger.esp32("ESP32 Activity", data);
    });
  }

  socket.emit("scores", scores);
  socket.emit("config", config);
  socket.emit("lockstate", lockState);
  socket.emit("teamToggleState", teamToggleState);
  socket.emit("esp32Status", esp32Status);
  
  if (isTimerRunning) {
    socket.emit("timerStart", { duration: timeRemaining });
  }

  socket.on("preTeamAudioFinished", (data) => {
    const team = data.team;
    logger.info("Pre-team audio finished via Socket.IO", { team });
    
    if (team) {
      const teamAudioFile = getTeamAudioFile(team);
      
      io.emit("playTeamAudio", {
        team: team,
        audioFile: teamAudioFile,
        timerDuration: config.timerDuration
      });
      
      logger.audio(`Memutar "${teamAudioFile}" setelah buzzer selesai (Socket.IO)`);
    }
  });

  socket.on("disconnect", (reason) => {
    const wasESP32 = clientType === 'esp32' || 
                     clientIP.includes('192.168.1.') || 
                     clientIP.includes('172.') || 
                     clientIP.includes('10.');
                     
    if (wasESP32) {
      updateESP32Status(false, null, null, "socket_disconnect");
    }
    
    logger.info("Client disconnected", { 
      socketId: socket.id, 
      reason: reason,
      clientType: clientType,
      ip: clientIP
    });
  });
});

// Startup server
async function startServer() {
  const audioDir = validateAudioFiles();
  
  http.listen(PORT, async () => {
    console.log('SISTEM KUIS - Ridwan and Team');
    console.log('----------------------------------------');
    console.log(`Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`Port: ${PORT}`);
    console.log(`Tampilan: http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin.html`);
    console.log('----------------------------------------');
  });
}

startServer();