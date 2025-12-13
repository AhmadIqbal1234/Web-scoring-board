﻿/* Copyright © 2025 Ridwan and Team */
const socket = io('/admin');
const teamsContainer = document.getElementById("teams");
const TEAM_COUNT = 12;
let config = { plus: 5, minus: -2, timerDuration: 30 };
let lockState = { locked: false, activeTeam: null, lockId: null, lockSequence: 0 };
let teamStatus = Array(TEAM_COUNT).fill(true);
let autoPenaltyEnabled = true;

// ===== EDIT SCORE FEATURE =====
let editModeActive = false;
let currentlyEditingTeam = 0;

// ===== STATUS ESP32 DIPERBAIKI =====
let esp32Status = {
  connected: false,
  lastActivity: null,
  socketId: null,
  ip: null,
  connectionType: null,
  activeTeams: 0,
  modulesDetected: 0,
  wifiRSSI: 0,
  heartbeatCount: 0,
  lastRSSIUpdate: null,
  rssiHistory: []
};

// ===== LOGGER DIPERBAIKI =====
const adminLogger = {
  info: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[ADMIN:${timestamp}] ${message}`, data || '');
  },
  
  error: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.error(`[ADMIN:${timestamp}] ${message}`, data || '');
  },
  
  esp32: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.log(`[ADMIN:${timestamp}] ESP32: ${message}`, data || '');
  },
  
  warning: (message, data = null) => {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    console.warn(`[ADMIN:${timestamp}] ⚠️ ${message}`, data || '');
  }
};

// ===== FUNGSI BANTU =====
function getTeamLetter(index) {
  return String.fromCharCode(64 + index);
}

// ===== EDIT SCORE FEATURE FUNCTIONS =====
function initializeEditScoreFeature() {
  const editToggleBtn = document.getElementById("editScoresToggle");
  const editModeStatus = document.getElementById("editModeStatus");
  
  if (editToggleBtn) {
    editToggleBtn.addEventListener("click", toggleEditMode);
  }
  
  // Add event listeners for edit dialog
  document.getElementById("cancelEdit").addEventListener("click", closeEditScoreDialog);
  document.getElementById("saveEdit").addEventListener("click", saveEditedScore);
  
  // Close dialog on overlay click
  document.getElementById("editScoreDialog").addEventListener("click", function(e) {
    if (e.target === this) {
      closeEditScoreDialog();
    }
  });
  
  adminLogger.info("Edit score feature initialized");
}

function toggleEditMode() {
  editModeActive = !editModeActive;
  const editToggleBtn = document.getElementById("editScoresToggle");
  const editModeStatus = document.getElementById("editModeStatus");
  
  if (editToggleBtn && editModeStatus) {
    if (editModeActive) {
      editToggleBtn.innerHTML = '<span class="edit-icon">✅</span> SELESAI EDITING';
      editToggleBtn.classList.add('btn-success');
      editToggleBtn.classList.remove('btn-info');
      editModeStatus.textContent = "Mode Edit Skor - Klik angka skor untuk mengedit";
      editModeStatus.style.color = "#4caf50";
      editModeStatus.style.fontWeight = "bold";
      
      // Add click event to all score displays
      for (let i = 1; i <= TEAM_COUNT; i++) {
        const scoreEl = document.getElementById(`score-${i}`);
        if (scoreEl) {
          scoreEl.style.cursor = "pointer";
          scoreEl.style.backgroundColor = "#f0f8ff";
          scoreEl.style.border = "2px dashed #4caf50";
          scoreEl.style.padding = "5px";
          scoreEl.style.borderRadius = "4px";
          
          // Remove existing event listeners and add new one
          scoreEl.onclick = () => openEditScoreDialog(i);
        }
      }
      
      adminLogger.info("Edit mode activated");
      showNotification("Mode edit skor diaktifkan. Klik angka skor untuk mengedit.", "info");
    } else {
      editToggleBtn.innerHTML = '<span class="edit-icon">✏️</span> EDIT SEMUA SKOR';
      editToggleBtn.classList.remove('btn-success');
      editToggleBtn.classList.add('btn-info');
      editModeStatus.textContent = "Mode Normal";
      editModeStatus.style.color = "";
      editModeStatus.style.fontWeight = "";
      
      // Remove click events and styling
      for (let i = 1; i <= TEAM_COUNT; i++) {
        const scoreEl = document.getElementById(`score-${i}`);
        if (scoreEl) {
          scoreEl.style.cursor = "";
          scoreEl.style.backgroundColor = "";
          scoreEl.style.border = "";
          scoreEl.style.padding = "";
          scoreEl.style.borderRadius = "";
          scoreEl.onclick = null;
        }
      }
      
      adminLogger.info("Edit mode deactivated");
      showNotification("Mode edit skor dinonaktifkan.", "info");
    }
  }
}

function openEditScoreDialog(team) {
  if (!editModeActive) return;
  
  currentlyEditingTeam = team;
  const currentScore = document.getElementById(`score-${team}`).textContent;
  const teamLetter = getTeamLetter(team);
  
  document.getElementById("editTeamLetter").textContent = teamLetter;
  document.getElementById("currentScoreValue").textContent = currentScore;
  document.getElementById("editScoreInput").value = currentScore;
  
  const dialog = document.getElementById("editScoreDialog");
  dialog.style.display = "flex";
  
  // Focus on input after a short delay
  setTimeout(() => {
    document.getElementById("editScoreInput").focus();
    document.getElementById("editScoreInput").select();
  }, 100);
}

function closeEditScoreDialog() {
  document.getElementById("editScoreDialog").style.display = "none";
  currentlyEditingTeam = 0;
}

function saveEditedScore() {
  if (!currentlyEditingTeam) return;
  
  const newScore = parseInt(document.getElementById("editScoreInput").value);
  const teamLetter = getTeamLetter(currentlyEditingTeam);
  
  if (isNaN(newScore)) {
    showNotification("Skor harus berupa angka!", "error");
    return;
  }
  
  if (newScore < -999 || newScore > 999) {
    showNotification("Skor harus antara -999 dan 999!", "error");
    return;
  }
  
  // Show loading state
  const saveBtn = document.getElementById("saveEdit");
  const originalText = saveBtn.textContent;
  saveBtn.textContent = "Menyimpan...";
  saveBtn.disabled = true;
  
  // Send to server
  fetch(`/editScore?team=${currentlyEditingTeam}&score=${newScore}`)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      if (data.success) {
        // Update local display
        const scoreEl = document.getElementById(`score-${currentlyEditingTeam}`);
        if (scoreEl) {
          scoreEl.textContent = newScore;
          scoreEl.classList.add('score-update');
          setTimeout(() => scoreEl.classList.remove('score-update'), 600);
        }
        
        showNotification(`Skor Tim ${teamLetter} diubah menjadi ${newScore}`, "success");
        closeEditScoreDialog();
        
        adminLogger.info(`Score edited: Team ${teamLetter} = ${newScore}`);
      } else {
        throw new Error(data.message || 'Failed to update score');
      }
    })
    .catch(err => {
      adminLogger.error('Edit score failed:', err);
      showNotification(`Gagal mengubah skor: ${err.message}`, "error");
    })
    .finally(() => {
      saveBtn.textContent = originalText;
      saveBtn.disabled = false;
    });
}

// ===== UPDATE ESP32 STATUS =====
function updateESP32Status(status) {
  const esp32Badge = document.getElementById("esp32Badge");
  const esp32Connection = document.getElementById("esp32Connection");
  const esp32LastActivity = document.getElementById("esp32LastActivity");
  const esp32SocketId = document.getElementById("esp32SocketId");
  const esp32ActiveTeams = document.getElementById("esp32ActiveTeams");
  const esp32ModulesDetected = document.getElementById("esp32ModulesDetected");
  const esp32WiFiRSSI = document.getElementById("esp32WiFiRSSI");
  const esp32RSSIHistory = document.getElementById("esp32RSSIHistory");
  
  const sebelumnyaOnline = esp32Status.connected;
  
  // Update status dengan data baru
  esp32Status = { ...esp32Status, ...status };
  
  // Jika ada RSSI history, update tampilan
  if (status.rssiHistory && Array.isArray(status.rssiHistory)) {
    esp32Status.rssiHistory = status.rssiHistory;
  }
  
  if (esp32Badge) {
    if (esp32Status.connected) {
      esp32Badge.textContent = "TERHUBUNG";
      esp32Badge.className = "controller-badge connected";
      esp32Badge.style.animation = "pulse 2s infinite";
      
      let connectionText = `ONLINE`;
      if (esp32Status.ip) connectionText += ` (${esp32Status.ip})`;
      if (esp32Status.connectionType) connectionText += ` - ${esp32Status.connectionType}`;
      
      esp32Connection.textContent = connectionText;
      esp32Connection.style.color = "#4caf50";
    } else {
      esp32Badge.textContent = "TERPUTUS";
      esp32Badge.className = "controller-badge disconnected";
      esp32Badge.style.animation = "none";
      esp32Connection.textContent = "OFFLINE - Tidak ada aktivitas dalam 5 menit";
      esp32Connection.style.color = "#f44336";
    }
  }
  
  // Update informasi jumlah tim aktif
  if (esp32ActiveTeams) {
    if (esp32Status.activeTeams !== undefined && esp32Status.activeTeams !== null) {
      esp32ActiveTeams.textContent = `${esp32Status.activeTeams} dari 12 tim`;
      
      if (esp32Status.activeTeams === 12) {
        esp32ActiveTeams.style.color = "#4caf50";
        esp32ActiveTeams.title = "Semua tombol tim terdeteksi";
      } else if (esp32Status.activeTeams >= 6) {
        esp32ActiveTeams.style.color = "#ff9800";
        esp32ActiveTeams.title = "Beberapa tombol tidak terdeteksi";
      } else if (esp32Status.activeTeams > 0) {
        esp32ActiveTeams.style.color = "#ff9800";
        esp32ActiveTeams.title = "Hanya sebagian tombol terdeteksi";
      } else {
        esp32ActiveTeams.style.color = "#f44336";
        esp32ActiveTeams.title = "Tidak ada tombol terdeteksi";
      }
    } else {
      esp32ActiveTeams.textContent = "Mengecek...";
      esp32ActiveTeams.style.color = "#ff9800";
    }
  }
  
  // Update informasi jumlah modul terdeteksi
  if (esp32ModulesDetected) {
    if (esp32Status.modulesDetected !== undefined && esp32Status.modulesDetected !== null) {
      esp32ModulesDetected.textContent = `${esp32Status.modulesDetected} dari 4 modul`;
      
      if (esp32Status.modulesDetected === 4) {
        esp32ModulesDetected.style.color = "#4caf50";
        esp32ModulesDetected.title = "Semua modul PCF8574 terdeteksi";
      } else if (esp32Status.modulesDetected >= 2) {
        esp32ModulesDetected.style.color = "#ff9800";
        esp32ModulesDetected.title = "Beberapa modul tidak terdeteksi";
      } else if (esp32Status.modulesDetected > 0) {
        esp32ModulesDetected.style.color = "#ff9800";
        esp32ModulesDetected.title = "Hanya 1 modul terdeteksi";
      } else {
        esp32ModulesDetected.style.color = "#f44336";
        esp32ModulesDetected.title = "Tidak ada modul PCF8574 terdeteksi";
      }
    } else {
      esp32ModulesDetected.textContent = "Mengecek...";
      esp32ModulesDetected.style.color = "#ff9800";
    }
  }
  
  // Update informasi sinyal WiFi
  if (esp32WiFiRSSI) {
    if (esp32Status.wifiRSSI !== undefined && esp32Status.wifiRSSI !== null) {
      esp32WiFiRSSI.textContent = `${esp32Status.wifiRSSI} dBm`;
      
      if (esp32Status.wifiRSSI > -60) {
        esp32WiFiRSSI.style.color = "#4caf50";
        esp32WiFiRSSI.title = `Sinyal WiFi: KUAT | Update: ${esp32Status.lastRSSIUpdate ? new Date(esp32Status.lastRSSIUpdate).toLocaleTimeString('id-ID') : 'Tidak ada'}`;
      } else if (esp32Status.wifiRSSI > -70) {
        esp32WiFiRSSI.style.color = "#ff9800";
        esp32WiFiRSSI.title = `Sinyal WiFi: SEDANG | Update: ${esp32Status.lastRSSIUpdate ? new Date(esp32Status.lastRSSIUpdate).toLocaleTimeString('id-ID') : 'Tidak ada'}`;
      } else if (esp32Status.wifiRSSI > -80) {
        esp32WiFiRSSI.style.color = "#f44336";
        esp32WiFiRSSI.title = `Sinyal WiFi: LEMAH | Update: ${esp32Status.lastRSSIUpdate ? new Date(esp32Status.lastRSSIUpdate).toLocaleTimeString('id-ID') : 'Tidak ada'}`;
      } else {
        esp32WiFiRSSI.style.color = "#d32f2f";
        esp32WiFiRSSI.title = `Sinyal WiFi: SANGAT LEMAH | Update: ${esp32Status.lastRSSIUpdate ? new Date(esp32Status.lastRSSIUpdate).toLocaleTimeString('id-ID') : 'Tidak ada'}`;
      }
      
      // Tampilkan RSSI history jika ada
      if (esp32RSSIHistory && esp32Status.rssiHistory && esp32Status.rssiHistory.length > 0) {
        const avgRSSI = Math.round(esp32Status.rssiHistory.reduce((sum, entry) => sum + entry.rssi, 0) / esp32Status.rssiHistory.length);
        esp32RSSIHistory.textContent = `Rata-rata: ${avgRSSI} dBm (${esp32Status.rssiHistory.length} sampel)`;
        esp32RSSIHistory.style.color = esp32WiFiRSSI.style.color;
      }
    } else {
      esp32WiFiRSSI.textContent = "-";
      esp32WiFiRSSI.style.color = "#ff9800";
      esp32WiFiRSSI.title = "Data sinyal belum tersedia";
    }
  }
  
  if (esp32LastActivity && esp32Status.lastActivity) {
    const activityDate = new Date(esp32Status.lastActivity);
    const now = new Date();
    const timeDiff = Math.floor((now - activityDate) / 1000);
    
    let timeText = activityDate.toLocaleTimeString('id-ID');
    
    if (timeDiff < 10) {
      timeText += ` (BARU SAJA)`;
      esp32LastActivity.style.color = "#4caf50";
    } else if (timeDiff < 60) {
      timeText += ` (${timeDiff} detik lalu)`;
      esp32LastActivity.style.color = "#ff9800";
    } else if (timeDiff < 300) {
      timeText += ` (${Math.floor(timeDiff / 60)} menit lalu)`;
      esp32LastActivity.style.color = "#ff9800";
    } else {
      timeText += ` (${Math.floor(timeDiff / 60)} menit lalu)`;
      esp32LastActivity.style.color = "#f44336";
    }
    
    esp32LastActivity.textContent = timeText;
  }
  
  if (esp32SocketId) {
    esp32SocketId.textContent = esp32Status.socketId || (esp32Status.connectionType === "http_activity" ? "Koneksi HTTP" : "Tidak terhubung");
  }
  
  updateESP32Timestamp();
  
  if (sebelumnyaOnline !== esp32Status.connected) {
    const pesan = esp32Status.connected ? 
      `ESP32 terhubung! Modul: ${esp32Status.modulesDetected || 0}, Tim: ${esp32Status.activeTeams || 0}` : 
      "ESP32 terputus! (timeout 5 menit)";
    const tipe = esp32Status.connected ? "success" : "error";
    showNotification(pesan, tipe);
    
    adminLogger.esp32(`Status changed: ${esp32Status.connected ? 'CONNECTED' : 'DISCONNECTED'}`, {
      lastActivity: esp32Status.lastActivity,
      connectionType: esp32Status.connectionType,
      heartbeatCount: esp32Status.heartbeatCount,
      modulesDetected: esp32Status.modulesDetected,
      activeTeams: esp32Status.activeTeams,
      wifiRSSI: esp32Status.wifiRSSI,
      socketId: esp32Status.socketId
    });
  }
}

// ===== UPDATE TIMESTAMP =====
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
      } else if (timeDiff < 300) {
        timestampElement.textContent = `${Math.floor(timeDiff / 60)} menit lalu`;
        timestampElement.style.color = "#ff9800";
      } else {
        timestampElement.textContent = `${Math.floor(timeDiff / 60)} menit lalu`;
        timestampElement.style.color = "#f44336";
      }
      
      // Refresh jika mendekati timeout
      if (timeDiff > 240 && timeDiff < 300 && !document.hidden) {
        refreshESP32Status();
        socket.emit("getESP32Status");
      }
    }
  }
}

// ===== TOGGLE TEAM =====
function toggleTeamStatus(teamNumber) {
  const newStatus = !teamStatus[teamNumber - 1];
  
  console.log(`[ADMIN] Toggle team ${teamNumber} to ${newStatus ? 'enabled' : 'disabled'}`);
  
  fetch(`/toggleTeam?team=${teamNumber}&enabled=${newStatus}`)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      teamStatus[teamNumber - 1] = newStatus;
      
      const teamCard = document.querySelector(`.team-card[data-team="${teamNumber}"]`);
      const toggleBtn = document.getElementById(`toggle-${teamNumber}`);
      const badgeEl = document.getElementById(`badge-${teamNumber}`);
      
      if (teamCard && toggleBtn && badgeEl) {
        if (newStatus) {
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
      
      adminLogger.info(`Tim ${getTeamLetter(teamNumber)} toggle updated to ${newStatus ? 'enabled' : 'disabled'}`);
      showNotification(`Tim ${getTeamLetter(teamNumber)} ${newStatus ? 'diaktifkan' : 'dinonaktifkan'}`, "info");
    })
    .catch(err => {
      adminLogger.error('Toggle update failed:', err);
      showNotification("Gagal memperbarui status tim!", "error");
    });
}

// ===== CREATE TEAM CONTROLS =====
function createTeamControls() {
  adminLogger.info('Creating team controls');
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
        <div class="team-sequence" id="sequence-${i}"></div>
      </div>
      <div class="team-controls">
        <button class="team-toggle toggle-on" id="toggle-${i}">
          NONAKTIFKAN
        </button>
      </div>
    `;
    
    teamDiv.title = `Tim ${getTeamLetter(i)} - Klik untuk melihat detail`;
    
    teamDiv.addEventListener('mouseenter', () => {
      if (teamStatus[i - 1]) {
        teamDiv.style.transform = 'translateY(-3px)';
        teamDiv.style.boxShadow = '0 8px 20px rgba(255, 215, 0, 0.2)';
      }
    });
    
    teamDiv.addEventListener('mouseleave', () => {
      teamDiv.style.transform = 'translateY(0)';
      teamDiv.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
      teamDiv.title = `Tim ${getTeamLetter(i)} - Klik untuk melihat detail`;
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

// ===== ESP32 CONTROLS =====
function initializeESP32Controls() {
  const refreshBtn = document.getElementById("refreshESP32");
  const testBtn = document.getElementById("testESP32");
  const forceUnlockBtn = document.getElementById("forceUnlockAll");
  const syncBtn = document.getElementById("manualSync");
  
  if (refreshBtn) {
    refreshBtn.addEventListener("click", refreshESP32Status);
  }
  
  if (testBtn) {
    testBtn.addEventListener("click", testESP32Connection);
  }

  if (forceUnlockBtn) {
    forceUnlockBtn.addEventListener("click", forceUnlockAll);
  }

  if (syncBtn) {
    syncBtn.addEventListener("click", manualSyncWithESP32);
  }
  
  startESP32RealTimePolling();
  
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
      adminLogger.esp32('Tab aktif, refresh status');
      refreshESP32Status();
      socket.emit("getESP32Status");
    }
  });
  
  window.addEventListener('focus', function() {
    adminLogger.esp32('Window focused, refresh status');
    refreshESP32Status();
  });
}

