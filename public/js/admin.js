﻿/* Copyright © 2025 Ridwan and Team */
const socket = io();
const teamsContainer = document.getElementById("teams");
const TEAM_COUNT = 12;
let config = { plus: 5, minus: -2, timerDuration: 30 };
let lockState = { locked: false, activeTeam: null };

// ===== STATUS ESP32 =====
let esp32Status = {
  connected: false,
  lastActivity: null,
  socketId: null,
  ip: null,
  connectionType: null
};

// ===== STATUS TIM =====
let teamStatus = Array(TEAM_COUNT).fill(true);
let autoPenaltyEnabled = true;

// ===== DEBUG PANEL =====
const debugPanel = document.createElement('div');
debugPanel.id = 'debugPanel';
debugPanel.style.cssText = `
  position: fixed;
  bottom: 10px;
  left: 10px;
  background: rgba(0,0,0,0.8);
  color: white;
  padding: 10px;
  border-radius: 5px;
  font-family: monospace;
  font-size: 12px;
  max-width: 300px;
  max-height: 200px;
  overflow: auto;
  z-index: 10000;
  display: none;
`;
document.body.appendChild(debugPanel);

// ===== SISTEM LOG ADMIN =====
const adminLogger = {
  info: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    const logMsg = `[ADMIN:${timestamp}] ${message}`;
    console.log(logMsg, data || '');
    debugLog(logMsg);
  },
  
  warn: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    const logMsg = `[ADMIN:${timestamp}] ${message}`;
    console.warn(logMsg, data || '');
    debugLog(`⚠️ ${logMsg}`);
  },
  
  error: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    const logMsg = `[ADMIN:${timestamp}] ${message}`;
    console.error(logMsg, data || '');
    debugLog(`❌ ${logMsg}`);
  },
  
  event: (eventName, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    const logMsg = `[ADMIN:${timestamp}] EVENT: ${eventName}`;
    console.log(logMsg, data || '');
    debugLog(`📡 ${logMsg}`);
  },
  
  esp32: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    const logMsg = `[ADMIN:${timestamp}] ESP32: ${message}`;
    console.log(logMsg, data || '');
    debugLog(`🤖 ${logMsg}`);
  }
};

// Fungsi untuk log ke debug panel
function debugLog(message) {
  const debugPanel = document.getElementById('debugPanel');
  if (debugPanel) {
    const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
    debugPanel.innerHTML += `[${time}] ${message}<br>`;
    debugPanel.scrollTop = debugPanel.scrollHeight;
    
    // Tampilkan debug panel jika ada error
    if (message.includes('ERROR') || message.includes('FAILED')) {
      debugPanel.style.display = 'block';
    }
  }
}

// ===== STATUS KONEKSI =====
const statusDot = document.querySelector('.status-dot');
const connectionStatus = document.querySelector('.connection-status-bar');

socket.on("connect", () => {
    adminLogger.info('Admin terhubung ke server');
    if (statusDot) statusDot.style.background = '#4caf50';
    if (connectionStatus) {
        connectionStatus.style.background = '#2e7d32';
        connectionStatus.textContent = 'TERHUBUNG KE SERVER - ONLINE';
    }
    
    // Request initial data
    socket.emit("getESP32Status");
    socket.emit("getTimerStatus");
});

socket.on("disconnect", () => {
    adminLogger.warn('Admin terputus dari server');
    if (statusDot) statusDot.style.background = '#f44336';
    if (connectionStatus) {
        connectionStatus.style.background = '#c62828';
        connectionStatus.textContent = 'TERPUTUS DARI SERVER - OFFLINE';
    }
});

// ===== FUNGSI BANTU =====
function getTeamLetter(index) {
    return String.fromCharCode(64 + index);
}

// ===== TOGGLE STATUS TIM =====
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
            adminLogger.info(`Tim ${getTeamLetter(teamNumber)} toggle diperbarui di server`, data);
        })
        .catch(err => {
            adminLogger.error('Gagal update toggle tim di server:', err);
            teamStatus[teamNumber - 1] = !teamStatus[teamNumber - 1];
        });
    
    adminLogger.info(`Tim ${getTeamLetter(teamNumber)} ${teamStatus[teamNumber - 1] ? 'diaktifkan' : 'dinonaktifkan'}`);
    showNotification(`Tim ${getTeamLetter(teamNumber)} ${teamStatus[teamNumber - 1] ? 'diaktifkan' : 'dinonaktifkan'}`, "info");
}

