﻿﻿﻿/*Copyright © 2025 Ridwan and Team*/
const socket = io();
const teamsContainer = document.getElementById("teams");
const TEAM_COUNT = 12;
let config = { plus: 5, minus: -2, timerDuration: 30 };
let lockState = { locked: false, activeTeam: null };

// ESP32 Status Tracking - DIPERBAIKI BESAR
let esp32Status = {
  connected: false,
  lastActivity: null,
  socketId: null,
  ip: null,
  connectionType: null
};

// Team Status Tracking
let teamStatus = Array(TEAM_COUNT).fill(true);

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

// Function untuk toggle status tim
function toggleTeamStatus(teamNumber) {
    teamStatus[teamNumber - 1] = !teamStatus[teamNumber - 1];
    
    const teamCard = document.querySelector(`.team-card[data-team="${teamNumber}"]`);
    const toggleBtn = document.getElementById(`toggle-${teamNumber}`);
    const badgeEl = document.getElementById(`badge-${teamNumber}`);
    
    if (teamCard && toggleBtn && badgeEl) {
        if (teamStatus[teamNumber - 1]) {
            teamCard.classList.remove('team-disabled');
            toggleBtn.textContent = 'NONAKTIFKAN';
            toggleBtn.classList.remove('toggle-off');
            toggleBtn.classList.add('toggle-on');
            badgeEl.textContent = "MENUNGGU";
            badgeEl.className = "team-status status-waiting";
        } else {
            teamCard.classList.add('team-disabled');
            toggleBtn.textContent = 'AKTIFKAN';
            toggleBtn.classList.remove('toggle-on');
            toggleBtn.classList.add('toggle-off');
            badgeEl.textContent = "NONAKTIF";
            badgeEl.className = "team-status status-disabled";
        }
    }
    
    fetch(`/toggleTeam?team=${teamNumber}&enabled=${teamStatus[teamNumber - 1]}`)
        .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then(data => {
            adminLogger.info(`Team ${getTeamLetter(teamNumber)} toggle updated on server`, data);
        })
        .catch(err => {
            adminLogger.error('Failed to update team toggle on server:', err);
            teamStatus[teamNumber - 1] = !teamStatus[teamNumber - 1];
        });
    
    adminLogger.info(`Team ${getTeamLetter(teamNumber)} ${teamStatus[teamNumber - 1] ? 'diaktifkan' : 'dinonaktifkan'}`);
    showNotification(`Tim ${getTeamLetter(teamNumber)} ${teamStatus[teamNumber - 1] ? 'diaktifkan' : 'dinonaktifkan'}`, "info");
}

function createTeamControls() {
    adminLogger.info('Creating 2-rows team controls UI with toggle');
    teamsContainer.innerHTML = '';
    teamsContainer.className = 'teams-two-rows-container';
    
    const firstRow = document.createElement('div');
    firstRow.className = 'teams-row first-row';
    
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
            <div class="team-controls">
                <button class="team-toggle toggle-on" id="toggle-${i}">
                    NONAKTIFKAN
                </button>
            </div>
        `;
        
        teamDiv.addEventListener('mouseenter', () => {
            if (teamStatus[i - 1]) {
                teamDiv.style.transform = 'translateY(-3px)';
                teamDiv.style.boxShadow = '0 8px 20px rgba(255, 215, 0, 0.2)';
            }
        });
        teamDiv.addEventListener('mouseleave', () => {
            teamDiv.style.transform = 'translateY(0)';
            teamDiv.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
        });
        
        const toggleBtn = teamDiv.querySelector(`#toggle-${i}`);
        if (toggleBtn) {
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleTeamStatus(i);
            });
        }
        
        if (i <= 6) {
            firstRow.appendChild(teamDiv);
        } else {
            secondRow.appendChild(teamDiv);
        }
    }
    
    teamsContainer.appendChild(firstRow);
    teamsContainer.appendChild(secondRow);
}

