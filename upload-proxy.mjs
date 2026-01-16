// upload-proxy.mjs
// Node 18+ 권장 (node에 fetch 내장)
// 역할:
//  - POST /fetch?url=...  : GET 다운로드 프록시 (CORS 회피, Authorization/X-Ads-Region 전달)
//  - POST /upload?url=... : PUT 업로드 프록시 (옵션, 필요 시)
// 클라이언트(App.tsx)에서 헤더 전달 방식:
//  - "X-Extra-Headers": JSON 문자열  (예: {"Authorization":"Bearer ...","X-Ads-Region":"..."} )

import http from "node:http";
import { URL } from "node:url";
import { Readable } from "node:stream";

const PORT = Number(process.env.PORT || 8787);

// ✅ 최소 보안장치: 허용 도메인 화이트리스트
// 필요하면 네 환경에 맞게 추가해
const ALLOWED_HOST_SUFFIXES = [
  "developer.api.autodesk.com",
  "autodesk.com",
  "amazonaws.com",
  "cloudfront.net",
  "s3.amazonaws.com",
];

function isAllowedTarget(targetUrl) {
  try {
    const u = new URL(targetUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;

    const host = u.hostname.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Extra-Headers");
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseExtraHeaders(req) {
  const raw = req.headers["x-extra-headers"];
  if (!raw) return {};
  const str = Array.isArray(raw) ? raw[0] : raw;
  try {
    const obj = JSON.parse(str);
    if (!obj || typeof obj !== "object") return {};
    // ✅ 포워딩 허용 헤더만 통과(보안)
    const allowed = ["authorization", "x-ads-region", "accept", "content-type"];
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const lk = String(k).toLowerCase();
      if (allowed.includes(lk) && typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function proxyFetch(targetUrl, method, extraHeaders, bodyBuffer) {
  const controller = new AbortController();
  const timeoutMs = 120_000; // 120s
  const t = setTimeout(() => controller.abort(new Error("proxy timeout")), timeoutMs);

  try {
    const res = await fetch(targetUrl, {
      method,
      headers: {
        ...extraHeaders,
      },
      body: bodyBuffer ? bodyBuffer : undefined,
      redirect: "follow",
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlObj.pathname;
    const target = urlObj.searchParams.get("url");

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Only POST is supported");
      return;
    }

    if (!target) {
      res.statusCode = 400;
      res.end("Missing ?url=");
      return;
    }

    if (!isAllowedTarget(target)) {
      res.statusCode = 403;
      res.end("Target URL not allowed by proxy whitelist");
      return;
    }

    const extraHeaders = parseExtraHeaders(req);

    if (pathname === "/fetch") {
      // GET 다운로드 프록시
      const upstream = await proxyFetch(target, "GET", extraHeaders);

      // 에러면 본문 일부 반환
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(text.slice(0, 2000));
        console.log(`[fetch] ${upstream.status} ${target}`);
        return;
      }

      // content-type 등 기본 헤더 전달
      const ct = upstream.headers.get("content-type") || "application/octet-stream";
      res.setHeader("Content-Type", ct);

      const cl = upstream.headers.get("content-length");
      if (cl) res.setHeader("Content-Length", cl);

      // 스트리밍으로 전달(대용량 대응)
      res.statusCode = 200;
      const body = upstream.body;
      if (!body) {
        res.end();
        return;
      }
      Readable.fromWeb(body).pipe(res);
      console.log(`[fetch] 200 ${target}`);
      return;
    }

    if (pathname === "/upload") {
      // PUT 업로드 프록시(옵션)
      const buf = await readRequestBody(req);
      const upstream = await proxyFetch(target, "PUT", extraHeaders, buf);

      const text = await upstream.text().catch(() => "");
      res.statusCode = upstream.status;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(text.slice(0, 2000));

      console.log(`[upload] ${upstream.status} ${target} (bytes=${buf.length})`);
      return;
    }

    res.statusCode = 404;
    res.end("Not found. Use POST /fetch?url=... or POST /upload?url=...");
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`Proxy error: ${e?.message || String(e)}`);
    console.error(e);
  }
});

server.listen(PORT, () => {
  console.log(`✅ upload-proxy running on http://localhost:${PORT}`);
  console.log(`   POST /fetch?url=...  (downloads)`);
  console.log(`   POST /upload?url=... (uploads, optional)`);
});
