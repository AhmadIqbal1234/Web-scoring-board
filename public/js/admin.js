﻿/*Copyright © 2025 Ridwan and Team*/
const socket = io();
const teamsContainer = document.getElementById("teams");
const TEAM_COUNT = 12;
let config = { plus: 5, minus: -2, timerDuration: 30 };
let lockState = { locked: false, activeTeam: null };

// ESP32 Status Tracking
let esp32Status = {
  connected: false,
  lastActivity: null,
  socketId: null,
  ip: null
};

// Admin Logger
const adminLogger = {
  info: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[ADMIN:${timestamp}] ${message}`, data || '');
  },
  
  warn: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[ADMIN:${timestamp}] ${message}`, data || '');
  },
  
  error: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[ADMIN:${timestamp}] ${message}`, data || '');
  },
  
  event: (eventName, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[ADMIN:${timestamp}] EVENT: ${eventName}`, data || '');
  },
  
  esp32: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[ADMIN:${timestamp}] ESP32: ${message}`, data || '');
  }
};

// Connection status
const statusDot = document.querySelector('.status-dot');
const connectionStatus = document.querySelector('.connection-status-bar');

socket.on("connect", () => {
    adminLogger.info('Admin connected to server');
    if (statusDot) statusDot.style.background = '#4caf50';
    if (connectionStatus) {
        connectionStatus.style.background = '#2e7d32';
        connectionStatus.textContent = 'TERHUBUNG KE SERVER - ONLINE';
    }
});

socket.on("disconnect", () => {
    adminLogger.warn('Admin disconnected from server');
    if (statusDot) statusDot.style.background = '#f44336';
    if (connectionStatus) {
        connectionStatus.style.background = '#c62828';
        connectionStatus.textContent = 'TERPUTUS DARI SERVER - OFFLINE';
    }
});

function getTeamLetter(index) {
    return String.fromCharCode(64 + index);
}

function createTeamControls() {
    adminLogger.info('Creating 2-rows team controls UI');
    teamsContainer.innerHTML = '';
    teamsContainer.className = 'teams-two-rows-container';
    
    // Create first row (Teams 1-6)
    const firstRow = document.createElement('div');
    firstRow.className = 'teams-row first-row';
    
    // Create second row (Teams 7-12)
    const secondRow = document.createElement('div');
    secondRow.className = 'teams-row second-row';
    
    for (let i = 1; i <= TEAM_COUNT; i++) {
        const teamDiv = document.createElement("div");
        teamDiv.className = "team-card team-card-compact";
        teamDiv.setAttribute('data-team', i);
        teamDiv.innerHTML = `
            <div class="team-header">
                <div class="team-name">Tim ${getTeamLetter(i)}</div>
                <div class="team-status status-waiting" id="badge-${i}">MENUNGGU</div>
            </div>
            <div class="team-score-display">
                <div class="team-score" id="score-${i}">0</div>
            </div>
        `;
        
        // Add hover effect
        teamDiv.style.cursor = 'pointer';
        teamDiv.addEventListener('mouseenter', () => {
            teamDiv.style.transform = 'translateY(-3px)';
            teamDiv.style.boxShadow = '0 8px 20px rgba(255, 215, 0, 0.2)';
        });
        teamDiv.addEventListener('mouseleave', () => {
            teamDiv.style.transform = 'translateY(0)';
            teamDiv.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
        });
        
        // Distribute teams between two rows
        if (i <= 6) {
            firstRow.appendChild(teamDiv);
        } else {
            secondRow.appendChild(teamDiv);
        }
    }
    
    teamsContainer.appendChild(firstRow);
    teamsContainer.appendChild(secondRow);
}

// Function untuk update ESP32 display - DIPERBAIKI
function updateESP32Status(status) {
  const esp32Badge = document.getElementById("esp32Badge");
  const esp32Connection = document.getElementById("esp32Connection");
  const esp32LastActivity = document.getElementById("esp32LastActivity");
  const esp32SocketId = document.getElementById("esp32SocketId");
  
  esp32Status = { ...esp32Status, ...status };
  
  if (esp32Badge) {
    if (esp32Status.connected) {
      esp32Badge.textContent = "TERHUBUNG";
      esp32Badge.className = "controller-badge connected";
      esp32Connection.textContent = `ONLINE - CONTROLLER AKTIF ${esp32Status.ip ? '(' + esp32Status.ip + ')' : ''}`;
      esp32Connection.style.color = "#4caf50";
    } else {
      esp32Badge.textContent = "TERPUTUS";
      esp32Badge.className = "controller-badge disconnected";
      esp32Connection.textContent = "OFFLINE - CONTROLLER TIDAK AKTIF";
      esp32Connection.style.color = "#f44336";
    }
  }
  
  if (esp32LastActivity) {
    if (esp32Status.lastActivity) {
      const activityDate = new Date(esp32Status.lastActivity);
      esp32LastActivity.textContent = activityDate.toLocaleTimeString('id-ID') + 
        " - " + activityDate.toLocaleDateString('id-ID');
    } else {
      esp32LastActivity.textContent = "Belum ada aktivitas";
    }
  }
  
  if (esp32SocketId) {
    esp32SocketId.textContent = esp32Status.socketId || "-";
  }
  
  adminLogger.esp32('Status Updated', esp32Status);
}

// Function untuk ESP32 controls
function initializeESP32Controls() {
  const refreshBtn = document.getElementById("refreshESP32");
  const testBtn = document.getElementById("testESP32");
  
  if (refreshBtn) {
    refreshBtn.addEventListener("click", refreshESP32Status);
  }
  
  if (testBtn) {
    testBtn.addEventListener("click", testESP32Connection);
  }
}

function refreshESP32Status() {
  adminLogger.esp32('Manual status refresh requested');
  
  fetch('/esp32status')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      updateESP32Status(data);
      showNotification("Status ESP32 diperbarui!", "success");
    })
    .catch(err => {
      adminLogger.error('ESP32 status refresh error:', err);
      showNotification("Gagal memuat status ESP32!", "error");
    });
}

function testESP32Connection() {
  adminLogger.esp32('Connection test requested');
  
  if (!esp32Status.connected) {
    showNotification("ESP32 tidak terhubung! Periksa koneksi jaringan.", "error");
    return;
  }
  
  // Kirim test event ke ESP32 jika terhubung
  socket.emit("testConnection", {
    type: "adminTest",
    timestamp: new Date().toISOString(),
    message: "Test connection from admin panel"
  });
  
  showNotification("Test koneksi dikirim ke ESP32!", "success");
}

// Konfigurasi - DIPERBAIKI dengan error handling
document.getElementById("setConfig").addEventListener("click", () => {
    const plus = parseInt(document.getElementById("plus").value, 10);
    const minus = parseInt(document.getElementById("minus").value, 10);
    const timerDuration = parseInt(document.getElementById("timerDuration").value, 10);
    
    adminLogger.info('Configuration update requested', { plus, minus, timerDuration });
    
    // Validasi input
    if (isNaN(plus) || isNaN(minus) || isNaN(timerDuration)) {
        showNotification("Input konfigurasi tidak valid!", "error");
        return;
    }
    
    fetch(`/setconfig?plus=${plus}&minus=${minus}&timerDuration=${timerDuration}`)
        .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then(data => {
            config.plus = plus;
            config.minus = minus;
            config.timerDuration = timerDuration;
            updateConfigDisplay();
            adminLogger.info('Configuration updated successfully', config);
            showNotification("Konfigurasi berhasil disimpan!", "success");
        })
        .catch(err => {
            adminLogger.error('Configuration update error:', err);
            showNotification("Gagal menyimpan konfigurasi!", "error");
        });
});

function updateConfigDisplay() {
    document.getElementById("plusValue").textContent = config.plus;
    document.getElementById("minusValue").textContent = config.minus;
    adminLogger.info('Config display updated', config);
}

// Reset - DIPERBAIKI
document.getElementById("reset").addEventListener("click", () => {
    adminLogger.info('Reset scores requested');
    if (confirm("Yakin reset semua skor ke 0?")) {
        fetch('/reset')
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(data => {
                adminLogger.info('Scores reset successfully', data);
                showNotification("Semua skor berhasil direset!", "success");
            })
            .catch(err => {
                adminLogger.error('Reset error:', err);
                showNotification("Gagal reset skor!", "error");
            });
    }
});

// Unlock - DIPERBAIKI
document.getElementById("unlock").addEventListener("click", () => {
    adminLogger.info('Manual unlock requested');
    fetch('/unlock')
        .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then(data => {
            adminLogger.info('Manual unlock applied', data);
            showNotification("Sistem berhasil dibuka!", "success");
        })
        .catch(err => {
            adminLogger.error('Unlock error:', err);
            showNotification("Gagal membuka sistem!", "error");
        });
});

// Event listeners untuk kontrol juri - DIPERBAIKI DENGAN ERROR HANDLING
function initializeJuryControls() {
    const juryPlus = document.getElementById("juryPlus");
    const juryMinus = document.getElementById("juryMinus");
    
    if (juryPlus) {
        juryPlus.addEventListener("click", handleJuryPlus);
    } else {
        adminLogger.error('Jury Plus button not found!');
    }
    
    if (juryMinus) {
        juryMinus.addEventListener("click", handleJuryMinus);
    } else {
        adminLogger.error('Jury Minus button not found!');
    }
}

function handleJuryPlus() {
    if (lockState.activeTeam) {
        adminLogger.info('Jury plus clicked', { 
            activeTeam: lockState.activeTeam, 
            points: config.plus 
        });
        
        fetch(`/update?team=${lockState.activeTeam}&add=${config.plus}`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status} - ${r.statusText}`);
                return r.text();
            })
            .then(data => {
                adminLogger.info('Jury plus applied', data);
                showNotification(`+${config.plus} poin!`, "success");
            })
            .catch(err => {
                adminLogger.error('Jury plus error:', err);
                showNotification(`Gagal memberikan poin! Error: ${err.message}`, "error");
            });
    } else {
        adminLogger.warn('Jury plus clicked but no active team');
        showNotification("Tidak ada tim yang aktif! Tekan tombol tim terlebih dahulu.", "warning");
    }
}