// ===== START ESP32 POLLING =====
function startESP32RealTimePolling() {
  // Polling untuk status ESP32 (10 detik)
  setInterval(() => {
    socket.emit("getESP32Status");
    
    fetch('/esp32status')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        updateESP32Status({
          lastActivity: new Date()
        });
      })
      .catch(err => {
        console.error('ESP32 polling error:', err);
      });
  }, 10000);
  
  // Update timestamp setiap detik
  setInterval(updateESP32Timestamp, 1000);
}

// ===== FORCE UNLOCK ALL =====
function forceUnlockAll() {
  if (!confirm("Yakin ingin membuka kunci paksa dari semua tim dan timer?\nIni akan membuka semua kunci dan menghentikan timer.")) return;
  
  const btn = document.getElementById('forceUnlockAll');
  const originalText = btn.textContent;
  
  btn.disabled = true;
  btn.textContent = 'MEMPROSES...';
  
  fetch('/forceUnlockAll')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      showNotification("Semua kunci berhasil dibuka paksa!", "success");
      
      lockState = { locked: false, activeTeam: null, lockId: null, lockSequence: lockState.lockSequence };
      updateTimerStatus('TIDAK AKTIF', 0);
      
      const unlockBtn = document.getElementById("unlock");
      if (unlockBtn) {
        unlockBtn.textContent = "Buka Kunci Tombol";
        unlockBtn.disabled = true;
      }
      
      const juryControls = document.getElementById("juryControls");
      const waitingLabel = document.getElementById("waitingLabel");
      const activeTeamLabel = document.getElementById("activeTeamLabel");
      
      if (juryControls) juryControls.style.display = "none";
      if (waitingLabel) waitingLabel.style.display = "block";
      if (activeTeamLabel) activeTeamLabel.style.display = "none";
      
      adminLogger.info("Force unlock all completed", data);
    })
    .catch(err => {
      adminLogger.error('Force unlock failed:', err);
      showNotification("❌ Gagal membuka kunci paksa!", "error");
    })
    .finally(() => {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = originalText;
      }, 1000);
    });
}

