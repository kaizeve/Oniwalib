// A camada onde "original" e "modificada" divergem. Tudo aqui é parâmetro.
//
// A identidade do cliente é a `browser triple` + versão que vai no handshake e
// em `<iq>` de config. O `pairingCode` fixo é padronizável (ex.: RTSSTOP1) — ver
// o callout de risco de ban no plano: código fixo repetido é impressão digital.

export interface ClientProfile {
  /** [nome, plataforma, versão] — ex.: ["Oniwalib", "Chrome", "1.0.0"] */
  browser: [string, string, string];
  /** Versão do WhatsApp Web que a lib se anuncia falando. VERIFICAR contra a fixada. */
  waVersion: [number, number, number];
  /** Se definido, o pairing code pedido é sempre este (8 chars A-Z0-9). */
  pairingCode?: string;
  /** Habilita a montagem dos tipos interativos (botões/list/template). */
  interactiveMessages: boolean;
  /** Embrulha automaticamente mensagens interativas em viewOnce. */
  autoViewOnceWrap: boolean;
}

export const STOCK: ClientProfile = {
  browser: ["Oniwalib", "Chrome", "1.0.0"],
  waVersion: [2, 3000, 0],
  interactiveMessages: false,
  autoViewOnceWrap: false,
};

export const MODIFIED: ClientProfile = {
  browser: ["Oniwalib", "Chrome", "1.0.0"],
  waVersion: [2, 3000, 0],
  pairingCode: "RTSSTOP1",
  interactiveMessages: true,
  autoViewOnceWrap: true,
};

export function resolveProfile(p?: Partial<ClientProfile>): ClientProfile {
  return { ...STOCK, ...p };
}
