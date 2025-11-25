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

// ===== IMPROVED STATE MANAGEMENT =====
let scores = Array(TEAM_COUNT).fill(0);
let config = { plus: 5, minus: -2, timerDuration: 30 };
let lockState = { locked: false, activeTeam: null };
let teamToggleState = Array(TEAM_COUNT).fill(true);

// IMPROVED: Timer state dengan protection
let timerInterval = null;
let timeRemaining = 0;
let isTimerRunning = false;
let isAudioPlaying = false;
let audioFinishTimeout = null;

// IMPROVED: ESP32 Status dengan heartbeat
let esp32Connected = false;
let lastEsp32Activity = null;
let esp32SocketId = null;
let esp32LastIP = null;
let esp32HeartbeatInterval = null;

// FIX: Request tracking untuk prevent spam dan double processing
let recentRequests = new Map();
const REQUEST_WINDOW_MS = 1000;
const MAX_REQUESTS_PER_WINDOW = 2;

// FIX: Track active requests untuk prevent race condition
let activeRequests = new Set();

const logger = {
  info: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  error: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  
  warn: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }
};

// FIX: Improved Rate limiting helper dengan request ID
function isRateLimited(identifier) {
  const now = Date.now();
  const windowStart = now - REQUEST_WINDOW_MS;
  
  if (!recentRequests.has(identifier)) {
    recentRequests.set(identifier, []);
  }
  
  const requests = recentRequests.get(identifier).filter(time => time > windowStart);
  recentRequests.set(identifier, requests);
  
  if (requests.length >= MAX_REQUESTS_PER_WINDOW) {
    return true;
  }
  
  requests.push(now);
  return false;
}

// FIX: Generate unique request ID untuk tracking
function generateRequestId(team, action) {
  return `req_${team}_${action}_${Date.now()}`;
}

// FIX: Check if request is already being processed
function isRequestActive(requestId) {
  return activeRequests.has(requestId);
}

// FIX: Mark request as active
function markRequestActive(requestId) {
  activeRequests.add(requestId);
}

// FIX: Mark request as completed
function markRequestComplete(requestId) {
  activeRequests.delete(requestId);
}

// IMPROVED: Audio System dengan better error handling
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
  }

  playCountdownAudio(seconds) {
    const audioFile = this.audioFiles[seconds];
    if (audioFile) {
      io.emit("playTimerAudio", {
        seconds: seconds,
        audioFile: audioFile
      });
      logger.info(`Memutar countdown audio: ${audioFile}`);
    }
  }

  playJuryAudio(isCorrect) {
    const audioFile = isCorrect ? this.juryAudio.correct : this.juryAudio.wrong;
    if (audioFile) {
      io.emit("playJuryAudio", {
        isCorrect: isCorrect,
        audioFile: audioFile
      });
      logger.info(`Memutar audio juri: ${audioFile} (${isCorrect ? 'BENAR' : 'SALAH'})`);
    }
  }
}

const timerAudio = new TimerAudioSystem();

// Helper function untuk nama tim
function getTeamLetter(teamNumber) {
  return String.fromCharCode(64 + teamNumber);
}

// IMPROVED: Generate feedback messages
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
    'benar.mp3', 'salah.mp3'
  ];
  
  logger.info("Validating audio files...");
  
  let missingFiles = [];
  let foundFiles = [];
  
  requiredFiles.forEach(file => {
    const filePath = join(audioDirFound, file);
    if (fs.existsSync(filePath)) {
      foundFiles.push(file);
    } else {
      missingFiles.push(file);
    }
  });
  
  logger.info(`Audio validation result: ${foundFiles.length}/${requiredFiles.length} files found`);
  if (missingFiles.length > 0) {
    logger.error(`Missing files: ${missingFiles.join(', ')}`);
  }
  
  return audioDirFound;
}