// ===== MANUAL SYNC =====
function manualSyncWithESP32() {
  const btn = document.getElementById("manualSync");
  const originalText = btn.textContent;
  
  btn.disabled = true;
  btn.textContent = 'SYNCING...';
  btn.classList.add('loading');
  
  fetch('/synctimer?action=status')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      showNotification("Sync berhasil", "success");
      
      const timerStateEl = document.getElementById("timerState");
      const currentTimeEl = document.getElementById("currentTime");
      
      if (timerStateEl && currentTimeEl) {
        if (data.timer.isRunning) {
          timerStateEl.textContent = 'BERJALAN';
          const mins = Math.floor(data.timer.remaining / 60);
          const secs = data.timer.remaining % 60;
          currentTimeEl.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        } else {
          timerStateEl.textContent = 'TIDAK AKTIF';
          currentTimeEl.textContent = '00:00';
        }
      }
      
      if (data.lock.locked && data.lock.activeTeam) {
        lockState = data.lock;
        updateLockStateUI();
      }
    })
    .catch(err => {
      showNotification("❌ Sync gagal", "error");
      console.error('Sync error:', err);
    })
    .finally(() => {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = originalText;
        btn.classList.remove('loading');
      }, 1000);
    });
}

// ===== REFRESH ESP32 DATA =====
function refreshESP32Data() {
  adminLogger.esp32('Manual refresh requested');
  
  fetch('/debug/esp32')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      updateESP32Status({
        connected: data.terhubung,
        lastActivity: data.aktivitasTerakhir,
        heartbeatCount: data.heartbeatCount,
        socketId: data.socketId,
        ip: data.ip,
        modulesDetected: data.modulTerdeteksi,
        activeTeams: data.timAktif,
        wifiRSSI: data.sinyalWiFi ? parseInt(data.sinyalWiFi) : null,
        rssiHistory: data.rssiHistory || []
      });
      
      adminLogger.esp32('Status refreshed', {
        modules: data.modulTerdeteksi,
        teams: data.timAktif,
        rssi: data.sinyalWiFi,
        historyCount: data.rssiHistory ? data.rssiHistory.length : 0
      });
    })
    .catch(err => {
      adminLogger.error('ESP32 refresh failed:', err);
    });
}

