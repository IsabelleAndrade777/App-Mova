/* =====================================================================
 *  MOVA – App de controle da mesa ergonômica (ESP32 via Bluetooth LE)
 * ---------------------------------------------------------------------
 *  Organização:
 *   1. Configuração             7. Movimento + SEGURANÇA
 *   2. Utilidades               8. Estatísticas de ergonomia
 *   3. Armazenamento local      9. Interface (render)
 *   4. Transporte BLE real     10. Folhas, toasts, vibração
 *   5. Transporte DEMO         11. Ações (cliques)
 *   6. Conexão + protocolo     12. Inicialização (splash)
 *
 *  PROTOCOLO (texto simples, uma mensagem por escrita/notificação)
 *   App -> ESP : HELLO:<chave> | UP | DOWN | STOP | GOTO:<cm> | HB
 *                GET | RESET | SETLIM:<min>,<max>
 *   ESP -> App : OK:HELLO | H:<cm> | S:IDLE|UP|DOWN|GOTO
 *                E:<código> | LIM:<min>,<max>
 *
 *  CAMADAS DE SEGURANÇA
 *   - Homem-morto: Subir/Descer só funcionam enquanto o dedo está no botão.
 *   - Heartbeat: durante o movimento o app envia "HB" a cada 300 ms. Se o
 *     ESP ficar 1 s sem HB, ele para sozinho (perda de sinal, app travado...).
 *   - STOP tem prioridade: limpa a fila de comandos e é reenviado se falhar.
 *   - Monitor no app: para tudo se a mesa não responder, se a altura parar de
 *     mudar (obstáculo) ou se passar do tempo máximo.
 *   - App em segundo plano / tela apagada => STOP.
 *   - Limites de altura validados no app E no ESP.
 *   - Erro da mesa trava os comandos até o usuário confirmar (RESET).
 *   - Pareamento (HELLO): o ESP ignora comandos de quem não se identificou.
 *   - Bloqueio de controles e confirmação de "área livre".
 * ===================================================================== */
'use strict';

/* ============================ 1. CONFIGURAÇÃO ============================ */
const CONFIG = {
    BLE: {
        DEVICE_NAME_PREFIX: 'MOVA',
        SERVICE_UUID: '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
        CHAR_UUID:    'beb5483e-36e1-4688-b7f5-ea07361b26a8',
        APP_KEY: 'MOVA-2026',          // precisa ser IGUAL ao APP_KEY do ESP32
    },
    SAFETY: {
        HEARTBEAT_MS: 300,             // intervalo do HB durante movimento
        STATUS_TIMEOUT_MS: 2500,       // sem mensagens da mesa enquanto move => STOP
        STALL_MS: 2500,                // altura não muda enquanto move => STOP
        START_TIMEOUT_MS: 2000,        // mesa não começou a mover após o comando
        MAX_MOVE_MS: 40000,            // duração máxima de um movimento
        HANDSHAKE_TIMEOUT_MS: 4000,
        WRITE_TIMEOUT_MS: 2000,
        IDLE_PING_MS: 5000,            // pede status se a mesa ficar quieta
        MONITOR_MS: 250,
    },
    RECONNECT: { ATTEMPTS: 5, BASE_DELAY_MS: 1000 },
    STANDING_THRESHOLD_CM: 90,         // acima disso conta como "em pé"
    DEFAULT_LIMITS: { min: 60, max: 110 },
    MIN_LIMIT_SPAN: 15,
};

const ERRORS = {
    OBSTACLE:  { title: 'Obstáculo detectado',             text: 'A mesa parou porque detectou resistência ao movimento. Verifique se não há objetos, cabos ou pessoas na área de movimento.' },
    PROXIMITY: { title: 'Pessoa ou objeto muito próximo',  text: 'O sensor laser VL53L0X detectou presença na zona de risco e parou a mesa imediatamente para evitar acidentes.' },
    WATCHDOG:  { title: 'Sinal do app perdido',            text: 'A mesa parou porque deixou de receber o sinal do aplicativo durante o movimento.' },
    TIMEOUT:   { title: 'Tempo máximo excedido',           text: 'O movimento durou mais do que o permitido e foi interrompido por segurança.' },
    SENSOR:    { title: 'Falha no sensor de altura',       text: 'Não foi possível ler a altura da mesa. Não use a mesa até verificar o sensor.' },
    MOTOR:     { title: 'Falha no motor',                  text: 'Foi detectado um problema no acionamento do motor.' },
};

/* ============================ 2. UTILIDADES ============================ */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fmtH = h => (h == null || !isFinite(h)) ? '--,-' : h.toFixed(1).replace('.', ',');
const fmtCm = h => String(Math.round(h * 10) / 10).replace('.', ',');

function withTimeout(promise, ms, msg = 'Tempo esgotado') {
    let t;
    return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })])
        .finally(() => clearTimeout(t));
}
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDur(ms) {
    const m = Math.floor(Math.max(0, ms) / 60000);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min`;
}
function fmtAgo(ts) {
    if (!ts) return '—';
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'agora';
    if (m < 60) return `há ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `há ${h}h${m % 60 ? ' ' + (m % 60) + 'min' : ''}`;
    return `há ${Math.floor(h / 24)} d`;
}
function initials(name) {
    const p = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((p[0]?.[0] || 'M') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
function refreshIcons() { try { lucide.createIcons(); } catch { /* ícones são opcionais */ } }

/* ======================= 3. ARMAZENAMENTO LOCAL ======================= */
const Store = {
    get(k, def) { try { const v = localStorage.getItem('mova:' + k); return v === null ? def : JSON.parse(v); } catch { return def; } },
    set(k, v)   { try { localStorage.setItem('mova:' + k, JSON.stringify(v)); } catch { /* sem espaço */ } },
    clear()     { Object.keys(localStorage).filter(k => k.startsWith('mova:')).forEach(k => localStorage.removeItem(k)); },
};

const DEFAULT_SETTINGS = {
    userName: 'Belle Andrade',
    userSub: 'Usuária / SENAI Frederico Jacob',
    deskAlias: 'Minha Mesa',
    sitHeight: 74,
    standHeight: 105,
    limits: { ...CONFIG.DEFAULT_LIMITS },
    proxMinCm: 35,           // distância mínima de segurança do VL53L0X (cm)
    childLock: false,
    confirmClearArea: true,
    haptics: true,
    reminder: true,
    reminderMin: 50,
    darkMode: null,          // null = seguir o sistema
    demoMode: false,
};
const settings = { ...DEFAULT_SETTINGS, ...Store.get('settings', {}) };
settings.limits = { ...DEFAULT_SETTINGS.limits, ...(settings.limits || {}) };
const saveSettings = () => Store.set('settings', settings);

let presets = Store.get('presets', null) || [
    { id: 'sit',   name: 'Trabalho sentado', h: 74 },
    { id: 'stand', name: 'Trabalho em pé',   h: 105 },
];
const savePresets = () => Store.set('presets', presets);

/* ============================ ESTADO GLOBAL ============================ */
const state = {
    conn: 'disconnected',     // unsupported | disconnected | connecting | handshake | connected | reconnecting
    lastConnLost: false,
    transportKind: null,      // 'ble' | 'demo'
    deviceName: null,
    deviceLimits: null,
    height: null,             // altura REAL informada pela mesa
    displayHeight: null,      // altura animada mostrada na tela
    heightRef: null,
    proxCm: 120,              // distância lida pelo VL53L0X (cm)
    simNear: false,           // simulação rápida de pessoa próxima
    tempC: 32,                // temperatura do módulo (°C)
    currentA: 0.2,            // corrente do motor (A)
    motion: 'IDLE',           // IDLE | UP | DOWN | GOTO (informado pela mesa)
    holdDir: null,            // 'UP' | 'DOWN' enquanto o dedo está no botão
    target: null,             // alvo do GOTO
    moveStartHeight: null,
    moveStartedAt: 0,
    lastHeightChangeAt: 0,
    lastMsgAt: 0,
    lastPingAt: 0,
    error: null,
    areaConfirmedSession: false,
    activeTab: 'home',
    statsRange: 'day',
    reconnectToken: 0,
};

/* ===================== 4. TRANSPORTE BLE (ESP32 REAL) ===================== */
class BleTransport {
    static isSupported() { return !!(navigator.bluetooth && window.isSecureContext); }

    constructor(onMessage, onDisconnect) {
        this.onMessage = onMessage;
        this.onDisconnect = onDisconnect;
        this.device = null;
        this.char = null;
        this.manual = false;
        this._onValue = this._onValue.bind(this);
        this._onDisc = this._onDisc.bind(this);
    }
    get kind() { return 'ble'; }
    get name() { return this.device?.name || 'MOVA'; }

    useDevice(device) {
        if (this.device) this.device.removeEventListener('gattserverdisconnected', this._onDisc);
        this.device = device;
        device.addEventListener('gattserverdisconnected', this._onDisc);
    }

    /** Abre o seletor de dispositivos do Chrome (precisa de toque do usuário). */
    async requestAndConnect() {
        const { SERVICE_UUID, DEVICE_NAME_PREFIX } = CONFIG.BLE;
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [SERVICE_UUID] }, { namePrefix: DEVICE_NAME_PREFIX }],
            optionalServices: [SERVICE_UUID],
        });
        this.useDevice(device);
        await this.connectGatt();
    }

    async connectGatt() {
        this.manual = false;
        const server  = await this.device.gatt.connect();
        const service = await server.getPrimaryService(CONFIG.BLE.SERVICE_UUID);
        const ch      = await service.getCharacteristic(CONFIG.BLE.CHAR_UUID);
        this.char = ch;
        ch.addEventListener('characteristicvaluechanged', this._onValue);
        await ch.startNotifications();
    }

    async write(text) {
        if (!this.char || !this.device?.gatt?.connected) throw new Error('Desconectado');
        const data = encoder.encode(text);
        if (this.char.writeValueWithResponse) await this.char.writeValueWithResponse(data);
        else await this.char.writeValue(data);
    }

    _onValue(e) {
        decoder.decode(e.target.value).split(/[\r\n;]+/).map(s => s.trim()).filter(Boolean).forEach(m => this.onMessage(m));
    }
    _onDisc() { this.char = null; this.onDisconnect(this.manual); }

    disconnect() {
        this.manual = true;
        try {
            if (this.device?.gatt?.connected) this.device.gatt.disconnect();
            else this.onDisconnect(true);
        } catch { this.onDisconnect(true); }
    }
}

/* ============ 5. TRANSPORTE DEMO (simula o firmware do ESP32) ============ */
/* Implementa o MESMO protocolo e as MESMAS travas do ESP, para testar o app
 * sem hardware. Inclusive o watchdog: se o app parar de mandar HB, ela para. */
