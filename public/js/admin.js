﻿/*Copyright © 2025 Ridwan and Team*/
// Socket connection
const socket = io();

// Global variables
let teams = [];
let activeTeam = null;
let timerDuration = 30;
let timerInterval = null;
let timeLeft = 0;
let timerRunning = false;
let plusScore = 5;
let minusScore = -2;

// Initialize teams
function initializeTeams() {
    teams = [];
    for (let i = 1; i <= 12; i++) {
        teams.push({
            id: i,
            name: `Tim ${String.fromCharCode(65 + i - 1)}`,
            score: 0,
            active: false,
            enabled: true
        });
    }
    renderTeams();
    updateJuryControls();
}

// Render teams in admin panel
function renderTeams() {
    const teamsContainer = document.getElementById('teams');
    teamsContainer.innerHTML = '';

    // Create two rows of 6 teams each
    const rows = [
        teams.slice(0, 6),
        teams.slice(6, 12)
    ];

    rows.forEach((rowTeams, rowIndex) => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'teams-row';
        
        rowTeams.forEach(team => {
            const teamCard = document.createElement('div');
            teamCard.className = `team-card-compact ${team.active ? 'active' : ''} ${!team.enabled ? 'disabled' : ''}`;
            teamCard.innerHTML = `
                <div class="team-header">
                    <div class="team-name">${team.name}</div>
                    <div class="team-status ${team.active ? 'status-active' : 'status-waiting'}">
                        ${team.active ? 'AKTIF' : 'MENUNGGU'}
                    </div>
                </div>
                <div class="team-score-display">
                    <div class="team-score">${team.score}</div>
                </div>
                <div class="team-controls">
                    <button class="team-toggle ${team.enabled ? 'toggle-on' : 'toggle-off'}" 
                            data-team-id="${team.id}">
                        ${team.enabled ? 'NONAKTIFKAN' : 'AKTIFKAN'}
                    </button>
                </div>
            `;
            rowDiv.appendChild(teamCard);
        });
        
        teamsContainer.appendChild(rowDiv);
    });

    // Add event listeners to toggle buttons
    document.querySelectorAll('.team-toggle').forEach(button => {
        button.addEventListener('click', function() {
            const teamId = parseInt(this.getAttribute('data-team-id'));
            toggleTeam(teamId);
        });
    });
}

// Toggle team enabled/disabled status
function toggleTeam(teamId) {
    const team = teams.find(t => t.id === teamId);
    if (team) {
        team.enabled = !team.enabled;
        
        // Jika menonaktifkan tim yang sedang aktif, nonaktifkan tim tersebut
        if (!team.enabled && team.active) {
            deactivateTeam();
        }
        
        renderTeams();
        updateJuryControls();
        sendScoresToDisplay();
        
        // KIRIM STATUS TOGGLE KE SERVER
        socket.emit('toggleTeam', {
            teamId: teamId,
            enabled: team.enabled
        });
        
        showNotification(`${team.name} ${team.enabled ? 'diaktifkan' : 'dinonaktifkan'}`, 'success');
    }
}

// Update jury controls based on active team
function updateJuryControls() {
    const juryControls = document.getElementById('juryControls');
    const waitingLabel = document.getElementById('waitingLabel');
    const activeTeamLabel = document.getElementById('activeTeamLabel');
    
    if (activeTeam && activeTeam.enabled) {
        juryControls.classList.add('active');
        waitingLabel.style.display = 'none';
        activeTeamLabel.textContent = `${activeTeam.name} SEDANG BERMAIN`;
        activeTeamLabel.style.display = 'block';
        
        // Enable jury buttons
        document.getElementById('juryPlus').disabled = false;
        document.getElementById('juryMinus').disabled = false;
    } else {
        juryControls.classList.remove('active');
        waitingLabel.style.display = 'flex';
        activeTeamLabel.style.display = 'none';
        
        // Disable jury buttons
        document.getElementById('juryPlus').disabled = true;
        document.getElementById('juryMinus').disabled = true;
    }
}

// Deactivate current team
function deactivateTeam() {
    if (activeTeam) {
        activeTeam.active = false;
        activeTeam = null;
    }
    stopTimer();
    updateJuryControls();
    sendScoresToDisplay();
}

// Activate a team
function activateTeam(teamId) {
    // Deactivate current team first
    deactivateTeam();
    
    const team = teams.find(t => t.id === teamId);
    if (team && team.enabled) {
        team.active = true;
        activeTeam = team;
        startTimer();
        updateJuryControls();
        sendScoresToDisplay();
        showNotification(`${team.name} aktif!`, 'info');
    }
}

// Send scores to display
function sendScoresToDisplay() {
    const teamsData = teams.map(team => ({
        id: team.id,
        name: team.name,
        score: team.score,
        active: team.active,
        enabled: team.enabled
    }));
    
    socket.emit('scoresUpdate', teamsData);
}

// Timer functions
function startTimer() {
    stopTimer();
    timeLeft = timerDuration;
    timerRunning = true;
    updateTimerDisplay();
    
    timerInterval = setInterval(() => {
        timeLeft--;
        updateTimerDisplay();
        
        if (timeLeft <= 0) {
            stopTimer();
            if (activeTeam) {
                // Auto minus score when time's up
                updateScore(minusScore);
                showNotification(`Waktu habis! ${activeTeam.name} mendapat poin salah`, 'warning');
            }
        }
    }, 1000);
}