function refreshESP32Status() {
  refreshESP32Data();
}

function testESP32Connection() {
  adminLogger.esp32('Connection test started');
  
  const testBtn = document.getElementById("testESP32");
  const originalText = testBtn.textContent;
  
  testBtn.disabled = true;
  testBtn.innerHTML = '<span class="loading-spinner"></span> MENGUJI...';
  testBtn.classList.add('loading');
  
  fetch('/testESP32Connection')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} - ${r.statusText}`);
      return r.json();
    })
    .then(data => {
      const resultDiv = document.getElementById("esp32TestResult");
      if (resultDiv) {
        resultDiv.style.display = 'block';
        resultDiv.className = `connection-test-result ${data.sukses ? 'success' : 'error'}`;
        
        if (data.sukses) {
          resultDiv.innerHTML = `
            <strong>TEST BERHASIL</strong><br>
            <small>${data.pesan}</small><br>
            <small>Modul: ${data.detail.modulTerdeteksi || 0}, Tim: ${data.detail.timAktif || 0}</small><br>
            <small>Lock State: ${data.lockState?.locked ? `Terlock oleh Tim ${getTeamLetter(data.lockState.activeTeam)}` : 'Tidak terkunci'}</small>
          `;
          showNotification("ESP32 ONLINE", "success");
          
          updateESP32Status({
            connected: true,
            lastActivity: data.detail.aktivitasTerakhir,
            ip: data.detail.ip,
            modulesDetected: data.detail.modulTerdeteksi,
            activeTeams: data.detail.timAktif,
            wifiRSSI: data.detail.sinyalWiFi
          });
        } else {
          resultDiv.innerHTML = `
            <strong>TEST GAGAL</strong><br>
            <small>${data.pesan}</small><br>
            <small>${data.saran || ''}</small>
          `;
          showNotification("ESP32 OFFLINE", "error");
        }
        
        setTimeout(() => {
          resultDiv.style.display = 'none';
        }, 10000);
      }
    })
    .catch(err => {
      adminLogger.error('Connection test failed:', err);
      showNotification("Test gagal", "error");
    })
    .finally(() => {
      setTimeout(() => {
        testBtn.disabled = false;
        testBtn.textContent = originalText;
        testBtn.classList.remove('loading');
      }, 1000);
    });
}

// ===== AUTO PENALTY =====
function initializeAutoPenaltyToggle() {
  const toggle = document.getElementById('autoPenaltyToggle');
  if (!toggle) return;
  
  toggle.checked = autoPenaltyEnabled;
  
  toggle.addEventListener('change', function() {
    const enabled = this.checked;
    adminLogger.info('Auto penalty toggle changed', { diaktifkan: enabled });
    
    fetch(`/toggleAutoPenalty?enabled=${enabled}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        autoPenaltyEnabled = data.diaktifkan;
        updateAutoPenaltyUI();
        showNotification(data.pesan, data.diaktifkan ? "success" : "warning");
      })
      .catch(err => {
        adminLogger.error('Auto penalty update failed:', err);
        toggle.checked = !enabled;
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
  
  const toggle = document.getElementById('autoPenaltyToggle');
  if (toggle) {
    toggle.checked = autoPenaltyEnabled;
  }
}

function loadAutoPenaltyStatus() {
  fetch('/autoPenaltyStatus')
    .then(r => {
      if (!r.ok) throw new Error('Failed to get auto penalty status');
      return r.json();
    })
    .then(data => {
      autoPenaltyEnabled = data.diaktifkan;
      updateAutoPenaltyUI();
    })
    .catch(err => {
      adminLogger.error('Auto penalty status load failed:', err);
    });
}

// ===== CONFIGURATION =====
document.getElementById("setConfig").addEventListener("click", () => {
  const plus = parseInt(document.getElementById("plus").value, 10);
  const minus = parseInt(document.getElementById("minus").value, 10);
  const timerDuration = parseInt(document.getElementById("timerDuration").value, 10);
  
  if (isNaN(plus) || isNaN(minus) || isNaN(timerDuration)) {
    showNotification("Input tidak valid!", "error");
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
      showNotification("Konfigurasi disimpan!", "success");
    })
    .catch(err => {
      showNotification("Gagal menyimpan konfigurasi!", "error");
    });
});

