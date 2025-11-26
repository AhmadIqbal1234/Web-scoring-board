﻿/*Copyright © 2025 Ridwan and Team*/
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

// ===== SMART SECURITY MIDDLEWARE =====
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

// ===== SMART RATE LIMITING - FIXED IP DETECTION =====
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => {
    let clientIP = req.ip || 
                  req.connection.remoteAddress || 
                  req.socket.remoteAddress ||
                  (req.connection.socket ? req.connection.socket.remoteAddress : null);
    
    if (!isProduction) {
      console.log(`[RATE LIMIT] Client IP: ${clientIP}, URL: ${req.url}`);
    }
    
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
      if (!isProduction) {
        console.log(`[RATE LIMIT] Whitelisted - IP: ${clientIP}, URL: ${req.url}`);
      }
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

// CORS setup untuk semua environment
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
let esp32Connected = false;
let lastEsp32Activity = null;
let esp32SocketId = null;
let esp32LastIP = null;

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

    // Audio yang akan diputar sebelum audio tim
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

  // Method untuk memutar audio sebelum audio tim
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
    'benar.mp3', 'salah.mp3', 'buzzer.mp3' // Ditambahkan buzzer.mp3
  ];
  
  logger.info("Validating audio files...");
  logger.info(`Audio directory: ${audioDirFound}`);
  
  let missingFiles = [];
  let foundFiles = [];
  
  requiredFiles.forEach(file => {
    const filePath = join(audioDirFound, file);
    if (fs.existsSync(filePath)) {
      foundFiles.push(file);
      logger.audio(`Audio file found: ${file}`);
    } else {
      missingFiles.push(file);
      logger.error(`Audio file missing: ${file}`);
    }
  });
  
  logger.info(`Audio validation result: ${foundFiles.length}/${requiredFiles.length} files found`);
  if (missingFiles.length > 0) {
    logger.error(`Missing files: ${missingFiles.join(', ')}`);
    
    if (!isProduction) {
      logger.info('Creating placeholder audio files for development...');
      missingFiles.forEach(file => {
        const placeholderPath = join(audioDirFound, file);
        fs.writeFileSync(placeholderPath, '');
        logger.info(`Created placeholder: ${file}`);
      });
    }
  }
  
  return audioDirFound;
}

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
  
  // Pertama, memutar audio buzzer
  timerAudio.playPreTeamAudio(team);
  
  // Setelah buzzer selesai, memutar audio tim
  // Client akan mengirim event "preTeamAudioFinished" ketika buzzer selesai
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

// Function untuk update ESP32 status dan broadcast
function updateESP32Status(connected, socket = null, ip = null) {
  esp32Connected = connected;
  
  if (connected && socket) {
    lastEsp32Activity = new Date();
    esp32SocketId = socket.id;
    esp32LastIP = ip;
    logger.esp32("ESP32 Controller Connected", {
      socketId: socket.id,
      ip: ip,
      timestamp: lastEsp32Activity.toISOString()
    });
  } else if (!connected) {
    logger.esp32("ESP32 Controller Disconnected", {
      socketId: esp32SocketId,
      timestamp: new Date().toISOString()
    });
  }
  
  io.emit("esp32Status", {
    connected: esp32Connected,
    lastActivity: lastEsp32Activity,
    socketId: esp32SocketId,
    ip: esp32LastIP
  });
}

// ROUTE UNTUK ESP32 CHECK-IN (HTTP Based)
app.get("/esp32checkin", (req, res) => {
  const action = req.query.action || 'heartbeat';
  const team = req.query.team;
  const ip = req.ip || req.connection.remoteAddress;
  
  esp32Connected = true;
  lastEsp32Activity = new Date();
  esp32LastIP = ip;
  
  logger.esp32(`ESP32 HTTP Check-in: ${action}`, {
    team: team,
    ip: ip,
    timestamp: lastEsp32Activity.toISOString()
  });
  
  io.emit("esp32Status", {
    connected: true,
    lastActivity: lastEsp32Activity,
    socketId: "HTTP_CONNECTION",
    ip: ip,
    activity: action
  });
  
  res.json({ 
    success: true, 
    message: "ESP32 check-in received",
    status: "CONTROLLER ONLINE",
    timestamp: lastEsp32Activity.toISOString()
  });
});

// ===== STATIC FILE SERVING dengan path yang robust =====
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
} else {
  logger.error('Audio directory not found, creating...');
  fs.mkdirSync(audioDir, { recursive: true });
  app.use('/audio', express.static(audioDir));
}

// Favicon route
app.get('/tts/android-chrome-192x192.png', (req, res) => {
  const faviconPath = join(publicDirFound, 'tts', 'android-chrome-192x192.png');
  if (fs.existsSync(faviconPath)) {
    res.sendFile(faviconPath);
  } else {
    const fallbackPath = join(publicDirFound, 'android-chrome-192x192.png');
    if (fs.existsSync(fallbackPath)) {
      res.sendFile(fallbackPath);
    } else {
      res.status(404).send('Favicon not found');
    }
  }
});

