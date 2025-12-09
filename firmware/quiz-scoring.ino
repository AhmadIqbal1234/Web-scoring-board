/*
  ESP32 master for Quiz Scoring system – SYNC WITH WEB TIMER
  VERSI DENGAN DETEKSI MODUL/TIM AKTIF
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>

// ========== KONFIGURASI ==========
const char *DEFAULT_SERVER_HOST = "web-scoring-board-production.up.railway.app";
const int   DEFAULT_SERVER_PORT = 443;
const char *WIFI_AP_NAME = "Quiz_Config";

// ========== PIN LED STATUS ==========
const int LED_MERAH = 33;  // G33 untuk LED Merah
const int LED_HIJAU = 32;  // G32 untuk LED Hijau

// ========== ALAMAT MODUL PCF8574 ==========
const uint8_t PCF_MODULE_A_C = 0x20;  // Tim A, B, C  (1,2,3)
const uint8_t PCF_MODULE_D_F = 0x21;  // Tim D, E, F  (4,5,6)
const uint8_t PCF_MODULE_G_I = 0x22;  // Tim G, H, I  (7,8,9)
const uint8_t PCF_MODULE_J_L = 0x23;  // Tim J, K, L  (10,11,12)

const uint8_t MODULE_ADDRESSES[4] = {
  PCF_MODULE_A_C,  // Index 0: Tim 1-3
  PCF_MODULE_D_F,  // Index 1: Tim 4-6  
  PCF_MODULE_G_I,  // Index 2: Tim 7-9
  PCF_MODULE_J_L   // Index 3: Tim 10-12
};

const char* TEAM_NAMES[12] = {
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"
};

// ========== KONFIGURASI PIN ==========
const int PIN_JURY_CORRECT = 4;
const int PIN_JURY_WRONG   = 5;
const int MODULE_INT_PIN = 16;  // PCF8574 INT terhubung ke ESP32 GPIO16

// ====== PEMETAAN TOMBOL-LED ======
struct ButtonLEDMapping {
  uint8_t moduleAddress;  // Alamat I2C modul
  uint8_t buttonBit;      // Bit untuk tombol (0-2)
  uint8_t ledBit;         // Bit untuk LED (3,4,5) - P3,P4,P5
  uint8_t teamNumber;     // Nomor tim (1-12)
  const char* teamName;   // Nama tim
};

const ButtonLEDMapping TEAM_MAPPINGS[12] = {
  // Module 0x20 - Tim A, B, C
  {0x20, 0, 3, 1, "A"},
  {0x20, 1, 4, 2, "B"},
  {0x20, 2, 5, 3, "C"},
  
  // Module 0x21 - Tim D, E, F
  {0x21, 0, 3, 4, "D"},
  {0x21, 1, 4, 5, "E"},
  {0x21, 2, 5, 6, "F"},
  
  // Module 0x22 - Tim G, H, I
  {0x22, 0, 3, 7, "G"},
  {0x22, 1, 4, 8, "H"},
  {0x22, 2, 5, 9, "I"},
  
  // Module 0x23 - Tim J, K, L
  {0x23, 0, 3, 10, "J"},
  {0x23, 1, 4, 11, "K"},
  {0x23, 2, 5, 12, "L"}
};

// ====== KONFIGURASI SISTEM DINAMIS ======
bool moduleEnabled[4] = {false, false, false, false};  // Modul yang aktif
bool moduleDetected[4] = {false, false, false, false}; // Modul yang terdeteksi
uint8_t enabledTeams[12] = {0};                        // Daftar tim yang diaktifkan
uint8_t activeTeamCount = 0;                           // Jumlah tim yang aktif
uint8_t detectedModules = 0;                           // PERBAIKAN: Jumlah modul terdeteksi

// ====== KONFIGURASI TIMER DARI SERVER ======
struct TimerConfig {
  int timerDuration = 30;
  bool autoPenalty = true;
  int plusPoints = 5;
  int minusPoints = -2;
};

TimerConfig config;

// ====== NILAI POIN UNTUK JURI ======
int plusValue = 5;    // Nilai default untuk tombol BENAR
int minusValue = -2;  // Nilai default untuk tombol SALAH

// ====== PERBAIKAN DEBOUNCE ======
const uint64_t BUTTON_DEBOUNCE_MS = 30;           // DEBOUNCE 30ms
const uint64_t BUTTON_LOCK_DELAY_MS = 100;        // Delay sebelum lock 100ms
const uint32_t BUTTON_MIN_PRESS_MS = 25;          // Minimal press 25ms

// ====== DETEKSI TEKANAN ATOMIK ======
struct TimestampedPress {
  int team;
  uint64_t timestamp;     // Timestamp millidetik
  uint8_t moduleIndex;
  uint8_t buttonBit;
  bool valid;
  bool processed;
};

TimestampedPress pressQueue[36];  // Antrian besar: 36 entri
volatile uint8_t queueHead = 0;
volatile uint8_t queueTail = 0;
volatile uint8_t queueCount = 0;

// ========== VARIABEL STATUS LED ==========
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

// ========== FITUR RESET WiFi ==========
bool wifiResetActive = false;
unsigned long wifiResetStartTime = 0;
const unsigned long WIFI_RESET_DURATION = 5000;
bool wifiResetTriggered = false;
bool bothPressedLastState = false;

// ====== PERBAIKAN SISTEM LOCK ======
volatile bool globalButtonLock = false;           // FLAG LOCK GLOBAL
volatile unsigned long globalLockStartTime = 0;   // Waktu lock dimulai
volatile int pendingTeamToSend = 0;              // Tim yang menunggu dikirim
volatile bool hasPendingRequest = false;         // Ada request pending
volatile bool httpInProgress = false;            // HTTP sedang berjalan

// ====== PERBAIKAN SISTEM INTERRUPT ======
volatile bool anyModuleInterrupt = false;
volatile unsigned long lastModuleInterruptTime = 0;
volatile bool interruptEnabled = true;
const unsigned long INTERRUPT_COOLDOWN_MS = 5;   // Cooldown 5ms untuk interrupt

// ====== PERBAIKAN PELACAKAN TOMBOL ======
struct ButtonState {
  bool isPressed;
  bool wasPressed;
  unsigned long pressStartTime;
  unsigned long lastChangeTime;
  bool ledFeedbackActive;
  unsigned long ledFeedbackStart;
  bool lockConfirmed;
  bool scored;
};

ButtonState buttonStates[12];

// ====== STATE MODUL ======
uint8_t pcfOutCache[4] = {0xFF, 0xFF, 0xFF, 0xFF};
uint8_t lastModuleState[4] = {0xFF, 0xFF, 0xFF, 0xFF};
uint8_t moduleReadRetry[4] = {0};

// ====== KONFIGURASI I2C ======
#define I2C_SPEED 100000 // 100kHz untuk stabilitas

// ====== KONFIGURASI TIMING ======
const unsigned long JURY_DEBOUNCE_MS   = 150;
const unsigned long LOCK_POLL_MS       = 100;
const unsigned long MODULE_SCAN_MS     = 5000;
const unsigned long BUTTON_FEEDBACK_DURATION = 100;
const unsigned long LOCK_LED_DURATION = 0;
const unsigned long WATCHDOG_TIMEOUT   = 30000;
const unsigned long HTTP_SEND_TIMEOUT  = 5000;

// ====== SISTEM POLLING UNTUK TIMER ======
unsigned long lastStatusCheckTime = 0;
const unsigned long STATUS_CHECK_INTERVAL = 800;
bool pollingEnabled = true;

// ====== SISTEM HEARTBEAT ======
unsigned long lastHeartbeatTime = 0;
const unsigned long HEARTBEAT_INTERVAL = 30000;
unsigned long heartbeatCount = 0;

// ====== STATE SISTEM ======
char serverHost[64];
int  serverPort = DEFAULT_SERVER_PORT;

bool lockActive = false;
int  activeTeam = 0;

// Stabilitas WiFi
int wifiDisconnectCount = 0;
unsigned long lastWifiCheck = 0;

// Watchdog
unsigned long lastWatchdogFeed = 0;
unsigned long lastSystemCheck = 0;

// State tombol juri
bool lastJuryCorrectState = HIGH;
bool lastJuryWrongState   = HIGH;
unsigned long lastJuryPressTime = 0;

// ========== VARIABEL DEBUG ==========
bool debugEnabled = true;
unsigned long lastButtonCheck = 0;
unsigned long lastQueueProcess = 0;

// ========== PERBAIKAN: STATE JURY ==========
bool juryButtonProcessing = false;
unsigned long lastJuryDebug = 0;

// ========== FUNGSI BANTUAN ==========
int getModuleIndex(uint8_t moduleAddress) {
  for (int i = 0; i < 4; i++) {
    if (MODULE_ADDRESSES[i] == moduleAddress) return i;
  }
  return -1;
}

// ========== FUNGSI BANTUAN PCF8574 ==========
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
  delayMicroseconds(100);
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
  
  moduleReadRetry[moduleIndex]++;
  if (moduleReadRetry[moduleIndex] > 3) {
    moduleEnabled[moduleIndex] = false;
    Serial.printf("[ERROR] Modul 0x%02X gagal setelah %d retry\n", addr, moduleReadRetry[moduleIndex]);
  }
  
  return false;
}

// ====== PERBAIKAN HANDLER INTERRUPT ======
void IRAM_ATTR isrAnyModuleEngine() {
  static unsigned long lastIsrTime = 0;
  unsigned long currentTime = millis();
  
  if (currentTime - lastIsrTime < INTERRUPT_COOLDOWN_MS) return;
  lastIsrTime = currentTime;
  
  if (interruptEnabled) {
    anyModuleInterrupt = true;
    lastModuleInterruptTime = currentTime;
  }
}

// ====== MANAJEMEN MODUL SEDERHANA ======
void initializeModules() {
  Serial.println("\n=== INISIALISASI MODUL ===");
  
  activeTeamCount = 0;
  detectedModules = 0;  // PERBAIKAN: Reset counter modul
  for (int i = 0; i < 12; i++) {
    enabledTeams[i] = 0;
    buttonStates[i].isPressed = false;
    buttonStates[i].wasPressed = false;
    buttonStates[i].pressStartTime = 0;
    buttonStates[i].lastChangeTime = 0;
    buttonStates[i].ledFeedbackActive = false;
    buttonStates[i].ledFeedbackStart = 0;
    buttonStates[i].lockConfirmed = false;
    buttonStates[i].scored = false;
  }
  
  for (int i = 0; i < 4; i++) {
    bool detected = checkModule(MODULE_ADDRESSES[i]);
    moduleDetected[i] = detected;
    moduleEnabled[i] = detected;
    moduleReadRetry[i] = 0;
    
    if (detected) {
      detectedModules++;  // PERBAIKAN: Increment counter modul
      Serial.printf("[INIT] Modul 0x%02X terdeteksi\n", MODULE_ADDRESSES[i]);
      
      pcfOutCache[i] = 0xFF;
      lastModuleState[i] = 0xFF;
      
      writePCF(MODULE_ADDRESSES[i], 0xFF);
      delay(10);
      
      for (int team = 0; team < 12; team++) {
        if (TEAM_MAPPINGS[team].moduleAddress == MODULE_ADDRESSES[i]) {
          enabledTeams[team] = 1;
          activeTeamCount++;  // PERBAIKAN: Hitung tim aktif
          Serial.printf("  Tim %s diaktifkan\n", TEAM_NAMES[team]);
        }
      }
    } else {
      Serial.printf("[INIT] Modul 0x%02X tidak terdeteksi\n", MODULE_ADDRESSES[i]);
    }
  }
  
  Serial.printf("[INIT] Modul terdeteksi: %d, Tim aktif: %d\n", detectedModules, activeTeamCount);
  Serial.println("===========================\n");
}

bool isTeamEnabled(uint8_t teamNumber) {
  if (teamNumber < 1 || teamNumber > 12) return false;
  return enabledTeams[teamNumber - 1] == 1;
}

// ====== PERBAIKAN DETEKSI TOMBOL ======
void improvedButtonDetection() {
  unsigned long currentTime = millis();
  
  for (int i = 0; i < 4; i++) {
    if (!moduleEnabled[i]) continue;
    
    uint8_t currentState;
    if (!readPCF(MODULE_ADDRESSES[i], currentState)) {
      continue;
    }
    
    moduleReadRetry[i] = 0;
    
    if (currentState != lastModuleState[i]) {
      if (debugEnabled) {
        Serial.printf("[BUTTON] Modul 0x%02X berubah: 0x%02X\n", 
                     MODULE_ADDRESSES[i], currentState);
      }
      
      for (int teamIdx = 0; teamIdx < 12; teamIdx++) {
        const ButtonLEDMapping &mapping = TEAM_MAPPINGS[teamIdx];
        if (mapping.moduleAddress != MODULE_ADDRESSES[i]) continue;
        
        if (!isTeamEnabled(mapping.teamNumber)) continue;
        
        int teamIndex = mapping.teamNumber - 1;
        uint8_t mask = (1 << mapping.buttonBit);
        bool currentPressed = (currentState & mask) == 0;
        bool wasPressed = buttonStates[teamIndex].wasPressed;
        
        if (currentTime - buttonStates[teamIndex].lastChangeTime < BUTTON_DEBOUNCE_MS) {
          continue;
        }
        
        if (currentPressed && !wasPressed) {
          buttonStates[teamIndex].scored = false;
        }
        
        if (currentPressed && !wasPressed) {
          buttonStates[teamIndex].isPressed = true;
          buttonStates[teamIndex].wasPressed = true;
          buttonStates[teamIndex].pressStartTime = currentTime;
          buttonStates[teamIndex].lastChangeTime = currentTime;
          buttonStates[teamIndex].lockConfirmed = false;
          
          addToPressQueue(mapping.teamNumber, currentTime, i, mapping.buttonBit);
          
          setTeamLED(mapping.teamNumber, true);
          buttonStates[teamIndex].ledFeedbackActive = true;
          buttonStates[teamIndex].ledFeedbackStart = currentTime;
          
          Serial.printf("[BUTTON] Tim %s DITEKAN @%lu ms\n", 
                       mapping.teamName, currentTime);
        }
        
        if (!currentPressed && wasPressed) {
          buttonStates[teamIndex].isPressed = false;
          buttonStates[teamIndex].wasPressed = false;
          buttonStates[teamIndex].lastChangeTime = currentTime;
          
          unsigned long pressDuration = currentTime - buttonStates[teamIndex].pressStartTime;
          
          if (debugEnabled) {
            Serial.printf("[BUTTON] Tim %s DILEPAS setelah %lu ms\n",
                         mapping.teamName, pressDuration);
          }
        }
      }
      
      lastModuleState[i] = currentState;
    }
  }
}

// ====== FUNGSI ANTRIAN ATOMIK ======
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
  
  for (int i = 0; i < 36; i++) {
    if (pressQueue[i].valid && !pressQueue[i].processed && pressQueue[i].team == team) {
      interrupts();
      return false;
    }
  }
  
  if (queueCount >= 36) {
    for (int i = 0; i < 36; i++) {
      if (pressQueue[i].valid && pressQueue[i].processed) {
        pressQueue[i].valid = false;
        queueCount--;
        break;
      }
    }
  }
  
  int insertIndex = -1;
  for (int i = 0; i < 36; i++) {
    if (!pressQueue[i].valid) {
      insertIndex = i;
      break;
    }
  }
  
  if (insertIndex == -1) {
    insertIndex = queueTail;
    queueTail = (queueTail + 1) % 36;
  }
  
  pressQueue[insertIndex].team = team;
  pressQueue[insertIndex].timestamp = timestamp;
  pressQueue[insertIndex].moduleIndex = modIndex;
  pressQueue[insertIndex].buttonBit = buttonBit;
  pressQueue[insertIndex].valid = true;
  pressQueue[insertIndex].processed = false;
  
  queueCount++;
  
  if (debugEnabled) {
    Serial.printf("[QUEUE] Tim %s ditambahkan @%lu ms (antrian: %d)\n", 
                  TEAM_NAMES[team-1], timestamp, queueCount);
  }
  
  interrupts();
  return true;
}

// ====== PROSES ANTRIAN TEKANAN ======
void processPressQueue() {
  unsigned long currentTime = millis();
  
  if (currentTime - lastQueueProcess < 10) return;
  lastQueueProcess = currentTime;
  
  if (globalButtonLock || lockActive || httpInProgress || wifiResetActive || juryButtonProcessing) {
    Serial.printf("[QUEUE] Skipped - GlobalLock:%d, LockActive:%d, HTTP:%d, Reset:%d, Jury:%d\n",
                  globalButtonLock, lockActive, httpInProgress, wifiResetActive, juryButtonProcessing);
    return;
  }
  
  TimestampedPress* earliest = NULL;
  unsigned long earliestTime = 0xFFFFFFFF;
  int earliestIndex = -1;
  
  noInterrupts();
  for (int i = 0; i < 36; ++i) {
    if (!pressQueue[i].valid || pressQueue[i].processed) continue;
    
    unsigned long pressTime = pressQueue[i].timestamp;
    
    unsigned long pressAge = currentTime - pressTime;
    if (pressAge < BUTTON_MIN_PRESS_MS) continue;
    
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
    
    int teamIndex = team - 1;
    if (!buttonStates[teamIndex].isPressed) {
      noInterrupts();
      earliest->processed = true;
      earliest->valid = false;
      if (queueCount > 0) queueCount--;
      interrupts();
      
      setTeamLED(team, false);
      buttonStates[teamIndex].ledFeedbackActive = false;
      buttonStates[teamIndex].lockConfirmed = false;
      
      Serial.printf("[QUEUE] Tim %s dilepas, dibatalkan\n", TEAM_NAMES[team-1]);
      return;
    }
    
    if (acquireGlobalLock(team)) {
      noInterrupts();
      earliest->processed = true;
      interrupts();
      
      Serial.printf("[QUEUE] Mengirim lock untuk Tim %s (usia: %lu ms)\n", TEAM_NAMES[team-1], ageMs);
      
      sendUpdateToServerAtomic(team);
      
    } else {
      Serial.printf("[QUEUE] Gagal acquire lock untuk Tim %s\n", TEAM_NAMES[team-1]);
    }
  }
  
  static unsigned long lastCleanup = 0;
  if (currentTime - lastCleanup > 100) {
    lastCleanup = currentTime;
    cleanupOldPresses();
  }
}

// ====== FUNGSI PEMBERSIHAN ======
void cleanupOldPresses() {
  unsigned long currentTime = millis();
  
  noInterrupts();
  for (int i = 0; i < 36; i++) {
    if (pressQueue[i].valid) {
      unsigned long age = currentTime - pressQueue[i].timestamp;
      
      if (age > 3000 || pressQueue[i].processed) {
        pressQueue[i].valid = false;
        if (queueCount > 0) queueCount--;
      }
    }
  }
  interrupts();
}

// ========== PERBAIKAN MANAJEMEN LOCK ==========
bool acquireGlobalLock(int team) {
  if (httpInProgress || globalButtonLock || lockActive || wifiResetActive || juryButtonProcessing) {
    Serial.printf("[LOCK] Tidak bisa acquire lock - Sibuk (HTTP: %d, Global: %d, Lock: %d, Reset: %d, Jury: %d)\n", 
                 httpInProgress, globalButtonLock, lockActive, wifiResetActive, juryButtonProcessing);
    return false;
  }
  
  globalButtonLock = true;
  globalLockStartTime = millis();
  pendingTeamToSend = team;
  hasPendingRequest = true;
  httpInProgress = true;
  
  Serial.printf("[LOCK] Lock global DIPEROLEH untuk Tim %s\n", TEAM_NAMES[team-1]);
  return true;
}

void releaseGlobalLock() {
  globalButtonLock = false;
  hasPendingRequest = false;
  pendingTeamToSend = 0;
  httpInProgress = false;
  Serial.println("[LOCK] Lock global DILEPASKAN");
}

// ====== PERBAIKAN KONTROL LED ======
void setTeamLED(uint8_t teamNumber, bool on) {
  if (teamNumber < 1 || teamNumber > 12) return;
  
  if (!isTeamEnabled(teamNumber)) return;
  
  const ButtonLEDMapping& mapping = TEAM_MAPPINGS[teamNumber - 1];
  int moduleIndex = getModuleIndex(mapping.moduleAddress);
  
  if (moduleIndex == -1 || !moduleEnabled[moduleIndex]) return;
  
  uint8_t currentState = pcfOutCache[moduleIndex];
  
  if (on) {
    currentState &= ~(1 << mapping.ledBit);
  } else {
    currentState |= (1 << mapping.ledBit);
  }
  
  pcfOutCache[moduleIndex] = currentState;
  
  for (int retry = 0; retry < 3; retry++) {
    if (writePCF(mapping.moduleAddress, currentState)) {
      break;
    }
    delay(1);
  }
  
  if (debugEnabled && teamNumber <= 12) {
    Serial.printf("[LED] Tim %s %s (Modul 0x%02X, State: 0x%02X)\n",
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
    buttonStates[i].lockConfirmed = false;
  }
  
  if (debugEnabled) Serial.println("[LED] Semua LED dimatikan dan state direset");
}

void updateButtonLEDs() {
  unsigned long now = millis();
  
  for (int team = 1; team <= 12; team++) {
    if (!isTeamEnabled(team)) continue;
    
    int idx = team - 1;
    
    if (buttonStates[idx].ledFeedbackActive && 
        !buttonStates[idx].lockConfirmed &&
        (now - buttonStates[idx].ledFeedbackStart >= BUTTON_FEEDBACK_DURATION)) {
      
      if (!lockActive || activeTeam != team) {
        setTeamLED(team, false);
        buttonStates[idx].ledFeedbackActive = false;
      }
    }
    
    if (lockActive && activeTeam == team) {
      setTeamLED(team, true);
    }
  }
}

// ====== SISTEM POLLING UNTUK CEK STATUS DARI SERVER ======
void checkTimerStatusFromServer() {
  if (!pollingEnabled) return;
  
  unsigned long currentTime = millis();
  if (currentTime - lastStatusCheckTime < STATUS_CHECK_INTERVAL) return;
  
  lastStatusCheckTime = currentTime;
  
  if (!lockActive || activeTeam == 0) return;
  
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[POLL] WiFi tidak terhubung, skipping polling");
    return;
  }
  
  String url = "https://" + String(serverHost) + "/checktimer?team=" + String(activeTeam);
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(3000);
  http.setTimeout(3000);
  
  if (http.begin(url)) {
    int code = http.GET();
    String response = http.getString();
    
    Serial.printf("[POLL] Timer status untuk Tim %s -> Kode: %d, Response: %s\n", 
                  TEAM_NAMES[activeTeam-1], code, response.c_str());
    
    http.end();
    
    if (code == 200) {
      DynamicJsonDocument doc(256);
      DeserializationError error = deserializeJson(doc, response);
      
      if (!error) {
        bool timerActive = doc["timerActive"];
        bool lockStatus = doc["lockActive"];
        
        if (!timerActive || !lockStatus) {
          Serial.printf("[POLL] Timer habis untuk Tim %s! Melepas lock...\n", TEAM_NAMES[activeTeam-1]);
          
          lockActive = false;
          activeTeam = 0;
          
          for (int i = 0; i < 12; i++) {
            buttonStates[i].lockConfirmed = false;
            buttonStates[i].scored = false;
          }
          
          clearAllLEDs();
          
          globalButtonLock = false;
          hasPendingRequest = false;
          httpInProgress = false;
          
          for (int i = 0; i < 3; i++) {
            digitalWrite(LED_MERAH, HIGH);
            delay(150);
            digitalWrite(LED_MERAH, LOW);
            if (i < 2) delay(100);
          }
          
          Serial.println("[POLL] Lock berhasil dilepas karena timer habis");
        } else {
          Serial.printf("[POLL] Timer masih berjalan untuk Tim %s\n", TEAM_NAMES[activeTeam-1]);
        }
      } else {
        Serial.printf("[POLL] Gagal parse JSON: %s\n", error.c_str());
      }
    } else {
      Serial.printf("[POLL] Error kode HTTP: %d\n", code);
    }
  } else {
    Serial.println("[POLL] Gagal memulai koneksi HTTP");
  }
}

// ====== FUNGSI HEARTBEAT DENGAN DATA MODUL/TIM ======
void sendHeartbeatToServer() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[HEARTBEAT] WiFi tidak terhubung");
    return;
  }
  
  // PERBAIKAN: Kirim data modul dan tim aktif
  String url = "https://" + String(serverHost) + "/esp32checkin?" 
               "action=heartbeat&"
               "count=" + String(heartbeatCount) + "&"
               "teams=" + String(activeTeamCount) + "&"
               "modules=" + String(detectedModules);
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(3000);
  http.setTimeout(3000);
  
  if (http.begin(url)) {
    int code = http.GET();
    Serial.printf("[HEARTBEAT] #%d -> Kode: %d, Tim: %d, Modul: %d\n", 
                  heartbeatCount, code, activeTeamCount, detectedModules);
    http.end();
    
    if (code == 200) {
      heartbeatCount++;
    }
  }
}

// ========== SINCRONISASI KONFIGURASI DARI SERVER ==========
void syncConfiguration() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[CONFIG] WiFi tidak terhubung, tidak bisa sinkronisasi konfigurasi");
    return;
  }

  String url = "https://" + String(serverHost) + "/config";
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(3000);
  http.setTimeout(3000);
  
  Serial.printf("[CONFIG] Mengambil konfigurasi dari: %s\n", url.c_str());
  
  if (http.begin(url)) {
    int httpCode = http.GET();
    if (httpCode == 200) {
      String payload = http.getString();
      DynamicJsonDocument doc(256);
      DeserializationError error = deserializeJson(doc, payload);
      
      if (!error) {
        int newDuration = doc["timerDuration"];
        int newPlus = doc["plus"];
        int newMinus = doc["minus"];
        
        if (newDuration != config.timerDuration) {
          config.timerDuration = newDuration;
          Serial.printf("[CONFIG] Durasi timer diperbarui: %d detik\n", config.timerDuration);
        }
        
        if (newPlus != config.plusPoints) {
          config.plusPoints = newPlus;
          plusValue = config.plusPoints;
          Serial.printf("[CONFIG] Poin benar diperbarui: +%d\n", config.plusPoints);
        }
        
        if (newMinus != config.minusPoints) {
          config.minusPoints = newMinus;
          minusValue = config.minusPoints;
          Serial.printf("[CONFIG] Poin salah diperbarui: %d\n", config.minusPoints);
        }
        
      } else {
        Serial.printf("[CONFIG] Gagal parsing JSON: %s\n", error.c_str());
      }
    } else {
      Serial.printf("[CONFIG] Gagal mengambil konfigurasi, kode HTTP: %d\n", httpCode);
    }
    http.end();
  } else {
    Serial.println("[CONFIG] Gagal memulai koneksi HTTP");
  }
}

// ========== FUNGSI RESET WiFi ==========
void handleWifiReset() {
  bool corrPressed = digitalRead(PIN_JURY_CORRECT) == LOW;
  bool wrongPressed = digitalRead(PIN_JURY_WRONG) == LOW;
  bool bothPressed = corrPressed && wrongPressed;

  if (!corrPressed && !wrongPressed) {
    if (wifiResetActive) {
      wifiResetActive = false;
      wifiResetTriggered = false;
      updateStatusLED();
      Serial.println("[WIFI-RESET] Reset dibatalkan");
    }
    bothPressedLastState = false;
    return;
  }

  if (bothPressed && !bothPressedLastState) {
    wifiResetActive = true;
    wifiResetStartTime = millis();
    wifiResetTriggered = false;
    Serial.println("[WIFI-RESET] Kedua tombol ditekan, memulai countdown 5 detik...");
    
    digitalWrite(LED_MERAH, HIGH);
    digitalWrite(LED_HIJAU, HIGH);
    
    bothPressedLastState = true;
  }
  
  if (bothPressed && wifiResetActive) {
    unsigned long elapsed = millis() - wifiResetStartTime;
    
    if (elapsed >= WIFI_RESET_DURATION && !wifiResetTriggered) {
      wifiResetTriggered = true;
      triggerWifiReset();
    }
  }
  
  bothPressedLastState = bothPressed;
}

void triggerWifiReset() {
  Serial.println("\n[WIFI-RESET] Mereset WiFi dan state sistem...");
  
  resetSystemState();
  
  WiFiManager wm;
  wm.resetSettings();
  
  delay(2000);
  
  Serial.println("[WIFI-RESET] Merestart ESP32...");
  ESP.restart();
}

// ========== RESET STATE SISTEM ==========
void resetSystemState() {
  globalButtonLock = false;
  lockActive = false;
  activeTeam = 0;
  hasPendingRequest = false;
  httpInProgress = false;
  juryButtonProcessing = false;
  
  clearAllLEDs();
  
  for (int i = 0; i < 12; i++) {
    buttonStates[i].isPressed = false;
    buttonStates[i].wasPressed = false;
    buttonStates[i].lockConfirmed = false;
    buttonStates[i].ledFeedbackActive = false;
    buttonStates[i].scored = false;
  }
  
  clearPressQueue();
  
  Serial.println("[SYSTEM] Semua state direset");
}

// ========== FUNGSI LED STATUS ==========
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

// ========== PEMULIHAN WiFi ==========
void checkWiFiConnection() {
  static unsigned long lastCheck = 0;
  unsigned long now = millis();
  
  if (now - lastCheck > 10000) {
    lastCheck = now;
    
    if (WiFi.status() != WL_CONNECTED) {
      wifiDisconnectCount++;
      Serial.printf("[WiFi] Terputus! Menyambung ulang #%d\n", wifiDisconnectCount);
      
      WiFi.disconnect();
      delay(500);
      WiFi.reconnect();
      delay(1000);
      
      if (WiFi.status() == WL_CONNECTED) {
        Serial.println("[WiFi] Tersambung ulang");
        wifiDisconnectCount = 0;
      }
    }
  }
}

// ========== CEK KESEHATAN MODUL ==========
void checkModuleHealth() {
  static unsigned long lastCheck = 0;
  unsigned long now = millis();
  
  if (now - lastCheck > 5000) {
    lastCheck = now;
    
    bool anyChange = false;
    uint8_t newDetectedModules = 0;
    uint8_t newActiveTeamCount = 0;
    
    for (int i = 0; i < 4; i++) {
      bool currentlyDetected = checkModule(MODULE_ADDRESSES[i]);
      
      if (currentlyDetected != moduleDetected[i]) {
        anyChange = true;
        moduleDetected[i] = currentlyDetected;
        moduleEnabled[i] = currentlyDetected;
        
        if (currentlyDetected) {
          Serial.printf("[HEALTH] Modul 0x%02X tersambung\n", MODULE_ADDRESSES[i]);
          
          pcfOutCache[i] = 0xFF;
          lastModuleState[i] = 0xFF;
          writePCF(MODULE_ADDRESSES[i], 0xFF);
          
          for (int team = 0; team < 12; team++) {
            if (TEAM_MAPPINGS[team].moduleAddress == MODULE_ADDRESSES[i]) {
              enabledTeams[team] = 1;
              newActiveTeamCount++;
            }
          }
          newDetectedModules++;
        } else {
          Serial.printf("[HEALTH] Modul 0x%02X terputus\n", MODULE_ADDRESSES[i]);
          
          for (int team = 0; team < 12; team++) {
            if (TEAM_MAPPINGS[team].moduleAddress == MODULE_ADDRESSES[i]) {
              enabledTeams[team] = 0;
            }
          }
        }
      } else if (currentlyDetected) {
        // Modul masih terdeteksi, tetap hitung
        newDetectedModules++;
        for (int team = 0; team < 12; team++) {
          if (TEAM_MAPPINGS[team].moduleAddress == MODULE_ADDRESSES[i] && enabledTeams[team] == 1) {
            newActiveTeamCount++;
          }
        }
      }
    }
    
    // Update global counters
    if (anyChange) {
      detectedModules = newDetectedModules;
      activeTeamCount = newActiveTeamCount;
      Serial.printf("[HEALTH] Modul: %d, Tim aktif: %d\n", detectedModules, activeTeamCount);
    }
  }
}

// ====== PERBAIKAN TOMBOL JURI ======
void handleJuryButtons() {
  bool corrPressed = (digitalRead(PIN_JURY_CORRECT) == LOW);
  bool wrongPressed = (digitalRead(PIN_JURY_WRONG) == LOW);
  
  if (wifiResetActive || juryButtonProcessing) {
    lastJuryCorrectState = corrPressed;
    lastJuryWrongState = wrongPressed;
    return;
  }
  
  if (millis() - lastJuryDebug > 3000) {
    lastJuryDebug = millis();
    Serial.printf("[JURY-DEBUG] Correct: %d, Wrong: %d, LockActive: %d, ActiveTeam: %d\n", 
                  corrPressed, wrongPressed, lockActive, activeTeam);
    
    for (int i = 0; i < 12; i++) {
      if (buttonStates[i].lockConfirmed) {
        Serial.printf("  Tim %s lockConfirmed=true\n", TEAM_NAMES[i]);
      }
    }
  }
  
  if (corrPressed && !lastJuryCorrectState) {
    Serial.println("[JURY] 🟢 Tombol BENAR ditekan!");
    handleJuryButtonAction(true);
  }
  
  if (wrongPressed && !lastJuryWrongState) {
    Serial.println("[JURY] 🔴 Tombol SALAH ditekan!");
    handleJuryButtonAction(false);
  }
  
  lastJuryCorrectState = corrPressed;
  lastJuryWrongState = wrongPressed;
}

void handleJuryButtonAction(bool isCorrect) {
  unsigned long now = millis();
  
  if (now - lastJuryPressTime < JURY_DEBOUNCE_MS) {
    Serial.printf("[JURY] Debounce active, skipping\n");
    return;
  }
  
  lastJuryPressTime = now;
  juryButtonProcessing = true;
  
  int teamToScore = findActiveTeamForJury();
  
  if (teamToScore == 0) {
    Serial.println("[JURY] ❌ ERROR: Tidak ada tim aktif untuk diberi skor!");
    
    for (int i = 0; i < 5; i++) {
      digitalWrite(LED_MERAH, HIGH);
      delay(80);
      digitalWrite(LED_MERAH, LOW);
      delay(80);
    }
    
    juryButtonProcessing = false;
    return;
  }
  
  int points = isCorrect ? plusValue : minusValue;
  const char* action = isCorrect ? "BENAR" : "SALAH";
  
  Serial.printf("[JURY] Memberi skor %d untuk Tim %s (%s)\n", 
                points, TEAM_NAMES[teamToScore-1], action);
  
  sendJuryUpdateToServer(teamToScore, points, action);
  
  if (isCorrect) {
    for (int i = 0; i < 3; i++) {
      digitalWrite(LED_HIJAU, HIGH);
      delay(150);
      digitalWrite(LED_HIJAU, LOW);
      if (i < 2) delay(100);
    }
  } else {
    for (int i = 0; i < 3; i++) {
      digitalWrite(LED_MERAH, HIGH);
      delay(150);
      digitalWrite(LED_MERAH, LOW);
      if (i < 2) delay(100);
    }
  }
  
  juryButtonProcessing = false;
}

int findActiveTeamForJury() {
  if (lockActive && activeTeam > 0 && activeTeam <= 12) {
    Serial.printf("[JURY] Menggunakan lockActive: Tim %s\n", TEAM_NAMES[activeTeam-1]);
    return activeTeam;
  }
  
  for (int i = 0; i < 12; i++) {
    if (buttonStates[i].lockConfirmed) {
      Serial.printf("[JURY] Menggunakan lockConfirmed: Tim %s\n", TEAM_NAMES[i]);
      return i + 1;
    }
  }
  
  for (int i = 0; i < 12; i++) {
    if (buttonStates[i].ledFeedbackActive) {
      Serial.printf("[JURY] Menggunakan ledFeedbackActive: Tim %s\n", TEAM_NAMES[i]);
      return i + 1;
    }
  }
  
  return 0;
}

// ====== PERBAIKAN PENGIRIMAN KE SERVER ======
void sendUpdateToServerAtomic(int team) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("[HTTP-ERROR] WiFi tidak terhubung untuk Tim %s\n", TEAM_NAMES[team-1]);
    lockActive = false;
    activeTeam = 0;
    buttonStates[team-1].lockConfirmed = false;
    clearAllLEDs();
    releaseGlobalLock();
    return;
  }
  
  String url = "https://" + String(serverHost) + "/update?team=" + 
               String(team) + "&add=0&first=1&_t=" + String(millis());
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(HTTP_SEND_TIMEOUT);
  http.setTimeout(HTTP_SEND_TIMEOUT);
  
  Serial.printf("[HTTP] Mengunci Tim %s: %s\n", TEAM_NAMES[team-1], url.c_str());
  
  unsigned long startTime = millis();
  bool success = false;
  
  if (http.begin(url)) {
    int code = http.GET();
    unsigned long elapsed = millis() - startTime;
    
    Serial.printf("[HTTP] Response Tim %s -> Kode: %d, Waktu: %lums\n", 
                  TEAM_NAMES[team-1], code, elapsed);
    
    if (code == 200) {
      Serial.printf("[HTTP] Tim %s BERHASIL terkunci\n", TEAM_NAMES[team-1]);
      success = true;
      
      digitalWrite(LED_HIJAU, HIGH);
      delay(100);
      digitalWrite(LED_HIJAU, LOW);
      
    } else {
      Serial.printf("[HTTP] ERROR: Kode %d untuk Tim %s\n", code, TEAM_NAMES[team-1]);
      
      delay(100);
      code = http.GET();
      if (code == 200) {
        Serial.printf("[HTTP] Tim %s terkunci pada retry\n", TEAM_NAMES[team-1]);
        success = true;
      }
    }
    
    http.end();
  }
  
  if (success) {
    lockActive = true;
    activeTeam = team;
    buttonStates[team-1].lockConfirmed = true;
    buttonStates[team-1].scored = false;
    httpInProgress = false;
    
    Serial.printf("[LOCK] Tim %s siap menerima skor dari juri\n", TEAM_NAMES[team-1]);
    
    setTeamLED(team, true);
    
    lastStatusCheckTime = millis();
    
  } else {
    Serial.printf("[HTTP] GAGAL mengunci Tim %s\n", TEAM_NAMES[team-1]);
    lockActive = false;
    activeTeam = 0;
    buttonStates[team-1].lockConfirmed = false;
    clearAllLEDs();
    releaseGlobalLock();
    
    for (int i = 0; i < 3; i++) {
      digitalWrite(LED_MERAH, HIGH);
      delay(100);
      digitalWrite(LED_MERAH, LOW);
      delay(100);
    }
  }
}

void sendJuryUpdateToServer(int team, int add, const char *action) {
  if (team < 1 || team > 12) {
    Serial.printf("[JURY-ERROR] Team %d invalid\n", team);
    return;
  }
  
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("[JURY-ERROR] WiFi not connected\n", team);
    return;
  }
  
  int teamIdx = team - 1;
  if (buttonStates[teamIdx].scored) {
    Serial.printf("[JURY] Tim %s sudah discore sebelumnya, skipping\n", TEAM_NAMES[teamIdx]);
    return;
  }
  
  String url = "https://" + String(serverHost) + "/update?team=" + 
               String(team) + "&add=" + String(add);
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  
  Serial.printf("[JURY] Mengirim %s untuk Tim %s: %s\n", 
                action, TEAM_NAMES[teamIdx], url.c_str());
  
  if (http.begin(url)) {
    int code = http.GET();
    String response = http.getString();
    
    Serial.printf("[JURY] Response: Kode=%d, Response=%s\n", code, response.c_str());
    
    http.end();
    
    if (code == 200) {
      Serial.printf("[JURY] ✅ Skor berhasil dikirim untuk Tim %s\n", TEAM_NAMES[teamIdx]);
      
      buttonStates[teamIdx].scored = true;
      
      lockActive = false;
      activeTeam = 0;
      
      for (int i = 0; i < 12; i++) {
        buttonStates[i].lockConfirmed = false;
      }
      
      clearAllLEDs();
      
      globalButtonLock = false;
      hasPendingRequest = false;
      httpInProgress = false;
      
      sendHeartbeatToServer();
      
    } else {
      Serial.printf("[JURY] ❌ ERROR: Gagal mengirim skor (kode: %d)\n", code);
      
      for (int i = 0; i < 3; i++) {
        digitalWrite(LED_MERAH, HIGH);
        delay(100);
        digitalWrite(LED_MERAH, LOW);
        delay(100);
      }
    }
  } else {
    Serial.println("[JURY] ❌ ERROR: Gagal memulai koneksi HTTP");
  }
}

// ====== HANDLE REQUEST PENDING ======
void handlePendingRequests() {
  static unsigned long lastProcessTime = 0;
  unsigned long now = millis();
  
  if (now - lastProcessTime < 50) return;
  lastProcessTime = now;
}

// ====== FUNGSI DEBUG ======
void printActiveTeams() {
  Serial.print("Tim aktif: ");
  bool anyActive = false;
  for (int i = 0; i < 12; i++) {
    if (enabledTeams[i] == 1) {
      Serial.printf("%s ", TEAM_NAMES[i]);
      anyActive = true;
    }
  }
  if (!anyActive) Serial.print("Tidak ada");
  Serial.println();
}

void printDebugInfo() {
  static unsigned long lastDebug = 0;
  if (millis() - lastDebug < 5000) return;
  lastDebug = millis();
  
  Serial.printf("\n[DEBUG] WiFi: %d, Lock: %d, ActiveTeam: %d\n", 
                WiFi.status(), lockActive, activeTeam);
  Serial.printf("[DEBUG] HTTP: %d, GlobalLock: %d, Jury: %d\n", 
                httpInProgress, globalButtonLock, juryButtonProcessing);
  
  for (int i = 0; i < 12; i++) {
    if (buttonStates[i].lockConfirmed || buttonStates[i].ledFeedbackActive) {
      Serial.printf("  %s: Locked=%d, LED=%d, Scored=%d\n", 
                   TEAM_NAMES[i], 
                   buttonStates[i].lockConfirmed,
                   buttonStates[i].ledFeedbackActive,
                   buttonStates[i].scored);
    }
  }
}

void printLockStatus() {
  static unsigned long lastPrint = 0;
  if (millis() - lastPrint > 2000) {
    lastPrint = millis();
    
    Serial.printf("[STATUS] LockActive: %d, ActiveTeam: %d, JuryProcessing: %d\n",
                  lockActive, activeTeam, juryButtonProcessing);
  }
}

// ====== WiFi & KONFIGURASI ======
WiFiManagerParameter custom_server_host("host", "Host server", DEFAULT_SERVER_HOST, 64);
WiFiManagerParameter custom_server_port("port", "Port", "443", 6);

void setupWiFiManager() {
  WiFiManager wm;
  wm.setConnectTimeout(30);
  wm.setConfigPortalTimeout(180);
  wm.addParameter(&custom_server_host);
  wm.addParameter(&custom_server_port);
  
  if (!wm.autoConnect(WIFI_AP_NAME)) {
    Serial.println("[WiFi] Gagal menyambung");
    ESP.restart();
  }
  
  String hostValue = custom_server_host.getValue();
  hostValue.replace("http://", ""); 
  hostValue.replace("https://", "");
  strncpy(serverHost, hostValue.c_str(), sizeof(serverHost) - 1);
  serverPort = atoi(custom_server_port.getValue());
  
  Serial.printf("WiFi: Tersambung ke %s\n", WiFi.SSID().c_str());
  Serial.printf("Server: Host=%s Port=%d\n", serverHost, serverPort);
}

// ====== SETUP ======
void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("\n========================================");
  Serial.println("SISTEM SKOR KUIS - SYNC WITH WEB TIMER");
  Serial.println("DENGAN DETEKSI MODUL/TIM AKTIF");
  Serial.println("========================================");
  
  pinMode(LED_MERAH, OUTPUT);
  pinMode(LED_HIJAU, OUTPUT);
  digitalWrite(LED_MERAH, LOW);
  digitalWrite(LED_HIJAU, LOW);
  
  Serial.println("[SETUP] Testing LED status...");
  digitalWrite(LED_MERAH, HIGH);
  delay(500);
  digitalWrite(LED_MERAH, LOW);
  digitalWrite(LED_HIJAU, HIGH);
  delay(500);
  digitalWrite(LED_HIJAU, LOW);
  
  pinMode(PIN_JURY_CORRECT, INPUT_PULLUP);
  pinMode(PIN_JURY_WRONG, INPUT_PULLUP);
  
  Serial.println("[SETUP] Testing tombol juri...");
  Serial.println("Tekan tombol BENAR untuk test...");
  unsigned long start = millis();
  while (millis() - start < 5000) {
    if (digitalRead(PIN_JURY_CORRECT) == LOW) {
      Serial.println("[SETUP] ✅ Tombol BENAR berfungsi!");
      digitalWrite(LED_HIJAU, HIGH);
      delay(200);
      digitalWrite(LED_HIJAU, LOW);
      break;
    }
    delay(10);
  }
  
  Serial.println("Tekan tombol SALAH untuk test...");
  start = millis();
  while (millis() - start < 5000) {
    if (digitalRead(PIN_JURY_WRONG) == LOW) {
      Serial.println("[SETUP] ✅ Tombol SALAH berfungsi!");
      digitalWrite(LED_MERAH, HIGH);
      delay(200);
      digitalWrite(LED_MERAH, LOW);
      break;
    }
    delay(10);
  }
  
  Serial.println("\nFITUR UTAMA:");
  Serial.println("  1. Deteksi modul aktif: 0-4 modul");
  Serial.println("  2. Deteksi tombol tim aktif: 0-12 tombol");
  Serial.println("  3. Lock dilepas berdasarkan polling ke server");
  Serial.println("  4. Polling setiap 800ms untuk cek status timer");
  Serial.println("  5. Timer web habis → ESP32 otomatis unlock");
  Serial.println("  6. Debounce 30ms");
  Serial.println("");
  
  Wire.begin(21, 22);
  Wire.setClock(I2C_SPEED);
  delay(10);
  
  pinMode(MODULE_INT_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(MODULE_INT_PIN), isrAnyModuleEngine, FALLING);
  
  clearPressQueue();
  
  setupWiFiManager();
  
  syncConfiguration();
  
  initializeModules();
  
  lastHeartbeatTime = millis();
  sendHeartbeatToServer();
  
  Serial.println("\n[SETUP] Sistem siap");
  Serial.printf("[SETUP] Modul terdeteksi: %d, Tim aktif: %d\n", detectedModules, activeTeamCount);
  Serial.println("========================================\n");
  
  Serial.println("[TEST] Menguji semua LED yang diaktifkan...");
  for (int team = 1; team <= 12; team++) {
    if (isTeamEnabled(team)) {
      setTeamLED(team, true);
      delay(150);
      setTeamLED(team, false);
      delay(50);
    }
  }
  Serial.println("[TEST] Uji LED selesai\n");
}

// ====== LOOP UTAMA ======
void loop() {
  handleWifiReset();
  
  if (wifiResetActive) {
    unsigned long elapsed = millis() - wifiResetStartTime;
    
    if (millis() % 200 < 100) {
      digitalWrite(LED_MERAH, HIGH);
      digitalWrite(LED_HIJAU, HIGH);
    } else {
      digitalWrite(LED_MERAH, LOW);
      digitalWrite(LED_HIJAU, LOW);
    }
    
    static unsigned long lastProgressPrint = 0;
    if (millis() - lastProgressPrint > 1000) {
      lastProgressPrint = millis();
      Serial.printf("[WIFI-RESET] Progress: %d%% (%lu/%lu ms)\n", 
                   (elapsed * 100) / WIFI_RESET_DURATION, elapsed, WIFI_RESET_DURATION);
    }
    
    return;
  }
  
  updateStatusLED();
  
  improvedButtonDetection();
  
  processPressQueue();
  
  handlePendingRequests();
  
  handleJuryButtons();
  
  checkTimerStatusFromServer();
  
  updateButtonLEDs();
  
  static unsigned long lastBackgroundCheck = 0;
  if (millis() - lastBackgroundCheck >= 100) {
    lastBackgroundCheck = millis();
    checkWiFiConnection();
    checkModuleHealth();
  }
  
  if (millis() - lastHeartbeatTime >= HEARTBEAT_INTERVAL) {
    lastHeartbeatTime = millis();
    sendHeartbeatToServer();
  }
  
  printLockStatus();
  printDebugInfo();
  
  static unsigned long lastSafetyCheck = 0;
  if (millis() - lastSafetyCheck > 30000) {
    lastSafetyCheck = millis();
    
    if (lockActive && (millis() - globalLockStartTime > 120000)) {
      Serial.println("[SAFETY-EMERGENCY] Lock aktif terlalu lama, mereset sistem!");
      resetSystemState();
      clearAllLEDs();
    }
  }
  
  static unsigned long lastConfigSync = 0;
  if (millis() - lastConfigSync > 300000) {
    lastConfigSync = millis();
    syncConfiguration();
  }
  
  yield();
}