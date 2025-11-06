import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const http = createServer(app);

// Socket.io setup untuk Railway
const io = new Server(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 8080;
const TEAM_COUNT = 12;

let scores = Array(TEAM_COUNT).fill(0);
let config = { plus: 5, minus: -2, timerDuration: 30 };
let lockState = { locked: false, activeTeam: null };

let timerInterval = null;
let timeRemaining = 0;
let isTimerRunning = false;

const logger = {
  info: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }
};

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
      `Mantap! Tim ${teamLetter} dapat ${points} poin!`
    ];
    return messages[Math.floor(Math.random() * messages.length)];
  } else {
    const messages = [
      `Sayang sekali, Tim ${teamLetter} kurang tepat. Kurang ${Math.abs(points)} poin!`,
      `Masih salah, Tim ${teamLetter}. ${points} poin!`,
      `Bukan itu jawabannya, Tim ${teamLetter}. ${points} poin!`,
      `Coba lagi, Tim ${teamLetter}. ${points} poin!`
    ];
    return messages[Math.floor(Math.random() * messages.length)];
  }
}

// TIMER SYSTEM
function startTimer(activeTeam = null) {
  if (isTimerRunning) return;
  
  isTimerRunning = true;
  timeRemaining = config.timerDuration;
  const currentActiveTeam = activeTeam || lockState.activeTeam;

  io.emit("timerStart", { duration: config.timerDuration });
  
  logger.info("Timer started AFTER AUDIO", { 
    timeRemaining, 
    activeTeam: currentActiveTeam
  });

  timerInterval = setInterval(() => {
    timeRemaining--;
    io.emit("timerUpdate", { timeRemaining });

    // Countdown TTS messages
    if (timeRemaining === 10) {
      io.emit("aiMessage", { 
        message: "Sepuluh detik!", 
        shouldSpeak: true
      });
    } else if (timeRemaining === 5) {
      io.emit("aiMessage", { 
        message: "Lima!", 
        shouldSpeak: true
      });
    } else if (timeRemaining === 3) {
      io.emit("aiMessage", { 
        message: "Tiga!", 
        shouldSpeak: true
      });
    } else if (timeRemaining === 2) {
      io.emit("aiMessage", { 
        message: "Dua!", 
        shouldSpeak: true
      });
    } else if (timeRemaining === 1) {
      io.emit("aiMessage", { 
        message: "Satu!", 
        shouldSpeak: true
      });
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

  // Timer end message
  io.emit("aiMessage", {
    message: "Waktu habis!",
    shouldSpeak: true
  });

  lockState = { locked: false, activeTeam: null };
  io.emit("lockstate", lockState);
}

function resetTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  isTimerRunning = false;
  timeRemaining = 0;
  io.emit("timerReset");
}

// ===== ROUTES =====
// Serve static files dari public folder (satu level di atas server/)
app.use(express.static(join(__dirname, '..', 'public')));

app.get("/update", async (req, res) => {
  const team = parseInt(req.query.team);
  const add = parseInt(req.query.add);
  const isFirst = req.query.first === "1";

  if (!Number.isInteger(team) || team < 1 || team > TEAM_COUNT) {
    return res.status(400).send("Tim tidak valid");
  }

  if (lockState.locked && team !== lockState.activeTeam) {
    return res.status(403).send("Tombol terkunci");
  }

  if (isFirst && !lockState.locked) {
    lockState = { locked: true, activeTeam: team };
    io.emit("lockstate", lockState);
    io.emit("buzz", { team });
    
    const audioFile = getTeamAudioFile(team);
    io.emit("playTeamAudio", {
      team: team,
      audioFile: audioFile,
      onAudioEnd: {
        action: "startTimer",
        team: team
      }
    });
    
    logger.info(`Audio triggered for team ${team}`);
  }

  if (add !== 0) {
    scores[team - 1] += add;
    io.emit("update", { team, score: scores[team - 1] });
    io.emit("scoring", { team, isCorrect: add > 0 });
    
    // Juri TTS
    const feedbackMessage = generateFeedbackMessage(team, add > 0, add);
    io.emit("aiMessage", {
      message: feedbackMessage,
      shouldSpeak: true
    });
    
    logger.info(`Jury scoring: ${feedbackMessage}`);
    
    resetTimer();
    lockState = { locked: false, activeTeam: null };
    io.emit("lockstate", lockState);
  }

  res.send("OK");
});

// Route untuk client memberi tahu audio selesai
app.get("/audioFinished", (req, res) => {
  const action = req.query.action;
  const team = parseInt(req.query.team);
  
  logger.info("Audio finished callback received", { action, team });
  
  if (action === "startTimer" && team && !isTimerRunning) {
    logger.info("Starting timer after audio finished", { team });
    startTimer(team);
  }
  
  res.json({ success: true, message: "Audio finished processed" });
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

app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    scores, 
    lockState, 
    config,
    connections: io.engine.clientsCount,
    services: {
      audio: "Audio File System - File per Tim",
      tts: "Web Speech API - Timer & Juri",
      files: "Tim A.mp3, Tim B.mp3, ..., Tim L.mp3",
      timer: "START AFTER AUDIO - Timer mulai setelah audio selesai"
    },
    timer: {
      running: isTimerRunning,
      remaining: timeRemaining,
      startAfterAudio: true
    }
  });
});

// Root route - serve index.html
app.get("/", (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});

// Admin route
app.get("/admin", (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'admin.html'));
});

// Socket connection
io.on("connection", (socket) => {
  logger.info("Client connected", { socketId: socket.id });

  // Send initial state
  socket.emit("scores", scores);
  socket.emit("config", config);
  socket.emit("lockstate", lockState);

  socket.on("disconnect", () => {
    logger.info("Client disconnected", { socketId: socket.id });
  });
});

// Startup server
http.listen(PORT, () => {
  console.log('=========================================');
  console.log('QUIZ SCORING SYSTEM - Ridwan and Tim');
  console.log(`Port: ${PORT}`);
  console.log(`Display: http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
  console.log('=========================================');
});