// Function untuk update ESP32 display - DIPERBAIKI BESAR
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
      
      let connectionText = `ONLINE - CONTROLLER AKTIF`;
      if (esp32Status.ip) connectionText += ` (${esp32Status.ip})`;
      if (esp32Status.connectionType) connectionText += ` - ${esp32Status.connectionType}`;
      
      esp32Connection.textContent = connectionText;
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
      const now = new Date();
      const timeDiff = Math.floor((now - activityDate) / 1000);
      
      let timeText = activityDate.toLocaleTimeString('id-ID') + " - " + activityDate.toLocaleDateString('id-ID');
      
      if (timeDiff < 10) {
        timeText += ` (BARU SAJA)`;
        esp32LastActivity.style.color = "#4caf50";
        esp32LastActivity.style.fontWeight = "bold";
      } else if (timeDiff < 60) {
        timeText += ` (${timeDiff} detik yang lalu)`;
        esp32LastActivity.style.color = "#ff9800";
        esp32LastActivity.style.fontWeight = "normal";
      } else if (timeDiff < 3600) {
        timeText += ` (${Math.floor(timeDiff / 60)} menit yang lalu)`;
        esp32LastActivity.style.color = "#ff9800";
        esp32LastActivity.style.fontWeight = "normal";
      } else {
        timeText += ` (${Math.floor(timeDiff / 3600)} jam yang lalu)`;
        esp32LastActivity.style.color = "#f44336";
        esp32LastActivity.style.fontWeight = "normal";
      }
      
      esp32LastActivity.textContent = timeText;
    } else {
      esp32LastActivity.textContent = "Belum ada aktivitas";
      esp32LastActivity.style.color = "#f44336";
    }
  }
  
  if (esp32SocketId) {
    esp32SocketId.textContent = esp32Status.socketId || "HTTP Connection";
  }
  
  adminLogger.esp32('Status Updated', esp32Status);
}

// Function untuk ESP32 controls - DIPERBAIKI BESAR
function initializeESP32Controls() {
  const refreshBtn = document.getElementById("refreshESP32");
  const testBtn = document.getElementById("testESP32");
  
  if (refreshBtn) {
    refreshBtn.addEventListener("click", refreshESP32Status);
  }
  
  if (testBtn) {
    testBtn.addEventListener("click", testESP32Connection);
  }
  
  // Auto-refresh status setiap 3 detik (lebih cepat)
  setInterval(refreshESP32Status, 3000);
  
  // Juga refresh saat halaman visible
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
      refreshESP32Status();
    }
  });
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
  
  // Test dengan mengirim HTTP request ke ESP32 checkin endpoint
  fetch('/esp32checkin?action=admin_test&team=0')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      adminLogger.esp32('ESP32 checkin test successful', data);
      showNotification("Test koneksi berhasil! ESP32 merespon.", "success");
      // Refresh status setelah test
      setTimeout(refreshESP32Status, 1000);
    })
    .catch(err => {
      adminLogger.error('ESP32 connection test failed:', err);
      showNotification("Test koneksi gagal! Periksa server.", "error");
    });
}

