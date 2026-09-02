// LidStore — mapa número↔lid + roster de contatos, sobre o `SignalKeyStore`
// (tipo "lid-mapping").
//
// O WhatsApp foi migrando o endereçamento de `553...@s.whatsapp.net` (número,
// "pn") para `1...@lid` (id oculto). Numa stanza de grupo com `addressing_mode`
// = lid o `participant` vem como `@lid` e o número real só aparece no atributo
// `participant_pn`; a metadata do grupo (`w:g2` interactive) traz o par no
// `<participant jid=…@lid phone_number=…>`. Sem casar os dois, na hora de
// postar um status (`statusJidList` quer número) ou de fanar o SKDM do grupo a
// gente fica com um `@lid` que não abre sessão — a mensagem sai pra ninguém.
//
// Este store só REGISTRA passivamente o que passa pela conexão (não faz USync
// ativo). Persiste no cofre, cifrado — sobrevive a restart sem depender de
// consulta ao servidor nem de nada no repo.
//
//   id = `1...@lid`              → valor = `553...@s.whatsapp.net`
//   id = `553...@s.whatsapp.net` → valor = `1...@lid`
//   id = `__roster`             → valor = string[] com TODO jid/lid de pessoa
//                                 real que já falou com o bot (audiência de
//                                 status, p.ex.)

import type { SignalKeyStore } from "../auth/state";
import { isJidUser, isLidUser } from "../frame/jid";
import { jidNormalizedUser } from "../usync";

const ROSTER_ID = "__roster";

export interface LidStore {
  /** Guarda o par número↔lid (nos dois sentidos). Ignora em silêncio o lado que
   *  não for um jid de número / de lid válido. NÃO mexe no roster — mapa é só
   *  tabela de lookup, alimentada de qualquer lugar (grupo inclusive). */
  remember(pnJid: string | undefined, lidJid: string | undefined): Promise<void>;
  /** Marca `jid` (número OU lid) como contato real que falou COM o bot — entra
   *  no roster (audiência de status). Chamado só em conversa 1:1. */
  noteContact(jid: string | undefined): Promise<void>;
  /** `@lid` → `@s.whatsapp.net` conhecido (ou o próprio jid, se já for número).
   *  `undefined` se for um lid que a gente ainda não pareou. */
  toPn(jid: string | undefined): Promise<string | undefined>;
  /** `@s.whatsapp.net` → `@lid` conhecido (ou o próprio jid, se já for lid). */
  toLid(jid: string | undefined): Promise<string | undefined>;
  /** Todo mundo do roster, colapsando par número/lid num jid só (número quando
   *  conhecido). Ordem estável de inserção. */
  contacts(): Promise<string[]>;
}

export function makeLidStore(keys: SignalKeyStore): LidStore {
  const lookup = async (id: string): Promise<string | undefined> => {
    const { [id]: v } = await keys.get("lid-mapping", [id]);
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };

  // Espelho em memória do roster — carregado uma vez, evita reler o cofre a
  // cada mensagem e só grava quando entra jid novo.
  let roster: Set<string> | undefined;
  const loadRoster = async (): Promise<Set<string>> => {
    if (roster) return roster;
    const { [ROSTER_ID]: raw } = await keys.get("lid-mapping", [ROSTER_ID]);
    roster = new Set(Array.isArray(raw) ? (raw as unknown[]).filter((x): x is string => typeof x === "string") : []);
    return roster;
  };
  const addToRoster = async (...jids: (string | undefined)[]): Promise<void> => {
    const r = await loadRoster();
    let changed = false;
    for (const j of jids) {
      const norm = jidNormalizedUser(j);
      if ((isJidUser(norm) || isLidUser(norm)) && !r.has(norm)) {
        r.add(norm);
        changed = true;
      }
    }
    if (changed) await keys.set({ "lid-mapping": { [ROSTER_ID]: [...r] } });
  };

  return {
    async remember(pnJid, lidJid) {
      const pn = jidNormalizedUser(pnJid);
      const lid = jidNormalizedUser(lidJid);
      if (!isJidUser(pn) || !isLidUser(lid)) return;
      const [curPn, curLid] = await Promise.all([lookup(lid), lookup(pn)]);
      if (curPn === pn && curLid === lid) return;
      await keys.set({ "lid-mapping": { [lid]: pn, [pn]: lid } });
    },

    async noteContact(jid) {
      await addToRoster(jid);
    },

    async toPn(jid) {
      if (isJidUser(jid)) return jidNormalizedUser(jid);
      if (!isLidUser(jid)) return undefined;
      return lookup(jidNormalizedUser(jid));
    },

    async toLid(jid) {
      if (isLidUser(jid)) return jidNormalizedUser(jid);
      if (!isJidUser(jid)) return undefined;
      return lookup(jidNormalizedUser(jid));
    },

    async contacts() {
      const r = await loadRoster();
      const out: string[] = [];
      const seen = new Set<string>();
      for (const jid of r) {
        // colapsa lid→número quando conhecido; a chave de dedupe é o número
        // (ou o próprio lid se não houver número).
        const pn = isLidUser(jid) ? await lookup(jid) : jid;
        const canonical = pn ?? jid;
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        out.push(canonical);
      }
      return out;
    },
  };
}
