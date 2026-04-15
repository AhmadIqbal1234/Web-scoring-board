﻿/* Copyright © 2025 Ridwan and Team */
/*
  server.js - Bug Fix Edition
  PERBAIKAN:
  - [FIX] Deteksi ESP32 via Socket.IO tidak lagi menggunakan IP lokal sebagai kriteria.
    Sebelumnya browser admin dari laptop di jaringan lokal bisa memicu esp32Status.connected = true
    padahal tidak ada ESP32 yang benar-benar terhubung.
    Sekarang hanya menggunakan clientType === 'esp32' atau User-Agent string.
*/
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const http = createServer(app);

// ===== KONFIGURASI LINGKUNGAN =====
const PORT = process.env.PORT || 8080;
const WS_PORT = process.env.WS_PORT || 8081;
const TEAM_COUNT = 12;
const isProduction = process.env.NODE_ENV === 'production';

// ===== STATE PERSISTENCE =====
const STATE_FILE = join(__dirname, 'state.json');

// Fungsi untuk memuat state dari file
function loadPersistedState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const state = JSON.parse(data);
      
      if (state.scores && Array.isArray(state.scores)) {
        scores = state.scores;
        logger.info(`State loaded from file: ${scores.length} scores restored`);
      }
      
      if (state.config) {
        config = state.config;
        logger.info('Config restored from file');
      }
      
      if (state.teamToggleState && Array.isArray(state.teamToggleState)) {
        teamToggleState = state.teamToggleState;
        logger.info('Team toggle state restored from file');
      }
      
      if (state.autoPenaltyEnabled !== undefined) {
        isAutoPenaltyEnabled = state.autoPenaltyEnabled;
        logger.info(`Auto penalty state restored: ${isAutoPenaltyEnabled}`);
      }
      
      return true;
    } else {
      logger.info('No saved state found, using defaults');
      return false;
    }
  } catch (err) {
    logger.error('Error loading persisted state:', err);
    return false;
  }
}

// Fungsi untuk menyimpan state ke file
function savePersistedState() {
  try {
    const state = {
      scores: scores,
      config: config,
      teamToggleState: teamToggleState,
      autoPenaltyEnabled: isAutoPenaltyEnabled,
      timestamp: new Date().toISOString(),
      version: '1.0'
    };
    
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    logger.info('State saved to file');
    return true;
  } catch (err) {
    logger.error('Error saving persisted state:', err);
    return false;
  }
}

// Fungsi untuk menyimpan skor saja
function saveScoresOnly() {
  try {
    const state = {
      scores: scores,
      timestamp: new Date().toISOString()
    };
    
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    logger.info('Scores saved to file');
    return true;
  } catch (err) {
    logger.error('Error saving scores:', err);
    return false;
  }
}

// ===== WEBSOCKET SERVER UNTUK ESP32 =====
const wss = new WebSocketServer({ 
  noServer: true
});

// PERBAIKAN: Setup upgrade handler di awal
http.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  
  // Tangani WebSocket ESP32
  if (pathname === '/esp32ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } 
  // Tangani Socket.IO
  else if (pathname === '/socket.io/') {
    // Biarkan Socket.IO menangani
  } 
  else {
    socket.destroy();
  }
});

// State untuk koneksi WebSocket ESP32
let esp32WebSocket = null;
let esp32WebSocketId = null;
let lastESP32Heartbeat = null;

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
  pingInterval: 25000
});

// ===== DATA STATE DENGAN ATOMIC LOCK =====
let scores = Array(TEAM_COUNT).fill(0);
let config = { plus: 5, minus: -2, timerDuration: 30 };
let lockState = { 
  locked: false, 
  activeTeam: null,
  lockTime: null,
  lockId: null,
  lockSequence: 0
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
  wifiRSSI: null  // PERBAIKAN: Diubah dari 0 menjadi null
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
  
  websocket: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] WEBSOCKET: ${message}`, data ? JSON.stringify(data, null, 2) : '');
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

// ===== ATOMIC LOCK FUNCTIONS =====
function acquireAtomicLock(team) {
  const now = Date.now();
  const lockThreshold = 10;
  
  if (lockState.locked) {
    const lockAge = now - (lockState.lockTime || now);
    
    if (lockAge < lockThreshold) {
      logger.lock(`Lock DITOLAK - Tim ${getTeamLetter(team)} terlambat ${lockAge}ms`);
      return false;
    }
    
    if (lockState.activeTeam !== team) {
      logger.lock(`Lock DENIED untuk Tim ${getTeamLetter(team)} - sudah terkunci oleh Tim ${getTeamLetter(lockState.activeTeam)} (${lockAge}ms yang lalu)`);
      return false;
    }
    
    if (lockAge < 50) {
      logger.lock(`Duplikat buzz dari Tim ${getTeamLetter(team)} diabaikan`);
      return false;
    }
  }
  
  lockState = { 
    locked: true, 
    activeTeam: team,
    lockTime: now,
    lockId: `lock_${now}_${team}_${Math.random().toString(36).substr(2, 9)}`,
    lockSequence: lockState.lockSequence + 1
  };
  
  logger.lock(`Lock ACQUIRED untuk Tim ${getTeamLetter(team)} pada ${now}`, {
    lockId: lockState.lockId,
    lockSequence: lockState.lockSequence,
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
    lockId: null,
    lockSequence: lockState.lockSequence // Pertahankan sequence
  };
  logger.lock(`Lock RELEASED (previous active: ${previousActive ? getTeamLetter(previousActive) : 'none'})`);
}

// ===== WEBSOCKET HANDLER UNTUK ESP32 =====
wss.on('connection', function connection(ws, req) {
  const clientIP = req.socket.remoteAddress;
  const socketId = `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  logger.websocket(`ESP32 connected: ${socketId} from ${clientIP}`);
  
  // Simpan koneksi ESP32
  esp32WebSocket = ws;
  esp32WebSocketId = socketId;
  lastESP32Heartbeat = Date.now();
  
  // Update ESP32 status
  esp32Status.connected = true;
  esp32Status.lastActivity = new Date();
  esp32Status.socketId = socketId;
  esp32Status.ip = clientIP;
  esp32Status.connectionType = "websocket";
  
  // PERBAIKAN: Kirim status ke semua client Socket.IO termasuk admin
  io.emit("esp32Status", esp32Status);
  
  // Send welcome message
  const welcomeMsg = Buffer.from([
    0x05, // MSG_SYSTEM_STATUS
    0x01, // Connected
    0x0C, // 12 teams
    0x04, // 4 modules
    config.timerDuration, // Timer duration
    lockState.locked ? lockState.activeTeam : 0x00, // Active team if locked
    0x00, // Reserved
    0x00  // Reserved
  ]);
  
  ws.send(welcomeMsg);
  
  // Send current configuration
  sendConfigToESP32();
  
  // Send current lock state
  sendLockStateToESP32();
  
  // Send all scores
  for (let i = 1; i <= TEAM_COUNT; i++) {
    sendScoreUpdateToESP32(i, scores[i-1]);
  }
  
  // Handle incoming binary messages
  ws.on('message', function message(data) {
    lastESP32Heartbeat = Date.now();
    
    if (data instanceof Buffer) {
      handleESP32BinaryMessage(data, socketId, clientIP);
    } else {
      logger.websocket(`Received non-binary message: ${data}`);
    }
  });
  
  ws.on('error', function error(err) {
    logger.error(`WebSocket error from ${socketId}:`, err);
  });
  
  ws.on('close', function close() {
    logger.websocket(`ESP32 disconnected: ${socketId}`);
    
    // PERBAIKAN: Reset ESP32 status termasuk wifiRSSI
    esp32WebSocket = null;
    esp32WebSocketId = null;
    
    esp32Status.connected = false;
    esp32Status.connectionType = "websocket_disconnected";
    esp32Status.wifiRSSI = null;  // PERBAIKAN: Reset wifiRSSI ke null
    esp32Status.modulesDetected = 0;
    esp32Status.activeTeams = 0;
    
    // PERBAIKAN: Kirim update ke semua client
    io.emit("esp32Status", esp32Status);
    
    logger.esp32(`ESP32 WebSocket disconnected: ${socketId}`);
  });
});