// Konfigurasi dengan error handling
document.getElementById("setConfig").addEventListener("click", () => {
    const plus = parseInt(document.getElementById("plus").value, 10);
    const minus = parseInt(document.getElementById("minus").value, 10);
    const timerDuration = parseInt(document.getElementById("timerDuration").value, 10);
    
    adminLogger.info('Configuration update requested', { plus, minus, timerDuration });
    
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

// Reset dengan reset status tim juga
function ensureSwal() {
    return new Promise((resolve) => {
        if (typeof Swal !== 'undefined') return resolve(true);

        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/sweetalert2@11';
        script.async = true;
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
    });
}

function showCustomConfirm(title, message) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.left = '0';
        overlay.style.top = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.background = 'rgba(0,0,0,0.5)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = '9999';

        const box = document.createElement('div');
        box.style.background = '#fff';
        box.style.borderRadius = '8px';
        box.style.padding = '20px';
        box.style.maxWidth = '420px';
        box.style.width = '90%';
        box.style.boxShadow = '0 8px 24px rgba(0,0,0,0.2)';
        box.style.textAlign = 'left';

        const t = document.createElement('h3');
        t.textContent = title || 'Konfirmasi';
        t.style.margin = '0 0 8px 0';

        const m = document.createElement('p');
        m.textContent = message || '';
        m.style.margin = '0 0 16px 0';
        m.style.color = '#333';

        const btnRow = document.createElement('div');
        btnRow.style.display = 'flex';
        btnRow.style.justifyContent = 'flex-end';
        btnRow.style.gap = '8px';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Batal';
        cancelBtn.style.padding = '8px 12px';
        cancelBtn.style.border = '1px solid #ccc';
        cancelBtn.style.background = '#fff';
        cancelBtn.style.borderRadius = '4px';

        const okBtn = document.createElement('button');
        okBtn.textContent = 'Ya, reset semua';
        okBtn.style.padding = '8px 12px';
        okBtn.style.border = 'none';
        okBtn.style.background = '#d32f2f';
        okBtn.style.color = '#fff';
        okBtn.style.borderRadius = '4px';

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);

        box.appendChild(t);
        box.appendChild(m);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        function cleanup() {
            if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }

        cancelBtn.addEventListener('click', () => {
            cleanup();
            resolve(false);
        });

        okBtn.addEventListener('click', () => {
            cleanup();
            resolve(true);
        });
    });
}

function doReset() {
    const btn = document.getElementById('reset');
    const originalInner = btn.dataset.originalInner || btn.innerHTML;
    btn.dataset.originalInner = originalInner;

    btn.disabled = true;
    btn.classList.add('loading');
    btn.innerHTML = '<span></span> MEMPROSES...';

    return fetch('/reset')
        .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then(data => {
            teamStatus = Array(TEAM_COUNT).fill(true);
            return fetch('/enableAllTeams');
        })
        .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then(data => {
            for (let i = 1; i <= TEAM_COUNT; i++) {
                const teamCard = document.querySelector(`.team-card[data-team="${i}"]`);
                const toggleBtn = document.getElementById(`toggle-${i}`);
                const badgeEl = document.getElementById(`badge-${i}`);

                if (teamCard && toggleBtn && badgeEl) {
                    teamCard.classList.remove('team-disabled');
                    toggleBtn.textContent = 'NONAKTIFKAN';
                    toggleBtn.classList.remove('toggle-off');
                    toggleBtn.classList.add('toggle-on');
                    badgeEl.textContent = "MENUNGGU";
                    badgeEl.className = "team-status status-waiting";
                }
            }

            adminLogger.info('Scores and team status reset successfully', data);
            return data;
        })
        .catch(err => {
            adminLogger.error('Reset error:', err);
            throw err;
        })
        .finally(() => {
            btn.disabled = false;
            btn.classList.remove('loading');
            btn.innerHTML = btn.dataset.originalInner || 'RESET SEMUA SKOR';
        });
}

