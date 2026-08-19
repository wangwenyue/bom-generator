const MAX_FILES = 3;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);
let githubInstallationToken = null;
let githubInstallationTokenExpiresAt = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.startsWith("/images/")) return serveFeedbackImage(url, env);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ message: "仅支持 POST 请求。" }, 405, cors);
    if (!originAllowed(origin, env.ALLOWED_ORIGIN)) return json({ message: "当前来源不允许提交反馈。" }, 403, cors);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    try {
      await enforceRateLimit(ip, env);
      const form = await request.formData();
      const input = validateInput(form);
      await verifyTurnstile(form.get("turnstileToken"), ip, env.TURNSTILE_SECRET);
      const attachments = form.getAll("attachments");
      await validateAttachments(attachments);

      const feedbackId = crypto.randomUUID();
      const uploadedKeys = [];
      try {
        const imageUrls = [];
        for (let index = 0; index < attachments.length; index += 1) {
          const file = attachments[index];
          const extension = ALLOWED_TYPES.get(file.type);
          const key = `${new Date().toISOString().slice(0, 10)}/${feedbackId}-${index + 1}.${extension}`;
          await env.FEEDBACK_IMAGES.put(key, file.stream(), {
            httpMetadata: { contentType: file.type, cacheControl: "public, max-age=31536000, immutable" },
            customMetadata: { feedbackId },
          });
          uploadedKeys.push(key);
          imageUrls.push(`${url.origin}/images/${key}`);
        }
        const issue = await createGithubIssue(input, imageUrls, feedbackId, env);
        return json({ issueNumber: issue.number, issueUrl: issue.html_url, feedbackId }, 201, cors);
      } catch (error) {
        await Promise.all(uploadedKeys.map((key) => env.FEEDBACK_IMAGES.delete(key)));
        throw error;
      }
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error("feedback_submission_failed", error);
      return json({ message: status >= 500 ? "反馈服务暂时不可用，请稍后重试。" : error.message }, status, cors);
    }
  },
};

async function serveFeedbackImage(url, env) {
  const key = decodeURIComponent(url.pathname.slice("/images/".length));
  if (!/^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}-[1-3]\.(png|jpg|webp)$/.test(key)) return new Response("Not found", { status: 404 });
  const object = await env.FEEDBACK_IMAGES.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  return new Response(object.body, { headers });
}

function validateInput(form) {
  const type = clean(form.get("type"), 20);
  const subject = clean(form.get("subject"), 80);
  const description = clean(form.get("description"), 2000);
  const steps = clean(form.get("steps"), 1200);
  const contact = clean(form.get("contact"), 200);
  if (!["功能异常", "数据问题", "使用建议", "其他"].includes(type)) fail("请选择有效的问题类型。", 400);
  if (subject.length < 2) fail("问题标题至少需要 2 个字符。", 400);
  if (description.length < 5) fail("问题描述至少需要 5 个字符。", 400);
  let context = {};
  try { context = JSON.parse(String(form.get("context") || "{}")); } catch { /* ignore invalid context */ }
  return { type, subject, description, steps, contact, context };
}

async function validateAttachments(files) {
  if (files.length > MAX_FILES) fail(`最多只能上传 ${MAX_FILES} 张截图。`, 400);
  for (const file of files) {
    if (!(file instanceof File) || !ALLOWED_TYPES.has(file.type)) fail("附件仅支持 PNG、JPG 和 WEBP。", 400);
    if (file.size > MAX_FILE_SIZE) fail("单张截图不能超过 5 MB。", 400);
    const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (!matchesSignature(file.type, header)) fail("附件内容与图片格式不一致。", 400);
  }
}

function matchesSignature(type, bytes) {
  if (type === "image/png") return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/webp") return String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return false;
}

async function verifyTurnstile(token, ip, secret) {
  if (!token) fail("请完成人机验证。", 400);
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", String(token));
  body.append("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const result = await response.json();
  if (!result.success) fail("人机验证失败，请刷新后重试。", 403);
}

async function enforceRateLimit(ip, env) {
  const hour = new Date().toISOString().slice(0, 13);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${hour}:${ip}`));
  const key = `rate:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  const count = Number(await env.FEEDBACK_RATE_LIMIT.get(key) || 0);
  if (count >= 5) fail("提交过于频繁，请稍后再试。", 429);
  await env.FEEDBACK_RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 3700 });
}