// ===== HANDLE ESP32 BINARY MESSAGES =====
function handleESP32BinaryMessage(buffer, socketId, clientIP) {
  if (buffer.length < 1) return;
  
  const msgType = buffer[0];
  
  switch(msgType) {
    case 0x01: // MSG_BUTTON_PRESS
      handleESP32ButtonPress(buffer, socketId, clientIP);
      break;
      
    case 0x02: // MSG_HEARTBEAT
      handleESP32Heartbeat(buffer, socketId, clientIP);
      break;
      
    case 0x03: // MSG_MODULE_STATUS
      handleESP32ModuleStatus(buffer, socketId, clientIP);
      break;
      
    case 0x04: // MSG_JURY_ACTION
      handleESP32JuryAction(buffer, socketId, clientIP);
      break;
      
    case 0x05: // MSG_SYSTEM_STATUS
      // Just acknowledge
      logger.esp32(`ESP32 system status received from ${socketId}`);
      break;
      
    default:
      logger.websocket(`Unknown message type: 0x${msgType.toString(16).padStart(2, '0')}`);
  }
}

// ===== HANDLE ESP32 BUTTON PRESS =====
function handleESP32ButtonPress(buffer, socketId, clientIP) {
  if (buffer.length < 14) return;
  
  const team = buffer[1];
  const timestamp = (buffer[2] << 24) | (buffer[3] << 16) | (buffer[4] << 8) | buffer[5];
  const sequence = (buffer[6] << 8) | buffer[7];
  const modulesDetected = buffer[8];
  const activeTeams = buffer[9];
  const rssi = (buffer[10] << 8) | buffer[11];
  
  // PERBAIKAN: Validasi RSSI - hanya terima jika negatif (WiFi valid)
  let validatedRSSI = null;
  if (rssi !== 0 && rssi !== 65535) { // 65535 = -1 dalam signed 16-bit
    const signedRSSI = rssi > 32767 ? rssi - 65536 : rssi;
    if (signedRSSI < 0) { // WiFi RSSI harus negatif
      validatedRSSI = signedRSSI;
    }
  }
  
  // Update ESP32 status
  esp32Status.modulesDetected = modulesDetected;
  esp32Status.activeTeams = activeTeams;
  esp32Status.wifiRSSI = validatedRSSI; // PERBAIKAN: Gunakan RSSI yang divalidasi
  esp32Status.lastActivity = new Date();
  esp32Status.lastHeartbeat = new Date();
  esp32Status.heartbeatCount++;
  
  logger.esp32(`ESP32 button press: Team ${team}, Seq ${sequence}`, {
    timestamp: timestamp,
    modules: modulesDetected,
    teams: activeTeams,
    rssiRaw: rssi,
    rssiValidated: validatedRSSI,
    socketId: socketId
  });
  
  // Cek jika tim diaktifkan
  if (!teamToggleState[team - 1]) {
    logger.info(`ESP32: Team ${getTeamLetter(team)} is disabled, ignoring press`);
    
    // Kirim MSG_LOCK_DENIED ke ESP32
    const deniedMsg = Buffer.from([
      0x82, // MSG_LOCK_DENIED
      team,
      0xE1, // ERR_TEAM_DISABLED
      lockState.activeTeam || 0x00,
      0x00, // Reserved
      0x00, // Reserved
      0x00, // Reserved
      0x00  // Reserved
    ]);
    
    if (esp32WebSocket) {
      esp32WebSocket.send(deniedMsg);
    }
    
    return;
  }
  
  // Coba acquire lock atomic
  if (acquireAtomicLock(team)) {
    logger.lock(`ESP32: Lock acquired for Team ${getTeamLetter(team)}`);
    
    // Kirim MSG_LOCK_ACQUIRED ke ESP32
    const lockTimestamp = lockState.lockTime || Date.now();
    const lockSequence = lockState.lockSequence;
    
    const acquiredMsg = Buffer.from([
      0x81, // MSG_LOCK_ACQUIRED
      team,
      (lockTimestamp >> 24) & 0xFF,
      (lockTimestamp >> 16) & 0xFF,
      (lockTimestamp >> 8) & 0xFF,
      lockTimestamp & 0xFF,
      (lockSequence >> 8) & 0xFF,
      lockSequence & 0xFF,
      config.timerDuration
    ]);
    
    if (esp32WebSocket) {
      esp32WebSocket.send(acquiredMsg);
    }
    
    // PERBAIKAN PENTING: Kirim event buzz ke SEMUA client Socket.IO (termasuk admin)
    io.emit("buzz", { 
      team, 
      lockId: lockState.lockId,
      lockSequence: lockSequence,
      timestamp: lockTimestamp 
    });
    
    // Update lock state display ke SEMUA client
    io.emit("lockstate", lockState);
    
    // Mainkan buzzer dan audio tim
    playBuzzerThenTeamAudio(team);
    
  } else {
    // Kirim MSG_LOCK_DENIED ke ESP32
    const deniedMsg = Buffer.from([
      0x82, // MSG_LOCK_DENIED
      team,
      0xE3, // ERR_SYSTEM_LOCKED
      lockState.activeTeam || 0x00,
      0x00, // Reserved
      0x00, // Reserved
      0x00, // Reserved
      0x00  // Reserved
    ]);
    
    if (esp32WebSocket) {
      esp32WebSocket.send(deniedMsg);
    }
    
    logger.lock(`ESP32: Lock denied for Team ${getTeamLetter(team)} - system locked by Team ${getTeamLetter(lockState.activeTeam)}`);
  }
}

