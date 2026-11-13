import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import stream from "node:stream";
import url from "node:url";
import JSZip from "jszip";
import { createServer as createViteServer } from "vite";
import { checkIslandContentPolicy } from "./src/content_policy";
import { type AppEnv, resolveRuntimeEnv } from "./src/env_types";
import { resolveWorldLiveFeeds } from "./src/live_feeds";
import { chooseMoveWithGeminiFlashLite, validateMinigameRequest } from "./src/minigame_ai";
import { MultiplayerHub } from "./src/multiplayer_hub";
import {
  buildSecurityHeaders,
  readBoundedJsonBody,
  resolveVisitorIdentity,
  safeLogError,
  sanitizePlainText,
  validateImageDataUrl,
  verifyMutationSecurity,
} from "./src/security";
import type { TrafficIncidentReason } from "./src/types";
import { WorldStore } from "./src/world_store";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

type NodeIncomingReq = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
};

type NodeServerRes = {
  statusCode: number;
  headersSent?: boolean;
  setHeader(name: string, value: string | string[]): void;
  end(chunk?: unknown): void;
};

type NodeUpgradeSocket = {
  write(chunk: string | Uint8Array): boolean;
  destroy(): void;
};

const minigameBuckets = new Map<string, { windowStart: number; count: number }>();
function allowMinigameMove(ipHash: string): boolean {
  const now = Date.now();
  if (minigameBuckets.size > 1024) {
    for (const [k, b] of minigameBuckets.entries()) {
      if (now - b.windowStart > 60_000) minigameBuckets.delete(k);
    }
  }
  const cur = minigameBuckets.get(ipHash);
  if (!cur || now - cur.windowStart > 60_000) {
    minigameBuckets.set(ipHash, { windowStart: now, count: 1 });
    return true;
  }
  if (cur.count >= 90) return false;
  cur.count++;
  return true;
}

const incidentBuckets = new Map<string, { windowStart: number; count: number }>();
function allowTrafficIncidentReport(ipHash: string): boolean {
  const now = Date.now();
  if (incidentBuckets.size > 1024) {
    for (const [k, b] of incidentBuckets.entries()) {
      if (now - b.windowStart > 60_000) incidentBuckets.delete(k);
    }
  }
  const cur = incidentBuckets.get(ipHash);
  if (!cur || now - cur.windowStart > 60_000) {
    incidentBuckets.set(ipHash, { windowStart: now, count: 1 });
    return true;
  }
  if (cur.count >= 24) return false;
  cur.count++;
  return true;
}

function jsonResponse(
  request: Request,
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const isHttps =
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https";
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...buildSecurityHeaders(isHttps),
      ...(extraHeaders ?? {}),
    },
  });
}

