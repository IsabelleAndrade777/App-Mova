/* =====================================================================
 *  MOVA - Firmware ESP32 (BLE + Controle Seguro + Sensor Laser VL53L0X)
 * ---------------------------------------------------------------------
 *  Compativel com o app web MOVA (mova.js) via Web Bluetooth API.
 *
 *  PROTOCOLO BLE (Characteristic Read/Write/Notify):
 *   App -> ESP : HELLO:MOVA-2026 | UP | DOWN | STOP | GOTO:<cm> | HB
 *                GET | RESET | SETLIM:<min>,<max> | SETPROX:<cm>
 *   ESP -> App : OK:HELLO | H:<cm> | P:<cm> | T:<C> | C:<A>
 *                S:IDLE|UP|DOWN|GOTO | E:<codigo> | LIM:<min>,<max>
 *
 *  CAMADAS DE SEGURANCA NO HARDWARE:
 *   1. Sensor Laser VL53L0X (Protecao de Proximidade): se alguem estiver
 *      a menos de proxMinCm (padrao 35 cm), o ESP32 bloqueia a partida
 *      ou para os motores na hora e envia "E:PROXIMITY".
 *   2. Pareamento de sessao (HELLO): ignora comandos ate autenticar.
 *   3. Watchdog de Heartbeat (HB): se o app parar de mandar "HB" por
 *      mais de 1000 ms durante um movimento, o motor desliga na hora!
 *   4. Desconexao BLE: para o motor imediatamente e volta a anunciar.
 *   5. Timeout maximo de movimento (40s continuos).
 *   6. Deteccao de travamento / obstaculo (se o sensor nao variar).
 *   7. Limites fisicos (hard limits) e configuraveis (soft limits).
 * ===================================================================== */

#include <Arduino.h>
#include <Wire.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ===================== CONFIGURACAO DE HARDWARE =====================
// Deixe true para testar o ESP32 pelo Bluetooth SEM motor/sensor ligados.
// Quando ligar o VL53L0X (I2C: SDA=21, SCL=22) e os motores, mude para false
// e instale a biblioteca "Adafruit_VL53L0X" (ou "VL53L0X" da Pololu).
#define MODO_SIMULADO true

#if !MODO_SIMULADO
  #include <Adafruit_VL53L0X.h>
  Adafruit_VL53L0X lox = Adafruit_VL53L0X();
  bool vl53Ready = false;
#endif

// Pinos sugeridos para Ponte H / Reles do motor linear
#define PIN_MOTOR_UP   25
#define PIN_MOTOR_DOWN 26

// Pinos I2C do sensor VL53L0X no ESP32
#define PIN_I2C_SDA    21
#define PIN_I2C_SCL    22

// Pinos sugeridos para sensor de altura (ex.: HC-SR04 ou segundo VL53L0X)
#define PIN_TRIG       32
#define PIN_ECHO       33

// ===================== CONFIGURACAO BLE & SEGURANCA =====================
#define DEVICE_NAME         "MOVA-001"
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define APP_KEY             "MOVA-2026"

// Limites fisicos da estrutura da mesa (cm)
const float HARD_MIN_CM = 60.0f;
const float HARD_MAX_CM = 110.0f;

// Tempos de seguranca (ms)
const unsigned long WATCHDOG_TIMEOUT_MS = 1000;  // sem HB por 1s => PARA
const unsigned long MAX_MOVE_TIME_MS    = 40000; // movimento max 40s
const unsigned long STALL_TIMEOUT_MS    = 2500;  // sem mudanca na altura => OBSTACULO

// ===================== ESTADO GLOBAL =====================
BLECharacteristic *pCharacteristic = nullptr;
bool deviceConnected = false;
bool sessionAuthed   = false;

enum MotionState { IDLE, MOVING_UP, MOVING_DOWN, MOVING_GOTO };
MotionState motion = IDLE;

float currentHeight = 74.5f;
float targetHeight  = 74.5f;
float softMin       = HARD_MIN_CM;
float softMax       = HARD_MAX_CM;

// Leituras dos sensores
float proxDistCm    = 120.0f; // Distancia lida pelo VL53L0X (cm)
float proxMinCm     = 35.0f;  // Limite de bloqueio de proximidade (cm)
float driverTempC   = 32.0f;  // Temperatura do modulo (°C)
float motorCurrentA = 0.2f;   // Corrente do motor (A)

