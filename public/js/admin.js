﻿/* Copyright © 2025 Ridwan and Team */
const socket = io();  // PERUBAHAN: Hapus namespace '/admin'
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
      editToggleBtn.innerHTML = 'SELESAI EDITING';
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
      editToggleBtn.innerHTML = 'EDIT SKOR';
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

// ===== UPDATE ESP32 STATUS DENGAN DETECTION DIPERBAIKI =====
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
  
  // PERBAIKAN: Jika ada RSSI history, update tampilan
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
  
  // Update informasi sinyal WiFi - DIPERBAIKI DENGAN HISTORY
  if (esp32WiFiRSSI) {
    if (esp32Status.wifiRSSI !== undefined && esp32Status.wifiRSSI !== null) {
      esp32WiFiRSSI.textContent = `${esp32Status.wifiRSSI} dBm`;
      
      // Logika warna berdasarkan kekuatan sinyal yang benar
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
      
      // PERBAIKAN: Tampilkan RSSI history jika ada
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
      
      // PERBAIKAN: Refresh jika mendekati timeout
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

// ===== CREATE TEAM CONTROLS DIPERBAIKI =====
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
    
    // PERBAIKAN: Tambah tooltip dengan informasi lock sequence
    teamDiv.title = `Tim ${getTeamLetter(i)} - Klik untuk melihat detail`;
    
    teamDiv.addEventListener('mouseenter', () => {
      if (teamStatus[i - 1]) {
        teamDiv.style.transform = 'translateY(-3px)';
        teamDiv.style.boxShadow = '0 8px 20px rgba(255, 215, 0, 0.2)';
        
        // Tampilkan informasi sequence jika ada
        const sequenceEl = document.getElementById(`sequence-${i}`);
        if (sequenceEl && sequenceEl.textContent) {
          teamDiv.title = `Tim ${getTeamLetter(i)} - Sequence: ${sequenceEl.textContent}`;
        }
      }
    });
    
    teamDiv.addEventListener('mouseleave', () => {
      teamDiv.style.transform = 'translateY(0)';
      teamDiv.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
      teamDiv.title = `Tim ${getTeamLetter(i)} - Klik untuk melihat detail`;
    });
    
    // PERBAIKAN: Tambah klik untuk melihat detail lock
    teamDiv.addEventListener('click', () => {
      if (lockState.locked && lockState.activeTeam === i) {
        showNotification(`Tim ${getTeamLetter(i)} aktif | Lock ID: ${lockState.lockId || 'N/A'} | Sequence: ${lockState.lockSequence || '0'}`, "info");
      }
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

// ===== ESP32 CONTROLS DIPERBAIKI =====
function initializeESP32Controls() {
  const refreshBtn = document.getElementById("refreshESP32");
  const testBtn = document.getElementById("testESP32");
  const forceUnlockBtn = document.getElementById("forceUnlockAll");
  const syncBtn = document.getElementById("manualSync");
  const forceUnlockWSBtn = document.getElementById("forceUnlockWS");
  const fullStateBtn = document.getElementById("fullStateRecovery");
  
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
  
  // PERBAIKAN: Tambah tombol untuk force unlock via WebSocket
  if (!forceUnlockWSBtn) {
    const esp32Actions = document.querySelector(".controller-actions");
    if (esp32Actions) {
      const newBtn = document.createElement("button");
      newBtn.id = "forceUnlockWS";
      newBtn.className = "admin-btn btn-danger";
      newBtn.textContent = "FORCE UNLOCK (WS)";
      newBtn.title = "Force unlock via WebSocket langsung ke ESP32";
      esp32Actions.appendChild(newBtn);
      
      newBtn.addEventListener("click", forceUnlockViaWebSocket);
    }
  }
  
  // PERBAIKAN: Tambah tombol untuk full state recovery
  if (!fullStateBtn) {
    const esp32Actions = document.querySelector(".controller-actions");
    if (esp32Actions) {
      const newBtn = document.createElement("button");
      newBtn.id = "fullStateRecovery";
      newBtn.className = "admin-btn btn-info";
      newBtn.textContent = "FULL STATE SYNC";
      newBtn.title = "Sinkronisasi state lengkap dengan ESP32";
      esp32Actions.appendChild(newBtn);
      
      newBtn.addEventListener("click", requestFullStateSync);
    }
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

// ===== START ESP32 POLLING DIPERBAIKI =====
function startESP32RealTimePolling() {
  // Polling untuk status ESP32 (10 detik)
  setInterval(() => {
    socket.emit("getESP32Status");
    
    // PERBAIKAN: Ambil status dari endpoint yang diperbarui
    fetch('/esp32status')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        // Update status dengan data yang diterima
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
  
  // PERBAIKAN: Polling untuk full state setiap 30 detik
  setInterval(() => {
    if (esp32Status.connected && esp32Status.socketId) {
      fetchFullState();
    }
  }, 30000);
}

// ===== FUNGSI BARU: FORCE UNLOCK VIA WEBSOCKET =====
function forceUnlockViaWebSocket() {
  if (!confirm("Yakin ingin membuka kunci paksa via WebSocket?\nIni akan mengirim perintah langsung ke ESP32 yang terhubung.")) return;
  
  const btn = document.getElementById('forceUnlockWS') || document.getElementById('forceUnlockAll');
  const originalText = btn.textContent;
  
  btn.disabled = true;
  btn.textContent = 'MENGIRIM KE ESP32...';
  btn.classList.add('loading');
  
  // Kirim via WebSocket
  socket.emit("forceUnlockRequest", {}, (response) => {
    if (response && response.success) {
      showNotification("Force unlock berhasil dikirim ke ESP32!", "success");
      
      // Update UI lokal
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
      
      adminLogger.info("Force unlock via WebSocket berhasil", response);
    } else {
      showNotification("❌ Gagal mengirim force unlock via WebSocket!", "error");
      adminLogger.error("Force unlock via WebSocket gagal", response);
    }
    
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = originalText;
      btn.classList.remove('loading');
    }, 1000);
  });
  
  // Timeout jika tidak ada response
  setTimeout(() => {
    if (btn.disabled) {
      btn.disabled = false;
      btn.textContent = originalText;
      btn.classList.remove('loading');
      showNotification("⚠️ Timeout: ESP32 mungkin tidak merespons", "warning");
    }
  }, 5000);
}

// ===== FUNGSI BARU: REQUEST FULL STATE SYNC =====
function requestFullStateSync() {
  const btn = document.getElementById('fullStateRecovery');
  const originalText = btn.textContent;
  
  btn.disabled = true;
  btn.textContent = 'SYNCING STATE...';
  btn.classList.add('loading');
  
  fetch('/fullstate')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      if (data.success) {
        showNotification("State sync berhasil!", "success");
        
        // Update semua data dari server
        updateAllStateFromServer(data);
        
        // Kirim ke ESP32 jika terhubung via WebSocket
        if (esp32Status.connected && esp32Status.socketId) {
          socket.emit("requestStateRecovery", {}, (response) => {
            if (response && response.success) {
              showNotification("State sync ke ESP32 berhasil!", "success");
            }
          });
        }
        
        adminLogger.info("Full state recovery completed", {
          lockId: data.lockState.lockId,
          timerRunning: data.timer.isRunning,
          checksum: data.checksum
        });
      }
    })
    .catch(err => {
      adminLogger.error('Full state sync failed:', err);
      showNotification("❌ State sync gagal!", "error");
    })
    .finally(() => {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = originalText;
        btn.classList.remove('loading');
      }, 1000);
    });
}

// ===== FUNGSI BARU: UPDATE ALL STATE FROM SERVER =====
function updateAllStateFromServer(stateData) {
  // Update scores
  if (stateData.scores && Array.isArray(stateData.scores)) {
    for (let i = 1; i <= TEAM_COUNT; i++) {
      const scoreEl = document.getElementById(`score-${i}`);
      if (scoreEl) {
        scoreEl.textContent = stateData.scores[i-1];
      }
    }
  }
  
  // Update lock state
  if (stateData.lockState) {
    lockState = stateData.lockState;
    updateLockStateUI();
  }
  
  // Update timer
  if (stateData.timer) {
    updateTimerStatus(
      stateData.timer.isRunning ? 'BERJALAN' : 'TIDAK AKTIF',
      stateData.timer.remaining || 0
    );
  }
  
  // Update config
  if (stateData.config) {
    config = stateData.config;
    updateConfigDisplay();
  }
  
  // Update ESP32 status
  if (stateData.esp32Status) {
    updateESP32Status(stateData.esp32Status);
  }
  
  adminLogger.info("All state updated from server", {
    lockId: lockState.lockId,
    timerRunning: stateData.timer?.isRunning,
    checksum: stateData.checksum
  });
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

// ===== FUNGSI BARU: FETCH FULL STATE =====
function fetchFullState() {
  fetch('/fullstate')
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        // Update sequence numbers di tampilan
        for (let i = 1; i <= TEAM_COUNT; i++) {
          const sequenceEl = document.getElementById(`sequence-${i}`);
          if (sequenceEl) {
            if (lockState.locked && lockState.activeTeam === i) {
              sequenceEl.textContent = `Seq: ${lockState.lockSequence || '0'}`;
              sequenceEl.style.display = 'block';
            } else {
              sequenceEl.style.display = 'none';
            }
          }
        }
      }
    })
    .catch(err => {
      console.error('Fetch full state error:', err);
    });
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
  
  // PERBAIKAN: Update juga di input fields
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

// ===== JURY CONTROLS DIPERBAIKI =====
function initializeJuryControls() {
  const juryPlus = document.getElementById("juryPlus");
  const juryMinus = document.getElementById("juryMinus");
  
  if (juryPlus) {
    juryPlus.addEventListener("click", handleJuryPlus);
  }
  
  if (juryMinus) {
    juryMinus.addEventListener("click", handleJuryMinus);
  }
  
  // Initialize in waiting state
  updateJuryControls(null);
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
      juryControls.style.animation = "fadeIn 0.3s ease-in";
    }
    if (waitingLabel) {
      waitingLabel.style.display = "none";
    }
    if (activeTeamLabel) {
      activeTeamLabel.textContent = `Tim ${getTeamLetter(activeTeam)} Sedang Aktif`;
      activeTeamLabel.style.display = "block";
      activeTeamLabel.style.animation = "pulse 2s infinite";
      activeTeamLabel.style.color = "#4caf50";
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

function handleJuryAction(isCorrect) {
  if (!lockState.activeTeam) {
    showNotification("Tidak ada tim aktif!", "warning");
    return;
  }
  
  const points = isCorrect ? config.plus : config.minus;
  const team = lockState.activeTeam;
  const teamLetter = getTeamLetter(team);
  
  // Show loading state
  const juryBtn = isCorrect ? document.getElementById("juryPlus") : document.getElementById("juryMinus");
  const originalText = juryBtn.innerHTML;
  juryBtn.innerHTML = '<span class="loading-spinner"></span> MEMPROSES...';
  juryBtn.disabled = true;
  
  // Disable the other button too
  const otherBtn = isCorrect ? document.getElementById("juryMinus") : document.getElementById("juryPlus");
  if (otherBtn) {
    otherBtn.disabled = true;
  }
  
  fetch(`/update?team=${team}&add=${points}`)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    })
    .then(data => {
      showNotification(isCorrect ? `Tim ${teamLetter} benar! +${points} poin!` : `Tim ${teamLetter} salah! ${points} poin!`, isCorrect ? "success" : "warning");
      
      // Reset jury controls after a short delay
      setTimeout(() => {
        updateJuryControls(null);
      }, 1000);
      
      adminLogger.info(`Jury action: Team ${teamLetter} ${isCorrect ? 'correct' : 'wrong'} (${points} points)`);
    })
    .catch(err => {
      showNotification(`Gagal memberikan poin!`, "error");
      juryBtn.innerHTML = originalText;
      juryBtn.disabled = false;
      if (otherBtn) otherBtn.disabled = false;
    });
}

