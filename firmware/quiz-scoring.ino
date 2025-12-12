/*
  ESP32 Quiz Buzzer System - WebSocket Version
  VERSION 4.0 - WebSocket Protocol with Binary Messages
  Optimized for race condition handling with gateway
*/

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include <WiFiManager.h>

// ========== KONFIGURASI UNTUK RAILWAY SSL ==========
const char* DEFAULT_SERVER_WS = "web-scoring-board-production.up.railway.app"; // Domain tanpa http://
const int   WS_PORT = 443;                                                     // Port untuk WSS
const char* WS_PATH = "/";                                                     // Path WebSocket
const char* WIFI_AP_NAME = "Quiz_Config_WS";

// ========== PIN DEFINITION ==========
const int LED_MERAH = 33;
const int LED_HIJAU = 32;
const int PIN_JURY_CORRECT = 4;
const int PIN_JURY_WRONG = 5;
const int MODULE_INT_PIN = 16;

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

#define ERR_TEAM_DISABLED    0xE1
#define ERR_INVALID_TEAM     0xE2
#define ERR_SYSTEM_LOCKED    0xE3
#define ERR_SERVER_ERROR     0xE4

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

// System state
bool moduleEnabled[4] = {false, false, false, false};
bool moduleDetected[4] = {false, false, false, false};
uint8_t enabledTeams[12] = {0};
uint8_t activeTeamCount = 0;
uint8_t detectedModules = 0;

// Button state
struct ButtonState {
  bool isPressed;
  bool wasPressed;
  unsigned long pressStartTime;
  bool ledFeedbackActive;
  bool lockConfirmed;
  bool scored;
};

ButtonState buttonStates[12];

// WebSocket state
bool wsConnected = false;
unsigned long lastWSPing = 0;
const unsigned long WS_PING_INTERVAL = 10000;
unsigned long wsConnectTime = 0;

// System state
bool lockActive = false;
int activeTeam = 0;
bool globalButtonLock = false;
unsigned long globalLockStartTime = 0;

// Configuration
struct Config {
  int plusPoints = 5;
  int minusPoints = -2;
  int timerDuration = 30;
  bool autoPenalty = true;
} config;

// Statistics
unsigned long buttonPressCount = 0;
unsigned long heartbeatCount = 0;
unsigned long systemUptime = 0;
int wifiRSSI = 0;

// WiFi reset
bool wifiResetActive = false;
unsigned long wifiResetStartTime = 0;
bool bothPressedLastState = false;

// ========== FUNCTION PROTOTYPES ==========
void setupWiFiManager();
void initializeModules();
bool checkModule(uint8_t addr);
bool writePCF(uint8_t addr, uint8_t value);
bool readPCF(uint8_t addr, uint8_t &value);
void setTeamLED(uint8_t team, bool on);
void clearAllLEDs();
void handleWifiReset();
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length);
void sendButtonPressWS(int team);
void sendHeartbeatWS();
void sendModuleStatus();
void handleWebSocketBinary(uint8_t *payload, size_t length);
void processButtonPress(int team);
void handleJuryButtons();
void resetLockState();
void testWebSocketConnection();