function updateConfigDisplay() {
  document.getElementById("plusValue").textContent = config.plus;
  document.getElementById("minusValue").textContent = config.minus;
  
  const plusInput = document.getElementById("plus");
  const minusInput = document.getElementById("minus");
  const timerInput = document.getElementById("timerDuration");
  
  if (plusInput) plusInput.value = config.plus;
  if (minusInput) minusInput.value = config.minus;
  if (timerInput) timerInput.value = config.timerDuration;
}

// ===== RESET =====
document.getElementById("reset").addEventListener("click", () => {
  if (!confirm("Yakin ingin mereset semua skor?")) return;
  
  const btn = document.getElementById('reset');
  const originalText = btn.innerHTML;
  
  btn.disabled = true;
  btn.classList.add('loading');
  btn.innerHTML = '<span></span> MEMPROSES...';
  
  fetch('/reset')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      showNotification("Skor direset!", "success");
    })
    .catch(err => {
      showNotification("Gagal mereset skor!", "error");
    })
    .finally(() => {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.innerHTML = originalText;
    });
});

// ===== UNLOCK =====
document.getElementById("unlock").addEventListener("click", () => {
  fetch('/unlock')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      showNotification("Sistem dibuka!", "success");
    })
    .catch(err => {
      showNotification("Gagal membuka sistem!", "error");
    });
});

