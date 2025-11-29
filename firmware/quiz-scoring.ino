/* quiz-scoring-persistent.ino ESP32 dengan Reset Sinkron Timer Web */
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>

// ========== KONFIGURASI ==========
const char *DEFAULT_SERVER_HOST = "web-scoring-board-production.up.railway.app";
const int DEFAULT_SERVER_PORT = 443;
const char *WIFI_AP_NAME = "Quiz_Config";

// Alamat I2C PCF8574
const uint8_t MODULE_ADDRESSES[4] = {0x20, 0x21, 0x22, 0x23};
const char* TEAM_NAMES[12] = {"A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"};

// Pin Juri
const int PIN_JURY_CORRECT = 4;
const int PIN_JURY_WRONG = 5;

// ====== TIMING CONFIG ======
const unsigned long HEARTBEAT_INTERVAL = 15000;
const unsigned long AUTO_RESET_TIMEOUT = 30000;
const unsigned long FORCE_RESET_TIMEOUT = 60000;
const unsigned long JURY_DEBOUNCE = 800;

// ====== STATE VARIABLES ======
char serverHost[64];
int serverPort = DEFAULT_SERVER_PORT;
bool lockActive = false;
int activeTeam = 0;
unsigned long lockStartTime = 0;
unsigned long lastActivityTime = 0;

// Module management
bool moduleDetected[4] = {false, false, false, false};
uint8_t pcfOutCache[4];
uint8_t lastRead[4];
unsigned long lastDebounceTime[14];
bool lastJuryCorrectState = HIGH;
bool lastJuryWrongState = HIGH;
int plusValue = 5;
int minusValue = -2;

// Button LED feedback
bool buttonLedActive[12] = {false};

// ====== PERSISTENT CONNECTION VARIABLES ======
bool serverOnline = true;
unsigned long lastSuccessfulHeartbeat = 0;
unsigned long lastHeartbeatAttempt = 0;
bool aggressiveMode = false;
unsigned long systemStartTime = 0;

// ====== PERFORMANCE OPTIMIZATION ======
unsigned long lastButtonPoll = 0;
const unsigned long BUTTON_POLL_INTERVAL = 15;
unsigned long lastJuryPoll = 0;
const unsigned long JURY_POLL_INTERVAL = 20;

// ====== TIMER SYNC VARIABLES ======
unsigned long lastTimerCheck = 0;
const unsigned long TIMER_CHECK_INTERVAL = 300; // Cek timer setiap 300ms
bool wasTimerRunning = false;
unsigned long lastServerTime = 0;

// ====== BUTTON & LED MAPPING ======
struct ButtonLEDMapping {
  uint8_t moduleAddress;
  uint8_t buttonBit;
  uint8_t ledBit;
  uint8_t teamNumber;
  const char* teamName;
};

const ButtonLEDMapping TEAM_MAPPINGS[12] = {
  {0x20, 0, 3, 1, "A"}, {0x20, 1, 4, 2, "B"}, {0x20, 2, 5, 3, "C"},
  {0x21, 0, 3, 4, "D"}, {0x21, 1, 4, 5, "E"}, {0x21, 2, 5, 6, "F"},
  {0x22, 0, 3, 7, "G"}, {0x22, 1, 4, 8, "H"}, {0x22, 2, 5, 9, "I"},
  {0x23, 0, 3, 10, "J"}, {0x23, 1, 4, 11, "K"}, {0x23, 2, 5, 12, "L"}
};

// ====== WATCHDOG & STABILITY ======
void systemWatchdog() {
  unsigned long now = millis();
  static unsigned long lastWatchdogCheck = 0;
  
  if (now - lastWatchdogCheck >= 60000) {
    lastWatchdogCheck = now;
    if (WiFi.status() != WL_CONNECTED) {
      WiFi.reconnect();
    }
  }
}

// ====== PERSISTENT HEARTBEAT SYSTEM ======
void sendPersistentHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) {
    serverOnline = false;
    aggressiveMode = true;
    return;
  }

  String url = "https://" + String(serverHost) + "/esp32checkin?action=heartbeat&team=0";
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(3000);
  http.setTimeout(3000);

  if (http.begin(url)) {
    int code = http.GET();
    http.end();
    
    if (code == 200) {
      lastSuccessfulHeartbeat = millis();
      serverOnline = true;
      aggressiveMode = false;
    } else {
      serverOnline = false;
      aggressiveMode = true;
    }
  }
  
  lastHeartbeatAttempt = millis();
}

void checkConnectionHealth() {
  unsigned long now = millis();
  unsigned long heartbeatInterval = aggressiveMode ? 2000 : HEARTBEAT_INTERVAL;
  
  if (now - lastHeartbeatAttempt >= heartbeatInterval) {
    sendPersistentHeartbeat();
  }
}