// ========== SETUP ==========
void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("\n========================================");
  Serial.println("ESP32 QUIZ BUZZER - WebSocket Version 4.0");
  Serial.println("Optimized for Railway SSL/HTTPS");
  Serial.println("========================================");
  
  // Initialize pins
  pinMode(LED_MERAH, OUTPUT);
  pinMode(LED_HIJAU, OUTPUT);
  pinMode(PIN_JURY_CORRECT, INPUT_PULLUP);
  pinMode(PIN_JURY_WRONG, INPUT_PULLUP);
  
  // Test LEDs
  digitalWrite(LED_MERAH, HIGH);
  digitalWrite(LED_HIJAU, HIGH);
  delay(200);
  digitalWrite(LED_MERAH, LOW);
  digitalWrite(LED_HIJAU, LOW);
  
  // Initialize I2C
  Wire.begin(21, 22);
  Wire.setClock(400000); // 400kHz for speed
  
  // Setup WiFi Manager
  setupWiFiManager();
  
  // Initialize modules
  initializeModules();
  
  // Setup WebSocket untuk Railway SSL
  Serial.println("\n[SETUP] Configuring WebSocket for Railway SSL...");
  Serial.print("Server: ");
  Serial.println(DEFAULT_SERVER_WS);
  Serial.print("Port: ");
  Serial.println(WS_PORT);
  Serial.print("Path: ");
  Serial.println(WS_PATH);
  
  // PERBAIKAN: Gunakan beginSSL untuk koneksi WSS (WebSocket Secure)
  // Jika menggunakan port 443, gunakan beginSSL
  // Jika menggunakan port 80, gunakan begin
  if (WS_PORT == 443) {
    // Untuk Railway dengan SSL
    webSocket.beginSSL(DEFAULT_SERVER_WS, WS_PORT, WS_PATH);
    Serial.println("[SETUP] Using SSL WebSocket (WSS)");
  } else {
    // Untuk koneksi non-SSL
    webSocket.begin(DEFAULT_SERVER_WS, WS_PORT, WS_PATH);
    Serial.println("[SETUP] Using regular WebSocket (WS)");
  }
  
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  
  // PERBAIKAN: Hapus setInsecure() karena tidak didukung
  // webSocket.setInsecure(); // HAPUS BARIS INI
  
  // Enable heartbeat untuk menjaga koneksi
  webSocket.enableHeartbeat(15000, 3000, 2);
  
  Serial.println("\n[SETUP] System ready! Waiting for WebSocket connection...");
  Serial.println("========================================\n");
}

// ========== WIFI MANAGER ==========
void setupWiFiManager() {
  WiFiManagerParameter custom_ws_server("ws_server", "WebSocket Server", DEFAULT_SERVER_WS, 100);
  wm.addParameter(&custom_ws_server);
  
  // Set timeout lebih lama
  wm.setConfigPortalTimeout(180);
  
  if (!wm.autoConnect(WIFI_AP_NAME)) {
    Serial.println("Failed to connect, restarting...");
    delay(3000);
    ESP.restart();
  }
  
  Serial.println("WiFi connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());
  Serial.print("RSSI: ");
  Serial.println(WiFi.RSSI());
  Serial.print("SSID: ");
  Serial.println(WiFi.SSID());
}

// ========== MODULE FUNCTIONS ==========
void initializeModules() {
  Serial.println("=== MODULE INITIALIZATION ===");
  
  activeTeamCount = 0;
  detectedModules = 0;
  
  for (int i = 0; i < 4; i++) {
    bool detected = checkModule(MODULE_ADDRESSES[i]);
    moduleDetected[i] = detected;
    moduleEnabled[i] = detected;
    
    if (detected) {
      detectedModules++;
      Serial.printf("Module 0x%02X detected\n", MODULE_ADDRESSES[i]);
      
      // Initialize with all LEDs off
      writePCF(MODULE_ADDRESSES[i], 0xFF);
      
      // Enable teams for this module
      for (int t = 0; t < 12; t++) {
        if (TEAM_MAPPINGS[t].moduleAddress == MODULE_ADDRESSES[i]) {
          enabledTeams[t] = 1;
          activeTeamCount++;
          Serial.printf("  Team %s enabled\n", TEAM_MAPPINGS[t].teamName);
        }
      }
    } else {
      Serial.printf("Module 0x%02X NOT detected\n", MODULE_ADDRESSES[i]);
    }
  }
  
  Serial.printf("Detected: %d modules, %d teams active\n", detectedModules, activeTeamCount);
}

bool checkModule(uint8_t addr) {
  Wire.beginTransmission(addr);
  byte error = Wire.endTransmission();
  return error == 0;
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
  
  // Find module index
  int modIdx = -1;
  for (int i = 0; i < 4; i++) {
    if (MODULE_ADDRESSES[i] == mapping.moduleAddress) {
      modIdx = i;
      break;
    }
  }
  
  if (modIdx == -1 || !moduleEnabled[modIdx]) return;
  
  // Read current state
  uint8_t current;
  if (!readPCF(mapping.moduleAddress, current)) return;
  
  // Update LED bit
  if (on) {
    current &= ~(1 << mapping.ledBit);
  } else {
    current |= (1 << mapping.ledBit);
  }
  
  // Write back
  writePCF(mapping.moduleAddress, current);
}

void clearAllLEDs() {
  for (int i = 0; i < 4; i++) {
    if (moduleEnabled[i]) {
      writePCF(MODULE_ADDRESSES[i], 0xFF);
    }
  }
  
  for (int i = 0; i < 12; i++) {
    buttonStates[i].ledFeedbackActive = false;
    buttonStates[i].lockConfirmed = false;
  }
}

// ========== WEBSOCKET FUNCTIONS ==========
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_CONNECTED:
      Serial.printf("[WS] Connected to server!\n");
      wsConnected = true;
      wsConnectTime = millis();
      digitalWrite(LED_HIJAU, HIGH);
      
      // Send initial heartbeat
      sendHeartbeatWS();
      
      // Send module status
      sendModuleStatus();
      
      Serial.println("[WS] Connection established successfully!");
      break;
      
    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected from server!");
      wsConnected = false;
      digitalWrite(LED_HIJAU, LOW);
      digitalWrite(LED_MERAH, LOW);
      break;
      
    case WStype_TEXT:
      Serial.printf("[WS] Text message: %s\n", payload);
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
      
    case WStype_PING:
      // Serial.println("[WS] Ping received");
      break;
      
    case WStype_PONG:
      // Serial.println("[WS] Pong received");
      break;
  }
}

