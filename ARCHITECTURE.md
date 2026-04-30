# Arquitetura — Chatwoot AI Bot (Máquinas Ribeiro)

## Visão Geral

Este projeto implementa um atendente virtual para o Chatwoot, usando a API da OpenAI para gerar respostas baseadas em um FAQ customizado. O bot responde automaticamente às mensagens dos clientes e pode escalar para atendimento humano quando necessário.

---

## Diagrama de Arquitetura

```
Cliente (browser/mobile)
        │
        │  Abre widget de chat
        ▼
┌───────────────────┐
│   GitHub Pages    │  → Hospeda o index.html com o widget do Chatwoot
│  (Static Hosting) │    https://rodrigosccardoso.github.io/chatwoot-ai-bot/
└───────────────────┘
        │
        │  Mensagem enviada pelo cliente
        ▼
┌───────────────────┐
│     Chatwoot      │  → Plataforma de atendimento (app.chatwoot.com)
│  (SaaS - Free)    │    Recebe a mensagem e dispara webhook pro Agent Bot
└───────────────────┘
        │
        │  POST /webhook  (payload JSON com mensagem + contexto)
        ▼
┌───────────────────┐
│      Render       │  → Executa o servidor Node.js (index.js)
│  (Free Tier)      │    Processa a mensagem e consulta a OpenAI
└───────────────────┘
        │
        │  Envia histórico + FAQ como contexto
        ▼
┌───────────────────┐
│     OpenAI API    │  → Modelo: gpt-4o-mini
│  (Pay-per-use)    │    Gera resposta baseada no FAQ
└───────────────────┘
        │
        │  Resposta gerada
        ▼
┌───────────────────┐
│     Chatwoot      │  → Bot envia a resposta como mensagem na conversa
│  REST API         │    POST /api/v1/accounts/{id}/conversations/{id}/messages
└───────────────────┘
        │
        ▼
Cliente recebe a resposta
```

---

## Componentes

### 1. GitHub Pages (`index.html`)
- Página estática que embute o widget de chat do Chatwoot
- Não requer servidor — hospedada diretamente pelo GitHub
- URL pública: `https://rodrigosccardoso.github.io/chatwoot-ai-bot/`
- Contém o widget token do Chatwoot para identificar a inbox correta

### 2. Chatwoot (app.chatwoot.com)
- Plataforma SaaS de atendimento ao cliente (plano gratuito)
- Recebe mensagens dos clientes via widget
- Dispara webhook para o Agent Bot a cada nova mensagem de cliente
- Permite visualizar e assumir conversas manualmente (handoff humano)

### 3. Servidor Webhook — Render (`index.js`)
- Servidor Node.js rodando 24/7 no Render (plano free)
- Recebe o webhook do Chatwoot e processa a mensagem
- Mantém histórico das últimas 10 mensagens por conversa (contexto)
- Detecta o token `[[HANDOFF]]` para escalar para humano
- Lê o `faq.md` na inicialização e usa como base de conhecimento

### 4. OpenAI API
- Modelo: `gpt-4o-mini` (custo ~$0.0005 por mensagem)
- Recebe: system prompt com FAQ + histórico da conversa
- Retorna: resposta em linguagem natural

### 5. FAQ (`faq.md`)
- Arquivo Markdown com todo o conhecimento do negócio
- Carregado na memória do servidor ao iniciar
- Para atualizar: editar o arquivo no GitHub → Render redeploya automaticamente

---

## Fluxo de uma Mensagem

```
1. Cliente digita mensagem no widget
2. Chatwoot recebe e verifica se há Agent Bot configurado na inbox
3. Chatwoot faz POST /webhook no Render com:
   - conversation_id
   - message_id
   - conteúdo da mensagem
4. Servidor busca o histórico das últimas 10 mensagens via Chatwoot API
5. Monta o payload para a OpenAI:
   - system: FAQ completo + instruções de comportamento
   - messages: histórico da conversa
6. OpenAI retorna a resposta gerada
7. Servidor faz POST na Chatwoot API para enviar a resposta
8. Cliente vê a resposta no widget
```

---

## API Endpoints

### Webhook (recebido pelo servidor)

```
POST /webhook
Content-Type: application/json

{
  "event": "message_created",
  "message_type": "incoming",
  "conversation": { "id": 123 },
  "content": "Qual o preço da revisão?"
}
```

O servidor ignora mensagens de tipo `outgoing` para evitar loops.

---

### Chatwoot REST API (usada pelo servidor)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/api/v1/accounts/{id}/conversations/{id}/messages` | Busca histórico |
| POST | `/api/v1/accounts/{id}/conversations/{id}/messages` | Envia resposta |

**Headers necessários:**
```
api_access_token: {CHATWOOT_BOT_TOKEN}
Content-Type: application/json
```

---

## Variáveis de Ambiente

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `CHATWOOT_BASE_URL` | URL base do Chatwoot | `https://app.chatwoot.com` |
| `CHATWOOT_ACCOUNT_ID` | ID da conta no Chatwoot | `162682` |
| `CHATWOOT_BOT_TOKEN` | Token do Agent Bot | `D8xbh...` |
| `OPENAI_API_KEY` | Chave da API da OpenAI | `sk-proj-...` |
| `COMPANY_NAME` | Nome exibido no system prompt | `Maquinas Ribeiro` |
| `OPENAI_MODEL` | Modelo da OpenAI (opcional) | `gpt-4o-mini` |
| `PORT` | Porta do servidor (opcional) | `3000` |

---

## Handoff para Humano

Quando o bot não consegue responder, retorna `[[HANDOFF]]`. O servidor:

1. Envia mensagem informando que um humano irá atender
2. Muda status da conversa para `open` (não atribuída)
3. Agente humano vê a conversa no Chatwoot e assume

---

## Infraestrutura e Custos

| Serviço | Função | Custo |
|---------|--------|-------|
| GitHub (repo + pages) | Código-fonte + frontend | **Grátis** |
| Chatwoot (SaaS) | Plataforma de atendimento | **Grátis** |
| Render (Web Service) | Executa o servidor bot | **Grátis** |
| OpenAI (gpt-4o-mini) | Geração de respostas | **~$0** (pay-per-use) |

> **Nota:** O Render no plano gratuito hiberna após 15 minutos de inatividade. A primeira mensagem pode levar até ~50 segundos após inatividade.

---

## Como Atualizar o FAQ

1. Edite o arquivo `faq.md` no repositório GitHub
2. Faça commit na branch `main`
3. O Render detecta o push e redeploya automaticamente em ~2 minutos
4. Nenhuma outra configuração é necessária

---

## Estrutura do Repositório

```
chatwoot-ai-bot/
├── index.js          # Servidor webhook principal
├── faq.md            # Base de conhecimento do negócio
├── package.json      # Dependências Node.js
├── Dockerfile        # Containerização para deploy
├── .env.example      # Exemplo de variáveis de ambiente
├── index.html        # Frontend (widget Chatwoot) — GitHub Pages
├── ARCHITECTURE.md   # Este arquivo
└── README.md         # Guia de instalação e uso
```