// ===== KONTROL JURI YANG BENAR =====
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
        
        // Reset UI setelah juri memberi penilaian
        setTimeout(() => {
          lockState = { locked: false, activeTeam: null, lockId: null, lockSequence: lockState.lockSequence };
          updateJuryControls(null);
          updateLockStateUI();
        }, 500);
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
        
        // Reset UI setelah juri memberi penilaian
        setTimeout(() => {
          lockState = { locked: false, activeTeam: null, lockId: null, lockSequence: lockState.lockSequence };
          updateJuryControls(null);
          updateLockStateUI();
        }, 500);
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

// ===== FUNGSI UPDATE KONTROL JURI =====
function updateJuryControls(activeTeam) {
  const juryControls = document.getElementById("juryControls");
  const waitingLabel = document.getElementById("waitingLabel");
  const activeTeamLabel = document.getElementById("activeTeamLabel");
  const juryPlus = document.getElementById("juryPlus");
  const juryMinus = document.getElementById("juryMinus");
  
  if (activeTeam && activeTeam > 0) {
    // Tim aktif, tampilkan kontrol juri
    if (juryControls) {
      juryControls.style.display = "flex";
      juryControls.style.opacity = "1";
      juryControls.style.visibility = "visible";
    }
    if (waitingLabel) {
      waitingLabel.style.display = "none";
    }
    if (activeTeamLabel) {
      activeTeamLabel.textContent = `Tim ${getTeamLetter(activeTeam)} Sedang Aktif`;
      activeTeamLabel.style.display = "block";
      activeTeamLabel.style.animation = "pulse 2s infinite";
    }
    
    // Aktifkan tombol juri
    if (juryPlus) juryPlus.disabled = false;
    if (juryMinus) juryMinus.disabled = false;
    
    adminLogger.info(`Jury controls activated for Team ${getTeamLetter(activeTeam)}`);
  } else {
    // Tidak ada tim aktif, sembunyikan kontrol juri
    if (juryControls) {
      juryControls.style.display = "none";
    }
    if (waitingLabel) {
      waitingLabel.style.display = "block";
      waitingLabel.style.animation = "pulse 2s infinite";
    }
    if (activeTeamLabel) {
      activeTeamLabel.style.display = "none";
    }
    
    // Nonaktifkan tombol juri
    if (juryPlus) juryPlus.disabled = true;
    if (juryMinus) juryMinus.disabled = true;
    
    adminLogger.info("Jury controls deactivated - no active team");
  }
}

