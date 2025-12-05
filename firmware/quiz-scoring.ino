/*
  ESP32 master for Quiz Scoring system – ATOMIC FIXED VERSION
  Dengan global lock untuk mencegah race condition
  Hanya tim pertama yang akan terkunci meskipun ada multiple press
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>

// ========== CONFIGURABLE ==========
const char *DEFAULT_SERVER_HOST = "web-scoring-board-production.up.railway.app";
const int   DEFAULT_SERVER_PORT = 443;
const char *WIFI_AP_NAME = "Quiz_Config";

// ========== LED STATUS PINS ==========
const int LED_MERAH = 33;  // G33 untuk LED Merah
const int LED_HIJAU = 32;  // G32 untuk LED Hijau

// Fixed PCF8574 I2C addresses with team mapping
const uint8_t PCF_MODULE_A_C = 0x20;  // Teams A, B, C  (1,2,3)
const uint8_t PCF_MODULE_D_F = 0x21;  // Teams D, E, F  (4,5,6)
const uint8_t PCF_MODULE_G_I = 0x22;  // Teams G, H, I  (7,8,9)
const uint8_t PCF_MODULE_J_L = 0x23;  // Teams J, K, L  (10,11,12)

const uint8_t MODULE_ADDRESSES[4] = {
  PCF_MODULE_A_C,  // Index 0: Teams 1-3
  PCF_MODULE_D_F,  // Index 1: Teams 4-6  
  PCF_MODULE_G_I,  // Index 2: Teams 7-9
  PCF_MODULE_J_L   // Index 3: Teams 10-12
};

const char* TEAM_NAMES[12] = {
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"
};

// Pins
const int PIN_JURY_CORRECT = 4;
const int PIN_JURY_WRONG   = 5;

// ====== BUTTON-LED MAPPING ======
struct ButtonLEDMapping {
  uint8_t moduleAddress;  // Alamat I2C module
  uint8_t buttonBit;      // Bit untuk tombol (0-2)
  uint8_t ledBit;         // Bit untuk LED (3,4,5) - P3,P4,P5
  uint8_t teamNumber;     // Nomor tim (1-12)
  const char* teamName;   // Nama tim
};

const ButtonLEDMapping TEAM_MAPPINGS[12] = {
  // Module 0x20 - Teams A, B, C
  {0x20, 0, 3, 1, "A"},
  {0x20, 1, 4, 2, "B"},
  {0x20, 2, 5, 3, "C"},
  
  // Module 0x21 - Teams D, E, F
  {0x21, 0, 3, 4, "D"},
  {0x21, 1, 4, 5, "E"},
  {0x21, 2, 5, 6, "F"},
  
  // Module 0x22 - Teams G, H, I
  {0x22, 0, 3, 7, "G"},
  {0x22, 1, 4, 8, "H"},
  {0x22, 2, 5, 9, "I"},
  
  // Module 0x23 - Teams J, K, L
  {0x23, 0, 3, 10, "J"},
  {0x23, 1, 4, 11, "K"},
  {0x23, 2, 5, 12, "L"}
};

// ========== STATUS LED VARIABLES ==========
enum SystemStatus {
  STATUS_BOOTING,
  STATUS_WIFI_CONNECTING,
  STATUS_WIFI_CONNECTED,
  STATUS_WEB_CONNECTED
};

SystemStatus currentStatus = STATUS_BOOTING;
unsigned long lastBlinkTime = 0;
bool blinkState = false;
const unsigned long BLINK_INTERVAL = 500;

// ========== WIFI RESET FEATURE ==========
bool wifiResetActive = false;
unsigned long wifiResetStartTime = 0;
const unsigned long WIFI_RESET_DURATION = 5000;
bool wifiResetTriggered = false;

// ====== ATOMIC LOCK SYSTEM ======
volatile bool globalButtonLock = false;           // GLOBAL LOCK FLAG
volatile unsigned long globalLockStartTime = 0;   // Waktu lock dimulai
const unsigned long GLOBAL_LOCK_TIMEOUT = 2000;   // 2 detik timeout lock
volatile int pendingTeamToSend = 0;               // Tim yang menunggu dikirim
volatile bool hasPendingRequest = false;          // Ada request pending
volatile bool httpInProgress = false;             // HTTP sedang berjalan

// ====== TIMINGS OPTIMIZED ======
const unsigned long DEBOUNCE_MS        = 25;
const unsigned long JURY_DEBOUNCE_MS   = 50;
const unsigned long LOCK_POLL_MS       = 1000;
const unsigned long MODULE_SCAN_MS     = 5000;
const unsigned long BUTTON_LED_DURATION = 500;
const unsigned long WATCHDOG_TIMEOUT   = 30000;
const unsigned long HTTP_SEND_TIMEOUT  = 800;     // Timeout send HTTP

// ====== HEARTBEAT SYSTEM (PERBAIKAN BARU) ======
unsigned long lastHeartbeatTime = 0;
const unsigned long HEARTBEAT_INTERVAL = 30000;   // Setiap 30 detik
unsigned long heartbeatCount = 0;

// ====== STATE ======
char serverHost[64];
int  serverPort = DEFAULT_SERVER_PORT;

bool lockActive = false;
int  activeTeam = 0;

// Module management
bool moduleDetected[4] = {false, false, false, false};
uint8_t pcfOutCache[4];
uint8_t lastRead[4];
unsigned long lastDebounceTime[14];
bool lastJuryCorrectState = HIGH;
bool lastJuryWrongState   = HIGH;
int plusValue  = 5;
int minusValue = -2;

// Button LED feedback
unsigned long buttonLedStartTime[12] = {0};
bool buttonLedActive[12] = {false};

// WiFi stability
int wifiDisconnectCount = 0;
unsigned long lastWifiCheck = 0;

// Watchdog
unsigned long lastWatchdogFeed = 0;
unsigned long lastSystemCheck = 0;

// ========== HELPER FUNCTIONS ==========
int getModuleIndex(uint8_t moduleAddress) {
  for (int i = 0; i < 4; i++) {
    if (MODULE_ADDRESSES[i] == moduleAddress) return i;
  }
  return -1;
}

// ========== HEARTBEAT FUNCTIONS (PERBAIKAN BARU) ==========
void sendHeartbeatToServer() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[HEARTBEAT] WiFi tidak terhubung, skip heartbeat");
    return;
  }
  
  String url = "https://" + String(serverHost) + "/esp32checkin?action=heartbeat&count=" + String(heartbeatCount);
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(3000);
  http.setTimeout(3000);
  
  bool success = http.begin(url);
  if (success) {
    int code = http.GET();
    unsigned long elapsed = millis() - lastHeartbeatTime;
    
    Serial.printf("[HEARTBEAT] #%d -> Code: %d, Time: %dms\n", 
                  heartbeatCount, code, elapsed);
    
    http.end();
    
    if (code == 200) {
      heartbeatCount++;
    }
  } else {
    Serial.println("[HEARTBEAT] Gagal memulai koneksi");
  }
}

void handleHeartbeat() {
  unsigned long now = millis();
  
  if (now - lastHeartbeatTime >= HEARTBEAT_INTERVAL) {
    lastHeartbeatTime = now;
    sendHeartbeatToServer();
  }
}

// ========== ATOMIC LOCK MANAGEMENT ==========
bool acquireGlobalLock(int team) {
  unsigned long now = millis();
  
  // Cek jika lock sudah expired (timeout)
  if (globalButtonLock && (now - globalLockStartTime > GLOBAL_LOCK_TIMEOUT)) {
    Serial.printf("[LOCK] Global lock expired after %dms, releasing\n", GLOBAL_LOCK_TIMEOUT);
    globalButtonLock = false;
    hasPendingRequest = false;
    pendingTeamToSend = 0;
    httpInProgress = false;
  }
  
  // Cek jika HTTP masih berjalan
  if (httpInProgress) {
    Serial.printf("[LOCK] Cannot acquire lock - HTTP in progress for Team %s\n", TEAM_NAMES[pendingTeamToSend-1]);
    return false;
  }
  
  // Coba acquire lock
  if (!globalButtonLock) {
    globalButtonLock = true;
    globalLockStartTime = now;
    pendingTeamToSend = team;
    hasPendingRequest = true;
    httpInProgress = true;
    
    Serial.printf("[LOCK] Global lock ACQUIRED for Team %s at %lu\n", TEAM_NAMES[team-1], now);
    return true;
  }
  
  Serial.printf("[LOCK] Global lock BUSY (Team %s waiting), current lock for Team %s\n", 
                TEAM_NAMES[team-1], TEAM_NAMES[pendingTeamToSend-1]);
  return false;
}

void releaseGlobalLock() {
  globalButtonLock = false;
  hasPendingRequest = false;
  pendingTeamToSend = 0;
  httpInProgress = false;
  Serial.println("[LOCK] Global lock RELEASED");
}

void forceReleaseGlobalLock() {
  if (globalButtonLock) {
    Serial.println("[LOCK] Force releasing global lock");
    releaseGlobalLock();
  }
}

// ========== WIFI RESET FUNCTIONS ==========
void handleWifiReset() {
  bool corrPressed = digitalRead(PIN_JURY_CORRECT) == LOW;
  bool wrongPressed = digitalRead(PIN_JURY_WRONG) == LOW;
  unsigned long now = millis();

  if (corrPressed && wrongPressed) {
    if (!wifiResetActive) {
      wifiResetActive = true;
      wifiResetStartTime = now;
      Serial.println("[WIFI-RESET] Both jury buttons pressed - starting reset timer");
      
      digitalWrite(LED_MERAH, HIGH);
      digitalWrite(LED_HIJAU, HIGH);
    } else {
      unsigned long elapsed = now - wifiResetStartTime;
      float progress = (float)elapsed / WIFI_RESET_DURATION;
      
      if (elapsed % 300 < 150) {
        digitalWrite(LED_MERAH, HIGH);
        digitalWrite(LED_HIJAU, HIGH);
      } else {
        digitalWrite(LED_MERAH, LOW);
        digitalWrite(LED_HIJAU, LOW);
      }
      
      if (elapsed >= WIFI_RESET_DURATION && !wifiResetTriggered) {
        wifiResetTriggered = true;
        triggerWifiReset();
      }
    }
  } else {
    if (wifiResetActive) {
      wifiResetActive = false;
      wifiResetTriggered = false;
      Serial.println("[WIFI-RESET] Reset cancelled - button released");
      updateStatusLED();
    }
  }
}

void triggerWifiReset() {
  Serial.println("\n[WIFI-RESET] ====== WIFI RESET TRIGGERED ======");
  Serial.println("[WIFI-RESET] Clearing saved WiFi credentials");
  
  digitalWrite(LED_MERAH, HIGH);
  digitalWrite(LED_HIJAU, HIGH);
  delay(1000);
  
  WiFiManager wm;
  wm.resetSettings();
  
  Serial.println("[WIFI-RESET] WiFi credentials cleared");
  Serial.println("[WIFI-RESET] Restarting ESP32...");
  
  delay(2000);
  ESP.restart();
}

// ========== STATUS LED FUNCTIONS ==========
void updateStatusLED() {
  unsigned long now = millis();
  
  if (wifiResetActive) return;
  
  switch (currentStatus) {
    case STATUS_BOOTING:
      if (now - lastBlinkTime >= BLINK_INTERVAL) {
        lastBlinkTime = now;
        blinkState = !blinkState;
        digitalWrite(LED_MERAH, blinkState ? HIGH : LOW);
        digitalWrite(LED_HIJAU, LOW);
      }
      break;
      
    case STATUS_WIFI_CONNECTING:
      digitalWrite(LED_MERAH, HIGH);
      digitalWrite(LED_HIJAU, LOW);
      break;
      
    case STATUS_WIFI_CONNECTED:
      if (now - lastBlinkTime >= BLINK_INTERVAL) {
        lastBlinkTime = now;
        blinkState = !blinkState;
        digitalWrite(LED_HIJAU, blinkState ? HIGH : LOW);
        digitalWrite(LED_MERAH, LOW);
      }
      break;
      
    case STATUS_WEB_CONNECTED:
      digitalWrite(LED_HIJAU, HIGH);
      digitalWrite(LED_MERAH, LOW);
      break;
  }
}

void setSystemStatus(SystemStatus newStatus) {
  if (currentStatus != newStatus) {
    currentStatus = newStatus;
    lastBlinkTime = millis();
    blinkState = false;
    
    Serial.printf("[STATUS] System status changed to: ");
    switch (currentStatus) {
      case STATUS_BOOTING: Serial.println("BOOTING"); break;
      case STATUS_WIFI_CONNECTING: Serial.println("WIFI_CONNECTING"); break;
      case STATUS_WIFI_CONNECTED: Serial.println("WIFI_CONNECTED"); break;
      case STATUS_WEB_CONNECTED: Serial.println("WEB_CONNECTED"); break;
    }
  }
}

void checkSystemStatus() {
  static unsigned long lastStatusCheck = 0;
  unsigned long now = millis();
  
  if (now - lastStatusCheck >= 10000) {
    lastStatusCheck = now;
    
    if (WiFi.status() == WL_CONNECTED) {
      String url = "https://" + String(serverHost) + "/health";
      HTTPClient http;
      http.setReuse(false);
      http.setConnectTimeout(2000);
      http.setTimeout(2000);
      
      bool success = http.begin(url);
      if (success) {
        int code = http.GET();
        http.end();
        
        if (code == 200) {
          setSystemStatus(STATUS_WEB_CONNECTED);
        } else {
          setSystemStatus(STATUS_WIFI_CONNECTED);
        }
      } else {
        setSystemStatus(STATUS_WIFI_CONNECTED);
      }
    } else {
      setSystemStatus(STATUS_WIFI_CONNECTING);
    }
  }
}

// ========== WATCHDOG & SYSTEM HEALTH ==========
void feedWatchdog() {
  unsigned long now = millis();
  
  if (now - lastWatchdogFeed > 10000) {
    lastWatchdogFeed = now;
    
    if (now - lastSystemCheck > WATCHDOG_TIMEOUT) {
      Serial.println("[WDT] System hang detected - restarting ESP32");
      ESP.restart();
    }
  }
}

void updateSystemCheck() {
  lastSystemCheck = millis();
}

// ========== WIFI RECOVERY ==========
void checkWiFiConnection() {
  unsigned long now = millis();
  
  if (now - lastWifiCheck > 10000) {
    lastWifiCheck = now;
    
    if (WiFi.status() != WL_CONNECTED) {
      wifiDisconnectCount++;
      Serial.printf("[WiFi] Disconnected! Attempting reconnect #%d\n", wifiDisconnectCount);
      
      WiFi.disconnect();
      delay(500);
      WiFi.reconnect();
      delay(1000);
      
      if (WiFi.status() == WL_CONNECTED) {
        Serial.println("[WiFi] Reconnected successfully");
        wifiDisconnectCount = 0;
      } else if (wifiDisconnectCount > 3) {
        Serial.println("[WiFi] Multiple reconnects failed - restarting ESP32");
        ESP.restart();
      }
    } else {
      if (wifiDisconnectCount > 0) {
        Serial.println("[WiFi] Connection restored");
        wifiDisconnectCount = 0;
      }
    }
  }
}

// ========== ROBUST MODULE DETECTION ==========
bool checkModule(uint8_t addr) {
  Wire.beginTransmission(addr);
  byte error = Wire.endTransmission();
  return (error == 0);
}

void scanPCFModules() {
  for (int i = 0; i < 4; i++) {
    bool detected = checkModule(MODULE_ADDRESSES[i]);
    
    if (detected != moduleDetected[i]) {
      moduleDetected[i] = detected;
      
      if (detected) {
        Serial.printf("[SCAN] Module 0x%02X detected\n", MODULE_ADDRESSES[i]);
        pcfOutCache[i] = 0xFF;
        lastRead[i] = 0xFF;
        writePCF(MODULE_ADDRESSES[i], 0xFF);
      } else {
        Serial.printf("[SCAN] Module 0x%02X disconnected\n", MODULE_ADDRESSES[i]);
        pcfOutCache[i] = 0xFF;
        lastRead[i] = 0xFF;
      }
    }
  }
}

// ========== I2C BUS RECOVERY ==========
void recoverI2CBus() {
  Serial.println("[I2C] Bus recovery initiated...");
  
  Wire.end();
  pinMode(21, INPUT_PULLUP);
  pinMode(22, INPUT_PULLUP);
  delay(50);
  
  Wire.begin(21, 22);
  Wire.setClock(100000);
  delay(50);
  
  Serial.println("[I2C] Bus recovery completed");
}

void checkI2CHealth() {
  static unsigned long lastI2CCheck = 0;
  unsigned long now = millis();
  
  if (now - lastI2CCheck > 30000) {
    lastI2CCheck = now;
    
    bool allModulesOK = true;
    for (int i = 0; i < 4; i++) {
      if (moduleDetected[i] && !checkModule(MODULE_ADDRESSES[i])) {
        Serial.printf("[I2C] Module 0x%02X not responding\n", MODULE_ADDRESSES[i]);
        allModulesOK = false;
      }
    }
    
    if (!allModulesOK) {
      recoverI2CBus();
      scanPCFModules();
    }
  }
}

// ========== PCF8574 HELPERS ==========
bool writePCF(uint8_t addr, uint8_t value) {
  if (!checkModule(addr)) return false;
  
  Wire.beginTransmission(addr);
  Wire.write(value);
  byte error = Wire.endTransmission();
  return (error == 0);
}

bool readPCF(uint8_t addr, uint8_t &value) {
  if (!checkModule(addr)) return false;
  
  Wire.requestFrom(addr, 1);
  if (Wire.available()) {
    value = Wire.read();
    return true;
  }
  return false;
}

// ====== CORRECTED LED CONTROL ======
void setTeamLED(uint8_t teamNumber, bool on) {
  if (teamNumber < 1 || teamNumber > 12) return;
  
  const ButtonLEDMapping& mapping = TEAM_MAPPINGS[teamNumber - 1];
  int moduleIndex = getModuleIndex(mapping.moduleAddress);
  
  if (moduleIndex == -1 || !moduleDetected[moduleIndex]) return;
  
  uint8_t currentState = pcfOutCache[moduleIndex];
  
  if (on) {
    currentState &= ~(1 << mapping.ledBit);
  } else {
    currentState |= (1 << mapping.ledBit);
  }
  
  pcfOutCache[moduleIndex] = currentState;
  
  writePCF(mapping.moduleAddress, currentState);
}

void clearAllLEDs() {
  for (int i = 0; i < 4; i++) {
    if (moduleDetected[i]) {
      pcfOutCache[i] = 0xFF;
      writePCF(MODULE_ADDRESSES[i], pcfOutCache[i]);
    }
  }
  
  for (int i = 0; i < 12; i++) {
    buttonLedActive[i] = false;
  }
}

void updateActiveTeamLED() {
  if (!lockActive || activeTeam < 1 || activeTeam > 12) return;
  
  Serial.printf("[ACTIVE] Setting active team: %s (%d)\n", 
                TEAM_NAMES[activeTeam-1], activeTeam);
  
  clearAllLEDs();
  
  setTeamLED(activeTeam, true);
  buttonLedActive[activeTeam-1] = true;
  buttonLedStartTime[activeTeam-1] = millis();
}

// ====== BUTTON HANDLERS WITH ATOMIC LOCK ======
void pollPCFButtons() {
  unsigned long now = millis();
  
  // Process each module
  for (int moduleIndex = 0; moduleIndex < 4; moduleIndex++) {
    if (!moduleDetected[moduleIndex]) continue;
    
    uint8_t currentState;
    if (!readPCF(MODULE_ADDRESSES[moduleIndex], currentState)) {
      moduleDetected[moduleIndex] = false;
      continue;
    }
    
    // Check each team mapping for this module
    for (int team = 0; team < 12; team++) {
      const ButtonLEDMapping& mapping = TEAM_MAPPINGS[team];
      
      if (mapping.moduleAddress != MODULE_ADDRESSES[moduleIndex]) continue;
      
      bool currentlyPressed = (currentState & (1 << mapping.buttonBit)) == 0;
      bool previouslyPressed = (lastRead[moduleIndex] & (1 << mapping.buttonBit)) == 0;
      
      // DEBOUNCE 25ms
      if (currentlyPressed && !previouslyPressed && !lockActive &&
          now - lastDebounceTime[mapping.teamNumber] > DEBOUNCE_MS) {
        
        lastDebounceTime[mapping.teamNumber] = now;
        
        Serial.printf("[BUTTON] Team %s pressed! Checking global lock...\n",
                     mapping.teamName);
        
        // ===== ATOMIC LOCK CHECK =====
        // 1. Coba acquire global lock
        if (!acquireGlobalLock(mapping.teamNumber)) {
          // Lock tidak tersedia, tombol diabaikan
          Serial.printf("[BUTTON] Team %s IGNORED - global lock busy\n", mapping.teamName);
          
          // Blink LED cepat untuk feedback
          setTeamLED(mapping.teamNumber, true);
          delay(50);
          setTeamLED(mapping.teamNumber, false);
          
          continue; // Lanjut ke tombol berikutnya
        }
        
        // 2. Set lock lokal
        lockActive = true;
        activeTeam = mapping.teamNumber;
        
        // 3. Immediate visual feedback
        setTeamLED(mapping.teamNumber, true);
        buttonLedActive[mapping.teamNumber-1] = true;
        buttonLedStartTime[mapping.teamNumber-1] = now;
        
        // 4. Update LED lainnya
        updateActiveTeamLED();
        
        // 5. Kirim ke server dalam task terpisah
        sendUpdateToServerAtomic(mapping.teamNumber);
        
        Serial.printf("[BUTTON] Team %s LOCKED and queued for server\n", mapping.teamName);
        
        break; // Hanya proses satu tombol per cycle
      }
    }
    
    lastRead[moduleIndex] = currentState;
  }
}

void updateButtonLEDs() {
  unsigned long now = millis();
  
  for (int team = 1; team <= 12; team++) {
    if (buttonLedActive[team-1] && (now - buttonLedStartTime[team-1] >= BUTTON_LED_DURATION)) {
      if (!lockActive || activeTeam != team) {
        setTeamLED(team, false);
        buttonLedActive[team-1] = false;
      }
    }
  }
}

void handleJuryButtons() {
  unsigned long now = millis();
  bool corr = digitalRead(PIN_JURY_CORRECT) == LOW;
  bool wrong = digitalRead(PIN_JURY_WRONG) == LOW;

  if (corr && !lastJuryCorrectState && now - lastDebounceTime[12] > JURY_DEBOUNCE_MS) {
    lastDebounceTime[12] = now;
    if (lockActive && activeTeam && activeTeam <= 12) {
      Serial.printf("[JURY] Correct for Team %s\n", TEAM_NAMES[activeTeam-1]);
      
      // Fast visual feedback
      setTeamLED(activeTeam, false);
      delay(30);
      setTeamLED(activeTeam, true);
      buttonLedStartTime[activeTeam-1] = now;
      
      sendJuryUpdateToServer(activeTeam, plusValue, "CORRECT");
    }
  }
  
  if (wrong && !lastJuryWrongState && now - lastDebounceTime[13] > JURY_DEBOUNCE_MS) {
    lastDebounceTime[13] = now;
    if (lockActive && activeTeam && activeTeam <= 12) {
      Serial.printf("[JURY] Wrong for Team %s\n", TEAM_NAMES[activeTeam-1]);
      
      // Faster double blink
      for (int i = 0; i < 2; i++) {
        setTeamLED(activeTeam, false);
        delay(30);
        setTeamLED(activeTeam, true);
        if (i == 0) delay(20);
      }
      buttonLedStartTime[activeTeam-1] = now;
      
      sendJuryUpdateToServer(activeTeam, minusValue, "WRONG");
    }
  }
  
  lastJuryCorrectState = corr;
  lastJuryWrongState   = wrong;
}

// ====== HTTP SEND WITH ATOMIC LOCK ======
void sendUpdateToServerAtomic(int team) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("[HTTP] WiFi not connected for Team %s, releasing lock\n", TEAM_NAMES[team-1]);
    releaseGlobalLock();
    return;
  }
  
  String url = "https://" + String(serverHost) + "/update?team=" + String(team) + "&add=0&first=1";
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(HTTP_SEND_TIMEOUT);
  http.setTimeout(HTTP_SEND_TIMEOUT);
  
  unsigned long startTime = millis();
  
  bool success = http.begin(url);
  if (success) {
    int code = http.GET();
    unsigned long elapsed = millis() - startTime;
    
    Serial.printf("[HTTP] Team %s -> Code: %d, Time: %dms\n", 
                  TEAM_NAMES[team-1], code, elapsed);
    
    // Periksa response
    if (code == 200) {
      // Success - server menerima request kita
      Serial.printf("[HTTP] Team %s successfully locked by server\n", TEAM_NAMES[team-1]);
      
      // Tunggu sedikit untuk memastikan server memproses
      delay(50);
      httpInProgress = false; // Tandai HTTP selesai
      
    } else if (code == 403) {
      // Server mengatakan "Tombol terkunci" - mungkin tim lain lebih cepat
      Serial.printf("[HTTP] Team %s rejected by server - already locked\n", TEAM_NAMES[team-1]);
      
      // Reset local lock karena kita bukan yang pertama
      lockActive = false;
      activeTeam = 0;
      clearAllLEDs();
      
      delay(50);
      httpInProgress = false;
      releaseGlobalLock();
      
    } else {
      // Error lainnya
      Serial.printf("[HTTP] Error %d for Team %s\n", code, TEAM_NAMES[team-1]);
      delay(50);
      httpInProgress = false;
      releaseGlobalLock();
    }
  } else {
    Serial.printf("[HTTP] Connection failed for Team %s\n", TEAM_NAMES[team-1]);
    delay(50);
    httpInProgress = false;
    releaseGlobalLock();
  }
  
  http.end();
}

void sendJuryUpdateToServer(int team, int add, const char *action) {
  if (!lockActive || team < 1 || team > 12 || WiFi.status() != WL_CONNECTED) return;
  
  String url = "https://" + String(serverHost) + "/update?team=" + String(team) + "&add=" + add;
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(1500);
  http.setTimeout(1500);
  
  bool success = http.begin(url);
  if (!success) {
    Serial.println("[HTTP] Jury update connection failed");
    return;
  }
  
  int code = http.GET();
  Serial.printf("[JURY] Team %s %s code=%d\n", TEAM_NAMES[team-1], action, code);
  http.end();
}

// ====== HANDLE PENDING REQUESTS ======
void handlePendingRequests() {
  static unsigned long lastProcessTime = 0;
  unsigned long now = millis();
  
  // Proses pending request setiap 100ms
  if (now - lastProcessTime < 100) return;
  lastProcessTime = now;
  
  // Auto-release lock jika timeout
  if (globalButtonLock && (now - globalLockStartTime > GLOBAL_LOCK_TIMEOUT)) {
    Serial.println("[LOCK] Auto-releasing lock due to timeout");
    
    // Reset semua state
    releaseGlobalLock();
    
    if (lockActive) {
      lockActive = false;
      activeTeam = 0;
      clearAllLEDs();
    }
  }
  
  // Jika HTTP sudah selesai tapi lock masih dipegang, release
  if (globalButtonLock && !httpInProgress && (now - globalLockStartTime > 500)) {
    Serial.println("[LOCK] Releasing lock after HTTP completed");
    releaseGlobalLock();
  }
}

String httpGetStringFast(const String &url) {
  if (WiFi.status() != WL_CONNECTED) return "";
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(2000);
  http.setTimeout(2000);
  
  bool success = http.begin(url);
  if (!success) return "";
  
  int code = http.GET();
  String payload = (code == 200) ? http.getString() : "";
  http.end();
  
  return payload;
}

void pollLockState() {
  String url = "https://" + String(serverHost) + "/lockstate";
  String payload = httpGetStringFast(url);
  if (payload.isEmpty()) return;
  
  StaticJsonDocument<200> doc;
  if (deserializeJson(doc, payload)) return;
  
  bool newLock = doc["locked"] | false;
  int newActive = doc["activeTeam"] | 0;
  
  if (newLock != lockActive || newActive != activeTeam) {
    lockActive = newLock;
    activeTeam = newActive;
    
    if (lockActive && activeTeam > 0) {
      Serial.printf("[SERVER-LOCK] Team %s locked by server\n", TEAM_NAMES[activeTeam-1]);
      
      // Jika server mengunci tim yang berbeda dengan pending kita,
      // release global lock kita
      if (hasPendingRequest && pendingTeamToSend != activeTeam) {
        Serial.printf("[SERVER-LOCK] Releasing our lock (Team %s) because server locked Team %s\n",
                     TEAM_NAMES[pendingTeamToSend-1], TEAM_NAMES[activeTeam-1]);
        forceReleaseGlobalLock();
        
        // Reset local state
        lockActive = false;
        clearAllLEDs();
      }
      
      updateActiveTeamLED();
    } else {
      Serial.println("[SERVER-LOCK] System unlocked by server");
      clearAllLEDs();
      
      // Juga release global lock kita
      if (hasPendingRequest) {
        forceReleaseGlobalLock();
      }
    }
  }
}

void safeHealthCheck() {
  if (WiFi.status() != WL_CONNECTED) return;
  
  String url = "https://" + String(serverHost) + "/health";
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(2000);
  http.setTimeout(2000);
  
  bool success = http.begin(url);
  if (success) {
    int code = http.GET();
    http.end();
    if (code != 200) {
      Serial.printf("[HEALTH] Server response: %d\n", code);
    }
  }
}

// ====== Wi-Fi & CONFIG ======
WiFiManagerParameter custom_server_host("host", "Server host", DEFAULT_SERVER_HOST, 64);
WiFiManagerParameter custom_server_port("port", "Port", "443", 6);

void setupWiFiManager() {
  WiFiManager wm;
  wm.setConnectTimeout(30);
  wm.setConfigPortalTimeout(180);
  wm.addParameter(&custom_server_host);
  wm.addParameter(&custom_server_port);
  
  if (!wm.autoConnect(WIFI_AP_NAME)) {
    Serial.println("[WiFi] Failed to connect and config portal timeout");
    ESP.restart();
  }
  
  String hostValue = custom_server_host.getValue();
  hostValue.replace("http://", ""); 
  hostValue.replace("https://", "");
  strncpy(serverHost, hostValue.c_str(), sizeof(serverHost) - 1);
  serverPort = atoi(custom_server_port.getValue());
  
  Serial.printf("WiFi: Connected to %s\n", WiFi.SSID().c_str());
  Serial.printf("Server: Host=%s Port=%d\n", serverHost, serverPort);
}

// ====== SETUP ======
void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("\n========================================");
  Serial.println("QUIZ SCORING SYSTEM - HEARTBEAT VERSION");
  Serial.println("FIXED: ESP32 Heartbeat untuk status online");
  Serial.println("========================================");
  
  // Initialize Status LED Pins
  pinMode(LED_MERAH, OUTPUT);
  pinMode(LED_HIJAU, OUTPUT);
  
  digitalWrite(LED_MERAH, LOW);
  digitalWrite(LED_HIJAU, LOW);
  
  Serial.println("HEARTBEAT SYSTEM:");
  Serial.println("  - Kirim heartbeat setiap 30 detik");
  Serial.println("  - Timeout server: 300 detik (5 menit)");
  Serial.println("  - Status tetap ONLINE meski tidak ada aktivitas");
  Serial.println("");
  
  // Initialize I2C
  Wire.begin(21, 22);
  Wire.setClock(100000);
  
  // Initial module scan
  scanPCFModules();

  // Setup jury buttons
  pinMode(PIN_JURY_CORRECT, INPUT_PULLUP);
  pinMode(PIN_JURY_WRONG, INPUT_PULLUP);
  lastJuryCorrectState = digitalRead(PIN_JURY_CORRECT);
  lastJuryWrongState   = digitalRead(PIN_JURY_WRONG);
  
  // Initialize debounce timers
  for (int i = 0; i < 14; ++i) lastDebounceTime[i] = 0;
  for (int i = 0; i < 12; i++) buttonLedActive[i] = false;

  // Setup WiFi
  setupWiFiManager();
  
  // Kirim heartbeat pertama
  lastHeartbeatTime = millis();
  sendHeartbeatToServer();
  
  Serial.println("\n[INIT] System ready - Heartbeat enabled");
  Serial.printf("[INIT] Free Heap: %d bytes\n", ESP.getFreeHeap());
  Serial.println("========================================\n");
}

// ====== OPTIMIZED MAIN LOOP DENGAN HEARTBEAT ======
void loop() {
  unsigned long now = millis();
  
  // 1. HIGHEST PRIORITY: Tombol dengan atomic lock
  pollPCFButtons();
  
  // 2. Handle pending requests dan lock management
  handlePendingRequests();
  
  // 3. HEARTBEAT SYSTEM (PERBAIKAN BARU)
  handleHeartbeat();
  
  // 4. Tombol juri
  handleJuryButtons();
  
  // 5. Update LED state
  updateButtonLEDs();
  
  // 6. WiFi reset feature
  handleWifiReset();
  
  // 7. Status LED update
  updateStatusLED();
  
  // 8. Background tasks (100ms interval)
  static unsigned long lastBackgroundCheck = 0;
  if (now - lastBackgroundCheck >= 100) {
    lastBackgroundCheck = now;
    
    updateSystemCheck();
    feedWatchdog();
    checkWiFiConnection();
  }
  
  // 9. HTTP polling untuk lock state (1 detik)
  static unsigned long lastLockPoll = 0;
  if (now - lastLockPoll >= LOCK_POLL_MS) {
    lastLockPoll = now;
    pollLockState();
  }
  
  // 10. System status check (10 detik)
  static unsigned long lastStatusCheck = 0;
  if (now - lastStatusCheck >= 10000) {
    lastStatusCheck = now;
    checkSystemStatus();
  }
  
  // 11. Health check (30 detik)
  static unsigned long lastHealthCheck = 0;
  if (now - lastHealthCheck >= 30000) {
    lastHealthCheck = now;
    safeHealthCheck();
  }
  
  // 12. Module scan dan I2C health (5 detik)
  static unsigned long lastModuleScan = 0;
  if (now - lastModuleScan >= MODULE_SCAN_MS) {
    lastModuleScan = now;
    scanPCFModules();
    checkI2CHealth();
  }
  
  // 13. Minimal delay untuk menjaga responsivitas
  delay(1);
}