function handleJuryPlus() {
  handleJuryAction(true);
}

function handleJuryMinus() {
  handleJuryAction(false);
}

// ===== HIGH-SPEED NOTIFICATION DIPERBAIKI =====
function showNotification(message, type = "success") {
  requestAnimationFrame(() => {
    const existingNotification = document.querySelector('.admin-notification');
    if (existingNotification) {
      existingNotification.remove();
    }
    
    const notification = document.createElement('div');
    notification.className = `admin-notification ${type}`;
    
    // PERBAIKAN: Tambah icon berdasarkan type
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

// ===== SOCKET EVENTS DIPERBAIKI =====
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
    fetchFullState();
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

// ===== PERBAIKAN PENTING: Tambah handler untuk event "buzz" =====
socket.on("buzz", (data) => {
  const { team, lockId, lockSequence } = data;
  
  adminLogger.info(`Buzz received: Team ${getTeamLetter(team)}`, {
    lockId,
    lockSequence
  });
  
  // Update lock state locally
  lockState = {
    locked: true,
    activeTeam: team,
    lockId: lockId,
    lockSequence: lockSequence || lockState.lockSequence + 1,
    lockTime: Date.now()
  };
  
  // Update UI immediately
  updateLockStateUI();
  updateJuryControls(team);
  
  // Update badge untuk tim yang aktif
  const badgeEl = document.getElementById(`badge-${team}`);
  if (badgeEl) {
    badgeEl.textContent = "AKTIF";
    badgeEl.className = "team-status status-active";
  }
  
  // Update sequence display
  const sequenceEl = document.getElementById(`sequence-${team}`);
  if (sequenceEl) {
    sequenceEl.textContent = `Seq: ${lockSequence || '0'}`;
    sequenceEl.style.display = 'block';
  }
  
  // Highlight the active team card
  const teamCard = document.querySelector(`.team-card[data-team="${team}"]`);
  if (teamCard) {
    teamCard.classList.add('active');
    teamCard.style.boxShadow = '0 0 15px gold';
  }
  
  showNotification(`Tim ${getTeamLetter(team)} menekan tombol!`, "info");
});

// ===== TAMBAHKAN JUGA UNTUK AUDIO EVENTS =====
socket.on("playPreTeamAudio", (data) => {
  adminLogger.info(`Buzzer audio untuk Tim ${getTeamLetter(data.team)}`);
});

socket.on("playTeamAudio", (data) => {
  adminLogger.info(`Team audio mulai: Tim ${getTeamLetter(data.team)}`);
});

socket.on("esp32Status", (status) => {
  console.log("ESP32 Status received via Socket.IO:", {
    connected: status.connected,
    lastActivity: status.lastActivity,
    modulesDetected: status.modulesDetected,
    activeTeams: status.activeTeams,
    wifiRSSI: status.wifiRSSI,
    socketId: status.socketId
  });
  updateESP32Status(status);
});

// PERBAIKAN: Event baru untuk warning dari ESP32
socket.on("esp32Warning", (data) => {
  console.warn("ESP32 Warning:", data);
  
  let message = data.message || "Peringatan dari ESP32";
  let type = "warning";
  
  if (data.type === 'weak_signal') {
    message = `⚠️ Sinyal WiFi ESP32 lemah: ${data.rssi} dBm`;
    type = "warning";
  } else if (data.type === 'timeout') {
    message = `⏰ ESP32 timeout: ${data.message}`;
    type = "error";
  } else if (data.type === 'websocket_disconnected') {
    message = `🔌 ESP32 WebSocket terputus: ${data.message}`;
    type = "warning";
  }
  
  showNotification(message, type);
  
  // Update badge jika ada warning
  const esp32Badge = document.getElementById("esp32Badge");
  if (esp32Badge && data.type === 'weak_signal') {
    esp32Badge.classList.add('warning');
    esp32Badge.title = `Sinyal lemah: ${data.rssi} dBm`;
  }
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

// PERBAIKAN: Event baru untuk full state sync
socket.on("fullStateSync", (data) => {
  console.log("Full state sync received from server:", data);
  updateAllStateFromServer(data);
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

// ===== PERBAIKAN: Lockstate dengan sequence number =====
socket.on("lockstate", (state) => {
  lockState = state;
  
  const unlockBtn = document.getElementById("unlock");
  const forceUnlockBtn = document.getElementById("forceUnlockAll");
  const forceUnlockWSBtn = document.getElementById("forceUnlockWS");

  if (unlockBtn) {
    unlockBtn.textContent = state.locked ? 
      `Buka Kunci (Tim ${getTeamLetter(state.activeTeam)} Aktif)` : 
      "Buka Kunci Tombol";
    unlockBtn.disabled = !state.locked;
  }

  if (forceUnlockBtn) {
    forceUnlockBtn.disabled = !state.locked;
  }
  
  if (forceUnlockWSBtn) {
    forceUnlockWSBtn.disabled = !state.locked;
  }

  // PERBAIKAN PENTING: Update jury controls berdasarkan lock state
  updateJuryControls(state.activeTeam);

  // PERBAIKAN: Update sequence numbers di tampilan tim
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const badgeEl = document.getElementById(`badge-${i}`);
    const teamCard = document.querySelector(`.team-card[data-team="${i}"]`);
    const sequenceEl = document.getElementById(`sequence-${i}`);
    
    if (badgeEl) {
      if (!teamStatus[i - 1]) {
        badgeEl.textContent = "NONAKTIF";
        badgeEl.className = "team-status status-disabled";
        if (teamCard) teamCard.classList.add('team-disabled');
        if (sequenceEl) sequenceEl.style.display = 'none';
      } else if (state.locked && state.activeTeam === i) {
        badgeEl.textContent = "AKTIF";
        badgeEl.className = "team-status status-active";
        if (teamCard) {
          teamCard.classList.add('active');
          teamCard.classList.remove('team-disabled');
          teamCard.style.boxShadow = '0 0 15px gold';
        }
        if (sequenceEl) {
          sequenceEl.textContent = `Seq: ${state.lockSequence || '0'}`;
          sequenceEl.style.display = 'block';
        }
      } else {
        badgeEl.textContent = "MENUNGGU";
        badgeEl.className = "team-status status-waiting";
        if (teamCard) {
          teamCard.classList.remove('active');
          teamCard.classList.remove('team-disabled');
          teamCard.style.boxShadow = '';
        }
        if (sequenceEl) sequenceEl.style.display = 'none';
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

// ===== TIMER EVENTS DIPERBAIKI =====
function updateTimerStatus(state, seconds) {
  const timerState = document.getElementById("timerState");
  const currentTime = document.getElementById("currentTime");
  
  if (timerState) {
    timerState.textContent = state;
    
    // PERBAIKAN: Tambah tooltip dengan lock ID
    if (lockState.locked && lockState.lockId) {
      timerState.title = `Lock ID: ${lockState.lockId}`;
    } else {
      timerState.title = '';
    }
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
  
  // PERBAIKAN: Tampilkan informasi lock
  if (data.lockId) {
    console.log(`[TIMER] Started with lock ID: ${data.lockId}`);
  }
});

socket.on("timerUpdate", (data) => {
  updateTimerStatus('BERJALAN', data.timeRemaining);
});

socket.on("timerReset", (data) => {
  updateTimerStatus('TIDAK AKTIF', 0);
  
  // PERBAIKAN: Log reset dengan lock ID
  if (data && data.lockId) {
    console.log(`[TIMER] Reset for lock ID: ${data.lockId}`);
  }
});

socket.on("systemUnlocked", (data) => {
  updateTimerStatus('TIDAK AKTIF', 0);
  lockState = { locked: false, activeTeam: null, lockId: null, lockSequence: lockState.lockSequence };
  
  const unlockBtn = document.getElementById("unlock");
  const forceUnlockBtn = document.getElementById("forceUnlockAll");
  const forceUnlockWSBtn = document.getElementById("forceUnlockWS");
  
  if (unlockBtn) {
    unlockBtn.textContent = "Buka Kunci Tombol";
    unlockBtn.disabled = true;
  }

  if (forceUnlockBtn) {
    forceUnlockBtn.disabled = true;
  }
  
  if (forceUnlockWSBtn) {
    forceUnlockWSBtn.disabled = true;
  }
  
  // Reset jury controls
  updateJuryControls(null);
  
  for (let i = 1; i <= TEAM_COUNT; i++) {
    const badgeEl = document.getElementById(`badge-${i}`);
    const sequenceEl = document.getElementById(`sequence-${i}`);
    if (badgeEl && teamStatus[i - 1]) {
      badgeEl.textContent = "MENUNGGU";
      badgeEl.className = "team-status status-waiting";
    }
    if (sequenceEl) {
      sequenceEl.style.display = 'none';
    }
  }
  
  // PERBAIKAN: Log unlock reason
  if (data && data.reason) {
    console.log(`[SYSTEM] Unlocked with reason: ${data.reason}`, data);
  }
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
      activeTeamLabel.textContent = `Tim ${getTeamLetter(lockState.activeTeam)} Sedang Aktif | Seq: ${lockState.lockSequence || '0'}`;
      activeTeamLabel.style.display = "block";
      activeTeamLabel.style.color = "#4caf50";
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

// ===== FUNGSI BARU: LOAD INITIAL DATA =====
async function loadInitialData() {
  try {
    const [
      lockStateRes, 
      scoresRes, 
      esp32Res, 
      toggleStateRes, 
      configRes, 
      timerRes
    ] = await Promise.all([
      fetch('/lockstate').then(r => r.json()),
      fetch('/scores').then(r => r.json()),
      fetch('/debug/esp32').then(r => r.json()),
      fetch('/teamToggleState').then(r => r.json()),
      fetch('/config').then(r => r.json()),
      fetch('/timerstatus').then(r => r.json())
    ]);
    
    // Update lock state
    lockState = lockStateRes;
    
    // Update scores
    if (Array.isArray(scoresRes)) {
      for (let i = 1; i <= TEAM_COUNT; i++) {
        const scoreEl = document.getElementById(`score-${i}`);
        if (scoreEl) {
          scoreEl.textContent = scoresRes[i-1];
        }
      }
    }
    
    // Update config
    config = configRes;
    updateConfigDisplay();
    
    // Update team toggle state
    if (Array.isArray(toggleStateRes)) {
      teamStatus = [...toggleStateRes];
      adminLogger.info('Initial team status loaded:', teamStatus);
    }
    
    // Update ESP32 status
    updateESP32Status({
      connected: esp32Res.terhubung,
      lastActivity: esp32Res.aktivitasTerakhir,
      heartbeatCount: esp32Res.heartbeatCount,
      socketId: esp32Res.socketId,
      ip: esp32Res.ip,
      modulesDetected: esp32Res.modulTerdeteksi,
      activeTeams: esp32Res.timAktif,
      wifiRSSI: esp32Res.sinyalWiFi ? parseInt(esp32Res.sinyalWiFi) : null,
      rssiHistory: esp32Res.rssiHistory || []
    });
    
    // Update timer
    if (timerRes) {
      updateTimerStatus(
        timerRes.timerRunning ? 'BERJALAN' : 'TIDAK AKTIF',
        timerRes.timeRemaining || 0
      );
    }
    
    // Update lock state UI
    updateLockStateUI();
    updateJuryControls(lockState.activeTeam);
    
    adminLogger.info('Initial data loaded successfully', {
      lockState: lockState,
      timerRunning: timerRes?.timerRunning,
      esp32Connected: esp32Res.terhubung
    });
    
    return true;
    
  } catch (error) {
    adminLogger.error('Failed to load initial data:', error);
    throw error;
  }
}

// ===== INITIALIZE DIPERBAIKI =====
function initializeAdmin() {
  adminLogger.info('Starting admin initialization...');
  
  // Load initial data FIRST
  loadInitialData().then(() => {
    // Setup UI components after data is loaded
    createTeamControls();
    initializeJuryControls();
    initializeESP32Controls();
    initializeAutoPenaltyToggle();
    initializeEditScoreFeature();
    updateTimerStatus('TIDAK AKTIF', 0);
    
    // Initialize team cards based on loaded data
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
    
    // Load auto penalty status
    loadAutoPenaltyStatus();
    
    adminLogger.info('Admin panel fully initialized');
    
  }).catch(err => {
    adminLogger.error('Admin initialization failed:', err);
    showNotification("Gagal memuat data awal!", "error");
    
    // Fallback: still setup basic UI
    createTeamControls();
    initializeJuryControls();
    updateTimerStatus('TIDAK AKTIF', 0);
  });
}

// ===== START =====
document.addEventListener('DOMContentLoaded', function() {
  adminLogger.info('Admin panel initializing...');
  initializeAdmin();
  
  // PERBAIKAN: Tambah event untuk menampilkan informasi versi
  const versionInfo = document.createElement('div');
  versionInfo.className = 'version-info';
  versionInfo.textContent = 'v2.2.1';
  versionInfo.title = 'Sistem dengan atomic lock, state recovery, WebSocket integration, dan edit skor manual';
  
  const header = document.querySelector('.admin-header');
  if (header) {
    header.appendChild(versionInfo);
  }
  
  // PERBAIKAN: Tambah CSS untuk animasi
  const style = document.createElement('style');
  style.textContent = `
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.7); }
      70% { box-shadow: 0 0 0 10px rgba(76, 175, 80, 0); }
      100% { box-shadow: 0 0 0 0 rgba(76, 175, 80, 0); }
    }
    
    .team-card.active {
      border: 3px solid #4caf50 !important;
      box-shadow: 0 0 15px gold !important;
      transform: scale(1.05);
      transition: all 0.3s ease;
    }
  `;
  document.head.appendChild(style);
});