// ===== MEMBUAT KONTROL TIM =====
function createTeamControls() {
    adminLogger.info('Membuat UI kontrol tim 2 baris dengan toggle');
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

// ===== UPDATE STATUS ESP32 =====
function updateESP32Status(status) {
  const esp32Badge = document.getElementById("esp32Badge");
  const esp32Connection = document.getElementById("esp32Connection");
  const esp32LastActivity = document.getElementById("esp32LastActivity");
  const esp32SocketId = document.getElementById("esp32SocketId");
  
  const sebelumnyaOnline = esp32Status.connected;
  const sekarangOnline = status.connected;
  
  esp32Status = { ...esp32Status, ...status };
  
  if (esp32Badge) {
    if (esp32Status.connected) {
      esp32Badge.textContent = "TERHUBUNG";
      esp32Badge.className = "controller-badge connected";
      esp32Badge.style.animation = "pulse 2s infinite";
      
      let connectionText = `ONLINE - CONTROLLER AKTIF`;
      if (esp32Status.ip) connectionText += ` (${esp32Status.ip})`;
      if (esp32Status.connectionType) connectionText += ` - ${esp32Status.connectionType}`;
      
      esp32Connection.textContent = connectionText;
      esp32Connection.style.color = "#4caf50";
    } else {
      esp32Badge.textContent = "TERPUTUS";
      esp32Badge.className = "controller-badge disconnected";
      esp32Badge.style.animation = "none";
      
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
        timeText += ` (${timeDiff} detik lalu)`;
        esp32LastActivity.style.color = "#ff9800";
        esp32LastActivity.style.fontWeight = "normal";
      } else if (timeDiff < 3600) {
        timeText += ` (${Math.floor(timeDiff / 60)} menit lalu)`;
        esp32LastActivity.style.color = "#ff9800";
        esp32LastActivity.style.fontWeight = "normal";
      } else {
        timeText += ` (${Math.floor(timeDiff / 3600)} jam lalu)`;
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
    esp32SocketId.textContent = esp32Status.socketId || "Koneksi HTTP";
  }
  
  // Update timestamp
  updateESP32Timestamp();
  
  // Hanya tampilkan notifikasi jika status berubah
  if (sebelumnyaOnline !== sekarangOnline) {
    const pesan = sekarangOnline ? 
      "ESP32 terhubung!" : 
      "ESP32 terputus!";
    const tipe = sekarangOnline ? "success" : "error";
    
    showNotification(pesan, tipe);
    adminLogger.esp32(`Status Berubah: ${sebelumnyaOnline ? 'ONLINE' : 'OFFLINE'} → ${sekarangOnline ? 'ONLINE' : 'OFFLINE'}`);
  }
}

// ===== FUNGSI BARU: UPDATE TIMESTAMP ESP32 =====
function updateESP32Timestamp() {
  const now = new Date();
  const lastActivity = esp32Status.lastActivity ? new Date(esp32Status.lastActivity) : null;
  
  if (lastActivity) {
    const timeDiff = Math.floor((now - lastActivity) / 1000);
    const timestampElement = document.getElementById("esp32Timestamp");
    
    if (timestampElement) {
      if (timeDiff < 10) {
        timestampElement.textContent = "Baru saja";
        timestampElement.style.color = "#4caf50";
      } else if (timeDiff < 60) {
        timestampElement.textContent = `${timeDiff} detik lalu`;
        timestampElement.style.color = "#ff9800";
      } else if (timeDiff < 3600) {
        timestampElement.textContent = `${Math.floor(timeDiff / 60)} menit lalu`;
        timestampElement.style.color = "#ff9800";
      } else {
        timestampElement.textContent = `${Math.floor(timeDiff / 3600)} jam lalu`;
        timestampElement.style.color = "#f44336";
      }
    }
  }
}

// ===== INISIALISASI KONTROL ESP32 =====
function initializeESP32Controls() {
  const refreshBtn = document.getElementById("refreshESP32");
  const testBtn = document.getElementById("testESP32");
  
  if (refreshBtn) {
    refreshBtn.addEventListener("click", refreshESP32Status);
  }
  
  if (testBtn) {
    testBtn.addEventListener("click", testESP32Connection);
  }
  
  // Polling real-time
  startESP32RealTimePolling();
  
  // Refresh saat halaman terlihat
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
      refreshESP32Status();
      socket.emit("getESP32Status");
    }
  });
}