void sendButtonPressWS(int team) {
  if (!wsConnected) {
    Serial.println("[WS] Not connected, cannot send button press");
    return;
  }
  
  buttonPressCount++;
  
  uint8_t buffer[14];
  buffer[0] = MSG_BUTTON_PRESS;
  buffer[1] = team;
  
  // Timestamp (4 bytes)
  uint32_t timestamp = millis();
  buffer[2] = (timestamp >> 24) & 0xFF;
  buffer[3] = (timestamp >> 16) & 0xFF;
  buffer[4] = (timestamp >> 8) & 0xFF;
  buffer[5] = timestamp & 0xFF;
  
  // Sequence (2 bytes) - using button press count
  uint16_t sequence = buttonPressCount;
  buffer[6] = (sequence >> 8) & 0xFF;
  buffer[7] = sequence & 0xFF;
  
  // Module and team info
  buffer[8] = detectedModules;
  buffer[9] = activeTeamCount;
  
  // RSSI
  int16_t rssi = WiFi.RSSI();
  buffer[10] = (rssi >> 8) & 0xFF;
  buffer[11] = rssi & 0xFF;
  
  // Nonce and reserved
  buffer[12] = random(256);
  buffer[13] = 0;
  
  bool sent = webSocket.sendBIN(buffer, 14);
  
  if (sent) {
    Serial.printf("[WS] Button press sent: Team %s, Seq %d\n", 
                  TEAM_MAPPINGS[team-1].teamName, sequence);
  } else {
    Serial.printf("[WS] Failed to send button press for Team %s\n", 
                  TEAM_MAPPINGS[team-1].teamName);
  }
}

void sendHeartbeatWS() {
  if (!wsConnected) {
    // Coba reconnect jika tidak terhubung
    Serial.println("[WS] Not connected, attempting to reconnect...");
    webSocket.disconnect();
    delay(100);
    if (WS_PORT == 443) {
      webSocket.beginSSL(DEFAULT_SERVER_WS, WS_PORT, WS_PATH);
    } else {
      webSocket.begin(DEFAULT_SERVER_WS, WS_PORT, WS_PATH);
    }
    return;
  }
  
  heartbeatCount++;
  
  uint8_t buffer[16];
  buffer[0] = MSG_HEARTBEAT;
  buffer[1] = detectedModules;
  buffer[2] = activeTeamCount;
  
  // RSSI
  int16_t rssi = WiFi.RSSI();
  buffer[3] = (rssi >> 8) & 0xFF;
  buffer[4] = rssi & 0xFF;
  
  // Heap memory
  uint32_t heap = ESP.getFreeHeap();
  buffer[5] = (heap >> 24) & 0xFF;
  buffer[6] = (heap >> 16) & 0xFF;
  buffer[7] = (heap >> 8) & 0xFF;
  buffer[8] = heap & 0xFF;
  
  // Uptime
  uint32_t uptime = millis() / 1000;
  buffer[9] = (uptime >> 24) & 0xFF;
  buffer[10] = (uptime >> 16) & 0xFF;
  buffer[11] = (uptime >> 8) & 0xFF;
  buffer[12] = uptime & 0xFF;
  
  // Lock state
  buffer[13] = lockActive ? 1 : 0;
  buffer[14] = activeTeam;
  buffer[15] = 0; // reserved
  
  webSocket.sendBIN(buffer, 16);
  
  if (heartbeatCount % 10 == 0) {
    Serial.printf("[WS] Heartbeat #%d sent (RSSI: %d, Heap: %d)\n", 
                  heartbeatCount, rssi, heap);
  }
}

