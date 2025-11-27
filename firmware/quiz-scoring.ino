/*
  quiz-scoring-persistent.ino
  ESP32 dengan Persistent Connection & Stability Improvements
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

// Alamat I2C PCF8574
const uint8_t PCF_MODULE_A_C = 0x20;
const uint8_t PCF_MODULE_D_F = 0x21;
const uint8_t PCF_MODULE_G_I = 0x22;
const uint8_t PCF_MODULE_J_L = 0x23;

const uint8_t MODULE_ADDRESSES[4] = {0x20, 0x21, 0x22, 0x23};
const char* TEAM_NAMES[12] = {"A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"};

// Pin Juri
const int PIN_JURY_CORRECT = 4;
const int PIN_JURY_WRONG   = 5;

// ====== PERSISTENT CONNECTION CONFIG ======
const unsigned long HEARTBEAT_INTERVAL = 10000;           // 10 detik - heartbeat normal
const unsigned long AGGRESSIVE_HEARTBEAT_INTERVAL = 2000; // 2 detik - mode agresif
const unsigned long CONNECTION_TIMEOUT = 15000;           // 15 detik timeout

// ====== STABILITY CONFIG ======
const unsigned long WATCHDOG_INTERVAL = 60000;           // 60 detik watchdog
const unsigned long MEMORY_CHECK_INTERVAL = 30000;       // 30 detik cek memory
const unsigned long STABILITY_LOG_INTERVAL = 60000;      // 60 detik log stability

// ====== STATE VARIABLES ======
char serverHost[64];
int  serverPort = DEFAULT_SERVER_PORT;

bool lockActive = false;
int  activeTeam = 0;
unsigned long lockStartTime = 0;
unsigned long lastActivityTime = 0;

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

// ====== PERSISTENT CONNECTION VARIABLES ======
bool serverOnline = true;
unsigned long lastSuccessfulHeartbeat = 0;
unsigned long lastHeartbeatAttempt = 0;
bool aggressiveMode = false;
unsigned long lastStabilityLog = 0;
unsigned long lastMemoryCheck = 0;
unsigned long lastWatchdogCheck = 0;
unsigned long systemStartTime = 0;

// ====== WATCHDOG & STABILITY ======
void systemWatchdog() {
  unsigned long now = millis();
  
  if (now - lastWatchdogCheck >= WATCHDOG_INTERVAL) {
    lastWatchdogCheck = now;
    
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[WATCHDOG] WiFi disconnected, attempting reconnect...");
      WiFi.reconnect();
    }
    
    if (ESP.getFreeHeap() < 10000) {
      Serial.println("[WATCHDOG] Low memory, restarting ESP32...");
      ESP.restart();
    }
    
    Serial.printf("[WATCHDOG] System Uptime: %lu minutes, Free Heap: %d bytes\n", 
                  (now - systemStartTime) / 60000, ESP.getFreeHeap());
  }
}

void checkMemoryStability() {
  unsigned long now = millis();
  
  if (now - lastMemoryCheck >= MEMORY_CHECK_INTERVAL) {
    lastMemoryCheck = now;
    
    int freeHeap = ESP.getFreeHeap();
    int minHeap = ESP.getMinFreeHeap();
    
    Serial.printf("[MEMORY] Free: %d, Min: %d\n", freeHeap, minHeap);
                  
    if (freeHeap < 15000) {
      Serial.println("[MEMORY] Low memory warning");
    }
  }
}

void logSystemStability() {
  unsigned long now = millis();
  
  if (now - lastStabilityLog >= STABILITY_LOG_INTERVAL) {
    lastStabilityLog = now;
    
    Serial.printf("[STABILITY] === System Status ===\n");
    Serial.printf("[STABILITY] Uptime: %lu minutes\n", (now - systemStartTime) / 60000);
    Serial.printf("[STABILITY] Free Heap: %d bytes\n", ESP.getFreeHeap());
    Serial.printf("[STABILITY] WiFi: %s\n", WiFi.status() == WL_CONNECTED ? "Connected" : "Disconnected");
    Serial.printf("[STABILITY] Server: %s\n", serverOnline ? "ONLINE" : "OFFLINE");
    Serial.printf("[STABILITY] Mode: %s\n", aggressiveMode ? "AGGRESSIVE" : "NORMAL");
    Serial.printf("[STABILITY] Last Activity: %lu seconds ago\n", (now - lastActivityTime) / 1000);
    Serial.printf("[STABILITY] ======================\n");
  }
}

// ====== PERSISTENT HEARTBEAT SYSTEM ======
void sendPersistentHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[HEARTBEAT] WiFi disconnected, skipping heartbeat");
    serverOnline = false;
    aggressiveMode = true;
    return;
  }
  
  String url = "https://" + String(serverHost) + "/esp32checkin?action=persistent_heartbeat&team=0";
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  
  bool success = false;
  int code = 0;
  
  for (int attempt = 0; attempt < 2; attempt++) {
    if (http.begin(url)) {
      code = http.GET();
      if (code == 200) {
        success = true;
        break;
      }
      http.end();
      delay(500);
    }
  }
  
  lastHeartbeatAttempt = millis();
  
  if (success) {
    lastSuccessfulHeartbeat = millis();
    
    if (!serverOnline) {
      serverOnline = true;
      aggressiveMode = false;
      Serial.println("[HEARTBEAT] Reconnected to server!");
    }
    
    lastActivityTime = millis();
    
  } else {
    Serial.printf("[HEARTBEAT] Failed, code=%d\n", code);
    
    if (serverOnline) {
      serverOnline = false;
      aggressiveMode = true;
      Serial.println("[HEARTBEAT] Entering aggressive reconnect mode");
    }
  }
}

void checkConnectionHealth() {
  unsigned long now = millis();
  
  unsigned long heartbeatInterval = aggressiveMode ? AGGRESSIVE_HEARTBEAT_INTERVAL : HEARTBEAT_INTERVAL;
  
  if (now - lastHeartbeatAttempt >= heartbeatInterval) {
    sendPersistentHeartbeat();
  }
  
  if (serverOnline && (now - lastSuccessfulHeartbeat > CONNECTION_TIMEOUT)) {
    serverOnline = false;
    aggressiveMode = true;
    Serial.println("[CONNECTION] Connection timeout, entering aggressive mode");
  }
}

// ====== ENHANCED HTTP REQUESTS ======
bool sendEnhancedUpdateToServer(int team, int add, bool isFirst) {
  if (!serverOnline && WiFi.status() != WL_CONNECTED) {
    Serial.println("[UPDATE] Server offline, skipping update");
    return false;
  }
  
  String url = "https://" + String(serverHost) + "/update?team=" + String(team) + "&add=" + add;
  if (isFirst) url += "&first=1";
  
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  
  bool success = false;
  int code = 0;
  
  for (int attempt = 0; attempt < 3; attempt++) {
    if (http.begin(url)) {
      code = http.GET();
      if (code == 200) {
        success = true;
        break;
      }
      http.end();
      delay(300 * (attempt + 1));
    }
  }
  
  if (success) {
    lastSuccessfulHeartbeat = millis();
    lastActivityTime = millis();
    serverOnline = true;
    aggressiveMode = false;
    
    Serial.printf("[UPDATE] Team %s first=%d code=%d\n", TEAM_NAMES[team-1], isFirst, code);
  } else {
    Serial.printf("[UPDATE] Team %s failed, code=%d\n", TEAM_NAMES[team-1], code);
    serverOnline = false;
    aggressiveMode = true;
  }
  
  return success;
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
        Serial.printf("[SCAN] Module 0x%02X detected\n", MODULE_ADDRESSES[i]);
        pcfOutCache[i] = 0xFF;
        lastRead[i] = 0xFF;
        writePCF(MODULE_ADDRESSES[i], 0xFF);
      } else {
        Serial.printf("[SCAN] Module 0x%02X disconnected\n", MODULE_ADDRESSES[i]);
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

// ====== BUTTON HANDLERS ======
void pollPCFButtons() {
  unsigned long now = millis();
  
  for (int moduleIndex = 0; moduleIndex < 4; moduleIndex++) {
    if (!moduleDetected[moduleIndex]) continue;
    
    uint8_t currentState;
    if (!readPCF(MODULE_ADDRESSES[moduleIndex], currentState)) {
      moduleDetected[moduleIndex] = false;
      continue;
    }
    
    for (int team = 0; team < 12; team++) {
      const ButtonLEDMapping& mapping = TEAM_MAPPINGS[team];
      
      if (mapping.moduleAddress != MODULE_ADDRESSES[moduleIndex]) continue;
      
      bool currentlyPressed = (currentState & (1 << mapping.buttonBit)) == 0;
      bool previouslyPressed = (lastRead[moduleIndex] & (1 << mapping.buttonBit)) == 0;
      
      if (currentlyPressed && !previouslyPressed) {
        lastActivityTime = now;
        
        if (!lockActive && now - lastDebounceTime[mapping.teamNumber] > 40) {
          lastDebounceTime[mapping.teamNumber] = now;
          
          Serial.printf("[BUTTON] Team %s pressed!\n", mapping.teamName);
          
          setTeamLED(mapping.teamNumber, true);
          buttonLedActive[mapping.teamNumber-1] = true;
          buttonLedStartTime[mapping.teamNumber-1] = millis();
          
          lockActive = true;
          activeTeam = mapping.teamNumber;
          lockStartTime = now;
          lastActivityTime = now;
          
          sendEnhancedUpdateToServer(mapping.teamNumber, 0, true);
          
          clearAllLEDs();
          setTeamLED(activeTeam, true);
          buttonLedActive[activeTeam-1] = true;
          buttonLedStartTime[activeTeam-1] = millis();
        }
        
        break;
      }
    }
    
    lastRead[moduleIndex] = currentState;
  }
}

void handleJuryButtons() {
  unsigned long now = millis();
  bool corr = digitalRead(PIN_JURY_CORRECT) == LOW;
  bool wrong = digitalRead(PIN_JURY_WRONG) == LOW;

  if (corr && !lastJuryCorrectState && now - lastDebounceTime[12] > 60) {
    lastDebounceTime[12] = now;
    if (lockActive && activeTeam && activeTeam <= 12) {
      Serial.printf("[JURY] Correct for Team %s\n", TEAM_NAMES[activeTeam-1]);
      lastActivityTime = now;
      
      setTeamLED(activeTeam, false);
      delay(80);
      setTeamLED(activeTeam, true);
      buttonLedStartTime[activeTeam-1] = millis();
      
      sendEnhancedUpdateToServer(activeTeam, plusValue, false);
    }
  }
  
  if (wrong && !lastJuryWrongState && now - lastDebounceTime[13] > 60) {
    lastDebounceTime[13] = now;
    if (lockActive && activeTeam && activeTeam <= 12) {
      Serial.printf("[JURY] Wrong for Team %s\n", TEAM_NAMES[activeTeam-1]);
      lastActivityTime = now;
      
      for (int i = 0; i < 2; i++) {
        setTeamLED(activeTeam, false);
        delay(80);
        setTeamLED(activeTeam, true);
        if (i == 0) delay(40);
      }
      buttonLedStartTime[activeTeam-1] = millis();
      
      sendEnhancedUpdateToServer(activeTeam, minusValue, false);
    }
  }
  
  lastJuryCorrectState = corr;
  lastJuryWrongState   = wrong;
}

void updateButtonLEDs() {
  unsigned long now = millis();
  
  for (int team = 1; team <= 12; team++) {
    if (buttonLedActive[team-1] && (now - buttonLedStartTime[team-1] >= 500)) {
      if (!lockActive || activeTeam != team) {
        setTeamLED(team, false);
        buttonLedActive[team-1] = false;
      }
    }
  }
}

// ====== AUTO-RESET ======
void checkAutoReset() {
  unsigned long now = millis();
  
  if (lockActive) {
    if (now - lastActivityTime > 30000) {
      Serial.println("[AUTO-RESET] Timeout 30 detik, sistem di-unlock");
      unlockSystem();
    }
    
    if (now - lockStartTime > 60000) {
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
      http.setConnectTimeout(3000);
      http.setTimeout(3000);
      http.begin(url);
      http.GET();
      http.end();
    }
  }
  
  lockActive = false;
  activeTeam = 0;
  lockStartTime = 0;
  lastActivityTime = 0;
  clearAllLEDs();
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
  hostValue.replace("http://", ""); hostValue.replace("https://", "");
  strncpy(serverHost, hostValue.c_str(), sizeof(serverHost) - 1);
  serverPort = atoi(custom_server_port.getValue());
  Serial.printf("WiFi: Host=%s Port=%d\n", serverHost, serverPort);
}

// ====== SETUP ======
void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("QUIZ SCORING - PERSISTENT CONNECTION");
  Serial.println("Connection: Never disconnects unless powered off");
  Serial.println("Stability: Watchdog, Memory Management, Auto-Recovery");
  Serial.println("Performance: Optimized HTTP requests");
  
  systemStartTime = millis();
  
  Wire.begin(21, 22);
  Wire.setClock(100000);
  
  scanPCFModules();

  pinMode(PIN_JURY_CORRECT, INPUT_PULLUP);
  pinMode(PIN_JURY_WRONG, INPUT_PULLUP);
  lastJuryCorrectState = digitalRead(PIN_JURY_CORRECT);
  lastJuryWrongState   = digitalRead(PIN_JURY_WRONG);
  
  for (int i = 0; i < 14; ++i) lastDebounceTime[i] = 0;
  for (int i = 0; i < 12; i++) buttonLedActive[i] = false;

  setupWiFiManager();
  
  lastSuccessfulHeartbeat = millis();
  lastHeartbeatAttempt = millis();
  
  Serial.println("[INIT] System ready with persistent connection");
}

// ====== LOOP ======
void loop() {
  unsigned long now = millis();

  checkConnectionHealth();
  systemWatchdog();
  checkMemoryStability();
  logSystemStability();
  
  handleJuryButtons();
  pollPCFButtons();
  updateButtonLEDs();
  
  checkAutoReset();

  static unsigned long lastLockPoll = 0;
  if (now - lastLockPoll >= 1000 && serverOnline) { 
    lastLockPoll = now; 
    
    String url = "https://" + String(serverHost) + "/lockstate";
    HTTPClient http;
    http.setReuse(false);
    http.setConnectTimeout(3000);
    http.setTimeout(3000);
    if (http.begin(url)) {
      int code = http.GET();
      if (code == 200) {
        String payload = http.getString();
      }
      http.end();
    }
  }

  static unsigned long lastModuleScan = 0;
  if (now - lastModuleScan >= 3000) {
    lastModuleScan = now;
    scanPCFModules();
  }

  delay(10);
}