// ===== FUNGSI BARU: POLLING STATUS ESP32 REAL-TIME =====
function startESP32RealTimePolling() {
  // Polling setiap 5 detik untuk status terbaru
  setInterval(() => {
    // Request status dari server via socket
    socket.emit("getESP32Status");
    
    // Juga ambil via HTTP sebagai fallback
    fetch('/esp32status')
      .then(r => r.json())
      .then(data => {
        updateESP32Status(data);
      })
      .catch(err => {
        console.error('ESP32 polling error:', err);
      });
  }, 5000);
  
  // Update timestamp setiap detik
  setInterval(updateESP32Timestamp, 1000);
}

// ===== REFRESH STATUS ESP32 =====
function refreshESP32Status() {
  adminLogger.esp32('Refresh status ESP32 manual diminta');
  
  fetch('/esp32status')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      updateESP32Status(data);
      adminLogger.esp32('Status ESP32 diperbarui', data);
    })
    .catch(err => {
      adminLogger.error('Error refresh status ESP32:', err);
    });
}

// ===== TEST KONEKSI KE ESP32 =====
function testESP32Connection() {
  adminLogger.esp32('Test koneksi ESP32 dimulai');
  
  const testBtn = document.getElementById("testESP32");
  const originalText = testBtn.textContent;
  
  // Tampilkan loading
  testBtn.disabled = true;
  testBtn.innerHTML = '<span class="loading-spinner"></span> MENGUJI...';
  testBtn.classList.add('loading');
  
  // Kirim request test ke server
  fetch('/testESP32Connection')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} - ${r.statusText}`);
      return r.json();
    })
    .then(data => {
      adminLogger.esp32('Hasil test koneksi ESP32:', data);
      
      // Update UI berdasarkan hasil test
      const resultDiv = document.getElementById("esp32TestResult");
      if (resultDiv) {
        resultDiv.style.display = 'block';
        resultDiv.className = `connection-test-result ${data.sukses ? 'success' : 'error'}`;
        
        if (data.sukses) {
          resultDiv.innerHTML = `
            <strong>✅ TEST BERHASIL</strong><br>
            <small>${data.pesan}</small><br>
            <small>Tipe: ${data.tipeKoneksi}</small>
            ${data.waktuRespon ? `<br><small>Respon: ${data.waktuRespon}</small>` : ''}
          `;
          showNotification("✅ ESP32 ONLINE - Terhubung dengan baik!", "success");
        } else {
          resultDiv.innerHTML = `
            <strong>❌ TEST GAGAL</strong><br>
            <small>${data.pesan}</small><br>
            <small>Tipe: ${data.tipeKoneksi}</small>
            ${data.saran ? `<br><small>Saran: ${data.saran}</small>` : ''}
          `;
          showNotification("❌ ESP32 OFFLINE - Tidak terdeteksi!", "error");
        }
        
        // Sembunyikan hasil setelah 10 detik
        setTimeout(() => {
          resultDiv.style.display = 'none';
        }, 10000);
      }
      
      // Update status ESP32 di UI
      updateESP32Status({
        connected: data.sukses,
        lastActivity: new Date(),
        connectionType: data.tipeKoneksi
      });
      
    })
    .catch(err => {
      adminLogger.error('Test koneksi ESP32 gagal:', err);
      showNotification("❌ Gagal melakukan test koneksi!", "error");
      
      const resultDiv = document.getElementById("esp32TestResult");
      if (resultDiv) {
        resultDiv.style.display = 'block';
        resultDiv.className = 'connection-test-result error';
        resultDiv.innerHTML = `
          <strong>❌ ERROR</strong><br>
          <small>${err.message}</small><br>
          <small>Server mungkin tidak merespon</small>
        `;
        
        setTimeout(() => {
          resultDiv.style.display = 'none';
        }, 10000);
      }
    })
    .finally(() => {
      // Reset tombol
      setTimeout(() => {
        testBtn.disabled = false;
        testBtn.textContent = originalText;
        testBtn.classList.remove('loading');
      }, 1000);
    });
}

// ===== KONTROL PENALTI OTOMATIS =====
function initializeAutoPenaltyToggle() {
  const toggle = document.getElementById('autoPenaltyToggle');
  if (!toggle) return;
  
  // Set status awal
  toggle.checked = autoPenaltyEnabled;
  
  // Event listener
  toggle.addEventListener('change', function() {
    const enabled = this.checked;
    adminLogger.info('Toggle penalti otomatis berubah', { diaktifkan: enabled });
    
    fetch(`/toggleAutoPenalty?enabled=${enabled}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        autoPenaltyEnabled = data.diaktifkan;
        updateAutoPenaltyUI();
        showNotification(data.pesan, data.diaktifkan ? "success" : "warning");
        adminLogger.info('Status penalti otomatis diperbarui di server', data);
      })
      .catch(err => {
        adminLogger.error('Gagal update status penalti otomatis:', err);
        showNotification('Gagal mengubah status penalti otomatis', 'error');
        toggle.checked = !enabled; // Kembalikan toggle
      });
  });
}

