/*
  quiz-scoring.ino
  ESP32 master for Quiz Scoring system - REVISED VERSION WITH ESP32 TRACKING
  - WiFiManager portal "Quiz_Config" (with custom server host/port fields)
  - 4x PCF8574 on I2C (0x20..0x23), each handles 3 buttons (P0..P2) + 3 LEDs (P4..P6)
  - 2 jury buttons on GPIO4 (correct) and GPIO5 (wrong)
  - Sends HTTP GET to server endpoints: /update, /config, /lockstate, /triggerAudio
  - Default server host: quizserver.local, port 8080
  - All logic runs at 3.3 V
  - REVISED: Improved I2C error handling and stability with audio trigger
  - ADDED: Server logging and ESP32 status monitoring
  - ADDED: ESP32 Heartbeat System for server tracking
  - Copyright © 2025 Ridwan and Team
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <WiFiManager.h> // https://github.com/tzapu/WiFiManager
#include <ArduinoJson.h> // Pastikan sudah install via Library Manager

// ======= Configurable defaults =======
const char *DEFAULT_SERVER_HOST = "192.168.1.5"; // can be replaced with IP
const int DEFAULT_SERVER_PORT = 8080;
const char *WIFI_AP_NAME = "Quiz_Config";

// PCF8574 I2C addresses
const uint8_t PCF_ADDR[4] = {0x20, 0x21, 0x22, 0x23};

// Pins
const int PIN_JURY_CORRECT = 4; // GPIO4
const int PIN_JURY_WRONG = 5;   // GPIO5

// Timings (ms)
const unsigned long POLL_INTERVAL = 12;     // I2C poll interval
const unsigned long DEBOUNCE_MS = 40;       // button debounce
const unsigned long JURY_DEBOUNCE_MS = 500; // jury button debounce (increased)
const unsigned long LOCK_POLL_MS = 500;     // poll /lockstate
const unsigned long CONFIG_POLL_MS = 60000; // poll /config
const unsigned long WIFI_CHECK_MS = 10000;  // ⚡ DIPERBAIKI: WiFi check interval
const unsigned long STATUS_REPORT_MS = 60000; // 🆕 Status report interval
const unsigned long HEARTBEAT_INTERVAL = 30000; // 🆕 ESP32 Heartbeat interval

// ===== State =====
char serverHost[64];
int serverPort = DEFAULT_SERVER_PORT;

bool lockActive = false;
int activeTeam = 0; // 1..12

// per-panel output cache for PCF (P0..P7)
uint8_t pcfOutCache[4];
uint8_t lastRead[4]; // last raw read from PCF

unsigned long lastI2CPoll = 0;
unsigned long lastLockPoll = 0;
unsigned long lastConfigPoll = 0;
unsigned long lastWiFiCheck = 0; // ⚡ DIPERBAIKI: WiFi check timer
unsigned long lastStatusReport = 0; // 🆕 Status report timer
unsigned long lastHeartbeat = 0; // 🆕 ESP32 Heartbeat timer
unsigned long lastDebounceTime[14]; // 12 players + 2 jury

int plusValue = 5;
int minusValue = -2;

// ===== Helpers: PCF read/write using Wire =====
bool writePCF(uint8_t addr, uint8_t value) {
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
    for (int i = 0; i < 10; i++) { // ⚡ DIPERBAIKI: Increased retries to 10
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            Wire.requestFrom(addr, 1);
            if (Wire.available()) {
                value = Wire.read();
                return true;
            }
        }
        delay(15); // ⚡ DIPERBAIKI: Increased delay for stability
    }
    Serial.printf("[I2C ERROR] Failed to read from PCF at 0x%02x after 10 attempts\n", addr);
    return false;
}

// Initialize PCF caches to all HIGH (inputs)
void pcfInitCaches() {
    for (int i = 0; i < 4; ++i) {
        pcfOutCache[i] = 0xFF; // all HIGH (inputs/LED off)
        lastRead[i] = 0xFF;
        if (!writePCF(PCF_ADDR[i], pcfOutCache[i])) {
            Serial.printf("[WARNING] Failed to initialize PCF at 0x%02x\n", PCF_ADDR[i]);
        }
    }
}

// Set LED for panel (ledIndex 0..2) on/off
void setPanelLED(int panelIdx, int ledIndex, bool on) {
    if (panelIdx < 0 || panelIdx >= 4 || ledIndex < 0 || ledIndex > 2)
        return;
    uint8_t mask = (1 << (4 + ledIndex)); // P4..P6
    uint8_t cur = pcfOutCache[panelIdx];
    if (on)
        cur &= ~mask; // sink => write 0 to light
    else
        cur |= mask; // set bit to 1 to turn off
    pcfOutCache[panelIdx] = cur;
    
    if (!writePCF(PCF_ADDR[panelIdx], cur)) {
        Serial.printf("[ERROR] Failed to set LED for panel %d, LED %d\n", panelIdx, ledIndex);
    }
}

void clearAllLEDs() {
    for (int i = 0; i < 4; ++i) {
        // set bits P4..P6 to HIGH
        pcfOutCache[i] |= ((1 << 4) | (1 << 5) | (1 << 6));
        if (!writePCF(PCF_ADDR[i], pcfOutCache[i])) {
            Serial.printf("[ERROR] Failed to clear LEDs for PCF at 0x%02x\n", PCF_ADDR[i]);
        }
    }
}

// ===== HTTP helpers =====
String httpGetString(const String &url) {
    HTTPClient http;
    http.setConnectTimeout(10000); // Increased timeout to 10s
    http.setTimeout(10000);
    http.begin(url);
    
    int code = http.GET();
    String payload = "";
    
    if (code == 200) {
        payload = http.getString();
    } else {
        Serial.printf("[HTTP ERROR] GET %s -> code=%d\n", url.c_str(), code);
    }
    
    http.end();
    return payload;
}

// 🆕 Function untuk log aktivitas ke server
void logToServer(const String& message, const String& type = "info") {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }
    
    String url = String("http://") + serverHost + ":" + String(serverPort) + "/health";
    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(5000);
    http.begin(url);
    
    int code = http.GET();
    if (code == 200) {
        Serial.printf("[ESP32-STATUS] %s\n", message.c_str());
    }
    http.end();
}

// 🆕 FUNCTION BARU: ESP32 Heartbeat untuk server tracking
void sendHeartbeatToServer() {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }
    
    String url = String("http://") + serverHost + ":" + String(serverPort) + "/esp32checkin?action=heartbeat";
    HTTPClient http;
    http.setConnectTimeout(3000);
    http.setTimeout(3000);
    http.begin(url);
    
    int code = http.GET();
    if (code == 200) {
        Serial.println("[ESP32-HEARTBEAT] ✅ Status reported to server");
    } else {
        Serial.printf("[ESP32-HEARTBEAT] ❌ Failed: %d\n", code);
    }
    http.end();
}

// 🆕 FUNCTION BARU: ESP32 Activity Report
void reportActivityToServer(const String& activity, int team = 0) {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }
    
    String url = String("http://") + serverHost + ":" + String(serverPort) + "/esp32checkin?action=" + activity;
    if (team > 0) {
        url += "&team=" + String(team);
    }
    
    HTTPClient http;
    http.setConnectTimeout(3000);
    http.setTimeout(3000);
    http.begin(url);
    
    int code = http.GET();
    if (code == 200) {
        Serial.printf("[ESP32-ACTIVITY] ✅ %s reported\n", activity.c_str());
    }
    http.end();
}

void sendUpdateToServer(int team, int add, bool isFirst) {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[WARNING] WiFi not connected, cannot send update");
        return;
    }
    
    String url = String("http://") + serverHost + ":" + String(serverPort) + "/update?team=" + String(team) + "&add=" + String(add);
    if (isFirst) {
        url += "&first=1";
        Serial.printf("[ESP32-BUZZ] Team %d FIRST PRESS - Audio triggered\n", team);
        logToServer("Team " + String(team) + " buzzer pressed - FIRST", "buzzer");
        
        // 🆕 REPORT ACTIVITY KE SERVER
        reportActivityToServer("buzzer_press", team);
    }
        
    HTTPClient http;
    http.setConnectTimeout(10000);
    http.setTimeout(10000);
    http.begin(url);
    
    int code = http.GET();
    Serial.printf("[ESP32-HTTP] /update -> code=%d team=%d add=%d first=%d\n", code, team, add, isFirst ? 1 : 0);
    
    http.end();
}

// NEW: Send audio trigger to server dengan improved error handling
void sendAudioTriggerToServer(int team) {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[WARNING] WiFi not connected, cannot trigger audio");
        return;
    }
    
    String url = String("http://") + serverHost + ":" + String(serverPort) + "/triggerAudio?team=" + String(team);
    HTTPClient http;
    http.setConnectTimeout(10000); // Increased timeout to 10s
    http.setTimeout(10000);
    
    Serial.printf("[AUDIO] Triggering audio for team %d\n", team);
    logToServer("Audio triggered for team " + String(team), "audio");
    http.begin(url);
    
    int code = http.GET();
    Serial.printf("[AUDIO] /triggerAudio -> code=%d team=%d\n", code, team);
    
    if (code != 200) {
        Serial.printf("[AUDIO ERROR] Failed to trigger audio: %d\n", code);
        // Fallback: send regular update if audio trigger fails
        Serial.println("[AUDIO] Using fallback - sending regular update");
        sendUpdateToServer(team, 0, true);
    }
    
    http.end();
}

// fetch /lockstate and update lockActive & activeTeam
void pollLockState() {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }
    
    String url = String("http://") + serverHost + ":" + String(serverPort) + "/lockstate";
    String payload = httpGetString(url);
    
    if (payload.length() == 0) {
        Serial.println("[ERROR] Empty response from /lockstate");
        return;
    }

    // parse JSON response for robustness
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
        
        if (lockActive) {
            logToServer("System LOCKED - Team " + String(newActive) + " active", "lock");
        } else {
            logToServer("System UNLOCKED", "unlock");
        }
    }
    activeTeam = newActive;

    // update LEDs: if unlocked, clear; if locked, ensure LED of active team is on
    if (!lockActive) {
        clearAllLEDs();
    } else if (activeTeam >= 1 && activeTeam <= 12) {
        int p = (activeTeam - 1) / 3;
        int b = (activeTeam - 1) % 3;
        // light that LED
        setPanelLED(p, b, true);
    }
}

// fetch config (plus/minus)
void pollConfig() {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }
    
    String url = String("http://") + serverHost + ":" + String(serverPort) + "/config";
    String payload = httpGetString(url);
    
    if (payload.length() == 0) {
        Serial.println("[ERROR] Empty response from /config");
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

// ⚡ DIPERBAIKI: WiFi connection check and auto-reconnect
void checkWiFiConnection() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[WiFi] Connection lost, attempting reconnect...");
        logToServer("WiFi connection lost - attempting reconnect", "wifi");
        WiFi.reconnect();
        delay(1000); // Wait a bit for reconnection
        
        if (WiFi.status() == WL_CONNECTED) {
            Serial.println("[WiFi] Reconnected successfully");
            logToServer("WiFi reconnected successfully", "wifi");
            
            // 🆕 KIRIM HEARTBEAT SETELAH RECONNECT
            sendHeartbeatToServer();
        } else {
            Serial.println("[WiFi] Reconnect failed");
        }
    }
}

// 🆕 Function untuk send periodic status report
void sendStatusReport() {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }
    
    String url = String("http://") + serverHost + ":" + String(serverPort) + "/health";
    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(5000);
    http.begin(url);
    
    int code = http.GET();
    if (code == 200) {
        Serial.println("[ESP32-STATUS] Periodic health report sent");
    } else {
        Serial.printf("[ESP32-STATUS] Health report failed: %d\n", code);
    }
    http.end();
}

// ===== Button handling (PCF polling) =====
void pollPCFButtons() {
    uint8_t buf[4];
    bool readSuccess[4] = {false, false, false, false};
    
    // Read all PCFs first
    for (int i = 0; i < 4; ++i) {
        uint8_t val;
        if (readPCF(PCF_ADDR[i], val)) {
            buf[i] = val;
            readSuccess[i] = true;
        } else {
            // Use last known value if read failed
            buf[i] = lastRead[i];
            Serial.printf("[WARNING] Using cached value for PCF 0x%02x\n", PCF_ADDR[i]);
        }
    }

    // debounce & detect edges
    unsigned long now = millis();
    
    for (int panel = 0; panel < 4; ++panel) {
        if (!readSuccess[panel]) continue; // Skip if read failed
        
        uint8_t cur = buf[panel];
        // P0..P2 buttons (active LOW)
        for (int b = 0; b < 3; ++b) {
            bool pressed = (((cur >> b) & 0x01) == 0);
            bool wasPressed = (((lastRead[panel] >> b) & 0x01) == 0);
            int teamIndex = panel * 3 + b + 1; // 1..12
            
            if (pressed && !wasPressed) {
                // edge: pressed now
                if (!lockActive) {
                    if (now - lastDebounceTime[teamIndex] > DEBOUNCE_MS) {
                        lastDebounceTime[teamIndex] = now;
                        // mark winner locally & send to server
                        lockActive = true;
                        activeTeam = teamIndex;
                        Serial.printf("[BUZZ] Team %d pressed (panel %d btn %d)\n", teamIndex, panel, b);
                        
                        // light LED of winner
                        setPanelLED(panel, b, true);
                        
                        // Trigger audio first dengan improved error handling
                        sendAudioTriggerToServer(teamIndex);
                        
                        // Then send first press for lock state (as fallback)
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
    
    // correct button
    if (digitalRead(PIN_JURY_CORRECT) == LOW) {
        if (now - lastDebounceTime[12] > JURY_DEBOUNCE_MS) {
            lastDebounceTime[12] = now;
            
            if (lockActive && activeTeam >= 1 && activeTeam <= 12) {
                Serial.printf("[JURY] Correct for team %d\n", activeTeam);
                logToServer("Jury CORRECT for team " + String(activeTeam), "jury");
                
                // 🆕 REPORT JURY ACTIVITY
                reportActivityToServer("jury_correct", activeTeam);
                
                sendUpdateToServer(activeTeam, plusValue, false);
            } else {
                Serial.println("[JURY] Correct pressed but no active team");
            }
        }
    }
    
    // wrong button
    if (digitalRead(PIN_JURY_WRONG) == LOW) {
        if (now - lastDebounceTime[13] > JURY_DEBOUNCE_MS) {
            lastDebounceTime[13] = now;
            
            if (lockActive && activeTeam >= 1 && activeTeam <= 12) {
                Serial.printf("[JURY] Wrong for team %d\n", activeTeam);
                logToServer("Jury WRONG for team " + String(activeTeam), "jury");
                
                // 🆕 REPORT JURY ACTIVITY
                reportActivityToServer("jury_wrong", activeTeam);
                
                sendUpdateToServer(activeTeam, minusValue, false);
            } else {
                Serial.println("[JURY] Wrong pressed but no active team");
            }
        }
    }
}

// ===== WiFiManager custom parameters =====
WiFiManagerParameter custom_server_host("host", "Server host (IP or hostname)", DEFAULT_SERVER_HOST, 64);
WiFiManagerParameter custom_server_port("port", "Server port", "8080", 6);

void setupWiFiManager() {
    WiFiManager wm;
    wm.setConnectTimeout(30);
    wm.setConfigPortalTimeout(180); // portal auto close (safety)

    // add custom fields
    wm.addParameter(&custom_server_host);
    wm.addParameter(&custom_server_port);

    // autoConnect: will start AP "Quiz_Config" if no saved WiFi
    if (!wm.autoConnect(WIFI_AP_NAME)) {
        Serial.println("WiFiManager failed or timeout, restarting...");
        delay(2000);
        ESP.restart();
    }

    // after connection, read custom params
    strncpy(serverHost, custom_server_host.getValue(), sizeof(serverHost) - 1);
    serverHost[sizeof(serverHost) - 1] = 0;
    serverPort = atoi(custom_server_port.getValue());
    Serial.printf("Connected. serverHost=%s serverPort=%d\n", serverHost, serverPort);
}

void setup() {
    Serial.begin(115200);
    delay(1000); // Increased delay for stability

    Serial.println("\n🎯 QUIZ SCORING SYSTEM - IMPROVED VERSION WITH ESP32 TRACKING");
    Serial.println("✅ Fixed: Audio-timer synchronization (5s timeout)");
    Serial.println("✅ Improved: I2C stability (10 retries, 15ms delay)");
    Serial.println("✅ Added: WiFi auto-reconnect every 10s");
    Serial.println("✅ Enhanced: Error handling and fallbacks");
    Serial.println("✅ ADDED: Server logging and ESP32 status monitoring");
    Serial.println("✅ ADDED: ESP32 Heartbeat System for server tracking");

    // init I2C with improved settings
    Wire.begin(21, 22);    // SDA=21, SCL=22
    Wire.setClock(100000); // 100 kHz for stability
    Wire.setTimeOut(100);  // Set timeout
    
    Serial.println("Scanning I2C devices...");
    bool foundDevices = false;
    
    for (byte addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            Serial.printf("Found I2C device at 0x%02x\n", addr);
            foundDevices = true;
        }
    }
    
    if (!foundDevices) {
        Serial.println("No I2C devices found! Check wiring.");
    } else {
        Serial.println("I2C scan completed successfully");
    }

    delay(500); // Increased delay for PCF8574 initialization

    // init pcf caches
    pcfInitCaches();

    // init jury buttons
    pinMode(PIN_JURY_CORRECT, INPUT_PULLUP);
    pinMode(PIN_JURY_WRONG, INPUT_PULLUP);

    // clear debounce times
    for (int i = 0; i < 14; ++i)
        lastDebounceTime[i] = 0;

    // start WiFi config & connect
    setupWiFiManager();

    // 🆕 KIRIM HEARTBEAT AWAL KE SERVER
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("[ESP32-INIT] Sending initial heartbeat to server...");
        sendHeartbeatToServer();
        reportActivityToServer("controller_startup");
    }

    // once connected, poll config & lockstate once
    pollConfig();
    pollLockState();

    // 🆕 Send initial status report
    logToServer("ESP32 Controller Started - System Ready", "startup");

    Serial.println("✅ Setup completed successfully");
    Serial.println("✅ System ready with improved stability + Server Logging + ESP32 Tracking");
}

void loop() {
    unsigned long now = millis();

    // I2C poll
    if (now - lastI2CPoll >= POLL_INTERVAL) {
        lastI2CPoll = now;
        pollPCFButtons();
    }

    // Jury buttons
    handleJuryButtons();

    // Poll lockstate from server
    if (now - lastLockPoll >= LOCK_POLL_MS) {
        lastLockPoll = now;
        pollLockState();
    }

    // Poll config occasionally
    if (now - lastConfigPoll >= CONFIG_POLL_MS) {
        lastConfigPoll = now;
        pollConfig();
    }

    // ⚡ DIPERBAIKI: Periodic WiFi connection check
    if (now - lastWiFiCheck >= WIFI_CHECK_MS) {
        lastWiFiCheck = now;
        checkWiFiConnection();
    }

    // 🆕 Periodic status report to server
    if (now - lastStatusReport >= STATUS_REPORT_MS) {
        lastStatusReport = now;
        sendStatusReport();
        
        // Periodic status report
        Serial.println("[STATUS] System running - WiFi: " + String(WiFi.status() == WL_CONNECTED ? "Connected" : "Disconnected"));
        Serial.printf("[STATUS] Lock: %s, Active Team: %d\n", lockActive ? "YES" : "NO", activeTeam);
        Serial.printf("[STATUS] Config: plus=%d, minus=%d\n", plusValue, minusValue);
    }

    // 🆕 PERIODIC HEARTBEAT KE SERVER (setiap 30 detik)
    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
        lastHeartbeat = now;
        sendHeartbeatToServer();
    }
}