document.getElementById("reset").addEventListener("click", () => {
    adminLogger.info('Reset scores requested');

    ensureSwal().then((available) => {
        if (!available) {
            showCustomConfirm('Yakin ingin mereset semua skor?', 'Semua skor akan diatur ke 0 dan semua tim akan diaktifkan kembali.').then(confirmed => {
                if (confirmed) doReset();
            });
            return;
        }

        const swalWithBootstrapButtons = Swal.mixin({
            customClass: {
                confirmButton: "btn btn-success",
                cancelButton: "btn btn-danger"
            },
            buttonsStyling: false
        });

        swalWithBootstrapButtons.fire({
            title: "Are you sure?",
            text: "You won't be able to revert this!",
            icon: "warning",
            showCancelButton: true,
            confirmButtonText: "Yes, reset it!",
            cancelButtonText: "No, cancel!",
            reverseButtons: true
        }).then((result) => {
            if (result.isConfirmed) {
                doReset()
                    .then(() => {
                        swalWithBootstrapButtons.fire({
                            title: "Reset!",
                            text: "All scores have been reset.",
                            icon: "success"
                        });
                    })
                    .catch(() => {
                        swalWithBootstrapButtons.fire({
                            title: "Failed",
                            text: "Failed to reset scores.",
                            icon: "error"
                        });
                    });
            } else if (result.dismiss === Swal.DismissReason.cancel) {
                swalWithBootstrapButtons.fire({
                    title: "Cancelled",
                    text: "Reset cancelled.",
                    icon: "error"
                });
            }
        }).catch(err => {
            adminLogger.error('SweetAlert error on reset:', err);
            showNotification('Terjadi kesalahan pada dialog konfirmasi', 'error');
        });
    });
});

// Unlock
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

