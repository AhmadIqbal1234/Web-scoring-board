/*
  quiz-scoring.ino
  ESP32 master for Quiz Scoring system
  - WiFiManager portal "Quiz_Config" (with custom server host/port fields)
  - 4x PCF8574 on I2C (0x20..0x23), each handles 3 buttons (P0..P2) + 3 LEDs (P4..P6)
  - 2 jury buttons on GPIO4 (correct) and GPIO5 (wrong)
  - Sends HTTP GET to server endpoints: /update, /config, /lockstate
  - Default server host: quizserver.local, port 8080
  - All logic runs at 3.3 V
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <WiFiManager.h> // https://github.com/tzapu/WiFiManager
#include <ArduinoJson.h> // Pastikan sudah install via Library Manager

// ======= Configurable defaults =======
const char *DEFAULT_SERVER_HOST = "quizserver.local"; // can be replaced with IP
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
const unsigned long LOCK_POLL_MS = 500;     // poll /lockstate
const unsigned long CONFIG_POLL_MS = 60000; // poll /config

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
unsigned long lastDebounceTime[14]; // 12 players + 2 jury

int plusValue = 5;
int minusValue = -2;

// ===== Helpers: PCF read/write using Wire =====
bool writePCF(uint8_t addr, uint8_t value)
{
    Wire.beginTransmission(addr);
    Wire.write(value);
    return (Wire.endTransmission() == 0);
}

bool readPCF(uint8_t addr, uint8_t &value)
{
    for (int i = 0; i < 3; i++)
    { // coba ulang sampai 3 kali
        Wire.requestFrom((int)addr, 1);
        if (Wire.available())
        {
            value = Wire.read();
            return true;
        }
        delay(2);
    }
    return false;
}

// Initialize PCF caches to all HIGH (inputs)
void pcfInitCaches()
{
    for (int i = 0; i < 4; ++i)
    {
        pcfOutCache[i] = 0xFF; // all HIGH (inputs/LED off)
        lastRead[i] = 0xFF;
        writePCF(PCF_ADDR[i], pcfOutCache[i]);
    }
}

// Set LED for panel (ledIndex 0..2) on/off
void setPanelLED(int panelIdx, int ledIndex, bool on)
{
    if (panelIdx < 0 || panelIdx >= 4 || ledIndex < 0 || ledIndex > 2)
        return;
    uint8_t mask = (1 << (4 + ledIndex)); // P4..P6
    uint8_t cur = pcfOutCache[panelIdx];
    if (on)
        cur &= ~mask; // sink => write 0 to light
    else
        cur |= mask; // set bit to 1 to turn off
    pcfOutCache[panelIdx] = cur;
    writePCF(PCF_ADDR[panelIdx], cur);
}

void clearAllLEDs()
{
    for (int i = 0; i < 4; ++i)
    {
        // set bits P4..P6 to HIGH
        pcfOutCache[i] |= ((1 << 4) | (1 << 5) | (1 << 6));
        writePCF(PCF_ADDR[i], pcfOutCache[i]);
    }
}

// ===== HTTP helpers =====
String httpGetString(const String &url)
{
    HTTPClient http;
    http.setConnectTimeout(3000);
    http.begin(url);
    int code = http.GET();
    String payload = "";
    if (code == 200)
    {
        payload = http.getString();
    }
    http.end();
    return payload;
}

void sendUpdateToServer(int team, int add, bool isFirst)
{
    if (WiFi.status() != WL_CONNECTED)
        return;
    String url = String("http://") + serverHost + ":" + String(serverPort) + "/update?team=" + String(team) + "&add=" + String(add);
    if (isFirst)
        url += "&first=1";
    HTTPClient http;
    http.setConnectTimeout(3000);
    http.begin(url);
    int code = http.GET();
    Serial.printf("[HTTP] /update -> code=%d team=%d add=%d first=%d\n", code, team, add, isFirst ? 1 : 0);
    http.end();
}

// fetch /lockstate and update lockActive & activeTeam
void pollLockState()
{
    if (WiFi.status() != WL_CONNECTED)
        return;
    String url = String("http://") + serverHost + ":" + String(serverPort) + "/lockstate";
    String payload = httpGetString(url);
    if (payload.length() == 0)
        return;

    // parse JSON response for robustness
    StaticJsonDocument<200> doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (err)
    {
        Serial.printf("[LOCK] json parse error: %s\n", err.c_str());
        return;
    }

    bool newLock = doc["locked"] | false;
    int newActive = 0;
    if (doc.containsKey("activeTeam") && !doc["activeTeam"].isNull())
    {
        newActive = doc["activeTeam"].as<int>();
    }

    if (newLock != lockActive)
    {
        lockActive = newLock;
        Serial.printf("[LOCK] changed -> %d active=%d\n", lockActive, newActive);
    }
    activeTeam = newActive;

    // update LEDs: if unlocked, clear; if locked, ensure LED of active team is on
    if (!lockActive)
        clearAllLEDs();
    else if (activeTeam >= 1 && activeTeam <= 12)
    {
        int p = (activeTeam - 1) / 3;
        int b = (activeTeam - 1) % 3;
        // light that LED
        setPanelLED(p, b, true);
    }
}

// fetch config (plus/minus)
void pollConfig()
{
    if (WiFi.status() != WL_CONNECTED)
        return;
    String url = String("http://") + serverHost + ":" + String(serverPort) + "/config";
    String payload = httpGetString(url);
    if (payload.length() == 0)
        return;

    StaticJsonDocument<200> doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (err)
    {
        Serial.printf("[CFG] json parse error: %s\n", err.c_str());
        return;
    }

    if (doc.containsKey("plus"))
        plusValue = doc["plus"].as<int>();
    if (doc.containsKey("minus"))
        minusValue = doc["minus"].as<int>();
    Serial.printf("[CFG] plus=%d minus=%d\n", plusValue, minusValue);
}

// ===== Button handling (PCF polling) =====
void pollPCFButtons()
{
    uint8_t buf[4];
    for (int i = 0; i < 4; ++i)
    {
        uint8_t val;
        if (readPCF(PCF_ADDR[i], val))
        {
            buf[i] = val;
        }
        else
        {
            // fallback: use lastRead
            buf[i] = lastRead[i];
        }
    }

    // debounce & detect edges
    unsigned long now = millis();
    for (int panel = 0; panel < 4; ++panel)
    {
        uint8_t cur = buf[panel];
        // P0..P2 buttons (active LOW)
        for (int b = 0; b < 3; ++b)
        {
            bool pressed = (((cur >> b) & 0x01) == 0);
            bool wasPressed = (((lastRead[panel] >> b) & 0x01) == 0);
            int teamIndex = panel * 3 + b + 1; // 1..12
            if (pressed && !wasPressed)
            {
                // edge: pressed now
                if (!lockActive)
                {
                    if (now - lastDebounceTime[teamIndex] > DEBOUNCE_MS)
                    {
                        lastDebounceTime[teamIndex] = now;
                        // mark winner locally & send to server
                        lockActive = true;
                        activeTeam = teamIndex;
                        Serial.printf("[WIN] Team %d pressed (panel %d btn %d)\n", teamIndex, panel, b);
                        // light LED of winner
                        setPanelLED(panel, b, true);
                        // send first press
                        sendUpdateToServer(teamIndex, 0, true);
                    }
                }
            }
        }
        lastRead[panel] = cur;
    }
}

// ===== Jury buttons handling =====
void handleJuryButtons()
{
    unsigned long now = millis();
    // correct
    if (digitalRead(PIN_JURY_CORRECT) == LOW)
    {
        if (now - lastDebounceTime[12] > 300)
        {
            lastDebounceTime[12] = now;
            if (lockActive && activeTeam >= 1 && activeTeam <= 12)
            {
                sendUpdateToServer(activeTeam, plusValue, false);
                // clear lock after judge
                lockActive = false;
                activeTeam = 0;
                clearAllLEDs();
            }
        }
    }
    // wrong
    if (digitalRead(PIN_JURY_WRONG) == LOW)
    {
        if (now - lastDebounceTime[13] > 300)
        {
            lastDebounceTime[13] = now;
            if (lockActive && activeTeam >= 1 && activeTeam <= 12)
            {
                sendUpdateToServer(activeTeam, minusValue, false);
                lockActive = false;
                activeTeam = 0;
                clearAllLEDs();
            }
        }
    }
}

// ===== WiFiManager custom parameters =====
WiFiManagerParameter custom_server_host("host", "Server host (IP or hostname)", DEFAULT_SERVER_HOST, 64);
WiFiManagerParameter custom_server_port("port", "Server port", "8080", 6);

void setupWiFiManager()
{
    WiFiManager wm;
    wm.setConnectTimeout(30);
    wm.setConfigPortalTimeout(180); // portal auto close (safety)

    // add custom fields
    wm.addParameter(&custom_server_host);
    wm.addParameter(&custom_server_port);

    // autoConnect: will start AP "Quiz_Config" if no saved WiFi
    if (!wm.autoConnect(WIFI_AP_NAME))
    {
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

void setup()
{
    Serial.begin(115200);
    delay(200);

    // init I2C
    Wire.begin(22, 21);    // pastikan SDA=21, SCL=22 sesuai wiring
    Wire.setClock(100000); // turunkan kecepatan jadi 100 kHz untuk stabilitas
    Serial.println("Scanning I2C devices...");
    for (byte addr = 1; addr < 127; addr++)
    {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0)
        {
            Serial.print("Found I2C device at 0x");
            Serial.println(addr, HEX);
        }
    }
    Serial.println("Scan done.");

    delay(200); // beri jeda supaya PCF8574 siap

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

    // once connected, poll config & lockstate once
    pollConfig();
    pollLockState();

    Serial.println("Setup done.");
}

void loop()
{
    unsigned long now = millis();

    // I2C poll
    if (now - lastI2CPoll >= POLL_INTERVAL)
    {
        lastI2CPoll = now;
        pollPCFButtons();
    }

    // Jury
    handleJuryButtons();

    // Poll lockstate from server
    if (now - lastLockPoll >= LOCK_POLL_MS)
    {
        lastLockPoll = now;
        pollLockState();
    }

    // Poll config occasionally
    if (now - lastConfigPoll >= CONFIG_POLL_MS)
    {
        lastConfigPoll = now;
        pollConfig();
    }
}