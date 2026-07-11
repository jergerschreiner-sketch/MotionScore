import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { networkInterfaces } from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const certDir = path.join(root, ".certs");
const caKey = path.join(certDir, "motionscore-ca.key");
const caCert = path.join(certDir, "motionscore-ca.crt");
const serverKey = path.join(certDir, "motionscore-local.key");
const serverCert = path.join(certDir, "motionscore-local.crt");
const csr = path.join(certDir, "motionscore-local.csr");
const extFile = path.join(certDir, "motionscore-local.ext");

function localAddress() {
  const interfaces = networkInterfaces();
  const preferred = ["en0", "en1"];
  for (const name of [...preferred, ...Object.keys(interfaces)]) {
    for (const entry of interfaces[name] ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) {
        return entry.address;
      }
    }
  }
  throw new Error("没有找到可用的局域网 IPv4 地址，请确认 Mac 已连接 Wi-Fi。 ");
}

function runOpenSSL(args) {
  execFileSync("/usr/bin/openssl", args, { stdio: "ignore" });
}

function ensureCertificates(ip) {
  mkdirSync(certDir, { recursive: true });
  const marker = path.join(certDir, "local-ip.txt");
  const needsRefresh = !existsSync(serverCert) || !existsSync(marker) || readFileSync(marker, "utf8") !== ip;

  if (!existsSync(caCert) || !existsSync(caKey)) {
    runOpenSSL(["genrsa", "-out", caKey, "2048"]);
    runOpenSSL([
      "req",
      "-x509",
      "-new",
      "-nodes",
      "-key",
      caKey,
      "-sha256",
      "-days",
      "825",
      "-out",
      caCert,
      "-subj",
      "/CN=MotionScore Local CA/O=MotionScore",
    ]);
  }

  if (needsRefresh) {
    runOpenSSL(["genrsa", "-out", serverKey, "2048"]);
    runOpenSSL([
      "req",
      "-new",
      "-key",
      serverKey,
      "-out",
      csr,
      "-subj",
      "/CN=MotionScore Local/O=MotionScore",
    ]);
    writeFileSync(
      extFile,
      [
        "authorityKeyIdentifier=keyid,issuer",
        "basicConstraints=CA:FALSE",
        "keyUsage=digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        `subjectAltName=IP:${ip},IP:127.0.0.1,DNS:localhost`,
      ].join("\n"),
    );
    runOpenSSL([
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      serverCert,
      "-days",
      "825",
      "-sha256",
      "-extfile",
      extFile,
    ]);
    writeFileSync(marker, ip);
  }
}

const ip = localAddress();
ensureCertificates(ip);

const vinextBin = path.join(root, "node_modules", ".bin", "vinext");
const app = spawn(vinextBin, ["dev", "--host", "127.0.0.1", "--port", "3000"], {
  cwd: root,
  env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
  stdio: ["ignore", "pipe", "pipe"],
});

app.stdout.on("data", (chunk) => process.stdout.write(chunk));
app.stderr.on("data", (chunk) => process.stderr.write(chunk));

const installer = http.createServer((request, response) => {
  if (request.url === "/motionscore-ca.crt") {
    response.writeHead(200, {
      "Content-Type": "application/x-x509-ca-cert",
      "Content-Disposition": 'attachment; filename="motionscore-ca.crt"',
      "Cache-Control": "no-store",
    });
    response.end(readFileSync(caCert));
    return;
  }

  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width"><title>惯性谱本地连接</title><style>body{margin:0;background:#10110f;color:#f1efe7;font:16px -apple-system;padding:34px;line-height:1.7}main{max-width:520px;margin:auto}b{color:#d7ff45}a{display:block;margin:24px 0;padding:16px;border-radius:14px;background:#d7ff45;color:#10110f;text-align:center;text-decoration:none;font-weight:700}small{opacity:.55}</style><main><h1>惯性谱<br>本地安全连接</h1><p>第一步：下载并安装 MotionScore 本地证书。</p><a href="/motionscore-ca.crt">下载本地证书</a><p>安装并信任证书后，返回 Safari 打开：</p><a href="https://${ip}:3443">进入 MotionScore</a><small>此证书只用于当前 Mac 与同一 Wi-Fi 下的 iPhone 测试。</small></main></html>`);
});

const secureProxy = https.createServer(
  { key: readFileSync(serverKey), cert: readFileSync(serverCert) },
  (request, response) => {
    if (request.url === "/local-peerjs.js") {
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(readFileSync(path.join(root, "node_modules", "peerjs", "dist", "peerjs.min.js")));
      return;
    }

    const proxy = http.request(
      {
        hostname: "::1",
        port: 3000,
        path: request.url,
        method: request.method,
        headers: {
          ...request.headers,
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
      },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(response);
      },
    );
    proxy.on("error", () => {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("MotionScore 正在启动，请稍后刷新。 ");
    });
    request.pipe(proxy);
  },
);

installer.listen(8080, "0.0.0.0", () => {
  console.log(`\n[MotionScore] iPhone 证书安装页: http://${ip}:8080`);
});

secureProxy.listen(3443, "0.0.0.0", () => {
  console.log(`[MotionScore] 安全测试地址: https://${ip}:3443\n`);
});

function shutdown() {
  installer.close();
  secureProxy.close();
  app.kill("SIGINT");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
