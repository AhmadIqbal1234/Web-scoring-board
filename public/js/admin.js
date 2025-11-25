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
    if (!teamsContainer) {
        console.error('Teams container not found');
        return;
    }
    
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
    
    if (!juryControls || !waitingLabel || !activeTeamLabel) {
        console.error('Jury control elements not found');
        return;
    }
    
    if (activeTeam && activeTeam.enabled) {
        juryControls.classList.add('active');
        waitingLabel.style.display = 'none';
        activeTeamLabel.textContent = `${activeTeam.name} SEDANG BERMAIN`;
        activeTeamLabel.style.display = 'block';
        
        // Enable jury buttons
        const juryPlus = document.getElementById('juryPlus');
        const juryMinus = document.getElementById('juryMinus');
        if (juryPlus) juryPlus.disabled = false;
        if (juryMinus) juryMinus.disabled = false;
    } else {
        juryControls.classList.remove('active');
        waitingLabel.style.display = 'flex';
        activeTeamLabel.style.display = 'none';
        
        // Disable jury buttons
        const juryPlus = document.getElementById('juryPlus');
        const juryMinus = document.getElementById('juryMinus');
        if (juryPlus) juryPlus.disabled = true;
        if (juryMinus) juryMinus.disabled = true;
    }
}

// Deactivate current team
function deactivateTeam() {
    if (activeTeam) {
        console.log('🔓 Deactivating team:', activeTeam.name);
        
        // Update team status in local state
        const team = teams.find(t => t.id === activeTeam.id);
        if (team) {
            team.active = false;
        }
        activeTeam = null;
    }
    stopTimer();
    updateJuryControls();
    renderTeams(); // Update UI to reflect deactivation
}

// Activate a team based on server lockstate
function activateTeamFromServer(teamId) {
    console.log('🔄 Activating team from server:', teamId);
    
    // Deactivate current team first
    deactivateTeam();
    
    const team = teams.find(t => t.id === teamId);
    if (team && team.enabled) {
        team.active = true;
        activeTeam = team;
        updateJuryControls();
        renderTeams(); // Update UI to show active team
        showNotification(`${team.name} aktif!`, 'info');
        
        // Start timer if not already running
        if (!timerRunning) {
            startTimer();
        }
    } else if (team && !team.enabled) {
        showNotification(`${team.name} dinonaktifkan - tidak dapat bermain`, 'warning');
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
    updateTimerDisplay();
}

function updateTimerDisplay() {
    const timerState = document.getElementById('timerState');
    const currentTime = document.getElementById('currentTime');
    
    if (!timerState || !currentTime) {
        console.error('Timer display elements not found');
        return;
    }
    
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

// PERBAIKAN: Update score for active team - HANYA kirim ke server
function updateScore(points) {
    if (activeTeam && activeTeam.enabled) {
        console.log(`🎯 Sending score update to server: ${activeTeam.name} +${points}`);
        
        // HANYA kirim ke server, JANGAN update lokal
        fetch(`/update?team=${activeTeam.id}&add=${points}`)
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    console.log(`✅ Score update sent to server: ${activeTeam.name} +${points}`);
                    
                    // Server akan mengirim update melalui socket, jadi tidak perlu update lokal
                    showNotification(`${activeTeam.name} menjawab ${points > 0 ? 'benar' : 'salah'}! (+${points})`, 'success');
                    
                    // Deactivate team after scoring
                    deactivateTeam();
                } else {
                    showNotification(`Gagal update score: ${data.error}`, 'error');
                }
            })
            .catch(error => {
                console.error('Score update error:', error);
                showNotification('Error: Gagal mengupdate score', 'error');
            });
    } else {
        showNotification('Tidak ada tim aktif untuk diberi nilai', 'warning');
    }
}

// Show notification
function showNotification(message, type = 'info') {
    // Remove existing notifications
    const existingNotifications = document.querySelectorAll('.admin-notification');
    existingNotifications.forEach(notification => {
        if (document.body.contains(notification)) {
            document.body.removeChild(notification);
        }
    });
    
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
            if (document.body.contains(notification)) {
                document.body.removeChild(notification);
            }
        }, 500);
    }, 3000);
}