class DemoTransport {
    constructor(onMessage, onDisconnect) {
        this.onMessage = onMessage;
        this.onDisconnect = onDisconnect;
        this.h = 74.5; this.motion = 'IDLE'; this.target = null;
        this.prox = 120; this.proxMin = 35; this.temp = 32.0; this.curr = 0.2;
        this.authed = false; this.error = null; this.lastHb = 0; this.moveStart = 0;
        this.hard = { ...CONFIG.DEFAULT_LIMITS }; this.soft = { ...CONFIG.DEFAULT_LIMITS };
        this.timer = null; this.connected = false; this.tick = 0;
    }
    get kind() { return 'demo'; }
    get name() { return 'MOVA-001'; }

    async requestAndConnect() {
        await sleep(900);
        this.connected = true;
        clearInterval(this.timer);
        this.timer = setInterval(() => this._loop(), 100);
    }
    async connectGatt() { return this.requestAndConnect(); }
    async write(text) {
        await sleep(12);
        if (!this.connected) throw new Error('Desconectado');
        this._handle(text.trim());
    }
    disconnect() {
        clearInterval(this.timer);
        this.connected = false; this.authed = false; this.motion = 'IDLE';
        this.onDisconnect(true);
    }

    _emit(m) { setTimeout(() => this.connected && this.onMessage(m), 15); }
    _status() { this._emit('S:' + this.motion); }
    _telemetry() {
        this._emit(`P:${Math.round(this.prox)}`);
        this._emit(`T:${this.temp.toFixed(0)}`);
        this._emit(`C:${this.curr.toFixed(1)}`);
    }
    _handle(c) {
        if (c.startsWith('HELLO:')) {
            if (c.slice(6) !== CONFIG.BLE.APP_KEY) return this._emit('E:AUTH');
            this.authed = true;
            this._emit('OK:HELLO');
            this._emit(`LIM:${this.hard.min.toFixed(1)},${this.hard.max.toFixed(1)}`);
            this._emit('H:' + this.h.toFixed(1)); this._status(); this._telemetry();
            if (this.error) this._emit('E:' + this.error);
            return;
        }
        if (!this.authed) return this._emit('E:AUTH');
        if (c === 'STOP') return this._stop();
        if (c === 'HB') { this.lastHb = Date.now(); return; }
        if (c === 'GET') { this._emit('H:' + this.h.toFixed(1)); this._status(); this._telemetry(); if (this.error) this._emit('E:' + this.error); return; }
        if (c === 'RESET') { this.error = null; return this._status(); }
        if (c.startsWith('SETPROX:')) {
            const p = parseFloat(c.slice(8));
            if (isFinite(p) && p >= 10 && p <= 100) this.proxMin = p;
            return;
        }
        if (c.startsWith('SIMPROX:')) {
            this.prox = parseFloat(c.slice(8)) || 120;
            this._emit(`P:${Math.round(this.prox)}`);
            if (this.motion !== 'IDLE' && this.prox < this.proxMin) this._fault('PROXIMITY');
            return;
        }
        if (c.startsWith('SETLIM:')) {
            const [a, b] = c.slice(7).split(',').map(Number);
            if (isFinite(a) && isFinite(b) && b - a >= 5) this.soft = { min: Math.max(a, this.hard.min), max: Math.min(b, this.hard.max) };
            return;
        }
        if (this.error) return this._emit('E:' + this.error);
        if (this.prox < this.proxMin) return this._emit('E:PROXIMITY');
        if (c === 'UP' || c === 'DOWN') return this._start(c, null);
        if (c.startsWith('GOTO:')) {
            const t = parseFloat(c.slice(5));
            if (!isFinite(t) || t < this.soft.min || t > this.soft.max) return this._emit('E:LIMIT');
            if (Math.abs(t - this.h) <= 0.4) return this._status();
            return this._start('GOTO', t);
        }
    }
    _start(m, target) {
        if ((m === 'UP' && this.h >= this.soft.max - 0.2) || (m === 'DOWN' && this.h <= this.soft.min + 0.2)) return this._status();
        if (this.motion === 'IDLE') this.moveStart = Date.now();
        this.motion = m; this.target = target; this.lastHb = Date.now();
        this.curr = 2.4;
        this._status(); this._telemetry();
    }
    _stop() { this.motion = 'IDLE'; this.target = null; this.curr = 0.2; this._status(); this._telemetry(); }
    _fault(code) { this.motion = 'IDLE'; this.target = null; this.curr = 0.2; this.error = code; this._emit('E:' + code); this._status(); this._telemetry(); }
    _loop() {
        this.tick++;
        if (this.motion === 'IDLE') {
            this.curr = 0.2;
            if (this.authed && this.tick % 10 === 0) { this._emit('H:' + this.h.toFixed(1)); this._telemetry(); }
            return;
        }
        if (this.prox < this.proxMin) return this._fault('PROXIMITY');
        if (Date.now() - this.lastHb > 1000) return this._fault('WATCHDOG');
        if (Date.now() - this.moveStart > CONFIG.SAFETY.MAX_MOVE_MS) return this._fault('TIMEOUT');
        const dir = this.motion === 'GOTO' ? Math.sign(this.target - this.h) : (this.motion === 'UP' ? 1 : -1);
        this.h = +(this.h + dir * 0.38).toFixed(2);   // ~3,8 cm/s
        this.curr = +(2.1 + Math.sin(this.tick * 0.4) * 0.3).toFixed(1);
        let stop = false;
        if (this.h >= this.soft.max) { this.h = this.soft.max; stop = true; }
        if (this.h <= this.soft.min) { this.h = this.soft.min; stop = true; }
        if (this.motion === 'GOTO' && Math.abs(this.target - this.h) <= 0.4) { this.h = this.target; stop = true; }
        if (this.tick % 2 === 0 || stop) this._emit('H:' + this.h.toFixed(1));
        if (this.tick % 5 === 0) this._telemetry();
        if (stop) this._stop();
    }
}

/* ================= 6. CONEXÃO, FILA DE COMANDOS E PROTOCOLO ================= */
/** Fila: o GATT só aceita uma operação por vez. STOP fura a fila. */
const Link = {
    transport: null,
    queue: [],
    busy: false,
    send(cmd, { priority = false } = {}) {
        return new Promise(resolve => {
            if (!this.transport) return resolve(false);
            const item = { cmd, resolve };
            if (priority) {
                this.queue.forEach(i => i.resolve(false));   // descarta o que estava esperando
                this.queue = [item];
            } else {
                if (cmd === 'HB' && this.queue.some(i => i.cmd === 'HB')) return resolve(true);
                this.queue.push(item);
            }
            this._pump();
        });
    },
    async _pump() {
        if (this.busy) return;
        const item = this.queue.shift();
        if (!item) return;
        this.busy = true;
        try {
            if (!this.transport) throw new Error('Sem transporte');
            await withTimeout(this.transport.write(item.cmd), CONFIG.SAFETY.WRITE_TIMEOUT_MS, 'Escrita BLE expirou');
            item.resolve(true);
        } catch (err) {
            console.warn('[MOVA] Falha ao enviar', item.cmd, err?.message);
            item.resolve(false);
        } finally {
            this.busy = false;
            this._pump();
        }
    },
    reset() { this.queue.forEach(i => i.resolve(false)); this.queue = []; this.busy = false; },
};
const sendCmd = cmd => Link.send(cmd);

let handshakeTimer = null;

function setConn(c) { state.conn = c; renderConn(); }

async function connect(kind = 'ble') {
    if (['connecting', 'handshake', 'connected'].includes(state.conn)) return;
    if (kind === 'ble' && !BleTransport.isSupported()) { showUnsupportedInfo(); return; }

    state.reconnectToken++;                      // cancela reconexões antigas
    if (Link.transport) { try { Link.transport.disconnect(); } catch { } Link.transport = null; }

    const T = kind === 'demo' ? DemoTransport : BleTransport;
    const t = new T(handleMessage, manual => onTransportDisconnect(t, manual));
    setConn('connecting');
    try {
        await t.requestAndConnect();
    } catch (e) {
        setConn(BleTransport.isSupported() || kind === 'demo' ? 'disconnected' : 'unsupported');
        const msg = String(e?.message || '');
        if (/cancel/i.test(msg)) toast('Nenhuma mesa selecionada.', 'info');
        else if (/adapter|bluetooth.*(off|unavailable|not available)/i.test(msg)) toast('Ative o Bluetooth do celular e tente de novo.', 'warn', 4500);
        else toast('Não foi possível conectar: ' + msg, 'error', 5000);
        return;
    }
    attachTransport(t);
    await startHandshake();
}

function attachTransport(t) {
    Link.reset();
    Link.transport = t;
    state.transportKind = t.kind;
    state.deviceName = t.name;
    state.lastMsgAt = Date.now();
}

async function startHandshake() {
    setConn('handshake');
    clearTimeout(handshakeTimer);
    handshakeTimer = setTimeout(() => {
        if (state.conn === 'handshake') {
            toast('A mesa não respondeu ao pareamento. Verifique o firmware do ESP32.', 'error', 5000);
            disconnect();
        }
    }, CONFIG.SAFETY.HANDSHAKE_TIMEOUT_MS);
    const ok = await sendCmd('HELLO:' + CONFIG.BLE.APP_KEY);
    if (!ok && state.conn === 'handshake') { clearTimeout(handshakeTimer); toast('Falha ao parear com a mesa.', 'error'); disconnect(); }
}

function onHandshakeOk() {
    clearTimeout(handshakeTimer);
    const first = state.conn !== 'connected';
    state.lastConnLost = false;
    setConn('connected');
    sendLimitsToDevice();
    sendProxLimitToDevice();
    sendCmd('GET');
    Stats.resume();
    if (first) { toast(state.transportKind === 'demo' ? 'Modo demonstração conectado' : `Mesa ${state.deviceName} conectada`, 'success'); haptic([15, 50, 15]); }
}

function disconnect() {
    state.reconnectToken++;
    if (isMoving()) emergencyStop();
    clearTimeout(handshakeTimer);
    const t = Link.transport;
    if (t) setTimeout(() => t.disconnect(), 120);   // dá tempo do STOP sair
    else setConn(BleTransport.isSupported() ? 'disconnected' : 'unsupported');
}

function onTransportDisconnect(t, manual) {
    if (Link.transport !== t) return;              // evento de um transporte antigo
    const wasMoving = isMoving();
    resetMotionState();
    Stats.pause();
    clearTimeout(handshakeTimer);
    Link.reset();
    if (manual) {
        Link.transport = null;
        state.lastConnLost = false;
        setConn('disconnected');
        toast('Mesa desconectada.', 'info', 2000);
        return;
    }
    state.lastConnLost = true;
    toast(wasMoving ? 'Conexão perdida durante o movimento. A mesa para sozinha por segurança.' : 'Conexão com a mesa perdida.', 'warn', 4500);
    haptic([80, 60, 80]);
    tryReconnect(t);
}