// ====== ENHANCED HTTP REQUESTS ======
void sendAsyncUpdateToServer(int team, int add, bool isFirst) {
  if (!serverOnline && WiFi.status() != WL_CONNECTED) {
    return;
  }

  String url = "https://" + String(serverHost) + "/update?team=" + String(team) + "&add=" + add;
  if (isFirst) url += "&first=1";

  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(1500);
  http.setTimeout(1500);
  
  if (http.begin(url)) {
    http.GET();
    http.end();
  }
  
  lastSuccessfulHeartbeat = millis();
  lastActivityTime = millis();
}

// ====== MODULE FUNCTIONS ======
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
        pcfOutCache[i] = 0xFF;
        lastRead[i] = 0xFF;
        writePCF(MODULE_ADDRESSES[i], 0xFF);
      }
    }
  }
}

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

// ====== BUTTON & LED FUNCTIONS ======
void setTeamLED(uint8_t teamNumber, bool on) {
  if (teamNumber < 1 || teamNumber > 12) return;

  const ButtonLEDMapping& mapping = TEAM_MAPPINGS[teamNumber - 1];
  int moduleIndex = -1;
  for (int i = 0; i < 4; i++) {
    if (MODULE_ADDRESSES[i] == mapping.moduleAddress) {
      moduleIndex = i;
      break;
    }
  }

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

// ====== BUTTON HANDLERS - OPTIMIZED ======
void pollPCFButtons() {
  unsigned long now = millis();
  
  if (now - lastButtonPoll < BUTTON_POLL_INTERVAL) {
    return;
  }
  lastButtonPoll = now;

  for (int moduleIndex = 0; moduleIndex < 4; moduleIndex++) {
    if (!moduleDetected[moduleIndex]) continue;

    uint8_t currentState;
    if (!readPCF(MODULE_ADDRESSES[moduleIndex], currentState)) {
      moduleDetected[moduleIndex] = false;
      continue;
    }

    if (currentState != lastRead[moduleIndex]) {
      for (int team = 0; team < 12; team++) {
        const ButtonLEDMapping& mapping = TEAM_MAPPINGS[team];
        if (mapping.moduleAddress != MODULE_ADDRESSES[moduleIndex]) continue;

        bool currentlyPressed = (currentState & (1 << mapping.buttonBit)) == 0;
        bool previouslyPressed = (lastRead[moduleIndex] & (1 << mapping.buttonBit)) == 0;

        if (currentlyPressed && !previouslyPressed && now - lastDebounceTime[mapping.teamNumber] > 10) {
          lastDebounceTime[mapping.teamNumber] = now;
          
          if (!lockActive) {
            Serial.printf("[BUTTON] Team %s pressed - INSTANT!\n", mapping.teamName);
            
            clearAllLEDs();
            setTeamLED(mapping.teamNumber, true);
            buttonLedActive[mapping.teamNumber-1] = true;

            lockActive = true;
            activeTeam = mapping.teamNumber;
            lockStartTime = now;
            lastActivityTime = now;

            sendAsyncUpdateToServer(mapping.teamNumber, 0, true);
          }
          break;
        }
      }
      lastRead[moduleIndex] = currentState;
    }
  }
}

void handleJuryButtons() {
  unsigned long now = millis();
  
  if (now - lastJuryPoll < JURY_POLL_INTERVAL) {
    return;
  }
  lastJuryPoll = now;

  bool corr = digitalRead(PIN_JURY_CORRECT) == LOW;
  bool wrong = digitalRead(PIN_JURY_WRONG) == LOW;

  if (corr && !lastJuryCorrectState && now - lastDebounceTime[12] > JURY_DEBOUNCE) {
    lastDebounceTime[12] = now;
    if (lockActive && activeTeam && activeTeam <= 12) {
      Serial.printf("[JURY] Correct for Team %s - INSTANT RESET\n", TEAM_NAMES[activeTeam-1]);
      
      sendAsyncUpdateToServer(activeTeam, plusValue, false);
      unlockSystem();
    }
  }

  if (wrong && !lastJuryWrongState && now - lastDebounceTime[13] > JURY_DEBOUNCE) {
    lastDebounceTime[13] = now;
    if (lockActive && activeTeam && activeTeam <= 12) {
      Serial.printf("[JURY] Wrong for Team %s - INSTANT RESET\n", TEAM_NAMES[activeTeam-1]);
      
      sendAsyncUpdateToServer(activeTeam, minusValue, false);
      unlockSystem();
    }
  }

  lastJuryCorrectState = corr;
  lastJuryWrongState = wrong;
}

// ====== TIMER SYNC FUNCTIONS ======
void checkTimerState() {
  if (!serverOnline) return;
  
  unsigned long now = millis();
  if (now - lastTimerCheck < TIMER_CHECK_INTERVAL) {
    return;
  }
  lastTimerCheck = now;

  String url = "https://" + String(serverHost) + "/timerstate";
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(2000);
  http.setTimeout(2000);
  
  if (http.begin(url)) {
    int code = http.GET();
    if (code == 200) {
      String payload = http.getString();
      payload.trim();
      
      // Debug logging
      if (now - lastServerTime > 5000) {
        Serial.printf("[TIMER] Server response: %s\n", payload.c_str());
        lastServerTime = now;
      }
      
      // Cek jika timer habis (0 atau finished)
      if (payload == "0" || payload == "finished" || payload == "expired" || payload.toInt() == 0) {
        if (lockActive) {
          Serial.println("[TIMER SYNC] Timer web habis - RESET OTOMATIS");
          unlockSystem();
        }
        wasTimerRunning = false;
      } 
      else if (payload.toInt() > 0) {
        wasTimerRunning = true;
      }
    }
    http.end();
  }
}

// ====== AUTO-RESET ======
void checkAutoReset() {
  unsigned long now = millis();
  
  if (lockActive) {
    if (now - lastActivityTime > AUTO_RESET_TIMEOUT) {
      Serial.println("[AUTO-RESET] Timeout 30 detik");
      unlockSystem();
    }
    else if (now - lockStartTime > FORCE_RESET_TIMEOUT) {
      Serial.println("[FORCE-RESET] Force reset setelah 60 detik");
      unlockSystem();
    }
  }
}

void unlockSystem() {
  if (lockActive) {
    Serial.printf("[UNLOCK] Membuka kunci dari Team %s\n", TEAM_NAMES[activeTeam-1]);
    
    if (serverOnline) {
      String url = "https://" + String(serverHost) + "/update?team=" + String(activeTeam) + "&add=0&unlock=1";
      HTTPClient http;
      http.setReuse(false);
      http.setConnectTimeout(1000);
      http.setTimeout(1000);
      http.begin(url);
      http.GET();
      http.end();
    }
  }
  
  lockActive = false;
  activeTeam = 0;
  lockStartTime = 0;
  lastActivityTime = millis();
  
  clearAllLEDs();
}

// ====== SERVER SYNC ======
void checkServerLockState() {
  if (!serverOnline) return;
  
  String url = "https://" + String(serverHost) + "/lockstate";
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(1000);
  http.setTimeout(1000);
  
  if (http.begin(url)) {
    int code = http.GET();
    if (code == 200) {
      String payload = http.getString();
      payload.trim();
      if (payload.indexOf("unlock") >= 0 && lockActive) {
        Serial.println("[SERVER] Received unlock command from server");
        unlockSystem();
      }
    }
    http.end();
  }
}

// ====== WIFI MANAGER ======
WiFiManagerParameter custom_server_host("host", "Server host", DEFAULT_SERVER_HOST, 64);
WiFiManagerParameter custom_server_port("port", "Port", "443", 6);

void setupWiFiManager() {
  WiFiManager wm;
  wm.setConnectTimeout(30);
  wm.setConfigPortalTimeout(180);
  wm.addParameter(&custom_server_host);
  wm.addParameter(&custom_server_port);

  if (!wm.autoConnect(WIFI_AP_NAME)) ESP.restart();

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
  Serial.println("QUIZ SCORING - RESET SINKRON DENGAN TIMER WEB");

  systemStartTime = millis();

  Wire.begin(21, 22);
  Wire.setClock(400000);
  scanPCFModules();

  pinMode(PIN_JURY_CORRECT, INPUT_PULLUP);
  pinMode(PIN_JURY_WRONG, INPUT_PULLUP);
  lastJuryCorrectState = digitalRead(PIN_JURY_CORRECT);
  lastJuryWrongState = digitalRead(PIN_JURY_WRONG);

  for (int i = 0; i < 14; ++i) lastDebounceTime[i] = 0;
  for (int i = 0; i < 12; i++) buttonLedActive[i] = false;

  setupWiFiManager();

  lastSuccessfulHeartbeat = millis();
  lastHeartbeatAttempt = millis();

  Serial.println("[INIT] System ready with web timer sync");
}

// ====== LOOP - OPTIMIZED ======
void loop() {
  unsigned long now = millis();

  static unsigned long lastHealthCheck = 0;
  if (now - lastHealthCheck >= 2000) {
    lastHealthCheck = now;
    checkConnectionHealth();
    systemWatchdog();
  }

  pollPCFButtons();
  handleJuryButtons();
  checkAutoReset();
  
  // CEK TIMER STATE - PRIORITAS TINGGI untuk sinkronisasi
  checkTimerState();

  static unsigned long lastLockPoll = 0;
  if (now - lastLockPoll >= 800) {
    lastLockPoll = now;
    checkServerLockState();
  }

  static unsigned long lastModuleScan = 0;
  if (now - lastModuleScan >= 5000) {
    lastModuleScan = now;
    scanPCFModules();
  }

  delay(2);
}