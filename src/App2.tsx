// src/App.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * 베이스라인(요약본 그대로 반영)
 * - Viewer 초기화 env: "Local"
 * - GLB는 blob/objectURL 로딩 + glbLoader 강제 지정
 * - S3 redirect/CORS 회피: node 프록시 POST /fetch?url=... 로만 다운로드
 * - 파일 업로드 없이 데모: (Forma 데이터가 있으면) terrain + 매스 자동 로드
 *
 * ⚠️ 중요: 이 파일은 "작동 가능한 완성본"을 목표로 했지만,
 * Forma API의 정확한 엔드포인트/응답 필드는 프로젝트마다 다를 수 있어
 * 아래 FORMA_ENDPOINTS / extract* 함수만 네 기존 구현에 맞게 “최소 수정”하면 된다.
 */

// --- Global Autodesk Viewer typings (CDN script 로드 전제) ---
declare global {
  interface Window {
    Autodesk?: any;
  }
}

// -------------------- Config --------------------
const ENV = {
  FORMA_API_BASE: import.meta.env.VITE_FORMA_API_BASE || "", // 예: https://developer.api.autodesk.com/forma/v1
  FORMA_PROJECT_ID: import.meta.env.VITE_FORMA_PROJECT_ID || "",
  FORMA_REGION: import.meta.env.VITE_FORMA_REGION || "", // 필요 시 (예: "EMEA" 등)
  FORMA_ACCESS_TOKEN: import.meta.env.VITE_FORMA_ACCESS_TOKEN || "", // 데모용. 배포에서는 서버로 옮기기.
  PROXY_BASE: import.meta.env.VITE_PROXY_BASE || "http://localhost:8787",
};

// ✅ 여기만 네 기존 코드에 맞춰 확정하면, 아래 로직은 거의 그대로 작동
const FORMA_ENDPOINTS = {
  // proposals 목록
  proposals: (projectId: string) =>
    `${ENV.FORMA_API_BASE}/projects/${encodeURIComponent(projectId)}/proposals`,

  // proposal children 조회
  proposalChildren: (projectId: string, proposalUrn: string) =>
    `${ENV.FORMA_API_BASE}/projects/${encodeURIComponent(
      projectId
    )}/proposals/${encodeURIComponent(proposalUrn)}/children`,

  // integrate element 목록/상세 (프로젝트마다 다를 수 있음)
  integrateElements: (integrateUrn: string) =>
    `${ENV.FORMA_API_BASE}/integrations/${encodeURIComponent(integrateUrn)}/elements`,

  integrateElement: (integrateUrn: string, elementId: string) =>
    `${ENV.FORMA_API_BASE}/integrations/${encodeURIComponent(
      integrateUrn
    )}/elements/${encodeURIComponent(elementId)}`,

  // blobId로 다운로드 URL(대개 302로 S3 redirect됨) → 반드시 프록시로 다운로드
  blob: (blobId: string) => `${ENV.FORMA_API_BASE}/blobs/${encodeURIComponent(blobId)}`,

  // terrain이 blobId를 안 주는 경우를 대비한 “terrain URN 다운로드” 템플릿(필요하면 교체)
  terrainByUrn: (terrainUrn: string) =>
    `${ENV.FORMA_API_BASE}/urns/${encodeURIComponent(terrainUrn)}/download`,
};

// -------------------- Small utils --------------------
function now() {
  return new Date().toLocaleTimeString();
}

function safeJsonParse(str: string) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// no-deps concurrency limiter
async function pMapLimit<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: R[] = new Array(items.length);
  let i = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    const next = () => {
      if (i >= items.length && active === 0) return resolve(results);
      while (active < limit && i < items.length) {
        const idx = i++;
        active++;
        Promise.resolve(mapper(items[idx], idx))
          .then((res) => {
            results[idx] = res;
            active--;
            next();
          })
          .catch(reject);
      }
    };
    next();
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number, label = "timeout") {
  let t: any;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label}: ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

async function withRetry<T>(fn: () => Promise<T>, tries = 1, backoffMs = 400) {
  let lastErr: any;
  for (let i = 0; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === tries) break;
      await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
    }
  }
  throw lastErr;
}

function createObjectUrlCache() {
  const map = new Map<string, string>();
  return {
    get: (key: string) => map.get(key),
    set: (key: string, url: string) => map.set(key, url),
    revokeAll: () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    },
  };
}