async function tryReconnect(t) {
    const token = ++state.reconnectToken;
    const { ATTEMPTS, BASE_DELAY_MS } = CONFIG.RECONNECT;
    for (let i = 1; i <= ATTEMPTS; i++) {
        setConn('reconnecting');
        await sleep(BASE_DELAY_MS * Math.pow(1.6, i - 1));
        if (token !== state.reconnectToken) return;
        try {
            await withTimeout(t.connectGatt(), 6000, 'Tempo esgotado');
            if (token !== state.reconnectToken) return;
            attachTransport(t);
            await startHandshake();
            return;
        } catch (e) { console.info(`[MOVA] Reconexão ${i}/${ATTEMPTS} falhou:`, e?.message); }
    }
    if (token !== state.reconnectToken) return;
    Link.transport = null;
    setConn('disconnected');
    toast('Não foi possível reconectar. Toque em "Conectar mesa".', 'error', 5000);
}

/** Na abertura: tenta reconectar sozinho a uma mesa já autorizada (se o Chrome permitir). */
async function tryAutoReconnect() {
    if (!navigator.bluetooth?.getDevices) return false;
    try {
        const devices = await navigator.bluetooth.getDevices();
        const dev = devices.find(d => (d.name || '').startsWith(CONFIG.BLE.DEVICE_NAME_PREFIX));
        if (!dev) return false;
        const t = new BleTransport(handleMessage, manual => onTransportDisconnect(t, manual));
        t.useDevice(dev);
        setConn('connecting');
        try { await withTimeout(t.connectGatt(), 4000); }
        catch (e) { try { dev.gatt.disconnect(); } catch { } setConn('disconnected'); return false; }
        attachTransport(t);
        await startHandshake();
        return true;
    } catch { setConn('disconnected'); return false; }
}

/** Interpreta cada mensagem vinda da mesa. */
function handleMessage(msg) {
    state.lastMsgAt = Date.now();
    const i = msg.indexOf(':');
    const type = i < 0 ? msg : msg.slice(0, i);
    const val  = i < 0 ? '' : msg.slice(i + 1);

    switch (type) {
        case 'OK':  if (val === 'HELLO') onHandshakeOk(); break;
        case 'H':   onHeight(parseFloat(val)); break;
        case 'S':   onStatus(val); break;
        case 'E':   onDeviceError(val); break;
        case 'P':   onProximity(parseFloat(val)); break;
        case 'T':   { const t = parseFloat(val); if (isFinite(t)) { state.tempC = t; renderSensors(); } break; }
        case 'C':   { const c = parseFloat(val); if (isFinite(c)) { state.currentA = c; renderSensors(); } break; }
        case 'LIM': {
            const [mn, mx] = val.split(',').map(parseFloat);
            if (isFinite(mn) && isFinite(mx) && mx > mn) { state.deviceLimits = { min: mn, max: mx }; normalizeUserLimits(); renderLimits(); }
            break;
        }
        default: console.info('[MOVA] Mensagem desconhecida:', msg);
    }
}

/* ======================== 7. MOVIMENTO + SEGURANÇA ======================== */
const isMoving = () => !!state.holdDir || state.target != null || state.motion !== 'IDLE';
const isProxBlocked = () => state.proxCm != null && state.proxCm < settings.proxMinCm;

function sendProxLimitToDevice() {
    if (state.conn === 'connected') sendCmd(`SETPROX:${Math.round(settings.proxMinCm)}`);
}

function onProximity(cm) {
    if (!isFinite(cm) || cm < 0) return;
    state.proxCm = cm;
    if (isProxBlocked() && isMoving()) {
        emergencyStop(`Pessoa ou objeto a ${Math.round(cm)} cm (sensor VL53L0X). Mesa parada!`);
    }
    renderSensors();
}

function deviceLimits() { return state.deviceLimits || CONFIG.DEFAULT_LIMITS; }
function effectiveLimits() {
    const d = deviceLimits();
    return { min: Math.max(d.min, settings.limits.min), max: Math.min(d.max, settings.limits.max) };
}
function normalizeUserLimits() {
    const d = deviceLimits();
    let { min, max } = settings.limits;
    min = clamp(min, d.min, d.max - CONFIG.MIN_LIMIT_SPAN);
    max = clamp(max, min + CONFIG.MIN_LIMIT_SPAN, d.max);
    settings.limits = { min, max };
    saveSettings();
}
function sendLimitsToDevice() {
    const L = effectiveLimits();
    if (state.conn === 'connected') sendCmd(`SETLIM:${L.min.toFixed(1)},${L.max.toFixed(1)}`);
}

/** Motivo para bloquear um movimento (ou null se pode mover). */
function moveBlockReason() {
    if (state.conn !== 'connected') return 'conn';
    if (state.error) return 'error';
    if (settings.childLock) return 'lock';
    if (isProxBlocked()) return 'prox';
    if (state.height == null) return 'height';
    return null;
}
function handleBlock(reason) {
    haptic([30, 40, 30]);
    if (reason === 'conn')   { toast('Conecte a mesa primeiro.', 'warn'); nudge($('#conn-pill')); if (state.activeTab !== 'home') switchTab('home'); }
    if (reason === 'lock')   toast('Controles bloqueados. Desative em Ajustes › Segurança.', 'warn', 3500);
    if (reason === 'prox')   toast(`Movimento bloqueado pelo sensor VL53L0X: há alguém/objeto a ${Math.round(state.proxCm)} cm (mín. ${settings.proxMinCm} cm).`, 'error', 4500);
    if (reason === 'error')  showErrorOverlay(state.error);
    if (reason === 'height') { toast('Aguardando a altura da mesa…', 'info'); sendCmd('GET'); }
}
const needsAreaConfirm = () => settings.confirmClearArea && !state.areaConfirmedSession;

async function confirmClearArea() {
    const res = await Sheet.open({
        title: 'Antes de mover a mesa',
        html: `
            <div class="space-y-3">
                ${[['package-open', 'Nenhum objeto embaixo ou em cima que possa cair'],
                   ['cable', 'Cabos com folga suficiente para a mesa subir'],
                   ['baby', 'Crianças, pets e mãos longe da área de movimento']]
                  .map(([ic, t]) => `<div class="flex items-center gap-3"><div class="w-9 h-9 rounded-xl bg-teal-50 dark:bg-teal-950/50 text-teal-600 flex items-center justify-center shrink-0"><i data-lucide="${ic}" class="w-4 h-4"></i></div><p class="text-xs">${t}</p></div>`).join('')}
                <p class="text-[11px] text-slate-400">Isso é perguntado uma vez por sessão. Dá para desligar em Ajustes › Segurança.</p>
            </div>`,
        actions: [
            { label: 'Cancelar', value: 'no', kind: 'ghost' },
            { label: 'Área livre', value: 'yes', kind: 'primary', icon: 'check' },
        ],
    });
    if (res === 'yes') { state.areaConfirmedSession = true; haptic(15); return true; }
    return false;
}

/* ---- Segurar para mover (homem-morto) ---- */
function startHold(dir, btn) {
    if (state.holdDir) return;
    const block = moveBlockReason();
    if (block) return handleBlock(block);
    if (needsAreaConfirm()) {                     // não inicia automaticamente após confirmar
        confirmClearArea().then(ok => ok && toast('Pronto! Agora segure o botão para mover.', 'success', 2500));
        return;
    }
    const L = effectiveLimits();
    if (dir === 'UP' && state.height >= L.max - 0.2)   { toast('A mesa já está na altura máxima.', 'info', 1800); return; }
    if (dir === 'DOWN' && state.height <= L.min + 0.2) { toast('A mesa já está na altura mínima.', 'info', 1800); return; }

    hideMotionOverlay();
    state.target = null;
    state.holdDir = dir;
    btn.classList.add('holding');
    markMoveStart();
    haptic(12);
    sendCmd(dir);
    startHeartbeat();
    requestWakeLock();
    renderMotion();
}
function endHold() {
    if (!state.holdDir) return;
    state.holdDir = null;
    $$('.holding').forEach(b => b.classList.remove('holding'));
    sendStop();
    renderMotion();
}

/* ---- Ir para uma altura ---- */
async function goTo(target, { overlay = true } = {}) {
    if (!isFinite(target)) return;
    const block = moveBlockReason();
    if (block) return handleBlock(block);
    if (needsAreaConfirm() && !(await confirmClearArea())) return;
    if (moveBlockReason()) return;                // algo mudou enquanto a folha estava aberta

    const L = effectiveLimits();
    const clamped = clamp(Math.round(target * 2) / 2, L.min, L.max);
    if (clamped !== Math.round(target * 2) / 2) toast(`Ajustado para ${fmtCm(clamped)} cm (limite configurado).`, 'info', 2500);
    if (Math.abs(clamped - state.height) < 0.3) { toast('A mesa já está nessa altura.', 'info', 1800); return; }

    endHold();
    state.target = clamped;
    markMoveStart();
    haptic(15);
    if (overlay && Math.abs(clamped - state.height) >= 3) showMotionOverlay();
    renderMotion();
    const ok = await sendCmd('GOTO:' + clamped.toFixed(1));
    if (!ok) { emergencyStop('Não foi possível enviar o comando para a mesa.'); return; }
    startHeartbeat();
    requestWakeLock();
}

function markMoveStart() {
    const now = Date.now();
    state.moveStartedAt = now;
    state.lastHeightChangeAt = now;
    state.lastMsgAt = Math.max(state.lastMsgAt, now - 500);
    state.moveStartHeight = state.height;
}

/* ---- Parada ---- */
async function sendStop() {
    stopHeartbeat();
    if (!Link.transport) return false;
    for (let i = 0; i < 3; i++) {                 // reenvia se falhar
        if (await Link.send('STOP', { priority: true })) return true;
        await sleep(120);
    }
    return false;                                 // o watchdog do ESP para em 1 s mesmo assim
}

function emergencyStop(reason) {
    state.target = null;
    state.holdDir = null;
    $$('.holding').forEach(b => b.classList.remove('holding'));
    hideMotionOverlay();
    sendStop();
    releaseWakeLock();
    renderMotion();
    if (reason) { toast(reason, 'warn', 4500); haptic([60, 40, 60]); }
}

function resetMotionState() {
    stopHeartbeat();
    state.holdDir = null; state.target = null; state.motion = 'IDLE';
    $$('.holding').forEach(b => b.classList.remove('holding'));
    hideMotionOverlay();
    releaseWakeLock();
    renderMotion();
}