// ===== HANDLE ESP32 HEARTBEAT =====
function handleESP32Heartbeat(buffer, socketId, clientIP) {
  if (buffer.length < 16) return;
  
  const modulesDetected = buffer[1];
  const activeTeams = buffer[2];
  const rssi = (buffer[3] << 8) | buffer[4];
  const heap = (buffer[5] << 24) | (buffer[6] << 16) | (buffer[7] << 8) | buffer[8];
  const uptime = (buffer[9] << 24) | (buffer[10] << 16) | (buffer[11] << 8) | buffer[12];
  const lockStatus = buffer[13];
  const lockedTeam = buffer[14];
  
  // PERBAIKAN: Validasi RSSI - hanya terima jika negatif (WiFi valid)
  let validatedRSSI = null;
  if (rssi !== 0 && rssi !== 65535) { // 65535 = -1 dalam signed 16-bit
    const signedRSSI = rssi > 32767 ? rssi - 65536 : rssi;
    if (signedRSSI < 0) { // WiFi RSSI harus negatif
      validatedRSSI = signedRSSI;
    }
  }
  
  // Update ESP32 status
  esp32Status.modulesDetected = modulesDetected;
  esp32Status.activeTeams = activeTeams;
  esp32Status.wifiRSSI = validatedRSSI; // PERBAIKAN: Gunakan RSSI yang divalidasi
  esp32Status.lastActivity = new Date();
  esp32Status.lastHeartbeat = new Date();
  esp32Status.heartbeatCount++;
  
  // PERBAIKAN: Update semua client
  io.emit("esp32Status", esp32Status);
  
  // Jika lock status tidak sync, kirim update
  if (lockState.locked !== (lockStatus === 1) || 
      lockState.activeTeam !== lockedTeam) {
    sendLockStateToESP32();
  }
  
  logger.esp32(`ESP32 heartbeat received`, {
    modules: modulesDetected,
    teams: activeTeams,
    rssiRaw: rssi,
    rssiValidated: validatedRSSI,
    heap: heap,
    uptime: uptime,
    lockStatus: lockStatus,
    lockedTeam: lockedTeam
  });
}

// ===== HANDLE ESP32 MODULE STATUS =====
function handleESP32ModuleStatus(buffer, socketId, clientIP) {
  if (buffer.length < 3) return;
  
  const modulesDetected = buffer[1];
  const activeTeams = buffer[2];
  
  esp32Status.modulesDetected = modulesDetected;
  esp32Status.activeTeams = activeTeams;
  esp32Status.lastActivity = new Date();
  
  logger.esp32(`ESP32 module status update`, {
    modules: modulesDetected,
    teams: activeTeams
  });
  
  io.emit("esp32Status", esp32Status);
}

// ===== HANDLE ESP32 JURY ACTION =====
function handleESP32JuryAction(buffer, socketId, clientIP) {
  if (buffer.length < 9) return;
  
  const team = buffer[1];
  const isCorrect = buffer[2] === 1;
  
  // PERBAIKAN: Baca sebagai signed 16-bit integer untuk nilai minus
  const rawPoints = (buffer[3] << 8) | buffer[4];
  // Konversi ke signed 16-bit
  const points = rawPoints > 32767 ? rawPoints - 65536 : rawPoints;
  
  const timestamp = (buffer[5] << 24) | (buffer[6] << 16) | (buffer[7] << 8) | buffer[8];
  
  logger.esp32(`ESP32 jury action: Team ${team}, ${isCorrect ? 'Correct' : 'Wrong'}, ${points} points`, {
    rawBytes: [buffer[3], buffer[4]],
    rawValue: rawPoints,
    calculatedPoints: points,
    bufferLength: buffer.length
  });
  
  // Update score
  scores[team - 1] += points;
  
  // SIMPAN KE FILE
  saveScoresOnly();
  
  // PERBAIKAN: Kirim update ke SEMUA client
  io.emit("update", { team, score: scores[team - 1] });
  io.emit("scoring", { team, isCorrect });
  
  // Mainkan audio juri ke SEMUA client
  timerAudio.playJuryAudio(isCorrect);
  
  // Berikan feedback ke SEMUA client
  const feedbackMessage = generateFeedbackMessage(team, isCorrect, points);
  io.emit("aiMessage", {
    message: feedbackMessage,
    type: isCorrect ? "success" : "penalty",
    shouldSpeak: false
  });
  
  // Release lock dan reset timer
  releaseAtomicLock();
  resetTimer();
  
  // Kirim update ke ESP32
  sendLockStateToESP32();
  sendScoreUpdateToESP32(team, scores[team - 1]);
  
  // PERBAIKAN: Kirim lockstate update ke SEMUA client
  io.emit("lockstate", lockState);
}

