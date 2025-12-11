/*
  ESP32 master for Quiz Scoring system – SYNC WITH WEB TIMER
  VERSI DENGAN DETEKSI MODUL/TIM AKTIF DAN MONITORING LENGKAP
  VERSION 3.0 - RESPONSIVE BUTTONS & JURY
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
uint8_t detectedModules = 0;                           // Jumlah modul terdeteksi

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
const uint64_t BUTTON_DEBOUNCE_MS = 15;           // DIPERBAIKI: 30ms -> 15ms untuk responsivitas
const uint64_t BUTTON_LOCK_DELAY_MS = 80;         // DIPERBAIKI: 100ms -> 80ms
const uint32_t BUTTON_MIN_PRESS_MS = 15;          // DIPERBAIKI: 25ms -> 15ms

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
const unsigned long INTERRUPT_COOLDOWN_MS = 30;   // DIPERBAIKI: 50ms -> 30ms untuk responsivitas

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
#define I2C_SPEED 400000 // DIPERBAIKI: 100kHz -> 400kHz untuk responsivitas

// ====== KONFIGURASI TIMING ======
const unsigned long JURY_DEBOUNCE_MS   = 30;      // DIPERBAIKI: 150ms -> 30ms untuk responsivitas
const unsigned long LOCK_POLL_MS       = 100;
const unsigned long MODULE_SCAN_MS     = 5000;
const unsigned long BUTTON_FEEDBACK_DURATION = 80; // DIPERBAIKI: 100ms -> 80ms
const unsigned long LOCK_LED_DURATION = 0;
const unsigned long WATCHDOG_TIMEOUT   = 30000;
const unsigned long HTTP_SEND_TIMEOUT  = 5000;

// ====== PERBAIKAN: SISTEM POLLING UNTUK TIMER ======
unsigned long lastStatusCheckTime = 0;
const unsigned long STATUS_CHECK_INTERVAL = 2000;  // DIPERBAIKI: 3000ms -> 2000ms
bool pollingEnabled = true;

// ====== SISTEM HEARTBEAT ======
unsigned long lastHeartbeatTime = 0;
const unsigned long HEARTBEAT_INTERVAL = 10000;   // DIPERBAIKI: 30 detik -> 10 detik
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

// ========== VARIABEL MONITORING ==========
int wifiRSSI = 0;
unsigned long freeHeap = 0;
unsigned long systemUptime = 0;
unsigned long lastMonitoringUpdate = 0;
const unsigned long MONITORING_UPDATE_INTERVAL = 5000;  // DIPERBAIKI: 15 detik -> 5 detik

// ========== PERBAIKAN: RATE LIMITING VARIABEL ==========
unsigned long lastButtonRead = 0;
const unsigned long BUTTON_READ_INTERVAL = 5;  // DIPERBAIKI: 10ms -> 5ms (200Hz) untuk responsivitas
unsigned long lastReadTime[4] = {0, 0, 0, 0};

// ========== PERBAIKAN: JURY PRIORITY QUEUE ==========
struct JuryPress {
  bool correct;
  unsigned long timestamp;
  bool processed;
};

JuryPress juryQueue[4];
volatile uint8_t juryQueueHead = 0;
volatile uint8_t juryQueueTail = 0;
volatile uint8_t juryQueueCount = 0;

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
  delayMicroseconds(50);  // DIPERBAIKI: 100us -> 50us
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
    delayMicroseconds(50);  // DIPERBAIKI: 100us -> 50us
    return true;
  }
  
  moduleReadRetry[moduleIndex]++;
  if (moduleReadRetry[moduleIndex] > 3) {  // Kembali ke 3 untuk responsivitas
    moduleEnabled[moduleIndex] = false;
    Serial.printf("[ERROR] Modul 0x%02X gagal setelah %d retry\n", addr, moduleReadRetry[moduleIndex]);
  }
  
  return false;
}

// ====== PERBAIKAN HANDLER INTERRUPT ======
void IRAM_ATTR isrAnyModuleEngine() {
  static unsigned long lastIsrTime = 0;
  unsigned long currentTime = millis();
  
  // Debounce hardware: minimal 30ms antara interrupt
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
  detectedModules = 0;
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
      detectedModules++;
      Serial.printf("[INIT] Modul 0x%02X terdeteksi\n", MODULE_ADDRESSES[i]);
      
      pcfOutCache[i] = 0xFF;
      lastModuleState[i] = 0xFF;
      
      writePCF(MODULE_ADDRESSES[i], 0xFF);
      delay(5);  // DIPERBAIKI: 10ms -> 5ms
      
      for (int team = 0; team < 12; team++) {
        if (TEAM_MAPPINGS[team].moduleAddress == MODULE_ADDRESSES[i]) {
          enabledTeams[team] = 1;
          activeTeamCount++;
          Serial.printf("  Tim %s diaktifkan\n", TEAM_NAMES[team]);
        }
      }
    } else {
      Serial.printf("[INIT] Modul 0x%02X tidak terdeteksi\n", MODULE_ADDRESSES[i]);
    }
  }
  
  Serial.printf("[INIT] Modul terdeteksi: %d, Tim aktif: %d\n", detectedModules, activeTeamCount);
  Serial.println("===========================\n");
  
  // Kirim status inisialisasi ke server
  sendMonitoringUpdate();
}

bool isTeamEnabled(uint8_t teamNumber) {
  if (teamNumber < 1 || teamNumber > 12) return false;
  return enabledTeams[teamNumber - 1] == 1;
}

// ====== PERBAIKAN DETEKSI TOMBOL ======
void improvedButtonDetection() {
  unsigned long currentTime = millis();
  
  // Rate limiting: maksimal 1x per 5ms
  if (currentTime - lastButtonRead < BUTTON_READ_INTERVAL) return;
  lastButtonRead = currentTime;
  
  for (int i = 0; i < 4; i++) {
    if (!moduleEnabled[i]) continue;
    
    // Rate limiting per modul
    if (currentTime - lastReadTime[i] < 5) continue;  // DIPERBAIKI: 10ms -> 5ms
    lastReadTime[i] = currentTime;
    
    uint8_t currentState;
    if (!readPCF(MODULE_ADDRESSES[i], currentState)) {
      moduleReadRetry[i]++;
      if (moduleReadRetry[i] > 3) {
        moduleEnabled[i] = false;
        Serial.printf("[ERROR] Modul 0x%02X dinonaktifkan setelah %d retry\n", 
                     MODULE_ADDRESSES[i], moduleReadRetry[i]);
      }
      continue;
    }
    
    moduleReadRetry[i] = 0;  // Reset retry counter
    
    // Deteksi perubahan hanya jika ada perbedaan
    if (currentState != lastModuleState[i]) {
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
          
          if (debugEnabled) {
            Serial.printf("[BUTTON] Tim %s DITEKAN @%lu ms\n", 
                         mapping.teamName, currentTime);
          }
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
  
  // Cek apakah tim sudah ada di antrian
  for (int i = 0; i < 36; i++) {
    if (pressQueue[i].valid && !pressQueue[i].processed && pressQueue[i].team == team) {
      interrupts();
      return false;
    }
  }
  
  if (queueCount >= 36) {
    // Bersihkan entri yang sudah diproses
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
  
  // Proses lebih sering
  if (currentTime - lastQueueProcess < 5) return;  // DIPERBAIKI: 10ms -> 5ms
  lastQueueProcess = currentTime;
  
  // Skip jika sistem sedang sibuk
  if (globalButtonLock || lockActive || httpInProgress || wifiResetActive || juryButtonProcessing) {
    return;
  }
  
  TimestampedPress* earliest = NULL;
  unsigned long earliestTime = 0xFFFFFFFF;
  int earliestIndex = -1;
  
  noInterrupts();
  for (int i = 0; i < 36; ++i) {
    if (!pressQueue[i].valid || pressQueue[i].processed) continue;
    
    unsigned long pressTime = pressQueue[i].timestamp;
    
    // Tunggu minimal press time
    if (currentTime - pressTime < BUTTON_MIN_PRESS_MS) continue;
    
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
    
    // Jika tombol sudah dilepas, batalkan
    if (!buttonStates[teamIndex].isPressed) {
      noInterrupts();
      earliest->processed = true;
      earliest->valid = false;
      if (queueCount > 0) queueCount--;
      interrupts();
      
      setTeamLED(team, false);
      buttonStates[teamIndex].ledFeedbackActive = false;
      buttonStates[teamIndex].lockConfirmed = false;
      
      return;
    }
    
    // Coba dapatkan lock
    if (acquireGlobalLock(team)) {
      noInterrupts();
      earliest->processed = true;
      interrupts();
      
      Serial.printf("[QUEUE] Mengirim lock untuk Tim %s (usia: %lu ms)\n", TEAM_NAMES[team-1], ageMs);
      
      sendUpdateToServerAtomic(team);
      
    } else {
      // Coba lagi nanti
    }
  }
  
  // Bersihkan entri lama
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
      
      if (age > 2000 || pressQueue[i].processed) {  // DIPERBAIKI: 3000ms -> 2000ms
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
    return false;
  }
  
  globalButtonLock = true;
  globalLockStartTime = millis();
  pendingTeamToSend = team;
  hasPendingRequest = true;
  httpInProgress = true;
  
  return true;
}

void releaseGlobalLock() {
  globalButtonLock = false;
  hasPendingRequest = false;
  pendingTeamToSend = 0;
  httpInProgress = false;
}

// ====== FUNGSI RESET STATE LOCK ======
void resetLockState() {
  lockActive = false;
  activeTeam = 0;
  
  for (int i = 0; i < 12; i++) {
    buttonStates[i].lockConfirmed = false;
    buttonStates[i].scored = false;
    buttonStates[i].ledFeedbackActive = false;
  }
  
  clearAllLEDs();
  
  globalButtonLock = false;
  hasPendingRequest = false;
  httpInProgress = false;
  
  Serial.println("[LOCK] Lock berhasil direset");
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
  
  writePCF(mapping.moduleAddress, currentState);
}

void clearAllLEDs() {
  for (int i = 0; i < 4; i++) {
    if (moduleEnabled[i]) {
      pcfOutCache[i] = 0xFF;
      writePCF(MODULE_ADDRESSES[i], pcfOutCache[i]);
    }
  }
  
  for (int i = 0; i < 12; i++) {
    buttonStates[i].ledFeedbackActive = false;
    buttonStates[i].lockConfirmed = false;
  }
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

// ====== PERBAIKAN: SISTEM POLLING UNTUK CEK STATUS DARI SERVER ======
void checkTimerStatusFromServer() {
  if (!pollingEnabled) return;
  
  unsigned long currentTime = millis();
  if (currentTime - lastStatusCheckTime < STATUS_CHECK_INTERVAL) return;
  
  lastStatusCheckTime = currentTime;
  
  // HANYA polling jika benar-benar ada lock aktif
  if (!lockActive || activeTeam == 0) {
    return;
  }
  
  // Pastikan sudah cukup lama lock aktif sebelum polling
  if (currentTime - globalLockStartTime < 3000) {  // DIPERBAIKI: 5000ms -> 3000ms
    return;
  }
  
  if (WiFi.status() != WL_CONNECTED) {
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
    
    http.end();
    
    // HANYA proses jika response 200 OK
    if (code == 200) {
      DynamicJsonDocument doc(256);
      DeserializationError error = deserializeJson(doc, response);
      
      if (!error) {
        bool timerActive = doc["timerActive"];
        bool lockStatus = doc["lockActive"];
        
        // HANYA unlock jika server konfirmasi timer habis DAN lock tidak aktif
        if (!timerActive && !lockStatus) {
          Serial.printf("[POLL] Timer habis untuk Tim %s! Melepas lock...\n", TEAM_NAMES[activeTeam-1]);
          
          // Reset semua state
          resetLockState();
        }
      }
    }
  }
}

// ====== FUNGSI HEARTBEAT DENGAN DATA MONITORING LENGKAP ======
void sendHeartbeatToServer() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }
  
  // Update data monitoring
  wifiRSSI = WiFi.RSSI();
  freeHeap = ESP.getFreeHeap();
  systemUptime = millis() / 1000;
  
  // Kirim data monitoring lengkap
  String url = "https://" + String(serverHost) + "/esp32checkin?" 
               "action=heartbeat&"
               "count=" + String(heartbeatCount) + "&"
               "teams=" + String(activeTeamCount) + "&"
               "modules=" + String(detectedModules) + "&"
               "rssi=" + String(wifiRSSI) + "&"
               "uptime=" + String(systemUptime) + "&"
               "heap=" + String(freeHeap) + "&"
               "lock=" + String(lockActive ? 1 : 0) + "&"
               "activeTeam=" + String(activeTeam);
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(2000);
  http.setTimeout(2000);
  
  if (http.begin(url)) {
    int code = http.GET();
    http.end();
    
    if (code == 200) {
      heartbeatCount++;
    }
  }
}

// ====== FUNGSI UNTUK MENGIRIM UPDATE MONITORING ======
void sendMonitoringUpdate() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }
  
  wifiRSSI = WiFi.RSSI();
  freeHeap = ESP.getFreeHeap();
  systemUptime = millis() / 1000;
  
  // Hitung ulang tim aktif (realtime)
  uint8_t realActiveTeams = 0;
  for (int i = 0; i < 12; i++) {
    if (enabledTeams[i] == 1) realActiveTeams++;
  }
  
  activeTeamCount = realActiveTeams;
  
  String url = "https://" + String(serverHost) + "/esp32status?" 
               "modules=" + String(detectedModules) + "&"
               "activeTeams=" + String(activeTeamCount) + "&"
               "rssi=" + String(wifiRSSI) + "&"
               "heap=" + String(freeHeap) + "&"
               "uptime=" + String(systemUptime) + "&"
               "lock=" + String(lockActive ? 1 : 0) + "&"
               "activeTeam=" + String(activeTeam) + "&"
               "timestamp=" + String(millis());
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(2000);
  http.setTimeout(2000);
  
  if (http.begin(url)) {
    int code = http.GET();
    String response = http.getString();
    http.end();
    
    if (debugEnabled && code == 200) {
      Serial.printf("[MONITOR] Update sent: Modul=%d, Tim=%d, RSSI=%d\n", 
                   detectedModules, activeTeamCount, wifiRSSI);
    }
  }
}

// ========== SINCRONISASI KONFIGURASI DARI SERVER ==========
void syncConfiguration() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  String url = "https://" + String(serverHost) + "/config";
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(2000);
  http.setTimeout(2000);
  
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
        }
        
        if (newPlus != config.plusPoints) {
          config.plusPoints = newPlus;
          plusValue = config.plusPoints;
        }
        
        if (newMinus != config.minusPoints) {
          config.minusPoints = newMinus;
          minusValue = config.minusPoints;
        }
      }
    }
    http.end();
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
    }
    bothPressedLastState = false;
    return;
  }

  if (bothPressed && !bothPressedLastState) {
    wifiResetActive = true;
    wifiResetStartTime = millis();
    wifiResetTriggered = false;
    
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
  
  delay(1000);
  
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
      
      WiFi.disconnect();
      delay(200);
      WiFi.reconnect();
      delay(500);
    } else {
      wifiRSSI = WiFi.RSSI();
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
          pcfOutCache[i] = 0xFF;
          lastModuleState[i] = 0xFF;
          writePCF(MODULE_ADDRESSES[i], 0xFF);
          delay(5);
          
          for (int team = 0; team < 12; team++) {
            if (TEAM_MAPPINGS[team].moduleAddress == MODULE_ADDRESSES[i]) {
              enabledTeams[team] = 1;
              newActiveTeamCount++;
            }
          }
          newDetectedModules++;
        } else {
          for (int team = 0; team < 12; team++) {
            if (TEAM_MAPPINGS[team].moduleAddress == MODULE_ADDRESSES[i]) {
              enabledTeams[team] = 0;
            }
          }
        }
      } else if (currentlyDetected) {
        newDetectedModules++;
        for (int team = 0; team < 12; team++) {
          if (TEAM_MAPPINGS[team].moduleAddress == MODULE_ADDRESSES[i] && enabledTeams[team] == 1) {
            newActiveTeamCount++;
          }
        }
      }
    }
    
    if (anyChange) {
      detectedModules = newDetectedModules;
      activeTeamCount = newActiveTeamCount;
      
      // Kirim update monitoring segera setelah perubahan
      sendMonitoringUpdate();
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
  
  // Debounce langsung di sini untuk responsivitas maksimal
  unsigned long now = millis();
  
  // Tombol Correct ditekan
  if (corrPressed && !lastJuryCorrectState) {
    if (now - lastJuryPressTime >= JURY_DEBOUNCE_MS) {
      Serial.println("[JURY] 🟢 Tombol BENAR ditekan!");
      handleJuryButtonAction(true);
      lastJuryPressTime = now;
    }
  }
  
  // Tombol Wrong ditekan
  if (wrongPressed && !lastJuryWrongState) {
    if (now - lastJuryPressTime >= JURY_DEBOUNCE_MS) {
      Serial.println("[JURY] 🔴 Tombol SALAH ditekan!");
      handleJuryButtonAction(false);
      lastJuryPressTime = now;
    }
  }
  
  lastJuryCorrectState = corrPressed;
  lastJuryWrongState = wrongPressed;
}

void handleJuryButtonAction(bool isCorrect) {
  if (lockActive && activeTeam > 0 && activeTeam <= 12) {
    // Ada tim aktif yang terkunci, langsung proses
    processJuryActionForTeam(activeTeam, isCorrect);
  } else {
    // Cari tim yang sedang aktif
    int teamToScore = 0;
    
    // Prioritas 1: Tim dengan lockConfirmed
    for (int i = 0; i < 12; i++) {
      if (buttonStates[i].lockConfirmed) {
        teamToScore = i + 1;
        break;
      }
    }
    
    // Prioritas 2: Tim dengan LED feedback aktif
    if (teamToScore == 0) {
      for (int i = 0; i < 12; i++) {
        if (buttonStates[i].ledFeedbackActive) {
          teamToScore = i + 1;
          break;
        }
      }
    }
    
    if (teamToScore > 0) {
      processJuryActionForTeam(teamToScore, isCorrect);
    } else {
      Serial.println("[JURY] ❌ ERROR: Tidak ada tim aktif untuk diberi skor!");
      
      // Feedback error
      for (int i = 0; i < 3; i++) {
        digitalWrite(LED_MERAH, HIGH);
        delay(50);
        digitalWrite(LED_MERAH, LOW);
        delay(50);
      }
    }
  }
}

void processJuryActionForTeam(int team, bool isCorrect) {
  juryButtonProcessing = true;
  
  int points = isCorrect ? plusValue : minusValue;
  const char* action = isCorrect ? "BENAR" : "SALAH";
  
  Serial.printf("[JURY] Memberi skor %d untuk Tim %s (%s)\n", 
                points, TEAM_NAMES[team-1], action);
  
  // Feedback LED langsung
  if (isCorrect) {
    for (int i = 0; i < 2; i++) {
      digitalWrite(LED_HIJAU, HIGH);
      delay(80);
      digitalWrite(LED_HIJAU, LOW);
      if (i < 1) delay(50);
    }
  } else {
    for (int i = 0; i < 2; i++) {
      digitalWrite(LED_MERAH, HIGH);
      delay(80);
      digitalWrite(LED_MERAH, LOW);
      if (i < 1) delay(50);
    }
  }
  
  // Kirim ke server (async)
  sendJuryUpdateToServer(team, points, action);
  
  // Reset state
  juryButtonProcessing = false;
}

// ====== PERBAIKAN PENGIRIMAN KE SERVER ======
void sendUpdateToServerAtomic(int team) {
  if (WiFi.status() != WL_CONNECTED) {
    lockActive = false;
    activeTeam = 0;
    buttonStates[team-1].lockConfirmed = false;
    clearAllLEDs();
    releaseGlobalLock();
    return;
  }
  
  wifiRSSI = WiFi.RSSI();
  
  String url = "https://" + String(serverHost) + "/update?team=" + 
               String(team) + "&add=0&first=1&_t=" + String(millis()) +
               "&modules=" + String(detectedModules) + 
               "&teams=" + String(activeTeamCount) + 
               "&rssi=" + String(wifiRSSI);
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(3000);
  http.setTimeout(3000);
  
  bool success = false;
  
  if (http.begin(url)) {
    int code = http.GET();
    
    if (code == 200) {
      success = true;
      
      // Feedback LED hijau cepat
      digitalWrite(LED_HIJAU, HIGH);
      delay(50);
      digitalWrite(LED_HIJAU, LOW);
      
    } else {
      // Coba sekali lagi
      delay(50);
      code = http.GET();
      if (code == 200) {
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
    
    setTeamLED(team, true);
    
    lastStatusCheckTime = millis();
    
  } else {
    lockActive = false;
    activeTeam = 0;
    buttonStates[team-1].lockConfirmed = false;
    clearAllLEDs();
    releaseGlobalLock();
    
    // Feedback error cepat
    for (int i = 0; i < 2; i++) {
      digitalWrite(LED_MERAH, HIGH);
      delay(50);
      digitalWrite(LED_MERAH, LOW);
      delay(50);
    }
  }
}

void sendJuryUpdateToServer(int team, int add, const char *action) {
  if (team < 1 || team > 12) {
    return;
  }
  
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }
  
  int teamIdx = team - 1;
  if (buttonStates[teamIdx].scored) {
    Serial.printf("[JURY] Tim %s sudah discore sebelumnya, skipping\n", TEAM_NAMES[teamIdx]);
    return;
  }
  
  wifiRSSI = WiFi.RSSI();
  
  String url = "https://" + String(serverHost) + "/update?team=" + 
               String(team) + "&add=" + String(add) + 
               "&modules=" + String(detectedModules) + 
               "&teams=" + String(activeTeamCount) + 
               "&rssi=" + String(wifiRSSI);
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(3000);
  http.setTimeout(3000);
  
  if (http.begin(url)) {
    int code = http.GET();
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
      
    } else {
      Serial.printf("[JURY] ❌ ERROR: Gagal mengirim skor (kode: %d)\n", code);
    }
  }
}

// ====== HANDLE REQUEST PENDING ======
void handlePendingRequests() {
  // Tidak perlu delay, proses segera
}

// ====== WiFi & KONFIGURASI ======
WiFiManagerParameter custom_server_host("host", "Host server", DEFAULT_SERVER_HOST, 64);
WiFiManagerParameter custom_server_port("port", "Port", "443", 6);

void setupWiFiManager() {
  WiFiManager wm;
  wm.setConnectTimeout(20);
  wm.setConfigPortalTimeout(120);
  wm.addParameter(&custom_server_host);
  wm.addParameter(&custom_server_port);
  
  if (!wm.autoConnect(WIFI_AP_NAME)) {
    ESP.restart();
  }
  
  String hostValue = custom_server_host.getValue();
  hostValue.replace("http://", ""); 
  hostValue.replace("https://", "");
  strncpy(serverHost, hostValue.c_str(), sizeof(serverHost) - 1);
  serverPort = atoi(custom_server_port.getValue());
}

// ====== SETUP ======
void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("\n========================================");
  Serial.println("SISTEM SKOR KUIS - RESPONSIVE BUTTONS v3.0");
  Serial.println("RESPONSIVITAS MAKSIMAL UNTUK TOMBOL TIM & JURI");
  Serial.println("========================================");
  
  pinMode(LED_MERAH, OUTPUT);
  pinMode(LED_HIJAU, OUTPUT);
  digitalWrite(LED_MERAH, LOW);
  digitalWrite(LED_HIJAU, LOW);
  
  // Test LED cepat
  digitalWrite(LED_MERAH, HIGH);
  delay(200);
  digitalWrite(LED_MERAH, LOW);
  digitalWrite(LED_HIJAU, HIGH);
  delay(200);
  digitalWrite(LED_HIJAU, LOW);
  
  pinMode(PIN_JURY_CORRECT, INPUT_PULLUP);
  pinMode(PIN_JURY_WRONG, INPUT_PULLUP);
  
  // Test tombol juri cepat
  Serial.println("[SETUP] Testing tombol juri (cepat)...");
  unsigned long start = millis();
  while (millis() - start < 2000) {
    if (digitalRead(PIN_JURY_CORRECT) == LOW) {
      Serial.println("[SETUP] ✅ Tombol BENAR berfungsi!");
      digitalWrite(LED_HIJAU, HIGH);
      delay(100);
      digitalWrite(LED_HIJAU, LOW);
      break;
    }
    delay(5);
  }
  
  start = millis();
  while (millis() - start < 2000) {
    if (digitalRead(PIN_JURY_WRONG) == LOW) {
      Serial.println("[SETUP] ✅ Tombol SALAH berfungsi!");
      digitalWrite(LED_MERAH, HIGH);
      delay(100);
      digitalWrite(LED_MERAH, LOW);
      break;
    }
    delay(5);
  }
  
  Serial.println("\nPERBAIKAN RESPONSIVITAS:");
  Serial.println("  1. I2C Speed: 400kHz (dari 100kHz)");
  Serial.println("  2. Button Debounce: 15ms (dari 30ms)");
  Serial.println("  3. Jury Debounce: 30ms (dari 150ms)");
  Serial.println("  4. Button Read Interval: 5ms (200Hz)");
  Serial.println("  5. Minimal Press Time: 15ms");
  Serial.println("  6. LED Feedback: 80ms (dari 100ms)");
  Serial.println("  7. Interrupt Cooldown: 30ms");
  Serial.println("  8. Polling Interval: 2 detik");
  Serial.println("  9. Heartbeat Interval: 10 detik");
  Serial.println("  10. Monitoring Interval: 5 detik");
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
  
  Serial.println("\n[SETUP] Sistem siap dengan responsivitas maksimal!");
  Serial.printf("[SETUP] Modul: %d/%d, Tim: %d/%d, RSSI: %d dBm\n", 
                detectedModules, 4, activeTeamCount, 12, WiFi.RSSI());
  Serial.println("========================================\n");
  
  // Test LED tim cepat
  Serial.println("[TEST] Menguji LED tim (cepat)...");
  for (int team = 1; team <= 12; team++) {
    if (isTeamEnabled(team)) {
      setTeamLED(team, true);
      delay(80);
      setTeamLED(team, false);
      delay(30);
    }
  }
  Serial.println("[TEST] Uji LED selesai\n");
}

// ====== LOOP UTAMA ======
void loop() {
  // Handle WiFi reset
  handleWifiReset();
  
  if (wifiResetActive) {
    unsigned long elapsed = millis() - wifiResetStartTime;
    
    // Blink cepat untuk feedback
    if (millis() % 150 < 75) {
      digitalWrite(LED_MERAH, HIGH);
      digitalWrite(LED_HIJAU, HIGH);
    } else {
      digitalWrite(LED_MERAH, LOW);
      digitalWrite(LED_HIJAU, LOW);
    }
    
    return;
  }
  
  // Update status LED
  updateStatusLED();
  
  // PROSES UTAMA DENGAN PRIORITAS TINGGI:
  
  // 1. Deteksi tombol tim (sangat sering)
  improvedButtonDetection();
  
  // 2. Proses antrian tombol tim
  processPressQueue();
  
  // 3. Handle tombol juri (prioritas tinggi)
  handleJuryButtons();
  
  // 4. Update LED
  updateButtonLEDs();
  
  // 5. Check timer dari server
  checkTimerStatusFromServer();
  
  // PROSES BACKGROUND (kurang sering):
  static unsigned long lastBackgroundCheck = 0;
  if (millis() - lastBackgroundCheck >= 300) {  // Setiap 300ms
    lastBackgroundCheck = millis();
    
    // Handle pending requests
    handlePendingRequests();
    
    // Check WiFi dan modul
    checkWiFiConnection();
    checkModuleHealth();
  }
  
  // Heartbeat ke server (setiap 10 detik)
  if (millis() - lastHeartbeatTime >= HEARTBEAT_INTERVAL) {
    lastHeartbeatTime = millis();
    sendHeartbeatToServer();
  }
  
  // Monitoring update (setiap 5 detik)
  static unsigned long lastMonitoringSend = 0;
  if (millis() - lastMonitoringSend >= MONITORING_UPDATE_INTERVAL) {
    lastMonitoringSend = millis();
    sendMonitoringUpdate();
  }
  
  // Safety check (setiap 30 detik)
  static unsigned long lastSafetyCheck = 0;
  if (millis() - lastSafetyCheck > 30000) {
    lastSafetyCheck = millis();
    
    if (lockActive && (millis() - globalLockStartTime > 90000)) {  // 90 detik
      resetSystemState();
      clearAllLEDs();
    }
  }
  
  // Sync config (setiap 5 menit)
  static unsigned long lastConfigSync = 0;
  if (millis() - lastConfigSync > 300000) {
    lastConfigSync = millis();
    syncConfiguration();
  }
  
  // BERI WAKTU SEDIKIT UNTUK TASK LAIN
  delay(1);
  yield();
}