/* ---- Heartbeat ---- */
let hbTimer = null;
function startHeartbeat() {
    if (hbTimer) return;
    hbTimer = setInterval(() => {
        if (state.conn !== 'connected' || !isMoving()) return stopHeartbeat();
        sendCmd('HB');
    }, CONFIG.SAFETY.HEARTBEAT_MS);
}
function stopHeartbeat() { clearInterval(hbTimer); hbTimer = null; }

/* ---- Mensagens de estado ---- */
function onHeight(h) {
    if (!isFinite(h)) return;
    state.height = h;
    if (state.displayHeight == null) state.displayHeight = h;
    if (state.heightRef == null || Math.abs(h - state.heightRef) >= 0.2) { state.heightRef = h; state.lastHeightChangeAt = Date.now(); }

    const L = effectiveLimits();                  // trava extra: limites do usuário no app
    if (state.holdDir === 'UP' && h >= L.max)   { endHold(); toast('Limite máximo atingido.', 'info', 1800); }
    if (state.holdDir === 'DOWN' && h <= L.min) { endHold(); toast('Limite mínimo atingido.', 'info', 1800); }

    Stats.onHeight(h);
}

function onStatus(s) {
    const prev = state.motion;
    state.motion = ['UP', 'DOWN', 'GOTO'].includes(s) ? s : 'IDLE';
    if (state.motion !== 'IDLE' && prev === 'IDLE') state.lastHeightChangeAt = Date.now();

    if (state.motion === 'IDLE') {
        if (state.target != null) {
            if (state.height != null && Math.abs(state.height - state.target) <= 1) {
                toast(`Pronto! Mesa em ${fmtH(state.height)} cm`, 'success', 2500);
                haptic([15, 60, 15]);
            }
            state.target = null;
            hideMotionOverlay();
        }
        if (state.holdDir) {                      // a mesa parou sozinha (ex.: chegou no limite)
            state.holdDir = null;
            $$('.holding').forEach(b => b.classList.remove('holding'));
        }
        stopHeartbeat();
        releaseWakeLock();
    }
    renderMotion();
}

function onDeviceError(code) {
    if (code === 'AUTH') { toast('A mesa recusou o pareamento (chave diferente no ESP32).', 'error', 5000); disconnect(); return; }
    if (code === 'LIMIT') { emergencyStop(); toast('Altura fora dos limites da mesa.', 'warn'); return; }
    if (code === 'BUSY')  { toast('Outro dispositivo está controlando a mesa.', 'warn'); return; }
    state.error = code;
    resetMotionState();
    showErrorOverlay(code);
    haptic([200, 80, 200]);
}

/* ---- Monitor de segurança (roda sempre) ---- */
function safetyMonitor() {
    if (state.conn !== 'connected') return;
    const now = Date.now(), S = CONFIG.SAFETY;
    if (isMoving()) {
        if (now - state.lastMsgAt > S.STATUS_TIMEOUT_MS)
            return emergencyStop('A mesa parou de responder. Movimento interrompido.');
        if (state.motion !== 'IDLE' && now - state.lastHeightChangeAt > S.STALL_MS)
            return emergencyStop('A altura parou de mudar (possível obstáculo). Movimento interrompido.');
        if (now - state.moveStartedAt > S.MAX_MOVE_MS)
            return emergencyStop('Tempo máximo de movimento atingido.');
        if (state.motion === 'IDLE' && state.target != null && now - state.moveStartedAt > S.START_TIMEOUT_MS) {
            state.target = null; hideMotionOverlay(); stopHeartbeat(); renderMotion();
            toast('A mesa não iniciou o movimento.', 'warn');
        }
    } else if (now - state.lastMsgAt > S.IDLE_PING_MS && now - state.lastPingAt > S.IDLE_PING_MS) {
        state.lastPingAt = now;
        sendCmd('GET');
    }
}

/* ---- Manter a tela acesa durante o movimento ---- */
let wakeLock = null;
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator && !wakeLock) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
    } catch { /* opcional */ }
}
function releaseWakeLock() { try { wakeLock?.release(); } catch { } wakeLock = null; }

/* ===================== 8. ESTATÍSTICAS DE ERGONOMIA ===================== */
const Stats = {
    data: Store.get('stats', null) || { days: {}, posture: null, postureSince: null, lastChange: null, lastTick: null, lastReminder: null },
    _saveAt: 0,

    dayKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; },
    day(key) { return (this.data.days[key] ||= { sit: 0, stand: 0, switches: 0, hours: {} }); },

    /** Postura com histerese (±2 cm) para não ficar “piscando” perto do limite. */
    postureFor(h) {
        const t = CONFIG.STANDING_THRESHOLD_CM, p = this.data.posture;
        if (p === 'stand') return h < t - 2 ? 'sit' : 'stand';
        if (p === 'sit')   return h > t + 2 ? 'stand' : 'sit';
        return h >= t ? 'stand' : 'sit';
    },
    accumulate() {
        const now = Date.now(), d = this.data;
        if (d.posture && d.lastTick && state.conn === 'connected') {
            const dt = now - d.lastTick;
            if (dt > 0 && dt < 5 * 60 * 1000) {
                const day = this.day(this.dayKey());
                day[d.posture] += dt;
                const hr = new Date().getHours();
                const hh = (day.hours[hr] ||= { sit: 0, stand: 0 });
                hh[d.posture] += dt;
            }
        }
        d.lastTick = state.conn === 'connected' ? now : null;
    },
    onHeight(h) {
        this.accumulate();
        const p = this.postureFor(h);
        if (p !== this.data.posture) {
            if (this.data.posture) { this.day(this.dayKey()).switches++; this.data.lastChange = Date.now(); }
            this.data.posture = p;
            this.data.postureSince = Date.now();
            renderHomeMode();
        }
        this.save();
    },
    resume() {
        const d = this.data;
        if (!d.lastTick || Date.now() - d.lastTick > 5 * 60 * 1000) d.postureSince = Date.now();
        d.lastTick = Date.now();
    },
    pause() { this.accumulate(); this.data.lastTick = null; this.save(true); },
    save(force = false) {
        if (!force && Date.now() - this._saveAt < 10000) return;
        this._saveAt = Date.now();
        const cutoff = Date.now() - 60 * 86400000;      // guarda só 60 dias
        for (const k of Object.keys(this.data.days)) if (new Date(k + 'T00:00').getTime() < cutoff) delete this.data.days[k];
        Store.set('stats', this.data);
    },
    lastDays(n) {
        const out = [];
        for (let i = n - 1; i >= 0; i--) {
            const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() - i);
            out.push({ date, day: this.data.days[this.dayKey(date)] || { sit: 0, stand: 0, switches: 0, hours: {} } });
        }
        return out;
    },
    checkReminder() {
        const d = this.data;
        if (!settings.reminder || state.conn !== 'connected' || !d.posture || !d.postureSince || isMoving()) return;
        const now = Date.now();
        const limitMs = (d.posture === 'sit' ? settings.reminderMin : settings.reminderMin * 1.5) * 60000;
        if (now - d.postureSince < limitMs) return;
        if (d.lastReminder && now - d.lastReminder < limitMs) return;
        d.lastReminder = now;
        const mins = Math.floor((now - d.postureSince) / 60000);
        if (d.posture === 'sit') toast(`Você está sentado há ${mins} min. Que tal trabalhar em pé um pouco?`, 'tip', 9000, { label: 'Ficar em pé', fn: () => goTo(settings.standHeight) });
        else                     toast(`Você está em pé há ${mins} min. Descanse um pouco sentado.`, 'tip', 9000, { label: 'Sentar', fn: () => goTo(settings.sitHeight) });
        haptic([40, 80, 40, 80, 40]);
    },
};

/* ============================ 9. INTERFACE ============================ */
const SCREENS = ['home', 'controle', 'ergonomia', 'configuracoes', 'sensores', 'conexao', 'seguranca'];
const SUB_TO_NAV = { sensores: 'configuracoes', conexao: 'configuracoes', seguranca: 'configuracoes' };

function switchTab(tab) {
    if (!SCREENS.includes(tab)) return;
    const changed = tab !== state.activeTab;
    state.activeTab = tab;
    const navTab = SUB_TO_NAV[tab] || tab;
    SCREENS.forEach(id => {
        $('#screen-' + id)?.classList.toggle('hidden', id !== tab);
    });
    ['home', 'controle', 'ergonomia', 'configuracoes'].forEach(id => {
        $('#nav-' + id)?.classList.toggle('nav-active', id === navTab);
    });
    $('#app-screens').scrollTop = 0;
    moveNavIndicator();
    if (tab === 'ergonomia') renderStats();
    if (tab === 'sensores' || tab === 'seguranca') renderSensors();
    if (tab === 'conexao') renderConnectionScreen();
    if (changed) haptic(6);
}
function moveNavIndicator() {
    const navTab = SUB_TO_NAV[state.activeTab] || state.activeTab;
    const btn = $('#nav-' + navTab), ind = $('#nav-indicator');
    if (!btn || !ind) return;
    ind.style.transform = `translateX(${btn.offsetLeft + btn.offsetWidth / 2 - ind.offsetWidth / 2}px)`;
}

function setIcon(el, name, cls = 'w-5 h-5') { if (!el) return; el.innerHTML = `<i data-lucide="${name}" class="${cls}"></i>`; refreshIcons(); }
function nudge(el) { if (!el) return; el.classList.remove('attn'); void el.offsetWidth; el.classList.add('attn'); }

const CONN_UI = {
    unsupported:  { text: 'Bluetooth indisponível', dot: 'bg-slate-400 text-slate-400', pulse: false },
    disconnected: { text: 'Desconectada',            dot: 'bg-red-400 text-red-400',     pulse: false },
    connecting:   { text: 'Conectando…',             dot: 'bg-amber-400 text-amber-400', pulse: true },
    handshake:    { text: 'Pareando…',               dot: 'bg-amber-400 text-amber-400', pulse: true },
    reconnecting: { text: 'Reconectando…',           dot: 'bg-amber-400 text-amber-400', pulse: true },
    connected:    { text: 'Conectada via Bluetooth', dot: 'bg-emerald-500 text-emerald-500', pulse: true },
};

