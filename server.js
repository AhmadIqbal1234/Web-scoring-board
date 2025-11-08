﻿import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const http = createServer(app);
const io = new Server(http);

const PORT = process.env.PORT || 8080;
const TEAM_COUNT = 12;

let scores = Array(TEAM_COUNT).fill(0);
let config = { plus: 5, minus: -2, timerDuration: 30 };
let lockState = { locked: false, activeTeam: null };

let timerInterval = null;
let timeRemaining = 0;
let isTimerRunning = false;
let audioPlaying = false;
let audioFinishTimeout = null;

// 🆕 ESP32 Status Tracking - DIPERBAIKI
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

// 🎵 Audio System untuk Timer Countdown dan Juri
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
    
    // 🆕 Tambahkan audio untuk juri
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
      logger.audio(`Memutar countdown audio: ${audioFile}`);
    }
  }

  // 🆕 Method baru untuk memutar audio juri
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

// Validasi file audio - DIPERBAIKI PATH
function validateAudioFiles() {
  const audioDir = join(__dirname, "..", "public", "audio");
  const requiredFiles = [
    'Tim A.mp3', 'Tim B.mp3', 'Tim C.mp3', 'Tim D.mp3', 'Tim E.mp3', 'Tim F.mp3',
    'Tim G.mp3', 'Tim H.mp3', 'Tim I.mp3', 'Tim J.mp3', 'Tim K.mp3', 'Tim L.mp3',
    '30 detik.mp3', '20 detik.mp3', '10 detik.mp3', '5 detik.mp3', '4 detik.mp3',
    '3 detik.mp3', '2 detik.mp3', '1 detik.mp3', 'waktu habis.mp3',
    'benar.mp3', 'salah.mp3' // 🆕 TAMBAHKAN file audio juri
  ];
  
  logger.info("Validating audio files...");
  logger.info(`Audio directory: ${audioDir}`);
  
  let missingFiles = [];
  let foundFiles = [];
  
  requiredFiles.forEach(file => {
    const filePath = join(audioDir, file);
    if (fs.existsSync(filePath)) {
      foundFiles.push(file);
      logger.audio(`✅ Audio file found: ${file}`);
    } else {
      missingFiles.push(file);
      logger.error(`❌ Audio file missing: ${file}`);
    }
  });
  
  logger.info(`Audio validation result: ${foundFiles.length}/${requiredFiles.length} files found`);
  if (missingFiles.length > 0) {
    logger.error(`Missing files: ${missingFiles.join(', ')}`);
  }
}

// TIMER SYSTEM - IMPROVED DENGAN SAFETY MECHANISM
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

    // Audio countdown
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

// Start timer setelah audio selesai - IMPROVED DENGAN SAFETY TIMEOUT
function startTimerAfterAudio(team) {
  logger.info("Starting timer after audio finished", { team });
  
  // Safety timeout: jika setelah 5 detik belum ada konfirmasi audio selesai, start timer anyway
  audioFinishTimeout = setTimeout(() => {
    if (!isTimerRunning) {
      logger.info("SAFETY TIMEOUT: Starting timer after 5 seconds (audio might have failed)", { team });
      startTimer(team);
    }
  }, 5000);
  
  // Tunggu 500ms untuk memastikan audio benar-benar mulai di client
  setTimeout(() => {
    if (!isTimerRunning) {
      logger.info("Audio playback should have started, waiting for client confirmation...", { team });
    }
  }, 500);
}

// 🆕 Function untuk update ESP32 status dan broadcast - DIPERBAIKI
function updateESP32Status(connected, socket = null, ip = null) {
  esp32Connected = connected;
  
  if (connected && socket) {
    lastEsp32Activity = new Date();
    esp32SocketId = socket.id;
    esp32LastIP = ip;
    logger.esp32("✅ ESP32 Controller Connected", {
      socketId: socket.id,
      ip: ip,
      timestamp: lastEsp32Activity.toISOString()
    });
  } else if (!connected) {
    logger.esp32("❌ ESP32 Controller Disconnected", {
      socketId: esp32SocketId,
      timestamp: new Date().toISOString()
    });
  }
  
  // Broadcast status ke semua client admin
  io.emit("esp32Status", {
    connected: esp32Connected,
    lastActivity: lastEsp32Activity,
    socketId: esp32SocketId,
    ip: esp32LastIP
  });
}

