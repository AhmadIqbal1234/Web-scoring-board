/*
  ESP32 Quiz Buzzer System - WebSocket Version
  VERSION 4.4 - Fixed for local non-SSL server
*/

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include <WiFiManager.h>

// ========== KONFIGURASI ==========
const char* DEFAULT_SERVER_WS = "192.168.1.8";
const int   WS_PORT = 8080;
const char* WS_PATH = "/esp32ws";
const char* WIFI_AP_NAME = "Quiz_Config_WS";

// ========== PIN DEFINITION ==========
const int LED_MERAH = 33;
const int LED_HIJAU = 32;
const int PIN_JURY_CORRECT = 4;
const int PIN_JURY_WRONG = 5;

// ========== MODULE ADDRESSES ==========
const uint8_t MODULE_ADDRESSES[4] = {0x20, 0x21, 0x22, 0x23};

// ========== PROTOCOL CONSTANTS ==========
#define MSG_BUTTON_PRESS     0x01
#define MSG_HEARTBEAT        0x02
#define MSG_MODULE_STATUS    0x03
#define MSG_JURY_ACTION      0x04
#define MSG_SYSTEM_STATUS    0x05

#define MSG_LOCK_ACQUIRED    0x81
#define MSG_LOCK_DENIED      0x82
#define MSG_LOCK_RELEASED    0x83
#define MSG_TIMER_UPDATE     0x84
#define MSG_FORCE_UNLOCK     0x85
#define MSG_CONFIG_UPDATE    0x86
#define MSG_SYSTEM_RESET     0x87
#define MSG_SCORE_UPDATE     0x88

// ========== TEAM MAPPING ==========
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

// ========== GLOBAL VARIABLES ==========
WebSocketsClient webSocket;
WiFiManager wm;

unsigned long lastModuleScan = 0;
const unsigned long MODULE_SCAN_INTERVAL = 2000;
unsigned long lastWiFiCheck = 0;
const unsigned long WIFI_CHECK_INTERVAL = 5000;
unsigned long lastBroadcast = 0;
const unsigned long BROADCAST_INTERVAL = 30000;

bool moduleEnabled[4] = {false};
bool moduleDetected[4] = {false};
uint8_t enabledTeams[12] = {0};
uint8_t activeTeamCount = 0;
uint8_t detectedModules = 0;
int previousWiFiRSSI = 0;
bool moduleStateChanged = false;

struct ButtonState {
  bool isPressed;
  bool wasPressed;
  unsigned long pressStartTime;
  bool ledFeedbackActive;
  bool lockConfirmed;
  bool scored;
};

ButtonState buttonStates[12];

bool wsConnected = false;
unsigned long wsConnectTime = 0;

bool lockActive = false;
int activeTeam = 0;
bool globalButtonLock = false;
unsigned long globalLockStartTime = 0;

struct Config {
  int plusPoints = 5;
  int minusPoints = -2;
  int timerDuration = 30;
  bool autoPenalty = true;
} config;

unsigned long buttonPressCount = 0;
unsigned long heartbeatCount = 0;
int wifiRSSI = 0;

// ========== FUNCTION PROTOTYPES ==========
void setupWiFiManager();
void initializeModules();
void scanModulesRealTime();
void monitorWiFiRealTime();
bool checkModule(uint8_t addr);
bool writePCF(uint8_t addr, uint8_t value);
bool readPCF(uint8_t addr, uint8_t &value);
void setTeamLED(uint8_t team, bool on);
void clearAllLEDs();
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length);
void sendButtonPressWS(int team);
void sendHeartbeatWS(bool forceUpdate = false);
void sendModuleStatus(bool forceUpdate = false);
void handleWebSocketBinary(uint8_t *payload, size_t length);
void processButtonPress(int team);
void handleJuryButtons();
void resetLockState();