function renderConn() {
    const c = state.conn, ui = CONN_UI[c], connected = c === 'connected', busy = ['connecting', 'handshake', 'reconnecting'].includes(c);
    document.body.classList.toggle('is-connected', connected);

    $('#conn-text').textContent = ui.text;
    $('#conn-dot').className = `w-2 h-2 rounded-full ${ui.dot} ${ui.pulse ? 'dot-pulse' : ''}`;
    $('#demo-badge').classList.toggle('hidden', !(connected && state.transportKind === 'demo'));

    // Cartão de conexão
    const card = $('#connect-card');
    card.classList.toggle('hidden', connected);
    const btn = $('#connect-btn');
    btn.disabled = busy;
    btn.classList.toggle('opacity-70', busy);
    if (c === 'unsupported') {
        $('#connect-title').textContent = 'Bluetooth indisponível aqui';
        $('#connect-text').textContent = 'Abra o app no Google Chrome do Android, por um endereço HTTPS.';
        btn.innerHTML = '<i data-lucide="info" class="w-4 h-4"></i><span>Como usar</span>';
    } else if (busy) {
        $('#connect-title').textContent = c === 'reconnecting' ? 'Reconectando…' : 'Conectando à mesa…';
        $('#connect-text').textContent = 'Mantenha o celular perto da mesa.';
        btn.innerHTML = '<i data-lucide="loader-circle" class="w-4 h-4 spin"></i><span>Aguarde</span>';
    } else {
        $('#connect-title').textContent = 'Conecte sua mesa';
        $('#connect-text').textContent = 'Ligue a mesa MOVA, ative o Bluetooth e aproxime o celular.';
        btn.innerHTML = '<i data-lucide="bluetooth-searching" class="w-4 h-4"></i><span>Conectar mesa</span>';
    }

    // Ajustes
    const devCode = state.deviceName || 'MOVA-001';
    $('#ble-status-text').textContent = connected ? `${settings.deskAlias} • Conectada` : ui.text;
    if ($('#cfg-desk-code')) $('#cfg-desk-code').textContent = devCode;
    if ($('#home-desk-name')) $('#home-desk-name').textContent = connected ? `${settings.deskAlias} (${devCode})` : 'Toque p/ conectar';
    const bi = $('#ble-icon');
    if (bi) {
        bi.className = `w-9 h-9 rounded-xl flex items-center justify-center ${connected ? 'bg-teal-50 dark:bg-teal-950/50 text-teal-600' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`;
        setIcon(bi, connected ? 'bluetooth-connected' : c === 'unsupported' ? 'bluetooth-off' : 'bluetooth', 'w-4 h-4');
    }

    if (!connected && state.conn !== 'reconnecting') { state.height = null; }
    renderMotion();
    renderHomeMode();
    renderSensors();
    renderConnectionScreen();
    refreshIcons();
}

function renderConnectionScreen() {
    const c = state.conn, connected = c === 'connected', busy = ['connecting', 'handshake', 'reconnecting'].includes(c);
    const devCode = state.deviceName || 'MOVA-001';
    if ($('#conn-Alias-title')) $('#conn-Alias-title').textContent = settings.deskAlias || 'Minha Mesa';
    if ($('#conn-device-code')) $('#conn-device-code').textContent = devCode + (connected && state.transportKind === 'demo' ? ' • Simulação' : '');

    const st = $('#conn-screen-state'), dot = $('#conn-screen-dot'), bdg = $('#conn-screen-badge');
    if (st && dot && bdg) {
        if (connected) {
            st.textContent = 'Conectada';
            dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 dot-pulse';
            bdg.className = 'inline-flex items-center gap-1.5 font-semibold text-emerald-600 dark:text-emerald-400';
        } else if (busy) {
            st.textContent = c === 'reconnecting' ? 'Reconectando…' : 'Conectando…';
            dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 dot-pulse';
            bdg.className = 'inline-flex items-center gap-1.5 font-semibold text-amber-500';
        } else {
            st.textContent = state.lastConnLost ? 'Conexão perdida' : 'Desconectada';
            dot.className = 'w-2.5 h-2.5 rounded-full bg-red-400';
            bdg.className = 'inline-flex items-center gap-1.5 font-semibold text-slate-500';
        }
    }
    const discBtn = $('#conn-disconnect-btn');
    if (discBtn) {
        discBtn.disabled = !connected && !busy;
        discBtn.classList.toggle('opacity-50', !connected && !busy);
    }

    // Linha do tempo (Procurando -> Conectando -> Conectada -> Conexão perdida)
    const s1 = $('#tl-step-1'), s2 = $('#tl-step-2'), s3 = $('#tl-step-3'), s4 = $('#tl-step-4');
    const t1 = $('#tl-text-1'), t2 = $('#tl-text-2'), t3 = $('#tl-text-3'), t4 = $('#tl-text-4');
    const l1 = $('#tl-line-1'), l2 = $('#tl-line-2');
    if (!s1) return;

    const doneStep = 'w-5 h-5 rounded-full flex items-center justify-center bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 text-[10px] z-10';
    const actStep  = 'w-5 h-5 rounded-full flex items-center justify-center bg-emerald-500 text-white text-[10px] z-10 dot-pulse';
    const idleStep = 'w-5 h-5 rounded-full flex items-center justify-center border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-400 text-[10px] z-10';

    if (connected) {
        s1.className = doneStep; t1.className = 'text-xs text-slate-500 dark:text-slate-400';
        s2.className = 'w-5 h-5 rounded-full flex items-center justify-center bg-emerald-500 text-white text-[10px] z-10';
        t2.className = 'text-xs text-slate-500 dark:text-slate-400';
        s3.className = 'w-6 h-6 -ml-0.5 rounded-full flex items-center justify-center bg-teal-700 text-white z-10';
        t3.className = 'text-xs font-bold text-teal-700 dark:text-teal-400';
        s4.className = idleStep; t4.className = 'text-xs text-slate-400';
        l1.className = 'absolute left-2.5 top-5 w-0.5 h-6 bg-teal-600';
        l2.className = 'absolute left-2.5 top-5 w-0.5 h-6 bg-teal-600';
    } else if (busy) {
        s1.className = doneStep; t1.className = 'text-xs font-semibold text-slate-700 dark:text-slate-200';
        s2.className = actStep;  t2.className = 'text-xs font-bold text-emerald-600 dark:text-emerald-400';
        s3.className = 'w-6 h-6 -ml-0.5 rounded-full flex items-center justify-center border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-400 z-10';
        t3.className = 'text-xs text-slate-400';
        s4.className = idleStep; t4.className = 'text-xs text-slate-400';
        l1.className = 'absolute left-2.5 top-5 w-0.5 h-6 bg-teal-600';
        l2.className = 'absolute left-2.5 top-5 w-0.5 h-6 bg-slate-200 dark:bg-slate-700';
    } else if (state.lastConnLost) {
        s1.className = idleStep; t1.className = 'text-xs text-slate-400';
        s2.className = idleStep; t2.className = 'text-xs text-slate-400';
        s3.className = 'w-6 h-6 -ml-0.5 rounded-full flex items-center justify-center border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-400 z-10';
        t3.className = 'text-xs text-slate-400';
        s4.className = 'w-5 h-5 rounded-full flex items-center justify-center bg-red-500 text-white text-[10px] font-bold z-10';
        t4.className = 'text-xs font-bold text-red-500';
        l1.className = 'absolute left-2.5 top-5 w-0.5 h-6 bg-slate-200 dark:bg-slate-700';
        l2.className = 'absolute left-2.5 top-5 w-0.5 h-6 bg-slate-200 dark:bg-slate-700';
    } else {
        s1.className = actStep;  t1.className = 'text-xs font-semibold text-slate-700 dark:text-slate-200';
        s2.className = idleStep; t2.className = 'text-xs text-slate-400';
        s3.className = 'w-6 h-6 -ml-0.5 rounded-full flex items-center justify-center border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-400 z-10';
        t3.className = 'text-xs text-slate-400';
        s4.className = idleStep; t4.className = 'text-xs text-slate-400';
        l1.className = 'absolute left-2.5 top-5 w-0.5 h-6 bg-slate-200 dark:bg-slate-700';
        l2.className = 'absolute left-2.5 top-5 w-0.5 h-6 bg-slate-200 dark:bg-slate-700';
    }
}

function renderSensors() {
    const blocked = isProxBlocked();
    const dist = state.proxCm != null ? Math.round(state.proxCm) : 120;
    const minCm = settings.proxMinCm;

    // Cartão VL53L0X na aba Sensores
    if ($('#vl53-dist-value')) $('#vl53-dist-value').textContent = `${dist} cm`;
    if ($('#vl53-min-label'))  $('#vl53-min-label').textContent = `${minCm} cm`;
    const stTxt = $('#vl53-status-text'), bar = $('#vl53-bar'), icWrap = $('#vl53-icon-wrap'), simBtn = $('#sim-prox-btn');
    if (stTxt && bar && icWrap) {
        const pct = clamp((dist / 150) * 100, 6, 100);
        bar.style.width = `${pct}%`;
        if (blocked) {
            stTxt.textContent = 'Pessoa/objeto próximo • Bloqueado!';
            stTxt.className = 'text-sm font-bold text-red-400 mt-0.5';
            bar.className = 'h-full bg-red-500 rounded-full transition-all duration-300';
            icWrap.className = 'w-12 h-12 rounded-full bg-red-500/20 border border-red-400/50 flex items-center justify-center text-red-400';
        } else {
            stTxt.textContent = 'Livre • Proteção ativa';
            stTxt.className = 'text-sm font-bold text-teal-400 mt-0.5';
            bar.className = 'h-full bg-teal-400 rounded-full transition-all duration-300';
            icWrap.className = 'w-12 h-12 rounded-full bg-teal-500/15 border border-teal-400/40 flex items-center justify-center text-teal-400';
        }
    }
    if (simBtn) simBtn.textContent = blocked ? 'Liberar área (120 cm)' : 'Simular pessoa perto';

    // Resumo na Home e Ajustes
    if ($('#home-prox-text')) {
        $('#home-prox-text').textContent = blocked ? `Bloqueado (${dist} cm)` : `Livre (${dist} cm)`;
        $('#home-prox-text').className = `text-xs font-bold block truncate ${blocked ? 'text-red-500' : ''}`;
    }
    if ($('#home-prox-icon')) {
        $('#home-prox-icon').className = `p-2.5 rounded-xl ${blocked ? 'bg-red-50 dark:bg-red-950/50 text-red-500' : 'bg-teal-50 dark:bg-teal-950/50 text-teal-600 dark:text-teal-400'}`;
    }
    if ($('#cfg-prox-badge')) {
        $('#cfg-prox-badge').textContent = blocked ? 'Bloqueado' : 'Livre';
        $('#cfg-prox-badge').className = blocked
            ? 'text-red-600 dark:text-red-400 text-[10px] bg-red-50 dark:bg-red-950 px-2 py-0.5 rounded-full'
            : 'text-emerald-600 dark:text-emerald-400 text-[10px] bg-emerald-50 dark:bg-emerald-950 px-2 py-0.5 rounded-full';
    }

    // Demais sensores na Tela 7
    if ($('#sens-height-val'))    $('#sens-height-val').textContent = state.height != null ? `${fmtH(state.height)} cm` : '74,5 cm';
    if ($('#sens-height-status')) $('#sens-height-status').textContent = state.error === 'SENSOR' ? 'Falha' : 'Normal';
    if ($('#sens-temp-val'))      $('#sens-temp-val').textContent = `${Math.round(state.tempC)}°C`;
    if ($('#sens-curr-val'))      $('#sens-curr-val').textContent = `${state.currentA.toFixed(1).replace('.', ',')} A`;
    if ($('#sens-motor-status'))  $('#sens-motor-status').textContent = state.error === 'MOTOR' ? 'Falha' : 'Operacional';
    if ($('#sens-motor-sub'))     $('#sens-motor-sub').textContent = isMoving() ? 'Em movimento' : 'Em espera';
    if ($('#sens-safety-status')) $('#sens-safety-status').textContent = blocked ? 'Bloqueio preventivo' : 'Ativo';

    // Tela 9: Sistema de Segurança
    const L = effectiveLimits();
    if ($('#safe-min-label')) $('#safe-min-label').textContent = `${Math.round(L.min)} cm ›`;
    if ($('#safe-max-label')) $('#safe-max-label').textContent = `${Math.round(L.max)} cm ›`;
    if ($('#prox-limit-val')) $('#prox-limit-val').textContent = `${minCm} cm`;
    const spLbl = $('#safe-prox-label'), spChk = $('#safe-prox-check');
    if (spLbl && spChk) {
        spLbl.textContent = blocked ? `Alerta (${dist} cm) ›` : `Livre (${dist} cm) ›`;
        spLbl.className = blocked ? 'text-red-500 font-bold' : 'text-emerald-600 font-semibold';
        spChk.className = `w-5 h-5 rounded-full text-white flex items-center justify-center ${blocked ? 'bg-amber-500' : 'bg-emerald-600'}`;
    }
    const heroTitle = $('#safety-hero-title'), heroSub = $('#safety-hero-sub'), heroIcon = $('#safety-hero-icon');
    if (heroTitle && heroSub && heroIcon) {
        if (blocked) {
            heroTitle.textContent = 'PROTEÇÃO ACIONADA';
            heroSub.textContent = `O sensor VL53L0X detectou presença a ${dist} cm. Movimento bloqueado.`;
            heroIcon.className = 'w-16 h-16 rounded-2xl bg-amber-50 dark:bg-amber-950/60 text-amber-500 flex items-center justify-center mb-3';
        } else if (state.error) {
            heroTitle.textContent = 'ALERTA DE SEGURANÇA';
            heroSub.textContent = ERRORS[state.error]?.title || 'Verifique a mesa antes de operar.';
            heroIcon.className = 'w-16 h-16 rounded-2xl bg-red-50 dark:bg-red-950/60 text-red-500 flex items-center justify-center mb-3';
        } else {
            heroTitle.textContent = 'ATIVO';
            heroSub.textContent = 'Tudo funcionando corretamente.';
            heroIcon.className = 'w-16 h-16 rounded-2xl bg-teal-50 dark:bg-teal-950/60 text-teal-700 dark:text-teal-400 flex items-center justify-center mb-3';
        }
    }
}