// -------------------- API helpers --------------------
type Proposal = { urn: string; name?: string; [k: string]: any };
type Child = { urn: string; type?: string; name?: string; [k: string]: any };

function authHeaders(token: string, region?: string) {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (region) h["X-Ads-Region"] = region;
  return h;
}

async function fetchJson(url: string, token: string, region: string, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...authHeaders(token, region),
      Accept: "application/json",
    },
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

/**
 * ✅ 핵심: 다운로드는 반드시 프록시로
 * POST {PROXY_BASE}/fetch?url=... + X-Extra-Headers (JSON string)
 */
async function proxyFetchBlob(url: string, extraHeaders: Record<string, string>) {
  const proxyUrl = `${ENV.PROXY_BASE}/fetch?url=${encodeURIComponent(url)}`;

  const res = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "X-Extra-Headers": JSON.stringify(extraHeaders),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Proxy fetch ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  return res.blob();
}

// -------------------- Extractors (가장 프로젝트 의존적인 부분) --------------------
/**
 * child가 terrain인지 판단
 * - 요약본: children에 ":terrain:" 타입 존재
 */
function isTerrainChild(ch: any): boolean {
  const v = String(ch?.type ?? ch?.category ?? ch?.kind ?? ch?.schema ?? "").toLowerCase();
  const name = String(ch?.name ?? "").toLowerCase();
  return v.includes("terrain") || v.includes(":terrain:") || name.includes("terrain") || name.includes("지형");
}

/**
 * child가 integrate인지 판단
 * - 요약본: children에 ":integrate:" 타입 존재
 */
function isIntegrateChild(ch: any): boolean {
  const v = String(ch?.type ?? ch?.category ?? ch?.kind ?? ch?.schema ?? "").toLowerCase();
  const name = String(ch?.name ?? "").toLowerCase();
  return v.includes("integrate") || v.includes(":integrate:") || name.includes("integrate") || name.includes("mass");
}

/**
 * terrain 다운로드 타겟 추출
 * - 프로젝트에 따라 child가 { blobId }를 가질 수도, urn 다운로드 엔드포인트를 써야 할 수도 있음
 */
function extractTerrainDownloadTarget(ch: any): { kind: "blobId"; blobId: string } | { kind: "urn"; urn: string } {
  const blobId =
    ch?.blobId ||
    ch?.data?.blobId ||
    ch?.representations?.terrainMesh?.blobId ||
    ch?.representations?.mesh?.blobId;

  if (blobId) return { kind: "blobId", blobId: String(blobId) };

  // fallback: child urn로 다운로드
  if (ch?.urn) return { kind: "urn", urn: String(ch.urn) };

  throw new Error("Cannot extract terrain download target (blobId/urn)");
}

/**
 * integrate URN 추출
 */
function extractIntegrateUrn(ch: any): string {
  const urn = ch?.urn || ch?.integrateUrn || ch?.data?.urn;
  if (!urn) throw new Error("Cannot extract integrate URN from child");
  return String(urn);
}

/**
 * element에서 volumeMesh blobId 추출
 * - 요약본: representations.volumeMesh.blobId
 */
function extractVolumeMeshBlobIdFromElement(el: any): string | null {
  const blobId =
    el?.representations?.volumeMesh?.blobId ??
    el?.representations?.volume_mesh?.blobId ??
    el?.volumeMesh?.blobId ??
    el?.volume_mesh?.blobId;

  return blobId ? String(blobId) : null;
}