void sendModuleStatus() {
  if (!wsConnected) return;
  
  uint8_t buffer[3];
  buffer[0] = MSG_MODULE_STATUS;
  buffer[1] = detectedModules;
  buffer[2] = activeTeamCount;
  
  webSocket.sendBIN(buffer, 3);
  Serial.printf("[WS] Module status sent: %d modules, %d teams\n", 
                detectedModules, activeTeamCount);
}

void handleWebSocketBinary(uint8_t *payload, size_t length) {
  if (length < 1) return;
  
  uint8_t msgType = payload[0];
  
  Serial.printf("[WS] Received binary message type: 0x%02X, length: %d\n", 
                msgType, length);
  
  switch(msgType) {
    case MSG_LOCK_ACQUIRED:
      if (length >= 9) {
        uint8_t team = payload[1];
        uint32_t timestamp = (payload[2] << 24) | (payload[3] << 16) | (payload[4] << 8) | payload[5];
        uint16_t sequence = (payload[6] << 8) | payload[7];
        uint8_t timerDuration = payload[8];
        
        Serial.printf("[WS] Lock acquired: Team %s, Seq %d, Timer %ds\n",
                     TEAM_MAPPINGS[team-1].teamName, sequence, timerDuration);
        
        // Update local state
        lockActive = true;
        activeTeam = team;
        buttonStates[team-1].lockConfirmed = true;
        
        // Set LED
        setTeamLED(team, true);
        
        // Feedback LED
        digitalWrite(LED_HIJAU, LOW);
        delay(50);
        digitalWrite(LED_HIJAU, HIGH);
        
        // Update config if timer duration changed
        if (timerDuration != config.timerDuration) {
          config.timerDuration = timerDuration;
          Serial.printf("[WS] Timer duration updated to %d seconds\n", timerDuration);
        }
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
        
        // Release LED feedback
        setTeamLED(team, false);
        buttonStates[team-1].ledFeedbackActive = false;
        
        // Error feedback
        for (int i = 0; i < 3; i++) {
          digitalWrite(LED_MERAH, HIGH);
          delay(50);
          digitalWrite(LED_MERAH, LOW);
          delay(50);
        }
      }
      break;
      
    case MSG_LOCK_RELEASED:
      Serial.println("[WS] System unlocked (lock released)");
      resetLockState();
      
      // Feedback
      digitalWrite(LED_HIJAU, LOW);
      digitalWrite(LED_MERAH, LOW);
      delay(100);
      digitalWrite(LED_HIJAU, HIGH);
      delay(100);
      digitalWrite(LED_MERAH, HIGH);
      delay(100);
      digitalWrite(LED_MERAH, LOW);
      break;
      
    case MSG_FORCE_UNLOCK:
      Serial.println("[WS] System unlocked (force unlock)");
      resetLockState();
      
      // Feedback
      digitalWrite(LED_HIJAU, LOW);
      digitalWrite(LED_MERAH, LOW);
      delay(100);
      digitalWrite(LED_HIJAU, HIGH);
      digitalWrite(LED_MERAH, HIGH);
      delay(100);
      digitalWrite(LED_HIJAU, LOW);
      digitalWrite(LED_MERAH, LOW);
      delay(100);
      digitalWrite(LED_HIJAU, HIGH);
      break;
      
    case MSG_CONFIG_UPDATE:
      if (length >= 6) {
        config.plusPoints = payload[1];
        config.minusPoints = (int8_t)payload[2];
        config.timerDuration = payload[3];
        config.autoPenalty = payload[4] == 1;
        
        Serial.printf("[WS] Config updated: +%d, %d, Timer %d, AutoPenalty %s\n",
                     config.plusPoints, config.minusPoints, config.timerDuration,
                     config.autoPenalty ? "ON" : "OFF");
        
        // Feedback
        digitalWrite(LED_HIJAU, LOW);
        delay(100);
        digitalWrite(LED_HIJAU, HIGH);
      }
      break;
      
    case MSG_SCORE_UPDATE:
      if (length >= 6) {
        uint8_t team = payload[1];
        int32_t score = (payload[2] << 24) | (payload[3] << 16) | (payload[4] << 8) | payload[5];
        Serial.printf("[WS] Score update: Team %s = %d\n", 
                     TEAM_MAPPINGS[team-1].teamName, score);
      }
      break;
      
    case MSG_SYSTEM_STATUS:
      Serial.println("[WS] System status received");
      break;
      
    default:
      Serial.printf("[WS] Unknown message type: 0x%02X\n", msgType);
  }
}