// Configuration functions
function setConfiguration() {
    const plusInput = document.getElementById('plus');
    const minusInput = document.getElementById('minus');
    const timerInput = document.getElementById('timerDuration');
    
    if (!plusInput || !minusInput || !timerInput) {
        console.error('Configuration input elements not found');
        showNotification('Error: Elemen konfigurasi tidak ditemukan', 'error');
        return;
    }
    
    plusScore = parseInt(plusInput.value) || 5;
    minusScore = parseInt(minusInput.value) || -2;
    timerDuration = parseInt(timerInput.value) || 30;
    
    // Update display values
    const plusValue = document.getElementById('plusValue');
    const minusValue = document.getElementById('minusValue');
    if (plusValue) plusValue.textContent = plusScore;
    if (minusValue) minusValue.textContent = minusScore;
    
    // Send configuration to server
    fetch(`/setconfig?plus=${plusScore}&minus=${minusScore}&timerDuration=${timerDuration}`)
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showNotification('Konfigurasi berhasil disimpan!', 'success');
                console.log('Configuration updated:', data.config);
            } else {
                showNotification('Gagal menyimpan konfigurasi', 'error');
            }
        })
        .catch(error => {
            console.error('Configuration error:', error);
            showNotification('Error: Gagal menyimpan konfigurasi', 'error');
        });
}

function resetScores() {
    if (confirm('Apakah Anda yakin ingin mereset semua skor?')) {
        fetch('/reset')
            .then(response => response.json())
            .then(data => {
                if (data.success) {
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
                } else {
                    showNotification('Gagal mereset skor', 'error');
                }
            })
            .catch(error => {
                console.error('Reset error:', error);
                showNotification('Error: Gagal mereset skor', 'error');
            });
    }
}

function unlockSystem() {
    fetch('/unlock')
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                // Enable all teams
                teams.forEach(team => {
                    team.enabled = true;
                });
                renderTeams();
                sendScoresToDisplay();
                
                // Emit to server
                socket.emit('enableAllTeams');
                
                showNotification('Semua tombol tim telah dibuka!', 'success');
            } else {
                showNotification('Gagal membuka kunci sistem', 'error');
            }
        })
        .catch(error => {
            console.error('Unlock error:', error);
            showNotification('Error: Gagal membuka kunci sistem', 'error');
        });
}

// Socket event listeners
socket.on('connect', function() {
    console.log('✅ Connected to server');
    const statusBar = document.querySelector('.connection-status-bar');
    if (statusBar) {
        statusBar.style.background = 'var(--admin-success)';
    }
    
    // Request initial state from server
    loadInitialState();
});

socket.on('disconnect', function() {
    console.log('❌ Disconnected from server');
    const statusBar = document.querySelector('.connection-status-bar');
    if (statusBar) {
        statusBar.style.background = 'var(--admin-danger)';
    }
});

// Load initial state from server
function loadInitialState() {
    console.log('🔄 Loading initial state from server...');
    
    Promise.all([
        fetch('/scores').then(r => r.json()),
        fetch('/lockstate').then(r => r.json()),
        fetch('/config').then(r => r.json()),
        fetch('/teamToggleState').then(r => r.json())
    ])
    .then(([scores, lockState, serverConfig, toggleState]) => {
        console.log('📥 Initial state loaded:', { scores, lockState, serverConfig, toggleState });
        
        // Update scores
        if (Array.isArray(scores)) {
            teams.forEach((team, index) => {
                team.score = scores[index] || 0;
            });
        }
        
        // Update configuration
        if (serverConfig) {
            plusScore = serverConfig.plus || 5;
            minusScore = serverConfig.minus || -2;
            timerDuration = serverConfig.timerDuration || 30;
            
            // Update UI inputs
            const plusInput = document.getElementById('plus');
            const minusInput = document.getElementById('minus');
            const timerInput = document.getElementById('timerDuration');
            const plusValue = document.getElementById('plusValue');
            const minusValue = document.getElementById('minusValue');
            
            if (plusInput) plusInput.value = plusScore;
            if (minusInput) minusInput.value = minusScore;
            if (timerInput) timerInput.value = timerDuration;
            if (plusValue) plusValue.textContent = plusScore;
            if (minusValue) minusValue.textContent = minusScore;
        }
        
        // Update team toggle state
        if (Array.isArray(toggleState)) {
            teams.forEach((team, index) => {
                team.enabled = toggleState[index];
            });
        }
        
        // Update active team based on lockstate
        if (lockState && lockState.locked && lockState.activeTeam) {
            activateTeamFromServer(lockState.activeTeam);
        }
        
        renderTeams();
        updateJuryControls();
        console.log('✅ Initial state applied successfully');
    })
    .catch(error => {
        console.error('❌ Error loading initial state:', error);
    });
}

// PERBAIKAN: Listen to server events dengan handling yang lebih baik
socket.on('lockstate', function(state) {
    console.log('🔒 Lockstate update received:', state);
    
    if (state.locked && state.activeTeam) {
        activateTeamFromServer(state.activeTeam);
    } else {
        deactivateTeam();
    }
});

socket.on('buzz', function(data) {
    console.log('🎯 Buzz event received:', data);
    if (data.team) {
        activateTeamFromServer(data.team);
    }
});

