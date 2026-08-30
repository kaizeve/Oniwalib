<div align="center">

# oniwalib

**Cliente WhatsApp Multi-Device nativo, sobre o [RTS](https://github.com/UrubuCode/rts).**
Fala o socket direto — sem navegador, sem Puppeteer, sem headless Chrome.

`nome provisório` · `TypeScript` · `compila para um binário único via RTS`

</div>

---

## O que é

`oniwalib` é uma biblioteca para conversar com o WhatsApp pelo protocolo
**Multi-Device**, no mesmo estilo da [Baileys](https://github.com/WhiskeySockets/Baileys):
um cliente WebSocket que implementa o handshake, a criptografia e o formato
binário do WhatsApp por conta própria.

A diferença é o alvo de execução. Em vez de rodar sobre Node com dezenas de
dependências, `oniwalib` é escrita para **compilar com o RTS** — o motor que
transforma TypeScript em código de máquina nativo. O resultado pretendido é um
**executável único**, sem runtime para instalar, com pegada de memória de
navegador-reverso (dezenas de MB, não centenas).

### Para que serve

- Automação da **própria conta** de WhatsApp: bots de atendimento, notificações,
  integrações internas.
- Base para um serviço **multi-linguagem**: o binário sobe como daemon com uma
  API local, e qualquer linguagem (Java, Go, PHP, Python…) fala com ele.
- Banco de provas do RTS: código no formato Baileys — cripto, `Buffer`, socket
  assíncrono longo, protobuf — é exatamente o que estressa o motor.

### O que NÃO é

Não é um cliente oficial e não finge ser um. Cliente não-oficial de WhatsApp
**é banível** — o gatilho principal é volume e mensagem não solicitada, e isso
fere os Termos de Serviço. Este repositório não tem, e não vai ter, recursos de
evasão de detecção.

---

## Como funciona

O WhatsApp Web Multi-Device é, em camadas:

```
  ┌──────────────────────────────────────────────────────┐
  │  aplicação / bot / daemon                             │
  ├──────────────────────────────────────────────────────┤
  │  eventos      store        profiles (original/mod)    │
  ├──────────────────────────────────────────────────────┤
  │  auth  ── registro (pairing code / QR), pre-keys      │
  ├──────────────────────────────────────────────────────┤
  │  signal      proto (WA)      frame (WABinary)         │
  ├──────────────────────────────────────────────────────┤
  │  noise  ── handshake XX · Curve25519 · AES-GCM · HKDF │
  ├──────────────────────────────────────────────────────┤
  │  transport  ── TLS · WebSocket cliente                │
  └──────────────────────────────────────────────────────┘
```

1. **transport** abre um WebSocket sobre TLS para o edge do WhatsApp.
2. **noise** faz o handshake `Noise_XX_25519_AESGCM_SHA256`: troca de chaves
   efêmeras e estáticas, cada passo derivando chave nova via HKDF. No fim, um
   par de chaves de transporte cifra tudo daí pra frente.
3. **frame** empacota/desempacota o **WABinary** — o formato binário tipo-XML do
   WhatsApp, com um dicionário de tokens que comprime as tags e atributos mais
   comuns para 1 byte.
4. **auth** registra o dispositivo (pairing code ou QR), envia as pre-keys, e
   guarda as credenciais para reconectar sem re-parear.
5. **signal** cifra o conteúdo das mensagens fim-a-fim (Double Ratchet, sender
   keys para grupos).
6. **proto** é o schema protobuf que dá forma ao conteúdo dentro do envelope
   cifrado.
7. **eventos** entregam para a aplicação: `connection.update`,
   `messages.upsert`, `creds.update`…

Toda a criptografia passa por **uma interface** (`src/crypto/types.ts`). O
núcleo da lib nunca chama `node:crypto` nem nada de plataforma diretamente —
isso é responsabilidade de um *adapter*. Trocar o adapter troca o backend
inteiro sem tocar em mais nada. É o que mantém `oniwalib` portável e o que
isola o único ponto que ainda depende do motor.

---

## Estado

`oniwalib` roda em **bun/node hoje**, e no **RTS** em tudo que não depende de
primitivos de criptografia que o motor ainda não expõe.

| Módulo | O que faz | bun/node | RTS |
|---|---|:---:|:---:|
| `frame/` | codec WABinary: binary node, buffers, JID, tabelas de token | ✅ | ✅ |
| `noise/` | handshake XX + enquadramento | ✅ | ✅ |
| `crypto/` | interface + adapter `node:crypto` (bun/node) e adapter RTS | ✅ | ✅ |
| `proto/` | builders de mensagem (incl. botões/list/interactive) + shapes de handshake | ✅ | ✅ |
| `auth/` | credenciais + cofre de chaves Signal | ✅ | ✅¹ |
| `events/` | superfície de eventos tipada | ✅ | ✅ |
| `profiles/` | camada original vs modificada | ✅ | ✅ |
| `transport/` | interface `Transport` + `MockTransport` + `NoiseSocket` (handshake→cripto→WABinary sobre um transporte) | ✅ | ✅ |
| `transport/` — conector real | TLS + WebSocket cliente com headers/Origin custom | ⛔ | ⛔ |

<sub>¹ A assinatura de identidade (XEdDSA) ainda não existe no RTS — no motor,
a `signedPreKey` fica com assinatura placeholder até a Fase 2. Todo o resto
roda nativo.</sub>

**Testes:** `wabinary` 23 · `noise` 12 · `auth` 22 · `socket` 6 (integração:
transporte → enquadramento → handshake XX → cripto de transporte → WABinary,
ponta a ponta) → **63/63 em bun E no RTS** (`rts run`). Falta só a tomada real
(TLS + WebSocket) para conectar no servidor do WhatsApp.

### A Fase 0 — estado no motor do RTS

| Primitivo | API | Estado no RTS |
|---|---|---|
| SHA-256, HMAC-SHA256, HKDF, `randomBytes` | `node:crypto` | ✅ já existia |
| AES-128/256-GCM e -CBC | `createCipheriv` / `createDecipheriv` (com `setAAD`/`getAuthTag`/`setAuthTag`) | ✅ adicionado |
| ECDH X25519 | `generateX25519KeyPair` / `x25519PublicKey` / `x25519DiffieHellman` (bytes crus, sem KeyObject) | ✅ adicionado |
| Assinatura Curve25519 (XEdDSA) | — | ⛔ pendente (Fase 2) |

Com isso, o handshake Noise e a inicialização de credenciais rodam no motor.
Falta a camada de transporte (TLS + WebSocket cliente) para conectar de fato.

---

## Uso

> A conexão real depende da Fase 0. O que já dá para fazer hoje é montar e
> inspecionar as mensagens e rodar o handshake com um adapter de referência.

### Montar uma mensagem com botões

```ts
import { message as m } from "oniwalib";

const msg = m.buttons({
  content: "Escolha uma opção:",
  footer: "oniwalib",
  buttons: [
    { id: "menu",   text: "Ver menu" },
    { id: "falar",  text: "Falar com humano" },
  ],
});
```

### Native flow (o caminho atual dos forks modificados)

```ts
import { message as m } from "oniwalib";

const msg = m.interactive({
  body: "Seu pedido está pronto.",
  footer: "Loja X",
  buttons: [
    m.flow.url("Acompanhar", "https://loja.x/pedido/123"),
    m.flow.copy("Copiar código", "ABC123"),
    m.flow.quickReply("Avaliar", "rate:123"),
  ],
});
```

### Codificar/decodificar um binary node

```ts
import { frame } from "oniwalib";

const bytes = frame.encodeBinaryNode(
  frame.node("iq", { type: "get", xmlns: "w:p", to: "s.whatsapp.net" }),
);
const back = frame.decodeBinaryNode(bytes); // → { tag: "iq", attrs: {...} }
```

### Rodar o handshake Noise (com adapter de referência)

```ts
import { NoiseHandshake, crypto } from "oniwalib";

const hs = new NoiseHandshake(crypto());
const eph = crypto().generateX25519();
const hello = hs.clientHello(eph);
// … troca com o servidor …
const { encKey, decKey } = hs.finish();
```

---

## Estrutura

```
oniwalib/
├── src/
│   ├── frame/              codec WABinary
│   │   ├── constants.ts      tags + tabelas de token (PROVENÂNCIA: conferir)
│   │   ├── buffer.ts         BufferReader/Writer + UTF-8 próprio
│   │   ├── jid.ts            parse/format de JID
│   │   ├── node.ts           o tipo BinaryNode + acessores
│   │   ├── decode.ts         bytes → BinaryNode
│   │   ├── encode.ts         BinaryNode → bytes
│   │   └── index.ts
│   ├── noise/
│   │   ├── frame.ts          enquadramento [len de 3 bytes][payload] + intro
│   │   ├── handshake.ts      Noise_XX_25519_AESGCM_SHA256, lado cliente
│   │   ├── wire.ts           serialização dos 3 frames do handshake (placeholder → protobuf)
│   │   └── socket.ts         NoiseSocket: transporte + handshake + WABinary numa conexão
│   ├── transport/
│   │   ├── types.ts          interface Transport + endpoints do WhatsApp
│   │   └── mock.ts           par de transportes em memória (testes)
│   ├── crypto/
│   │   ├── types.ts          a interface Crypto (a fronteira de plataforma)
│   │   ├── node-adapter.ts   implementação sobre node:crypto (referência)
│   │   └── index.ts          crypto() / setCrypto()
│   ├── proto/
│   │   ├── message.ts        builders de body: text, buttons, list, template, interactive
│   │   └── handshake.ts      HandshakeMessage / ClientPayload
│   ├── auth/
│   │   └── state.ts          initAuthCreds, memoryAuthState, base64 próprio
│   ├── events/
│   │   └── emitter.ts        Emitter tipado + OniwalibEvents
│   ├── profiles/
│   │   └── index.ts          STOCK vs MODIFIED
│   └── index.ts
├── test/
│   ├── wabinary.test.ts      round-trip do codec + builders
│   ├── noise.test.ts         handshake XX ponta a ponta + enquadramento
│   └── auth.test.ts          init de credenciais + base64
├── package.json
├── tsconfig.json
└── README.md
```

---

## Desenvolvimento

```bash
# testes no runtime de referência
bun test/wabinary.test.ts
bun test/noise.test.ts
bun test/auth.test.ts

# os mesmos testes no motor alvo
../rts/target/fast/rts run test/wabinary.test.ts
```

Rodar em ambos e comparar é o teste de "código estilo Baileys funciona no RTS".

### Original e modificada

Um núcleo só. `src/profiles/index.ts` aplica um conjunto de parâmetros por cima:
a identidade do cliente (o *browser triple*, versão), a string do pairing code,
e se os tipos interativos ficam ativos.

- **`STOCK`** — identidade de cliente padrão, sem shaping. Menor superfície de detecção.
- **`MODIFIED`** — identidade custom, pairing code fixo padronizável, tipos
  interativos ligados. Quem usa escolhe, **com a própria conta no risco**.

---

## Licença

**Uso exclusivo do criador e dos criadores do RTS.** Não é software livre. Não
redistribuir, publicar ou usar fora desse círculo sem autorização.

Autoria: **loveless**.

---

<div align="center">
<sub>oniwalib · rascunho · progresso separado do core do RTS</sub>
</div>