// ========== BUTTON PROCESSING ==========
void processButtonPress(int team) {
  if (team < 1 || team > 12) return;
  
  int idx = team - 1;
  
  // Check if team is enabled
  if (enabledTeams[idx] != 1) {
    Serial.printf("[BUTTON] Team %s is disabled, ignoring\n", TEAM_MAPPINGS[idx].teamName);
    return;
  }
  
  // Check global lock
  if (globalButtonLock) {
    if (millis() - globalLockStartTime > 5000) {
      globalButtonLock = false; // Timeout after 5 seconds
    } else {
      Serial.println("[BUTTON] Global lock active, ignoring");
      return;
    }
  }
  
  // Check if already locked by another team
  if (lockActive && activeTeam != team) {
    Serial.printf("[BUTTON] System locked by Team %s, ignoring Team %s\n", 
                 TEAM_MAPPINGS[activeTeam-1].teamName, TEAM_MAPPINGS[idx].teamName);
    return;
  }
  
  // Check if already processed
  if (buttonStates[idx].lockConfirmed) {
    Serial.printf("[BUTTON] Team %s already lock confirmed, ignoring\n", TEAM_MAPPINGS[idx].teamName);
    return;
  }
  
  // Acquire global lock
  globalButtonLock = true;
  globalLockStartTime = millis();
  
  // Set LED feedback
  setTeamLED(team, true);
  buttonStates[idx].ledFeedbackActive = true;
  
  // Send via WebSocket
  sendButtonPressWS(team);
  
  Serial.printf("[BUTTON] Team %s pressed, sending via WS\n", TEAM_MAPPINGS[idx].teamName);
}

// ========== JURY BUTTONS ==========
void handleJuryButtons() {
  bool corrPressed = digitalRead(PIN_JURY_CORRECT) == LOW;
  bool wrongPressed = digitalRead(PIN_JURY_WRONG) == LOW;
  
  if (wifiResetActive) {
    // Handle WiFi reset
    if (corrPressed && wrongPressed) {
      unsigned long elapsed = millis() - wifiResetStartTime;
      
      if (elapsed > 5000 && !bothPressedLastState) {
        Serial.println("[RESET] WiFi reset triggered!");
        wm.resetSettings();
        delay(1000);
        ESP.restart();
      }
      bothPressedLastState = true;
    } else {
      bothPressedLastState = false;
    }
    return;
  }
  
  // Check for WiFi reset trigger
  if (corrPressed && wrongPressed && !bothPressedLastState) {
    wifiResetActive = true;
    wifiResetStartTime = millis();
    bothPressedLastState = true;
    
    Serial.println("[RESET] WiFi reset mode activated - hold for 5 seconds");
    
    // Visual feedback
    digitalWrite(LED_MERAH, HIGH);
    digitalWrite(LED_HIJAU, HIGH);
    return;
  }
  
  if (!corrPressed && !wrongPressed) {
    if (wifiResetActive) {
      wifiResetActive = false;
      bothPressedLastState = false;
      digitalWrite(LED_MERAH, LOW);
      digitalWrite(LED_HIJAU, HIGH);
    }
    return;
  }
  
  // Normal jury button handling
  static unsigned long lastJuryPress = 0;
  unsigned long now = millis();
  
  if (now - lastJuryPress < 300) return; // Debounce
  
  if (corrPressed && lockActive && activeTeam > 0) {
    // Send jury action via WebSocket
    uint8_t buffer[9];
    buffer[0] = MSG_JURY_ACTION;
    buffer[1] = activeTeam;
    buffer[2] = 1; // correct
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
      
      // Feedback
      for (int i = 0; i < 2; i++) {
        digitalWrite(LED_HIJAU, LOW);
        delay(80);
        digitalWrite(LED_HIJAU, HIGH);
        delay(80);
      }
    } else {
      Serial.println("[JURY] WebSocket not connected, cannot send jury action");
    }
    
    lastJuryPress = now;
  }
  
  if (wrongPressed && lockActive && activeTeam > 0) {
    // Send jury action via WebSocket
    uint8_t buffer[9];
    buffer[0] = MSG_JURY_ACTION;
    buffer[1] = activeTeam;
    buffer[2] = 0; // wrong
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
      
      // Feedback
      for (int i = 0; i < 2; i++) {
        digitalWrite(LED_MERAH, HIGH);
        delay(80);
        digitalWrite(LED_MERAH, LOW);
        delay(80);
      }
    } else {
      Serial.println("[JURY] WebSocket not connected, cannot send jury action");
    }
    
    lastJuryPress = now;
  }
}