String activeError  = "";     // "", "PROXIMITY", "WATCHDOG", "OBSTACLE", "TIMEOUT", "SENSOR"

unsigned long lastHbTime         = 0;
unsigned long moveStartTime      = 0;
unsigned long lastHeightChangeAt = 0;
float heightRefForStall          = 74.5f;
unsigned long lastLoopTick       = 0;
unsigned long lastTelemetryTick  = 0;

String pendingCmd = "";

// ===================== FUNCOES DE MOTOR E SENSORES =====================
void hardwareMotorStop() {
#if !MODO_SIMULADO
  digitalWrite(PIN_MOTOR_UP, LOW);
  digitalWrite(PIN_MOTOR_DOWN, LOW);
#endif
  motorCurrentA = 0.2f;
}

void hardwareMotorUp() {
#if !MODO_SIMULADO
  digitalWrite(PIN_MOTOR_DOWN, LOW);
  digitalWrite(PIN_MOTOR_UP, HIGH);
#endif
  motorCurrentA = 2.3f;
}

void hardwareMotorDown() {
#if !MODO_SIMULADO
  digitalWrite(PIN_MOTOR_UP, LOW);
  digitalWrite(PIN_MOTOR_DOWN, HIGH);
#endif
  motorCurrentA = 2.1f;
}

// Leitura do sensor laser VL53L0X (protecao de proximidade)
float readProximityVL53Cm() {
#if MODO_SIMULADO
  return proxDistCm;
#else
  if (!vl53Ready) return 120.0f;
  VL53L0X_RangingMeasurementData_t measure;
  lox.rangingTest(&measure, false);
  if (measure.RangeStatus != 4) { // 4 = fora de alcance (livre)
    return measure.RangeMilliMeter / 10.0f; // converte mm para cm
  }
  return 150.0f; // livre (sem obstaculo proximo)
#endif
}

float readHeightSensorCm() {
#if MODO_SIMULADO
  return currentHeight;
#else
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  long duration = pulseIn(PIN_ECHO, HIGH, 30000);
  if (duration == 0) return -1.0f;
  return duration * 0.0343f / 2.0f;
#endif
}

// ===================== ENVIO BLE =====================
void sendBle(const String &msg) {
  if (!deviceConnected || !pCharacteristic) return;
  pCharacteristic->setValue(msg.c_str());
  pCharacteristic->notify();
  Serial.println("[BLE TX] " + msg);
}

void sendStatus() {
  switch (motion) {
    case IDLE:        sendBle("S:IDLE"); break;
    case MOVING_UP:   sendBle("S:UP");   break;
    case MOVING_DOWN: sendBle("S:DOWN"); break;
    case MOVING_GOTO: sendBle("S:GOTO"); break;
  }
}

void sendHeight() {
  sendBle("H:" + String(currentHeight, 1));
}

void sendSensorsTelemetry() {
  sendBle("P:" + String((int)round(proxDistCm)));
  sendBle("T:" + String((int)round(driverTempC)));
  sendBle("C:" + String(motorCurrentA, 1));
}

void stopMotion(bool notify = true) {
  hardwareMotorStop();
  motion = IDLE;
  if (notify) {
    sendHeight();
    sendStatus();
    sendSensorsTelemetry();
  }
}

void triggerFault(const String &code) {
  hardwareMotorStop();
  motion = IDLE;
  activeError = code;
  sendBle("E:" + code);
  sendStatus();
  sendSensorsTelemetry();
  Serial.println("[FALHA SEGURANCA] " + code);
}

void startMotion(MotionState newState, float gotoTarget = 0.0f) {
  if (activeError.length() > 0) {
    sendBle("E:" + activeError);
    return;
  }
  // Bloqueio imediato pelo sensor VL53L0X se houver alguem perto
  proxDistCm = readProximityVL53Cm();
  if (proxDistCm < proxMinCm) {
    sendSensorsTelemetry();
    sendBle("E:PROXIMITY");
    return;
  }

  unsigned long now = millis();
  if (motion == IDLE) {
    moveStartTime      = now;
    lastHeightChangeAt = now;
    heightRefForStall  = currentHeight;
  }
  lastHbTime = now;
  motion     = newState;

  if (newState == MOVING_GOTO) {
    targetHeight = gotoTarget;
    if (targetHeight > currentHeight) hardwareMotorUp();
    else                              hardwareMotorDown();
  } else if (newState == MOVING_UP) {
    hardwareMotorUp();
  } else if (newState == MOVING_DOWN) {
    hardwareMotorDown();
  }
  sendStatus();
}