// ===== SEND CONFIG TO ESP32 =====
function sendConfigToESP32() {
  if (!esp32WebSocket) {
    logger.websocket("ESP32 WebSocket tidak terhubung, tidak bisa kirim config");
    return;
  }
  
  // PERBAIKAN: Konversi nilai minus ke byte dengan benar dan tambah logging
  const minusByte = config.minus < 0 ? (256 + config.minus) : config.minus;
  
  // Debug logging
  logger.websocket(`Sending config to ESP32: plus=${config.plus}, minus=${config.minus} (byte: ${minusByte})`, {
    minusOriginal: config.minus,
    minusAsByte: minusByte,
    minusHex: minusByte.toString(16).toUpperCase()
  });
  
  const configMsg = Buffer.from([
    0x86, // MSG_CONFIG_UPDATE
    config.plus,
    minusByte,
    config.timerDuration,
    isAutoPenaltyEnabled ? 0x01 : 0x00,
    0x00, // Reserved
    0x00  // Reserved
  ]);
  
  esp32WebSocket.send(configMsg);
  logger.websocket("Configuration sent to ESP32");
}

// ===== SEND LOCK STATE TO ESP32 =====
function sendLockStateToESP32() {
  if (!esp32WebSocket) return;
  
  if (lockState.locked) {
    const lockTimestamp = lockState.lockTime || Date.now();
    const lockSequence = lockState.lockSequence;
    
    const lockMsg = Buffer.from([
      0x81, // MSG_LOCK_ACQUIRED
      lockState.activeTeam,
      (lockTimestamp >> 24) & 0xFF,
      (lockTimestamp >> 16) & 0xFF,
      (lockTimestamp >> 8) & 0xFF,
      lockTimestamp & 0xFF,
      (lockSequence >> 8) & 0xFF,
      lockSequence & 0xFF,
      config.timerDuration
    ]);
    
    esp32WebSocket.send(lockMsg);
    logger.websocket(`Lock state sent to ESP32: Team ${getTeamLetter(lockState.activeTeam)} acquired`);
  } else {
    const unlockMsg = Buffer.from([
      0x83, // MSG_LOCK_RELEASED
      0x00, // Reason
      0x00, // Reserved
      0x00, // Reserved
      0x00, // Reserved
      0x00, // Reserved
      0x00, // Reserved
      0x00  // Reserved
    ]);
    
    esp32WebSocket.send(unlockMsg);
    logger.websocket("Lock released sent to ESP32");
  }
}

// ===== SEND FORCE UNLOCK TO ESP32 =====
function sendForceUnlockToESP32() {
  if (!esp32WebSocket) return;
  
  const forceUnlockMsg = Buffer.from([
    0x85, // MSG_FORCE_UNLOCK
    0x00, // Reason
    0x00, // Reserved
    0x00, // Reserved
    0x00, // Reserved
    0x00, // Reserved
    0x00, // Reserved
    0x00  // Reserved
  ]);
  
  esp32WebSocket.send(forceUnlockMsg);
  logger.websocket("Force unlock command sent to ESP32");
}

// ===== SEND SCORE UPDATE TO ESP32 =====
function sendScoreUpdateToESP32(team, score) {
  if (!esp32WebSocket) return;
  
  const scoreMsg = Buffer.from([
    0x88, // MSG_SCORE_UPDATE
    team,
    (score >> 24) & 0xFF,
    (score >> 16) & 0xFF,
    (score >> 8) & 0xFF,
    score & 0xFF,
    0x00, // Reserved
    0x00  // Reserved
  ]);
  
  esp32WebSocket.send(scoreMsg);
  logger.websocket(`Score update sent to ESP32: Team ${getTeamLetter(team)} = ${score}`);
}