// ========== SETUP ==========
void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("\n========================================");
  Serial.println("ESP32 QUIZ BUZZER - Fixed Non-SSL v4.4");
  Serial.println("========================================");
  
  pinMode(LED_MERAH, OUTPUT);
  pinMode(LED_HIJAU, OUTPUT);
  pinMode(PIN_JURY_CORRECT, INPUT_PULLUP);
  pinMode(PIN_JURY_WRONG, INPUT_PULLUP);
  
  digitalWrite(LED_MERAH, HIGH);
  digitalWrite(LED_HIJAU, HIGH);
  delay(200);
  digitalWrite(LED_MERAH, LOW);
  digitalWrite(LED_HIJAU, LOW);
  
  Wire.begin(21, 22);
  Wire.setClock(400000);
  
  setupWiFiManager();
  initializeModules();
  
  Serial.println("\n[SETUP] Configuring WebSocket for local server (ws://)");
  Serial.printf("Server: %s:%d%s\n", DEFAULT_SERVER_WS, WS_PORT, WS_PATH);
  
  // PERBAIKAN UTAMA: gunakan begin() biasa, bukan beginSSL()
  webSocket.begin(DEFAULT_SERVER_WS, WS_PORT, WS_PATH);
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  webSocket.enableHeartbeat(15000, 3000, 2);
  
  Serial.println("[SETUP] Using plain WebSocket (ws://)");
  Serial.println("[SETUP] System ready!");
  Serial.println("========================================\n");
}

