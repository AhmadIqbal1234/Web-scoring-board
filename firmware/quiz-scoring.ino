/*
  quiz-scoring.ino
  ESP32 master for Quiz Scoring system - OPTIMIZED VERSION WITH DYNAMIC PCF DETECTION
  - Modified for dynamic PCF8574 detection (1-4 modules)
  - Copyright © 2025 Ridwan and Team
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>

// ======= Configurable defaults =======
const char *DEFAULT_SERVER_HOST = "web-scoring-board-production.up.railway.app";
const int DEFAULT_SERVER_PORT = 443;
const char *WIFI_AP_NAME = "Quiz_Config";

// PCF8574 I2C addresses
const uint8_t PCF_ADDR[4] = {0x20, 0x21, 0x22, 0x23};

// Pins
const int PIN_JURY_CORRECT = 4; // GPIO4
const int PIN_JURY_WRONG = 5;   // GPIO5

// OPTIMIZED TIMINGS (ms)
const unsigned long POLL_INTERVAL = 12;
const unsigned long DEBOUNCE_MS = 40;
const unsigned long JURY_DEBOUNCE_MS = 80;
const unsigned long LOCK_POLL_MS = 5000;
const unsigned long CONFIG_POLL_MS = 60000;
const unsigned long WIFI_CHECK_MS = 15000;
const unsigned long STATUS_REPORT_MS = 60000;
const unsigned long HEARTBEAT_INTERVAL = 60000;

// ===== State =====
char serverHost[64];
int serverPort = DEFAULT_SERVER_PORT;

bool lockActive = false;
int activeTeam = 0;

// Dynamic PCF configuration
bool pcfDetected[4] = {false, false, false, false};
int totalPCFCount = 0;
int totalTeams = 0;

// per-panel output cache for PCF (P0..P7)
uint8_t pcfOutCache[4];
uint8_t lastRead[4];

unsigned long lastI2CPoll = 0;
unsigned long lastLockPoll = 0;
unsigned long lastConfigPoll = 0;
unsigned long lastWiFiCheck = 0;
unsigned long lastStatusReport = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastDebounceTime[14];

// JURY STATE TRACKING
bool lastJuryCorrectState = HIGH;
bool lastJuryWrongState = HIGH;

int plusValue = 5;
int minusValue = -2;

// ===== PCF Detection and Configuration =====
void detectPCFModules() {
    Serial.println("Scanning for PCF8574 modules...");
    totalPCFCount = 0;
    
    for (int i = 0; i < 4; i++) {
        Wire.beginTransmission(PCF_ADDR[i]);
        byte error = Wire.endTransmission();
        
        if (error == 0) {
            pcfDetected[i] = true;
            totalPCFCount++;
            Serial.printf("Found PCF8574 at address 0x%02X\n", PCF_ADDR[i]);
        } else {
            pcfDetected[i] = false;
            Serial.printf("No PCF8574 at address 0x%02X\n", PCF_ADDR[i]);
        }
    }
    
    totalTeams = totalPCFCount * 3;
    Serial.printf("Total PCF modules detected: %d\n", totalPCFCount);
    Serial.printf("Total teams available: %d\n", totalTeams);
    
    // Report to server
    if (WiFi.status() == WL_CONNECTED) {
        String url = String("https://") + serverHost + "/esp32checkin?action=pcf_detection&count=" + 
                    String(totalPCFCount) + "&teams=" + String(totalTeams);
        HTTPClient http;
        http.setConnectTimeout(3000);
        http.setTimeout(3000);
        http.begin(url);
        http.GET();
        http.end();
    }
}

bool isPCFActive(int panelIdx) {
    return (panelIdx >= 0 && panelIdx < 4 && pcfDetected[panelIdx]);
}

bool isTeamValid(int team) {
    return (team >= 1 && team <= totalTeams);
}

// ===== Helpers: PCF read/write using Wire =====
bool writePCF(uint8_t addr, uint8_t value) {
    bool detected = false;
    for (int i = 0; i < 4; i++) {
        if (PCF_ADDR[i] == addr && pcfDetected[i]) {
            detected = true;
            break;
        }
    }
    
    if (!detected) return false;
    
    Wire.beginTransmission(addr);
    Wire.write(value);
    byte result = Wire.endTransmission();
    
    if (result != 0) {
        Serial.printf("[I2C ERROR] Write to 0x%02x failed: %d\n", addr, result);
        return false;
    }
    return true;
}

bool readPCF(uint8_t addr, uint8_t &value) {
    bool detected = false;
    for (int i = 0; i < 4; i++) {
        if (PCF_ADDR[i] == addr && pcfDetected[i]) {
            detected = true;
            break;
        }
    }
    
    if (!detected) return false;
    
    for (int i = 0; i < 10; i++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            Wire.requestFrom(addr, 1);
            if (Wire.available()) {
                value = Wire.read();
                return true;
            }
        }
        delay(15);
    }
    Serial.printf("[I2C ERROR] Failed to read from PCF at 0x%02x after 10 attempts\n", addr);
    return false;
}

// Initialize PCF caches to all HIGH (inputs)
void pcfInitCaches() {
    for (int i = 0; i < 4; ++i) {
        if (pcfDetected[i]) {
            pcfOutCache[i] = 0xFF;
            lastRead[i] = 0xFF;
            if (!writePCF(PCF_ADDR[i], pcfOutCache[i])) {
                Serial.printf("[WARNING] Failed to initialize PCF at 0x%02x\n", PCF_ADDR[i]);
            }
        }
    }
}

// Set LED for panel (ledIndex 0..2) on/off
void setPanelLED(int panelIdx, int ledIndex, bool on) {
    if (!isPCFActive(panelIdx) || ledIndex < 0 || ledIndex > 2)
        return;
        
    uint8_t mask = (1 << (4 + ledIndex));
    uint8_t cur = pcfOutCache[panelIdx];
    if (on)
        cur &= ~mask;
    else
        cur |= mask;
    pcfOutCache[panelIdx] = cur;
    
    if (!writePCF(PCF_ADDR[panelIdx], cur)) {
        Serial.printf("[ERROR] Failed to set LED for panel %d, LED %d\n", panelIdx, ledIndex);
    }
}

void clearAllLEDs() {
    for (int i = 0; i < 4; ++i) {
        if (pcfDetected[i]) {
            pcfOutCache[i] |= ((1 << 4) | (1 << 5) | (1 << 6));
            if (!writePCF(PCF_ADDR[i], pcfOutCache[i])) {
                Serial.printf("[ERROR] Failed to clear LEDs for PCF at 0x%02x\n", PCF_ADDR[i]);
            }
        }
    }
}

// ===== HTTP helpers =====
String httpGetString(const String &url) {
    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(5000);
    http.begin(url);
    
    int code = http.GET();
    String payload = "";
    
    if (code == 200) {
        payload = http.getString();
    } else if (code == 429) {
        Serial.printf("[RATE LIMIT] Server busy: %s\n", url.c_str());
    } else {
        Serial.printf("[HTTP ERROR] GET %s -> code=%d\n", url.c_str(), code);
    }
    
    http.end();
    return payload;
}

void logToServer(const String& message, const String& type = "info") {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }
    
    String url = String("https://") + serverHost + "/health";
    HTTPClient http;
    http.setConnectTimeout(3000);
    http.setTimeout(3000);
    http.begin(url);
    
    int code = http.GET();
    if (code == 200) {
        Serial.printf("[ESP32-STATUS] %s\n", message.c_str());
    }
    http.end();
}

void sendHeartbeatToServer() {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }
    
    String url = String("https://") + serverHost + "/esp32checkin?action=heartbeat&teams=" + String(totalTeams);
    HTTPClient http;
    http.setConnectTimeout(3000);
    http.setTimeout(3000);
    http.begin(url);
    
    int code = http.GET();
    if (code == 200) {
        Serial.println("[HEARTBEAT] Status reported to server");
    } else {
        Serial.printf("[HEARTBEAT] Failed: %d\n", code);
    }
    http.end();
}

void reportActivityToServer(const String& activity, int team = 0) {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }
    
    String url = String("https://") + serverHost + "/esp32checkin?action=" + activity;
    if (team > 0) {
        url += "&team=" + String(team);
    }
    
    HTTPClient http;
    http.setConnectTimeout(3000);
    http.setTimeout(3000);
    http.begin(url);
    
    int code = http.GET();
    if (code == 200) {
        Serial.printf("[ACTIVITY] %s reported\n", activity.c_str());
    }
    http.end();
}

void sendUpdateToServer(int team, int add, bool isFirst) {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[WARNING] WiFi not connected, cannot send update");
        return;
    }
    
    if (!isTeamValid(team)) {
        Serial.printf("[WARNING] Invalid team %d (max teams: %d)\n", team, totalTeams);
        return;
    }
    
    String url = String("https://") + serverHost + "/update?team=" + String(team) + "&add=" + String(add);
    if (isFirst) {
        url += "&first=1";
        Serial.printf("[BUZZ] Team %d FIRST PRESS\n", team);
    }
        
    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(5000);
    http.begin(url);
    
    unsigned long startTime = millis();
    int code = http.GET();
    unsigned long responseTime = millis() - startTime;
    
    Serial.printf("[HTTP] /update -> code=%d team=%d add=%d first=%d time=%dms\n", 
                  code, team, add, isFirst ? 1 : 0, responseTime);
    
    http.end();
    
    if (code == 200 && isFirst) {
        reportActivityToServer("buzzer_press", team);
    }
}

void sendJuryUpdateToServer(int team, int add, const char* action) {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.printf("[JURY] WiFi not connected for %s\n", action);
        return;
    }
    
    if (!lockActive || !isTeamValid(team)) {
        Serial.printf("[JURY] No active team for %s\n", action);
        return;
    }
    
    String url = String("https://") + serverHost + "/update?team=" + String(team) + "&add=" + String(add);
    
    HTTPClient http;
    http.setConnectTimeout(3000);
    http.setTimeout(3000);
    
    unsigned long startTime = millis();
    http.begin(url);
    
    int code = http.GET();
    unsigned long responseTime = millis() - startTime;
    
    Serial.printf("[JURY] %s -> code=%d, team=%d, points=%d, time=%dms\n", 
                  action, code, team, add, responseTime);
    
    http.end();
    
    if (code == 200) {
        reportActivityToServer("jury_" + String(action), team);
    }
}

void pollLockState() {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }
    
    String url = String("https://") + serverHost + "/lockstate";
    String payload = httpGetString(url);
    
    if (payload.length() == 0) {
        static unsigned long lastErrorLog = 0;
        if (millis() - lastErrorLog > 10000) {
            Serial.println("[LOCK] Empty response from /lockstate");
            lastErrorLog = millis();
        }
        return;
    }

    StaticJsonDocument<200> doc;
    DeserializationError err = deserializeJson(doc, payload);
    
    if (err) {
        Serial.printf("[LOCK] JSON parse error: %s\n", err.c_str());
        return;
    }

    bool newLock = doc["locked"] | false;
    int newActive = 0;
    
    if (doc.containsKey("activeTeam") && !doc["activeTeam"].isNull()) {
        newActive = doc["activeTeam"].as<int>();
    }

    if (newLock != lockActive) {
        lockActive = newLock;
        Serial.printf("[LOCK] changed -> %d active=%d\n", lockActive, newActive);
    }
    activeTeam = newActive;

    if (!lockActive) {
        clearAllLEDs();
    } else if (isTeamValid(activeTeam)) {
        int p = (activeTeam - 1) / 3;
        int b = (activeTeam - 1) % 3;
        setPanelLED(p, b, true);
    }
}

void pollConfig() {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }
    
    String url = String("https://") + serverHost + "/config";
    String payload = httpGetString(url);
    
    if (payload.length() == 0) {
        Serial.println("[CFG] Empty response from /config");
        return;
    }

    StaticJsonDocument<200> doc;
    DeserializationError err = deserializeJson(doc, payload);
    
    if (err) {
        Serial.printf("[CFG] JSON parse error: %s\n", err.c_str());
        return;
    }

    if (doc.containsKey("plus"))
        plusValue = doc["plus"].as<int>();
    if (doc.containsKey("minus"))
        minusValue = doc["minus"].as<int>();
        
    Serial.printf("[CFG] plus=%d minus=%d\n", plusValue, minusValue);
}

void checkWiFiConnection() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[WiFi] Connection lost, attempting reconnect...");
        WiFi.reconnect();
        delay(1000);
        
        if (WiFi.status() == WL_CONNECTED) {
            Serial.println("[WiFi] Reconnected successfully");
            sendHeartbeatToServer();
        } else {
            Serial.println("[WiFi] Reconnect failed");
        }
    }
}

void sendStatusReport() {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }
    
    String url = String("https://") + serverHost + "/health";
    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(5000);
    http.begin(url);
    
    int code = http.GET();
    if (code == 200) {
        Serial.println("[STATUS] Periodic health report sent");
    } else {
        Serial.printf("[STATUS] Health report failed: %d\n", code);
    }
    http.end();
}

// ===== Button handling (PCF polling) =====
void pollPCFButtons() {
    uint8_t buf[4];
    bool readSuccess[4] = {false, false, false, false};
    
    for (int i = 0; i < 4; ++i) {
        if (!pcfDetected[i]) continue;
        
        uint8_t val;
        if (readPCF(PCF_ADDR[i], val)) {
            buf[i] = val;
            readSuccess[i] = true;
        } else {
            buf[i] = lastRead[i];
        }
    }

    unsigned long now = millis();
    
    for (int panel = 0; panel < 4; ++panel) {
        if (!pcfDetected[panel] || !readSuccess[panel]) continue;
        
        uint8_t cur = buf[panel];
        for (int b = 0; b < 3; ++b) {
            bool pressed = (((cur >> b) & 0x01) == 0);
            bool wasPressed = (((lastRead[panel] >> b) & 0x01) == 0);
            int teamIndex = panel * 3 + b + 1;
            
            if (teamIndex > totalTeams) continue;
            
            if (pressed && !wasPressed) {
                if (!lockActive) {
                    if (now - lastDebounceTime[teamIndex] > DEBOUNCE_MS) {
                        lastDebounceTime[teamIndex] = now;
                        lockActive = true;
                        activeTeam = teamIndex;
                        Serial.printf("[BUZZ] Team %d pressed (panel %d btn %d)\n", teamIndex, panel, b);
                        
                        setPanelLED(panel, b, true);
                        sendUpdateToServer(teamIndex, 0, true);
                    }
                }
            }
        }
        lastRead[panel] = cur;
    }
}

// ===== Jury buttons handling =====
void handleJuryButtons() {
    unsigned long now = millis();
    
    bool currentCorrect = (digitalRead(PIN_JURY_CORRECT) == LOW);
    bool currentWrong = (digitalRead(PIN_JURY_WRONG) == LOW);
    
    if (currentCorrect && !lastJuryCorrectState) {
        if (now - lastDebounceTime[12] > JURY_DEBOUNCE_MS) {
            lastDebounceTime[12] = now;
            
            if (lockActive && isTeamValid(activeTeam)) {
                Serial.printf("[JURY] Correct for team %d\n", activeTeam);
                
                int panel = (activeTeam - 1) / 3;
                int led = (activeTeam - 1) % 3;
                setPanelLED(panel, led, false);
                delay(30);
                setPanelLED(panel, led, true);
                
                sendJuryUpdateToServer(activeTeam, plusValue, "correct");
            } else {
                Serial.println("[JURY] Correct pressed but no active team");
            }
        }
    }
    lastJuryCorrectState = currentCorrect;
    
    if (currentWrong && !lastJuryWrongState) {
        if (now - lastDebounceTime[13] > JURY_DEBOUNCE_MS) {
            lastDebounceTime[13] = now;
            
            if (lockActive && isTeamValid(activeTeam)) {
                Serial.printf("[JURY] Wrong for team %d\n", activeTeam);
                
                int panel = (activeTeam - 1) / 3;
                int led = (activeTeam - 1) % 3;
                setPanelLED(panel, led, false);
                delay(80);
                setPanelLED(panel, led, true);
                delay(40);
                setPanelLED(panel, led, false);
                delay(80);
                setPanelLED(panel, led, true);
                
                sendJuryUpdateToServer(activeTeam, minusValue, "wrong");
            } else {
                Serial.println("[JURY] Wrong pressed but no active team");
            }
        }
    }
    lastJuryWrongState = currentWrong;
}

// ===== WiFiManager custom parameters =====
WiFiManagerParameter custom_server_host("host", "Server host (IP or hostname)", DEFAULT_SERVER_HOST, 64);
WiFiManagerParameter custom_server_port("port", "Server port", "443", 6);

void setupWiFiManager() {
    WiFiManager wm;
    wm.setConnectTimeout(30);
    wm.setConfigPortalTimeout(180);

    wm.addParameter(&custom_server_host);
    wm.addParameter(&custom_server_port);

    if (!wm.autoConnect(WIFI_AP_NAME)) {
        Serial.println("WiFiManager failed or timeout, restarting...");
        delay(2000);
        ESP.restart();
    }

    String hostValue = custom_server_host.getValue();
    hostValue.replace("http://", "");
    hostValue.replace("https://", "");
    
    strncpy(serverHost, hostValue.c_str(), sizeof(serverHost) - 1);
    serverHost[sizeof(serverHost) - 1] = 0;
    serverPort = atoi(custom_server_port.getValue());
    
    Serial.printf("Connected. serverHost=%s serverPort=%d\n", serverHost, serverPort);
}

void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println("QUIZ SCORING SYSTEM - DYNAMIC PCF DETECTION");
    Serial.println("Feature: Automatic PCF8574 detection (1-4 modules)");
    Serial.println("Feature: Dynamic team count based on detected modules");

    Wire.begin(21, 22);
    Wire.setClock(100000);
    Wire.setTimeOut(100);
    
    detectPCFModules();
    
    if (totalPCFCount == 0) {
        Serial.println("WARNING: No PCF8574 modules detected!");
        Serial.println("System will continue but no buttons/LEDs will work");
    }

    delay(500);

    pcfInitCaches();

    pinMode(PIN_JURY_CORRECT, INPUT_PULLUP);
    pinMode(PIN_JURY_WRONG, INPUT_PULLUP);

    lastJuryCorrectState = digitalRead(PIN_JURY_CORRECT);
    lastJuryWrongState = digitalRead(PIN_JURY_WRONG);
    
    for (int i = 0; i < 14; ++i)
        lastDebounceTime[i] = 0;

    setupWiFiManager();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("Sending initial heartbeat to server...");
        sendHeartbeatToServer();
        reportActivityToServer("controller_startup");
    }

    pollConfig();
    pollLockState();

    logToServer("ESP32 Controller Started - Dynamic PCF Detection", "startup");

    Serial.println("Setup completed successfully");
    Serial.printf("Available teams: %d (from %d PCF modules)\n", totalTeams, totalPCFCount);
}

void loop() {
    unsigned long now = millis();

    handleJuryButtons();

    if (now - lastI2CPoll >= POLL_INTERVAL) {
        lastI2CPoll = now;
        pollPCFButtons();
    }

    if (now - lastLockPoll >= LOCK_POLL_MS) {
        lastLockPoll = now;
        pollLockState();
    }

    if (now - lastWiFiCheck >= WIFI_CHECK_MS) {
        lastWiFiCheck = now;
        checkWiFiConnection();
    }

    if (now - lastConfigPoll >= CONFIG_POLL_MS) {
        lastConfigPoll = now;
        pollConfig();
    }

    if (now - lastStatusReport >= STATUS_REPORT_MS) {
        lastStatusReport = now;
        sendStatusReport();
        
        Serial.println("System running - WiFi: " + String(WiFi.status() == WL_CONNECTED ? "Connected" : "Disconnected"));
        Serial.printf("PCF Modules: %d/%d, Teams: %d\n", totalPCFCount, 4, totalTeams);
        Serial.printf("Lock: %s, Active Team: %d\n", lockActive ? "YES" : "NO", activeTeam);
    }

    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
        lastHeartbeat = now;
        sendHeartbeatToServer();
    }
}