// IMPROVED: TIMER SYSTEM dengan better state management
function startTimer(activeTeam = null) {
  if (isTimerRunning) {
    logger.info("Timer already running, ignoring start request");
    return false;
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

    // Audio countdown
    if ([30, 20, 10, 5, 4, 3, 2, 1, 0].includes(timeRemaining)) {
      timerAudio.playCountdownAudio(timeRemaining);
    }

    if (timeRemaining <= 0) {
      stopTimer(currentActiveTeam);
    }
  }, 1000);
  
  return true;
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
  isAudioPlaying = false;
  timeRemaining = 0;
  io.emit("timerReset");
  
  logger.info("Timer reset");
}

// IMPROVED: Start timer setelah audio dengan better sync
function startTimerAfterAudio(team) {
  logger.info("Starting timer after audio finished", { team });
  
  if (audioFinishTimeout) {
    clearTimeout(audioFinishTimeout);
  }
  
  isAudioPlaying = true;
  
  audioFinishTimeout = setTimeout(() => {
    isAudioPlaying = false;
    if (!isTimerRunning) {
      logger.info("SAFETY TIMEOUT: Starting timer after audio timeout", { team });
      startTimer(team);
    }
  }, 5000);
}

// IMPROVED: Function untuk update ESP32 status dengan heartbeat
function updateESP32Status(connected, socket = null, ip = null) {
  esp32Connected = connected;
  
  if (connected && socket) {
    lastEsp32Activity = new Date();
    esp32SocketId = socket.id;
    esp32LastIP = ip;
    
    if (esp32HeartbeatInterval) {
      clearInterval(esp32HeartbeatInterval);
    }
    
    esp32HeartbeatInterval = setInterval(() => {
      const timeSinceLastActivity = new Date() - lastEsp32Activity;
      if (timeSinceLastActivity > 120000) {
        logger.warn("ESP32 heartbeat timeout - marking as disconnected");
        updateESP32Status(false);
        clearInterval(esp32HeartbeatInterval);
      }
    }, 30000);
    
    logger.info("ESP32 Controller Connected", {
      socketId: socket.id,
      ip: ip,
      timestamp: lastEsp32Activity.toISOString()
    });
  } else if (!connected) {
    logger.info("ESP32 Controller Disconnected", {
      socketId: esp32SocketId,
      timestamp: new Date().toISOString()
    });
    
    if (esp32HeartbeatInterval) {
      clearInterval(esp32HeartbeatInterval);
      esp32HeartbeatInterval = null;
    }
  }
  
  io.emit("esp32Status", {
    connected: esp32Connected,
    lastActivity: lastEsp32Activity,
    socketId: esp32SocketId,
    ip: esp32LastIP
  });
}

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

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: {
    error: 'Terlalu banyak request',
    message: 'Silakan coba lagi setelah 15 menit'
  },
  standardHeaders: true,
  legacyHeaders: false,
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

// ===== ROUTES =====

// Root route untuk health check
app.get("/", (req, res) => {
  res.json({ 
    status: "Quiz Scoring System API", 
    version: "2.1.0",
    environment: isProduction ? "production" : "development",
    ready: true
  });
});

// IMPROVED: ROUTES UNTUK TEAM TOGGLE
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

