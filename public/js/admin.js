const socket = io();
const teamsContainer = document.getElementById("teams");
const TEAM_COUNT = 12;
let config = { plus: 5, minus: -2, timerDuration: 30 };
let lockState = { locked: false, activeTeam: null };

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
    return String.fromCharCode(65 + index - 1);
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

// Konfigurasi
document.getElementById("setConfig").addEventListener("click", () => {
    const plus = parseInt(document.getElementById("plus").value, 10);
    const minus = parseInt(document.getElementById("minus").value, 10);
    const timerDuration = parseInt(document.getElementById("timerDuration").value, 10);
    
    adminLogger.info('Configuration update requested', { plus, minus, timerDuration });
    
    fetch(`/setconfig?plus=${plus}&minus=${minus}&timerDuration=${timerDuration}`)
        .then(r => {
            if (r.ok) {
                config.plus = plus;
                config.minus = minus;
                config.timerDuration = timerDuration;
                updateConfigDisplay();
                adminLogger.info('Configuration updated successfully', config);
                alert("Config disimpan");
            } else {
                adminLogger.error('Configuration update failed', { status: r.statusText });
                alert("Gagal menyimpan config");
            }
        })
        .catch(err => {
            adminLogger.error('Configuration update error:', err);
            alert("Error menyimpan config");
        });
});

function updateConfigDisplay() {
    document.getElementById("plusValue").textContent = config.plus;
    document.getElementById("minusValue").textContent = config.minus;
    adminLogger.info('Config display updated', config);
}

// Reset
document.getElementById("reset").addEventListener("click", () => {
    adminLogger.info('Reset scores requested');
    if (confirm("Yakin reset semua skor ke 0?")) {
        fetch('/reset')
            .then(() => adminLogger.info('Scores reset successfully'))
            .catch(err => adminLogger.error('Reset error:', err));
    }
});

// Unlock
document.getElementById("unlock").addEventListener("click", () => {
    adminLogger.info('Manual unlock requested');
    fetch('/unlock')
        .then(() => adminLogger.info('Manual unlock applied'))
        .catch(err => adminLogger.error('Unlock error:', err));
});

// Event listeners untuk kontrol juri (yang sudah ada di HTML)
document.getElementById("juryPlus")?.addEventListener("click", () => {
    if (lockState.activeTeam) {
        adminLogger.info('Jury plus clicked', { 
            activeTeam: lockState.activeTeam, 
            points: config.plus 
        });
        fetch(`/update?team=${lockState.activeTeam}&add=${config.plus}`)
            .then(() => adminLogger.info('Jury plus applied'))
            .catch(err => adminLogger.error('Jury plus error:', err));
    } else {
        adminLogger.warn('Jury plus clicked but no active team');
        alert("Tidak ada tim yang aktif. Tunggu hingga ada tim menekan tombol.");
    }
});

document.getElementById("juryMinus")?.addEventListener("click", () => {
    if (lockState.activeTeam) {
        adminLogger.info('Jury minus clicked', { 
            activeTeam: lockState.activeTeam, 
            points: config.minus 
        });
        fetch(`/update?team=${lockState.activeTeam}&add=${config.minus}`)
            .then(() => adminLogger.info('Jury minus applied'))
            .catch(err => adminLogger.error('Jury minus error:', err));
    } else {
        adminLogger.warn('Jury minus clicked but no active team');
        alert("Tidak ada tim yang aktif. Tunggu hingga ada tim menekan tombol.");
    }
});

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
        timerState.className = 'timer-state-' + state.toLowerCase();
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

// Socket events
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

// Initialize
createTeamControls();
updateTimerStatus('TIDAK AKTIF', 0);

// Load initial data
fetch('/lockstate').then(r => r.json()).then(state => {
    lockState = state;
    adminLogger.info('Initial lock state loaded', state);
});

fetch('/scores').then(r => r.json()).then(scores => {
    adminLogger.info('Initial scores loaded', { scores });
    for (let i = 1; i <= TEAM_COUNT; i++) {
        const scoreEl = document.getElementById(`score-${i}`);
        if (scoreEl) {
            scoreEl.textContent = scores[i-1];
        }
    }
});