// ========== WIFI MANAGER ==========
void setupWiFiManager() {
  WiFiManagerParameter custom_ws_server("ws_server", "WebSocket Server", DEFAULT_SERVER_WS, 100);
  wm.addParameter(&custom_ws_server);
  wm.setConfigPortalTimeout(180);
  
  if (!wm.autoConnect(WIFI_AP_NAME)) {
    Serial.println("Failed to connect, restarting...");
    delay(3000);
    ESP.restart();
  }
  
  Serial.println("WiFi connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());
  wifiRSSI = WiFi.RSSI();
  Serial.print("RSSI: ");
  Serial.println(wifiRSSI);
}

// ========== MODULE FUNCTIONS (sama seperti sebelumnya) ==========
void initializeModules() {
  Serial.println("=== MODULE INITIALIZATION ===");
  for (int i = 0; i < 4; i++) {
    moduleDetected[i] = checkModule(MODULE_ADDRESSES[i]);
    moduleEnabled[i] = moduleDetected[i];
    if (moduleDetected[i]) {
      detectedModules++;
      Serial.printf("✓ Module 0x%02X detected\n", MODULE_ADDRESSES[i]);
      writePCF(MODULE_ADDRESSES[i], 0xFF);
    } else {
      Serial.printf("✗ Module 0x%02X NOT detected\n", MODULE_ADDRESSES[i]);
    }
  }
  
  activeTeamCount = 0;
  for (int i = 0; i < 12; i++) {
    int modIdx = -1;
    for (int m = 0; m < 4; m++) {
      if (MODULE_ADDRESSES[m] == TEAM_MAPPINGS[i].moduleAddress) {
        modIdx = m;
        break;
      }
    }
    if (modIdx != -1 && moduleDetected[modIdx]) {
      enabledTeams[i] = 1;
      activeTeamCount++;
    } else {
      enabledTeams[i] = 0;
    }
  }
  Serial.printf("=== SUMMARY: %d modules, %d teams active ===\n", detectedModules, activeTeamCount);
}

bool checkModule(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

bool writePCF(uint8_t addr, uint8_t value) {
  Wire.beginTransmission(addr);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readPCF(uint8_t addr, uint8_t &value) {
  Wire.requestFrom(addr, 1);
  if (Wire.available()) {
    value = Wire.read();
    return true;
  }
  return false;
}

void setTeamLED(uint8_t team, bool on) {
  if (team < 1 || team > 12) return;
  int idx = team - 1;
  const ButtonLEDMapping &mapping = TEAM_MAPPINGS[idx];
  uint8_t current;
  if (!readPCF(mapping.moduleAddress, current)) return;
  if (on) current &= ~(1 << mapping.ledBit);
  else current |= (1 << mapping.ledBit);
  writePCF(mapping.moduleAddress, current);
}

void clearAllLEDs() {
  for (int i = 0; i < 4; i++) {
    if (moduleEnabled[i]) writePCF(MODULE_ADDRESSES[i], 0xFF);
  }
  for (int i = 0; i < 12; i++) {
    buttonStates[i].ledFeedbackActive = false;
    buttonStates[i].lockConfirmed = false;
  }
}

// ========== WEBSOCKET EVENT ==========
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_CONNECTED:
      Serial.printf("[WS] Connected to server at %s%s\n", DEFAULT_SERVER_WS, WS_PATH);
      wsConnected = true;
      wsConnectTime = millis();
      digitalWrite(LED_HIJAU, HIGH);
      sendHeartbeatWS(true);
      sendModuleStatus(true);
      break;
      
    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected from server!");
      wsConnected = false;
      digitalWrite(LED_HIJAU, LOW);
      digitalWrite(LED_MERAH, LOW);
      break;
      
    case WStype_BIN:
      handleWebSocketBinary(payload, length);
      break;
      
    case WStype_ERROR:
      Serial.printf("[WS] Error: %s\n", payload);
      digitalWrite(LED_MERAH, HIGH);
      delay(200);
      digitalWrite(LED_MERAH, LOW);
      break;
  }
}

void sendButtonPressWS(int team) {
  if (!wsConnected) return;
  buttonPressCount++;
  uint8_t buffer[14];
  buffer[0] = MSG_BUTTON_PRESS;
  buffer[1] = team;
  uint32_t timestamp = millis();
  buffer[2] = (timestamp >> 24) & 0xFF;
  buffer[3] = (timestamp >> 16) & 0xFF;
  buffer[4] = (timestamp >> 8) & 0xFF;
  buffer[5] = timestamp & 0xFF;
  uint16_t sequence = buttonPressCount;
  buffer[6] = (sequence >> 8) & 0xFF;
  buffer[7] = sequence & 0xFF;
  buffer[8] = detectedModules;
  buffer[9] = activeTeamCount;
  int16_t rssi = WiFi.RSSI();
  buffer[10] = (rssi >> 8) & 0xFF;
  buffer[11] = rssi & 0xFF;
  buffer[12] = random(256);
  buffer[13] = 0;
  webSocket.sendBIN(buffer, 14);
  Serial.printf("[WS] Button press sent: Team %s, Seq %d\n", TEAM_MAPPINGS[team-1].teamName, sequence);
}

void sendHeartbeatWS(bool forceUpdate) {
  static unsigned long lastHeartbeatTime = 0;
  if (!wsConnected) return;
  unsigned long now = millis();
  if (!forceUpdate && (now - lastHeartbeatTime < 30000)) return;
  heartbeatCount++;
  uint8_t buffer[16];
  buffer[0] = MSG_HEARTBEAT;
  buffer[1] = detectedModules;
  buffer[2] = activeTeamCount;
  int16_t rssi = wifiRSSI;
  buffer[3] = (rssi >> 8) & 0xFF;
  buffer[4] = rssi & 0xFF;
  uint32_t heap = ESP.getFreeHeap();
  buffer[5] = (heap >> 24) & 0xFF;
  buffer[6] = (heap >> 16) & 0xFF;
  buffer[7] = (heap >> 8) & 0xFF;
  buffer[8] = heap & 0xFF;
  uint32_t uptime = now / 1000;
  buffer[9] = (uptime >> 24) & 0xFF;
  buffer[10] = (uptime >> 16) & 0xFF;
  buffer[11] = (uptime >> 8) & 0xFF;
  buffer[12] = uptime & 0xFF;
  buffer[13] = lockActive ? 1 : 0;
  buffer[14] = activeTeam;
  buffer[15] = moduleStateChanged ? 1 : 0;
  webSocket.sendBIN(buffer, 16);
  lastHeartbeatTime = now;
  moduleStateChanged = false;
  if (heartbeatCount % 5 == 0) {
    Serial.printf("[HEARTBEAT] #%d: %d modules, %d teams, RSSI: %d dBm\n", 
                  heartbeatCount, detectedModules, activeTeamCount, rssi);
  }
}

void sendModuleStatus(bool forceUpdate) {
  if (!wsConnected) return;
  uint8_t buffer[12];
  buffer[0] = MSG_MODULE_STATUS;
  buffer[1] = detectedModules;
  buffer[2] = activeTeamCount;
  for (int i = 0; i < 4; i++) buffer[3 + i] = moduleDetected[i] ? 0x01 : 0x00;
  int16_t rssi = WiFi.RSSI();
  buffer[7] = (rssi >> 8) & 0xFF;
  buffer[8] = rssi & 0xFF;
  uint16_t teamStatus = 0;
  for (int i = 0; i < 12; i++) if (enabledTeams[i]) teamStatus |= (1 << i);
  buffer[9] = (teamStatus >> 8) & 0xFF;
  buffer[10] = teamStatus & 0xFF;
  buffer[11] = random(256);
  webSocket.sendBIN(buffer, 12);
}

void handleWebSocketBinary(uint8_t *payload, size_t length) {
  if (length < 1) return;
  uint8_t msgType = payload[0];
  switch(msgType) {
    case MSG_LOCK_ACQUIRED:
      if (length >= 9) {
        uint8_t team = payload[1];
        uint16_t sequence = (payload[6] << 8) | payload[7];
        uint8_t timerDuration = payload[8];
        Serial.printf("[WS] Lock acquired: Team %s, Seq %d, Timer %ds\n", TEAM_MAPPINGS[team-1].teamName, sequence, timerDuration);
        lockActive = true;
        activeTeam = team;
        buttonStates[team-1].lockConfirmed = true;
        globalButtonLock = false;
        setTeamLED(team, true);
        config.timerDuration = timerDuration;
        globalLockStartTime = millis();
      }
      break;
      
    case MSG_LOCK_DENIED:
      if (length >= 5) {
        uint8_t team = payload[1];
        uint8_t reason = payload[2];
        uint8_t lockedByTeam = payload[3];
        Serial.printf("[WS] Lock denied for Team %s: Reason %d, Locked by Team %s\n", 
                     TEAM_MAPPINGS[team-1].teamName, reason, 
                     lockedByTeam > 0 ? TEAM_MAPPINGS[lockedByTeam-1].teamName : "None");
        setTeamLED(team, false);
        buttonStates[team-1].ledFeedbackActive = false;
        globalButtonLock = false;
        for (int i = 0; i < 3; i++) {
          digitalWrite(LED_MERAH, HIGH);
          delay(50);
          digitalWrite(LED_MERAH, LOW);
          delay(50);
        }
      }
      break;
      
    case MSG_LOCK_RELEASED:
      Serial.println("[WS] System unlocked");
      resetLockState();
      break;
      
    case MSG_FORCE_UNLOCK:
      Serial.println("[WS] Force unlock received");
      resetLockState();
      for (int i = 0; i < 5; i++) {
        digitalWrite(LED_MERAH, HIGH);
        digitalWrite(LED_HIJAU, LOW);
        delay(60);
        digitalWrite(LED_MERAH, LOW);
        digitalWrite(LED_HIJAU, HIGH);
        delay(60);
      }
      digitalWrite(LED_MERAH, LOW);
      digitalWrite(LED_HIJAU, wsConnected ? HIGH : LOW);
      break;
      
    case MSG_CONFIG_UPDATE:
      if (length >= 6) {
        config.plusPoints = payload[1];
        config.minusPoints = (int8_t)payload[2];
        config.timerDuration = payload[3];
        config.autoPenalty = payload[4] == 1;
        Serial.printf("[WS] Config updated: +%d, %d, Timer %d\n", config.plusPoints, config.minusPoints, config.timerDuration);
      }
      break;
      
    case MSG_SCORE_UPDATE:
      if (length >= 6) {
        uint8_t team = payload[1];
        int32_t score = (payload[2] << 24) | (payload[3] << 16) | (payload[4] << 8) | payload[5];
        Serial.printf("[WS] Score update: Team %s = %d\n", TEAM_MAPPINGS[team-1].teamName, score);
      }
      break;
      
    default:
      Serial.printf("[WS] Unknown message type: 0x%02X\n", msgType);
      break;
  }
}

void processButtonPress(int team) {
  if (team < 1 || team > 12) return;
  int idx = team - 1;
  if (enabledTeams[idx] != 1) return;
  if (globalButtonLock) {
    if (millis() - globalLockStartTime > 3000) {
      globalButtonLock = false;
    } else {
      return;
    }
  }
  if (lockActive && activeTeam != team) return;
  if (buttonStates[idx].lockConfirmed) return;
  
  globalButtonLock = true;
  globalLockStartTime = millis();
  setTeamLED(team, true);
  buttonStates[idx].ledFeedbackActive = true;
  sendButtonPressWS(team);
  Serial.printf("[BUTTON] Team %s pressed, waiting...\n", TEAM_MAPPINGS[idx].teamName);
}

void handleJuryButtons() {
  static unsigned long lastJuryPress = 0;
  static bool wifiResetMode = false;
  static unsigned long wifiResetStart = 0;
  
  bool corrPressed = digitalRead(PIN_JURY_CORRECT) == LOW;
  bool wrongPressed = digitalRead(PIN_JURY_WRONG) == LOW;
  
  if (corrPressed && wrongPressed) {
    if (!wifiResetMode) {
      wifiResetMode = true;
      wifiResetStart = millis();
      Serial.println("[RESET] WiFi reset mode - hold for 5 seconds");
      digitalWrite(LED_MERAH, HIGH);
      digitalWrite(LED_HIJAU, HIGH);
    }
    if (millis() - wifiResetStart > 5000) {
      Serial.println("[RESET] WiFi reset triggered!");
      wm.resetSettings();
      delay(1000);
      ESP.restart();
    }
    return;
  } else if (wifiResetMode) {
    wifiResetMode = false;
    digitalWrite(LED_MERAH, LOW);
    digitalWrite(LED_HIJAU, wsConnected ? HIGH : LOW);
  }
  
  unsigned long now = millis();
  if (now - lastJuryPress < 300) return;
  
  if (corrPressed && lockActive && activeTeam > 0) {
    uint8_t buffer[9];
    buffer[0] = MSG_JURY_ACTION;
    buffer[1] = activeTeam;
    buffer[2] = 1;
    buffer[3] = (config.plusPoints >> 8) & 0xFF;
    buffer[4] = config.plusPoints & 0xFF;
    uint32_t timestamp = now;
    buffer[5] = (timestamp >> 24) & 0xFF;
    buffer[6] = (timestamp >> 16) & 0xFF;
    buffer[7] = (timestamp >> 8) & 0xFF;
    buffer[8] = timestamp & 0xFF;
    if (wsConnected) {
      webSocket.sendBIN(buffer, 9);
      Serial.printf("[JURY] Correct for Team %s\n", TEAM_MAPPINGS[activeTeam-1].teamName);
    }
    lastJuryPress = now;
  }
  
  if (wrongPressed && lockActive && activeTeam > 0) {
    uint8_t buffer[9];
    buffer[0] = MSG_JURY_ACTION;
    buffer[1] = activeTeam;
    buffer[2] = 0;
    buffer[3] = (config.minusPoints >> 8) & 0xFF;
    buffer[4] = config.minusPoints & 0xFF;
    uint32_t timestamp = now;
    buffer[5] = (timestamp >> 24) & 0xFF;
    buffer[6] = (timestamp >> 16) & 0xFF;
    buffer[7] = (timestamp >> 8) & 0xFF;
    buffer[8] = timestamp & 0xFF;
    if (wsConnected) {
      webSocket.sendBIN(buffer, 9);
      Serial.printf("[JURY] Wrong for Team %s\n", TEAM_MAPPINGS[activeTeam-1].teamName);
    }
    lastJuryPress = now;
  }
}

void resetLockState() {
  lockActive = false;
  activeTeam = 0;
  globalButtonLock = false;
  for (int i = 0; i < 12; i++) {
    buttonStates[i].lockConfirmed = false;
    buttonStates[i].scored = false;
    buttonStates[i].ledFeedbackActive = false;
  }
  clearAllLEDs();
}

void scanModulesRealTime() {
  if (millis() - lastModuleScan < MODULE_SCAN_INTERVAL) return;
  lastModuleScan = millis();
  bool changed = false;
  uint8_t newDetectedModules = 0;
  for (int i = 0; i < 4; i++) {
    bool current = checkModule(MODULE_ADDRESSES[i]);
    if (moduleDetected[i] != current) {
      changed = true;
      moduleStateChanged = true;
    }
    moduleDetected[i] = current;
    if (current) newDetectedModules++;
  }
  if (changed) detectedModules = newDetectedModules;
}

void monitorWiFiRealTime() {
  if (millis() - lastWiFiCheck < WIFI_CHECK_INTERVAL) return;
  lastWiFiCheck = millis();
  int newRSSI = WiFi.RSSI();
  if (abs(newRSSI - previousWiFiRSSI) > 5) {
    wifiRSSI = newRSSI;
    previousWiFiRSSI = newRSSI;
  }
}

// ========== MAIN LOOP ==========
void loop() {
  webSocket.loop();
  
  scanModulesRealTime();
  monitorWiFiRealTime();
  sendHeartbeatWS(false);
  
  // Status LED
  if (wsConnected) {
    if (!lockActive) digitalWrite(LED_HIJAU, HIGH);
  } else {
    digitalWrite(LED_HIJAU, LOW);
    digitalWrite(LED_MERAH, (millis() % 1000 < 500) ? HIGH : LOW);
  }
  
  // Scan buttons
  for (int modIdx = 0; modIdx < 4; modIdx++) {
    if (!moduleEnabled[modIdx]) continue;
    uint8_t state;
    if (readPCF(MODULE_ADDRESSES[modIdx], state)) {
      for (int team = 0; team < 12; team++) {
        if (TEAM_MAPPINGS[team].moduleAddress != MODULE_ADDRESSES[modIdx]) continue;
        int teamIdx = team;
        uint8_t mask = (1 << TEAM_MAPPINGS[team].buttonBit);
        bool pressed = (state & mask) == 0;
        if (pressed && !buttonStates[teamIdx].isPressed) {
          buttonStates[teamIdx].isPressed = true;
          buttonStates[teamIdx].pressStartTime = millis();
          processButtonPress(TEAM_MAPPINGS[team].teamNumber);
        }
        if (!pressed && buttonStates[teamIdx].isPressed) {
          buttonStates[teamIdx].isPressed = false;
          if (!buttonStates[teamIdx].lockConfirmed) {
            setTeamLED(TEAM_MAPPINGS[team].teamNumber, false);
            buttonStates[teamIdx].ledFeedbackActive = false;
          }
        }
      }
    }
  }
  
  handleJuryButtons();
  
  unsigned long lockTimeoutMs = (unsigned long)(config.timerDuration + 10) * 1000;
  if (lockActive && (millis() - globalLockStartTime > lockTimeoutMs)) {
    Serial.printf("[TIMEOUT] Lock timeout after %d seconds\n", config.timerDuration + 10);
    resetLockState();
  }
  
  if (millis() - lastBroadcast > BROADCAST_INTERVAL) {
    lastBroadcast = millis();
    if (wsConnected) sendModuleStatus(true);
  }
  
  delay(5);
}