// ===== MONITOR ESP32 WEBSOCKET CONNECTION =====
function monitorESP32WebSocket() {
  const now = Date.now();
  
  if (esp32WebSocket && lastESP32Heartbeat) {
    const timeSinceHeartbeat = now - lastESP32Heartbeat;
    
    if (timeSinceHeartbeat > 30000) { // 30 seconds timeout
      logger.esp32("ESP32 WebSocket heartbeat timeout", {
        lastHeartbeat: lastESP32Heartbeat,
        secondsSince: Math.floor(timeSinceHeartbeat / 1000)
      });
      
      // Close the connection
      try {
        esp32WebSocket.close();
      } catch (err) {
        logger.error("Error closing ESP32 WebSocket:", err);
      }
      
      esp32WebSocket = null;
      esp32WebSocketId = null;
      
      esp32Status.connected = false;
      esp32Status.connectionType = "websocket_timeout";
      esp32Status.wifiRSSI = null;  // PERBAIKAN: Reset wifiRSSI
      
      // PERBAIKAN: Update semua client
      io.emit("esp32Status", esp32Status);
    }
  }
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
  
  // SIMPAN KE FILE
  saveScoresOnly();
  
  // PERBAIKAN: Kirim update ke SEMUA client
  io.emit("update", { team: activeTeam, score: scores[activeTeam - 1] });
  io.emit("scoring", { team: activeTeam, isCorrect: false });
  
  const previousActiveTeam = lockState.activeTeam;
  releaseAtomicLock();
  
  isTimerRunning = false;
  timeRemaining = 0;
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  // PERBAIKAN: Kirim event ke SEMUA client
  io.emit("lockstate", lockState);
  io.emit("timerReset", { reason: "auto_penalty_applied" });
  io.emit("systemUnlocked", { reason: "auto_penalty_applied" });
  
  // Kirim ke ESP32
  sendLockStateToESP32();
  sendScoreUpdateToESP32(activeTeam, scores[activeTeam - 1]);
  
  const feedbackMessage = `Waktu habis! Tim ${getTeamLetter(activeTeam)} tidak menjawab, dikurangi ${Math.abs(penaltyPoints)} poin!`;
  
  io.emit("aiMessage", {
    message: feedbackMessage,
    type: "warning",
    shouldSpeak: false
  });
  
  logger.info(`AUTO PENALTI: Tim ${getTeamLetter(activeTeam)} -${Math.abs(penaltyPoints)} poin`, {
    poinPenalti: penaltyPoints,
    skorSebelum: previousScore,
    skorSekarang: scores[activeTeam - 1]
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
    releaseAtomicLock();
    
    // Kirim ke ESP32
    sendLockStateToESP32();
    
    // PERBAIKAN: Kirim ke SEMUA client
    io.emit("lockstate", lockState);
    io.emit("timerReset", { reason: "timer_expired" });
    io.emit("systemUnlocked", { 
      reason: "timer_expired",
      previousActiveTeam: previousActiveTeam 
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

// ===== UPDATE ESP32 STATUS DARI HTTP =====
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
  
  // PERBAIKAN: Validasi RSSI dari HTTP
  if (data.rssi !== undefined && data.rssi !== null) {
    if (data.rssi < 0) { // Hanya terima nilai negatif untuk RSSI WiFi
      esp32Status.wifiRSSI = data.rssi;
    } else {
      esp32Status.wifiRSSI = null;
    }
  }
  
  // Update heartbeat count jika ada
  if (data.count !== undefined && data.count !== null) {
    esp32Status.heartbeatCount = data.count;
    esp32Status.lastHeartbeat = new Date();
  }
  
  // PERBAIKAN: Update semua client
  io.emit("esp32Status", esp32Status);
  
  logger.esp32(`ESP32 update: ${activityType}`, {
    ip: ip,
    modules: esp32Status.modulesDetected,
    teams: esp32Status.activeTeams,
    rssi: esp32Status.wifiRSSI,
    heartbeatCount: esp32Status.heartbeatCount
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
        secondsInactive: Math.floor(timeSinceLastActivity / 1000)
      });
      
      esp32Status.connected = false;
      esp32Status.connectionType = "timeout";
      esp32Status.wifiRSSI = null;  // PERBAIKAN: Reset wifiRSSI saat timeout
      
      // PERBAIKAN: Update semua client
      io.emit("esp32Status", esp32Status);
    }
  }
}

// ===== SISTEM TIMER =====
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

  // PERBAIKAN: Kirim ke SEMUA client
  io.emit("timerStart", { 
    duration: config.timerDuration,
    lockId: lockState.lockId,
    lockSequence: lockState.lockSequence
  });
  lastTimerEvent = 'timerStart';
  
  logger.performance("Timer dimulai", { 
    waktuTersisa: timeRemaining, 
    timAktif: currentActiveTeam,
    hurufTim: getTeamLetter(currentActiveTeam)
  });

  timerInterval = setInterval(() => {
    timeRemaining--;
    
    // PERBAIKAN: Kirim ke SEMUA client
    io.emit("timerUpdate", { 
      timeRemaining,
      lockId: lockState.lockId,
      lockSequence: lockState.lockSequence
    });
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
  
  if (lockState.locked) {
    releaseAtomicLock();
  }
  
  // PERBAIKAN: Kirim ke SEMUA client
  io.emit("timerReset", {
    lockId: lockState.lockId,
    lockSequence: lockState.lockSequence
  });
  io.emit("lockstate", lockState);
  
  // Kirim ke ESP32
  sendLockStateToESP32();
  
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
  
  // PERBAIKAN: Kirim ke SEMUA client
  io.emit("timerReset", {
    lockId: lockState.lockId,
    lockSequence: lockState.lockSequence
  });
  io.emit("lockstate", lockState);
  
  // Kirim ke ESP32
  sendLockStateToESP32();
  
  lastTimerEvent = 'timerReset';
  
  lockState.lockTime = null;
  
  logger.performance("Timer direset manual", {
    lockState: lockState
  });
}

// ===== FUNGSI BUKA KUNSI PAKSA =====
function forceUnlockSystem() {
  logger.info("BUKA KUNCI PAKSA: Buka kunci manual atau darurat");
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  isTimerRunning = false;
  timeRemaining = 0;
  
  releaseAtomicLock();
  
  // Kirim ke ESP32 via WebSocket
  sendForceUnlockToESP32();
  
  // PERBAIKAN: Kirim ke SEMUA client
  io.emit("lockstate", lockState);
  io.emit("timerReset", {
    lockId: lockState.lockId,
    lockSequence: lockState.lockSequence
  });
  io.emit("systemUnlocked", { reason: "buka_kunci_manual" });
  
  logger.performance("Sistem dibuka paksa");
}

// ===== MEMUTAR AUDIO BUZZER DAN TIM =====
function playBuzzerThenTeamAudio(team) {
  logger.audio(`Memulai urutan audio buzzer untuk Tim ${getTeamLetter(team)}`);
  
  const buzzerPlayed = timerAudio.playPreTeamAudio(team);
  
  // Timer tidak dimulai di sini, akan dimulai setelah buzzer selesai (di preTeamAudioFinished)
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
  
  // PERBAIKAN: Kirim timerReset ke semua client meskipun sistem terkunci
  io.emit("timerReset", {
    lockId: lockState.lockId,
    lockSequence: lockState.lockSequence
  });
  
  lastTimerEvent = 'timerReset';
  
  logger.performance("Timer direset (hanya timer)", {
    lockState: lockState
  });
}

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
    serverTime: new Date().toLocaleTimeString('id-ID')
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
    timestamp: Date.now(),
    serverTime: new Date().toLocaleTimeString('id-ID')
  };
  
  res.setHeader('Content-Type', 'application/json');
  res.json(response);
});

// ===== ENDPOINT: GET TIMER STATUS =====
app.get("/timerstatus", (req, res) => {
  const response = {
    timerRunning: isTimerRunning,
    timeRemaining: timeRemaining,
    lockState: lockState,
    config: config
  };
  
  res.json(response);
});

// ===== ENDPOINT: FORCE TIMER SYNC =====
app.get("/synctimer", (req, res) => {
  const action = req.query.action || 'status';
  
  let response = {
    success: true,
    message: "Timer status",
    timer: {
      isRunning: isTimerRunning,
      remaining: timeRemaining
    },
    lock: lockState
  };
  
  if (action === 'stop') {
    stopTimer();
    response.message = "Timer stopped manually";
  } else if (action === 'reset') {
    resetTimer();
    response.message = "Timer reset manually";
  }
  
  console.log(`[SYNCTIMER] ${action} request:`, response);
  res.json(response);
});

