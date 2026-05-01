import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
    PORT = 3000,
    CHATWOOT_BASE_URL = "https://app.chatwoot.com",
    CHATWOOT_ACCOUNT_ID,
    CHATWOOT_BOT_TOKEN,
    CHATWOOT_WEBHOOK_TOKEN,
    OPENAI_API_KEY,
    OPENAI_MODEL = "gpt-4o-mini",
    COMPANY_NAME = "Nossa empresa",
    HANDOFF_KEYWORDS = "atendente,humano,pessoa,suporte humano,falar com alguem",
    OFICINA_CRM_URL = "https://oficina-crm.onrender.com",
} = process.env;

if (!CHATWOOT_ACCOUNT_ID || !CHATWOOT_BOT_TOKEN) {
    console.error("Faltam variaveis: CHATWOOT_ACCOUNT_ID, CHATWOOT_BOT_TOKEN");
    process.exit(1);
}
if (!OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY nao configurada - bot fara handoff de tudo.");
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const FAQ_PATH = path.join(__dirname, "faq_loja_mecanica.md");
let FAQ_CONTENT = "";
try {
    FAQ_CONTENT = fs.readFileSync(FAQ_PATH, "utf-8");
    console.log("FAQ carregada:", FAQ_CONTENT.length, "chars");
} catch (e) {
    console.warn("faq_loja_mecanica.md nao encontrado, tentando faq.md...");
    try {
        FAQ_CONTENT = fs.readFileSync(path.join(__dirname, "faq.md"), "utf-8");
        console.log("faq.md carregada como fallback:", FAQ_CONTENT.length, "chars");
    } catch (e2) {
        console.warn("Nenhum arquivo FAQ encontrado.");
    }
}

const SYSTEM_PROMPT = [
    "Voce e o assistente virtual de " + COMPANY_NAME + ".",
    "Responda em portugues do Brasil, de forma cordial e objetiva.",
    "REGRAS:",
    "1. Use APENAS as informacoes da BASE DE CONHECIMENTO abaixo.",
    "   Se nao souber, diga que nao tem a informacao e inclua [[HANDOFF]].",
    "2. Se o usuario pedir atendente humano, inclua [[HANDOFF]].",
    "3. Nao invente dados que nao estejam na base.",
    "4. Mensagens curtas, maximo 4 frases.",
    "",
    "=== BASE DE CONHECIMENTO ===",
    FAQ_CONTENT || "(vazia - sempre faca handoff)",
    "=== FIM DA BASE ===",
].join("\n");

const cw = axios.create({
    baseURL: CHATWOOT_BASE_URL + "/api/v1/accounts/" + CHATWOOT_ACCOUNT_ID,
    headers: { api_access_token: CHATWOOT_BOT_TOKEN },
    timeout: 15000,
});

async function sendMessage(convId, content, isPrivate = false) {
    return cw.post("/conversations/" + convId + "/messages", {
        content,
        message_type: "outgoing",
        private: isPrivate,
    });
}

async function toggleStatus(convId, status) {
    return cw.post("/conversations/" + convId + "/toggle_status", { status });
}

const OS_QUERY_KEYWORDS = [
    "status", "situacao", "pronto", "quando fica", "quando vai ficar",
    "cade", "onde esta", "meu equipamento", "minha ferramenta",
    "minha rocadeira", "minha motosserra", "meu cortador",
    "meu soprador", "ordem de servico", "minha os", "minha ordem",
    "reparo", "conserto", "andamento", "previsao", "retirar", "buscar",
    "prazo", "quanto tempo", "ta pronto", "esta pronto", "ficou pronto",
];

function isOsQuery(text) {
    const t = (text || "").toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return OS_QUERY_KEYWORDS.some((k) => t.includes(k));
}

function extractOsNumber(text) {
    const match = (text || "").match(/OS[-\s]?\d{4}[-\s]?\d{4}/i);
    return match ? match[0].toUpperCase().replace(/\s/g, "") : null;
}

function extractPhone(text) {
    const match = (text || "").match(
        /(?:\+55|55)?\s*(?:\(?\d{2}\)?\s?)[\s-]?\d{4,5}[\s-]?\d{4}/
    );
    if (!match) return null;
    return match[0].replace(/\D/g, "");
}

function getContactPhone(body) {
    const phone =
        body?.conversation?.meta?.sender?.phone_number ||
        body?.conversation?.contact_inbox?.contact?.phone_number || "";
    return phone.replace(/\D/g, "");
}

async function consultarStatusCRM(identifier, type = "telefone") {
    try {
        const url = OFICINA_CRM_URL + "/api/chatbot/status?" + type + "=" + encodeURIComponent(identifier);
        console.log("[CRM] Consultando: " + url);
        const response = await axios.get(url, { timeout: 10000 });
        return response.data;
    } catch (err) {
        console.error("[CRM] Erro na consulta:", err.message);
        return null;
    }
}

// Mapa para rastrear conversas aguardando identificador (telefone ou OS)
const pendingCrmConversations = new Map();

function shouldHandoff(text) {
    const t = (text || "").toLowerCase();
    return HANDOFF_KEYWORDS.split(",").some((k) => t.includes(k.trim().toLowerCase()));
}

async function aiReply(history) {
    const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
    const res = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.3,
        max_tokens: 400,
    });
    const raw = res.choices?.[0]?.message?.content?.trim() || "";
    return {
        text: raw.replace(/\[\[HANDOFF\]\]/g, "").trim(),
        handoff: raw.includes("[[HANDOFF]]"),
    };
}