function updateAutoPenaltyUI() {
  const penaltyStatusEl = document.getElementById('penaltyStatus');
  if (penaltyStatusEl) {
    penaltyStatusEl.textContent = `Penalti Otomatis: ${autoPenaltyEnabled ? 'AKTIF' : 'NONAKTIF'}`;
    penaltyStatusEl.className = autoPenaltyEnabled ? 'status-active' : 'status-disabled';
    penaltyStatusEl.style.color = autoPenaltyEnabled ? '#4caf50' : '#f44336';
  }
  
  // Update toggle switch
  const toggle = document.getElementById('autoPenaltyToggle');
  if (toggle) {
    toggle.checked = autoPenaltyEnabled;
  }
}

function loadAutoPenaltyStatus() {
  fetch('/autoPenaltyStatus')
    .then(r => {
      if (!r.ok) throw new Error('Gagal mengambil status penalti otomatis');
      return r.json();
    })
    .then(data => {
      autoPenaltyEnabled = data.diaktifkan;
      adminLogger.info('Status penalti otomatis dimuat', data);
      updateAutoPenaltyUI();
    })
    .catch(err => {
      adminLogger.error('Gagal memuat status penalti otomatis:', err);
    });
}

// ===== KONFIGURASI =====
document.getElementById("setConfig").addEventListener("click", () => {
    const plus = parseInt(document.getElementById("plus").value, 10);
    const minus = parseInt(document.getElementById("minus").value, 10);
    const timerDuration = parseInt(document.getElementById("timerDuration").value, 10);
    
    adminLogger.info('Update konfigurasi diminta', { plus: plus, minus: minus, timerDuration: timerDuration });
    
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
            adminLogger.info('Konfigurasi berhasil diperbarui', config);
            showNotification("Konfigurasi berhasil disimpan!", "success");
        })
        .catch(err => {
            adminLogger.error('Error update konfigurasi:', err);
            showNotification("Gagal menyimpan konfigurasi!", "error");
        });
});

function updateConfigDisplay() {
    document.getElementById("plusValue").textContent = config.plus;
    document.getElementById("minusValue").textContent = config.minus;
    adminLogger.info('Tampilan konfigurasi diperbarui', config);
}

// ===== RESET SKOR =====
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

            adminLogger.info('Skor dan status tim berhasil direset', data);
            return data;
        })
        .catch(err => {
            adminLogger.error('Error reset:', err);
            throw err;
        })
        .finally(() => {
            btn.disabled = false;
            btn.classList.remove('loading');
            btn.innerHTML = btn.dataset.originalInner || 'RESET SEMUA SKOR';
        });
}