async function createGithubIssue(input, imageUrls, feedbackId, env) {
  const context = input.context && typeof input.context === "object" ? input.context : {};
  const images = imageUrls.length ? imageUrls.map((url, index) => `![反馈截图 ${index + 1}](${url})`).join("\n\n") : "未提供";
  const body = [
    "## 问题描述", input.description,
    "## 复现步骤", input.steps || "未提供",
    "## 截图", images,
    "## 联系方式", input.contact || "未提供",
    "## 环境信息",
    `- 页面版本：${safeLine(context.appVersion)}`,
    `- 当前步骤：${safeLine(context.activeStep)}`,
    `- 页面地址：${safeLine(context.pageUrl)}`,
    `- 浏览器：${safeLine(context.browser)}`,
    `- 视口：${safeLine(context.viewport)}`,
    `- 提交时间：${safeLine(context.submittedAt)}`,
    `- 反馈编号：${feedbackId}`,
  ].join("\n\n");
  const installationToken = await getGithubInstallationToken(env);
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${installationToken}`,
      "Content-Type": "application/json",
      "User-Agent": "bom-generator-feedback-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ title: `[用户反馈][${input.type}] ${input.subject}`, body, labels: ["user-feedback"] }),
  });
  if (!response.ok) throw Object.assign(new Error(`GitHub API ${response.status}`), { status: 502 });
  return response.json();
}

async function getGithubInstallationToken(env) {
  if (githubInstallationToken && Date.now() < githubInstallationTokenExpiresAt - 60_000) return githubInstallationToken;
  const jwt = await createGithubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const response = await fetch(`https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "bom-generator-feedback-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw Object.assign(new Error(`GitHub App authentication ${response.status}`), { status: 502 });
  const result = await response.json();
  githubInstallationToken = result.token;
  githubInstallationTokenExpiresAt = Date.parse(result.expires_at);
  return githubInstallationToken;
}

async function createGithubAppJwt(appId, privateKeyPem) {
  if (!appId || !privateKeyPem) throw Object.assign(new Error("GitHub App configuration is incomplete"), { status: 500 });
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const signingInput = `${header}.${payload}`;
  const keyData = pemToArrayBuffer(privateKeyPem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function pemToArrayBuffer(pem) {
  const normalized = String(pem).replace(/\\n/g, "\n");
  const isPkcs1 = normalized.includes("BEGIN RSA PRIVATE KEY");
  const base64 = normalized.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s/g, "");
  const binary = atob(base64);
  const der = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return (isPkcs1 ? wrapPkcs1AsPkcs8(der) : der).buffer;
}

function wrapPkcs1AsPkcs8(pkcs1) {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  return derSequence(version, rsaAlgorithm, derValue(0x04, pkcs1));
}

function derSequence(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  return derValue(0x30, body);
}

function derValue(tag, body) {
  const length = derLength(body.length);
  const output = new Uint8Array(1 + length.length + body.length);
  output[0] = tag;
  output.set(length, 1);
  output.set(body, 1 + length.length);
  return output;
}

function derLength(length) {
  if (length < 128) return Uint8Array.of(length);
  const bytes = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function base64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function clean(value, max) { return String(value || "").trim().slice(0, max); }
function safeLine(value) { return String(value || "未知").replace(/[\r\n]+/g, " ").slice(0, 500); }
function fail(message, status) { throw Object.assign(new Error(message), { status }); }
function originAllowed(origin, allowed) { return allowed.split(",").map((item) => item.trim()).includes(origin); }
function corsHeaders(origin, allowed) {
  const headers = { "Content-Type": "application/json; charset=utf-8", Vary: "Origin" };
  if (originAllowed(origin, allowed)) headers["Access-Control-Allow-Origin"] = origin;
  headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  headers["Access-Control-Allow-Headers"] = "Content-Type";
  return headers;
}
function json(data, status, headers) { return new Response(JSON.stringify(data), { status, headers }); }
