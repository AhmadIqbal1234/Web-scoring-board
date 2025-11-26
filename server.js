﻿const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// In-memory storage untuk data
let scores = Array(12).fill(0);
let lockState = { locked: false, activeTeam: null };
let config = { plus: 5, minus: -2, timerDuration: 30 };
let teamToggleState = Array(12).fill(true);
let timer = null;
let timeRemaining = 0;

// Middleware
app.use(express.static(path.join(__dirname)));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files dari folder yang benar
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/audio', express.static(path.join(__dirname, 'audio')));
app.use('/tts', express.static(path.join(__dirname, 'tts')));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/test', (req, res) => {
    res.sendFile(path.join(__dirname, 'test.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        message: 'Server is running'
    });
});

// API endpoints
app.get('/scores', (req, res) => {
    res.json(scores);
});

app.get('/lockstate', (req, res) => {
    res.json(lockState);
});

app.get('/teamToggleState', (req, res) => {
    res.json(teamToggleState);
});

app.get('/esp32status', (req, res) => {
    res.json({
        connected: false,
        lastActivity: null,
        socketId: null,
        ip: null
    });
});

// Update score
app.get('/update', (req, res) => {
    const team = parseInt(req.query.team);
    const add = parseInt(req.query.add);
    const isFirst = req.query.first === '1';

    if (team >= 1 && team <= 12) {
        if (isFirst && !lockState.locked) {
            // First buzz - lock the system
            lockState = { locked: true, activeTeam: team };
            io.emit('lockstate', lockState);
            io.emit('buzz', { team });
            
            // Play buzzer audio
            io.emit('playBuzzerAudio', {
                audioFile: 'buzzer.mp3',
                team: team
            });

            // Then play team audio after buzzer
            setTimeout(() => {
                io.emit('playTeamAudio', {
                    team: team,
                    audioFile: `Tim ${String.fromCharCode(64 + team)}.mp3`,
                    timerDuration: config.timerDuration
                });
            }, 1000);

            res.json({ success: true, message: `Tim ${team} mengunci sistem` });
        } else if (!isFirst && lockState.locked && lockState.activeTeam === team) {
            // Update score for active team
            scores[team - 1] += add;
            io.emit('update', { team, score: scores[team - 1] });
            
            // Play jury audio
            const isCorrect = add > 0;
            io.emit('playJuryAudio', {
                isCorrect: isCorrect,
                audioFile: isCorrect ? 'benar.mp3' : 'salah.mp3'
            });

            // Unlock system after scoring
            lockState = { locked: false, activeTeam: null };
            io.emit('lockstate', lockState);
            
            // Reset timer
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            io.emit('timerReset');

            res.json({ success: true, score: scores[team - 1] });
        } else {
            res.json({ success: false, error: 'Aksi tidak valid' });
        }
    } else {
        res.json({ success: false, error: 'Tim tidak valid' });
    }
});

// Reset scores
app.get('/reset', (req, res) => {
    scores = Array(12).fill(0);
    lockState = { locked: false, activeTeam: null };
    teamToggleState = Array(12).fill(true);
    
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    
    io.emit('reset', scores);
    io.emit('lockstate', lockState);
    io.emit('allTeamsEnabled');
    io.emit('timerReset');
    
    res.json({ success: true, scores: scores });
});

// Unlock system
app.get('/unlock', (req, res) => {
    lockState = { locked: false, activeTeam: null };
    
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    
    io.emit('lockstate', lockState);
    io.emit('timerReset');
    res.json({ success: true });
});

// Set configuration
app.get('/setconfig', (req, res) => {
    const plus = parseInt(req.query.plus);
    const minus = parseInt(req.query.minus);
    const timerDuration = parseInt(req.query.timerDuration);
    
    if (!isNaN(plus)) config.plus = plus;
    if (!isNaN(minus)) config.minus = minus;
    if (!isNaN(timerDuration)) config.timerDuration = timerDuration;
    
    io.emit('config', config);
    res.json({ success: true, config: config });
});

// Toggle team status
app.get('/toggleTeam', (req, res) => {
    const team = parseInt(req.query.team);
    const enabled = req.query.enabled === 'true';
    
    if (team >= 1 && team <= 12) {
        teamToggleState[team - 1] = enabled;
        io.emit('teamToggleUpdate', { team, enabled });
        res.json({ success: true, team, enabled });
    } else {
        res.json({ success: false, error: 'Tim tidak valid' });
    }
});

// Enable all teams
app.get('/enableAllTeams', (req, res) => {
    teamToggleState = Array(12).fill(true);
    io.emit('allTeamsEnabled');
    res.json({ success: true });
});

// Audio finished callback
app.get('/audioFinished', (req, res) => {
    const action = req.query.action;
    const team = parseInt(req.query.team);
    
    if (action === 'startTimer' && team) {
        startTimer(team);
        res.json({ success: true, action: 'timerStarted', team: team });
    } else {
        res.json({ success: false, error: 'Aksi tidak dikenali' });
    }
});

// Timer functions
function startTimer(team) {
    if (timer) {
        clearInterval(timer);
    }
    
    timeRemaining = config.timerDuration;
    io.emit('timerStart', { duration: timeRemaining, team: team });
    
    // Play countdown audio at specific intervals
    const playCountdownAudio = (seconds) => {
        const audioFiles = {
            30: '30 detik.mp3',
            20: '20 detik.mp3', 
            10: '10 detik.mp3',
            5: '5 detik.mp3',
            4: '4 detik.mp3',
            3: '3 detik.mp3',
            2: '2 detik.mp3', 
            1: '1 detik.mp3'
        };
        
        if (audioFiles[seconds]) {
            io.emit('playTimerAudio', {
                seconds: seconds,
                audioFile: audioFiles[seconds]
            });
        }
    };
    
    timer = setInterval(() => {
        timeRemaining--;
        
        // Play countdown audio
        playCountdownAudio(timeRemaining);
        
        if (timeRemaining <= 0) {
            clearInterval(timer);
            timer = null;
            io.emit('timerEnd');
            io.emit('playTimerAudio', { seconds: 0, audioFile: 'waktu habis.mp3' });
            
            // Auto-unlock when timer ends
            lockState = { locked: false, activeTeam: null };
            io.emit('lockstate', lockState);
            
        } else {
            io.emit('timerUpdate', { timeRemaining: timeRemaining });
        }
    }, 1000);
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Send initial data to new client
    socket.emit('config', config);
    socket.emit('lockstate', lockState);
    socket.emit('teamToggleState', teamToggleState);
    
    socket.on('ping', (data) => {
        socket.emit('pong', { ...data, serverTime: Date.now() });
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server berjalan di port ${PORT}`);
    console.log(`Local: http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
});