function buildHistory(payload) {
    const history = [];
    if (Array.isArray(payload?.conversation?.messages)) {
        for (const m of payload.conversation.messages.slice(-10)) {
            if (!m.content) continue;
            history.push({
                role: m.message_type === 0 ? "user" : "assistant",
                content: m.content,
            });
        }
    } else if (payload?.content) {
        history.push({ role: "user", content: payload.content });
    }
    return history;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_, res) => res.send("Chatwoot AI Bot - Oficina CRM integrado."));
app.get("/healthz", (_, res) => res.json({ ok: true }));

app.post("/webhook", async (req, res) => {
    if (CHATWOOT_WEBHOOK_TOKEN) {
        const t = req.headers["x-chatwoot-token"] || req.query.token;
        if (t !== CHATWOOT_WEBHOOK_TOKEN) return res.status(401).json({ error: "invalid token" });
    }

    res.status(200).json({ received: true });

    const { event, message_type, private: isPrivate, content, conversation } = req.body || {};

    try {
        if (event !== "message_created") return;
        if (message_type !== "incoming") return;
        if (isPrivate) return;

        const conversationId = conversation?.id;
        const userText = content || "";
        if (!conversationId || !userText) return;

        const assignee = conversation?.meta?.assignee;
        if (assignee?.id) {
            console.log("Conversa", conversationId, "tem agente. Ignorando.");
            return;
        }

        if (shouldHandoff(userText)) {
            await sendMessage(conversationId, "Vou te transferir para um atendente. Aguarde!");
            await toggleStatus(conversationId, "open");
            return;
        }

        if (!openai) {
            await sendMessage(
                conversationId,
                "Ola! Nosso assistente esta sendo configurado. Transferindo para atendente."
            );
            await toggleStatus(conversationId, "open");
            return;
        }

        // Verifica se esta conversa esta aguardando um identificador (telefone ou OS)
        if (pendingCrmConversations.has(conversationId)) {
            pendingCrmConversations.delete(conversationId);
            const osNumber = extractOsNumber(userText);
            const phone = extractPhone(userText);
            if (osNumber) {
                const crm = await consultarStatusCRM(osNumber, "numero_os");
                if (crm) { await sendMessage(conversationId, crm.mensagem); return; }
            }
            if (phone) {
                const crm = await consultarStatusCRM(phone, "telefone");
                if (crm) { await sendMessage(conversationId, crm.mensagem); return; }
            }
            await sendMessage(
                conversationId,
                "Nao consegui localizar sua OS com essa informacao. " +
                "Por favor, informe o numero da OS (ex: OS-2026-0001) ou o telefone cadastrado na oficina."
            );
            pendingCrmConversations.set(conversationId, Date.now());
            return;
        }

        if (isOsQuery(userText)) {
            const osNumber = extractOsNumber(userText);
            if (osNumber) {
                const crm = await consultarStatusCRM(osNumber, "numero_os");
                if (crm) { await sendMessage(conversationId, crm.mensagem); return; }
            }
            const phoneFromMsg = extractPhone(userText);
            if (phoneFromMsg) {
                const crm = await consultarStatusCRM(phoneFromMsg, "telefone");
                if (crm) { await sendMessage(conversationId, crm.mensagem); return; }
            }
            const phoneFromContact = getContactPhone(req.body);
            if (phoneFromContact) {
                const crm = await consultarStatusCRM(phoneFromContact, "telefone");
                if (crm) { await sendMessage(conversationId, crm.mensagem); return; }
            }
            pendingCrmConversations.set(conversationId, Date.now());
            await sendMessage(
                conversationId,
                "Para consultar o status do seu equipamento, me informe o numero da sua OS " +
                "(ex: OS-2026-0001) ou o telefone cadastrado na oficina."
            );
            return;
        }

        const { text, handoff } = await aiReply(buildHistory(req.body));
        if (text) await sendMessage(conversationId, text);
        if (handoff) {
            await sendMessage(conversationId, "Nota: bot solicitou handoff.", true);
            await toggleStatus(conversationId, "open");
        }
    } catch (err) {
        console.error("Erro webhook:", err?.response?.data || err.message);
    }
});

app.listen(PORT, () => console.log("Bot rodando na porta", PORT));