// ===== ENDPOINT UPDATE =====
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
    if (!acquireAtomicLock(team)) {
      const lockAge = Date.now() - (lockState.lockTime || Date.now());
      const currentTeam = lockState.activeTeam;
      
      logger.lock(`Request DITOLAK: Tim ${getTeamLetter(team)} - sistem sudah terkunci oleh Tim ${getTeamLetter(currentTeam)} (${lockAge}ms yang lalu)`);
      
      return res.status(403).json({ 
        error: "Tombol terkunci",
        lockedBy: currentTeam,
        lockAge: `${lockAge}ms`,
        message: `Tim ${getTeamLetter(currentTeam)} lebih cepat ${lockAge}ms`,
        responseTime: `${Date.now() - startTime}ms`
      });
    }
    
    logger.lock(`Request DITERIMA: Tim ${getTeamLetter(team)} berhasil terkunci`);
    
    // PERBAIKAN: Kirim ke SEMUA client
    io.emit("lockstate", lockState);
    io.emit("buzz", { 
      team,
      lockId: lockState.lockId,
      lockSequence: lockState.lockSequence
    });
    
    // Kirim ke ESP32
    sendLockStateToESP32();
    
    playBuzzerThenTeamAudio(team);
  }

  if (add !== 0) {
    logger.info(`Scoring: Team ${team} add ${add} points`);
    scores[team - 1] += add;
    
    // SIMPAN KE FILE
    saveScoresOnly();
    
    // PERBAIKAN: Kirim ke SEMUA client
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
    
    // Kirim ke ESP32
    sendLockStateToESP32();
    sendScoreUpdateToESP32(team, scores[team - 1]);
    
    io.emit("lockstate", lockState);
  }

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
    lockId: lockState.lockId,
    lockSequence: lockState.lockSequence
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
  
  // PERBAIKAN: Kirim ke SEMUA client
  io.emit("timerReset", {
    lockId: lockState.lockId,
    lockSequence: lockState.lockSequence
  });
  io.emit("lockstate", lockState);
  io.emit("systemUnlocked", { reason: "debug_perbaikan" });
  
  // Kirim ke ESP32
  sendLockStateToESP32();
  
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
  
  releaseAtomicLock();
  
  lockState = { 
    locked: false, 
    activeTeam: null,
    lockTime: null,
    lockId: null,
    lockSequence: lockState.lockSequence
  };
  
  // Kirim ke ESP32
  sendForceUnlockToESP32();
  
  // PERBAIKAN: Kirim ke SEMUA client
  io.emit("lockstate", lockState);
  io.emit("timerReset", {
    lockId: lockState.lockId,
    lockSequence: lockState.lockSequence
  });
  io.emit("systemUnlocked", { reason: "force_unlock_all" });
  
  res.json({
    sukses: true,
    pesan: "Semua kunci dibuka paksa",
    lockState: lockState,
    timerRunning: isTimerRunning
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
    serverTime: new Date().toLocaleTimeString('id-ID')
  });
});

// ===== ENDPOINT: DEBUG MONITORING =====
app.get("/debug/monitoring", (req, res) => {
  res.json({
    esp32Status: esp32Status,
    lastUpdate: new Date().toLocaleTimeString('id-ID'),
    fields: {
      modulesDetected: esp32Status.modulesDetected,
      activeTeams: esp32Status.activeTeams,
      wifiRSSI: esp32Status.wifiRSSI
    }
  });
});