function toWebRequest(req: NodeIncomingReq): Request {
  const proto =
    (typeof req.headers["x-forwarded-proto"] === "string" &&
      req.headers["x-forwarded-proto"].split(",")[0].trim()) ||
    "http";
  const host =
    (typeof req.headers["x-forwarded-host"] === "string" &&
      req.headers["x-forwarded-host"].split(",")[0].trim()) ||
    req.headers.host ||
    `localhost:${PORT}`;
  const fullUrl = `${proto}://${host}${req.url || "/"}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") {
      headers.set(k, v);
    } else if (Array.isArray(v)) {
      headers.set(k, v.join(", "));
    }
  }

  const method = (req.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
  };
  if (hasBody) {
    init.body = stream.Readable.toWeb(
      req as unknown as Parameters<typeof stream.Readable.toWeb>[0],
    ) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(fullUrl, init);
}

async function sendWebResponse(res: NodeServerRes, webRes: Response): Promise<void> {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const setCookies = (webRes.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (setCookies && setCookies.length > 0) {
    res.setHeader("set-cookie", setCookies);
  }
  if (!webRes.body) {
    res.end();
    return;
  }
  const buf = Buffer.from(await webRes.arrayBuffer());
  res.end(buf);
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function tryServeStaticFile(req: NodeIncomingReq, res: NodeServerRes, rootDir: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const cleanRel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const resolved = path.resolve(rootDir, cleanRel);
  if (!resolved.startsWith(path.resolve(rootDir))) {
    return false;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return false;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.statusCode = 200;
  res.setHeader("content-type", MIME_BY_EXT[ext] || "application/octet-stream");
  res.setHeader("x-content-type-options", "nosniff");
  if (ext === ".png" || ext === ".jpg" || ext === ".ico") {
    res.setHeader("cache-control", "public, max-age=3600");
  }
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  fs.createReadStream(resolved).pipe(res as unknown as NodeJS.WritableStream);
  return true;
}

function collectProjectFiles(): Array<{ relPath: string; content: Buffer }> {
  const root = __dirname;
  const results: Array<{ relPath: string; content: Buffer }> = [];
  const excludeDirs = new Set(["node_modules", "dist", ".git", ".aistudio"]);
  const excludeFiles = new Set([".env", "bun.lock"]);

  function walk(dir: string, baseRel: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (excludeDirs.has(name)) continue;
        walk(path.join(dir, name), baseRel ? `${baseRel}/${name}` : name);
      } else if (entry.isFile()) {
        if (excludeFiles.has(name)) continue;
        const relPath = baseRel ? `${baseRel}/${name}` : name;
        try {
          const content = fs.readFileSync(path.join(dir, name));
          results.push({ relPath, content });
        } catch (e) {
          console.error("Failed to read file for github export:", relPath, e);
        }
      }
    }
  }

  walk(root, "");
  return results;
}

function sanitizeApkFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "GeminIsland";
}

function buildCapacitorConfigJson(opts: {
  appId: string;
  appName: string;
  serverUrl?: string;
}): string {
  const config: Record<string, unknown> = {
    appId: opts.appId || "com.geminisland.app",
    appName: opts.appName || "GeminIsland",
    webDir: "dist",
    android: {
      allowMixedContent: true,
      backgroundColor: "#84c960",
    },
  };
  if (opts.serverUrl && /^https?:\/\/.+/.test(opts.serverUrl)) {
    config.server = {
      url: opts.serverUrl,
      cleartext: true,
    };
  }
  return JSON.stringify(config, null, 2) + "\n";
}

function buildApkWorkflowYaml(appName: string): string {
  const apkBase = sanitizeApkFilename(appName);
  return `name: Build Android APK

on:
  push:
    branches: [ main, master ]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build-apk:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Setup Java 17
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'

      - name: Configure Preinstalled Android SDK & Licenses
        run: |
          SDK_ROOT="\${ANDROID_HOME:-/usr/local/lib/android/sdk}"
          echo "ANDROID_HOME=$SDK_ROOT" >> $GITHUB_ENV
          echo "ANDROID_SDK_ROOT=$SDK_ROOT" >> $GITHUB_ENV
          SDKMGR=""
          if [ -x "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]; then
            SDKMGR="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
          elif [ -x "$SDK_ROOT/tools/bin/sdkmanager" ]; then
            SDKMGR="$SDK_ROOT/tools/bin/sdkmanager"
          fi
          if [ -n "$SDKMGR" ]; then
            yes | "$SDKMGR" --licenses > /dev/null 2>&1 || true
          fi

      - name: Install dependencies & build web bundle
        run: |
          npm install --legacy-peer-deps
          npm run build

      - name: Setup Capacitor Android
        run: |
          npm install --legacy-peer-deps @capacitor/core@^6.2.0 @capacitor/cli@^6.2.0 @capacitor/android@^6.2.0
          if [ ! -d "android" ]; then
            npx cap add android
          fi
          npx cap sync android

      - name: Build Debug APK
        run: |
          cd android
          chmod +x gradlew
          ./gradlew assembleDebug --no-daemon

      - name: Package APK
        run: |
          cp android/app/build/outputs/apk/debug/app-debug.apk ./${apkBase}-debug.apk

      - name: Upload APK Artifact
        uses: actions/upload-artifact@v4
        with:
          name: ${apkBase}-APK
          path: ${apkBase}-debug.apk
          retention-days: 30

      - name: Create GitHub Release with APK
        uses: softprops/action-gh-release@v2
        with:
          tag_name: apk-v\${{ github.run_number }}
          name: ${appName || "GeminIsland"} APK #\${{ github.run_number }}
          body: "Automated Android APK build generated via GitHub Actions."
          files: ${apkBase}-debug.apk
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
}

export async function startServer(customPort?: number) {
  const mpHub = new MultiplayerHub();

  const worldStore = new WorldStore({
    getEnv: () => resolveRuntimeEnv(),
    onBroadcast: (payload) => {
      mpHub.broadcastWorldEvent(payload);
    },
  });

  async function handleApiRequest(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/mp") {
        if (request.method !== "POST") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const csrfErr = verifyMutationSecurity(request);
        if (csrfErr) {
          return jsonResponse(request, { ok: false, error: csrfErr }, 403);
        }
        const parsed = await readBoundedJsonBody(request, 32_768);
        if (!parsed.ok) {
          return jsonResponse(request, { ok: false, error: parsed.error }, parsed.status);
        }
        const syncRes = mpHub.handleHttpSync(parsed.data);
        return jsonResponse(request, syncRes, 200);
      }

      if (url.pathname === "/api/world") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const id = await resolveVisitorIdentity(request, env);
        const snapshot = worldStore.getWorldSnapshot(id.cookieId, id.dayKey);
        return jsonResponse(
          request,
          {
            ...snapshot,
            visitorToken: id.visitorToken,
          },
          200,
          id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined,
        );
      }

      if (url.pathname === "/api/job") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const id = await resolveVisitorIdentity(request, env);
        const jobId = sanitizePlainText(url.searchParams.get("id") ?? "", 64, true);
        const statusRes = worldStore.getBuildJobStatus(jobId || null, id.cookieId, id.dayKey);
        const feeds = statusRes.world
          ? await resolveWorldLiveFeeds(statusRes.world.creations)
          : undefined;
        return jsonResponse(
          request,
          {
            ok: true,
            job: statusRes.job,
            visitorToken: id.visitorToken,
            ...(statusRes.world ? { world: statusRes.world } : {}),
            ...(feeds ? { feeds } : {}),
          },
          200,
          id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined,
        );
      }

      if (url.pathname === "/api/feeds") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const snapshot = worldStore.getWorldSnapshot("", "");
        const feeds = await resolveWorldLiveFeeds(snapshot.creations);
        return jsonResponse(request, { ok: true, feeds }, 200, {
          "cache-control": "public, max-age=20",
        });
      }

      if (url.pathname === "/api/audit") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const report = worldStore.getWorldAuditReport();
        return jsonResponse(request, report, 200, {
          "cache-control": "public, max-age=10",
        });
      }

      if (url.pathname === "/api/eta") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const telemetry = worldStore.getBuildEtaTelemetry();
        const diagnostics = worldStore.getBuildDiagnostics();
        return jsonResponse(
          request,
          { ok: true, telemetry, diagnostics },
          200,
          { "cache-control": "public, max-age=5" },
        );
      }

      if (url.pathname === "/api/traffic-incident") {
        if (request.method !== "POST") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const csrfErr = verifyMutationSecurity(request);
        if (csrfErr) {
          return jsonResponse(request, { ok: false, error: csrfErr }, 403);
        }
        const id = await resolveVisitorIdentity(request, env);
        if (!allowTrafficIncidentReport(id.ipHash)) {
          return jsonResponse(request, { ok: false, error: "Rate limited." }, 429);
        }
        const parsedBody = await readBoundedJsonBody(request, 4_096);
        if (!parsedBody.ok) {
          return jsonResponse(request, { ok: false, error: parsedBody.error }, parsedBody.status);
        }
        const raw = parsedBody.data;
        const vehicleId = sanitizePlainText(raw.vehicleId, 64, true);
        const peerVehicleId = raw.peerVehicleId
          ? sanitizePlainText(raw.peerVehicleId, 64, true)
          : null;
        const allowedReasons = new Set<TrafficIncidentReason>([
          "clash_gridlock",
          "turnaround_blocked",
          "building_obstruction",
          "self_restored",
        ]);
        const rawReason = sanitizePlainText(raw.reason, 32, true) as TrafficIncidentReason;
        const reason: TrafficIncidentReason = allowedReasons.has(rawReason)
          ? rawReason
          : "self_restored";
        const x = typeof raw.x === "number" && Number.isFinite(raw.x) ? raw.x : 0;
        const z = typeof raw.z === "number" && Number.isFinite(raw.z) ? raw.z : 0;
        if (!vehicleId) {
          return jsonResponse(request, { ok: false, error: "vehicleId required." }, 400);
        }
        const result = worldStore.reportTrafficIncident({
          vehicleId,
          peerVehicleId,
          x,
          z,
          reason,
        });
        return jsonResponse(request, result, result.ok ? 200 : 404);
      }

      if (url.pathname === "/api/minigame-move") {
        if (request.method !== "POST") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const csrfErr = verifyMutationSecurity(request);
        if (csrfErr) {
          return jsonResponse(request, { ok: false, error: csrfErr }, 403);
        }
        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) {
          return jsonResponse(
            request,
            { ok: false, error: "Gemini opponent is temporarily unavailable." },
            503,
          );
        }
        const id = await resolveVisitorIdentity(request, env);
        if (!allowMinigameMove(id.ipHash)) {
          return jsonResponse(
            request,
            { ok: false, error: "Too many rapid moves — pause a moment." },
            429,
          );
        }
        const parsedBody = await readBoundedJsonBody(request, 8_192);
        if (!parsedBody.ok) {
          return jsonResponse(request, { ok: false, error: parsedBody.error }, parsedBody.status);
        }
        const validated = validateMinigameRequest(parsedBody.data);
        if (!validated.ok) {
          return jsonResponse(request, { ok: false, error: validated.error }, 400);
        }
        const result = await chooseMoveWithGeminiFlashLite({
          apiKey,
          configuredModel: env.MINIGAME_MODEL,
          req: validated.req,
          validMoves: validated.validMoves,
        });
        return jsonResponse(request, { ok: true, ...result }, 200);
      }

      if (url.pathname === "/api/build") {
        if (request.method !== "POST") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const csrfErr = verifyMutationSecurity(request);
        if (csrfErr) {
          return jsonResponse(request, { ok: false, error: csrfErr }, 403);
        }
        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) {
          return jsonResponse(
            request,
            { ok: false, error: "Sculpting service requires GEMINI_API_KEY." },
            503,
          );
        }

        const parsedBody = await readBoundedJsonBody(request, 5_000_000);
        if (!parsedBody.ok) {
          return jsonResponse(request, { ok: false, error: parsedBody.error }, parsedBody.status);
        }
        const body = parsedBody.data;
        const prompt = sanitizePlainText(body.prompt, 480, true);
        const imgCheck = validateImageDataUrl(body.imageDataUrl);
        if (!imgCheck.ok) {
          return jsonResponse(request, { ok: false, error: imgCheck.error }, imgCheck.status);
        }
        if (!prompt && !imgCheck.base64) {
          return jsonResponse(
            request,
            { ok: false, error: "Add a photo or short description first." },
            400,
          );
        }
        if (prompt) {
          const policyRes = checkIslandContentPolicy(prompt);
          if (!policyRes.allowed) {
            return jsonResponse(request, { ok: false, error: policyRes.reason }, 400);
          }
        }

        const id = await resolveVisitorIdentity(request, env);
        const cookieHeaders = id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined;

        const enqueued = await worldStore.enqueueBuildJob({
          ipHash: id.ipHash,
          cookieId: id.cookieId,
          dayKey: id.dayKey,
          prompt,
          imageBase64: imgCheck.base64,
          imageMimeType: imgCheck.mimeType,
          x: typeof body.x === "number" && Number.isFinite(body.x) ? body.x : null,
          z: typeof body.z === "number" && Number.isFinite(body.z) ? body.z : null,
          yaw: typeof body.yaw === "number" && Number.isFinite(body.yaw) ? body.yaw : null,
        });

        if (!enqueued.ok) {
          const extra = {
            ...(cookieHeaders ?? {}),
            ...(enqueued.retryAfterSec ? { "Retry-After": String(enqueued.retryAfterSec) } : {}),
          };
          return jsonResponse(
            request,
            {
              ok: false,
              ...(enqueued.alreadyPlaced
                ? { alreadyPlaced: true, myCreationId: enqueued.myCreationId }
                : {}),
              error: enqueued.error,
            },
            enqueued.status,
            extra,
          );
        }

        return jsonResponse(
          request,
          {
            ok: true,
            queued: true,
            job: enqueued.job,
            visitorToken: id.visitorToken,
          },
          200,
          cookieHeaders,
        );
      }

      if (url.pathname === "/api/github/zip") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const zip = new JSZip();
        const files = collectProjectFiles();
        const seen = new Set(files.map((f) => f.relPath));
        for (const file of files) {
          zip.file(file.relPath, file.content);
        }
        if (!seen.has("public/offline_world.json")) {
          const snapshot = worldStore.getWorldSnapshot("", "");
          zip.file("public/offline_world.json", JSON.stringify(snapshot));
        }
        if (!seen.has("capacitor.config.json")) {
          zip.file(
            "capacitor.config.json",
            buildCapacitorConfigJson({ appId: "com.geminisland.app", appName: "GeminIsland" }),
          );
        }
        if (!seen.has(".github/workflows/build-apk.yml")) {
          zip.file(".github/workflows/build-apk.yml", buildApkWorkflowYaml("GeminIsland"));
        }
        const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
        return new Response(new Uint8Array(zipBuffer), {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="geminisland-project.zip"',
            "cache-control": "no-store",
          },
        });
      }

      if (url.pathname === "/api/github/upload") {
        if (request.method !== "POST") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const csrfErr = verifyMutationSecurity(request);
        if (csrfErr) {
          return jsonResponse(request, { ok: false, error: csrfErr }, 403);
        }
        const parsedBody = await readBoundedJsonBody(request, 65_536);
        if (!parsedBody.ok) {
          return jsonResponse(request, { ok: false, error: parsedBody.error }, parsedBody.status);
        }
        const body = parsedBody.data;
        const token = sanitizePlainText(body.token, 256, true);
        const repoName = sanitizePlainText(body.repoName || "geminisland-app", 100, true).replace(/\s+/g, "-");
        const description = sanitizePlainText(
          body.description || "Gemini 3D Voxel Island project exported from AI Studio",
          256,
          true,
        );
        const isPrivate = Boolean(body.isPrivate);
        const buildApk = body.buildApk !== false;
        const appName = sanitizePlainText(body.appName || "GeminIsland", 60, true) || "GeminIsland";
        const rawAppId = sanitizePlainText(body.appId || "com.geminisland.app", 100, true);
        const appId = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(rawAppId)
          ? rawAppId
          : "com.geminisland.app";
        const serverUrl = sanitizePlainText(body.serverUrl || "", 512, false);

        if (!token) {
          return jsonResponse(request, { ok: false, error: "GitHub Personal Access Token (PAT) is required." }, 400);
        }
        if (!repoName) {
          return jsonResponse(request, { ok: false, error: "Repository name is required." }, 400);
        }

        const ghHeaders = {
          Authorization: `Bearer ${token}`,
          "User-Agent": "GeminIsland-Applet",
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        };

        const userRes = await fetch("https://api.github.com/user", { headers: ghHeaders });
        if (!userRes.ok) {
          const errText = await userRes.text();
          return jsonResponse(
            request,
            { ok: false, error: `Invalid GitHub Token or unauthorized (${userRes.status}): ${errText.slice(0, 120)}` },
            400,
          );
        }
        const userData = (await userRes.json()) as { login: string };
        const owner = userData.login;

        const repoRes = await fetch("https://api.github.com/user/repos", {
          method: "POST",
          headers: ghHeaders,
          body: JSON.stringify({
            name: repoName,
            description,
            private: isPrivate,
            auto_init: true,
          }),
        });

        let repoData: { html_url: string; full_name: string; default_branch?: string } | null = null;
        if (repoRes.ok) {
          repoData = (await repoRes.json()) as { html_url: string; full_name: string; default_branch?: string };
        } else {
          const existingRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
            headers: ghHeaders,
          });
          if (existingRes.ok) {
            repoData = (await existingRes.json()) as { html_url: string; full_name: string; default_branch?: string };
          } else {
            const errText = await repoRes.text();
            return jsonResponse(
              request,
              { ok: false, error: `Could not create or access repository '${repoName}' (${repoRes.status}): ${errText.slice(0, 150)}` },
              400,
            );
          }
        }

        const defaultBranch = repoData.default_branch || "main";

        // Ensure repository has at least one commit / readable branch ref
        let headCommitSha: string | null = null;
        for (let attempt = 0; attempt < 6; attempt++) {
          const refRes = await fetch(
            `https://api.github.com/repos/${owner}/${repoName}/git/ref/heads/${defaultBranch}`,
            { headers: ghHeaders },
          );
          if (refRes.ok) {
            const refData = (await refRes.json()) as { object?: { sha?: string } };
            headCommitSha = refData.object?.sha || null;
            if (headCommitSha) break;
          } else if (refRes.status === 409 || (refRes.status === 404 && attempt >= 2)) {
            // Empty repository: seed README.md first
            await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/README.md`, {
              method: "PUT",
              headers: ghHeaders,
              body: JSON.stringify({
                message: "Initial commit",
                content: Buffer.from(`# ${repoName}\n\n${description}\n`, "utf8").toString("base64"),
              }),
            });
          }
          await new Promise((r) => setTimeout(r, 700));
        }

        if (!headCommitSha) {
          return jsonResponse(
            request,
            { ok: false, error: `Repository branch '${defaultBranch}' could not be initialized. Please retry.` },
            500,
          );
        }

        const commitInfoRes = await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/git/commits/${headCommitSha}`,
          { headers: ghHeaders },
        );
        if (!commitInfoRes.ok) {
          return jsonResponse(request, { ok: false, error: "Failed to read repository base commit." }, 500);
        }
        const commitInfo = (await commitInfoRes.json()) as { tree: { sha: string } };
        const baseTreeSha = commitInfo.tree.sha;

        // Collect project files and inject offline world bundle + APK build files
        const filesMap = new Map<string, Buffer>();
        for (const file of collectProjectFiles()) {
          filesMap.set(file.relPath, file.content);
        }
        const offlineSnapshot = worldStore.getWorldSnapshot("", "");
        filesMap.set(
          "public/offline_world.json",
          Buffer.from(JSON.stringify(offlineSnapshot), "utf8"),
        );
        if (buildApk) {
          filesMap.set(
            "capacitor.config.json",
            Buffer.from(buildCapacitorConfigJson({ appId, appName, serverUrl }), "utf8"),
          );
          filesMap.set(
            ".github/workflows/build-apk.yml",
            Buffer.from(buildApkWorkflowYaml(appName), "utf8"),
          );
        }

        const allFiles = Array.from(filesMap.entries()).map(([relPath, content]) => ({ relPath, content }));
        const treeEntries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
        const errors: string[] = [];

        const BATCH_SIZE = 8;
        for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
          const batch = allFiles.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            batch.map(async (file) => {
              try {
                const blobRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/blobs`, {
                  method: "POST",
                  headers: ghHeaders,
                  body: JSON.stringify({
                    content: file.content.toString("base64"),
                    encoding: "base64",
                  }),
                });
                if (!blobRes.ok) {
                  errors.push(`${file.relPath}: ${blobRes.status}`);
                  return null;
                }
                const blobData = (await blobRes.json()) as { sha: string };
                return {
                  path: file.relPath,
                  mode: "100644",
                  type: "blob",
                  sha: blobData.sha,
                };
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : "error";
                errors.push(`${file.relPath}: ${msg}`);
                return null;
              }
            }),
          );
          for (const entry of results) {
            if (entry) treeEntries.push(entry);
          }
        }

        if (treeEntries.length === 0) {
          return jsonResponse(request, { ok: false, error: "Failed to upload project files as Git blobs." }, 500);
        }

        const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/trees`, {
          method: "POST",
          headers: ghHeaders,
          body: JSON.stringify({
            base_tree: baseTreeSha,
            tree: treeEntries,
          }),
        });
        if (!treeRes.ok) {
          const errText = await treeRes.text();
          return jsonResponse(
            request,
            { ok: false, error: `Failed to create Git tree (${treeRes.status}): ${errText.slice(0, 150)}` },
            500,
          );
        }
        const newTree = (await treeRes.json()) as { sha: string };

        const newCommitRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/commits`, {
          method: "POST",
          headers: ghHeaders,
          body: JSON.stringify({
            message: buildApk
              ? "Auto-upload GeminIsland with Android APK GitHub Actions workflow"
              : "Auto-upload GeminIsland from AI Studio",
            tree: newTree.sha,
            parents: [headCommitSha],
          }),
        });
        if (!newCommitRes.ok) {
          const errText = await newCommitRes.text();
          return jsonResponse(
            request,
            { ok: false, error: `Failed to create commit (${newCommitRes.status}): ${errText.slice(0, 150)}` },
            500,
          );
        }
        const newCommit = (await newCommitRes.json()) as { sha: string };

        const updateRefRes = await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/git/refs/heads/${defaultBranch}`,
          {
            method: "PATCH",
            headers: ghHeaders,
            body: JSON.stringify({ sha: newCommit.sha, force: false }),
          },
        );
        if (!updateRefRes.ok) {
          const errText = await updateRefRes.text();
          if (errText.toLowerCase().includes("workflow")) {
            return jsonResponse(
              request,
              {
                ok: false,
                error:
                  "توکن گیت‌هاب شما دسترسی «workflow» ندارد! لطفاً هنگام ساخت توکن (PAT)، هر دو گزینه repo و workflow را تیک بزنید.",
              },
              403,
            );
          }
          return jsonResponse(
            request,
            { ok: false, error: `Failed to push commit to '${defaultBranch}' (${updateRefRes.status}): ${errText.slice(0, 180)}` },
            400,
          );
        }

        return jsonResponse(
          request,
          {
            ok: true,
            owner,
            repoName,
            repoUrl: repoData.html_url,
            actionsUrl: `${repoData.html_url}/actions`,
            releasesUrl: `${repoData.html_url}/releases`,
            fullName: repoData.full_name,
            commitSha: newCommit.sha,
            uploadedCount: treeEntries.length,
            totalFiles: allFiles.length,
            buildApk,
            errors: errors.length > 0 ? errors : undefined,
          },
          200,
        );
      }

      if (url.pathname === "/api/github/workflow-status") {
        if (request.method !== "POST") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const csrfErr = verifyMutationSecurity(request);
        if (csrfErr) {
          return jsonResponse(request, { ok: false, error: csrfErr }, 403);
        }
        const parsedBody = await readBoundedJsonBody(request, 16_384);
        if (!parsedBody.ok) {
          return jsonResponse(request, { ok: false, error: parsedBody.error }, parsedBody.status);
        }
        const body = parsedBody.data;
        const token = sanitizePlainText(body.token, 256, true);
        const owner = sanitizePlainText(body.owner, 100, true);
        const repoName = sanitizePlainText(body.repoName, 100, true);

        if (!token || !owner || !repoName) {
          return jsonResponse(request, { ok: false, error: "token, owner, and repoName are required." }, 400);
        }

        const ghHeaders = {
          Authorization: `Bearer ${token}`,
          "User-Agent": "GeminIsland-Applet",
          Accept: "application/vnd.github.v3+json",
        };

        const runsRes = await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/actions/runs?per_page=5`,
          { headers: ghHeaders },
        );
        if (!runsRes.ok) {
          return jsonResponse(request, { ok: false, error: `GitHub API error (${runsRes.status})` }, 400);
        }
        const runsData = (await runsRes.json()) as {
          workflow_runs?: Array<{
            id: number;
            name?: string;
            status: string;
            conclusion: string | null;
            html_url: string;
            run_number: number;
          }>;
        };

        const run =
          runsData.workflow_runs?.find((r) => r.name === "Build Android APK") ||
          runsData.workflow_runs?.[0] ||
          null;

        if (!run) {
          return jsonResponse(request, { ok: true, status: "waiting", conclusion: null });
        }

        let apkDownloadUrl: string | null = null;
        let releaseUrl: string | null = null;
        if (run.status === "completed" && run.conclusion === "success") {
          const relRes = await fetch(
            `https://api.github.com/repos/${owner}/${repoName}/releases?per_page=3`,
            { headers: ghHeaders },
          );
          if (relRes.ok) {
            const releases = (await relRes.json()) as Array<{
              html_url: string;
              assets?: Array<{ name: string; browser_download_url: string }>;
            }>;
            for (const rel of releases) {
              const apkAsset = rel.assets?.find((a) => a.name.toLowerCase().endsWith(".apk"));
              if (apkAsset) {
                apkDownloadUrl = apkAsset.browser_download_url;
                releaseUrl = rel.html_url;
                break;
              }
            }
          }
        }

        return jsonResponse(request, {
          ok: true,
          status: run.status,
          conclusion: run.conclusion,
          runUrl: run.html_url,
          runNumber: run.run_number,
          apkDownloadUrl,
          releaseUrl,
        });
      }

      return jsonResponse(request, { ok: false, error: "Not found." }, 404);
    } catch (err) {
      safeLogError("api_unhandled", err, [env.GEMINI_API_KEY, env.CREATOR_HMAC_SECRET]);
      return jsonResponse(request, { ok: false, error: "Internal server error." }, 500);
    }
  }

  const isProd = process.env.NODE_ENV === "production";
  const distDir = path.join(__dirname, "dist");
  const publicDir = path.join(__dirname, "public");

  const httpServer = http.createServer();

  let viteMiddleware: ((req: NodeIncomingReq, res: NodeServerRes, next: () => void) => void) | null =
    null;

  if (!isProd || !fs.existsSync(path.join(distDir, "index.html"))) {
    const vite = await createViteServer({
      root: __dirname,
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
        allowedHosts: true,
      },
      appType: "spa",
    });
    viteMiddleware = vite.middlewares as unknown as (
      req: NodeIncomingReq,
      res: NodeServerRes,
      next: () => void,
    ) => void;
  }

  httpServer.on("request", async (req: NodeIncomingReq, res: NodeServerRes) => {
    const urlPath = (req.url || "/").split("?")[0];

    if (urlPath.startsWith("/api/")) {
      const env = resolveRuntimeEnv();
      const webReq = toWebRequest(req);
      const webRes = await handleApiRequest(webReq, env);
      await sendWebResponse(res, webRes);
      return;
    }

    if (viteMiddleware) {
      viteMiddleware(req, res, () => {
        if (!res.headersSent) {
          res.statusCode = 404;
          res.end("Not Found");
        }
      });
      return;
    }

    if (tryServeStaticFile(req, res, distDir)) return;
    if (tryServeStaticFile(req, res, publicDir)) return;

    const indexPath = path.join(distDir, "index.html");
    if (fs.existsSync(indexPath)) {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      fs.createReadStream(indexPath).pipe(res as unknown as NodeJS.WritableStream);
      return;
    }
    res.statusCode = 404;
    res.end("Not Found");
  });

  httpServer.on("upgrade", (req: NodeIncomingReq, socket: NodeUpgradeSocket, head: Uint8Array) => {
    const handled = mpHub.handleUpgrade(req, socket, head);
    if (!handled && !viteMiddleware) {
      socket.destroy();
    }
  });

  const listenPort = customPort ?? PORT;
  await new Promise<void>((resolve) => {
    httpServer.listen(listenPort, HOST, () => {
      console.log(`GeminIsland server listening on http://${HOST}:${listenPort}`);
      resolve();
    });
  });

  return {
    httpServer,
    worldStore,
    mpHub,
    close: () =>
      new Promise<void>((resolve) => {
        mpHub.dispose();
        httpServer.close(() => resolve());
      }),
  };
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url));

if (isMainModule) {
  void startServer();
}