// ===== HIGH-SPEED NOTIFICATION =====
function showNotification(message, type = "success") {
  requestAnimationFrame(() => {
    const existingNotification = document.querySelector('.admin-notification');
    if (existingNotification) {
      existingNotification.remove();
    }
    
    const notification = document.createElement('div');
    notification.className = `admin-notification ${type}`;
    
    let icon = '';
    switch(type) {
      case 'success': icon = '✅'; break;
      case 'error': icon = '❌'; break;
      case 'warning': icon = '⚠️'; break;
      case 'info': icon = 'ℹ️'; break;
      default: icon = '💡';
    }
    
    notification.innerHTML = `<span class="notification-icon">${icon}</span> ${message}`;
    
    document.body.appendChild(notification);
    
    setTimeout(() => notification.classList.add('show'), 10);
    
    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  });
}

// ===== SOCKET EVENTS =====
socket.on("connect", () => {
  adminLogger.info('Admin connected via WebSocket');
  const statusDot = document.querySelector('.status-dot');
  if (statusDot) {
    statusDot.style.background = '#4caf50';
    statusDot.title = `Terhubung ke server | Socket ID: ${socket.id}`;
  }
  
  setTimeout(() => {
    socket.emit("getESP32Status");
    refreshESP32Status();
  }, 500);
});

socket.on("disconnect", () => {
  adminLogger.warn('Admin disconnected from WebSocket');
  const statusDot = document.querySelector('.status-dot');
  if (statusDot) {
    statusDot.style.background = '#f44336';
    statusDot.title = 'Terputus dari server';
  }
});

socket.on("esp32Status", (status) => {
  updateESP32Status(status);
});

socket.on("esp32Activity", (activity) => {
  const updatedStatus = {
    ...esp32Status,
    lastActivity: activity.timestamp,
    socketId: activity.socketId,
    ip: activity.ip,
    connected: true,
    connectionType: activity.activity?.type || "activity"
  };
  
  updateESP32Status(updatedStatus);
});

socket.on("autoPenaltyToggle", (data) => {
  autoPenaltyEnabled = data.enabled;
  updateAutoPenaltyUI();
});

socket.on("autoPenaltyConfig", (data) => {
  autoPenaltyEnabled = data.diaktifkan;
  updateAutoPenaltyUI();
});

socket.on("autoPenaltyStatus", (data) => {
  autoPenaltyEnabled = data.diaktifkan;
  updateAutoPenaltyUI();
});

socket.on("config", (c) => {
  config = c;
  document.getElementById("plus").value = c.plus;
  document.getElementById("minus").value = c.minus;
  document.getElementById("timerDuration").value = c.timerDuration;
  updateConfigDisplay();
});

// ===== KONTROL JURI YANG RESPONSIF =====
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
  const { team, score } = payload;
  const scoreEl = document.getElementById(`score-${team}`);
  if (scoreEl) {
    scoreEl.textContent = score;
    scoreEl.classList.add('score-update');
    setTimeout(() => scoreEl.classList.remove('score-update'), 600);
  }
});

socket.on("reset", (scores) => {
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const scoreEl = document.getElementById(`score-${i}`);
    if (scoreEl) {
      scoreEl.textContent = scores[i-1];
      scoreEl.classList.add('score-update');
      setTimeout(() => scoreEl.classList.remove('score-update'), 600);
    }
  }
});