function motionLabel() {
    if (state.conn !== 'connected') return CONN_UI[state.conn].text.replace(' via Bluetooth', '');
    if (state.error) return 'Parada por segurança';
    if (isProxBlocked()) return `Bloqueado (${Math.round(state.proxCm)} cm)`;
    if (settings.childLock) return 'Controles bloqueados';
    if (state.target != null) return `Indo para ${fmtCm(state.target)} cm`;
    const m = state.motion !== 'IDLE' ? state.motion : state.holdDir;
    if (m === 'UP') return 'Subindo…';
    if (m === 'DOWN') return 'Descendo…';
    if (m === 'GOTO') return 'Ajustando…';
    return 'Parada';
}
function renderMotion() {
    const label = motionLabel();
    const moving = isMoving() && state.conn === 'connected';
    const ds = $('#dash-status');
    ds.textContent = label;
    ds.className = `mt-2 text-[11px] font-semibold px-2 py-0.5 rounded-full ${moving ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-300' : (state.error || isProxBlocked()) ? 'bg-red-100 text-red-600 dark:bg-red-950/60 dark:text-red-400' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`;
    $('#ctrl-status').textContent = label;
    $('#gauge-wrap').classList.toggle('moving', moving);
    document.body.classList.toggle('is-locked', settings.childLock || isProxBlocked());
    renderSensors();

    const tl = $('#lv-target');
    if (state.target != null) { tl.setAttribute('y1', deskY(state.target)); tl.setAttribute('y2', deskY(state.target)); tl.setAttribute('opacity', '1'); }
    else tl.setAttribute('opacity', '0');
}

/* Altura animada (interpolação suave a cada quadro) */
function deskPct(h) { const d = deviceLimits(); return clamp((h - d.min) / (d.max - d.min), 0, 1); }
function deskY(h) { return 42 + (1 - deskPct(h)) * 58; }  // y do tampo na mesa ao vivo
let lastRendered = null;
function animationLoop() {
    const target = state.height;
    if (target != null) {
        if (state.displayHeight == null) state.displayHeight = target;
        const diff = target - state.displayHeight;
        state.displayHeight = Math.abs(diff) < 0.02 ? target : state.displayHeight + diff * 0.18;
    }
    const shown = state.height == null ? null : state.displayHeight;
    if (shown !== lastRendered) { lastRendered = shown; renderHeight(shown); }
    requestAnimationFrame(animationLoop);
}
function renderHeight(h) {
    const txt = fmtH(h);
    $('#dash-height').textContent = txt;
    $('#ctrl-height').textContent = txt;
    $('#motion-height').textContent = txt;
    const pct = h == null ? 0 : deskPct(h);
    $('#gauge-progress').setAttribute('stroke-dasharray', `${(pct * 197.92).toFixed(2)} 263.89`);
    const off = (1 - pct) * 58;
    $$('.live-desk').forEach(g => { g.style.transform = `translateY(${off}px)`; });

    if (state.target != null && h != null && state.moveStartHeight != null) {
        const total = Math.abs(state.target - state.moveStartHeight) || 1;
        const prog = clamp(1 - Math.abs(state.target - h) / total, 0, 1);
        $('#motion-ring').style.strokeDashoffset = (276.46 * (1 - prog)).toFixed(2);
    }
}

function showMotionOverlay() {
    const o = $('#motion-overlay');
    $('#motion-target').textContent = fmtCm(state.target);
    $('#motion-ring').style.strokeDashoffset = '276.46';
    setIcon($('#motion-dir'), state.target > state.height ? 'arrow-up' : 'arrow-down', 'w-5 h-5');
    o.classList.remove('hidden'); o.classList.add('flex');
}
function hideMotionOverlay() { const o = $('#motion-overlay'); o.classList.add('hidden'); o.classList.remove('flex'); }

function showErrorOverlay(code) {
    const e = ERRORS[code] || { title: 'Mesa parada por segurança', text: 'A mesa informou um problema e parou o movimento.' };
    $('#error-title').textContent = e.title;
    $('#error-text').textContent = e.text;
    $('#error-code').textContent = code;
    const o = $('#error-overlay');
    o.classList.remove('hidden'); o.classList.add('flex');
    refreshIcons();
}
function hideErrorOverlay() { const o = $('#error-overlay'); o.classList.add('hidden'); o.classList.remove('flex'); }

function renderGreeting() {
    const h = new Date().getHours();
    const g = h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
    $('#greet-text').textContent = `${g}, ${settings.userName.split(' ')[0] || 'você'}`;
    const t = new Date();
    $('#sb-time').textContent = `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`;
}
function renderProfile() {
    const ini = initials(settings.userName);
    $('#home-initials').textContent = ini;
    $('#profile-initials').textContent = ini;
    $('#profile-name').textContent = settings.userName;
    $('#profile-sub').textContent = settings.userSub;
    $('#home-sit-h').textContent = fmtCm(settings.sitHeight);
    $('#home-stand-h').textContent = fmtCm(settings.standHeight);
    renderGreeting();
}
function renderHomeMode() {
    const d = Stats.data, connected = state.conn === 'connected';
    if (!connected || !d.posture) {
        $('#mode-title').textContent = '—';
        $('#mode-time').textContent = 'Conecte a mesa para acompanhar';
        return;
    }
    const sit = d.posture === 'sit';
    $('#mode-title').textContent = sit ? 'Trabalho sentado' : 'Trabalho em pé';
    $('#mode-time').textContent = 'Há ' + fmtDur(Date.now() - d.postureSince);
    const mi = $('#mode-icon');
    mi.className = `p-3 rounded-xl ${sit ? 'bg-teal-50 dark:bg-teal-950/50 text-teal-600 dark:text-teal-400' : 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400'}`;
    setIcon(mi, sit ? 'armchair' : 'person-standing', 'w-6 h-6');
}

