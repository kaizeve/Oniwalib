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

import { node, type BinaryNode } from "../frame/node";
import { utf8Encode } from "../frame/buffer";

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

  return { setProfilePicture, removeProfilePicture, setBio };
}
