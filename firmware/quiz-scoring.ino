/*
  ESP32 master for Quiz Scoring system – FIXED VERSION
  Perbaikan masalah: Tombol ditekan, LED nyala, tetapi tidak terkunci
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include <esp_timer.h>
#include <esp_system.h>

// ========== CONFIGURABLE ==========
const char *DEFAULT_SERVER_HOST = "web-scoring-board-production.up.railway.app";
const int   DEFAULT_SERVER_PORT = 443;
const char *WIFI_AP_NAME = "Quiz_Config";

// ========== LED STATUS PINS ==========
const int LED_MERAH = 33;  // G33 untuk LED Merah
const int LED_HIJAU = 32;  // G32 untuk LED Hijau

// ========== PCF8574 MODULE ADDRESSES ==========
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

// ========== PIN CONFIGURATION ==========
const int PIN_JURY_CORRECT = 4;
const int PIN_JURY_WRONG   = 5;
const int MODULE_INT_PIN = 16;  // PCF8574 INT wired to ESP32 GPIO16

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

// ====== DYNAMIC SYSTEM CONFIGURATION ======
bool moduleEnabled[4] = {false, false, false, false};  // Modul yang aktif
bool moduleDetected[4] = {false, false, false, false}; // Modul yang terdeteksi
uint8_t enabledTeams[12] = {0};                        // Daftar tim yang enabled
uint8_t activeTeamCount = 0;                           // Jumlah tim yang aktif

// ====== PERBAIKAN DEBOUNCE ======
const uint64_t BUTTON_DEBOUNCE_MS = 20;           // DEBOUNCE 20ms (ditingkatkan dari 5ms)
const uint64_t BUTTON_LOCK_DELAY_MS = 50;         // Delay sebelum lock 50ms
const uint32_t BUTTON_MIN_PRESS_MS = 15;          // Minimal press 15ms

// ====== ATOMIC PRESS DETECTION ======
struct TimestampedPress {
  int team;
  uint64_t timestamp;     // Millisecond timestamp
  uint8_t moduleIndex;
  uint8_t buttonBit;
  bool valid;
  bool processed;
};

TimestampedPress pressQueue[36];  // Queue besar: 36 entries
volatile uint8_t queueHead = 0;
volatile uint8_t queueTail = 0;
volatile uint8_t queueCount = 0;

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

// ====== PERBAIKAN LOCK SYSTEM ======
volatile bool globalButtonLock = false;           // GLOBAL LOCK FLAG
volatile unsigned long globalLockStartTime = 0;   // Waktu lock dimulai
const unsigned long GLOBAL_LOCK_TIMEOUT = 3000;   // Timeout lock 3 detik
volatile int pendingTeamToSend = 0;              // Tim yang menunggu dikirim
volatile bool hasPendingRequest = false;         // Ada request pending
volatile bool httpInProgress = false;            // HTTP sedang berjalan

// ====== PERBAIKAN INTERRUPT SYSTEM ======
volatile bool anyModuleInterrupt = false;
volatile unsigned long lastModuleInterruptTime = 0;
volatile bool interruptEnabled = true;
const unsigned long INTERRUPT_COOLDOWN_MS = 5;   // Cooldown 5ms untuk interrupt

// ====== PERBAIKAN BUTTON TRACKING ======
struct ButtonState {
  bool isPressed;
  bool wasPressed;
  unsigned long pressStartTime;
  unsigned long lastChangeTime;
  bool ledFeedbackActive;
  unsigned long ledFeedbackStart;
  bool lockConfirmed;
};

ButtonState buttonStates[12];

// ====== MODULE STATE ======
uint8_t pcfOutCache[4] = {0xFF, 0xFF, 0xFF, 0xFF};
uint8_t lastModuleState[4] = {0xFF, 0xFF, 0xFF, 0xFF};
uint8_t moduleReadRetry[4] = {0};  // Counter retry untuk baca modul

// ====== I2C CONFIG ======
#define I2C_SPEED 100000 // 100kHz untuk stabilitas

// ====== TIMING CONFIG ======
const unsigned long JURY_DEBOUNCE_MS   = 50;
const unsigned long LOCK_POLL_MS       = 100;     // Polling lock 100ms (dikurangi)
const unsigned long MODULE_SCAN_MS     = 5000;    // Scan modul setiap 5 detik
const unsigned long BUTTON_FEEDBACK_DURATION = 100;    // LED feedback 100ms
const unsigned long LOCK_LED_DURATION = 0;        // LED lock tetap nyala sampai reset
const unsigned long WATCHDOG_TIMEOUT   = 30000;
const unsigned long HTTP_SEND_TIMEOUT  = 500;     // HTTP timeout 500ms (ditambah)

// ====== HEARTBEAT SYSTEM ======
unsigned long lastHeartbeatTime = 0;
const unsigned long HEARTBEAT_INTERVAL = 30000;
unsigned long heartbeatCount = 0;

// ====== SYSTEM STATE ======
char serverHost[64];
int  serverPort = DEFAULT_SERVER_PORT;

bool lockActive = false;
int  activeTeam = 0;

// WiFi stability
int wifiDisconnectCount = 0;
unsigned long lastWifiCheck = 0;

// Watchdog
unsigned long lastWatchdogFeed = 0;
unsigned long lastSystemCheck = 0;

// Jury button states
bool lastJuryCorrectState = HIGH;
bool lastJuryWrongState   = HIGH;
int plusValue  = 5;
int minusValue = -2;

// ========== DEBUG VARIABLES ==========
bool debugEnabled = true;
unsigned long lastButtonCheck = 0;
unsigned long lastQueueProcess = 0;

// ========== HELPER FUNCTIONS ==========
int getModuleIndex(uint8_t moduleAddress) {
  for (int i = 0; i < 4; i++) {
    if (MODULE_ADDRESSES[i] == moduleAddress) return i;
  }
  return -1;
}

// ========== PCF8574 HELPERS ==========
bool checkModule(uint8_t addr) {
  Wire.beginTransmission(addr);
  byte error = Wire.endTransmission();
  return (error == 0);
}

bool writePCF(uint8_t addr, uint8_t value) {
  if (!moduleEnabled[getModuleIndex(addr)]) return false;
  
  Wire.beginTransmission(addr);
  Wire.write(value);
  byte error = Wire.endTransmission();
  delayMicroseconds(100); // Delay untuk stabilitas
  return (error == 0);
}

bool readPCF(uint8_t addr, uint8_t &value) {
  int moduleIndex = getModuleIndex(addr);
  if (moduleIndex == -1 || !moduleEnabled[moduleIndex]) {
    value = 0xFF;
    return false;
  }
  
  Wire.requestFrom(addr, 1);
  if (Wire.available()) {
    value = Wire.read();
    delayMicroseconds(100);
    return true;
  }
  
  // Retry logic
  moduleReadRetry[moduleIndex]++;
  if (moduleReadRetry[moduleIndex] > 3) {
    moduleEnabled[moduleIndex] = false;
    Serial.printf("[ERROR] Module 0x%02X failed after %d retries\n", addr, moduleReadRetry[moduleIndex]);
  }
  
  return false;
}

// ====== PERBAIKAN INTERRUPT HANDLER ======
void IRAM_ATTR isrAnyModuleEngine() {
  static unsigned long lastIsrTime = 0;
  unsigned long currentTime = millis();
  
  // Debounce interrupt
  if (currentTime - lastIsrTime < INTERRUPT_COOLDOWN_MS) return;
  lastIsrTime = currentTime;
  
  if (interruptEnabled) {
    anyModuleInterrupt = true;
    lastModuleInterruptTime = currentTime;
  }
}

// ====== SIMPLE MODULE MANAGEMENT ======
void initializeModules() {
  Serial.println("\n=== INITIALIZING MODULES ===");
  
  // Reset semua state
  activeTeamCount = 0;
  for (int i = 0; i < 12; i++) {
    enabledTeams[i] = 0;
    buttonStates[i].isPressed = false;
    buttonStates[i].wasPressed = false;
    buttonStates[i].pressStartTime = 0;
    buttonStates[i].lastChangeTime = 0;
    buttonStates[i].ledFeedbackActive = false;
    buttonStates[i].ledFeedbackStart = 0;
    buttonStates[i].lockConfirmed = false;
  }
  
  for (int i = 0; i < 4; i++) {
    bool detected = checkModule(MODULE_ADDRESSES[i]);
    moduleDetected[i] = detected;
    moduleEnabled[i] = detected;
    moduleReadRetry[i] = 0;
    
    if (detected) {
      Serial.printf("[INIT] Module 0x%02X detected\n", MODULE_ADDRESSES[i]);
      
      // Initialize dengan nilai default
      pcfOutCache[i] = 0xFF;
      lastModuleState[i] = 0xFF;
      
      // Tulis nilai awal ke modul
      writePCF(MODULE_ADDRESSES[i], 0xFF);
      delay(10);
      
      // Enable teams untuk modul ini
      for (int team = 0; team < 12; team++) {
        if (TEAM_MAPPINGS[team].moduleAddress == MODULE_ADDRESSES[i]) {
          enabledTeams[team] = 1;
          activeTeamCount++;
          Serial.printf("  Team %s enabled\n", TEAM_NAMES[team]);
        }
      }
    } else {
      Serial.printf("[INIT] Module 0x%02X not detected\n", MODULE_ADDRESSES[i]);
    }
  }
  
  Serial.printf("[INIT] Total active teams: %d\n", activeTeamCount);
  Serial.println("===========================\n");
}

bool isTeamEnabled(uint8_t teamNumber) {
  if (teamNumber < 1 || teamNumber > 12) return false;
  return enabledTeams[teamNumber - 1] == 1;
}

// ====== PERBAIKAN BUTTON DETECTION ======
void improvedButtonDetection() {
  unsigned long currentTime = millis();
  
  // Cek semua modul yang enabled
  for (int i = 0; i < 4; i++) {
    if (!moduleEnabled[i]) continue;
    
    uint8_t currentState;
    if (!readPCF(MODULE_ADDRESSES[i], currentState)) {
      continue;
    }
    
    // Reset retry counter jika berhasil baca
    moduleReadRetry[i] = 0;
    
    // Cek perubahan state
    if (currentState != lastModuleState[i]) {
      if (debugEnabled) {
        Serial.printf("[BUTTON] Module 0x%02X changed: 0x%02X\n", 
                     MODULE_ADDRESSES[i], currentState);
      }
      
      // Proses setiap tombol pada modul ini
      for (int teamIdx = 0; teamIdx < 12; teamIdx++) {
        const ButtonLEDMapping &mapping = TEAM_MAPPINGS[teamIdx];
        if (mapping.moduleAddress != MODULE_ADDRESSES[i]) continue;
        
        if (!isTeamEnabled(mapping.teamNumber)) continue;
        
        int teamIndex = mapping.teamNumber - 1;
        uint8_t mask = (1 << mapping.buttonBit);
        bool currentPressed = (currentState & mask) == 0;
        bool wasPressed = buttonStates[teamIndex].wasPressed;
        
        // Debounce check
        if (currentTime - buttonStates[teamIndex].lastChangeTime < BUTTON_DEBOUNCE_MS) {
          continue;
        }
        
        // Falling edge - tombol ditekan
        if (currentPressed && !wasPressed) {
          buttonStates[teamIndex].isPressed = true;
          buttonStates[teamIndex].wasPressed = true;
          buttonStates[teamIndex].pressStartTime = currentTime;
          buttonStates[teamIndex].lastChangeTime = currentTime;
          buttonStates[teamIndex].lockConfirmed = false;
          
          // Tambahkan ke queue
          addToPressQueue(mapping.teamNumber, currentTime, i, mapping.buttonBit);
          
          // LED feedback langsung
          setTeamLED(mapping.teamNumber, true);
          buttonStates[teamIndex].ledFeedbackActive = true;
          buttonStates[teamIndex].ledFeedbackStart = currentTime;
          
          Serial.printf("[BUTTON] Team %s PRESSED @%lu ms\n", 
                       mapping.teamName, currentTime);
        }
        
        // Rising edge - tombol dilepas
        if (!currentPressed && wasPressed) {
          buttonStates[teamIndex].isPressed = false;
          buttonStates[teamIndex].wasPressed = false;
          buttonStates[teamIndex].lastChangeTime = currentTime;
          
          unsigned long pressDuration = currentTime - buttonStates[teamIndex].pressStartTime;
          
          if (debugEnabled) {
            Serial.printf("[BUTTON] Team %s RELEASED after %lu ms\n",
                         mapping.teamName, pressDuration);
          }
        }
      }
      
      lastModuleState[i] = currentState;
    }
  }
}

// ====== ATOMIC QUEUE FUNCTIONS ======
void clearPressQueue() {
  noInterrupts();
  queueHead = 0;
  queueTail = 0;
  queueCount = 0;
  for (int i = 0; i < 36; i++) {
    pressQueue[i].valid = false;
    pressQueue[i].processed = false;
  }
  interrupts();
}

bool addToPressQueue(int team, unsigned long timestamp, uint8_t modIndex, uint8_t buttonBit) {
  if (!isTeamEnabled(team)) return false;
  
  noInterrupts();
  
  // Cek duplikat untuk tim yang sama (mencegah multiple entries)
  for (int i = 0; i < 36; i++) {
    if (pressQueue[i].valid && !pressQueue[i].processed && pressQueue[i].team == team) {
      interrupts();
      return false; // Sudah ada dalam queue
    }
  }
  
  if (queueCount >= 36) {
    // Cari yang sudah diproses untuk dihapus
    for (int i = 0; i < 36; i++) {
      if (pressQueue[i].valid && pressQueue[i].processed) {
        pressQueue[i].valid = false;
        queueCount--;
        break;
      }
    }
  }
  
  // Cari slot kosong
  int insertIndex = -1;
  for (int i = 0; i < 36; i++) {
    if (!pressQueue[i].valid) {
      insertIndex = i;
      break;
    }
  }
  
  if (insertIndex == -1) {
    // Gunakan circular buffer
    insertIndex = queueTail;
    queueTail = (queueTail + 1) % 36;
  }
  
  // Tambah ke queue
  pressQueue[insertIndex].team = team;
  pressQueue[insertIndex].timestamp = timestamp;
  pressQueue[insertIndex].moduleIndex = modIndex;
  pressQueue[insertIndex].buttonBit = buttonBit;
  pressQueue[insertIndex].valid = true;
  pressQueue[insertIndex].processed = false;
  
  queueCount++;
  
  if (debugEnabled) {
    Serial.printf("[QUEUE] Added Team %s @%lu ms (queue: %d)\n", 
                  TEAM_NAMES[team-1], timestamp, queueCount);
  }
  
  interrupts();
  return true;
}

// ====== PROCESS PRESS QUEUE ======
void processPressQueue() {
  unsigned long currentTime = millis();
  
  if (currentTime - lastQueueProcess < 10) return; // 10ms interval
  lastQueueProcess = currentTime;
  
  // Skip jika sistem terkunci
  if (globalButtonLock || lockActive || httpInProgress) {
    return;
  }
  
  // Cari press yang paling awal dan belum diproses
  TimestampedPress* earliest = NULL;
  unsigned long earliestTime = 0xFFFFFFFF;
  int earliestIndex = -1;
  
  noInterrupts();
  for (int i = 0; i < 36; ++i) {
    if (!pressQueue[i].valid || pressQueue[i].processed) continue;
    
    unsigned long pressTime = pressQueue[i].timestamp;
    
    // Cek usia press (minimal 20ms untuk debounce)
    unsigned long pressAge = currentTime - pressTime;
    if (pressAge < BUTTON_MIN_PRESS_MS) continue;
    
    // Cari yang paling awal
    if (pressTime < earliestTime) {
      earliestTime = pressTime;
      earliest = &pressQueue[i];
      earliestIndex = i;
    }
  }
  interrupts();
  
  if (earliest != NULL && earliest->valid && !earliest->processed) {
    int team = earliest->team;
    unsigned long pressTime = earliest->timestamp;
    unsigned long ageMs = currentTime - pressTime;
    
    // Cek apakah tombol masih ditekan
    int teamIndex = team - 1;
    if (!buttonStates[teamIndex].isPressed) {
      // Tombol sudah dilepas, hapus dari queue
      noInterrupts();
      earliest->processed = true;
      earliest->valid = false;
      if (queueCount > 0) queueCount--;
      interrupts();
      return;
    }
    
    // Coba acquire lock
    if (acquireGlobalLock(team)) {
      // Tandai sebagai diproses
      noInterrupts();
      earliest->processed = true;
      interrupts();
      
      // Set active team
      lockActive = true;
      activeTeam = team;
      buttonStates[teamIndex].lockConfirmed = true;
      
      // LED lock (jangan matikan)
      setTeamLED(activeTeam, true);
      
      // Kirim ke server
      sendUpdateToServerAtomic(activeTeam);
      
      Serial.printf("[QUEUE] Team %s LOCKED (age: %lu ms)\n", TEAM_NAMES[team-1], ageMs);
    }
  }
  
  // Cleanup queue setiap 100ms
  static unsigned long lastCleanup = 0;
  if (currentTime - lastCleanup > 100) {
    lastCleanup = currentTime;
    cleanupOldPresses();
  }
}

// ====== CLEANUP FUNCTIONS ======
void cleanupOldPresses() {
  unsigned long currentTime = millis();
  
  noInterrupts();
  for (int i = 0; i < 36; i++) {
    if (pressQueue[i].valid) {
      unsigned long age = currentTime - pressQueue[i].timestamp;
      
      // Hapus yang lebih dari 3 detik atau sudah diproses
      if (age > 3000 || pressQueue[i].processed) {
        pressQueue[i].valid = false;
        if (queueCount > 0) queueCount--;
      }
    }
  }
  interrupts();
}

// ========== PERBAIKAN LOCK MANAGEMENT ==========
bool acquireGlobalLock(int team) {
  unsigned long now = millis();
  
  // AUTO-RELEASE jika lock timeout
  if (globalButtonLock && (now - globalLockStartTime > GLOBAL_LOCK_TIMEOUT)) {
    Serial.printf("[LOCK] Global lock expired after %lu ms\n", 
                 (now - globalLockStartTime));
    releaseGlobalLock();
    return false;
  }
  
  // Cek jika HTTP masih berjalan atau sudah ada lock
  if (httpInProgress || globalButtonLock || lockActive) {
    Serial.printf("[LOCK] Cannot acquire lock - Busy (HTTP: %d, Global: %d, Lock: %d)\n", 
                 httpInProgress, globalButtonLock, lockActive);
    return false;
  }
  
  // Coba acquire lock
  globalButtonLock = true;
  globalLockStartTime = now;
  pendingTeamToSend = team;
  hasPendingRequest = true;
  httpInProgress = true;
  
  Serial.printf("[LOCK] Global lock ACQUIRED for Team %s\n", TEAM_NAMES[team-1]);
  return true;
}

void releaseGlobalLock() {
  globalButtonLock = false;
  hasPendingRequest = false;
  pendingTeamToSend = 0;
  httpInProgress = false;
  Serial.println("[LOCK] Global lock RELEASED");
}

// ====== PERBAIKAN LED CONTROL ======
void setTeamLED(uint8_t teamNumber, bool on) {
  if (teamNumber < 1 || teamNumber > 12) return;
  
  if (!isTeamEnabled(teamNumber)) return;
  
  const ButtonLEDMapping& mapping = TEAM_MAPPINGS[teamNumber - 1];
  int moduleIndex = getModuleIndex(mapping.moduleAddress);
  
  if (moduleIndex == -1 || !moduleEnabled[moduleIndex]) return;
  
  uint8_t currentState = pcfOutCache[moduleIndex];
  
  if (on) {
    currentState &= ~(1 << mapping.ledBit);  // LOW untuk nyala
  } else {
    currentState |= (1 << mapping.ledBit);   // HIGH untuk mati
  }
  
  pcfOutCache[moduleIndex] = currentState;
  
  // Tulis ke modul dengan retry
  for (int retry = 0; retry < 3; retry++) {
    if (writePCF(mapping.moduleAddress, currentState)) {
      break;
    }
    delay(1);
  }
  
  if (debugEnabled && teamNumber <= 12) {
    Serial.printf("[LED] Team %s %s (Module 0x%02X, State: 0x%02X)\n",
                 TEAM_NAMES[teamNumber-1], on ? "ON" : "OFF",
                 mapping.moduleAddress, currentState);
  }
}

void clearAllLEDs() {
  for (int i = 0; i < 4; i++) {
    if (moduleEnabled[i]) {
      pcfOutCache[i] = 0xFF;
      for (int retry = 0; retry < 3; retry++) {
        if (writePCF(MODULE_ADDRESSES[i], pcfOutCache[i])) {
          break;
        }
        delay(1);
      }
    }
  }
  
  for (int i = 0; i < 12; i++) {
    buttonStates[i].ledFeedbackActive = false;
  }
  
  if (debugEnabled) Serial.println("[LED] All LEDs cleared");
}

void updateButtonLEDs() {
  unsigned long now = millis();
  
  for (int team = 1; team <= 12; team++) {
    if (!isTeamEnabled(team)) continue;
    
    int idx = team - 1;
    
    // Handle LED feedback (blink saat ditekan tapi belum lock)
    if (buttonStates[idx].ledFeedbackActive && 
        !buttonStates[idx].lockConfirmed &&
        (now - buttonStates[idx].ledFeedbackStart >= BUTTON_FEEDBACK_DURATION)) {
      
      // Jangan matikan LED jika sudah lock
      if (!lockActive || activeTeam != team) {
        setTeamLED(team, false);
        buttonStates[idx].ledFeedbackActive = false;
      }
    }
    
    // Handle LED lock (tetap nyala saat lock active)
    if (lockActive && activeTeam == team) {
      setTeamLED(team, true); // Pastikan LED tetap nyala
    }
  }
}

// ====== HEARTBEAT FUNCTIONS ======
void sendHeartbeatToServer() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[HEARTBEAT] WiFi not connected");
    return;
  }
  
  String url = "https://" + String(serverHost) + "/esp32checkin?action=heartbeat&count=" + 
               String(heartbeatCount) + "&teams=" + String(activeTeamCount);
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(3000);
  http.setTimeout(3000);
  
  if (http.begin(url)) {
    int code = http.GET();
    Serial.printf("[HEARTBEAT] #%d -> Code: %d, Teams: %d\n", 
                  heartbeatCount, code, activeTeamCount);
    http.end();
    
    if (code == 200) {
      heartbeatCount++;
    }
  }
}

// ========== WIFI RESET FUNCTIONS ==========
void handleWifiReset() {
  bool corrPressed = digitalRead(PIN_JURY_CORRECT) == LOW;
  bool wrongPressed = digitalRead(PIN_JURY_WRONG) == LOW;

  if (corrPressed && wrongPressed) {
    if (!wifiResetActive) {
      wifiResetActive = true;
      wifiResetStartTime = millis();
      Serial.println("[WIFI-RESET] Both jury buttons pressed");
      
      digitalWrite(LED_MERAH, HIGH);
      digitalWrite(LED_HIJAU, HIGH);
    } else {
      unsigned long elapsed = millis() - wifiResetStartTime;
      
      if (elapsed >= WIFI_RESET_DURATION && !wifiResetTriggered) {
        wifiResetTriggered = true;
        triggerWifiReset();
      }
    }
  } else {
    if (wifiResetActive) {
      wifiResetActive = false;
      wifiResetTriggered = false;
      updateStatusLED();
    }
  }
}

void triggerWifiReset() {
  Serial.println("\n[WIFI-RESET] Resetting WiFi...");
  
  WiFiManager wm;
  wm.resetSettings();
  
  delay(2000);
  ESP.restart();
}

// ========== STATUS LED FUNCTIONS ==========
void updateStatusLED() {
  if (wifiResetActive) return;
  
  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(LED_HIJAU, HIGH);
    digitalWrite(LED_MERAH, LOW);
  } else {
    digitalWrite(LED_MERAH, HIGH);
    digitalWrite(LED_HIJAU, LOW);
  }
}

// ========== WIFI RECOVERY ==========
void checkWiFiConnection() {
  static unsigned long lastCheck = 0;
  unsigned long now = millis();
  
  if (now - lastCheck > 10000) {
    lastCheck = now;
    
    if (WiFi.status() != WL_CONNECTED) {
      wifiDisconnectCount++;
      Serial.printf("[WiFi] Disconnected! Reconnect #%d\n", wifiDisconnectCount);
      
      WiFi.disconnect();
      delay(500);
      WiFi.reconnect();
      delay(1000);
      
      if (WiFi.status() == WL_CONNECTED) {
        Serial.println("[WiFi] Reconnected");
        wifiDisconnectCount = 0;
      }
    }
  }
}

// ========== MODULE HEALTH CHECK ==========
void checkModuleHealth() {
  static unsigned long lastCheck = 0;
  unsigned long now = millis();
  
  if (now - lastCheck > 5000) {
    lastCheck = now;
    
    bool anyChange = false;
    
    for (int i = 0; i < 4; i++) {
      bool currentlyDetected = checkModule(MODULE_ADDRESSES[i]);
      
      if (currentlyDetected != moduleDetected[i]) {
        anyChange = true;
        moduleDetected[i] = currentlyDetected;
        moduleEnabled[i] = currentlyDetected;
        
        if (currentlyDetected) {
          Serial.printf("[HEALTH] Module 0x%02X connected\n", MODULE_ADDRESSES[i]);
          
          // Initialize module
          pcfOutCache[i] = 0xFF;
          lastModuleState[i] = 0xFF;
          writePCF(MODULE_ADDRESSES[i], 0xFF);
          
          // Update team count
          for (int team = 0; team < 12; team++) {
            if (TEAM_MAPPINGS[team].moduleAddress == MODULE_ADDRESSES[i]) {
              enabledTeams[team] = 1;
              activeTeamCount++;
            }
          }
        } else {
          Serial.printf("[HEALTH] Module 0x%02X disconnected\n", MODULE_ADDRESSES[i]);
          
          // Update team count
          for (int team = 0; team < 12; team++) {
            if (TEAM_MAPPINGS[team].moduleAddress == MODULE_ADDRESSES[i]) {
              enabledTeams[team] = 0;
              activeTeamCount--;
            }
          }
        }
      }
    }
    
    if (anyChange) {
      Serial.printf("[HEALTH] Active teams: %d\n", activeTeamCount);
    }
  }
}

// ====== JURY BUTTONS HANDLING ======
void handleJuryButtons() {
  bool corr = digitalRead(PIN_JURY_CORRECT) == LOW;
  bool wrong = digitalRead(PIN_JURY_WRONG) == LOW;

  if (corr && !lastJuryCorrectState) {
    if (lockActive && activeTeam > 0) {
      Serial.printf("[JURY] Correct for Team %s\n", TEAM_NAMES[activeTeam-1]);
      
      // Visual feedback
      setTeamLED(activeTeam, false);
      delay(50);
      setTeamLED(activeTeam, true);
      
      sendJuryUpdateToServer(activeTeam, plusValue, "CORRECT");
    }
  }
  
  if (wrong && !lastJuryWrongState) {
    if (lockActive && activeTeam > 0) {
      Serial.printf("[JURY] Wrong for Team %s\n", TEAM_NAMES[activeTeam-1]);
      
      // Visual feedback
      setTeamLED(activeTeam, false);
      delay(50);
      setTeamLED(activeTeam, true);
      
      sendJuryUpdateToServer(activeTeam, minusValue, "WRONG");
    }
  }
  
  lastJuryCorrectState = corr;
  lastJuryWrongState   = wrong;
}

// ====== PERBAIKAN HTTP SEND ======
void sendUpdateToServerAtomic(int team) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("[HTTP] WiFi not connected for Team %s\n", TEAM_NAMES[team-1]);
    httpInProgress = false;
    releaseGlobalLock();
    lockActive = false;
    activeTeam = 0;
    clearAllLEDs();
    return;
  }
  
  String url = "https://" + String(serverHost) + "/update?team=" + String(team) + 
               "&add=0&first=1&_t=" + String(millis());
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(HTTP_SEND_TIMEOUT);
  http.setTimeout(HTTP_SEND_TIMEOUT);
  
  unsigned long startTime = millis();
  
  if (http.begin(url)) {
    int code = http.GET();
    unsigned long elapsed = millis() - startTime;
    
    Serial.printf("[HTTP] Team %s -> Code: %d, Time: %lums\n", 
                  TEAM_NAMES[team-1], code, elapsed);
    
    if (code == 200) {
      Serial.printf("[HTTP] Team %s locked successfully\n", TEAM_NAMES[team-1]);
      // Lock berhasil, biarkan LED tetap nyala
      httpInProgress = false;
      // Jangan release global lock di sini, biarkan untuk jury
    } else {
      Serial.printf("[HTTP] Error %d for Team %s\n", code, TEAM_NAMES[team-1]);
      
      // Retry once
      delay(50);
      int retryCode = http.GET();
      if (retryCode == 200) {
        Serial.printf("[HTTP] Team %s locked on retry\n", TEAM_NAMES[team-1]);
        httpInProgress = false;
      } else {
        // Gagal total, reset semua
        lockActive = false;
        activeTeam = 0;
        clearAllLEDs();
        httpInProgress = false;
        releaseGlobalLock();
        Serial.printf("[HTTP] Failed to lock Team %s\n", TEAM_NAMES[team-1]);
      }
    }
  } else {
    Serial.printf("[HTTP] Connection failed for Team %s\n", TEAM_NAMES[team-1]);
    lockActive = false;
    activeTeam = 0;
    clearAllLEDs();
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
  
  if (http.begin(url)) {
    int code = http.GET();
    Serial.printf("[JURY] Team %s %s code=%d\n", TEAM_NAMES[team-1], action, code);
    http.end();
    
    if (code == 200) {
      // Reset semua state
      lockActive = false;
      activeTeam = 0;
      clearAllLEDs();
      releaseGlobalLock();
      
      // Reset button states untuk tim ini
      int idx = team - 1;
      buttonStates[idx].lockConfirmed = false;
      buttonStates[idx].ledFeedbackActive = false;
    }
  }
}

// ====== HANDLE PENDING REQUESTS ======
void handlePendingRequests() {
  static unsigned long lastProcessTime = 0;
  unsigned long now = millis();
  
  if (now - lastProcessTime < 50) return;
  lastProcessTime = now;
  
  // Auto-release lock jika timeout
  if (globalButtonLock && (now - globalLockStartTime > GLOBAL_LOCK_TIMEOUT)) {
    Serial.println("[LOCK] Auto-releasing lock due to timeout");
    releaseGlobalLock();
    
    if (lockActive) {
      lockActive = false;
      activeTeam = 0;
      clearAllLEDs();
    }
  }
}

// ====== DEBUG FUNCTIONS ======
void printActiveTeams() {
  Serial.print("Active teams: ");
  bool anyActive = false;
  for (int i = 0; i < 12; i++) {
    if (enabledTeams[i] == 1) {
      Serial.printf("%s ", TEAM_NAMES[i]);
      anyActive = true;
    }
  }
  if (!anyActive) Serial.print("None");
  Serial.println();
}

void printDebugInfo() {
  static unsigned long lastDebug = 0;
  if (millis() - lastDebug < 3000) return;
  lastDebug = millis();
  
  Serial.printf("\n[DEBUG] Queue: %d, Lock: %d, Active Team: %d, HTTP: %d\n", 
                queueCount, lockActive, activeTeam, httpInProgress);
  
  printActiveTeams();
  
  // Tampilkan button states
  for (int i = 0; i < 12; i++) {
    if (enabledTeams[i]) {
      Serial.printf("  %s: Pressed=%d, Locked=%d\n", 
                   TEAM_NAMES[i], 
                   buttonStates[i].isPressed,
                   buttonStates[i].lockConfirmed);
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
    Serial.println("[WiFi] Failed to connect");
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
  Serial.println("QUIZ SCORING SYSTEM - FIXED VERSION");
  Serial.println("Perbaikan: Tombol LED nyala tapi tidak lock");
  Serial.println("========================================");
  
  // Initialize pins
  pinMode(LED_MERAH, OUTPUT);
  pinMode(LED_HIJAU, OUTPUT);
  digitalWrite(LED_MERAH, LOW);
  digitalWrite(LED_HIJAU, LOW);
  
  Serial.println("PERBAIKAN UTAMA:");
  Serial.println("  1. Debounce ditingkatkan ke 20ms");
  Serial.println("  2. Deteksi tombol lebih reliable");
  Serial.println("  3. LED feedback dipisah dari LED lock");
  Serial.println("  4. Queue management diperbaiki");
  Serial.println("");
  
  // Initialize I2C
  Wire.begin(21, 22);
  Wire.setClock(I2C_SPEED);
  delay(10);
  
  // Setup jury buttons
  pinMode(PIN_JURY_CORRECT, INPUT_PULLUP);
  pinMode(PIN_JURY_WRONG, INPUT_PULLUP);
  lastJuryCorrectState = digitalRead(PIN_JURY_CORRECT);
  lastJuryWrongState   = digitalRead(PIN_JURY_WRONG);
  
  // Setup interrupt
  pinMode(MODULE_INT_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(MODULE_INT_PIN), isrAnyModuleEngine, FALLING);
  
  // Clear press queue
  clearPressQueue();
  
  // Setup WiFi
  setupWiFiManager();
  
  // Initialize modules
  initializeModules();
  
  // First heartbeat
  lastHeartbeatTime = millis();
  sendHeartbeatToServer();
  
  Serial.println("\n[SETUP] System ready");
  Serial.printf("[SETUP] Free Heap: %d bytes\n", ESP.getFreeHeap());
  Serial.println("========================================\n");
  
  // Test all enabled LEDs
  Serial.println("[TEST] Testing all enabled LEDs...");
  for (int team = 1; team <= 12; team++) {
    if (isTeamEnabled(team)) {
      setTeamLED(team, true);
      delay(150);
      setTeamLED(team, false);
      delay(50);
    }
  }
  Serial.println("[TEST] LED test complete\n");
}

// ====== MAIN LOOP ======
void loop() {
  // 1. Improved button detection
  improvedButtonDetection();
  
  // 2. Process press queue
  processPressQueue();
  
  // 3. Handle pending requests
  handlePendingRequests();
  
  // 4. Jury buttons
  handleJuryButtons();
  
  // 5. Update LED state
  updateButtonLEDs();
  
  // 6. Background tasks
  static unsigned long lastBackgroundCheck = 0;
  if (millis() - lastBackgroundCheck >= 50) {
    lastBackgroundCheck = millis();
    
    lastSystemCheck = millis();
    checkWiFiConnection();
  }
  
  // 7. Status LED update
  updateStatusLED();
  
  // 8. WiFi reset feature
  handleWifiReset();
  
  // 9. Module health check
  checkModuleHealth();
  
  // 10. Heartbeat (setiap 30 detik)
  if (millis() - lastHeartbeatTime >= HEARTBEAT_INTERVAL) {
    lastHeartbeatTime = millis();
    sendHeartbeatToServer();
  }
  
  // 11. Debug info (setiap 3 detik)
  printDebugInfo();
  
  yield();
}