// 🆕 Function untuk log aktivitas ESP32 - DIPERBAIKI
function logESP32Activity(activity, socket, ip = null) {
  lastEsp32Activity = new Date();
  logger.esp32("📡 ESP32 Activity", {
    activity: activity,
    socketId: socket.id,
    ip: ip,
    timestamp: lastEsp32Activity.toISOString()
  });
  
  // Broadcast aktivitas ke admin
  io.emit("esp32Activity", {
    activity: activity,
    timestamp: lastEsp32Activity,
    socketId: socket.id,
    ip: ip
  });
}

// 🆕 ROUTE UNTUK ESP32 CHECK-IN (HTTP Based) - SOLUSI BARU
app.get("/esp32checkin", (req, res) => {
  const action = req.query.action || 'heartbeat';
  const team = req.query.team;
  const ip = req.ip || req.connection.remoteAddress;
  
  // Update ESP32 status
  esp32Connected = true;
  lastEsp32Activity = new Date();
  esp32LastIP = ip;
  
  logger.esp32(`📞 ESP32 HTTP Check-in: ${action}`, {
    team: team,
    ip: ip,
    timestamp: lastEsp32Activity.toISOString()
  });
  
  // Broadcast ke semua admin
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

// ROUTES dengan Audio File System untuk tim dan timer - DIPERBAIKI PATH
app.use(express.static(join(__dirname, "..", "public")));
app.use('/audio', express.static(join(__dirname, "..", "public", "audio")));

app.get("/update", async (req, res) => {
  if (!req.query.team) {
    logger.error('Missing team parameter');
    return res.status(400).json({ error: "Parameter team diperlukan" });
  }

  const team = parseInt(req.query.team);
  const add = parseInt(req.query.add) || 0;
  const isFirst = req.query.first === "1";
  const ip = req.ip || req.connection.remoteAddress;

  logger.info('/update called', { team, add, isFirst, ip });

  // 🆕 LOG ACTIVITY JIKA DARI ESP32
  if (ip.includes('192.168.1.14') || ip.includes('192.168.1.')) { // Adjust IP range sesuai jaringan ESP32
    logESP32Activity({
      type: "buzzer",
      team: team,
      action: isFirst ? "first_press" : "scoring",
      points: add
    }, { id: "HTTP_CONNECTION" }, ip);
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
    
    const audioFile = getTeamAudioFile(team);
    
    // Kirim event untuk memutar audio tim
    io.emit("playTeamAudio", {
      team: team,
      audioFile: audioFile,
      timerDuration: config.timerDuration
    });
    
    logger.audio(`Memutar "${audioFile}" - Timer akan mulai setelah audio selesai`);
    
    // Start safety mechanism untuk timer
    startTimerAfterAudio(team);
  }

  if (add !== 0) {
    scores[team - 1] += add;
    io.emit("update", { team, score: scores[team - 1] });
    io.emit("scoring", { team, isCorrect: add > 0 });
    
    // 🆕 TAMBAHKAN: Putar audio juri berdasarkan benar/salah
    timerAudio.playJuryAudio(add > 0);
    
    // Feedback message tanpa TTS
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

// Route untuk client memberi tahu audio selesai - IMPROVED
app.get("/audioFinished", (req, res) => {
  const action = req.query.action;
  const team = parseInt(req.query.team);
  const audioType = req.query.type || 'team';
  
  logger.info("Audio finished callback received", { action, team, audioType });
  
  // Clear safety timeout karena audio sudah selesai
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

// Route untuk trigger audio manual (testing)
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

// Route untuk unlock manual
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

// 🆕 Route untuk status ESP32 - DIPERBAIKI
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
    connections: io.engine.clientsCount,
    services: {
      audio: "Audio File System - File per Tim & Timer Countdown & Juri",
      timer: "START AFTER AUDIO - Timer mulai setelah audio selesai",
      esp32: "ESP32 Master Controller with Buzzer & LED System",
      safety: "5-second safety timeout implemented",
      jury: "Audio feedback untuk tombol juri (benar/salah)",
      tracking: "ESP32 HTTP Heartbeat System Active"
    }
  });
});

// Socket connection dengan ESP32 tracking - DIPERBAIKI
io.on("connection", (socket) => {
  const clientType = socket.handshake.query.clientType || 'unknown';
  const clientIP = socket.handshake.address;
  
  logger.info("Client connected", { 
    socketId: socket.id,
    clientType: clientType,
    ip: clientIP
  });

  // 🆕 DETEKSI OTOMATIS ESP32 BERDASARKAN IP ATAU IDENTIFIKASI
  if (clientType === 'esp32' || clientIP.includes('192.168.1.14')) { // Adjust IP sesuai ESP32
    updateESP32Status(true, socket, clientIP);
    logger.esp32("✅ ESP32 Controller detected via Socket.IO", {
      socketId: socket.id,
      ip: clientIP
    });
  }

  // 🆕 Handler untuk identifikasi manual ESP32
  socket.on("esp32_identify", (data) => {
    logger.esp32("🔍 ESP32 Manual Identification", {
      socketId: socket.id,
      data: data
    });
    
    // Tandai sebagai ESP32 dan update status
    updateESP32Status(true, socket, clientIP);
    
    // Beri konfirmasi ke ESP32
    socket.emit("esp32_identified", {
      status: "success",
      message: "ESP32 registered as controller",
      timestamp: new Date().toISOString()
    });
  });

  // 🆕 Handler untuk heartbeat dari ESP32
  socket.on("esp32_heartbeat", (data) => {
    if (clientType === 'esp32' || clientIP.includes('192.168.1.14')) {
      logESP32Activity({
        type: "heartbeat",
        message: "ESP32 Socket.IO heartbeat",
        data: data
      }, socket, clientIP);
    }
  });

  // 🆕 Handler untuk activity dari ESP32
  socket.on("esp32_activity", (data) => {
    if (clientType === 'esp32' || clientIP.includes('192.168.1.14')) {
      logESP32Activity(data, socket, clientIP);
    }
  });

  // 🆕 Handler untuk test connection dari admin
  socket.on("testConnection", (data) => {
    if (clientType === 'esp32' || clientIP.includes('192.168.1.14')) {
      logger.esp32("🧪 Test connection received", data);
      socket.emit("testResponse", {
        status: "OK",
        message: "ESP32 Controller is responsive",
        timestamp: new Date().toISOString()
      });
    }
  });

  // Send initial state
  socket.emit("scores", scores);
  socket.emit("config", config);
  socket.emit("lockstate", lockState);
  
  if (isTimerRunning) {
    socket.emit("timerStart", { duration: timeRemaining });
  }

  socket.on("disconnect", (reason) => {
    // 🆕 Jika ESP32 disconnect
    if (clientType === 'esp32' || clientIP.includes('192.168.1.14')) {
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
  // Validasi file audio saat startup
  validateAudioFiles();
  
  http.listen(PORT, async () => {
    console.log('\n🎯 SISTEM KUIS - Ridwan and Team');
    console.log('───────────────────────────────────────────────────────');
    console.log(`✅ Tampilan: http://localhost:${PORT}`);
    console.log(`✅ Admin: http://localhost:${PORT}/admin.html`);
    console.log(`✅ Health Check: http://localhost:${PORT}/health`);
    console.log(`✅ ESP32 Status: http://localhost:${PORT}/esp32status`);
    console.log(`✅ ESP32 Check-in: http://localhost:${PORT}/esp32checkin`);
    console.log('───────────────────────────────────────────────────────\n');
  });
}

startServer();