# MOVA — Mesa Ergonômica Inteligente

> **Ergonomia que se adapta a você.**  
> Aplicativo Web Bluetooth (Android) e firmware **ESP32** para controle seguro, conectado e ergonômico da mesa motorizada **MOVA**.

---

## Sobre o Projeto

A linha **MOVA** une hardware embarcado (**ESP32 + sensores**) e uma interface web *mobile-first* (**HTML5 + Tailwind CSS + JavaScript + Web Bluetooth API**) para transformar o ajuste de altura da mesa em uma experiência fluida, segura e centrada no bem-estar do usuário.

O aplicativo se comunica diretamente com o ESP32 via **Bluetooth Low Energy (BLE)** pelo Google Chrome no Android — sem necessidade de instalar aplicativos nativos — e oferece telemetria em tempo real, proteções ativas em software e hardware, calculadora ergonômica **NR-17 / ISO 9241** e acompanhamento de postura.

---

## Principais Funcionalidades

### Controle e Interface Viva
- **Conexão Bluetooth (BLE) direta:** pareamento com o dispositivo `MOVA-001` e reconexão automática.
- **Mostrador e Mesa ao Vivo:** medidor circular e ilustração telescópica animados em tempo real conforme a altura enviada pelo sensor.
- **Presets e Ajuste Fino:** atalhos rápidos para *Sentado* e *Em pé*, posições personalizadas salvas no aparelho e ajuste fino de `0,5 cm`.
- **Tela de Conexão dedicada:** linha do tempo ao vivo (*Procurando → Conectando → Conectada → Conexão perdida*) e opção de renomear a mesa.
- **Modo Demonstração:** simula o comportamento completo do ESP32 e dos sensores diretamente no navegador, permitindo testar tudo sem o hardware ligado.
- **Modo Claro e Escuro:** alternância instantânea com persistência de preferências.

### Segurança em Camadas (App + Hardware)
O controle da mesa conta com múltiplas travas simultâneas para evitar acidentes:
1. **Sensor Laser de Proximidade (`VL53L0X`):** monitora continuamente a área ao redor da mesa (I2C no ESP32). Se detectar uma pessoa ou objeto abaixo da distância configurada (padrão `35 cm`, ajustável entre `15` e `80 cm`), **bloqueia o acionamento** ou **interrompe o movimento imediatamente** (`E:PROXIMITY`).
2. **Acionamento "Homem-Morto":** os botões *Subir* e *Descer* só movimentam os motores enquanto o dedo permanece pressionado. Soltou o botão → `STOP` imediato.
3. **Heartbeat + Watchdog (`1000 ms`):** durante qualquer movimento, o app envia pulsos `HB` a cada `300 ms`. Se a conexão cair, a bateria acabar ou o app travar, o ESP32 desliga os motores sozinho em 1 segundo (`E:WATCHDOG`).
4. **Prioridade Absoluta para `STOP`:** o comando de parada fura a fila de envio BLE e é reenviado automaticamente em caso de falha.
5. **Parada Automática ao Minimizar:** se o usuário trocar de aplicativo, bloquear a tela ou fechar a aba, o movimento é interrompido na hora.
6. **Detecção de Obstáculo / Travamento (`E:OBSTACLE`):** se o motor estiver ativo e a altura não variar por `2,5 s`, o sistema corta a alimentação e exige confirmação visual antes de liberar novamente.
7. **Pareamento Autenticado (`HELLO:MOVA-2026`):** o ESP32 rejeita comandos de clientes não autenticados.
8. **Limites de Altura, Trava Infantil e Confirmação de Área Livre:** limites físicos (`60–110 cm`), limites configuráveis pelo usuário, bloqueio de controles e aviso inicial antes do movimento.

### Ergonomia, Sensores e Saúde
- **Aba Sensores:** monitoramento em tempo real do sensor de proximidade **VL53L0X**, sensor de altura, temperatura do módulo, corrente do motor e estado do sistema de segurança (incluindo botão de simulação de presença para testes).
- **Calculadora NR-17 / ISO 9241:** calcula a altura ideal para trabalhar sentado e em pé com base na estatura e altura do calçado, permitindo aplicar ou salvar como padrão.
- **Histórico de Postura:** contabiliza automaticamente o tempo sentado, tempo em pé e quantidade de alternâncias (Hoje, 7 dias e 30 dias), com lembretes configuráveis para mudar de posição.

---

## Arquitetura dos Arquivos

| Arquivo | Função |
|---|---|
| `index.html` / `codigomesa.html` | Interface do aplicativo (Splash animado, Home, Controle, Ergonomia, Ajustes, Sensores, Conexão e Segurança). |
| `mova.js` | Controlador Web Bluetooth, fila de comandos, monitoramento de segurança, estatísticas e modo demonstração. |
| `codigoESP032.cpp` | Firmware do ESP32 com servidor BLE, watchdog, controle dos motores e leitura do sensor **VL53L0X**. |

---

## Protocolo de Comunicação BLE

- **Nome do dispositivo:** `MOVA-001`
- **Service UUID:** `4fafc201-1fb5-459e-8fcc-c5c9c331914b`
- **Characteristic UUID:** `beb5483e-36e1-4688-b7f5-ea07361b26a8`

| Direção | Comandos / Mensagens |
|---|---|
| **App → ESP32** | `HELLO:MOVA-2026`, `UP`, `DOWN`, `STOP`, `GOTO:<cm>`, `HB`, `GET`, `RESET`, `SETLIM:<min>,<max>`, `SETPROX:<cm>` |
| **ESP32 → App** | `OK:HELLO`, `H:<cm>`, `P:<cm>`, `T:<°C>`, `C:<A>`, `S:IDLE\|UP\|DOWN\|GOTO`, `E:<codigo>`, `LIM:<min>,<max>` |

---

## Como Testar no Celular (Android)

1. Publique o repositório usando o **GitHub Pages** (necessário para fornecer endereço `https://`, exigido pela Web Bluetooth API).
2. Grave o arquivo `codigoESP032.cpp` no **ESP32** pela Arduino IDE:
   - Use `#define MODO_SIMULADO true` para testar a comunicação Bluetooth real sem ligar os motores/sensores.
   - Para hardware real, conecte o **VL53L0X** nos pinos `SDA = 21` e `SCL = 22`, instale a biblioteca `Adafruit_VL53L0X` e altere para `#define MODO_SIMULADO false`.
3. No **Android**, ative o Bluetooth e a Localização, abra o link do GitHub Pages no **Google Chrome**, toque em **Conectar mesa** e selecione `MOVA-001`.

---

## Créditos Acadêmicos

**MOVA — Protótipo Acadêmico**  
**Instituição:** SENAI Frederico Jacob  
**Orientador:** Célio Monari  
**Equipe:** Erik, Isabelle, Julia, Lucas e Lynkon