// ===== ENDPOINT BARU: TEST CONFIG DEBUG =====
app.get("/test/config", (req, res) => {
  res.json({
    serverConfig: config,
    esp32WebSocketConnected: !!esp32WebSocket,
    lastConfigSent: new Date().toISOString(),
    testData: {
      plusAsByte: config.plus,
      minusAsByte: config.minus < 0 ? (256 + config.minus) : config.minus,
      minusOriginal: config.minus,
      minusHex: (config.minus < 0 ? (256 + config.minus) : config.minus).toString(16).toUpperCase(),
      signedInterpretation: config.minus < 0 ? `Negative: ${config.minus}` : `Positive: ${config.minus}`
    },
    currentState: {
      lockState: lockState,
      isTimerRunning: isTimerRunning,
      timeRemaining: timeRemaining,
      scores: scores
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
    versi: "2.0.0",
    lingkungan: isProduction ? "produksi" : "pengembangan",
    siap: true,
    websocket_port: WS_PORT,
    websocket_path: "/esp32ws"
  });
});

// ===== ENDPOINT BARU: EDIT SCORE MANUAL =====
app.get("/editScore", (req, res) => {
  const team = parseInt(req.query.team);
  const score = parseInt(req.query.score);
  
  if (!Number.isInteger(team) || team < 1 || team > TEAM_COUNT) {
    return res.status(400).json({ 
      success: false, 
      message: "Tim tidak valid" 
    });
  }
  
  if (isNaN(score) || score < -999 || score > 999) {
    return res.status(400).json({ 
      success: false, 
      message: "Skor harus antara -999 dan 999" 
    });
  }
  
  // Update score
  scores[team - 1] = score;
  
  // SIMPAN KE FILE
  saveScoresOnly();
  
  // PERBAIKAN: Broadcast ke SEMUA client
  io.emit("update", { team, score: score });
  
  // Kirim ke ESP32 jika terhubung
  sendScoreUpdateToESP32(team, score);
  
  logger.info(`Score manually edited: Team ${getTeamLetter(team)} = ${score}`);
  
  res.json({ 
    success: true, 
    message: `Skor Tim ${getTeamLetter(team)} diubah menjadi ${score}`,
    team: team,
    score: score
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
  
  // Simpan ke file
  savePersistedState();
  
  logger.info(`Team ${getTeamLetter(team)} ${enabled ? 'enabled' : 'disabled'}`, {
    team: team,
    enabled: enabled,
    currentState: teamToggleState
  });
  
  // PERBAIKAN: Kirim ke SEMUA client
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
  
  // Simpan ke file
  savePersistedState();
  
  logger.info("All teams enabled");
  
  // PERBAIKAN: Kirim ke SEMUA client
  io.emit("allTeamsEnabled");
  
  res.json({ 
    sukses: true, 
    pesan: "Semua tim diaktifkan",
    statusToggleTim: teamToggleState
  });
});

app.get("/disableAllTeams", (req, res) => {
  teamToggleState = Array(TEAM_COUNT).fill(false);
  
  // Simpan ke file
  savePersistedState();
  
  logger.info("All teams disabled");
  
  // PERBAIKAN: Kirim ke SEMUA client
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

// ===== ENDPOINT: ESP32 ACTIVITY =====
app.get("/esp32activity", (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const activityType = req.query.type || 'activity';
  const team = req.query.team;
  
  updateESP32FromHTTP(ip, `http_${activityType}_team${team}`);
  
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
    sinyalWiFi: esp32Status.wifiRSSI || null
  });
});

// ===== ROUTE UNTUK KONTROL PENALTI OTOMATIS =====
app.get("/toggleAutoPenalty", (req, res) => {
  const enabled = req.query.enabled === 'true';
  isAutoPenaltyEnabled = enabled;
  
  // Simpan ke file
  savePersistedState();
  
  // Kirim konfigurasi ke ESP32
  sendConfigToESP32();
  
  // PERBAIKAN: Kirim ke SEMUA client
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
    
    // PERBAIKAN: Kirim ke SEMUA client
    io.emit("playTeamAudio", {
      team: team,
      audioFile: teamAudioFile,
      timerDuration: config.timerDuration
    });
  }
  
  res.json({ 
    sukses: true, 
    pesan: "Audio buzzer selesai, audio tim dan timer dimulai",
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
  
  // Kirim ke ESP32
  sendLockStateToESP32();
  
  // PERBAIKAN: Kirim ke SEMUA client
  io.emit("lockstate", lockState);
  
  res.json({ sukses: true, pesan: "Sistem dibuka dan timer direset", statusKunci: lockState });
});

// ===== PERBAIKAN ENDPOINT: SETCONFIG DENGAN VALIDASI =====
app.get("/setconfig", (req, res) => {
  let plus = parseInt(req.query.plus);
  let minus = parseInt(req.query.minus);
  const timerDuration = parseInt(req.query.timerDuration);
  
  // PERBAIKAN: Validasi input dan pastikan minus tetap negatif
  if (!Number.isNaN(plus) && plus > 0) {
    config.plus = plus;
    logger.info(`Config updated: plus points = ${plus}`);
  }
  
  if (!Number.isNaN(minus) && minus < 0) {
    config.minus = minus;
    logger.info(`Config updated: minus points = ${minus} (negatif)`);
  } else if (!Number.isNaN(minus)) {
    logger.warning(`Invalid minus value: ${minus}. Must be negative. Keeping previous value: ${config.minus}`);
  }
  
  if (!Number.isNaN(timerDuration) && timerDuration >= 5 && timerDuration <= 300) {
    config.timerDuration = timerDuration;
    logger.info(`Config updated: timer duration = ${timerDuration} seconds`);
  }
  
  // Simpan ke file
  savePersistedState();
  
  // Debug logging
  logger.websocket(`Updated config: ${JSON.stringify(config)}`, {
    rawInput: { plus, minus, timerDuration },
    finalConfig: config
  });
  
  // Kirim ke ESP32 via WebSocket
  sendConfigToESP32();
  
  // PERBAIKAN: Kirim ke SEMUA client
  io.emit("config", config);
  io.emit("autoPenaltyConfig", { 
    diaktifkan: isAutoPenaltyEnabled,
    poinPenalti: config.minus 
  });
  
  res.json({ sukses: true, konfigurasi: config });
});

// ===== ENDPOINT: RESET SEMUA SKOR =====
app.get("/reset", (req, res) => {
  // Reset semua skor ke 0
  scores = Array(TEAM_COUNT).fill(0);
  
  // Simpan state kosong ke file
  saveScoresOnly();
  
  resetTimer();
  releaseAtomicLock();
  
  // Kirim semua scores ke ESP32
  if (esp32WebSocket) {
    for (let i = 1; i <= TEAM_COUNT; i++) {
      sendScoreUpdateToESP32(i, 0);
    }
  }
  
  // PERBAIKAN: Kirim ke SEMUA client
  io.emit("reset", scores);
  io.emit("lockstate", lockState);
  
  logger.info('All scores reset and saved to file');
  
  res.json({ 
    sukses: true, 
    pesan: "Skor direset dan timer direset", 
    skor: scores 
  });
});

app.get("/scores", (req, res) => {
  // Selalu kembalikan skor dari memori
  res.json({
    scores: scores,
    timestamp: new Date().toISOString(),
    persisted: fs.existsSync(STATE_FILE)
  });
});

app.get("/lockstate", (req, res) => {
  res.json(lockState);
});

app.get("/config", (req, res) => {
  res.json(config);
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
      sinyalWiFi: esp32Status.wifiRSSI
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
  
  // Kirim ke ESP32
  sendLockStateToESP32();
  
  // PERBAIKAN: Kirim ke SEMUA client
  io.emit("lockstate", lockState);
  io.emit("timerReset", {
    lockId: lockState.lockId,
    lockSequence: lockState.lockSequence
  });
  
  res.json({ 
    success: true, 
    message: "Lock manually reset",
    lockState: lockState 
  });
});

// ===== ENDPOINT DEBUG STATE =====
app.get("/debug/state", (req, res) => {
  res.json({
    fileExists: fs.existsSync(STATE_FILE),
    scores: scores,
    config: config,
    teamToggleState: teamToggleState,
    autoPenaltyEnabled: isAutoPenaltyEnabled,
    stateFile: STATE_FILE
  });
});

app.get("/debug/forceSave", (req, res) => {
  const saved = saveScoresOnly();
  res.json({
    success: saved,
    message: saved ? "State saved successfully" : "Failed to save state",
    scores: scores
  });
});

app.get("/debug/clearState", (req, res) => {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
      scores = Array(TEAM_COUNT).fill(0);
      res.json({
        success: true,
        message: "State file deleted and scores reset"
      });
    } else {
      res.json({
        success: false,
        message: "State file does not exist"
      });
    }
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
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
    websocket_connected: !!esp32WebSocket,
    lingkungan: isProduction ? "produksi" : "pengembangan",
    state_persisted: fs.existsSync(STATE_FILE)
  });
});

// ===== ENDPOINT: FULL STATE SYNC =====
app.get("/fullstate", (req, res) => {
  const fullState = {
    success: true,
    scores: scores,
    lockState: lockState,
    timer: {
      isRunning: isTimerRunning,
      remaining: timeRemaining
    },
    config: config,
    esp32Status: esp32Status,
    teamToggleState: teamToggleState,
    autoPenaltyEnabled: isAutoPenaltyEnabled,
    checksum: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    state_persisted: fs.existsSync(STATE_FILE)
  };
  
  res.json(fullState);
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

// ===== SOCKET.IO HANDLERS =====
io.on("connection", (socket) => {
  const clientType = socket.handshake.query.clientType || 'unknown';
  const clientIP = socket.handshake.address;
  const userAgent = socket.handshake.headers['user-agent'] || 'unknown';
  
  // [FIX] Deteksi ESP32 hanya berdasarkan clientType yang dikirim saat koneksi,
  // BUKAN berdasarkan IP lokal. Sebelumnya browser admin dari laptop di jaringan lokal
  // (192.168.x.x, 10.x.x.x) bisa salah terdeteksi sebagai ESP32 sehingga
  // esp32Status.connected = true padahal tidak ada ESP32 yang terhubung.
  const isESP32 = clientType === 'esp32' ||
                  userAgent.toLowerCase().includes('esp32') ||
                  userAgent.toLowerCase().includes('arduino');

  logger.info(`New Socket.IO connection: ${socket.id}`, {
    ip: clientIP,
    userAgent: userAgent,
    isESP32: isESP32
  });

  if (isESP32) {
    esp32Status.connected = true;
    esp32Status.lastActivity = new Date();
    esp32Status.socketId = socket.id;
    esp32Status.ip = clientIP;
    esp32Status.connectionType = "koneksi_socket";
    
    // PERBAIKAN: Kirim ke SEMUA client
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
      
      esp32Status.lastActivity = new Date();
      io.emit("esp32Status", esp32Status);
    });
    
    socket.on("esp32Heartbeat", (data) => {
      esp32Status.lastActivity = new Date();
      io.emit("esp32Status", esp32Status);
    });
    
    socket.on("esp32Activity", (data) => {
      esp32Status.lastActivity = new Date();
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
    socket.emit("timerStart", { 
      duration: timeRemaining,
      lockId: lockState.lockId,
      lockSequence: lockState.lockSequence
    });
  }

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
      
      // PERBAIKAN: Kirim ke SEMUA client
      io.emit("playTeamAudio", {
        team: team,
        audioFile: teamAudioFile,
        timerDuration: config.timerDuration
      });
    }
  });

  // Event untuk force unlock via WebSocket
  socket.on("forceUnlockRequest", (data, callback) => {
    forceUnlockSystem();
    
    if (callback) {
      callback({ success: true, message: "Force unlock executed" });
    }
  });
  
  socket.on("requestStateRecovery", (data, callback) => {
    // Kirim semua state ke ESP32
    sendConfigToESP32();
    sendLockStateToESP32();
    
    // Kirim semua scores
    for (let i = 1; i <= TEAM_COUNT; i++) {
      sendScoreUpdateToESP32(i, scores[i-1]);
    }
    
    if (callback) {
      callback({ success: true, message: "State recovery sent to ESP32" });
    }
  });
  
  socket.on("fullStateSync", () => {
    const fullState = {
      success: true,
      scores: scores,
      lockState: lockState,
      timer: {
        isRunning: isTimerRunning,
        remaining: timeRemaining
      },
      config: config,
      esp32Status: esp32Status,
      teamToggleState: teamToggleState,
      autoPenaltyEnabled: isAutoPenaltyEnabled,
      checksum: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      state_persisted: fs.existsSync(STATE_FILE)
    };
    
    socket.emit("fullStateSync", fullState);
  });

  socket.on("disconnect", (reason) => {
    // [FIX] Sama seperti saat koneksi, gunakan clientType/userAgent bukan IP
    const wasESP32 = clientType === 'esp32' ||
                     userAgent.toLowerCase().includes('esp32') ||
                     userAgent.toLowerCase().includes('arduino');
                     
    if (wasESP32) {
      esp32Status.connected = false;
      esp32Status.connectionType = "socket_terputus";
      esp32Status.wifiRSSI = null;  // PERBAIKAN: Reset wifiRSSI saat disconnect
      io.emit("esp32Status", esp32Status);
    }
    
    logger.info(`Socket.IO disconnect: ${socket.id}`, { reason: reason, wasESP32: wasESP32 });
  });
});