// ========== RESET LOCK STATE ==========
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

// ========== TEST WEBSOCKET CONNECTION ==========
void testWebSocketConnection() {
  if (!wsConnected) {
    Serial.println("[TEST] WebSocket not connected, attempting to reconnect...");
    webSocket.disconnect();
    delay(1000);
    if (WS_PORT == 443) {
      webSocket.beginSSL(DEFAULT_SERVER_WS, WS_PORT, WS_PATH);
    } else {
      webSocket.begin(DEFAULT_SERVER_WS, WS_PORT, WS_PATH);
    }
    webSocket.enableHeartbeat(15000, 3000, 2);
  }
}

// ========== MAIN LOOP ==========
void loop() {
  // Handle WebSocket events
  webSocket.loop();
  
  // Handle WiFi reset
  if (wifiResetActive) {
    unsigned long elapsed = millis() - wifiResetStartTime;
    
    // Blink LEDs during reset mode
    if (millis() % 200 < 100) {
      digitalWrite(LED_MERAH, HIGH);
      digitalWrite(LED_HIJAU, HIGH);
    } else {
      digitalWrite(LED_MERAH, LOW);
      digitalWrite(LED_HIJAU, LOW);
    }
    
    // Cancel reset if buttons released
    if (elapsed > 10000) {
      wifiResetActive = false;
      digitalWrite(LED_MERAH, LOW);
      digitalWrite(LED_HIJAU, HIGH);
      Serial.println("[RESET] Reset mode cancelled");
    }
    
    return;
  }
  
  // Update status LEDs
  if (wsConnected) {
    digitalWrite(LED_HIJAU, HIGH);
  } else {
    digitalWrite(LED_HIJAU, LOW);
    // Blink red LED if not connected
    if (millis() % 1000 < 500) {
      digitalWrite(LED_MERAH, HIGH);
    } else {
      digitalWrite(LED_MERAH, LOW);
    }
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
          
          // Turn off LED if not locked
          if (!buttonStates[teamIdx].lockConfirmed) {
            setTeamLED(TEAM_MAPPINGS[team].teamNumber, false);
            buttonStates[teamIdx].ledFeedbackActive = false;
          }
        }
      }
    }
  }
  
  // Handle jury buttons
  handleJuryButtons();
  
  // Send periodic heartbeat
  static unsigned long lastHeartbeat = 0;
  if (millis() - lastHeartbeat > 30000) { // Every 30 seconds
    lastHeartbeat = millis();
    
    if (wsConnected) {
      sendHeartbeatWS();
    } else {
      Serial.println("[HEARTBEAT] WebSocket not connected, skipping heartbeat");
      testWebSocketConnection();
    }
    
    // Update WiFi RSSI
    wifiRSSI = WiFi.RSSI();
    
    // Reconnect if WiFi lost
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("WiFi lost, reconnecting...");
      WiFi.reconnect();
    }
  }
  
  // Check for WebSocket connection status
  static unsigned long lastConnectionCheck = 0;
  if (millis() - lastConnectionCheck > 60000) { // Every 60 seconds
    lastConnectionCheck = millis();
    
    if (!wsConnected) {
      Serial.println("[CONNECTION] WebSocket disconnected, attempting to reconnect...");
      testWebSocketConnection();
    }
  }
  
  // Check for lock timeout (90 seconds)
  if (lockActive && millis() - globalLockStartTime > 90000) {
    Serial.println("[TIMEOUT] Lock timeout after 90 seconds, resetting...");
    resetLockState();
  }
  
  // Small delay to prevent watchdog
  delay(5);
}