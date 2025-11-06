# Quiz Scoring - JS + ESP32

Instruksi singkat:
1. Buka PowerShell:
   file lokasi
2. Install dependensi:
   npm install
3. Jalankan server:
   npm start
4. Buka browser:
   - Tampilan umum: http://localhost:8080/
   - Admin control: http://localhost:8080/admin.html

Firmware ESP32:
- Edit SSID, password, serverHost di firmware/esp32/main.cpp.
- Upload firmware ke ESP32 (PlatformIO atau Arduino IDE).
- Set pin tombol sesuai hardware.

Catatan:
- Pastikan ESP32 dan server berada dalam jaringan yang sama.
- Tambahkan autentikasi jika diperlukan.