function handleJuryMinus() {
    if (lockState.activeTeam) {
        adminLogger.info('Jury minus clicked', { 
            activeTeam: lockState.activeTeam, 
            points: config.minus 
        });
        
        fetch(`/update?team=${lockState.activeTeam}&add=${config.minus}`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status} - ${r.statusText}`);
                return r.text();
            })
            .then(data => {
                adminLogger.info('Jury minus applied', data);
                showNotification(`Tim ${getTeamLetter(lockState.activeTeam)} ${config.minus} poin!`, "warning");
            })
            .catch(err => {
                adminLogger.error('Jury minus error:', err);
                showNotification(`Gagal mengurangi poin! Error: ${err.message}`, "error");
            });
    } else {
        adminLogger.warn('Jury minus clicked but no active team');
        showNotification("Tidak ada tim yang aktif! Tekan tombol tim terlebih dahulu.", "warning");
    }
}

// Notification system - DIPERBAIKI
function showNotification(message, type = "success") {
    // Remove existing notification
    const existingNotification = document.querySelector('.admin-notification');
    if (existingNotification) {
        existingNotification.remove();
    }
    
    const notification = document.createElement('div');
    notification.className = `admin-notification ${type}`;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    // Show notification
    setTimeout(() => {
        notification.classList.add('show');
    }, 100);
    
    // Auto hide after 3 seconds
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 500);
    }, 3000);
}

// Socket events untuk timer
socket.on("timerStart", (data) => {
    adminLogger.event('timerStart', data);
    updateTimerStatus('BERJALAN', data.duration);
});

socket.on("timerUpdate", (data) => {
    adminLogger.event('timerUpdate', data);
    updateTimerStatus('BERJALAN', data.timeRemaining);
});

socket.on("timerEnd", () => {
    adminLogger.event('timerEnd');
    updateTimerStatus('SELESAI', 0);
});

socket.on("timerReset", () => {
    adminLogger.event('timerReset');
    updateTimerStatus('TIDAK AKTIF', 0);
});

function updateTimerStatus(state, seconds) {
    const timerState = document.getElementById("timerState");
    const currentTime = document.getElementById("currentTime");
    
    if (timerState) {
        timerState.textContent = state;
        timerState.className = 'timer-state-' + state.toLowerCase().replace(' ', '-');
    }
    
    if (currentTime) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        currentTime.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        
        // Update color based on time
        if (seconds <= 10) {
            currentTime.style.color = '#f44336';
        } else if (seconds <= 30) {
            currentTime.style.color = '#ff9800';
        } else {
            currentTime.style.color = '#4caf50';
        }
    }
    
    adminLogger.info('Timer status updated', { state, seconds });
}

//Socket events untuk ESP32 - DIPERBAIKI
socket.on("esp32Status", (status) => {
    adminLogger.event('esp32Status', status);
    updateESP32Status(status);
});

socket.on("esp32Activity", (activity) => {
    adminLogger.event('esp32Activity', activity);
    updateESP32Status({
        lastActivity: activity.timestamp,
        socketId: activity.socketId,
        ip: activity.ip
    });
    
    // Tampilkan notifikasi untuk aktivitas penting
    if (activity.activity && activity.activity.type === 'buzzer') {
        showNotification(`ESP32: Tombol ditekan - Tim ${getTeamLetter(activity.activity.team)}`, "info");
    } else if (activity.activity && activity.activity.type === 'heartbeat') {
        // Tidak perlu notifikasi untuk heartbeat, hanya log
        adminLogger.esp32('Heartbeat received', activity);
    }
});

// Socket events - DIPERBAIKI
socket.on("config", (c) => {
    adminLogger.event('config', c);
    config = c;
    document.getElementById("plus").value = c.plus;
    document.getElementById("minus").value = c.minus;
    document.getElementById("timerDuration").value = c.timerDuration;
    updateConfigDisplay();
});

socket.on("lockstate", (state) => {
    adminLogger.event('lockstate', state);
    lockState = state;
    
    const unlockBtn = document.getElementById("unlock");
    const juryControls = document.getElementById("juryControls");
    const waitingLabel = document.getElementById("waitingLabel");
    const activeTeamLabel = document.getElementById("activeTeamLabel");

    if (unlockBtn) {
        unlockBtn.textContent = state.locked ? 
            `Buka Kunci (Tim ${getTeamLetter(state.activeTeam)} Aktif)` : 
            "Buka Kunci Tombol";
        unlockBtn.disabled = !state.locked;
    }

    // Update tampilan kontrol juri
    if (state.locked && state.activeTeam) {
        if (juryControls) {
            juryControls.style.display = "flex";
            juryControls.classList.add('active');
        }
        if (waitingLabel) waitingLabel.style.display = "none";
        if (activeTeamLabel) {
            activeTeamLabel.textContent = `Tim ${getTeamLetter(state.activeTeam)} Sedang Aktif`;
            activeTeamLabel.style.display = "block";
        }
        adminLogger.info('Team activated', { activeTeam: state.activeTeam });
    } else {
        if (juryControls) {
            juryControls.style.display = "none";
            juryControls.classList.remove('active');
        }
        if (waitingLabel) waitingLabel.style.display = "block";
        if (activeTeamLabel) activeTeamLabel.style.display = "none";
        adminLogger.info('All teams unlocked');
    }

    // Update team badges
    for (let i = 1; i <= TEAM_COUNT; i++) {
        const badgeEl = document.getElementById(`badge-${i}`);
        const teamCard = document.querySelector(`.team-card[data-team="${i}"]`);
        
        if (badgeEl) {
            if (state.locked && state.activeTeam === i) {
                badgeEl.textContent = "AKTIF";
                badgeEl.className = "team-status status-active";
                if (teamCard) teamCard.classList.add('active');
            } else {
                badgeEl.textContent = "MENUNGGU";
                badgeEl.className = "team-status status-waiting";
                if (teamCard) teamCard.classList.remove('active');
            }
        }
    }
});

socket.on("update", (payload) => {
    adminLogger.event('update', payload);
    const { team, score } = payload;
    const scoreEl = document.getElementById(`score-${team}`);
    if (scoreEl) {
        scoreEl.textContent = score;
        scoreEl.classList.add('score-update');
        setTimeout(() => scoreEl.classList.remove('score-update'), 600);
    }
});

socket.on("reset", (scores) => {
    adminLogger.event('reset', { scores });
    for (let i = 1; i <= TEAM_COUNT; i++) {
        const scoreEl = document.getElementById(`score-${i}`);
        if (scoreEl) {
            scoreEl.textContent = scores[i-1];
            scoreEl.classList.add('score-update');
            setTimeout(() => scoreEl.classList.remove('score-update'), 600);
        }
    }
});

// Initialize - DIPERBAIKI
function initializeAdmin() {
    createTeamControls();
    initializeJuryControls();
    initializeESP32Controls(); // Initialize ESP32 controls
    updateTimerStatus('TIDAK AKTIF', 0);
    refreshESP32Status(); // Load initial ESP32 status
    
    // Load initial data dengan error handling
    Promise.all([
        fetch('/lockstate').then(r => {
            if (!r.ok) throw new Error('Failed to fetch lockstate');
            return r.json();
        }),
        fetch('/scores').then(r => {
            if (!r.ok) throw new Error('Failed to fetch scores');
            return r.json();
        }),
        fetch('/esp32status').then(r => { //Load ESP32 status
            if (!r.ok) throw new Error('Failed to fetch ESP32 status');
            return r.json();
        })
    ]).then(([lockStateData, scoresData, esp32Data]) => {
        lockState = lock32Data;
        adminLogger.info('Initial data loaded', { 
            lockState: lockStateData, 
            scores: scoresData,
            esp32: esp32Data 
        });
        
        // Update scores display
        for (let i = 1; i <= TEAM_COUNT; i++) {
            const scoreEl = document.getElementById(`score-${i}`);
            if (scoreEl) {
                scoreEl.textContent = scoresData[i-1];
            }
        }
        
        // Update ESP32 status
        updateESP32Status(esp32Data);
        
    }).catch(err => {
        adminLogger.error('Failed to load initial data:', err);
        showNotification("Gagal memuat data awal!", "error");
    });
}

// Add CSS for notification
const notificationStyles = `
.admin-notification {
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%) translateY(-100px);
    background: #4caf50;
    color: white;
    padding: 1.2rem 2rem;
    border-radius: 10px;
    font-weight: 700;
    z-index: 10000;
    box-shadow: 0 8px 25px rgba(0, 0, 0, 0.4);
    transition: all 0.5s cubic-bezier(0.68, -0.55, 0.265, 1.55);
    text-align: center;
    min-width: 300px;
    font-size: 1.1rem;
}

.admin-notification.show {
    transform: translateX(-50%) translateY(0);
}

.admin-notification.error {
    background: #f44336;
}

.admin-notification.warning {
    background: #ff9800;
    color: #000;
}

.admin-notification.success {
    background: #4caf50;
}

.admin-notification.info {
    background: #2196f3;
}
`;

// Inject styles
const styleSheet = document.createElement('style');
styleSheet.textContent = notificationStyles;
document.head.appendChild(styleSheet);

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    adminLogger.info('Admin panel initializing...');
    adminLogger.esp32('ESP32 monitoring system activated');
    initializeAdmin();
});