function renderPresets() {
    const list = $('#preset-list');
    if (!presets.length) {
        list.innerHTML = `<p class="text-xs text-slate-400 text-center py-4">Nenhuma posição salva ainda.</p>`;
        return;
    }
    list.innerHTML = presets.map(p => `
        <div data-action="goto" data-value="${p.h}" class="needs-conn press cursor-pointer bg-white dark:bg-slate-900 p-3.5 rounded-2xl border border-slate-100 dark:border-slate-800 flex items-center justify-between hover:border-teal-500 transition-colors">
            <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-xl ${p.h >= CONFIG.STANDING_THRESHOLD_CM ? 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600' : 'bg-teal-50 dark:bg-teal-950/50 text-teal-600'} flex items-center justify-center">
                    <i data-lucide="${p.h >= CONFIG.STANDING_THRESHOLD_CM ? 'person-standing' : 'armchair'}" class="w-4 h-4"></i>
                </div>
                <div>
                    <h4 class="text-xs font-bold">${escapeHtml(p.name)}</h4>
                    <span class="text-[11px] text-slate-400">${fmtCm(p.h)} cm</span>
                </div>
            </div>
            <div class="flex items-center gap-1">
                <button data-action="delete-preset" data-id="${escapeHtml(p.id)}" class="p-2 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30" aria-label="Apagar"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                <i data-lucide="chevron-right" class="w-4 h-4 text-slate-400"></i>
            </div>
        </div>`).join('');
    refreshIcons();
}

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
function renderStats() {
    Stats.accumulate();
    const range = state.statsRange;
    $$('.range-btn').forEach(b => {
        const on = b.dataset.range === range;
        b.className = `range-btn px-2.5 py-1 rounded-lg transition ${on ? 'bg-white dark:bg-slate-700 shadow-sm' : 'text-slate-500'}`;
    });
    const n = range === 'day' ? 1 : range === 'week' ? 7 : 30;
    const days = Stats.lastDays(n);
    const tot = days.reduce((a, d) => ({ sit: a.sit + d.day.sit, stand: a.stand + d.day.stand, sw: a.sw + d.day.switches }), { sit: 0, stand: 0, sw: 0 });
    $('#stat-sit').textContent = fmtDur(tot.sit);
    $('#stat-stand').textContent = fmtDur(tot.stand);
    $('#stat-switches').textContent = `${tot.sw} ${tot.sw === 1 ? 'vez' : 'vezes'}`;
    $('#stat-last').textContent = fmtAgo(Stats.data.lastChange);

    let buckets;
    if (range === 'day') {
        const d = days[0].day;
        buckets = [];
        for (let h = 6; h < 22; h += 2) {
            const a = d.hours[h] || { sit: 0, stand: 0 }, b = d.hours[h + 1] || { sit: 0, stand: 0 };
            buckets.push({ label: h + 'h', sit: a.sit + b.sit, stand: a.stand + b.stand });
        }
    } else {
        buckets = days.map((d, i) => ({
            label: range === 'week' ? WEEKDAYS[d.date.getDay()] : ((n - 1 - i) % 5 === 0 ? String(d.date.getDate()) : ''),
            sit: d.day.sit, stand: d.day.stand,
        }));
    }
    const max = Math.max(...buckets.map(b => b.sit + b.stand), 0);
    $('#chart-empty').classList.toggle('hidden', max > 0);
    $('#chart').style.gap = range === 'month' ? '2px' : '';
    $('#chart').innerHTML = buckets.map(b => {
        const sp = max ? (b.sit / max) * 100 : 0, st = max ? (b.stand / max) * 100 : 0;
        return `<div class="flex-1 h-full flex flex-col items-center gap-1 min-w-0">
            <div class="w-full flex-1 flex flex-col justify-end">
                <div class="bar w-full bg-indigo-500 rounded-t-md" style="height:0" data-h="${st}"></div>
                <div class="bar w-full bg-teal-500 ${st ? '' : 'rounded-t-md'}" style="height:0" data-h="${sp}"></div>
            </div>
            <span class="text-[9px] text-slate-400 h-3 leading-3">${b.label}</span>
        </div>`;
    }).join('');
    requestAnimationFrame(() => requestAnimationFrame(() => $$('#chart .bar').forEach(el => { el.style.height = el.dataset.h + '%'; })));
    $('#ergo-tip').textContent = tipText();
}
function tipText() {
    const d = Stats.data;
    if (state.conn !== 'connected' || !d.posture) return 'Conecte a mesa para receber dicas baseadas no seu uso real.';
    const mins = Math.floor((Date.now() - d.postureSince) / 60000);
    if (d.posture === 'sit') return mins >= settings.reminderMin
        ? `Você está há ${mins} minutos sentado. Que tal trabalhar em pé por 15 minutos?`
        : `Sentado há ${mins} min. Bom ritmo! O ideal é alternar a cada ${settings.reminderMin} min.`;
    return mins >= 60 ? `Você está em pé há ${mins} min. Descanse um pouco sentado.`
                      : `Em pé há ${mins} min. Ombros relaxados e joelhos destravados.`;
}

function renderLimits() {
    const d = deviceLimits();
    $('#lv-min').textContent = Math.round(d.min);
    $('#lv-max').textContent = Math.round(d.max);
    const mn = $('[data-setting="limitMin"]'), mx = $('[data-setting="limitMax"]');
    mn.value = settings.limits.min; mn.min = d.min; mn.max = d.max;
    mx.value = settings.limits.max; mx.min = d.min; mx.max = d.max;
}
function renderSettings() {
    $$('[data-setting]').forEach(el => {
        const k = el.dataset.setting;
        if (el.type === 'checkbox') el.checked = k === 'darkMode' ? document.documentElement.classList.contains('dark') : !!settings[k];
        else if (el.tagName === 'SELECT' || el.type === 'range') el.value = String(settings[k]);
    });
    renderLimits();
    renderSensors();
}

function applyTheme() {
    const dark = settings.darkMode ?? window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', dark);
    $('meta[name="theme-color"]').setAttribute('content', dark ? '#020617' : '#0F766E');
}

/* ===================== 10. FOLHAS, TOASTS, VIBRAÇÃO ===================== */
function haptic(pattern) { if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(pattern); } catch { } } }

function toast(msg, type = 'info', ms = 3200, action = null) {
    const root = $('#toast-root');
    if ($$('.toast', root).some(t => t.dataset.msg === msg)) return;   // evita repetidos
    const icons  = { info: 'info', success: 'circle-check', warn: 'triangle-alert', error: 'circle-x', tip: 'lightbulb' };
    const colors = { info: 'text-sky-500', success: 'text-emerald-500', warn: 'text-amber-500', error: 'text-red-500', tip: 'text-teal-500' };
    const el = document.createElement('div');
    el.dataset.msg = msg;
    el.className = 'toast pointer-events-auto flex items-start gap-3 bg-white/95 dark:bg-slate-800/95 backdrop-blur border border-slate-200 dark:border-slate-700 shadow-lg rounded-2xl px-4 py-3 text-xs text-slate-700 dark:text-slate-200';
    el.innerHTML = `<i data-lucide="${icons[type]}" class="w-4 h-4 mt-0.5 shrink-0 ${colors[type]}"></i>
        <div class="flex-1 leading-relaxed">${escapeHtml(msg)}</div>
        ${action ? `<button class="toast-action font-bold text-teal-600 whitespace-nowrap">${escapeHtml(action.label)}</button>` : ''}`;
    root.appendChild(el);
    refreshIcons();
    let closed = false;
    const close = () => { if (closed) return; closed = true; el.classList.add('toast-out'); setTimeout(() => el.remove(), 300); };
    if (action) el.querySelector('.toast-action').addEventListener('click', e => { e.stopPropagation(); close(); action.fn(); });
    el.addEventListener('click', close);
    setTimeout(close, ms);
    const all = $$('.toast', root);
    if (all.length > 3) all[0].remove();
}

const Sheet = {
    _resolve: null,
    open({ title, html, actions = [] }) {
        if (this._resolve) this.close(null);
        $('#sheet-title').textContent = title;
        $('#sheet-body').innerHTML = html;
        $('#sheet-actions').innerHTML = actions.map(a => {
            const cls = a.kind === 'primary' ? 'bg-teal-600 text-white' : a.kind === 'danger' ? 'bg-red-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200';
            return `<button data-sheet-value="${a.value}" class="press ripple flex-1 py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2 ${cls}">${a.icon ? `<i data-lucide="${a.icon}" class="w-4 h-4"></i>` : ''}${escapeHtml(a.label)}</button>`;
        }).join('');
        refreshIcons();
        $('#sheet').classList.add('open');
        $('#sheet-backdrop').classList.add('open');
        setTimeout(() => $('#sheet-body input')?.focus(), 350);
        return new Promise(res => { this._resolve = res; });
    },
    close(value) {
        $('#sheet').classList.remove('open');
        $('#sheet-backdrop').classList.remove('open');
        const r = this._resolve; this._resolve = null;
        r?.(value);
    },
};

function showUnsupportedInfo() {
    const secure = window.isSecureContext;
    Sheet.open({
        title: 'Bluetooth não disponível',
        html: `<div class="space-y-3 text-xs leading-relaxed">
            <p>Este navegador não consegue acessar o Bluetooth da mesa. Para usar o MOVA:</p>
            <ol class="list-decimal pl-4 space-y-1.5 text-slate-500 dark:text-slate-400">
                <li>Use o <b>Google Chrome no Android</b> (ou Chrome/Edge no computador).</li>
                <li>Abra o app por um endereço <b>https://</b> ${secure ? '' : '<span class="text-red-500">(este endereço não é seguro)</span>'}.</li>
                <li>Ative o <b>Bluetooth</b> e a <b>Localização</b> e permita "Dispositivos próximos".</li>
            </ol>
            <p class="text-slate-400">iPhone: o Safari não tem Web Bluetooth. Veja as opções com a equipe.</p>
            <p>Enquanto isso, você pode testar tudo no <b>modo demonstração</b>.</p></div>`,
        actions: [{ label: 'Fechar', value: 'close', kind: 'ghost' }, { label: 'Usar demo', value: 'demo', kind: 'primary', icon: 'flask-conical' }],
    }).then(v => { if (v === 'demo') Actions['connect-demo'](); });
}