// Root route untuk health check
app.get("/", (req, res) => {
  res.json({ 
    status: "Quiz Scoring System API", 
    version: "2.0.0",
    environment: isProduction ? "production" : "development",
    rateLimiting: "Smart limits enabled",
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

  if (ip.includes('192.168.1.') || ip.includes('172.') || ip.includes('10.')) {
    lastEsp32Activity = new Date();
    logger.esp32("ESP32 Activity", {
      type: "buzzer",
      team: team,
      action: isFirst ? "first_press" : "scoring",
      points: add,
      ip: ip,
      timestamp: lastEsp32Activity.toISOString()
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
    
    // Memutar sequence audio: buzzer -> audio tim
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

// Route baru untuk menangani selesainya pre-team audio (buzzer)
app.get("/preTeamAudioFinished", (req, res) => {
  const team = parseInt(req.query.team);
  
  logger.info("Pre-team audio (buzzer) finished", { team });
  
  if (team) {
    const teamAudioFile = getTeamAudioFile(team);
    
    // Setelah buzzer selesai, memutar audio tim
    io.emit("playTeamAudio", {
      team: team,
      audioFile: teamAudioFile,
      timerDuration: config.timerDuration
    });
    
    logger.audio(`Memutar "${teamAudioFile}" setelah buzzer selesai`);
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
  
  const audioFile = getTeamAudioFile(team);
  io.emit("playTeamAudio", {
    team: team,
    audioFile: audioFile,
    timerDuration: config.timerDuration
  });
  
  logger.audio(`Manual audio trigger for team ${team}`);
  res.json({ success: true, team: team, audioFile: audioFile });
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
  res.json({ 
    connected: esp32Connected,
    lastActivity: lastEsp32Activity,
    socketId: esp32SocketId,
    ip: esp32LastIP,
    controller: "ESP32 Master Controller",
    features: [
      "12 Team Buzzer Buttons",
      "Jury Controls (Correct/Wrong)", 
      "LED Feedback",
      "WiFi Manager Configuration",
      "Audio Trigger Support"
    ],
    status: esp32Connected ? "CONTROLLER ONLINE" : "CONTROLLER OFFLINE"
  });
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    scores, 
    lockState, 
    config,
    timer: {
      running: isTimerRunning,
      remaining: timeRemaining
    },
    esp32: {
      connected: esp32Connected,
      lastActivity: lastEsp32Activity,
      socketId: esp32SocketId,
      ip: esp32LastIP,
      status: esp32Connected ? "CONTROLLER ONLINE" : "CONTROLLER OFFLINE"
    },
    teamToggle: {
      state: teamToggleState,
      activeCount: teamToggleState.filter(state => state).length,
      disabledCount: teamToggleState.filter(state => !state).length
    },
    connections: io.engine.clientsCount,
    environment: isProduction ? "production" : "development",
    rateLimiting: "Smart limits active",
    services: {
      audio: "Audio File System - File per Tim & Timer Countdown & Juri",
      timer: "START AFTER AUDIO - Timer mulai setelah audio selesai",
      esp32: "ESP32 Master Controller with Buzzer & LED System",
      safety: "5-second safety timeout implemented",
      jury: "Audio feedback untuk tombol juri (benar/salah)",
      tracking: "ESP32 HTTP Heartbeat System Active",
      teamToggle: "Team toggle controls - Enable/disable individual teams",
      buzzer: "BUZZER FIRST - Memutar buzzer.mp3 sebelum audio tim"
    }
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

// Socket connection dengan ESP32 tracking
io.on("connection", (socket) => {
  const clientType = socket.handshake.query.clientType || 'unknown';
  const clientIP = socket.handshake.address;
  
  logger.info("Client connected", { 
    socketId: socket.id,
    clientType: clientType,
    ip: clientIP
  });

  if (clientType === 'esp32' || clientIP.includes('192.168.1.')) {
    updateESP32Status(true, socket, clientIP);
    logger.esp32("ESP32 Controller detected via Socket.IO", {
      socketId: socket.id,
      ip: clientIP
    });
  }

  socket.emit("scores", scores);
  socket.emit("config", config);
  socket.emit("lockstate", lockState);
  socket.emit("teamToggleState", teamToggleState);
  
  if (isTimerRunning) {
    socket.emit("timerStart", { duration: timeRemaining });
  }

  // Event handler untuk pre-team audio finished
  socket.on("preTeamAudioFinished", (data) => {
    const team = data.team;
    logger.info("Pre-team audio finished via Socket.IO", { team });
    
    if (team) {
      const teamAudioFile = getTeamAudioFile(team);
      
      // Setelah buzzer selesai, memutar audio tim
      io.emit("playTeamAudio", {
        team: team,
        audioFile: teamAudioFile,
        timerDuration: config.timerDuration
      });
      
      logger.audio(`Memutar "${teamAudioFile}" setelah buzzer selesai (Socket.IO)`);
    }
  });

  socket.on("disconnect", (reason) => {
    if (clientType === 'esp32' || clientIP.includes('192.168.1.')) {
      updateESP32Status(false);
    }
    
    logger.info("Client disconnected", { 
      socketId: socket.id, 
      reason: reason,
      clientType: clientType
    });
  });
});

// Startup server
async function startServer() {
  const audioDir = validateAudioFiles();
  
  http.listen(PORT, async () => {
    console.log('\nSISTEM KUIS - Ridwan and Team');
    console.log('───────────────────────────────────────────────────────');
    console.log(`Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`Port: ${PORT}`);
    console.log(`Tampilan: http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin.html`);
    console.log('───────────────────────────────────────────────────────\n');
  });
}

startServer();