document.getElementById("reset").addEventListener("click", () => {
    adminLogger.info('Reset skor diminta');

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
            title: "Yakin?",
            text: "Anda tidak dapat mengembalikan ini!",
            icon: "warning",
            showCancelButton: true,
            confirmButtonText: "Ya, reset!",
            cancelButtonText: "Batal!",
            reverseButtons: true
        }).then((result) => {
            if (result.isConfirmed) {
                doReset()
                    .then(() => {
                        swalWithBootstrapButtons.fire({
                            title: "Direset!",
                            text: "Semua skor telah direset.",
                            icon: "success"
                        });
                    })
                    .catch(() => {
                        swalWithBootstrapButtons.fire({
                            title: "Gagal",
                            text: "Gagal mereset skor.",
                            icon: "error"
                        });
                    });
            } else if (result.dismiss === Swal.DismissReason.cancel) {
                swalWithBootstrapButtons.fire({
                    title: "Dibatalkan",
                    text: "Reset dibatalkan.",
                    icon: "error"
                });
            }
        }).catch(err => {
            adminLogger.error('Error SweetAlert pada reset:', err);
            showNotification('Terjadi kesalahan pada dialog konfirmasi', 'error');
        });
    });
});

// ===== BUKA KUNCI =====
document.getElementById("unlock").addEventListener("click", () => {
    adminLogger.info('Buka kunci manual diminta');
    fetch('/unlock')
        .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then(data => {
            adminLogger.info('Buka kunci manual diterapkan', data);
            showNotification("Sistem berhasil dibuka!", "success");
        })
        .catch(err => {
            adminLogger.error('Error buka kunci:', err);
            showNotification("Gagal membuka sistem!", "error");
        });
});

// ===== KONTROL JURI =====
function initializeJuryControls() {
    const juryPlus = document.getElementById("juryPlus");
    const juryMinus = document.getElementById("juryMinus");
    
    if (juryPlus) {
        juryPlus.addEventListener("click", handleJuryPlus);
    } else {
        adminLogger.error('Tombol Juri Plus tidak ditemukan!');
    }
    
    if (juryMinus) {
        juryMinus.addEventListener("click", handleJuryMinus);
    } else {
        adminLogger.error('Tombol Juri Minus tidak ditemukan!');
    }
}

function handleJuryPlus() {
    const juryPlus = document.getElementById("juryPlus");
    if (juryPlus && juryPlus.disabled) {
        adminLogger.warn('Juri plus diklik tapi tombol dinonaktifkan');
        return;
    }
    
    if (lockState.activeTeam) {
        if (!teamStatus[lockState.activeTeam - 1]) {
            showNotification(`Tim ${getTeamLetter(lockState.activeTeam)} sedang dinonaktifkan!`, "warning");
            return;
        }
        
        adminLogger.info('Juri plus diklik', { 
            timAktif: lockState.activeTeam, 
            poin: config.plus 
        });
        
        fetch(`/update?team=${lockState.activeTeam}&add=${config.plus}`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status} - ${r.statusText}`);
                return r.text();
            })
            .then(data => {
                adminLogger.info('Juri plus diterapkan', data);
                showNotification(`+${config.plus} poin!`, "success");
            })
            .catch(err => {
                adminLogger.error('Error juri plus:', err);
                showNotification(`Gagal memberikan poin! Error: ${err.message}`, "error");
            });
    } else {
        adminLogger.warn('Juri plus diklik tapi tidak ada tim aktif');
        showNotification("Tidak ada tim yang aktif! Tekan tombol tim terlebih dahulu.", "warning");
    }
}

function handleJuryMinus() {
    const juryMinus = document.getElementById("juryMinus");
    if (juryMinus && juryMinus.disabled) {
        adminLogger.warn('Juri minus diklik tapi tombol dinonaktifkan');
        return;
    }
    
    if (lockState.activeTeam) {
        if (!teamStatus[lockState.activeTeam - 1]) {
            showNotification(`Tim ${getTeamLetter(lockState.activeTeam)} sedang dinonaktifkan!`, "warning");
            return;
        }
        
        adminLogger.info('Juri minus diklik', { 
            timAktif: lockState.activeTeam, 
            poin: config.minus 
        });
        
        fetch(`/update?team=${lockState.activeTeam}&add=${config.minus}`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status} - ${r.statusText}`);
                return r.text();
            })
            .then(data => {
                adminLogger.info('Juri minus diterapkan', data);
                showNotification(`${config.minus} poin!`, "warning");
            })
            .catch(err => {
                adminLogger.error('Error juri minus:', err);
                showNotification(`Gagal mengurangi poin! Error: ${err.message}`, "error");
            });
    } else {
        adminLogger.warn('Juri minus diklik tapi tidak ada tim aktif');
        showNotification("Tidak ada tim yang aktif! Tekan tombol tim terlebih dahulu.", "warning");
    }
}