// ===== MONITORING ESP32 =====
setInterval(checkESP32Status, 60000);
setInterval(monitorESP32WebSocket, 10000);

// ===== MEMULAI SERVER =====
async function startServer() {
  // Muat state yang tersimpan
  const stateLoaded = loadPersistedState();
  
  if (stateLoaded) {
    logger.info(`Persisted state loaded: ${scores.length} scores`);
  } else {
    // Inisialisasi dengan default
    scores = Array(TEAM_COUNT).fill(0);
    config = { plus: 5, minus: -2, timerDuration: 30 };
    teamToggleState = Array(TEAM_COUNT).fill(true);
    isAutoPenaltyEnabled = true;
  }
  
  validateAudioFiles();
  
  http.listen(PORT, async () => {
    console.log('========================================');
    console.log('SISTEM KUIS Ridwan and Team');
    console.log('========================================');
    console.log(`State Persistence: ${fs.existsSync(STATE_FILE) ? 'AKTIF' : 'BARU'}`);
    console.log(`Skor yang dimuat: ${scores.join(', ')}`);
    console.log(`Lingkungan: ${isProduction ? 'PRODUKSI' : 'PENGEMBANGAN'}`);
    console.log(`Socket.IO Server: http://localhost:${PORT}`);
    console.log(`WebSocket Server (ESP32): ws://localhost:${PORT}/esp32ws`);
    console.log(`Admin: http://localhost:${PORT}/admin.html`);
    console.log(`Display: http://localhost:${PORT}/index.html`);
    console.log(`State File: ${STATE_FILE}`);
    console.log('========================================');
  });
}

startServer();