// ===================== PROCESSAMENTO DE COMANDOS =====================
void processCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;
  Serial.println("[BLE RX] " + cmd);

  // 1. Handshake de autenticacao
  if (cmd.startsWith("HELLO:")) {
    String key = cmd.substring(6);
    if (key == APP_KEY) {
      sessionAuthed = true;
      sendBle("OK:HELLO");
      sendBle("LIM:" + String(HARD_MIN_CM, 1) + "," + String(HARD_MAX_CM, 1));
      sendHeight();
      sendStatus();
      sendSensorsTelemetry();
      if (activeError.length() > 0) sendBle("E:" + activeError);
    } else {
      sendBle("E:AUTH");
    }
    return;
  }

  if (!sessionAuthed) {
    sendBle("E:AUTH");
    return;
  }

  // 2. Parada de emergencia tem prioridade absoluta
  if (cmd == "STOP") {
    stopMotion(true);
    return;
  }

  // 3. Heartbeat
  if (cmd == "HB") {
    lastHbTime = millis();
    return;
  }

  // 4. Consulta de estado
  if (cmd == "GET") {
    sendHeight();
    sendStatus();
    sendSensorsTelemetry();
    if (activeError.length() > 0) sendBle("E:" + activeError);
    return;
  }

  // 5. Reset de falha confirmado pelo usuario
  if (cmd == "RESET") {
    activeError = "";
    stopMotion(true);
    return;
  }

  // 6. Limite de distancia do sensor VL53L0X configurado no app
  if (cmd.startsWith("SETPROX:")) {
    float p = cmd.substring(8).toFloat();
    if (p >= 10.0f && p <= 100.0f) proxMinCm = p;
    return;
  }

  // Simulacao de aproximacao enviada pelo botao de teste do app
  if (cmd.startsWith("SIMPROX:")) {
    proxDistCm = cmd.substring(8).toFloat();
    sendSensorsTelemetry();
    if (motion != IDLE && proxDistCm < proxMinCm) {
      triggerFault("PROXIMITY");
    }
    return;
  }

  // 7. Configuracao de limites de altura (soft limits)
  if (cmd.startsWith("SETLIM:")) {
    int comma = cmd.indexOf(',', 7);
    if (comma > 7) {
      float mn = cmd.substring(7, comma).toFloat();
      float mx = cmd.substring(comma + 1).toFloat();
      if (mx - mn >= 5.0f) {
        softMin = max(HARD_MIN_CM, mn);
        softMax = min(HARD_MAX_CM, mx);
      }
    }
    return;
  }

  // 8. Comandos de movimento
  if (cmd == "UP") {
    if (currentHeight >= softMax - 0.2f) { stopMotion(true); return; }
    startMotion(MOVING_UP);
    return;
  }

  if (cmd == "DOWN") {
    if (currentHeight <= softMin + 0.2f) { stopMotion(true); return; }
    startMotion(MOVING_DOWN);
    return;
  }

  if (cmd.startsWith("GOTO:")) {
    float t = cmd.substring(5).toFloat();
    if (t < softMin || t > softMax) {
      sendBle("E:LIMIT");
      return;
    }
    if (abs(t - currentHeight) <= 0.4f) {
      stopMotion(true);
      return;
    }
    startMotion(MOVING_GOTO, t);
    return;
  }
}

// ===================== CALLBACKS BLE =====================
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) override {
    deviceConnected = true;
    sessionAuthed   = false;
    Serial.println("Cliente BLE conectado. Aguardando HELLO...");
  }

  void onDisconnect(BLEServer* pServer) override {
    deviceConnected = false;
    sessionAuthed   = false;
    hardwareMotorStop();
    motion = IDLE;
    Serial.println("Cliente BLE desconectado! Motor parado por seguranca.");
    BLEDevice::startAdvertising();
  }
};

class CharacteristicCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pChar) override {
    String val = pChar->getValue().c_str();
    if (val.indexOf("STOP") >= 0) {
      pendingCmd = "STOP";
    } else {
      pendingCmd = val;
    }
  }
};

// ===================== SETUP & LOOP =====================
void setup() {
  Serial.begin(115200);

#if !MODO_SIMULADO
  pinMode(PIN_MOTOR_UP, OUTPUT);
  pinMode(PIN_MOTOR_DOWN, OUTPUT);
  hardwareMotorStop();
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  if (lox.begin()) {
    vl53Ready = true;
    Serial.println("Sensor VL53L0X iniciado com sucesso!");
  } else {
    Serial.println("Aviso: Sensor VL53L0X nao encontrado no barramento I2C.");
  }
#endif

  BLEDevice::init(DEVICE_NAME);
  BLEServer *pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  pCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID,
    BLECharacteristic::PROPERTY_READ   |
    BLECharacteristic::PROPERTY_WRITE  |
    BLECharacteristic::PROPERTY_NOTIFY
  );

  pCharacteristic->addDescriptor(new BLE2902());
  pCharacteristic->setCallbacks(new CharacteristicCallbacks());
  pCharacteristic->setValue("S:IDLE");

  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("ESP32 MOVA pronto! Anunciando como: " + String(DEVICE_NAME));
}

void loop() {
  if (pendingCmd.length() > 0) {
    String c = pendingCmd;
    pendingCmd = "";
    processCommand(c);
  }

  unsigned long now = millis();
  if (now - lastLoopTick < 100) return; // roda a cada 100ms (10 Hz)
  lastLoopTick = now;

  // Leitura continua do sensor de proximidade VL53L0X
  proxDistCm = readProximityVL53Cm();

  // Se estiver em movimento, executa todas as verificacoes de seguranca
  if (motion != IDLE) {
    // 0. Protecao imediata do sensor VL53L0X (pessoa/objeto proximo)
    if (proxDistCm < proxMinCm) {
      triggerFault("PROXIMITY");
      return;
    }

    // 1. Watchdog de Heartbeat (se perder sinal do celular, para!)
    if (now - lastHbTime > WATCHDOG_TIMEOUT_MS) {
      triggerFault("WATCHDOG");
      return;
    }

    // 2. Tempo maximo de movimento continuo
    if (now - moveStartTime > MAX_MOVE_TIME_MS) {
      triggerFault("TIMEOUT");
      return;
    }

    // 3. Atualiza / le a altura
#if MODO_SIMULADO
    float dir = 0.0f;
    if (motion == MOVING_UP)   dir =  1.0f;
    if (motion == MOVING_DOWN) dir = -1.0f;
    if (motion == MOVING_GOTO) dir = (targetHeight > currentHeight) ? 1.0f : -1.0f;
    currentHeight += dir * 0.38f;
#else
    float measured = readHeightSensorCm();
    if (measured < 0.0f) {
      triggerFault("SENSOR");
      return;
    }
    currentHeight = measured;
#endif

    // 4. Verifica se a altura esta realmente mudando (anti-esmagamento / obstaculo)
    if (abs(currentHeight - heightRefForStall) >= 0.2f) {
      heightRefForStall  = currentHeight;
      lastHeightChangeAt = now;
    } else if (now - lastHeightChangeAt > STALL_TIMEOUT_MS) {
      triggerFault("OBSTACLE");
      return;
    }

    // 5. Verifica chegada no limite ou no alvo do GOTO
    if (motion == MOVING_UP && currentHeight >= softMax) {
      currentHeight = softMax;
      stopMotion(true);
      return;
    }
    if (motion == MOVING_DOWN && currentHeight <= softMin) {
      currentHeight = softMin;
      stopMotion(true);
      return;
    }
    if (motion == MOVING_GOTO && abs(targetHeight - currentHeight) <= 0.4f) {
      currentHeight = targetHeight;
      stopMotion(true);
      return;
    }

    if (now - lastTelemetryTick >= 200) {
      lastTelemetryTick = now;
      sendHeight();
      sendSensorsTelemetry();
    }
  } else {
    if (deviceConnected && sessionAuthed && (now - lastTelemetryTick >= 2000)) {
      lastTelemetryTick = now;
      sendHeight();
      sendSensorsTelemetry();
    }
  }
}