// ===== SISTEM NOTIFIKASI =====
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

// ===== SOCKET EVENTS UNTUK TIMER =====
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

socket.on("systemUnlocked", (data) => {
    adminLogger.event('systemUnlocked', data);
    
    updateTimerStatus('TIDAK AKTIF', 0);
    
    lockState = { locked: false, activeTeam: null };
    
    const unlockBtn = document.getElementById("unlock");
    const juryControls = document.getElementById("juryControls");
    const waitingLabel = document.getElementById("waitingLabel");
    const activeTeamLabel = document.getElementById("activeTeamLabel");
    
    if (unlockBtn) {
        unlockBtn.textContent = "Buka Kunci Tombol";
        unlockBtn.disabled = true;
    }
    
    if (juryControls) {
        juryControls.style.display = "none";
        juryControls.classList.remove('active');
    }
    
    if (waitingLabel) waitingLabel.style.display = "block";
    if (activeTeamLabel) activeTeamLabel.style.display = "none";
    
    for (let i = 1; i <= TEAM_COUNT; i++) {
        const badgeEl = document.getElementById(`badge-${i}`);
        if (badgeEl && teamStatus[i - 1]) {
            badgeEl.textContent = "MENUNGGU";
            badgeEl.className = "team-status status-waiting";
        }
    }
    
    if (data.reason === "timer_expired") {
        showNotification("Timer habis! Sistem terbuka otomatis.", "warning");
    } else if (data.reason === "buka_kunci_manual") {
        showNotification("Sistem dibuka paksa.", "info");
    } else if (data.reason === "auto_penalty_applied") {
        showNotification("Penalti otomatis diterapkan!", "warning");
    }
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
    
    adminLogger.info('Status timer diperbarui', { state: state, detik: seconds });
}

// ===== SOCKET EVENTS UNTUK ESP32 =====
socket.on("esp32Status", (status) => {
    adminLogger.event('esp32Status', status);
    updateESP32Status(status);
});

socket.on("esp32Activity", (activity) => {
    adminLogger.event('esp32Activity', activity);
    
    // Update status dengan aktivitas terbaru
    const updatedStatus = {
        ...esp32Status,
        lastActivity: activity.timestamp,
        socketId: activity.socketId,
        ip: activity.ip,
        connected: true,
        connectionType: activity.activity?.type || "activity"
    };
    
    updateESP32Status(updatedStatus);
    
    if (activity.activity && activity.activity.type === 'buzzer') {
        showNotification(`ESP32: Tombol ditekan - Tim ${getTeamLetter(activity.activity.team)}`, "info");
    } else if (activity.activity && activity.activity.type === 'heartbeat') {
        adminLogger.esp32('Detak jantung diterima', activity);
    }
});

// ===== SOCKET EVENTS UNTUK PENALTI OTOMATIS =====
socket.on("autoPenaltyToggle", (data) => {
    adminLogger.event('autoPenaltyToggle', data);
    autoPenaltyEnabled = data.enabled;
    updateAutoPenaltyUI();
    
    const message = data.enabled ? 
        'Penalti otomatis diaktifkan' : 
        'Penalti otomatis dinonaktifkan';
    showNotification(message, data.enabled ? "success" : "warning");
});

socket.on("autoPenaltyConfig", (data) => {
    adminLogger.event('autoPenaltyConfig', data);
    autoPenaltyEnabled = data.diaktifkan;
    updateAutoPenaltyUI();
});

socket.on("autoPenaltyStatus", (data) => {
    adminLogger.event('autoPenaltyStatus', data);
    autoPenaltyEnabled = data.diaktifkan;
    updateAutoPenaltyUI();
});

// ===== SOCKET EVENTS LAINNYA =====
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
        
        adminLogger.info('Tim diaktifkan', { timAktif: state.activeTeam });
    } else {
        if (juryControls) {
            juryControls.style.display = "none";
            juryControls.classList.remove('active');
        }
        if (waitingLabel) waitingLabel.style.display = "block";
        if (activeTeamLabel) activeTeamLabel.style.display = "none";
        
        if (juryPlus) juryPlus.disabled = true;
        if (juryMinus) juryMinus.disabled = true;
        
        adminLogger.info('Semua tim terbuka');
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
    adminLogger.event('reset', { scores: scores });
    for (let i = 1; i <= TEAM_COUNT; i++) {
        const scoreEl = document.getElementById(`score-${i}`);
        if (scoreEl) {
            scoreEl.textContent = scores[i-1];
            scoreEl.classList.add('score-update');
            setTimeout(() => scoreEl.classList.remove('score-update'), 600);
        }
    }
});