// Event listeners untuk kontrol juri
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
    const juryPlus = document.getElementById("juryPlus");
    if (juryPlus && juryPlus.disabled) {
        adminLogger.warn('Jury plus clicked but button is disabled');
        return;
    }
    
    if (lockState.activeTeam) {
        if (!teamStatus[lockState.activeTeam - 1]) {
            showNotification(`Tim ${getTeamLetter(lockState.activeTeam)} sedang dinonaktifkan!`, "warning");
            return;
        }
        
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
    const juryMinus = document.getElementById("juryMinus");
    if (juryMinus && juryMinus.disabled) {
        adminLogger.warn('Jury minus clicked but button is disabled');
        return;
    }
    
    if (lockState.activeTeam) {
        if (!teamStatus[lockState.activeTeam - 1]) {
            showNotification(`Tim ${getTeamLetter(lockState.activeTeam)} sedang dinonaktifkan!`, "warning");
            return;
        }
        
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
                showNotification(`${config.minus} poin!`, "warning");
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

// Notification system
function showNotification(message, type = "success") {
    const existingNotification = document.querySelector('.admin-notification');
    if (existingNotification) {
        existingNotification.remove();
    }
    
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
    
    if (activity.activity && activity.activity.type === 'buzzer') {
        showNotification(`ESP32: Tombol ditekan - Tim ${getTeamLetter(activity.activity.team)}`, "info");
    } else if (activity.activity && activity.activity.type === 'heartbeat') {
        adminLogger.esp32('Heartbeat received', activity);
    }
});

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
    const juryPlus = document.getElementById("juryPlus");
    const juryMinus = document.getElementById("juryMinus");

    if (unlockBtn) {
        unlockBtn.textContent = state.locked ? 
            `Buka Kunci (Tim ${getTeamLetter(state.activeTeam)} Aktif)` : 
            "Buka Kunci Tombol";
        unlockBtn.disabled = !state.locked;
    }

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
        
        if (juryPlus) juryPlus.disabled = false;
        if (juryMinus) juryMinus.disabled = false;
        
        adminLogger.info('Team activated', { activeTeam: state.activeTeam });
    } else {
        if (juryControls) {
            juryControls.style.display = "none";
            juryControls.classList.remove('active');
        }
        if (waitingLabel) waitingLabel.style.display = "block";
        if (activeTeamLabel) activeTeamLabel.style.display = "none";
        
        if (juryPlus) juryPlus.disabled = true;
        if (juryMinus) juryMinus.disabled = true;
        
        adminLogger.info('All teams unlocked');
    }

    for (let i = 1; i <= TEAM_COUNT; i++) {
        const badgeEl = document.getElementById(`badge-${i}`);
        const teamCard = document.querySelector(`.team-card[data-team="${i}"]`);
        
        if (badgeEl) {
            if (!teamStatus[i - 1]) {
                badgeEl.textContent = "NONAKTIF";
                badgeEl.className = "team-status status-disabled";
                if (teamCard) teamCard.classList.add('team-disabled');
            } else if (state.locked && state.activeTeam === i) {
                badgeEl.textContent = "AKTIF";
                badgeEl.className = "team-status status-active";
                if (teamCard) teamCard.classList.add('active');
                if (teamCard) teamCard.classList.remove('team-disabled');
            } else {
                badgeEl.textContent = "MENUNGGU";
                badgeEl.className = "team-status status-waiting";
                if (teamCard) teamCard.classList.remove('active');
                if (teamCard) teamCard.classList.remove('team-disabled');
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
    initializeESP32Controls();
    updateTimerStatus('TIDAK AKTIF', 0);
    
    // Load initial ESP32 status
    refreshESP32Status();
    
    Promise.all([
        fetch('/lockstate').then(r => {
            if (!r.ok) throw new Error('Failed to fetch lockstate');
            return r.json();
        }),
        fetch('/scores').then(r => {
            if (!r.ok) throw new Error('Failed to fetch scores');
            return r.json();
        }),
        fetch('/esp32status').then(r => {
            if (!r.ok) throw new Error('Failed to fetch ESP32 status');
            return r.json();
        }),
        fetch('/teamToggleState').then(r => {
            if (!r.ok) throw new Error('Failed to fetch team toggle state');
            return r.json();
        })
    ]).then(([lockStateData, scoresData, esp32Data, toggleStateData]) => {
        lockState = lockStateData;
        
        if (Array.isArray(toggleStateData)) {
            teamStatus = toggleStateData;
        }
        
        adminLogger.info('Initial data loaded', { 
            lockState: lockStateData, 
            scores: scoresData,
            esp32: esp32Data,
            teamToggleState: toggleStateData
        });
        
        for (let i = 1; i <= TEAM_COUNT; i++) {
            const scoreEl = document.getElementById(`score-${i}`);
            if (scoreEl) {
                scoreEl.textContent = scoresData[i-1];
            }
        }
        
        for (let i = 1; i <= TEAM_COUNT; i++) {
            const teamCard = document.querySelector(`.team-card[data-team="${i}"]`);
            const toggleBtn = document.getElementById(`toggle-${i}`);
            const badgeEl = document.getElementById(`badge-${i}`);
            
            if (teamCard && toggleBtn && badgeEl) {
                if (teamStatus[i - 1]) {
                    teamCard.classList.remove('team-disabled');
                    toggleBtn.textContent = 'NONAKTIFKAN';
                    toggleBtn.classList.remove('toggle-off');
                    toggleBtn.classList.add('toggle-on');
                    badgeEl.textContent = "MENUNGGU";
                    badgeEl.className = "team-status status-waiting";
                } else {
                    teamCard.classList.add('team-disabled');
                    toggleBtn.textContent = 'AKTIFKAN';
                    toggleBtn.classList.remove('toggle-on');
                    toggleBtn.classList.add('toggle-off');
                    badgeEl.textContent = "NONAKTIF";
                    badgeEl.className = "team-status status-disabled";
                }
            }
        }
        
        updateESP32Status(esp32Data);
        
    }).catch(err => {
        adminLogger.error('Failed to load initial data:', err);
        showNotification("Gagal memuat data awal!", "error");
    });
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    adminLogger.info('Admin panel initializing...');
    adminLogger.esp32('ESP32 monitoring system activated');
    initializeAdmin();
    try {
        if (typeof Swal === 'undefined') {
            adminLogger.warn('SweetAlert2 tidak terdeteksi pada saat load. Mungkin diblokir atau gagal dimuat.');
            showNotification('SweetAlert2 tidak ter-load; menggunakan fallback.', 'warning');
        } else {
            adminLogger.info('SweetAlert2 tersedia.');
        }
    } catch (e) {
        console.error('Error checking Swal availability', e);
    }
});