import React, { useEffect, useMemo, useRef, useState } from "react";

// GLB(박스) 생성용
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

// APS Viewer는 index.html에서 script로 로드됨 (TypeScript 에러 방지)
declare const Autodesk: any;

// ===== Autodesk OAuth (PKCE) - Frontend Only =====
const APS_CLIENT_ID = "r0lx4IZVhHuDeXBpn5hC7WajpExJAbLce2eU3L5GdKHWuJRz";
const REDIRECT_URI = "http://localhost:5173/callback";
const APS_SCOPES = "data:read data:write viewables:read";

const AUTHORIZE_URL = "https://developer.api.autodesk.com/authentication/v2/authorize";
const TOKEN_URL = "https://developer.api.autodesk.com/authentication/v2/token";

function randomString(len = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const arr = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(arr, (n) => chars[n % chars.length]).join("");
}

function base64UrlEncode(arrayBuffer: ArrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(str: string) {
  const data = new TextEncoder().encode(str);
  return crypto.subtle.digest("SHA-256", data);
}

async function startAutodeskLogin() {
  const codeVerifier = randomString(64);
  const codeChallenge = base64UrlEncode(await sha256(codeVerifier));
  localStorage.setItem("pkce_code_verifier", codeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: APS_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: APS_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login",
  });

  window.location.href = `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForToken(code: string) {
  const codeVerifier = localStorage.getItem("pkce_code_verifier");
  if (!codeVerifier) throw new Error("PKCE code_verifier 없음");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: APS_CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`토큰 교환 실패: ${res.status} ${text}`);
  }

  return res.json() as Promise<{ access_token: string }>;
}
async function proxyDownloadBlob(
  downloadUrl: string,
  token: string,
  region?: string,
  proxyBase = "http://localhost:8787"
): Promise<Blob> {
  const proxyUrl = `${proxyBase}/fetch?url=${encodeURIComponent(downloadUrl)}`;

  const extraHeaders: Record<string, string> = {};
  if (token) extraHeaders["Authorization"] = `Bearer ${token}`;
  if (region) extraHeaders["X-Ads-Region"] = region;

  const res = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "X-Extra-Headers": JSON.stringify(extraHeaders),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`proxyDownloadBlob failed: ${res.status} ${res.statusText} ${text.slice(0, 300)}`);
  }
  return await res.blob();
}

function blobToObjectUrl(blob: Blob) {
  return URL.createObjectURL(blob);
}

function AuthCallback() {
  const [msg, setMsg] = useState("로그인 처리 중...");

  useEffect(() => {
    (async () => {
      try {
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        const err = url.searchParams.get("error");
        if (err) throw new Error(err);
        if (!code) throw new Error("code 파라미터 없음");

        const token = await exchangeCodeForToken(code);
        localStorage.setItem("aps_access_token", token.access_token);

        setMsg("로그인 성공! 메인으로 이동...");
        window.location.replace("http://localhost:5173/");
      } catch (e: any) {
        setMsg(`로그인 실패: ${e?.message ?? String(e)}`);
      }
    })();
  }, []);

  return <div style={{ padding: 24, fontFamily: "sans-serif" }}>{msg}</div>;
}
// ===== /Autodesk OAuth (PKCE) =====

type KeyUrn = { key: string; urn: string };

type ProposalSeed = {
  terrain: KeyUrn;
  base: KeyUrn;
  children: Array<KeyUrn>; // terrain/base 제외한 children
};

async function sceneToGlbBlobBox(params: { width: number; depth: number; height: number }) {
  const { width, depth, height } = params;

  const scene = new THREE.Scene();
  const geom = new THREE.BoxGeometry(width, height, depth);
  const mat = new THREE.MeshStandardMaterial({ color: 0xb0b0b0 });
  const mesh = new THREE.Mesh(geom, mat);

  // 바닥 기준으로 보이게(센터가 아니라 바닥에 닿도록)
  mesh.position.set(0, height / 2, 0);
  scene.add(mesh);

  const exporter = new GLTFExporter();

  const arrayBuffer: ArrayBuffer = await new Promise((resolve, reject) => {
    exporter.parse(
      scene,
      (gltf) => {
        if (gltf instanceof ArrayBuffer) resolve(gltf);
        else reject(new Error("GLB(binary)로 export 실패"));
      },
      (err) => reject(err),
      { binary: true }
    );
  });

  return new Blob([arrayBuffer], { type: "model/gltf-binary" });
}

function parseProposalIdFromUrn(proposalUrn: string) {
  // urn:adsk-forma-elements:proposal:pro_xxx:<proposalId>:<timestamp>
  const parts = proposalUrn.split(":");
  const idx = parts.indexOf("proposal");
  return idx >= 0 ? (parts[idx + 2] ?? "") : "";
}

function parseFormaUrn(urn: string) {
  // urn:adsk-forma-elements:<kind>:<authcontext>:<elementId>:<revision>
  const p = urn.split(":");
  return {
    kind: p[2] ?? "",
    authcontext: p[3] ?? "",
    elementId: p[4] ?? "",
    revision: p[5] ?? "",
  };
}

async function loadGlbIntoViewer(viewer: any, glbBlob: Blob, keepCurrentModels: boolean) {
  const url = URL.createObjectURL(glbBlob);

  const mgr =
    Autodesk?.Viewing?.FileLoaderManager ||
    Autodesk?.Viewing?.Private?.FileLoaderManager;

  const glbLoader = mgr?.getFileLoaderForExtension?.("glb");
  if (!glbLoader) throw new Error("glb 로더를 찾지 못했습니다(FileLoaderManager).");

  const model = await new Promise<any>((resolve, reject) => {
    viewer.loadModel(
      url,
      {
        keepCurrentModels,
        fileLoader: glbLoader, // blob: URL에는 확장자가 없어서 로더를 강제 지정
      },
      (m: any) => resolve(m),
      (err: any) => reject(err)
    );
  });

  // ✅ 지금은 revoke 하지 마세요(나중에 모델 unload할 때 정리)
  // URL.revokeObjectURL(url);

  return model;
}

function pickLinkedBlobIdFromRepresentations(element: any) {
  const reps = element?.representations ?? {};
  const keys = [
    "volumeMesh",
    "surfaceMesh",
    "mesh",
    "triangleMesh",
    "lineMesh",
    "polylineMesh",
    "roadMesh",
  ];

  for (const k of keys) {
    const r = reps?.[k];
    const blobId = r?.blobId;
    if (r && r.type === "linked" && typeof blobId === "string" && blobId.length > 0) {
      return { blobId, repKey: k };
    }
  }
  return null;
}

function isRenderableChildUrn(urn: string) {
  // 기존 :integrate: 외에 road 관련 타입도 포함 (프로젝트별로 다를 수 있어 넓게 잡음)
  const u = String(urn);
  return (
    u.includes(":integrate:") ||
    u.includes(":road:") ||
    u.includes(":roads:") ||
    u.includes(":path:") ||
    u.includes(":infra:")
  );
}

function fitToTerrainPrefer(viewer: any, _terrainModel: any) {
  try {
    viewer.fitToView?.();     // ✅ 로드된 모델 전체 기준으로 화면 맞춤
  } catch {}
  try {
    viewer.resize?.();
  } catch {}
}


export default function App() {
  if (window.location.pathname === "/callback") return <AuthCallback />;

  // ✅ EU 프로젝트 기준
  const FORMA_AUTHCONTEXT = "pro_wyet2m1tjw";
  const FORMA_REGION = "EMEA";

  const token = localStorage.getItem("aps_access_token");

  // ✅ terrain/base seed(하드코딩) — Proposal 조회하면 자동 갱신됨
  const HARDCODED_SEED: ProposalSeed = useMemo(
    () => ({
      terrain: {
        key: "b33bb3ea-04aa-41aa-830d-a81940b73989",
        urn: "urn:adsk-forma-elements:terrain:pro_wyet2m1tjw:a98cd28c-c9c6-4959-8ae4-2a4b31b92e36:1767865869866",
      },
      base: {
        key: "724184ae-1edb-4d66-a249-52cf82800551",
        urn: "urn:adsk-forma-elements:group:pro_wyet2m1tjw:base:1767865876345",
      },
      children: [],
    }),
    []
  );

  const [formaResult, setFormaResult] = useState("");
  const [createResult, setCreateResult] = useState("");
  const [massResult, setMassResult] = useState("");
  const [viewerResult, setViewerResult] = useState("");

  const [proposalSeed, setProposalSeed] = useState<ProposalSeed | null>(HARDCODED_SEED);

  const [activeProposalUrn, setActiveProposalUrn] = useState<string>(
    "urn:adsk-forma-elements:proposal:pro_wyet2m1tjw:5b1c1214-8139-44cf-ada2-62c94ad6caee:1767870450024"
  );
  const [activeProposalName, setActiveProposalName] = useState<string>("공정: 골조공사");
  const [taskName, setTaskName] = useState("골조공사");

  const [boxW, setBoxW] = useState(20);
  const [boxD, setBoxD] = useState(15);
  const [boxH, setBoxH] = useState(40);

  // ===== APS Viewer =====
  const viewerRef = useRef<any>(null);

  useEffect(() => {
    const el = document.getElementById("aps-viewer");
    if (!el) return;

    if (viewerRef.current) return;

    setViewerResult("APS Viewer 초기화 중...");

    Autodesk.Viewing.Initializer(
      { env: "Local" }, // ✅ 로컬(GLB/blob) 로딩 모드
      async () => {
        const viewer = new Autodesk.Viewing.GuiViewer3D(el);
        viewer.start();
        viewerRef.current = viewer;

        // glTF/GLB 확장 로드(안정적인 순서)
        try {
          await viewer.loadExtension("Autodesk.glTF");
        } catch {
          try {
            await viewer.loadExtension("Autodesk.glTFExtension");
          } catch {}
        }

        viewer.resize();
        setViewerResult("APS Viewer 준비 완료 ✅");
      }
    );

    return () => {
      try {
        viewerRef.current?.finish?.();
      } catch {}
      viewerRef.current = null;
    };
  }, []);
  // ===== /APS Viewer =====

  async function testListProposals() {
    const t = localStorage.getItem("aps_access_token");
    if (!t) return setFormaResult("❌ 토큰 없음. 로그인부터!");

    const url = `https://developer.api.autodesk.com/forma/proposal/v1alpha/proposals?authcontext=${FORMA_AUTHCONTEXT}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${t}`, "X-Ads-Region": FORMA_REGION },
    });

    const text = await res.text();
    setFormaResult(`status: ${res.status}\n${text}`);
    if (!res.ok) return;

    try {
      const json = JSON.parse(text);
      const first = json?.results?.[0];
      if (!first) return;

      // (주의) 데모 편의상: 첫 proposal을 active로 설정
      if (first?.urn) setActiveProposalUrn(String(first.urn));
      if (first?.properties?.name) setActiveProposalName(String(first.properties.name));

      // seed: terrain/base/children 찾기
      const children = first?.children ?? [];
      const terrain = children.find((c: any) => String(c.urn).includes(":terrain:"));
      const base = children.find(
        (c: any) => String(c.urn).includes(":group:") && String(c.urn).includes(":base:")
      );

      if (terrain && base) {
        setProposalSeed({
          terrain: { key: String(terrain.key), urn: String(terrain.urn) },
          base: { key: String(base.key), urn: String(base.urn) },
          children: children
            .filter((c: any) => c !== terrain && c !== base)
            .map((c: any) => ({ key: String(c.key), urn: String(c.urn) })),
        });
      }
    } catch {
      // ignore
    }
  }

  async function getLatestProposalRevision(proposalId: string, t: string) {
    const url = `https://developer.api.autodesk.com/forma/proposal/v1alpha/proposals/${proposalId}/revisions?authcontext=${FORMA_AUTHCONTEXT}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${t}`, "X-Ads-Region": FORMA_REGION },
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`revisions 조회 실패 ${res.status}: ${text}`);

    const json = JSON.parse(text);
    const first = json?.results?.[0];
    if (!first?.urn) throw new Error(`revisions 응답에서 urn을 못 찾음: ${text}`);

    // ✅ urn 끝 값을 revision으로 사용
    const last = String(first.urn).split(":").pop();
    if (!last) throw new Error(`urn에서 revision 추출 실패: ${first.urn}`);

    return last;
  }

  async function createProposal(name: string) {
    const t = localStorage.getItem("aps_access_token");
    if (!t) return setCreateResult("❌ 토큰 없음. 로그인부터!");
    if (!proposalSeed) return setCreateResult("❌ seed(terrain/base) 없음");

    const url = `https://developer.api.autodesk.com/forma/proposal/v1alpha/proposals?authcontext=${FORMA_AUTHCONTEXT}`;

    const body = {
      name,
      terrain: proposalSeed.terrain,
      base: proposalSeed.base,
      children: proposalSeed.children ?? [],
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        "X-Ads-Region": FORMA_REGION,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    setCreateResult(`status: ${res.status}\n${text}`);

    if (res.ok) {
      try {
        const j = JSON.parse(text);
        if (j?.urn) {
          setActiveProposalUrn(String(j.urn));
          setActiveProposalName(name);
        }
      } catch {}
      await testListProposals();
    }
  }

  // ===== A단계: 웹에서 GLB 만들고 Forma에 element 생성 + proposal에 붙이기 =====
  async function createMassAndAttach() {
    try {
      const t = localStorage.getItem("aps_access_token");
      if (!t) throw new Error("토큰 없음(로그인부터)");
      if (!proposalSeed) throw new Error("proposalSeed(terrain/base) 없음");
      if (!activeProposalUrn) throw new Error("activeProposalUrn 없음");

      // 1) GLB 만들기
      setMassResult("1/5 GLB(박스) 생성중...");
      const glb = await sceneToGlbBlobBox({ width: boxW, depth: boxD, height: boxH });

      // 2) upload-link 받기
      setMassResult("2/5 upload-link 요청중...");
      const uploadLinkUrl = `https://developer.api.autodesk.com/forma/integrate/v1alpha/upload-link?authcontext=${FORMA_AUTHCONTEXT}`;
      const linkRes = await fetch(uploadLinkUrl, {
        headers: { Authorization: `Bearer ${t}`, "X-Ads-Region": FORMA_REGION },
      });

      const linkText = await linkRes.text();
      if (!linkRes.ok) throw new Error(`upload-link 실패 ${linkRes.status}: ${linkText}`);

      const linkJson = JSON.parse(linkText);
      const blobId = linkJson.blobId;
      const putUrl = linkJson.url;
      const extraHeaders = linkJson.headers ?? {};

      if (!blobId || !putUrl) throw new Error(`upload-link 응답에 blobId/url 없음: ${linkText}`);

      // 3) S3 PUT 업로드 (프록시)
      setMassResult("3/5 S3 업로드(PUT) 중... (프록시)");
      const glbBuf = await glb.arrayBuffer();

      const proxyRes = await fetch(
        `http://localhost:8787/upload?url=${encodeURIComponent(putUrl)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Extra-Headers": JSON.stringify(extraHeaders ?? {}),
          },
          body: glbBuf,
        }
      );

      if (!proxyRes.ok) {
        const err = await proxyRes.text().catch(() => "");
        throw new Error(`프록시 업로드 실패 ${proxyRes.status}: ${err}`);
      }

      // 4) element 생성 (transform 금지)
      setMassResult("4/5 element 생성중...");
      const createElementUrl = `https://developer.api.autodesk.com/forma/integrate/v2alpha/elements?authcontext=${FORMA_AUTHCONTEXT}`;

      const elementBody = {
        properties: { name: `Auto Mass ${new Date().toLocaleTimeString()}` },
        representations: {
          volumeMesh: { type: "linked", blobId },
        },
      };

      const elRes = await fetch(createElementUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${t}`,
          "Content-Type": "application/json",
          "X-Ads-Region": FORMA_REGION,
        },
        body: JSON.stringify(elementBody),
      });

      const elText = await elRes.text();
      if (!elRes.ok) throw new Error(`element 생성 실패 ${elRes.status}: ${elText}`);

      const elJson = JSON.parse(elText);
      const elementUrn = elJson?.urn;
      if (!elementUrn) throw new Error(`element 응답에 urn 없음: ${elText}`);

      // 5) Proposal에 child로 붙이기
      setMassResult("5/5 Proposal에 child로 붙이는 중...");

      const proposalId = parseProposalIdFromUrn(activeProposalUrn);
      if (!proposalId) throw new Error(`proposalId 파싱 실패: ${activeProposalUrn}`);

      const revision = await getLatestProposalRevision(proposalId, t);

      const newChildKey = `mass-${Date.now()}`;
      const existingChildren = proposalSeed.children ?? [];
      const nextChildren = [...existingChildren, { key: newChildKey, urn: elementUrn }];

      const proposalPutUrl = `https://developer.api.autodesk.com/forma/proposal/v1alpha/proposals/${proposalId}/revisions/${revision}?authcontext=${FORMA_AUTHCONTEXT}`;

      const body = {
        name: activeProposalName,
        terrain: proposalSeed.terrain,
        base: proposalSeed.base,
        children: nextChildren,
      };

      const putRes = await fetch(proposalPutUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${t}`,
          "Content-Type": "application/json",
          "X-Ads-Region": FORMA_REGION,
        },
        body: JSON.stringify(body),
      });

      const putText = await putRes.text();
      if (!putRes.ok) throw new Error(`proposal PUT 실패 ${putRes.status}: ${putText}`);

      // seed 갱신(다음 로드에서 integrate를 찾게)
      setProposalSeed((prev) => (prev ? { ...prev, children: nextChildren } : prev));

      setMassResult(
        `✅ 완료!\n- elementUrn: ${elementUrn}\n- proposalId: ${proposalId}\n- revision: ${revision}\n\nForma에서 Proposal 새로고침하면 매스가 보입니다.`
      );
    } catch (e: any) {
      setMassResult(`❌ 실패: ${e?.message ?? String(e)}`);
    }
  }
  // ===== /A단계 =====

  // ===== B단계: (1) 특정 proposal(또는 매스 있는 proposal 자동선택) Terrain + Mass 로드 =====
  async function reloadFromForma_TerrainAndMass() {
    try {
      const t = localStorage.getItem("aps_access_token");
      if (!t) throw new Error("토큰 없음(로그인부터)");
      const viewer = viewerRef.current;
      if (!viewer) throw new Error("APS Viewer 아직 준비 안됨(잠깐 기다렸다 다시).");

      setViewerResult("Forma에서 Terrain+매스 불러오는 중...");

      const proposalsUrl = `https://developer.api.autodesk.com/forma/proposal/v1alpha/proposals?authcontext=${FORMA_AUTHCONTEXT}`;
      const proposalsRes = await fetch(proposalsUrl, {
        headers: { Authorization: `Bearer ${t}`, "X-Ads-Region": FORMA_REGION },
      });
      const proposalsText = await proposalsRes.text();
      if (!proposalsRes.ok) throw new Error(`Proposal 조회 실패 ${proposalsRes.status}: ${proposalsText}`);

      const proposalsJson = JSON.parse(proposalsText);
      const results = proposalsJson?.results ?? [];
      if (!results.length) throw new Error("Proposal이 0개입니다.");

      // 1순위: activeProposalUrn
      let proposal = results.find((p: any) => String(p.urn) === String(activeProposalUrn));

      // 2순위: 매스(integrate)가 있는 proposal 중 최근 생성
      if (!proposal) {
        const withMass = results
          .filter((p: any) => (p.children ?? []).some((c: any) => String(c.urn).includes(":integrate:")))
          .sort((a: any, b: any) => {
            const ta = Date.parse(a?.metadata?.createdAt ?? "1970-01-01");
            const tb = Date.parse(b?.metadata?.createdAt ?? "1970-01-01");
            return tb - ta;
          });
        proposal = withMass[0];
      }

      // 3순위: 그래도 없으면 첫 번째
      if (!proposal) proposal = results[0];
      if (!proposal) throw new Error("Proposal을 찾지 못했어요.");

      setActiveProposalUrn(String(proposal.urn));
      setActiveProposalName(String(proposal?.properties?.name ?? ""));

      // children에서 terrain + integrate만
      const children = proposal.children ?? [];
      const terrainChild = children.find((c: any) => String(c.urn).includes(":terrain:"));
      const massChildren = children.filter((c: any) => isRenderableChildUrn(String(c.urn)));
      if (!terrainChild) throw new Error("children에서 terrain을 찾지 못했어요.");

      // 기존 모델 제거
      try {
        const models = viewer.getAllModels?.() || (viewer.model ? [viewer.model] : []);
        models.forEach((m: any) => viewer.unloadModel?.(m));
      } catch {}

      // terrain 다운로드
      const terrainUrn = String(terrainChild.urn);
      const tp = parseFormaUrn(terrainUrn);

      const terrainDownloadUrl =
        `https://developer.api.autodesk.com/forma/terrain/v1alpha/terrains/${tp.elementId}` +
        `/revisions/${tp.revision}/download?authcontext=${FORMA_AUTHCONTEXT}`;

      const terrainBlob = await proxyDownloadBlob(terrainDownloadUrl, t, FORMA_REGION);

      const terrainModel = await loadGlbIntoViewer(viewer, terrainBlob, false);

      // mass 로드
      for (let i = 0; i < massChildren.length; i++) {
        const massUrn = String(massChildren[i].urn);

        const elementUrl =
          `https://developer.api.autodesk.com/forma/element-service/v1alpha/elements/` +
          `${encodeURIComponent(massUrn)}?authcontext=${FORMA_AUTHCONTEXT}`;

        const elementRes = await fetch(elementUrl, {
          headers: { Authorization: `Bearer ${t}`, "X-Ads-Region": FORMA_REGION },
        });

        const elementText = await elementRes.text();
        if (!elementRes.ok) throw new Error(`element 조회 실패 ${elementRes.status}: ${elementText}`);

        const elementJson = JSON.parse(elementText);
        const element =
          elementJson?.[massUrn] ||
          elementJson?.elements?.[massUrn] ||
          elementJson?.results?.[0] ||
          elementJson;

        const picked = pickLinkedBlobIdFromRepresentations(element);
        if (!picked) {
          throw new Error(`linked mesh blobId 못 찾음(volume/surface/mesh 등): ${massUrn}`);
        }
        const { blobId, repKey } = picked;
        const blobUrl =
          `https://developer.api.autodesk.com/forma/element-service/v1alpha/blobs/` +
          `${encodeURIComponent(blobId)}?authcontext=${FORMA_AUTHCONTEXT}`;

        const glbBlob = await proxyDownloadBlob(blobUrl, t, FORMA_REGION);

        await loadGlbIntoViewer(viewer, glbBlob, true);
      }

      fitToTerrainPrefer(viewer, terrainModel);
      viewer.resize?.();
setViewerResult(`✅ 로드 완료! (terrain 1개 + mass ${massChildren.length}개)`);
    } catch (e: any) {
      setViewerResult(`❌ 실패: ${e?.message ?? String(e)}`);
    }
  }

  // ===== B단계: (2) 모든 proposal에서 매스(integrate) 전부 수집해서 로드(terrain 1개만) =====
  async function reloadFromForma_AllProposals_MassesOnly() {
    try {
      const t = localStorage.getItem("aps_access_token");
      if (!t) throw new Error("토큰 없음(로그인부터)");
      const viewer = viewerRef.current;
      if (!viewer) throw new Error("APS Viewer 아직 준비 안됨");

      setViewerResult("모든 Proposal에서 매스 수집/로딩 중...");

      const proposalsUrl = `https://developer.api.autodesk.com/forma/proposal/v1alpha/proposals?authcontext=${FORMA_AUTHCONTEXT}`;
      const proposalsRes = await fetch(proposalsUrl, {
        headers: { Authorization: `Bearer ${t}`, "X-Ads-Region": FORMA_REGION },
      });
      const proposalsText = await proposalsRes.text();
      if (!proposalsRes.ok) throw new Error(`Proposal 조회 실패 ${proposalsRes.status}: ${proposalsText}`);

      const proposalsJson = JSON.parse(proposalsText);
      const results = proposalsJson?.results ?? [];
      if (!results.length) throw new Error("Proposal이 0개입니다.");

      // 기존 모델 제거
      try {
        const models = viewer.getAllModels?.() || (viewer.model ? [viewer.model] : []);
        models.forEach((m: any) => viewer.unloadModel?.(m));
      } catch {}

      // terrain 1개만 로드(첫 terrain 발견 proposal)
      const firstWithTerrain = results.find((p: any) =>
        (p.children ?? []).some((c: any) => String(c.urn).includes(":terrain:"))
      );
      if (!firstWithTerrain) throw new Error("terrain을 가진 proposal을 찾지 못했어요.");

      const terrainChild = (firstWithTerrain.children ?? []).find((c: any) =>
        String(c.urn).includes(":terrain:")
      );
      if (!terrainChild) throw new Error("terrain child 없음");

      const tp = parseFormaUrn(String(terrainChild.urn));
      const terrainDownloadUrl =
        `https://developer.api.autodesk.com/forma/terrain/v1alpha/terrains/${tp.elementId}` +
        `/revisions/${tp.revision}/download?authcontext=${FORMA_AUTHCONTEXT}`;

      const terrainBlob = await proxyDownloadBlob(terrainDownloadUrl, t, FORMA_REGION);

      const terrainModel = await loadGlbIntoViewer(viewer, terrainBlob, false);

      // 모든 proposal에서 integrate URN 수집(중복 제거)
      const massUrnSet = new Set<string>();
      for (const p of results) {
        for (const c of p.children ?? []) {
          const u = String(c.urn);
          if (isRenderableChildUrn(u)) massUrnSet.add(u);
        }
      }

      const massUrns = Array.from(massUrnSet);
      setViewerResult(`terrain 1개 로드 완료. 매스 ${massUrns.length}개 로딩 시작...`);

      for (let i = 0; i < massUrns.length; i++) {
        const massUrn = massUrns[i];

        const elementUrl =
          `https://developer.api.autodesk.com/forma/element-service/v1alpha/elements/` +
          `${encodeURIComponent(massUrn)}?authcontext=${FORMA_AUTHCONTEXT}`;

        const elementRes = await fetch(elementUrl, {
          headers: { Authorization: `Bearer ${t}`, "X-Ads-Region": FORMA_REGION },
        });
        const elementText = await elementRes.text();
        if (!elementRes.ok) throw new Error(`element 조회 실패 ${elementRes.status}: ${elementText}`);

        const elementJson = JSON.parse(elementText);
        const element =
          elementJson?.[massUrn] ||
          elementJson?.elements?.[massUrn] ||
          elementJson?.results?.[0] ||
          elementJson;

        const picked = pickLinkedBlobIdFromRepresentations(element);
        if (!picked) {
          throw new Error(`linked mesh blobId 못 찾음(volume/surface/mesh 등): ${massUrn}`);
        }
        const { blobId, repKey } = picked;
        const blobUrl =
          `https://developer.api.autodesk.com/forma/element-service/v1alpha/blobs/` +
          `${encodeURIComponent(blobId)}?authcontext=${FORMA_AUTHCONTEXT}`;

        const glbBlob = await proxyDownloadBlob(blobUrl, t, FORMA_REGION);

        await loadGlbIntoViewer(viewer, glbBlob, true);

        if (i % 3 === 0) setViewerResult(`매스 로딩 ${i + 1}/${massUrns.length}...`);
      }

      fitToTerrainPrefer(viewer, terrainModel);
      viewer.resize?.();
setViewerResult(`✅ 완료! terrain 1개 + 매스 ${massUrns.length}개`);
    } catch (e: any) {
      setViewerResult(`❌ 실패: ${e?.message ?? String(e)}`);
    }
  }

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      {/* 로그인 UI */}
      <div style={{ position: "fixed", top: 12, right: 12, display: "flex", gap: 8, zIndex: 10 }}>
        {!token ? (
          <button onClick={startAutodeskLogin} style={{ padding: "8px 12px", cursor: "pointer" }}>
            Autodesk 로그인
          </button>
        ) : (
          <button
            onClick={() => {
              localStorage.removeItem("aps_access_token");
              window.location.reload();
            }}
            style={{ padding: "8px 12px", cursor: "pointer" }}
          >
            로그아웃
          </button>
        )}
      </div>

      <h2>Forma API + APS Viewer 데모</h2>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={testListProposals} style={{ padding: "8px 12px", cursor: "pointer" }}>
          Proposal 목록 테스트(조회)
        </button>

        <input
          value={taskName}
          onChange={(e) => setTaskName(e.target.value)}
          style={{ padding: 8, minWidth: 260 }}
        />

        <button
          onClick={() => createProposal(`공정: ${taskName}`)}
          style={{ padding: "8px 12px", cursor: "pointer" }}
        >
          선택 공정으로 Proposal 생성
        </button>

        <button onClick={reloadFromForma_TerrainAndMass} style={{ padding: "8px 12px", cursor: "pointer" }}>
          현재(또는 매스 있는) Proposal 불러오기
        </button>

        <button onClick={reloadFromForma_AllProposals_MassesOnly} style={{ padding: "8px 12px", cursor: "pointer" }}>
          모든 Proposal 매스 전부 불러오기
        </button>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
        activeProposalUrn: {activeProposalUrn || "(없음)"} <br />
        activeProposalName: {activeProposalName || "(없음)"} <br />
        seed: {proposalSeed ? "OK" : "없음"} <br />
        viewer: {viewerResult || "(대기중)"}
      </div>

      {/* APS Viewer */}
      <div
        id="aps-viewer"
        style={{
          width: "100%",
          height: 360,
          position: "relative",
          overflow: "hidden",
          border: "1px solid #ddd",
          borderRadius: 8,
          marginTop: 16,
          zIndex: 0,
        }}
      />

      <hr style={{ margin: "16px 0" }} />

      <h3>자동 매스(박스) 생성 → 업로드/element 생성 → Proposal에 붙이기</h3>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12 }}>
          W
          <input
            type="number"
            value={boxW}
            onChange={(e) => setBoxW(Number(e.target.value))}
            style={{ marginLeft: 6, width: 90, padding: 6 }}
          />
        </label>

        <label style={{ fontSize: 12 }}>
          D
          <input
            type="number"
            value={boxD}
            onChange={(e) => setBoxD(Number(e.target.value))}
            style={{ marginLeft: 6, width: 90, padding: 6 }}
          />
        </label>

        <label style={{ fontSize: 12 }}>
          H
          <input
            type="number"
            value={boxH}
            onChange={(e) => setBoxH(Number(e.target.value))}
            style={{ marginLeft: 6, width: 90, padding: 6 }}
          />
        </label>

        <button onClick={createMassAndAttach} style={{ padding: "8px 12px", cursor: "pointer" }}>
          매스 생성 + Proposal 반영
        </button>
      </div>

      <hr style={{ margin: "16px 0" }} />

      <h4>Proposal 조회 결과</h4>
      <pre style={{ whiteSpace: "pre-wrap", background: "#111", color: "#0f0", padding: 12, borderRadius: 8 }}>
        {formaResult || "(아직 없음)"}
      </pre>

      <h4>Proposal 생성 결과</h4>
      <pre style={{ whiteSpace: "pre-wrap", background: "#111", color: "#0f0", padding: 12, borderRadius: 8 }}>
        {createResult || "(아직 없음)"}
      </pre>

      <h4>매스 생성/반영 결과</h4>
      <pre style={{ whiteSpace: "pre-wrap", background: "#111", color: "#0f0", padding: 12, borderRadius: 8 }}>
        {massResult || "(아직 없음)"}
      </pre>
    </div>
  );
}
