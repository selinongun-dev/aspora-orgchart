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

// CSV header alias
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

  // Read URL params once (edit=1 + optional view=pod|hierarchy)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");

    const v = params.get("view");
    if (v === "pod" || v === "hierarchy") setViewMode(v);
  }, []);

  // helper: keep view in URL (nice for sharing) + auto-fit
  const setTab = (mode: ViewMode) => {
    setViewMode(mode);

    // keep query param without losing others (like edit=1)
    const url = new URL(window.location.href);
    url.searchParams.set("view", mode);
    window.history.replaceState({}, "", url.toString());

    // fit after React commits + chart renders
    requestAnimationFrame(() => {
      chartObjRef.current?.fit?.();
    });
  };

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
        // first setup: csv may not exist
      });
  }, []);

  // people nodes
  const people: PersonNode[] = useMemo(() => {
    return rows
      .filter((r) => Object.keys(r || {}).length > 0)
      .map((r, i) => {
        const name = String(pick(r, ["Name"])).trim();
        const email = String(pick(r, ["Work Email", "Email", "Work email"])).trim();
        const managerEmail = String(pick(r, ["Manager Email", "Manager email"])).trim();

        const team = String(pick(r, ["Team"])).trim();
        const location = String(pick(r, ["Location", "Country"])).trim();

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

  // normalize roots
  const normalizedPeople: PersonNode[] = useMemo(() => {
    const ids = new Set(people.map((p) => p.id));
    const missing = new Set<string>();

    const result = people.map((p) => {
      if (p.parentId && !ids.has(p.parentId)) {
        missing.add(p.parentId);
      }
      return {
        ...p,
        parentId: p.parentId && ids.has(p.parentId) ? p.parentId : null,
      };
    });

    if (missing.size > 0) {
      console.warn("⚠️ Manager emails not found in CSV:", Array.from(missing));
    }

    return result;
  }, [people]);

  // pod -> person ids
  const idsByPod = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of normalizedPeople) {
      if (!p.pod) continue;
      if (!map.has(p.pod)) map.set(p.pod, []);
      map.get(p.pod)!.push(p.id);
    }
    return map;
  }, [normalizedPeople]);

  // roots -> super-root if needed
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

  // POD VIEW dataset (only used when viewMode === "pod")
  const podNodes: ChartNode[] = useMemo(() => {
    if (viewMode !== "pod") return hierarchyNodes;
    if (!rootId) return hierarchyNodes;

    const pods = Array.from(idsByPod.keys()).sort((a, b) => a.localeCompare(b));
    const podGroupNodes: PodNode[] = pods.map((pod) => ({
      id: `pod:${pod}`,
      parentId: rootId,
      isPod: true,
      name: pod,
    }));

    const byId = new Map<string, PersonNode>();
    for (const n of hierarchyNodes) {
      if ((n as any).isPod) continue;
      byId.set((n as PersonNode).id, n as PersonNode);
    }

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

  // Render chart (single container; tabs just change dataset + styling)
  useEffect(() => {
    if (!chartRef.current) return;

    const dataToRender = viewMode === "pod" ? podNodes : hierarchyNodes;

    if (!dataToRender.length) {
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

      const chart = new OrgChart()
        .container(chartRef.current)
        .data(dataToRender)
        .nodeWidth((d: any) => {
          if (viewMode === "pod" && d?.data?.isPod) return 340;
          return 320;
        })
        .nodeHeight((d: any) => {
          if (viewMode === "pod" && d?.data?.isPod) return 90;
          return 120;
        })
        .childrenMargin(() => 50)
        .compactMarginBetween(() => 35)
        .compactMarginPair(() => 80)
        .onNodeClick((d: any) => {
          const data = d?.data as ChartNode;
          const c = chart as any;

          const isExpanded = !!d?.data?._expanded;
          const safeSet = (id: string, val: boolean) => {
            if (typeof c.setExpanded === "function") c.setExpanded(id, val);
          };

          // Pod node: toggle whole pod
          if (viewMode === "pod" && data?.isPod) {
            const podName = (data as PodNode).name;
            const ids = idsByPod.get(podName) || [];

            safeSet(data.id, !isExpanded);

            if (!isExpanded) {
              for (const id of ids) safeSet(id, true);
            } else {
              for (const id of ids) safeSet(id, false);
            }

            c.render?.();
            c.fit?.();
            return;
          }

          // Person node: simple toggle
          safeSet((data as any).id, !isExpanded);
          c.render?.();
          c.fit?.();
        })
        .nodeContent((d: any) => {
          const p = d.data as ChartNode;

          // POD NODE
          if ((p as any).isPod) {
            const podName = (p as PodNode).name;
            const total = (idsByPod.get(podName) || []).length;

            return `
              <div style="
                width:340px;height:90px;background:${LILAC_BG};
                border:1px solid rgba(0,0,0,0.10);
                border-radius:18px;box-shadow:0 6px 18px rgba(0,0,0,0.06);
                display:flex;align-items:center;justify-content:center;
                position:relative; overflow:hidden;
              ">
                <div style="position:absolute;left:0;top:0;bottom:0;width:6px;background:${LILAC};"></div>

                <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:0 16px;max-width:320px;">
                  <div style="
                    font-weight:900;font-size:18px;color:#111827;
                    text-align:center;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;
                  ">
                    ${(p as PodNode).name}
                  </div>

                  <div style="
                    font-size:12px;font-weight:800;color:#6B7280;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;
                    text-align:center;
                  ">
                    ${total} people
                  </div>
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
              width:320px;height:120px;background:#fff;border:1px solid rgba(0,0,0,0.12);
              border-radius:16px;box-shadow:0 2px 10px rgba(0,0,0,0.06);
              padding:12px;display:flex;gap:12px;align-items:center;
              position:relative; overflow:hidden;
            ">
              <div style="position:absolute;left:0;top:0;bottom:0;width:6px;background:${LILAC};"></div>

              <div style="margin-left:6px;display:flex;gap:12px;align-items:center;min-width:0;">
                ${img}
                <div style="display:flex;flex-direction:column;gap:6px;min-width:0;">
                <div style="font-weight:900;font-size:15px;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px;">
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
        })
        .render();

      chartObjRef.current = chart;

      // initial behavior: in pod view, collapse all but keep root visible
      if (viewMode === "pod") {
        const c = chart as any;

        c.collapseAll?.();

        // root’u aç
        if (rootId) c.setExpanded?.(rootId, true);

        // root altındaki pod node'larını aç
        for (const pod of idsByPod.keys()) {
          c.setExpanded?.(`pod:${pod}`, true);
        }

        c.render?.();
        c.fit?.();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [viewMode, podNodes, hierarchyNodes, idsByPod, rootId]);

  function onLocalFileCheck(headers: string[]) {
    const missing = requiredColsMissing(headers);
    if (missing.length) {
      setError(`Missing required columns: ${missing.join(", ")}`);
      return false;
    }
    return true;
  }

  const TabButton = ({
    active,
    children,
    onClick,
  }: {
    active: boolean;
    children: React.ReactNode;
    onClick: () => void;
  }) => (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      style={{
        padding: "10px 14px",
        border: "none",
        background: active ? "#F5F3FF" : "transparent",
        color: "#111827",
        fontWeight: 900,
        cursor: "pointer",
        outline: "none",
      }}
    >
      {children}
    </button>
  );

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 16px 0" }}>
        Aspora Organisational Chart
      </h1>

      {/* Top bar: upload (if edit) + tabs + controls */}
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
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

          {/* Tabs */}
          <div
            role="tablist"
            style={{
              display: "inline-flex",
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: 12,
              overflow: "hidden",
              background: "white",
            }}
          >
            <div
              style={{
                borderRight: "1px solid rgba(0,0,0,0.10)",
              }}
            >
              <TabButton active={viewMode === "hierarchy"} onClick={() => setTab("hierarchy")}>
                Team
              </TabButton>
              {viewMode === "hierarchy" ? (
                <div style={{ height: 2, background: "#6D28D9" }} />
              ) : (
                <div style={{ height: 2, background: "transparent" }} />
              )}
            </div>

            <div>
              <TabButton active={viewMode === "pod"} onClick={() => setTab("pod")}>
                Pod
              </TabButton>
              {viewMode === "pod" ? (
                <div style={{ height: 2, background: "#6D28D9" }} />
              ) : (
                <div style={{ height: 2, background: "transparent" }} />
              )}
            </div>
          </div>
        </div>

        {/* Shared controls */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={() => chartObjRef.current?.fit?.()}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.12)",
              background: "white",
              fontWeight: 800,
            }}
          >
            Fit
          </button>

          <button
            onClick={() => chartObjRef.current?.expandAll?.()}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.12)",
              background: "white",
              fontWeight: 800,
            }}
          >
            Expand
          </button>

          <button
            onClick={() => chartObjRef.current?.collapseAll?.()}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.12)",
              background: "white",
              fontWeight: 800,
            }}
          >
            Collapse
          </button>
        </div>
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