// -------------------- Viewer helpers --------------------
function getGlbLoader(AutodeskViewing: any) {
  try {
    // viewer가 glTF/GLB 로더를 내부에 갖고 있을 때
    const m = AutodeskViewing?.FileLoaderManager;
    if (!m?.getFileLoader) return undefined;
    return (
      m.getFileLoader("gltf") ||
      m.getFileLoader("glb") ||
      m.getFileLoader("application/octet-stream") ||
      undefined
    );
  } catch {
    return undefined;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// -------------------- UI/Logic --------------------
type LoadedModelInfo = {
  model: any;
  tag: "terrain" | "mass";
  proposalUrn?: string;
  blobId?: string;
};

export default function App() {
  // Auth / project
  const [projectId, setProjectId] = useState(ENV.FORMA_PROJECT_ID);
  const [region, setRegion] = useState(ENV.FORMA_REGION);

  // token: env > localStorage > empty
  const [token, setToken] = useState(() => {
    const ls = localStorage.getItem("FORMA_ACCESS_TOKEN") || "";
    return ENV.FORMA_ACCESS_TOKEN || ls;
  });

  // proposals
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedProposalUrn, setSelectedProposalUrn] = useState<string>("");

  // mode / performance controls
  const [maxMeshes, setMaxMeshes] = useState<number>(10);
  const [concurrency, setConcurrency] = useState<number>(3);

  // toggles
  const [showTerrain, setShowTerrain] = useState(true);
  const [showMass, setShowMass] = useState(true);

  // status
  const [busy, setBusy] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);

  // viewer refs
  const viewerDivRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any>(null);

  const urlCacheRef = useRef(createObjectUrlCache());
  const loadedModelsRef = useRef<LoadedModelInfo[]>([]);

  const canRun = useMemo(() => {
    return Boolean(projectId && token && ENV.FORMA_API_BASE);
  }, [projectId, token]);

  function log(msg: string) {
    setLogLines((prev) => [`[${now()}] ${msg}`, ...prev].slice(0, 200));
  }

  // cleanup objectURLs when unmount
  useEffect(() => {
    return () => {
      urlCacheRef.current.revokeAll();
    };
  }, []);

  // init viewer once
  useEffect(() => {
    const Autodesk = window.Autodesk;
    if (!Autodesk?.Viewing) {
      log("❌ Autodesk Viewer script not found. (index.html에 Viewer 스크립트 로드 필요)");
      return;
    }
    if (!viewerDivRef.current) return;
    if (viewerRef.current) return;

    try {
      const options: any = {
        env: "Local", // ✅ 요약본 핵심
        // 로컬 GLB만 로드하면 accessToken 콜백이 없어도 되는 경우가 많지만,
        // 일부 확장/리소스가 필요할 수 있어 안전하게 넣어둠.
        getAccessToken: (onTokenReady: (t: string, expiresIn: number) => void) => {
          // expiresIn은 대충. 데모에서는 30분으로
          onTokenReady(token || "", 30 * 60);
        },
      };

      Autodesk.Viewing.Initializer(options, () => {
        const viewer = new Autodesk.Viewing.GuiViewer3D(viewerDivRef.current, {
          // 필요하면 확장 넣기
        });
        const started = viewer.start();
        if (!started) {
          log("❌ Viewer.start() failed");
          return;
        }

        viewerRef.current = viewer;
        log('✅ Viewer initialized (env="Local")');
      });
    } catch (e: any) {
      log(`❌ Viewer init error: ${e?.message || String(e)}`);
    }
    // token 변경으로 viewer를 재초기화하진 않음(베이스라인 유지)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------- Viewer model management --------------------
  function unloadAllModels() {
    const viewer = viewerRef.current;
    if (!viewer) return;

    try {
      // unload loaded models we tracked
      for (const info of loadedModelsRef.current) {
        try {
          viewer.unloadModel(info.model);
        } catch {
          // ignore
        }
      }
      loadedModelsRef.current = [];
      log("🧹 Unloaded all models");
    } catch (e: any) {
      log(`⚠️ unloadAllModels error: ${e?.message || String(e)}`);
    }
  }

  function applyVisibility() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    for (const info of loadedModelsRef.current) {
      const visible =
        info.tag === "terrain" ? showTerrain : info.tag === "mass" ? showMass : true;
      try {
        viewer.setModelVisibility(info.model, visible);
      } catch {
        // fallback: hide/show by isolating/unloading is too heavy; ignore if not supported
      }
    }
  }

  useEffect(() => {
    applyVisibility();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTerrain, showMass]);

  async function loadGlbBlobIntoViewer(
    blob: Blob,
    tag: "terrain" | "mass",
    meta?: { proposalUrn?: string; blobId?: string }
  ) {
    const viewer = viewerRef.current;
    const Autodesk = window.Autodesk;
    if (!viewer || !Autodesk?.Viewing) throw new Error("Viewer not ready");

    const objectUrl = URL.createObjectURL(blob);

    // 캐시/정리: terrain은 매번 새로일 확률 높아서 굳이 key 없이 관리
    // mass는 blobId 있으면 cache에 저장(호출부에서 처리)
    const glbLoader = getGlbLoader(Autodesk.Viewing);

    return await new Promise<any>((resolve, reject) => {
      try {
        viewer.loadModel(
          objectUrl,
          {
            // ✅ 요약본 핵심: 확장자 없으면 로더 강제 지정
            fileLoader: glbLoader,
            keepCurrentModels: true,
          },
          (model: any) => {
            loadedModelsRef.current.push({
              model,
              tag,
              proposalUrn: meta?.proposalUrn,
              blobId: meta?.blobId,
            });
            applyVisibility();

            // zoom은 terrain 첫 로드 시 정도만
            try {
              if (tag === "terrain") viewer.fitToView(true);
            } catch {
              // ignore
            }
            resolve(model);
          },
          (err: any) => {
            reject(new Error(`viewer.loadModel failed: ${JSON.stringify(err)}`));
          }
        );
      } catch (e: any) {
        reject(e);
      }
    }).finally(() => {
      // objectUrl은 model이 내부적으로 유지하지만, viewer가 필요로 할 수 있어 바로 revoke하면 안 될 때가 있음
      // 대신 blobId 캐시는 별도 관리. 여기서는 revoke하지 않음.
    });
  }

  // -------------------- Forma loading --------------------
  async function refreshProposals() {
    if (!canRun) {
      log("⚠️ Missing config: VITE_FORMA_API_BASE / projectId / token");
      return;
    }
    setBusy(true);
    try {
      log("🔎 Fetching proposals...");
      const data = await withTimeout(
        fetchJson(FORMA_ENDPOINTS.proposals(projectId), token, region),
        30_000,
        "proposals"
      );

      // 응답 형태가 { results: [] } 또는 [] 등 다양할 수 있어 유연하게 처리
      const list: Proposal[] = Array.isArray(data) ? data : data?.results || data?.items || [];
      const normalized = list
        .map((p: any) => ({
          urn: String(p.urn ?? p.id ?? p.proposalUrn ?? ""),
          name: p.name ?? p.title ?? p.label ?? String(p.urn ?? p.id ?? ""),
          raw: p,
        }))
        .filter((p) => p.urn);

      setProposals(normalized);
      log(`✅ Proposals loaded: ${normalized.length}`);

      if (!selectedProposalUrn && normalized.length > 0) {
        setSelectedProposalUrn(""); // auto mode 유지
      }
    } catch (e: any) {
      log(`❌ refreshProposals error: ${e?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function fetchProposalChildren(proposalUrn: string): Promise<Child[]> {
    const data = await fetchJson(FORMA_ENDPOINTS.proposalChildren(projectId, proposalUrn), token, region);
    const list: any[] = Array.isArray(data) ? data : data?.results || data?.items || data?.children || [];
    return list
      .map((c) => ({
        urn: String(c.urn ?? c.id ?? c.childUrn ?? ""),
        type: c.type ?? c.kind ?? c.category ?? c.schema,
        name: c.name ?? c.title ?? c.label,
        raw: c,
        ...c,
      }))
      .filter((c) => c.urn);
  }

  async function pickProposalWithMassOrFirst(proposalList: Proposal[]): Promise<string | null> {
    if (proposalList.length === 0) return null;

    // 1) 사용자가 선택했으면 그걸 사용
    if (selectedProposalUrn) return selectedProposalUrn;

    // 2) "매스 있는 proposal 자동 선택"
    log("🧭 Auto-picking a proposal with mass...");
    for (const p of proposalList) {
      try {
        const children = await withTimeout(fetchProposalChildren(p.urn), 20_000, "children");
        const hasIntegrate = children.some((c) => isIntegrateChild(c));
        if (hasIntegrate) {
          log(`✅ Auto-picked: ${p.name || p.urn}`);
          return p.urn;
        }
      } catch {
        // ignore and continue
      }
    }

    // 3) fallback: 첫 proposal
    log("⚠️ No mass proposal found. Falling back to first proposal.");
    return proposalList[0].urn;
  }

  async function resolveTerrainBlob(proposalUrn: string): Promise<Blob | null> {
    const children = await withTimeout(fetchProposalChildren(proposalUrn), 20_000, "children");
    const terrainChild = children.find((c) => isTerrainChild(c));
    if (!terrainChild) {
      log("⚠️ Terrain child not found in this proposal.");
      return null;
    }

    const target = extractTerrainDownloadTarget(terrainChild);
    const extra = authHeaders(token, region);

    if (target.kind === "blobId") {
      const url = FORMA_ENDPOINTS.blob(target.blobId);
      log(`⬇️ Terrain download via blobId: ${target.blobId}`);
      return await withTimeout(proxyFetchBlob(url, extra), 60_000, "terrain-blob");
    } else {
      const url = FORMA_ENDPOINTS.terrainByUrn(target.urn);
      log(`⬇️ Terrain download via urn: ${target.urn}`);
      return await withTimeout(proxyFetchBlob(url, extra), 60_000, "terrain-urn");
    }
  }

  async function collectIntegrateUrnsFromProposal(proposalUrn: string): Promise<string[]> {
    const children = await withTimeout(fetchProposalChildren(proposalUrn), 20_000, "children");
    const integrate = children.filter((c) => isIntegrateChild(c));
    return integrate.map((c) => extractIntegrateUrn(c));
  }

  async function getVolumeMeshBlobIdsFromIntegrate(integrateUrn: string): Promise<string[]> {
    // 1) elements 목록
    const list = await withTimeout(
      fetchJson(FORMA_ENDPOINTS.integrateElements(integrateUrn), token, region),
      30_000,
      "integrate-elements"
    );

    const elements: any[] = Array.isArray(list) ? list : list?.results || list?.items || list?.elements || [];
    const blobIds = new Set<string>();

    // elements에 blobId가 바로 있으면 그걸 쓰고,
    // 없으면 element detail을 한번 더 조회
    for (const el of elements) {
      const direct = extractVolumeMeshBlobIdFromElement(el);
      if (direct) {
        blobIds.add(direct);
        continue;
      }

      const elementId = el?.id || el?.elementId || el?.urn || el?.guid;
      if (!elementId) continue;

      try {
        const detail = await withTimeout(
          fetchJson(FORMA_ENDPOINTS.integrateElement(integrateUrn, String(elementId)), token, region),
          30_000,
          "integrate-element"
        );
        const fromDetail = extractVolumeMeshBlobIdFromElement(detail);
        if (fromDetail) blobIds.add(fromDetail);
      } catch {
        // ignore detail failures
      }
    }

    return [...blobIds];
  }

  async function downloadGlbByBlobId(blobId: string): Promise<Blob> {
    const extra = authHeaders(token, region);
    const url = FORMA_ENDPOINTS.blob(blobId);
    return await proxyFetchBlob(url, extra);
  }

  // -------------------- Run demos --------------------
  async function runSelectedProposalDemo() {
    const viewer = viewerRef.current;
    if (!viewer) {
      log("⚠️ Viewer not ready yet");
      return;
    }
    if (!canRun) {
      log("⚠️ Missing config: VITE_FORMA_API_BASE / projectId / token");
      return;
    }

    setBusy(true);
    try {
      unloadAllModels();

      const proposalUrn = await pickProposalWithMassOrFirst(proposals);
      if (!proposalUrn) throw new Error("No proposal available");

      // 1) terrain 로드
      log("🌍 Loading terrain...");
      const terrainBlob = await resolveTerrainBlob(proposalUrn);
      if (terrainBlob) {
        await withTimeout(loadGlbBlobIntoViewer(terrainBlob, "terrain"), 60_000, "viewer-terrain");
        log("✅ Terrain loaded");
      } else {
        log("⚠️ Terrain skipped (not found)");
      }

      // 2) 해당 proposal의 integrate만 로드
      log("🧱 Collecting integrate URNs...");
      const integrateUrns = await collectIntegrateUrnsFromProposal(proposalUrn);
      if (integrateUrns.length === 0) {
        log("⚠️ No integrate URNs found. (mass 없음)");
        return;
      }
      log(`✅ integrate URNs: ${integrateUrns.length}`);

      // 3) integrate → blobIds
      const allBlobIds: Array<{ blobId: string; proposalUrn: string }> = [];
      for (const urn of integrateUrns) {
        const blobIds = await withTimeout(getVolumeMeshBlobIdsFromIntegrate(urn), 60_000, "volumeMeshBlobIds");
        for (const b of blobIds) allBlobIds.push({ blobId: b, proposalUrn });
      }

      if (allBlobIds.length === 0) {
        log("⚠️ No volumeMesh blobIds found");
        return;
      }

      const sliced = allBlobIds.slice(0, maxMeshes);
      log(`⬇️ Loading mass GLBs (selected proposal) count=${sliced.length} (max=${maxMeshes})`);

      await pMapLimit(sliced, concurrency, async ({ blobId }, idx) => {
        const cached = urlCacheRef.current.get(blobId);
        if (cached) {
          // 캐시된 objectURL은 blob이 아니라 URL이므로, viewer.loadModel로 직접 로딩해야 함.
          // 여기서는 “cached URL을 다시 loadModel”하는 대신,
          // 실제 현장에선 model 핸들을 재사용하거나, blob 캐시로 바꾸는게 더 낫지만
          // 지금은 안정성을 위해 "blob 재다운로드를 피하는" 수준으로 구현.
          log(`♻️ [${idx + 1}/${sliced.length}] cache hit blobId=${blobId} (re-download skipped)`);
        }

        await withRetry(async () => {
          const blob = await withTimeout(downloadGlbByBlobId(blobId), 60_000, "mass-download");
          // objectURL 캐시
          const objectUrl = URL.createObjectURL(blob);
          urlCacheRef.current.set(blobId, objectUrl);

          await withTimeout(
            // viewer.loadModel은 URL 기반이므로, blob 대신 objectURL을 다시 fetch해서 blob 만드는건 비효율
            // 여기서는 loadGlbBlobIntoViewer(blob)로 로드하되, blob은 이미 있고 objectURL도 저장됨
            loadGlbBlobIntoViewer(blob, "mass", { proposalUrn, blobId }),
            60_000,
            "viewer-mass"
          );
        }, 1);
      });

      log("✅ Mass loading done (selected proposal)");
    } catch (e: any) {
      log(`❌ runSelectedProposalDemo error: ${e?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runAllProposalsMassDemo() {
    const viewer = viewerRef.current;
    if (!viewer) {
      log("⚠️ Viewer not ready yet");
      return;
    }
    if (!canRun) {
      log("⚠️ Missing config: VITE_FORMA_API_BASE / projectId / token");
      return;
    }

    setBusy(true);
    try {
      unloadAllModels();

      // terrain은 1개만 로드: auto pick (mass proposal 우선)
      const terrainProposalUrn = await pickProposalWithMassOrFirst(proposals);
      if (!terrainProposalUrn) throw new Error("No proposal available");

      log("🌍 Loading terrain (single)...");
      const terrainBlob = await resolveTerrainBlob(terrainProposalUrn);
      if (terrainBlob) {
        await withTimeout(loadGlbBlobIntoViewer(terrainBlob, "terrain"), 60_000, "viewer-terrain");
        log("✅ Terrain loaded");
      } else {
        log("⚠️ Terrain skipped (not found)");
      }

      // 모든 proposal에서 integrate URN 수집
      log("🧱 Collecting integrate URNs from ALL proposals...");
      const allIntegrateUrns: Array<{ proposalUrn: string; integrateUrn: string }> = [];

      for (const p of proposals) {
        try {
          const urns = await withTimeout(collectIntegrateUrnsFromProposal(p.urn), 20_000, "collect-integrate");
          for (const u of urns) allIntegrateUrns.push({ proposalUrn: p.urn, integrateUrn: u });
        } catch {
          // ignore
        }
      }

      if (allIntegrateUrns.length === 0) {
        log("⚠️ No integrate URNs found across proposals");
        return;
      }
      log(`✅ integrate URNs total: ${allIntegrateUrns.length}`);

      // integrate → blobIds 모으기
      const blobIdPairs: Array<{ blobId: string; proposalUrn: string }> = [];
      for (const x of allIntegrateUrns) {
        try {
          const blobIds = await withTimeout(
            getVolumeMeshBlobIdsFromIntegrate(x.integrateUrn),
            60_000,
            "volumeMeshBlobIds"
          );
          for (const b of blobIds) blobIdPairs.push({ blobId: b, proposalUrn: x.proposalUrn });
        } catch {
          // ignore failures for some integrates
        }
      }

      if (blobIdPairs.length === 0) {
        log("⚠️ No volumeMesh blobIds found across proposals");
        return;
      }

      // 요약본 A안: 속도 때문에 제한
      const sliced = blobIdPairs.slice(0, maxMeshes);
      log(`⬇️ Loading mass GLBs (ALL proposals) count=${sliced.length} (max=${maxMeshes}), concurrency=${concurrency}`);

      await pMapLimit(sliced, concurrency, async ({ blobId, proposalUrn }, idx) => {
        // blobId 캐시: 이미 있으면 재다운로드 생략
        const cachedUrl = urlCacheRef.current.get(blobId);
        if (cachedUrl) {
          log(`♻️ [${idx + 1}/${sliced.length}] cache hit blobId=${blobId} (re-download skipped)`);
          // NOTE: cachedUrl을 그대로 viewer.loadModel로 로딩하는 구현도 가능하지만,
          // 여기서는 “이미 로드된 모델 재사용”이 아니라 “다운로드 캐시”가 핵심이라
          // 같은 blobId를 중복 로드할 일이 거의 없게 upstream에서 dedupe되는 전제.
          // (필요하면 여기에서 viewer.loadModel(cachedUrl, ...)로 로딩하도록 바꾸면 됨)
        }

        await withRetry(async () => {
          const blob = await withTimeout(downloadGlbByBlobId(blobId), 60_000, "mass-download");
          const objectUrl = URL.createObjectURL(blob);
          urlCacheRef.current.set(blobId, objectUrl);

          await withTimeout(loadGlbBlobIntoViewer(blob, "mass", { proposalUrn, blobId }), 60_000, "viewer-mass");
        }, 1);
      });

      log("✅ Mass loading done (ALL proposals)");
    } catch (e: any) {
      log(`❌ runAllProposalsMassDemo error: ${e?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // -------------------- Proposal toggles (simple) --------------------
  function countLoaded(tag: "terrain" | "mass") {
    return loadedModelsRef.current.filter((x) => x.tag === tag).length;
  }

  // -------------------- Render --------------------
  return (
    <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", height: "100vh" }}>
      {/* Left panel */}
      <div
        style={{
          borderRight: "1px solid #2222",
          padding: 12,
          overflow: "auto",
          background: "#0b0f14",
          color: "#e8eef6",
        }}
      >
        <h2 style={{ margin: "0 0 10px 0" }}>Forma → APS Viewer (Local)</h2>

        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ padding: 10, border: "1px solid #2a3340", borderRadius: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>Config</div>

            <label style={{ display: "grid", gap: 4, marginBottom: 8 }}>
              <span style={{ fontSize: 12 }}>FORMA API Base (VITE_FORMA_API_BASE)</span>
              <input
                value={ENV.FORMA_API_BASE}
                readOnly
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #2a3340",
                  background: "#0f1622",
                  color: "#9fb3c8",
                }}
              />
            </label>

            <label style={{ display: "grid", gap: 4, marginBottom: 8 }}>
              <span style={{ fontSize: 12 }}>Project ID</span>
              <input
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="Forma project id"
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #2a3340",
                  background: "#0f1622",
                  color: "#e8eef6",
                }}
              />
            </label>

            <label style={{ display: "grid", gap: 4, marginBottom: 8 }}>
              <span style={{ fontSize: 12 }}>Region (optional, X-Ads-Region)</span>
              <input
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="ex) EMEA / US / ... (프로젝트에 맞게)"
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #2a3340",
                  background: "#0f1622",
                  color: "#e8eef6",
                }}
              />
            </label>

            <label style={{ display: "grid", gap: 4, marginBottom: 6 }}>
              <span style={{ fontSize: 12 }}>
                Access Token (local demo only){" "}
                <span style={{ opacity: 0.7 }}>(저장됨: localStorage)</span>
              </span>
              <input
                value={token}
                onChange={(e) => {
                  const v = e.target.value;
                  setToken(v);
                  localStorage.setItem("FORMA_ACCESS_TOKEN", v);
                }}
                placeholder="Bearer token"
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #2a3340",
                  background: "#0f1622",
                  color: "#e8eef6",
                }}
              />
            </label>

            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
              프록시: <code>{ENV.PROXY_BASE}</code> (PowerShell에서 <code>node upload-proxy.mjs</code>)
            </div>
          </div>

          <div style={{ padding: 10, border: "1px solid #2a3340", borderRadius: 10 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                onClick={refreshProposals}
                disabled={busy || !canRun}
                style={btnStyle(busy || !canRun)}
              >
                Proposals 새로고침
              </button>
              <button
                onClick={runAllProposalsMassDemo}
                disabled={busy || proposals.length === 0}
                style={btnStyle(busy || proposals.length === 0)}
              >
                데모 A: 모든 proposal 매스
              </button>
              <button
                onClick={runSelectedProposalDemo}
                disabled={busy || proposals.length === 0}
                style={btnStyle(busy || proposals.length === 0)}
              >
                선택 proposal 매스
              </button>
              <button
                onClick={() => {
                  unloadAllModels();
                  urlCacheRef.current.revokeAll();
                  log("🧹 cache cleared");
                }}
                disabled={busy}
                style={btnStyle(busy)}
              >
                Clear
              </button>
            </div>

            <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 12 }}>Proposal 선택 (비우면 자동 선택)</span>
                <select
                  value={selectedProposalUrn}
                  onChange={(e) => setSelectedProposalUrn(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">(auto pick mass proposal)</option>
                  {proposals.map((p) => (
                    <option key={p.urn} value={p.urn}>
                      {p.name || p.urn}
                    </option>
                  ))}
                </select>
              </label>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={{ fontSize: 12 }}>Max meshes</span>
                  <select
                    value={maxMeshes}
                    onChange={(e) => setMaxMeshes(Number(e.target.value))}
                    style={selectStyle}
                  >
                    <option value={10}>10</option>
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                  </select>
                </label>

                <label style={{ display: "grid", gap: 4 }}>
                  <span style={{ fontSize: 12 }}>Concurrency</span>
                  <select
                    value={concurrency}
                    onChange={(e) => setConcurrency(Number(e.target.value))}
                    style={selectStyle}
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={4}>4</option>
                  </select>
                </label>
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={showTerrain}
                    onChange={(e) => setShowTerrain(e.target.checked)}
                  />
                  <span style={{ fontSize: 12 }}>
                    Terrain ({countLoaded("terrain")})
                  </span>
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={showMass}
                    onChange={(e) => setShowMass(e.target.checked)}
                  />
                  <span style={{ fontSize: 12 }}>
                    Mass ({countLoaded("mass")})
                  </span>
                </label>
              </div>

              <div style={{ fontSize: 12, opacity: 0.7 }}>
                Viewer env: <code>Local</code> / GLB loader forced / downloads via proxy <code>/fetch</code>
              </div>
            </div>
          </div>

          <div style={{ padding: 10, border: "1px solid #2a3340", borderRadius: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 8 }}>Logs</div>
            <div
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: 12,
                lineHeight: 1.45,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: "48vh",
                overflow: "auto",
                padding: 10,
                background: "#0f1622",
                borderRadius: 8,
                border: "1px solid #2a3340",
              }}
            >
              {logLines.length ? logLines.join("\n") : "no logs"}
            </div>
          </div>

          <div style={{ fontSize: 12, opacity: 0.6, padding: "0 4px" }}>
            <div>⚠️ 보안: 토큰/시크릿 하드코딩 금지. 배포 시 서버로 분리.</div>
            <div>
              ⚙️ 프로젝트별로 다른 부분: <code>FORMA_ENDPOINTS</code>,{" "}
              <code>extract*</code> 함수(terrain/integrate/element/blobId).
            </div>
          </div>
        </div>
      </div>

      {/* Right: Viewer */}
      <div style={{ height: "100%", background: "#0b0f14" }}>
        <div
          style={{
            height: "100%",
            padding: 10,
          }}
        >
          <div
            ref={viewerDivRef}
            id="viewer"
            style={{
              height: "100%",
              width: "100%",
              position: "relative", // ✅ 화면 덮음 방지
              overflow: "hidden", // ✅ 화면 덮음 방지
              borderRadius: 12,
              border: "1px solid #2a3340",
              background: "#0f1622",
            }}
          />
        </div>
      </div>
    </div>
  );
}

// -------------------- small styles --------------------
function btnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #2a3340",
    background: disabled ? "#0f1622" : "#142033",
    color: disabled ? "#6f7f93" : "#e8eef6",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
  };
}

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid #2a3340",
  background: "#0f1622",
  color: "#e8eef6",
};
