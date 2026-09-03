// Camada de PERFIL — foto e recado (bio) da conta logada. Dois `<iq>` simples
// sobre o mesmo `query()` request/response do `client.ts` (espelha o
// `updateProfilePicture` / `updateProfileStatus` do `@whiskeysockets/baileys`).
//
//   foto:  <iq to="s.whatsapp.net" type="set" xmlns="w:profile:picture">
//            <picture type="image">{JPEG}</picture>
//          </iq>
//   remover foto: o mesmo <iq> sem conteúdo.
//   bio:   <iq to="s.whatsapp.net" type="set" xmlns="status">
//            <status>{texto utf-8}</status>
//          </iq>

import { node, getBinaryNodeChild, type BinaryNode } from "../frame/node";
import { utf8Encode, utf8Decode } from "../frame/buffer";

const S_WHATSAPP_NET = "@s.whatsapp.net";

export interface ProfileLayerOptions {
  /** Faz um `<iq>` e resolve com o `<iq type=result>` correspondente. */
  query: (n: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>;
}

export interface ProfileLayer {
  /** Troca a foto de perfil da conta. `jpeg` deve ser um JPEG — o WhatsApp
   *  espera algo quadrado e não muito grande (~640px); imagens fora disso
   *  costumam ser recusadas com `<iq type=error>`. */
  setProfilePicture(jpeg: Uint8Array): Promise<void>;
  /** Remove a foto de perfil da conta. */
  removeProfilePicture(): Promise<void>;
  /** Define o recado / bio (o texto "Recado" do perfil). */
  setBio(text: string): Promise<void>;
  /** URL da foto de perfil de `jid` (contato, grupo ou a própria conta).
   *  `hd` = imagem cheia em vez do preview. `undefined` se não tem foto ou a
   *  privacidade não deixa. */
  getProfilePictureUrl(jid: string, hd?: boolean): Promise<string | undefined>;
  /** Recado / bio (o "Recado") de `jid`. `undefined` se não há ou é privado. */
  fetchStatus(jid: string): Promise<{ status?: string; setAt?: Date } | undefined>;
}

export function createProfileLayer(o: ProfileLayerOptions): ProfileLayer {
  const { query } = o;

  async function setProfilePicture(jpeg: Uint8Array): Promise<void> {
    if (!jpeg || jpeg.length === 0) throw new Error("profile: imagem vazia");
    await query(
      node("iq", { to: S_WHATSAPP_NET, type: "set", xmlns: "w:profile:picture" }, [
        node("picture", { type: "image" }, jpeg),
      ]),
    );
  }

  async function removeProfilePicture(): Promise<void> {
    await query(node("iq", { to: S_WHATSAPP_NET, type: "set", xmlns: "w:profile:picture" }));
  }

  async function setBio(text: string): Promise<void> {
    await query(
      node("iq", { to: S_WHATSAPP_NET, type: "set", xmlns: "status" }, [
        node("status", {}, utf8Encode(text)),
      ]),
    );
  }

  async function getProfilePictureUrl(jid: string, hd = false): Promise<string | undefined> {
    try {
      const res = await query(
        node("iq", { to: jid, type: "get", xmlns: "w:profile:picture" }, [
          node("picture", { type: hd ? "image" : "preview", query: "url" }),
        ]),
      );
      return getBinaryNodeChild(res, "picture")?.attrs.url || undefined;
    } catch {
      // <iq type=error> = sem foto / privado / jid não existe
      return undefined;
    }
  }

  async function fetchStatus(
    jid: string,
  ): Promise<{ status?: string; setAt?: Date } | undefined> {
    try {
      const res = await query(
        node("iq", { to: S_WHATSAPP_NET, type: "get", xmlns: "status" }, [
          node("status", {}, [node("user", { jid })]),
        ]),
      );
      const u = getBinaryNodeChild(getBinaryNodeChild(res, "status"), "user");
      if (!u) return undefined;
      const status =
        typeof u.content === "string"
          ? u.content
          : u.content instanceof Uint8Array
            ? utf8Decode(u.content)
            : undefined;
      const t = Number(u.attrs.t);
      return { status: status || undefined, setAt: Number.isFinite(t) && t > 0 ? new Date(t * 1000) : undefined };
    } catch {
      return undefined;
    }
  }

  return { setProfilePicture, removeProfilePicture, setBio, getProfilePictureUrl, fetchStatus };
}