socket.on("teamToggleUpdate", (data) => {
  const { team, enabled } = data;
  console.log(`[ADMIN] Team toggle update from server: Team ${team} = ${enabled}`);
  
  if (team >= 1 && team <= TEAM_COUNT) {
    teamStatus[team - 1] = enabled;
    
    const teamCard = document.querySelector(`.team-card[data-team="${team}"]`);
    const toggleBtn = document.getElementById(`toggle-${team}`);
    const badgeEl = document.getElementById(`badge-${team}`);
    
    if (teamCard && toggleBtn && badgeEl) {
      if (enabled) {
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
});

socket.on("allTeamsEnabled", () => {
  console.log('[ADMIN] All teams enabled from server');
  teamStatus = Array(TEAM_COUNT).fill(true);
  
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
});

socket.on("allTeamsDisabled", () => {
  console.log('[ADMIN] All teams disabled from server');
  teamStatus = Array(TEAM_COUNT).fill(false);
  
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const teamCard = document.querySelector(`.team-card[data-team="${i}"]`);
    const toggleBtn = document.getElementById(`toggle-${i}`);
    const badgeEl = document.getElementById(`badge-${i}`);
    
    if (teamCard && toggleBtn && badgeEl) {
      teamCard.classList.add('team-disabled');
      toggleBtn.textContent = 'AKTIFKAN';
      toggleBtn.classList.remove('toggle-on');
      toggleBtn.classList.add('toggle-off');
      badgeEl.textContent = "NONAKTIF";
      badgeEl.className = "team-status status-disabled";
    }
  }
});

socket.on("teamToggleState", (data) => {
  console.log('[ADMIN] Initial team toggle state from server:', data);
  if (Array.isArray(data)) {
    teamStatus = [...data];
  }
});

// ===== SYSTEM UNLOCKED EVENT =====
socket.on("systemUnlocked", (data) => {
  console.log('[ADMIN] System unlocked:', data);
  
  lockState = { locked: false, activeTeam: null, lockId: null, lockSequence: lockState.lockSequence };
  
  updateJuryControls(null);
  updateLockStateUI();
  
  const unlockBtn = document.getElementById("unlock");
  if (unlockBtn) {
    unlockBtn.textContent = "Buka Kunci Tombol";
    unlockBtn.disabled = true;
  }
});

// ===== TIMER EVENTS =====
function updateTimerStatus(state, seconds) {
  const timerState = document.getElementById("timerState");
  const currentTime = document.getElementById("currentTime");
  
  if (timerState) {
    timerState.textContent = state;
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
}

socket.on("timerStart", (data) => {
  updateTimerStatus('BERJALAN', data.duration);
});

socket.on("timerUpdate", (data) => {
  updateTimerStatus('BERJALAN', data.timeRemaining);
});

socket.on("timerReset", (data) => {
  updateTimerStatus('TIDAK AKTIF', 0);
});

// ===== UPDATE LOCK STATE UI =====
function updateLockStateUI() {
  const unlockBtn = document.getElementById("unlock");
  const juryControls = document.getElementById("juryControls");
  const waitingLabel = document.getElementById("waitingLabel");
  const activeTeamLabel = document.getElementById("activeTeamLabel");
  
  if (lockState.locked && lockState.activeTeam) {
    if (unlockBtn) {
      unlockBtn.textContent = `Buka Kunci (Tim ${getTeamLetter(lockState.activeTeam)} Aktif)`;
      unlockBtn.disabled = false;
    }
    
    if (juryControls) juryControls.style.display = "flex";
    if (waitingLabel) waitingLabel.style.display = "none";
    if (activeTeamLabel) {
      activeTeamLabel.textContent = `Tim ${getTeamLetter(lockState.activeTeam)} Sedang Aktif`;
      activeTeamLabel.style.display = "block";
    }
  } else {
    if (unlockBtn) {
      unlockBtn.textContent = "Buka Kunci Tombol";
      unlockBtn.disabled = true;
    }
    
    if (juryControls) juryControls.style.display = "none";
    if (waitingLabel) waitingLabel.style.display = "block";
    if (activeTeamLabel) activeTeamLabel.style.display = "none";
  }
}

// ===== INITIALIZE =====
function initializeAdmin() {
  createTeamControls();
  initializeJuryControls();
  initializeESP32Controls();
  initializeAutoPenaltyToggle();
  initializeEditScoreFeature();
  updateTimerStatus('TIDAK AKTIF', 0);
  
  refreshESP32Status();
  loadAutoPenaltyStatus();
  
  // Load semua data awal sekaligus
  Promise.all([
    fetch('/lockstate').then(r => r.json()),
    fetch('/scores').then(r => r.json()),
    fetch('/debug/esp32').then(r => r.json()),
    fetch('/teamToggleState').then(r => r.json()),
    fetch('/config').then(r => r.json()),
    fetch('/timerstatus').then(r => r.json())
  ]).then(([lockStateData, scoresData, esp32Data, toggleStateData, configData, timerData]) => {
    lockState = lockStateData;
    config = configData;
    
    // Handle scores data dengan benar
    const actualScores = Array.isArray(scoresData) ? scoresData : 
                        (scoresData.scores || Array(TEAM_COUNT).fill(0));
    
    for (let i = 1; i <= TEAM_COUNT; i++) {
      const scoreEl = document.getElementById(`score-${i}`);
      if (scoreEl) {
        scoreEl.textContent = actualScores[i-1] || 0;
      }
    }
    
    if (Array.isArray(toggleStateData)) {
      teamStatus = toggleStateData;
      console.log('[ADMIN] Initial team status:', teamStatus);
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
    
    updateESP32Status({
      connected: esp32Data.terhubung,
      lastActivity: esp32Data.aktivitasTerakhir,
      heartbeatCount: esp32Data.heartbeatCount,
      socketId: esp32Data.socketId,
      ip: esp32Data.ip,
      modulesDetected: esp32Data.modulTerdeteksi,
      activeTeams: esp32Data.timAktif,
      wifiRSSI: esp32Data.sinyalWiFi ? parseInt(esp32Data.sinyalWiFi) : null,
      rssiHistory: esp32Data.rssiHistory || []
    });
    
    if (timerData) {
      updateTimerStatus(
        timerData.timerRunning ? 'BERJALAN' : 'TIDAK AKTIF',
        timerData.timeRemaining || 0
      );
    }
    
    updateConfigDisplay();
    updateLockStateUI();
    
    adminLogger.info('Admin panel initialized successfully', {
      lockState: lockState,
      timerRunning: timerData?.timerRunning,
      esp32Connected: esp32Data.terhubung
    });
    
  }).catch(err => {
    adminLogger.error('Initial data load failed:', err);
    showNotification("Gagal memuat data awal!", "error");
  });
}

// ===== START =====
document.addEventListener('DOMContentLoaded', function() {
  adminLogger.info('Admin panel initializing...');
  initializeAdmin();
  
  const versionInfo = document.createElement('div');
  versionInfo.className = 'version-info';
  versionInfo.textContent = 'v2.3.0';
  versionInfo.title = 'Sistem dengan kontrol juri responsif, edit skor, ESP32 monitoring, dan atomic lock';
  document.querySelector('.admin-header').appendChild(versionInfo);
});