/* ============================ 11. AÇÕES ============================ */
const Actions = {
    tab: el => switchTab(el.dataset.tab),
    connect: () => {
        if (state.conn === 'unsupported') return showUnsupportedInfo();
        connect(settings.demoMode ? 'demo' : 'ble');
    },
    'connect-demo': () => {
        settings.demoMode = true; saveSettings(); renderSettings();
        if (state.conn === 'connected' && state.transportKind === 'demo') return;
        if (Link.transport) disconnect();
        setTimeout(() => connect('demo'), Link.transport ? 400 : 0);
    },
    'conn-pill': () => {
        switchTab('conexao');
    },
    'toggle-connection': () => state.conn === 'connected' ? disconnect() : Actions.connect(),
    'disconnect-desk': () => {
        if (state.conn === 'connected' || ['connecting', 'handshake', 'reconnecting'].includes(state.conn)) disconnect();
        else toast('A mesa já está desconectada.', 'info', 1800);
    },
    'rename-desk': async () => {
        const input = 'mt-1 w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:border-teal-500';
        const v = await Sheet.open({
            title: 'Renomear mesa',
            html: `<label class="block text-xs text-slate-400">Apelido da mesa<input id="desk-alias-input" maxlength="28" value="${escapeHtml(settings.deskAlias || 'Minha Mesa')}" class="${input}"></label>`,
            actions: [{ label: 'Cancelar', value: 'no', kind: 'ghost' }, { label: 'Salvar', value: 'yes', kind: 'primary', icon: 'check' }],
        });
        if (v !== 'yes') return;
        settings.deskAlias = ($('#desk-alias-input').value || '').trim() || 'Minha Mesa';
        saveSettings(); renderConn();
        toast('Nome da mesa atualizado.', 'success');
    },
    'sim-prox': () => {
        const near = !isProxBlocked();
        const newDist = near ? 18 : 120;
        onProximity(newDist);
        if (state.conn === 'connected') sendCmd(`SIMPROX:${newDist}`);
        toast(near ? 'Simulação VL53L0X: pessoa a 18 cm (movimento bloqueado!)' : 'Simulação VL53L0X: área livre (120 cm).', near ? 'warn' : 'success');
        haptic(near ? [40, 50, 40] : 15);
    },
    stop: () => { haptic(25); emergencyStop(); },
    goto: el => goTo(parseFloat(el.dataset.value)),
    'goto-sit': () => goTo(settings.sitHeight),
    'goto-stand': () => goTo(settings.standHeight),
    nudge: el => { if (state.height != null) goTo(state.height + parseFloat(el.dataset.value), { overlay: false }); else handleBlock(moveBlockReason() || 'height'); },
    calc: () => {
        const uh = clamp(parseFloat($('#user-height-input').value) || 170, 120, 230);
        const sole = clamp(parseFloat($('#user-sole-input').value) || 0, 0, 15);
        const total = uh + sole;
        // Proporções antropométricas aproximadas (altura do cotovelo)
        state.calc = { sit: Math.round(total * 0.42), stand: Math.round(total * 0.62) };
        $('#calc-sitting').textContent = `${state.calc.sit} cm`;
        $('#calc-standing').textContent = `${state.calc.stand} cm`;
        const box = $('#calc-result');
        box.classList.remove('hidden');
        box.classList.remove('pop-in'); void box.offsetWidth; box.classList.add('pop-in');
        haptic(10);
    },
    'calc-go': el => state.calc && goTo(state.calc[el.dataset.which]),
    'calc-save': () => {
        if (!state.calc) return;
        settings.sitHeight = state.calc.sit; settings.standHeight = state.calc.stand; saveSettings();
        presets = presets.map(p => p.id === 'sit' ? { ...p, h: state.calc.sit } : p.id === 'stand' ? { ...p, h: state.calc.stand } : p);
        savePresets(); renderPresets(); renderProfile();
        toast('Alturas padrão atualizadas.', 'success');
    },
    'save-preset': async () => {
        if (state.conn !== 'connected' || state.height == null) return handleBlock(moveBlockReason() || 'height');
        const h = Math.round(state.height * 2) / 2;
        const v = await Sheet.open({
            title: `Salvar posição (${fmtCm(h)} cm)`,
            html: `<label class="text-xs text-slate-400">Nome da posição<input id="preset-name" maxlength="24" value="${h >= CONFIG.STANDING_THRESHOLD_CM ? 'Em pé' : 'Sentado'} ${fmtCm(h)} cm" class="mt-1 w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:border-teal-500"></label>`,
            actions: [{ label: 'Cancelar', value: 'no', kind: 'ghost' }, { label: 'Salvar', value: 'yes', kind: 'primary', icon: 'bookmark-plus' }],
        });
        if (v !== 'yes') return;
        const name = ($('#preset-name').value || '').trim() || `${fmtCm(h)} cm`;
        presets.push({ id: 'p' + Date.now(), name, h });
        savePresets(); renderPresets();
        toast('Posição salva!', 'success'); haptic(15);
    },
    'delete-preset': async el => {
        const p = presets.find(x => x.id === el.dataset.id);
        if (!p) return;
        const v = await Sheet.open({ title: 'Apagar posição?', html: `<p class="text-xs">"${escapeHtml(p.name)}" (${fmtCm(p.h)} cm) será removida.</p>`, actions: [{ label: 'Cancelar', value: 'no', kind: 'ghost' }, { label: 'Apagar', value: 'yes', kind: 'danger', icon: 'trash-2' }] });
        if (v !== 'yes') return;
        presets = presets.filter(x => x.id !== p.id); savePresets(); renderPresets();
    },
    'edit-profile': async () => {
        const input = 'mt-1 w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:border-teal-500';
        const v = await Sheet.open({
            title: 'Seu perfil',
            html: `<div class="space-y-3">
                <label class="block text-xs text-slate-400">Nome<input id="pf-name" maxlength="40" value="${escapeHtml(settings.userName)}" class="${input}"></label>
                <label class="block text-xs text-slate-400">Descrição<input id="pf-sub" maxlength="60" value="${escapeHtml(settings.userSub)}" class="${input}"></label></div>`,
            actions: [{ label: 'Cancelar', value: 'no', kind: 'ghost' }, { label: 'Salvar', value: 'yes', kind: 'primary', icon: 'check' }],
        });
        if (v !== 'yes') return;
        settings.userName = $('#pf-name').value.trim() || DEFAULT_SETTINGS.userName;
        settings.userSub = $('#pf-sub').value.trim();
        saveSettings(); renderProfile(); toast('Perfil atualizado.', 'success');
    },
    range: el => { state.statsRange = el.dataset.range; renderStats(); haptic(6); },
    'ack-error': async () => {
        hideErrorOverlay();
        const code = state.error;
        state.error = null;
        await sendCmd('RESET');
        renderMotion();
        if (code) toast('Mesa liberada. Mova com atenção.', 'info');
    },
    'clear-data': async () => {
        const v = await Sheet.open({ title: 'Apagar dados do app?', html: '<p class="text-xs">Perfil, posições salvas, estatísticas e preferências serão apagados deste celular.</p>', actions: [{ label: 'Cancelar', value: 'no', kind: 'ghost' }, { label: 'Apagar tudo', value: 'yes', kind: 'danger', icon: 'trash-2' }] });
        if (v !== 'yes') return;
        if (isMoving()) emergencyStop();
        Store.clear(); location.reload();
    },
};

function applySetting(key, el) {
    switch (key) {
        case 'darkMode':
            settings.darkMode = el.checked; applyTheme(); break;
        case 'limitMin':
        case 'limitMax': {
            const v = parseFloat(el.value);
            if (!isFinite(v)) { renderLimits(); return; }
            settings.limits[key === 'limitMin' ? 'min' : 'max'] = v;
            const before = { ...settings.limits };
            normalizeUserLimits();
            if (before.min !== settings.limits.min || before.max !== settings.limits.max)
                toast(`Limites ajustados para ${settings.limits.min}–${settings.limits.max} cm (mín. ${CONFIG.MIN_LIMIT_SPAN} cm de faixa).`, 'info', 3500);
            renderLimits(); sendLimitsToDevice();
            break;
        }
        case 'demoMode':
            settings.demoMode = el.checked;
            if (Link.transport) disconnect();
            if (el.checked) setTimeout(() => connect('demo'), 400);
            break;
        case 'childLock':
            settings.childLock = el.checked;
            if (el.checked && isMoving()) emergencyStop();
            toast(el.checked ? 'Controles bloqueados.' : 'Controles liberados.', 'info', 1800);
            renderMotion();
            break;
        case 'reminderMin':
            settings.reminderMin = parseInt(el.value, 10) || 50; break;
        case 'proxMinCm':
            settings.proxMinCm = parseInt(el.value, 10) || 35;
            sendProxLimitToDevice();
            renderSensors();
            if (isProxBlocked() && isMoving()) emergencyStop('Pessoa/objeto dentro da nova distância de segurança (VL53L0X).');
            break;
        default:
            settings[key] = el.type === 'checkbox' ? el.checked : el.value;
    }
    saveSettings();
    haptic(8);
}

/* ---- Eventos ---- */
function bindEvents() {
    // Cliques (delegação)
    document.addEventListener('click', e => {
        const sv = e.target.closest('[data-sheet-value]');
        if (sv) return Sheet.close(sv.dataset.sheetValue);
        const el = e.target.closest('[data-action]');
        if (el && Actions[el.dataset.action]) { e.stopPropagation(); Actions[el.dataset.action](el, e); }
    });
    $('#sheet-backdrop').addEventListener('click', () => Sheet.close(null));
    document.addEventListener('change', e => { const k = e.target.dataset?.setting; if (k) applySetting(k, e.target); });

    // Efeito ripple
    document.addEventListener('pointerdown', e => {
        const el = e.target.closest('.ripple');
        if (!el) return;
        const r = el.getBoundingClientRect(), s = Math.max(r.width, r.height), ink = document.createElement('span');
        ink.className = 'ripple-ink';
        ink.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
        el.appendChild(ink);
        setTimeout(() => ink.remove(), 650);
    });

    // Botões de segurar (homem-morto)
    $$('[data-hold]').forEach(btn => {
        btn.addEventListener('pointerdown', e => {
            if (e.button !== undefined && e.button !== 0) return;
            e.preventDefault();
            try { btn.setPointerCapture(e.pointerId); } catch { }
            startHold(btn.dataset.hold, btn);
        });
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => btn.addEventListener(ev, endHold));
        btn.addEventListener('contextmenu', e => e.preventDefault());
        btn.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startHold(btn.dataset.hold, btn); } });
        btn.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') endHold(); });
    });
    window.addEventListener('pointerup', endHold);
    window.addEventListener('blur', endHold);

    // App saiu da tela => para tudo
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (isMoving()) emergencyStop('Movimento interrompido: o app saiu da tela.');
            Stats.pause();
        } else {
            if (state.conn === 'connected') { Stats.resume(); sendCmd('GET'); }
            renderGreeting(); renderHomeMode();
        }
    });
    window.addEventListener('pagehide', () => { if (isMoving()) sendStop(); });

    // Atalho: Esc = parar
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { if (Sheet._resolve) Sheet.close(null); else if (isMoving()) emergencyStop(); }
    });

    window.addEventListener('resize', moveNavIndicator);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (settings.darkMode == null) { applyTheme(); renderSettings(); } });
}

/* ======================= 12. INICIALIZAÇÃO (SPLASH) ======================= */
function setSplash(text, pct) {
    $('#splash-status').textContent = text;
    $('#splash-progress').style.width = pct + '%';
}

async function boot() {
    applyTheme();
    refreshIcons();
    bindEvents();
    renderProfile();
    renderPresets();
    renderSettings();
    renderConn();
    switchTab('home');
    requestAnimationFrame(animationLoop);
    setInterval(safetyMonitor, CONFIG.SAFETY.MONITOR_MS);
    setInterval(() => {
        Stats.accumulate(); Stats.save(); Stats.checkReminder();
        renderGreeting(); renderHomeMode();
        if (state.activeTab === 'ergonomia') { $('#ergo-tip').textContent = tipText(); $('#stat-last').textContent = fmtAgo(Stats.data.lastChange); }
    }, 15000);

    const minSplash = sleep(2900);
    setSplash('Inicializando…', 15);
    await sleep(600);

    let auto = Promise.resolve();
    if (settings.demoMode) {
        setSplash('Iniciando modo demonstração…', 55);
        auto = connect('demo');
    } else if (!BleTransport.isSupported()) {
        setConn('unsupported');
        setSplash('Bluetooth indisponível neste navegador', 55);
    } else {
        setSplash('Procurando sua mesa…', 55);
        auto = tryAutoReconnect();
    }
    await Promise.race([Promise.all([minSplash, auto]), sleep(6000)]);
    setSplash(state.conn === 'connected' ? 'Mesa conectada' : 'Pronto', 100);
    await sleep(400);

    const sp = $('#splash');
    sp.classList.add('splash-out');
    setTimeout(() => { sp.remove(); moveNavIndicator(); }, 650);
    moveNavIndicator();
}

document.addEventListener('DOMContentLoaded', boot);
