/*
  quiz-scoring-fast.ino
  ESP32 master for Quiz Scoring system – Ultra-Low-Latency version
  With Corrected LED Mapping (P3, P4, P5)
  Optimized by ChatGPT (GPT-5, 2025)
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

// ====== CORRECTED BUTTON-LED MAPPING ======
struct ButtonLEDMapping {
  uint8_t moduleAddress;  // Alamat I2C module
  uint8_t buttonBit;      // Bit untuk tombol (0-2)
  uint8_t ledBit;         // Bit untuk LED (3,4,5) - P3,P4,P5
  uint8_t teamNumber;     // Nomor tim (1-12)
  const char* teamName;   // Nama tim
};

// CORRECTED MAPPING - LED menggunakan P3, P4, P5
const ButtonLEDMapping TEAM_MAPPINGS[12] = {
  // Module 0x20 - Teams A, B, C
  {0x20, 0, 3, 1, "A"},  // Tombol A -> Button Bit 0, LED Bit 3 (P3)
  {0x20, 1, 4, 2, "B"},  // Tombol B -> Button Bit 1, LED Bit 4 (P4)
  {0x20, 2, 5, 3, "C"},  // Tombol C -> Button Bit 2, LED Bit 5 (P5)
  
  // Module 0x21 - Teams D, E, F
  {0x21, 0, 3, 4, "D"},  // Tombol D -> Button Bit 0, LED Bit 3 (P3)
  {0x21, 1, 4, 5, "E"},  // Tombol E -> Button Bit 1, LED Bit 4 (P4)
  {0x21, 2, 5, 6, "F"},  // Tombol F -> Button Bit 2, LED Bit 5 (P5)
  
  // Module 0x22 - Teams G, H, I
  {0x22, 0, 3, 7, "G"},  // Tombol G -> Button Bit 0, LED Bit 3 (P3)
  {0x22, 1, 4, 8, "H"},  // Tombol H -> Button Bit 1, LED Bit 4 (P4)
  {0x22, 2, 5, 9, "I"},  // Tombol I -> Button Bit 2, LED Bit 5 (P5)
  
  // Module 0x23 - Teams J, K, L
  {0x23, 0, 3, 10, "J"}, // Tombol J -> Button Bit 0, LED Bit 3 (P3)
  {0x23, 1, 4, 11, "K"}, // Tombol K -> Button Bit 1, LED Bit 4 (P4)
  {0x23, 2, 5, 12, "L"}  // Tombol L -> Button Bit 2, LED Bit 5 (P5)
};

// Helper functions untuk mapping
int getModuleIndex(uint8_t moduleAddress) {
  for (int i = 0; i < 4; i++) {
    if (MODULE_ADDRESSES[i] == moduleAddress) return i;
  }
  return -1;
}

// ====== TIMINGS ======
const unsigned long POLL_INTERVAL      = 8;
const unsigned long DEBOUNCE_MS        = 40;
const unsigned long JURY_DEBOUNCE_MS   = 60;
const unsigned long LOCK_POLL_MS       = 1000;
const unsigned long MODULE_SCAN_MS     = 3000;
const unsigned long BUTTON_LED_DURATION = 500;

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

// ====== SHARED HTTP CLIENT ======
HTTPClient sharedHttp;

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
    currentState &= ~(1 << mapping.ledBit); // Clear bit (LED ON)
  } else {
    currentState |= (1 << mapping.ledBit);  // Set bit (LED OFF)
  }
  
  pcfOutCache[moduleIndex] = currentState;
  
  Serial.printf("[LED] Team %s -> Module 0x%02X, LED Bit P%d %s (Value: 0x%02X)\n", 
                mapping.teamName, mapping.moduleAddress, mapping.ledBit,
                on ? "ON" : "OFF", currentState);
  
  writePCF(mapping.moduleAddress, currentState);
}

void clearAllLEDs() {
  Serial.println("[CLEAR] Clearing all LEDs");
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

// ====== BUTTON HANDLERS ======
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
    
    // Debug: log raw button states if changed
    if (currentState != lastRead[moduleIndex]) {
      Serial.printf("[BTN-RAW] Module 0x%02X: 0x%02X -> ", 
                   MODULE_ADDRESSES[moduleIndex], currentState);
      for (int i = 0; i < 3; i++) {
        Serial.printf("B%d:%d ", i, (currentState & (1 << i)) == 0 ? 1 : 0);
      }
      Serial.println();
    }
    
    // Check each team mapping for this module
    for (int team = 0; team < 12; team++) {
      const ButtonLEDMapping& mapping = TEAM_MAPPINGS[team];
      
      // Only process teams from current module
      if (mapping.moduleAddress != MODULE_ADDRESSES[moduleIndex]) continue;
      
      bool currentlyPressed = (currentState & (1 << mapping.buttonBit)) == 0;
      bool previouslyPressed = (lastRead[moduleIndex] & (1 << mapping.buttonBit)) == 0;
      
      if (currentlyPressed && !previouslyPressed && !lockActive &&
          now - lastDebounceTime[mapping.teamNumber] > DEBOUNCE_MS) {
        lastDebounceTime[mapping.teamNumber] = now;
        
        Serial.printf("[BUTTON] Team %s pressed! Module 0x%02X, Button Bit %d\n",
                     mapping.teamName, mapping.moduleAddress, mapping.buttonBit);
        
        // Immediately activate LED for the pressed button
        setTeamLED(mapping.teamNumber, true);
        buttonLedActive[mapping.teamNumber-1] = true;
        buttonLedStartTime[mapping.teamNumber-1] = millis();
        
        // Set lock state
        lockActive = true;
        activeTeam = mapping.teamNumber;
        
        // Send to server
        sendUpdateToServer(mapping.teamNumber, 0, true);
        
        // Update LED state (this will clear others and set active)
        updateActiveTeamLED();
        
        break; // Only process one button press at a time
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
      
      // Visual feedback - quick blink
      setTeamLED(activeTeam, false);
      delay(80);
      setTeamLED(activeTeam, true);
      buttonLedStartTime[activeTeam-1] = millis();
      
      sendJuryUpdateToServer(activeTeam, plusValue, "CORRECT");
    }
  }
  
  if (wrong && !lastJuryWrongState && now - lastDebounceTime[13] > JURY_DEBOUNCE_MS) {
    lastDebounceTime[13] = now;
    if (lockActive && activeTeam && activeTeam <= 12) {
      Serial.printf("[JURY] Wrong for Team %s\n", TEAM_NAMES[activeTeam-1]);
      
      // Visual feedback - double blink
      for (int i = 0; i < 2; i++) {
        setTeamLED(activeTeam, false);
        delay(80);
        setTeamLED(activeTeam, true);
        if (i == 0) delay(40);
      }
      buttonLedStartTime[activeTeam-1] = millis();
      
      sendJuryUpdateToServer(activeTeam, minusValue, "WRONG");
    }
  }
  
  lastJuryCorrectState = corr;
  lastJuryWrongState   = wrong;
}

// ====== HTTP OPERATIONS ======
String httpGetString(const String &url) {
  if (WiFi.status() != WL_CONNECTED) return "";
  sharedHttp.setReuse(true);
  sharedHttp.setConnectTimeout(2000);
  sharedHttp.setTimeout(2000);
  sharedHttp.begin(url);
  int code = sharedHttp.GET();
  String payload = (code == 200) ? sharedHttp.getString() : "";
  sharedHttp.end();
  return payload;
}

void sendUpdateToServer(int team, int add, bool isFirst) {
  if (WiFi.status() != WL_CONNECTED) return;
  
  String url = "https://" + String(serverHost) + "/update?team=" + String(team) + "&add=" + add;
  if (isFirst) url += "&first=1";
  sharedHttp.setReuse(true);
  sharedHttp.setConnectTimeout(2000);
  sharedHttp.setTimeout(2000);
  sharedHttp.begin(url);
  int code = sharedHttp.GET();
  Serial.printf("[UPDATE] Team %s first=%d code=%d\n", TEAM_NAMES[team-1], isFirst, code);
  sharedHttp.end();
}

void sendJuryUpdateToServer(int team, int add, const char *action) {
  if (!lockActive || team < 1 || team > 12 || WiFi.status() != WL_CONNECTED) return;
  
  String url = "https://" + String(serverHost) + "/update?team=" + String(team) + "&add=" + add;
  sharedHttp.setReuse(true);
  sharedHttp.setConnectTimeout(2000);
  sharedHttp.setTimeout(2000);
  sharedHttp.begin(url);
  int code = sharedHttp.GET();
  Serial.printf("[JURY] Team %s %s code=%d\n", TEAM_NAMES[team-1], action, code);
  sharedHttp.end();
}

void pollLockState() {
  String url = "https://" + String(serverHost) + "/lockstate";
  String payload = httpGetString(url);
  if (payload.isEmpty()) return;
  
  StaticJsonDocument<200> doc;
  if (deserializeJson(doc, payload)) return;
  
  bool newLock = doc["locked"] | false;
  int newActive = doc["activeTeam"] | 0;
  
  if (newLock != lockActive || newActive != activeTeam) {
    lockActive = newLock;
    activeTeam = newActive;
    
    if (lockActive && activeTeam > 0) {
      Serial.printf("[LOCK] Team %s locked\n", TEAM_NAMES[activeTeam-1]);
      updateActiveTeamLED();
    } else {
      Serial.println("[LOCK] System unlocked");
      clearAllLEDs();
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
  if (!wm.autoConnect(WIFI_AP_NAME)) ESP.restart();
  String hostValue = custom_server_host.getValue();
  hostValue.replace("http://", ""); hostValue.replace("https://", "");
  strncpy(serverHost, hostValue.c_str(), sizeof(serverHost) - 1);
  serverPort = atoi(custom_server_port.getValue());
  Serial.printf("WiFi: Host=%s Port=%d\n", serverHost, serverPort);
}

void recoverI2CBus() {
  Serial.println("[I2C] Bus recovery...");
  Wire.end();
  delay(100);
  Wire.begin(21, 22);
  Wire.setClock(100000);
  delay(100);
}

// ====== SETUP ======
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\nQUIZ SCORING - Corrected LED Mapping (P3,P4,P5)");
  Serial.println("CORRECTED LED MAPPING:");
  Serial.println("LED_1 = P3 (bit 3)");
  Serial.println("LED_2 = P4 (bit 4)");  
  Serial.println("LED_3 = P5 (bit 5)");
  Serial.println("");
  Serial.println("TEAM MAPPING CONFIGURATION:");
  
  // Print semua mapping
  for (int i = 0; i < 12; i++) {
    const ButtonLEDMapping& mapping = TEAM_MAPPINGS[i];
    Serial.printf("  Team %s (%d) -> Module 0x%02X, Button Bit %d, LED Bit P%d\n",
                  mapping.teamName, mapping.teamNumber,
                  mapping.moduleAddress, mapping.buttonBit, mapping.ledBit);
  }

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
  Serial.println("[INIT] System ready with corrected LED mapping");
}

// ====== LOOP ======
void loop() {
  unsigned long now = millis();

  handleJuryButtons();
  pollPCFButtons();
  updateButtonLEDs();

  static unsigned long lastLockPoll = 0;
  if (now - lastLockPoll >= LOCK_POLL_MS) { 
    lastLockPoll = now; 
    pollLockState(); 
  }

  static unsigned long lastModuleScan = 0;
  if (now - lastModuleScan >= MODULE_SCAN_MS) {
    lastModuleScan = now;
    scanPCFModules();
  }

  static unsigned long lastKeepAlivePing = 0;
  if (now - lastKeepAlivePing >= 30000) {
    lastKeepAlivePing = now;
    if (WiFi.status() == WL_CONNECTED) {
      sharedHttp.setReuse(true);
      sharedHttp.begin("https://" + String(serverHost) + "/health");
      sharedHttp.GET();
      sharedHttp.end();
    }
  }
}