socket.on("timerStatusResponse", (data) => {
    adminLogger.event('timerStatusResponse', data);
    if (data.berjalan) {
        updateTimerStatus('BERJALAN', data.waktuTersisa);
    } else {
        updateTimerStatus('TIDAK AKTIF', 0);
    }
});

// ===== FUNGSI RESET TIMER MANUAL =====
function manualTimerReset() {
    adminLogger.info('Reset timer manual diminta');
    
    fetch('/debug/timer/fix')
        .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then(data => {
            adminLogger.info('Reset timer manual berhasil', data);
            showNotification("Timer direset manual!", "success");
        })
        .catch(err => {
            adminLogger.error('Reset timer manual gagal:', err);
            showNotification("Gagal mereset timer!", "error");
        });
}

// ===== INISIALISASI ADMIN =====
function initializeAdmin() {
    createTeamControls();
    initializeJuryControls();
    initializeESP32Controls();
    initializeAutoPenaltyToggle();
    updateTimerStatus('TIDAK AKTIF', 0);
    
    // Load status awal ESP32
    refreshESP32Status();
    
    // Load status penalti otomatis
    loadAutoPenaltyStatus();
    
    // Load data awal dari server
    Promise.all([
        fetch('/lockstate').then(r => {
            if (!r.ok) throw new Error('Gagal mengambil status kunci');
            return r.json();
        }),
        fetch('/scores').then(r => {
            if (!r.ok) throw new Error('Gagal mengambil skor');
            return r.json();
        }),
        fetch('/esp32status').then(r => {
            if (!r.ok) throw new Error('Gagal mengambil status ESP32');
            return r.json();
        }),
        fetch('/teamToggleState').then(r => {
            if (!r.ok) throw new Error('Gagal mengambil status toggle tim');
            return r.json();
        })
    ]).then(([lockStateData, scoresData, esp32Data, toggleStateData]) => {
        lockState = lockStateData;
        
        if (Array.isArray(toggleStateData)) {
            teamStatus = toggleStateData;
        }
        
        adminLogger.info('Data awal dimuat', { 
            statusKunci: lockStateData, 
            skor: scoresData,
            esp32: esp32Data,
            statusToggleTim: toggleStateData
        });
        
        // Update skor
        for (let i = 1; i <= TEAM_COUNT; i++) {
            const scoreEl = document.getElementById(`score-${i}`);
            if (scoreEl) {
                scoreEl.textContent = scoresData[i-1];
            }
        }
        
        // Update status tim
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
        adminLogger.error('Gagal memuat data awal:', err);
        showNotification("Gagal memuat data awal!", "error");
    });
}

// ===== MEMULAI SAAT DOKUMEN SIAP =====
document.addEventListener('DOMContentLoaded', function() {
    adminLogger.info('Panel admin diinisialisasi...');
    adminLogger.esp32('Sistem monitoring ESP32 REAL-TIME diaktifkan');
    initializeAdmin();
    
    // Toggle debug panel dengan Ctrl+Shift+D
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.shiftKey && e.key === 'D') {
            const debugPanel = document.getElementById('debugPanel');
            if (debugPanel) {
                debugPanel.style.display = debugPanel.style.display === 'none' ? 'block' : 'none';
            }
        }
    });
    
    try {
        if (typeof Swal === 'undefined') {
            adminLogger.warn('SweetAlert2 tidak terdeteksi pada saat load.');
            showNotification('SweetAlert2 tidak ter-load; menggunakan fallback.', 'warning');
        } else {
            adminLogger.info('SweetAlert2 tersedia.');
        }
    } catch (e) {
        console.error('Error memeriksa ketersediaan Swal', e);
    }
});