function stopTimer() {
    timerRunning = false;
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function updateTimerDisplay() {
    const timerState = document.getElementById('timerState');
    const currentTime = document.getElementById('currentTime');
    
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    
    currentTime.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    
    if (timerRunning) {
        timerState.textContent = 'BERJALAN';
        timerState.className = 'timer-state-berjalan';
    } else if (timeLeft <= 0 && activeTeam) {
        timerState.textContent = 'SELESAI';
        timerState.className = 'timer-state-selesai';
    } else {
        timerState.textContent = 'TIDAK AKTIF';
        timerState.className = 'timer-state-tidak-aktif';
        currentTime.textContent = '00:00';
    }
}

// Update score for active team
function updateScore(points) {
    if (activeTeam && activeTeam.enabled) {
        activeTeam.score += points;
        activeTeam.score = Math.max(0, activeTeam.score); // Prevent negative scores
        
        // Add animation class
        const teamElement = document.querySelector(`[data-team-id="${activeTeam.id}"]`);
        if (teamElement) {
            const scoreElement = teamElement.closest('.team-card-compact').querySelector('.team-score');
            scoreElement.classList.add('score-update');
            setTimeout(() => {
                scoreElement.classList.remove('score-update');
            }, 600);
        }
        
        renderTeams();
        sendScoresToDisplay();
        stopTimer();
        deactivateTeam();
        
        const action = points > 0 ? 'benar' : 'salah';
        showNotification(`${activeTeam.name} menjawab ${action}! (+${points})`, 'success');
    }
}

// Show notification
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `admin-notification ${type}`;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.classList.add('show');
    }, 100);
    
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 500);
    }, 3000);
}

// Socket event listeners
socket.on('connect', function() {
    console.log('Connected to server');
    document.querySelector('.connection-status-bar').style.background = 'var(--admin-success)';
});

socket.on('disconnect', function() {
    console.log('Disconnected from server');
    document.querySelector('.connection-status-bar').style.background = 'var(--admin-danger)';
});

socket.on('buzzerPressed', function(data) {
    const team = teams.find(t => t.id === data.teamId);
    if (team && team.enabled) {
        activateTeam(data.teamId);
        showNotification(`${team.name} menekan buzzer!`, 'info');
    } else if (team && !team.enabled) {
        showNotification(`${team.name} dinonaktifkan - tidak dapat bermain`, 'warning');
    }
});

socket.on('esp32Status', function(data) {
    updateESP32Status(data);
});

// ESP32 status update
function updateESP32Status(data) {
    const esp32Badge = document.getElementById('esp32Badge');
    const esp32Connection = document.getElementById('esp32Connection');
    const esp32LastActivity = document.getElementById('esp32LastActivity');
    const esp32SocketId = document.getElementById('esp32SocketId');
    
    if (data.connected) {
        esp32Badge.textContent = 'TERHUBUNG';
        esp32Badge.className = 'controller-badge connected';
        esp32Connection.textContent = 'Online';
        esp32Connection.style.color = 'var(--admin-success)';
    } else {
        esp32Badge.textContent = 'TERPUTUS';
        esp32Badge.className = 'controller-badge disconnected';
        esp32Connection.textContent = 'Offline';
        esp32Connection.style.color = 'var(--admin-danger)';
    }
    
    esp32LastActivity.textContent = data.lastActivity || '-';
    esp32SocketId.textContent = data.socketId || '-';
}

// Event listeners for buttons
document.addEventListener('DOMContentLoaded', function() {
    initializeTeams();
    
    // Configuration buttons
    document.getElementById('setConfig').addEventListener('click', function() {
        plusScore = parseInt(document.getElementById('plus').value) || 5;
        minusScore = parseInt(document.getElementById('minus').value) || -2;
        timerDuration = parseInt(document.getElementById('timerDuration').value) || 30;
        
        document.getElementById('plusValue').textContent = plusScore;
        document.getElementById('minusValue').textContent = minusScore;
        
        showNotification('Konfigurasi disimpan!', 'success');
    });
    
    document.getElementById('reset').addEventListener('click', function() {
        if (confirm('Apakah Anda yakin ingin mereset semua skor?')) {
            teams.forEach(team => {
                team.score = 0;
                team.active = false;
            });
            activeTeam = null;
            stopTimer();
            renderTeams();
            updateJuryControls();
            sendScoresToDisplay();
            showNotification('Semua skor telah direset!', 'success');
        }
    });
    
    document.getElementById('unlock').addEventListener('click', function() {
        teams.forEach(team => {
            team.enabled = true;
        });
        renderTeams();
        sendScoresToDisplay();
        
        socket.emit('enableAllTeams');
        
        showNotification('Semua tombol tim telah dibuka!', 'success');
    });
    
    // Jury buttons
    document.getElementById('juryPlus').addEventListener('click', function() {
        updateScore(plusScore);
    });
    
    document.getElementById('juryMinus').addEventListener('click', function() {
        updateScore(minusScore);
    });
    
    // ESP32 buttons
    document.getElementById('refreshESP32').addEventListener('click', function() {
        socket.emit('getESP32Status');
        showNotification('Memperbarui status ESP32...', 'info');
    });
    
    document.getElementById('testESP32').addEventListener('click', function() {
        socket.emit('testESP32');
        showNotification('Mengirim perintah test ke ESP32...', 'info');
    });
    
    // Initialize values
    document.getElementById('plusValue').textContent = plusScore;
    document.getElementById('minusValue').textContent = minusScore;
    
    // Request initial ESP32 status
    socket.emit('getESP32Status');
});