// PERBAIKAN: Socket event handler untuk update scores - HANYA update dari server
socket.on('update', function(payload) {
    console.log('📊 Score update received from server:', payload);
    
    // Update HANYA jika ini bukan dari action kita sendiri (prevent loop)
    if (payload.team && payload.score !== undefined) {
        const team = teams.find(t => t.id === payload.team);
        if (team) {
            team.score = payload.score;
            
            // Add animation class
            const teamElement = document.querySelector(`[data-team-id="${payload.team}"]`);
            if (teamElement) {
                const scoreElement = teamElement.closest('.team-card-compact').querySelector('.team-score');
                scoreElement.classList.add('score-update');
                setTimeout(() => {
                    scoreElement.classList.remove('score-update');
                }, 600);
            }
            
            renderTeams();
        }
    }
});

socket.on('config', function(config) {
    console.log('⚙️ Config update received:', config);
    // Update local configuration
    if (config.plus) plusScore = config.plus;
    if (config.minus) minusScore = config.minus;
    if (config.timerDuration) timerDuration = config.timerDuration;
    
    // Update UI
    const plusValue = document.getElementById('plusValue');
    const minusValue = document.getElementById('minusValue');
    if (plusValue) plusValue.textContent = plusScore;
    if (minusValue) minusValue.textContent = minusScore;
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
    
    if (esp32Badge) {
        if (data.connected) {
            esp32Badge.textContent = 'TERHUBUNG';
            esp32Badge.className = 'controller-badge connected';
        } else {
            esp32Badge.textContent = 'TERPUTUS';
            esp32Badge.className = 'controller-badge disconnected';
        }
    }
    
    if (esp32Connection) {
        esp32Connection.textContent = data.connected ? 'Online' : 'Offline';
        esp32Connection.style.color = data.connected ? 'var(--admin-success)' : 'var(--admin-danger)';
    }
    
    if (esp32LastActivity) {
        esp32LastActivity.textContent = data.lastActivity || '-';
    }
    
    if (esp32SocketId) {
        esp32SocketId.textContent = data.socketId || '-';
    }
}

// Initialize admin panel
function initializeAdminPanel() {
    console.log('🔄 Initializing admin panel...');
    
    // Initialize teams
    initializeTeams();
    
    // Configuration buttons
    const setConfigBtn = document.getElementById('setConfig');
    const resetBtn = document.getElementById('reset');
    const unlockBtn = document.getElementById('unlock');
    
    if (setConfigBtn) {
        setConfigBtn.addEventListener('click', setConfiguration);
        console.log('✅ setConfig button initialized');
    } else {
        console.error('❌ setConfig button not found');
    }
    
    if (resetBtn) {
        resetBtn.addEventListener('click', resetScores);
        console.log('✅ reset button initialized');
    } else {
        console.error('❌ reset button not found');
    }
    
    if (unlockBtn) {
        unlockBtn.addEventListener('click', unlockSystem);
        console.log('✅ unlock button initialized');
    } else {
        console.error('❌ unlock button not found');
    }
    
    // Jury buttons
    const juryPlus = document.getElementById('juryPlus');
    const juryMinus = document.getElementById('juryMinus');
    
    if (juryPlus) {
        juryPlus.addEventListener('click', function() {
            console.log('🎯 Jury PLUS clicked for team:', activeTeam);
            updateScore(plusScore);
        });
        console.log('✅ juryPlus button initialized');
    }
    
    if (juryMinus) {
        juryMinus.addEventListener('click', function() {
            console.log('🎯 Jury MINUS clicked for team:', activeTeam);
            updateScore(minusScore);
        });
        console.log('✅ juryMinus button initialized');
    }
    
    // ESP32 buttons
    const refreshESP32 = document.getElementById('refreshESP32');
    const testESP32 = document.getElementById('testESP32');
    
    if (refreshESP32) {
        refreshESP32.addEventListener('click', function() {
            socket.emit('getESP32Status');
            showNotification('Memperbarui status ESP32...', 'info');
        });
    }
    
    if (testESP32) {
        testESP32.addEventListener('click', function() {
            socket.emit('testESP32');
            showNotification('Mengirim perintah test ke ESP32...', 'info');
        });
    }
    
    // Initialize values
    const plusValue = document.getElementById('plusValue');
    const minusValue = document.getElementById('minusValue');
    
    if (plusValue) plusValue.textContent = plusScore;
    if (minusValue) minusValue.textContent = minusScore;
    
    console.log('✅ Admin panel initialized successfully');
}

// Wait for DOM to be fully loaded
document.addEventListener('DOMContentLoaded', function() {
    console.log('📄 DOM loaded, initializing admin panel...');
    initializeAdminPanel();
});

// Fallback initialization
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeAdminPanel);
} else {
    initializeAdminPanel();
}