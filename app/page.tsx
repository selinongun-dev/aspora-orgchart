"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type RawRow = Record<string, string>;

type PersonNode = {
  id: string;
  parentId: string | null;
  isPod?: false;
  name: string;
  email: string;
  team: string;
  location: string;
  photoUrl: string;
  pod: string; // "" olabilir
};

type PodNode = {
  id: string; // "pod:Engineering"
  parentId: string; // root id
  isPod: true;
  name: string; // Pod adı
};

type ChartNode = PersonNode | PodNode;

function normalizeEmail(v: string) {
  return (v || "").trim().toLowerCase();
}

function ensureHttps(url: string) {
  const u = (url || "").trim();
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  return `https://${u}`;
}

// CSV header alias (senin dosyada bazen değişiyor)
function pick(row: RawRow, keys: string[]) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined) return v;
  }
  return "";
}

function requiredColsMissing(headers: string[]) {
  // Pod opsiyonel
  const required = ["Name", "Work Email", "Manager Email", "Team", "Location", "Photo URL"];
  const set = new Set(headers);
  return required.filter((c) => !set.has(c));
}

type ViewMode = "hierarchy" | "pod";

export default function ClientPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("hierarchy");

  const [rows, setRows] = useState<RawRow[]>([]);
  const [error, setError] = useState<string>("");

  // edit=1 sadece sende
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  // shared CSV load
  useEffect(() => {
    fetch("/api/org")
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.text();
      })
      .then((text) => {
        Papa.parse<RawRow>(text, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => setRows((res.data || []) as RawRow[]),
          error: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
        });
      })
      .catch(() => {
        // ilk kurulumda normal: csv yoksa sessiz geç
      });
  }, []);

  // people nodes (her zaman temel kaynak)
  const people: PersonNode[] = useMemo(() => {
    return rows
      .filter((r) => Object.keys(r || {}).length > 0)
      .map((r, i) => {
        const name = String(pick(r, ["Name"])).trim();
        const email = String(pick(r, ["Work Email", "Email", "Work email"])).trim();
        const managerEmail = String(pick(r, ["Manager Email", "Manager email"])).trim();

        const team = String(pick(r, ["Team"])).trim();
        const location = String(pick(r, ["Location", "Country"])).trim();

        // Pod OPSİYONEL: sadece Pod kolonundan
        const pod = String(pick(r, ["Pod"])).trim();

        const photo = String(pick(r, ["Photo URL", "Photo Url", "Photo"])).trim();

        const id = email ? normalizeEmail(email) : `name:${name.toLowerCase()}:${i}`;

        return {
          id,
          parentId: normalizeEmail(managerEmail) || null,
          isPod: false,
          name: name || email || "(no name)",
          email,
          team,
          location,
          pod,
          photoUrl:
            ensureHttps(photo) ||
            `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
              name || "User"
            )}`,
        };
      });
  }, [rows]);

  // manager olmayanları root say (dataset dışı manager varsa da root olsun)
  const normalizedPeople: PersonNode[] = useMemo(() => {
    const ids = new Set(people.map((p) => p.id));
    return people.map((p) => ({
      ...p,
      parentId: p.parentId && ids.has(p.parentId) ? p.parentId : null,
    }));
  }, [people]);

  // pod -> person id list (pod view expand için)
  const idsByPod = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of normalizedPeople) {
      if (!p.pod) continue;
      if (!map.has(p.pod)) map.set(p.pod, []);
      map.get(p.pod)!.push(p.id);
    }
    return map;
  }, [normalizedPeople]);

  // root belirle (1'den fazla root varsa super-root oluştur)
  const { rootId, hierarchyNodes } = useMemo(() => {
    const roots = normalizedPeople.filter((p) => p.parentId === null);
    if (roots.length <= 1) {
      return { rootId: roots[0]?.id || null, hierarchyNodes: normalizedPeople as ChartNode[] };
    }

    const superRootId = "__root__";
    const superRoot: PersonNode = {
      id: superRootId,
      parentId: null,
      isPod: false,
      name: "Aspora",
      email: "",
      team: "",
      location: "",
      pod: "",
      photoUrl: `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
        "Aspora"
      )}`,
    };

    const patched = normalizedPeople.map((p) =>
      p.parentId === null ? { ...p, parentId: superRootId } : p
    );

    return { rootId: superRootId, hierarchyNodes: [superRoot, ...patched] as ChartNode[] };
  }, [normalizedPeople]);

  // POD VIEW node set üretimi
  const podNodes: ChartNode[] = useMemo(() => {
    if (viewMode !== "pod") return hierarchyNodes;

    if (!rootId) return hierarchyNodes;

    // pod node’larını üret (pod boşsa üretme!)
    const pods = Array.from(idsByPod.keys()).sort((a, b) => a.localeCompare(b));
    const podGroupNodes: PodNode[] = pods.map((pod) => ({
      id: `pod:${pod}`,
      parentId: rootId,
      isPod: true,
      name: pod,
    }));

    // hızlı lookup
    const byId = new Map<string, PersonNode>();
    for (const n of hierarchyNodes) {
      if ((n as any).isPod) continue;
      byId.set((n as PersonNode).id, n as PersonNode);
    }

    // Pod view parent rule:
    // - podu olan kişi:
    //    - manager yoksa -> pod node altına
    //    - manager farklı pod / yok -> pod node altına
    //    - manager aynı pod -> manager’a bağlı kalsın
    // - podu olmayan: normal hiyerarşi kalsın (No Pod yok!)
    const patchedPeople: PersonNode[] = (hierarchyNodes as PersonNode[])
      .filter((n) => !(n as any).isPod)
      .map((p) => {
        if (!p.pod) return p;

        const mgr = p.parentId ? byId.get(p.parentId) : null;
        const mgrPod = mgr?.pod || "";

        if (!mgr || mgrPod !== p.pod) {
          return { ...p, parentId: `pod:${p.pod}` };
        }
        return p;
      });

    return [...podGroupNodes, ...patchedPeople] as ChartNode[];
  }, [viewMode, hierarchyNodes, idsByPod, rootId]);

  // ✅ FIX #2: Toplam alt kırılım sayısı (descendants) hesapla
  // - Person node için: altındaki toplam person sayısı (self hariç)
  // - Pod node için: altındaki toplam person sayısı
  const subtreeCounts = useMemo(() => {
    const nodeById = new Map<string, ChartNode>();
    const childrenByParent = new Map<string, string[]>();

    for (const n of podNodes) {
      nodeById.set(n.id, n);
      if (n.parentId) {
        if (!childrenByParent.has(n.parentId)) childrenByParent.set(n.parentId, []);
        childrenByParent.get(n.parentId)!.push(n.id);
      }
    }

    const memoTotalPeopleInSubtree = new Map<string, number>();

    const dfsTotalPeople = (id: string): number => {
      if (memoTotalPeopleInSubtree.has(id)) return memoTotalPeopleInSubtree.get(id)!;

      const node = nodeById.get(id);
      const isPod = !!(node as any)?.isPod;

      // self person ise 1, pod ise 0
      let total = isPod ? 0 : 1;

      const kids = childrenByParent.get(id) || [];
      for (const cid of kids) total += dfsTotalPeople(cid);

      memoTotalPeopleInSubtree.set(id, total);
      return total;
    };

    const out: Record<string, number> = {};
    for (const n of podNodes) {
      const total = dfsTotalPeople(n.id);
      const isPod = !!(n as any)?.isPod;
      // person için self hariç descendants; pod için total
      out[n.id] = isPod ? total : Math.max(0, total - 1);
    }
    return out;
  }, [podNodes]);

  // Upload
  async function uploadCsvToServer(file: File) {
    setError("");
    const pw = prompt("Admin password?");
    if (!pw) return;

    const fd = new FormData();
    fd.append("file", file);

    const res = await fetch("/api/org", {
      method: "POST",
      headers: { "x-admin-password": pw },
      body: fd,
    });

    if (!res.ok) {
      setError(`Upload failed: ${await res.text()}`);
      return;
    }

    const csv = await (await fetch("/api/org")).text();
    Papa.parse<RawRow>(csv, {
      header: true,
      skipEmptyLines: true,
      complete: (r) => setRows((r.data || []) as RawRow[]),
      error: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    });
  }

  // Render chart
  useEffect(() => {
    if (!chartRef.current) return;

    if (!podNodes.length) {
      chartRef.current.innerHTML = "";
      return;
    }

    chartRef.current.innerHTML = "";

    let cancelled = false;

    (async () => {
      const mod = await import("d3-org-chart");
      const OrgChart = (mod as any).OrgChart;

      if (cancelled || !chartRef.current) return;

      const LILAC = "#6D28D9";
      const LILAC_BG = "#F5F3FF";

      // Node ölçüleri (nodeContent içindeki width/height ile uyumlu)
      const PERSON_W = 320;
      const PERSON_H = 120;
      const POD_W = 340;
      const POD_H = 90;

      const BUTTON_W = 34;
      const BUTTON_H = 34;
      const BUTTON_GAP = 10;

      const dims = (d: any) =>
        d?.data?.isPod ? { w: POD_W, h: POD_H } : { w: PERSON_W, h: PERSON_H };

      const chartAny: any = new OrgChart()
        .container(chartRef.current)
        .data(podNodes)
        .nodeWidth((d: any) => (d?.data?.isPod ? POD_W : PERSON_W))
        // Buton + boşluk için ekstra yükseklik ekle (button içerik üstüne binmesin)
        .nodeHeight((d: any) => dims(d).h + BUTTON_H + BUTTON_GAP + 10)
        .childrenMargin(() => 50)
        .compactMarginBetween(() => 35)
        .compactMarginPair(() => 80);

      // --- Button (count + position) ---
      if (typeof chartAny.buttonContent === "function") {
        chartAny.buttonContent((d: any) => {
          const data = d?.data || d;
          const id = data?.id as string;
          const count = subtreeCounts[id] ?? 0;

          // leaf node: hiç buton gösterme
          if (!count) return "";

          const expanded = !!(data?._expanded ?? d?._expanded);
          const caret = expanded ? "▴" : "▾";

          return `
            <div style="
              display:inline-flex;align-items:center;gap:6px;
              padding:4px 10px;border-radius:999px;
              border:1px solid rgba(0,0,0,0.18);
              background:#fff;
              font-weight:900;font-size:12px;color:#111827;
              box-shadow:0 2px 8px rgba(0,0,0,0.10);
              line-height:1;
            ">
              <span style="font-size:12px">${caret}</span>
              <span>${count}</span>
            </div>
          `;
        });
      }

      if (typeof chartAny.buttonWidth === "function") chartAny.buttonWidth(() => BUTTON_W);
      if (typeof chartAny.buttonHeight === "function") chartAny.buttonHeight(() => BUTTON_H);

      // Ortala + node altına koy
      if (typeof chartAny.buttonX === "function")
        chartAny.buttonX((d: any) => dims(d).w / 2);
      if (typeof chartAny.buttonY === "function")
        chartAny.buttonY((d: any) => dims(d).h + BUTTON_GAP);
      // --- END Button ---

      chartAny
        .onNodeClick((d: any) => {
          const data = d?.data as ChartNode;

          // Pod node’a tıklayınca: o pod’un altındaki HER ŞEY tek seferde açılsın/kapanılsın
          if (data?.isPod) {
            const podName = (data as PodNode).name;
            const ids = idsByPod.get(podName) || [];
            const isExpanded = !!d?.data?._expanded;

            const c = chartAny;

            const safeSet = (id: string, val: boolean) => {
              if (typeof c.setExpanded === "function") c.setExpanded(id, val);
            };

            // toggle pod
            safeSet(data.id, !isExpanded);

            if (!isExpanded) {
              for (const id of ids) safeSet(id, true);
            } else {
              for (const id of ids) safeSet(id, false);
            }

            c.render?.();
            c.fit?.();
          }
        })
        .nodeContent((d: any) => {
          const p = d.data as ChartNode;

          // POD NODE
          if ((p as any).isPod) {
            return `
              <div style="
                width:${POD_W}px;height:${POD_H}px;background:${LILAC_BG};
                border:1px solid rgba(0,0,0,0.10);
                border-radius:18px;box-shadow:0 6px 18px rgba(0,0,0,0.06);
                display:flex;align-items:center;justify-content:center;
                position:relative; overflow:hidden;
              ">
                <div style="position:absolute;left:0;top:0;bottom:0;width:6px;background:${LILAC};"></div>
                <div style="
                  font-weight:900;font-size:18px;color:#111827;
                  padding:0 16px; text-align:center;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:${POD_W - 20}px;
                ">
                  ${(p as PodNode).name}
                </div>
              </div>
            `;
          }

          const person = p as PersonNode;

          const img = person.photoUrl
            ? `<img src="${person.photoUrl}" crossorigin="anonymous"
                style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid rgba(0,0,0,0.12)" />`
            : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                display:flex;align-items:center;justify-content:center;font-weight:700;">
                ${String(person.name).trim().slice(0, 1).toUpperCase()}
              </div>`;

          return `
            <div style="
              width:${PERSON_W}px;height:${PERSON_H}px;background:#fff;border:1px solid rgba(0,0,0,0.12);
              border-radius:16px;box-shadow:0 2px 10px rgba(0,0,0,0.06);
              padding:12px;display:flex;gap:12px;align-items:center;
              position:relative; overflow:hidden;
            ">
              <div style="position:absolute;left:0;top:0;bottom:0;width:6px;background:${LILAC};"></div>

              <div style="margin-left:6px;display:flex;gap:12px;align-items:center;min-width:0;">
                ${img}
                <div style="display:flex;flex-direction:column;gap:6px;min-width:0;">
                  <div style="font-weight:900;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px;">
                    ${person.name}
                  </div>
                  <div style="font-size:12px;font-weight:800;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px;">
                    ${person.team || ""}
                  </div>
                  <div style="font-size:12px;font-weight:700;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px;">
                    ${person.location || ""}
                  </div>
                  <div style="font-size:11px;font-weight:700;color:#6B7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px;">
                    ${person.email || ""}
                  </div>
                </div>
              </div>
            </div>
          `;
        });

      chartAny.render();
      chartObjRef.current = chartAny;

      // Pod view’de ilk açılışta pod’lar kapalı kalsın ama root görünür olsun
      if (viewMode === "pod" && chartAny.collapseAll) {
        chartAny.collapseAll();
        chartAny.setExpanded?.(rootId, true);
        chartAny.render?.();
        chartAny.fit?.();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [podNodes, viewMode, idsByPod, rootId, subtreeCounts]);

  function onLocalFileCheck(headers: string[]) {
    const missing = requiredColsMissing(headers);
    if (missing.length) {
      setError(`Missing required columns: ${missing.join(", ")}`);
      return false;
    }
    return true;
  }

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 16px 0" }}>
        Aspora Organisational Chart
      </h1>

      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        {isEdit && (
          <input
            type="file"
            accept=".csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (!file.name.toLowerCase().endsWith(".csv")) {
                setError("Please upload a .csv file.");
                return;
              }

              // hızlı header doğrulama
              const text = await file.text();
              Papa.parse<RawRow>(text, {
                header: true,
                preview: 1,
                complete: (res) => {
                  const headers = (res.meta.fields || []) as string[];
                  if (!onLocalFileCheck(headers)) return;
                  uploadCsvToServer(file);
                },
                error: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
              });
            }}
          />
        )}

        <button
          onClick={() => setViewMode("hierarchy")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: viewMode === "hierarchy" ? "2px solid #6D28D9" : "1px solid rgba(0,0,0,0.12)",
            background: viewMode === "hierarchy" ? "#F5F3FF" : "white",
            fontWeight: 800,
          }}
        >
          Hierarchy View
        </button>

        <button
          onClick={() => setViewMode("pod")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: viewMode === "pod" ? "2px solid #6D28D9" : "1px solid rgba(0,0,0,0.12)",
            background: viewMode === "pod" ? "#F5F3FF" : "white",
            fontWeight: 800,
          }}
        >
          Pod View
        </button>

        <div style={{ width: 12 }} />

        <button onClick={() => chartObjRef.current?.fit()} style={{ padding: "8px 12px" }}>
          Fit
        </button>
        <button onClick={() => chartObjRef.current?.expandAll()} style={{ padding: "8px 12px" }}>
          Expand
        </button>
        <button onClick={() => chartObjRef.current?.collapseAll()} style={{ padding: "8px 12px" }}>
          Collapse
        </button>
      </div>

      {error ? (
        <div style={{ color: "#b00020", fontWeight: 700, marginBottom: 12 }}>{error}</div>
      ) : null}

      <div
        style={{
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: 16,
          background: "white",
          padding: 12,
          minHeight: 650,
          overflow: "hidden",
        }}
      >
        <div ref={chartRef} />
      </div>

      <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
        CSV headers expected: Name, Work Email, Manager Email, Team, Location, Photo URL (optional: Pod)
      </div>
    </div>
  );
}