// FIX: COMPLETELY REWRITTEN UPDATE ENDPOINT - SINGLE SOURCE OF TRUTH
app.get("/update", async (req, res) => {
  const requestId = generateRequestId(req.query.team, req.query.add);
  
  // Cek jika request ini sedang diproses
  if (isRequestActive(requestId)) {
    logger.warn('Request already being processed', { requestId, query: req.query });
    return res.status(429).json({ error: "Request sedang diproses" });
  }
  
  // Cek rate limiting
  const clientIP = req.ip || req.connection.remoteAddress;
  if (isRateLimited(`update_${clientIP}`)) {
    logger.warn('Rate limited request', { ip: clientIP, query: req.query });
    return res.status(429).json({ error: "Terlalu banyak request" });
  }

  try {
    console.log('=== 🎯 UPDATE ENDPOINT - PROCESSING START ===');
    console.log('📋 Query parameters:', req.query);
    console.log('🌐 Client IP:', clientIP);
    console.log('🆔 Request ID:', requestId);
    
    // Mark request as active
    markRequestActive(requestId);

    // VALIDASI PARAMETER
    if (!req.query.team) {
      console.log('❌ Missing team parameter');
      markRequestComplete(requestId);
      return res.status(400).json({ error: "Parameter team diperlukan" });
    }

    const team = parseInt(req.query.team);
    const add = parseInt(req.query.add) || 0;
    const isFirst = req.query.first === "1";

    console.log('🔢 Parsed values - team:', team, 'add:', add, 'isFirst:', isFirst);

    // VALIDASI TEAM
    if (!Number.isInteger(team) || team < 1 || team > TEAM_COUNT) {
      console.log('❌ Invalid team number');
      markRequestComplete(requestId);
      return res.status(400).json({ error: "Tim tidak valid" });
    }

    // VALIDASI TEAM ENABLED
    if (!teamToggleState[team - 1]) {
      console.log('❌ Team is disabled');
      markRequestComplete(requestId);
      return res.status(403).json({ error: "Tombol tim dinonaktifkan" });
    }

    // VALIDASI LOCK STATE UNTUK FIRST PRESS
    if (isFirst) {
      if (lockState.locked) {
        console.log('❌ System already locked');
        markRequestComplete(requestId);
        return res.status(403).json({ error: "Sistem sudah terkunci" });
      }
    }

    // VALIDASI LOCK STATE UNTUK SCORING
    if (add !== 0) {
      if (!lockState.locked) {
        console.log('❌ System not locked for scoring');
        markRequestComplete(requestId);
        return res.status(403).json({ error: "Sistem tidak terkunci" });
      }
      if (lockState.activeTeam !== team) {
        console.log('❌ Wrong team for scoring');
        markRequestComplete(requestId);
        return res.status(403).json({ error: "Bukan giliran tim ini" });
      }
    }

    console.log('✅ All validations passed');

    // TRACK ESP32 ACTIVITY
    if (clientIP.includes('192.168.1.') || clientIP.includes('172.') || clientIP.includes('10.')) {
      lastEsp32Activity = new Date();
      console.log('📡 ESP32 Activity detected');
      updateESP32Status(true, null, clientIP);
    }

    // PROSES FIRST PRESS (BUZZER)
    if (isFirst && !lockState.locked) {
      console.log('🎮 FIRST PRESS - Activating team:', team);
      
      // Update lock state
      lockState = { locked: true, activeTeam: team };
      console.log('📢 Emitting lockstate:', lockState);
      io.emit("lockstate", lockState);
      
      console.log('📢 Emitting buzz for team:', team);
      io.emit("buzz", { team });
      
      const audioFile = `Tim ${getTeamLetter(team)}.mp3`;
      console.log('🎵 Emitting playTeamAudio for team:', team);
      io.emit("playTeamAudio", {
        team: team,
        audioFile: audioFile,
        timerDuration: config.timerDuration
      });
      
      logger.info(`Memutar "${audioFile}" - Timer akan mulai setelah audio selesai`);
      startTimerAfterAudio(team);
    }

    // PROSES SCORING (JURY ACTION)
    if (add !== 0) {
      console.log('➕ SCORING ACTION - Adding score:', add, 'to team:', team);
      
      // Calculate new score
      const oldScore = scores[team - 1];
      const newScore = Math.max(0, oldScore + add); // Prevent negative scores
      scores[team - 1] = newScore;
      
      console.log('📊 Score updated:', { team, oldScore, newScore, add });
      
      // EMIT SCORE UPDATE HANYA SEKALI
      console.log('📢 Emitting SINGLE score update for team:', team);
      io.emit("update", { team, score: newScore });
      
      // Play jury audio
      timerAudio.playJuryAudio(add > 0);
      
      // Send feedback message
      const feedbackMessage = generateFeedbackMessage(team, add > 0, add);
      console.log('📢 Emitting AI message:', feedbackMessage);
      io.emit("aiMessage", {
        message: feedbackMessage,
        shouldSpeak: false
      });
      
      logger.info(`JURI: "${feedbackMessage}"`);
      
      // Reset system
      resetTimer();
      lockState = { locked: false, activeTeam: null };
      console.log('📢 Emitting final lockstate:', lockState);
      io.emit("lockstate", lockState);
    }

    console.log('✅ UPDATE SUCCESS - Request completed');
    markRequestComplete(requestId);
    res.json({ 
      success: true, 
      message: "OK", 
      team, 
      add, 
      isFirst,
      newScore: add !== 0 ? scores[team - 1] : undefined
    });
    
  } catch (error) {
    console.log('❌ UPDATE ERROR:', error);
    markRequestComplete(requestId);
    logger.error('Error in /update endpoint:', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// IMPROVED: Audio finished callback
app.get("/audioFinished", (req, res) => {
  try {
    const action = req.query.action;
    const team = parseInt(req.query.team);
    const audioType = req.query.type || 'team';
    
    console.log('🎵 Audio finished callback:', { action, team, audioType });
    
    if (audioFinishTimeout) {
      clearTimeout(audioFinishTimeout);
    }
    
    isAudioPlaying = false;
    
    if (action === "startTimer" && team && audioType === 'team') {
      if (!isTimerRunning) {
        console.log('⏰ Starting timer after audio finished for team:', team);
        startTimer(team);
      } else {
        console.log('⏰ Timer already running');
      }
    }
    
    res.json({ 
      success: true, 
      message: "Audio finished processed",
      timerStarted: isTimerRunning
    });
  } catch (error) {
    console.log('❌ Audio finished error:', error);
    logger.error('Error in /audioFinished:', error);
    res.status(500).json({ error: "Processing failed" });
  }
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
      "WiFi Manager Configuration"
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
      remaining: timeRemaining,
      audioPlaying: isAudioPlaying
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
    environment: isProduction ? "production" : "development"
  });
});

// ROUTE UNTUK ESP32 CHECK-IN
app.get("/esp32checkin", (req, res) => {
  const action = req.query.action || 'heartbeat';
  const team = req.query.team;
  const ip = req.ip || req.connection.remoteAddress;
  
  esp32Connected = true;
  lastEsp32Activity = new Date();
  esp32LastIP = ip;
  
  logger.info(`ESP32 HTTP Check-in: ${action}`, {
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

// TEST ROUTE untuk manual testing
app.get("/test", (req, res) => {
  res.sendFile(join(publicDirFound, 'test.html'));
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

// FIX: IMPROVED Socket connection dengan request tracking
io.on("connection", (socket) => {
  const clientType = socket.handshake.query.clientType || 'unknown';
  const clientIP = socket.handshake.address;
  
  console.log('🔌 New client connected:', {
    socketId: socket.id,
    clientType: clientType,
    ip: clientIP
  });

  if (clientType === 'esp32' || clientIP.includes('192.168.1.')) {
    updateESP32Status(true, socket, clientIP);
    console.log('📡 ESP32 Controller detected via Socket.IO');
  }

  // Send initial state
  socket.emit("scores", scores);
  socket.emit("config", config);
  socket.emit("lockstate", lockState);
  socket.emit("teamToggleState", teamToggleState);
  
  if (isTimerRunning) {
    socket.emit("timerStart", { duration: timeRemaining });
  }

  // Test ping-pong
  socket.on("ping", (data) => {
    console.log('🏓 Ping received from client:', socket.id);
    socket.emit("pong", { ...data, serverTime: Date.now() });
  });

  socket.on("toggleTeam", (data) => {
    try {
      const { teamId, enabled } = data;
      if (teamId >= 1 && teamId <= TEAM_COUNT) {
        teamToggleState[teamId - 1] = enabled;
        console.log('🔘 Team toggle from admin:', { teamId, enabled });
        
        io.emit("teamToggleUpdate", {
          team: teamId,
          enabled: enabled
        });
      }
    } catch (error) {
      console.log('❌ Error in toggleTeam socket event:', error);
    }
  });

  socket.on("enableAllTeams", () => {
    teamToggleState = Array(TEAM_COUNT).fill(true);
    console.log('🔘 Enable all teams from admin');
    
    io.emit("allTeamsEnabled");
  });

  socket.on("disconnect", (reason) => {
    if (clientType === 'esp32' || clientIP.includes('192.168.1.')) {
      updateESP32Status(false);
    }
    
    console.log('🔌 Client disconnected:', {
      socketId: socket.id, 
      reason: reason,
      clientType: clientType
    });
  });
});

// Di bagian socket connection, tambahkan event untuk team button activity
io.on("connection", (socket) => {
  const clientType = socket.handshake.query.clientType || 'unknown';
  const clientIP = socket.handshake.address;
  
  console.log('🔌 New client connected:', {
    socketId: socket.id,
    clientType: clientType,
    ip: clientIP
  });

  if (clientType === 'esp32' || clientIP.includes('192.168.1.')) {
    updateESP32Status(true, socket, clientIP);
    console.log('📡 ESP32 Controller detected via Socket.IO');
  }

  // Send initial state
  socket.emit("scores", scores);
  socket.emit("config", config);
  socket.emit("lockstate", lockState);
  socket.emit("teamToggleState", teamToggleState);
  
  if (isTimerRunning) {
    socket.emit("timerStart", { duration: timeRemaining });
  }

  // Test ping-pong
  socket.on("ping", (data) => {
    console.log('🏓 Ping received from client:', socket.id);
    socket.emit("pong", { ...data, serverTime: Date.now() });
  });

  // Team button activity tracking
  socket.on("teamButtonActivity", (data) => {
    console.log('🔘 Team button activity:', data);
    if (data.team && data.team >= 1 && data.team <= TEAM_COUNT) {
      io.emit("teamButtonStatus", {
        team: data.team,
        connected: true,
        timestamp: new Date().toISOString()
      });
    }
  });

  socket.on("toggleTeam", (data) => {
    try {
      const { teamId, enabled } = data;
      if (teamId >= 1 && teamId <= TEAM_COUNT) {
        teamToggleState[teamId - 1] = enabled;
        console.log('🔘 Team toggle from admin:', { teamId, enabled });
        
        io.emit("teamToggleUpdate", {
          team: teamId,
          enabled: enabled
        });
      }
    } catch (error) {
      console.log('❌ Error in toggleTeam socket event:', error);
    }
  });

  socket.on("enableAllTeams", () => {
    teamToggleState = Array(TEAM_COUNT).fill(true);
    console.log('🔘 Enable all teams from admin');
    
    io.emit("allTeamsEnabled");
  });

  socket.on("disconnect", (reason) => {
    if (clientType === 'esp32' || clientIP.includes('192.168.1.')) {
      updateESP32Status(false);
    }
    
    console.log('🔌 Client disconnected:', {
      socketId: socket.id, 
      reason: reason,
      clientType: clientType
    });
  });
});

// Startup server
async function startServer() {
  validateAudioFiles();
  
  http.listen(PORT, async () => {
    console.log('\nSISTEM KUIS - DOUBLE SCORE FIXED');
    console.log('───────────────────────────────────────────────────────');
    console.log(`Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`Port: ${PORT}`);
    console.log(`Tampilan: http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin.html`);
    console.log('───────────────────────────────────────────────────────\n');
  });
}

startServer();