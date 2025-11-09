/*
  quiz-scoring.ino
  ESP32 master for Quiz Scoring system - OPTIMIZED VERSION
  - Smart polling intervals untuk menghindari rate limiting
  - Copyright © 2025 Ridwan and Team
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>

// ======= Configurable defaults =======
const char *DEFAULT_SERVER_HOST = "192.168.1.5"; // Ganti dengan URL Railway saat production
const int DEFAULT_SERVER_PORT = 8080;
const char *WIFI_AP_NAME = "Quiz_Config";

// PCF8574 I2C addresses
const uint8_t PCF_ADDR[4] = {0x20, 0x21, 0x22, 0x23};

// Pins
const int PIN_JURY_CORRECT = 4; // GPIO4
const int PIN_JURY_WRONG = 5;   // GPIO5

// SMART TIMINGS (ms) - OPTIMIZED UNTUK RATE LIMITING
const unsigned long POLL_INTERVAL = 12;     // I2C poll interval (tetap cepat)
const unsigned long DEBOUNCE_MS = 40;       // button debounce
const unsigned long JURY_DEBOUNCE_MS = 500; // jury button debounce
const unsigned long LOCK_POLL_MS = 2000;    // OPTIMIZED: 2 detik (dari 500ms)
const unsigned long CONFIG_POLL_MS = 30000; // OPTIMIZED: 30 detik (dari 60s)
const unsigned long WIFI_CHECK_MS = 15000;  // WiFi check interval
const unsigned long STATUS_REPORT_MS = 60000; // Status report interval
const unsigned long HEARTBEAT_INTERVAL = 60000; // OPTIMIZED: 60 detik (dari 30s)

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
unsigned long lastWiFiCheck = 0;
unsigned long lastStatusReport = 0;
unsigned long lastHeartbeat = 0;
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
        pcfOutCache[i] |= ((1 << 4) | (1 << 5) | (1 << 6));
        if (!writePCF(PCF_ADDR[i], pcfOutCache[i])) {
            Serial.printf("[ERROR] Failed to clear LEDs for PCF at 0x%02x\n", PCF_ADDR[i]);
        }
    }
}

// ===== HTTP helpers =====
String httpGetString(const String &url) {
    HTTPClient http;
    http.setConnectTimeout(10000);
    http.setTimeout(10000);
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

void sendAudioTriggerToServer(int team) {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[WARNING] WiFi not connected, cannot trigger audio");
        return;
    }
    
    String url = String("http://") + serverHost + ":" + String(serverPort) + "/triggerAudio?team=" + String(team);
    HTTPClient http;
    http.setConnectTimeout(10000);
    http.setTimeout(10000);
    
    Serial.printf("[AUDIO] Triggering audio for team %d\n", team);
    logToServer("Audio triggered for team " + String(team), "audio");
    http.begin(url);
    
    int code = http.GET();
    Serial.printf("[AUDIO] /triggerAudio -> code=%d team=%d\n", code, team);
    
    if (code != 200) {
        Serial.printf("[AUDIO ERROR] Failed to trigger audio: %d\n", code);
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
        // Jangan log error terus-menerus, hanya occasional
        static unsigned long lastErrorLog = 0;
        if (millis() - lastErrorLog > 10000) { // Log setiap 10 detik max
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
        logToServer("WiFi connection lost - attempting reconnect", "wifi");
        WiFi.reconnect();
        delay(1000);
        
        if (WiFi.status() == WL_CONNECTED) {
            Serial.println("[WiFi] Reconnected successfully");
            logToServer("WiFi reconnected successfully", "wifi");
            
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
    
    for (int i = 0; i < 4; ++i) {
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
        if (!readSuccess[panel]) continue;
        
        uint8_t cur = buf[panel];
        for (int b = 0; b < 3; ++b) {
            bool pressed = (((cur >> b) & 0x01) == 0);
            bool wasPressed = (((lastRead[panel] >> b) & 0x01) == 0);
            int teamIndex = panel * 3 + b + 1;
            
            if (pressed && !wasPressed) {
                if (!lockActive) {
                    if (now - lastDebounceTime[teamIndex] > DEBOUNCE_MS) {
                        lastDebounceTime[teamIndex] = now;
                        lockActive = true;
                        activeTeam = teamIndex;
                        Serial.printf("[BUZZ] Team %d pressed (panel %d btn %d)\n", teamIndex, panel, b);
                        
                        setPanelLED(panel, b, true);
                        
                        sendAudioTriggerToServer(teamIndex);
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
    
    if (digitalRead(PIN_JURY_CORRECT) == LOW) {
        if (now - lastDebounceTime[12] > JURY_DEBOUNCE_MS) {
            lastDebounceTime[12] = now;
            
            if (lockActive && activeTeam >= 1 && activeTeam <= 12) {
                Serial.printf("[JURY] Correct for team %d\n", activeTeam);
                logToServer("Jury CORRECT for team " + String(activeTeam), "jury");
                
                reportActivityToServer("jury_correct", activeTeam);
                
                sendUpdateToServer(activeTeam, plusValue, false);
            } else {
                Serial.println("[JURY] Correct pressed but no active team");
            }
        }
    }
    
    if (digitalRead(PIN_JURY_WRONG) == LOW) {
        if (now - lastDebounceTime[13] > JURY_DEBOUNCE_MS) {
            lastDebounceTime[13] = now;
            
            if (lockActive && activeTeam >= 1 && activeTeam <= 12) {
                Serial.printf("[JURY] Wrong for team %d\n", activeTeam);
                logToServer("Jury WRONG for team " + String(activeTeam), "jury");
                
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
    wm.setConfigPortalTimeout(180);

    wm.addParameter(&custom_server_host);
    wm.addParameter(&custom_server_port);

    if (!wm.autoConnect(WIFI_AP_NAME)) {
        Serial.println("WiFiManager failed or timeout, restarting...");
        delay(2000);
        ESP.restart();
    }

    strncpy(serverHost, custom_server_host.getValue(), sizeof(serverHost) - 1);
    serverHost[sizeof(serverHost) - 1] = 0;
    serverPort = atoi(custom_server_port.getValue());
    Serial.printf("Connected. serverHost=%s serverPort=%d\n", serverHost, serverPort);
}

void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println("\n🎯 QUIZ SCORING SYSTEM - OPTIMIZED VERSION");
    Serial.println("✅ Fixed: Smart rate limiting compatibility");
    Serial.println("✅ Optimized: Polling intervals untuk menghindari 429");
    Serial.println("✅ Enhanced: Error handling dan logging");

    Wire.begin(21, 22);
    Wire.setClock(100000);
    Wire.setTimeOut(100);
    
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

    delay(500);

    pcfInitCaches();

    pinMode(PIN_JURY_CORRECT, INPUT_PULLUP);
    pinMode(PIN_JURY_WRONG, INPUT_PULLUP);

    for (int i = 0; i < 14; ++i)
        lastDebounceTime[i] = 0;

    setupWiFiManager();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("[ESP32-INIT] Sending initial heartbeat to server...");
        sendHeartbeatToServer();
        reportActivityToServer("controller_startup");
    }

    pollConfig();
    pollLockState();

    logToServer("ESP32 Controller Started - System Ready", "startup");

    Serial.println("✅ Setup completed successfully");
    Serial.println("✅ System ready with optimized polling + rate limiting compatibility");
}

void loop() {
    unsigned long now = millis();

    if (now - lastI2CPoll >= POLL_INTERVAL) {
        lastI2CPoll = now;
        pollPCFButtons();
    }

    handleJuryButtons();

    if (now - lastLockPoll >= LOCK_POLL_MS) {
        lastLockPoll = now;
        pollLockState();
    }

    if (now - lastConfigPoll >= CONFIG_POLL_MS) {
        lastConfigPoll = now;
        pollConfig();
    }

    if (now - lastWiFiCheck >= WIFI_CHECK_MS) {
        lastWiFiCheck = now;
        checkWiFiConnection();
    }

    if (now - lastStatusReport >= STATUS_REPORT_MS) {
        lastStatusReport = now;
        sendStatusReport();
        
        Serial.println("[STATUS] System running - WiFi: " + String(WiFi.status() == WL_CONNECTED ? "Connected" : "Disconnected"));
        Serial.printf("[STATUS] Lock: %s, Active Team: %d\n", lockActive ? "YES" : "NO", activeTeam);
        Serial.printf("[STATUS] Config: plus=%d, minus=%d\n", plusValue, minusValue);
    }

    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
        lastHeartbeat = now;
        sendHeartbeatToServer();
    }
}