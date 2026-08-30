# Publicar o oniwalib no GitHub — passo a passo

Guia pra subir e manter o repo atualizado. O ambiente do Claude é efêmero: a
credencial não sobrevive entre sessões, então a parte "por sessão" se repete.

---

## 1. Uma vez só — no navegador

### 1.1 Criar o repositório (privado)

<https://github.com/new>

- **Repository name:** `oniwalib`
- **Visibility:** **Private** — obrigatório, a licença é de uso exclusivo
- **NÃO** marque "Add a README" / "Add .gitignore" / "Choose a license"
  (o repo local já tem os três)
- Create repository

### 1.2 Criar o token de acesso

<https://github.com/settings/personal-access-tokens/new> (fine-grained)

- **Token name:** `oniwalib-claude`
- **Expiration:** 30 days (ou menos)
- **Repository access:** Only select repositories → `oniwalib`
- **Permissions → Repository permissions:**
  - **Contents:** Read and write
  - (Metadata: Read-only entra sozinho)
- Generate token → **copia o valor** (`github_pat_...`). Só aparece uma vez.

Pra revogar depois: mesma página, botão Revoke.

---

## 2. Por sessão — o que passar pro Claude

Cola isto no chat, trocando os dois campos:

```
usuario github: <SEU_USUARIO>
token: github_pat_xxxxxxxxxxxxxxxxxxxx
```

O Claude então roda (ou você mesmo, no prompt com `!`):

### 2.1 Primeira vez (repo ainda não tem remote)

```bash
cd /root/oniwalib
git remote add origin https://<SEU_USUARIO>:<TOKEN>@github.com/<SEU_USUARIO>/oniwalib.git
git push -u origin main
```

### 2.2 Ambiente novo, código já existe no GitHub

```bash
cd /root && rm -rf oniwalib
git clone https://<SEU_USUARIO>:<TOKEN>@github.com/<SEU_USUARIO>/oniwalib.git
```

### 2.3 Ambiente novo, código só local (perdeu o clone)

```bash
cd /root/oniwalib
git remote set-url origin https://<SEU_USUARIO>:<TOKEN>@github.com/<SEU_USUARIO>/oniwalib.git 2>/dev/null \
  || git remote add origin https://<SEU_USUARIO>:<TOKEN>@github.com/<SEU_USUARIO>/oniwalib.git
git push -u origin main --force-with-lease
```

---

## 3. Atualizar (toda vez que tiver mudança)

```bash
cd /root/oniwalib
git add -A
git commit -m "feat: <o que mudou>"
git push
```

O Claude faz isso quando você pedir. Ele **não** empurra sozinho em background
nem entre sessões.

---

## 4. Higiene do token

- O token colado no chat fica no histórico da conversa. Por isso: **fine-grained,
  1 repo, expiração curta.**
- Terminou a rodada de trabalho? Revoga o token. Cria outro na próxima.
- Nunca commite o token. Ele só entra na URL do `remote` local (que não é
  versionado) ou num comando de push avulso.
