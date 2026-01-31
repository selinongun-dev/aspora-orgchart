"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type Row = {
  Name: string;
  "Work Email": string;
  "Manager Email": string;
  Team: string;
  Location: string;
  "Photo URL": string;
  Pod?: string;
};

type NodeData = {
  id: string;
  parentId: string | null;
  name: string;
  email: string;
  team: string;
  location: string;
  photoUrl: string;
  pod?: string;

  // virtual nodes
  isPod?: boolean;
  podTotal?: number;
};

function normalizeEmail(v: string) {
  return (v || "").trim().toLowerCase();
}

function ensureHttps(url: string) {
  const u = (url || "").trim();
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  return `https://${u}`;
}

// ---- CSV header aliases (senin sheet bazen Job Title / Manager Name vb ekliyor)
// Biz sadece lazım olanları map’liyoruz. ----
const HEADER_ALIASES: Record<keyof Row, string[]> = {
  Name: ["Name", "Full Name"],
  "Work Email": ["Work Email", "Email", "Work email"],
  "Manager Email": ["Manager Email", "Manager email", "Reports To Email", "Manager Email Address"],
  Team: ["Team", "Department"],
  Location: ["Location", "Country", "Office", "Country/Location"],
  "Photo URL": ["Photo URL", "Photo", "PhotoURL", "Image", "Image URL"],
  Pod: ["Pod", "POD", "Product Pod", "Squad"],
};

function pickField(obj: Record<string, any>, keys: string[]) {
  for (const k of keys) {
    if (k in obj) return obj[k];
  }
  return "";
}

function parseCsvTextToRows(text: string): { rows: Row[]; error?: string } {
  const parsed = Papa.parse<Record<string, any>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors?.length) {
    return { rows: [], error: parsed.errors[0]?.message || "CSV parse error" };
  }

  const data = (parsed.data || []) as Record<string, any>[];

  const rows: Row[] = data.map((r) => {
    const mapped: Row = {
      Name: String(pickField(r, HEADER_ALIASES.Name) ?? "").trim(),
      "Work Email": String(pickField(r, HEADER_ALIASES["Work Email"]) ?? "").trim(),
      "Manager Email": String(pickField(r, HEADER_ALIASES["Manager Email"]) ?? "").trim(),
      Team: String(pickField(r, HEADER_ALIASES.Team) ?? "").trim(),
      Location: String(pickField(r, HEADER_ALIASES.Location) ?? "").trim(),
      "Photo URL": String(pickField(r, HEADER_ALIASES["Photo URL"]) ?? "").trim(),
      Pod: String(pickField(r, HEADER_ALIASES.Pod) ?? "").trim(),
    };
    return mapped;
  });

  // basic validation: Name zorunlu
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].Name) return { rows: [], error: `Row ${i + 2}: Name is empty` };
  }

  return { rows };
}

export default function ClientPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [layout, setLayout] = useState<"hierarchy" | "pods">("hierarchy");

  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>("");
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
    const l = params.get("layout");
    if (l === "pods") setLayout("pods");
  }, []);

  // Load shared CSV on first load
  useEffect(() => {
    setStatus("Loading…");
    fetch("/api/org")
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.text();
      })
      .then((text) => {
        const res = parseCsvTextToRows(text);
        if (res.error) {
          setError(res.error);
          setRows([]);
          setStatus("");
          return;
        }
        setError("");
        setRows(res.rows);
        setStatus(`Loaded ${res.rows.length} people`);
      })
      .catch(() => {
        setStatus("No CSV uploaded yet (normal).");
      });
  }, []);

  // Build person nodes (hierarchy base)
  const personNodes: NodeData[] = useMemo(() => {
    const built = rows.map((r, i) => {
      const workEmail = String(r["Work Email"] || "").trim();
      const name = String(r.Name || "").trim();
      const id = workEmail ? normalizeEmail(workEmail) : `row:${i}:${name.toLowerCase()}`;

      return {
        id,
        parentId: normalizeEmail(r["Manager Email"]) || null,
        name: name || workEmail || "(no name)",
        email: workEmail,
        team: (r.Team || "").trim(),
        location: (r.Location || "").trim(),
        pod: (r.Pod || "").trim(),
        photoUrl:
          ensureHttps(r["Photo URL"] || "") ||
          `https://ui-avatars.com/api/?background=ede9fe&color=4c1d95&name=${encodeURIComponent(
            name || "User"
          )}`,
      };
    });

    // If manager not in dataset, parentId null
    const ids = new Set(built.map((n) => n.id));
    return built.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));
  }, [rows]);

  // POD layout nodes:
  // - create pod nodes under root(s)
  // - keep hierarchy INSIDE pod when manager is same pod
  // - if pod empty => do NOT create "No Pod", keep normal hierarchy
  const nodes: NodeData[] = useMemo(() => {
    if (layout === "hierarchy") return personNodes;

    // find roots (CEO etc.)
    const roots = personNodes.filter((n) => !n.parentId).map((n) => n.id);
    const globalRoot = roots.length ? roots[0] : null;

    // pod totals
    const podTotals = new Map<string, number>();
    for (const n of personNodes) {
      const p = (n.pod || "").trim();
      if (!p) continue;
      podTotals.set(p, (podTotals.get(p) || 0) + 1);
    }

    // create pod nodes under global root (if none, they become roots)
    const podNodes: NodeData[] = Array.from(podTotals.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([podName, total]) => ({
        id: `pod:${podName.toLowerCase()}`,
        parentId: globalRoot, // if null => root
        name: podName,
        email: "",
        team: "",
        location: "",
        photoUrl: "",
        isPod: true,
        podTotal: total,
      }));

    const byId = new Map(personNodes.map((n) => [n.id, n]));
    const podIdByName = new Map<string, string>();
    for (const p of podNodes) podIdByName.set(p.name, p.id);

    const remappedPeople: NodeData[] = personNodes.map((n) => {
      const podName = (n.pod || "").trim();
      if (!podName) return n; // keep original hierarchy if no pod

      const manager = n.parentId ? byId.get(n.parentId) : null;
      const managerPod = (manager?.pod || "").trim();

      // If manager is same pod -> keep as is (under manager)
      if (manager && managerPod === podName) return n;

      // else attach to pod node
      return {
        ...n,
        parentId: podIdByName.get(podName) || n.parentId,
      };
    });

    return [...podNodes, ...remappedPeople];
  }, [layout, personNodes]);

  // Render chart
  useEffect(() => {
    if (!chartRef.current) return;

    if (!nodes.length) {
      chartRef.current.innerHTML = "";
      return;
    }

    chartRef.current.innerHTML = "";
    let cancelled = false;

    (async () => {
      try {
        const mod = await import("d3-org-chart");
        const OrgChart = (mod as any).OrgChart;
        if (cancelled || !chartRef.current) return;

        const LILAC = "#6D28D9";
        const LILAC_BG = "#F5F3FF";

        const chart = new OrgChart()
          .container(chartRef.current)
          .data(nodes)
          .nodeWidth((d: any) => (d.data?.isPod ? 360 : 360))
          .nodeHeight((d: any) => (d.data?.isPod ? 90 : 124))
          .childrenMargin(() => 55)
          .compactMarginBetween(() => 30)
          .compactMarginPair(() => 80)

          // IMPORTANT: button label (pod’da total göster)
          .buttonContent((d: any) => {
            const data = d.data || {};
            const label =
              data.isPod && typeof data.podTotal === "number"
                ? String(data.podTotal)
                : String(d.children?.length || 0);

            // küçük pill — overlap olmasın diye biraz daha aşağıda dursun
            return `
              <div style="
                transform: translateY(8px);
                background: white;
                border: 1px solid rgba(0,0,0,0.12);
                border-radius: 8px;
                padding: 2px 6px;
                font-size: 12px;
                font-weight: 800;
                color: #111827;
                box-shadow: 0 2px 8px rgba(0,0,0,0.06);
                min-width: 22px;
                text-align: center;
              ">${label}</div>
            `;
          })

          .nodeContent((d: any) => {
            const p: NodeData = d.data;

            // POD NODE (no "x people" text)
            if (p.isPod) {
              return `
                <div style="
                  width:360px;height:90px;background:${LILAC_BG};
                  border:1px solid rgba(0,0,0,0.10);
                  border-radius:18px;box-shadow:0 6px 18px rgba(0,0,0,0.06);
                  display:flex;align-items:center;justify-content:center;
                  position:relative; overflow:hidden;
                  padding-bottom:16px;
                ">
                  <div style="position:absolute;left:0;top:0;bottom:0;width:6px;background:${LILAC};"></div>
                  <div style="
                    font-weight:900;font-size:18px;color:#111827;
                    padding:0 16px; text-align:center;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px;
                  ">
                    ${p.name}
                  </div>
                </div>
              `;
            }

            const img = p.photoUrl
              ? `<img src="${p.photoUrl}" crossorigin="anonymous"
                     style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid rgba(0,0,0,0.12)" />`
              : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                     display:flex;align-items:center;justify-content:center;font-weight:800;">
                   ${String(p.name).trim().slice(0, 1).toUpperCase()}
                 </div>`;

            return `
              <div style="
                width:360px;height:124px;background:#fff;border:1px solid rgba(0,0,0,0.12);
                border-radius:18px;box-shadow:0 6px 18px rgba(0,0,0,0.06);
                padding:14px;display:flex;gap:12px;align-items:center;
                position:relative; overflow:hidden;
                padding-bottom:22px;
              ">
                <div style="position:absolute;left:0;top:0;bottom:0;width:6px;background:${LILAC};"></div>

                ${img}

                <div style="display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;">
                  <div style="
                    font-weight:950;font-size:16px;line-height:1.1;color:#111827;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  ">
                    ${p.name}
                  </div>

                  <div style="font-size:13px;font-weight:800;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${p.team}
                  </div>

                  <div style="font-size:12px;font-weight:800;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${p.location}
                  </div>

                  <div style="font-size:12px;font-weight:800;color:#6B7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${p.email}
                  </div>

                  ${
                    p.pod
                      ? `<div style="
                          position:absolute; right:12px; top:12px;
                          font-size:12px;font-weight:900;color:#4C1D95;
                          background:#EDE9FE;border:1px solid rgba(76,29,149,0.15);
                          padding:3px 9px;border-radius:999px;
                          max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                        ">${p.pod}</div>`
                      : ""
                  }
                </div>
              </div>
            `;
          })
          .render();

        chartObjRef.current = chart;

        // POD layout: daha pürüzsüz olsun diye ilk açılışta genişlet
        if (layout === "pods") {
          chart.expandAll();
          chart.fit();
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nodes, layout]);

  async function uploadCsvToServer(file: File) {
    setError("");
    setStatus("Uploading…");

    const pw = prompt("Admin password?");
    if (!pw) {
      setStatus("");
      return;
    }

    const fd = new FormData();
    fd.append("file", file);

    const res = await fetch("/api/org", {
      method: "POST",
      headers: { "x-admin-password": pw },
      body: fd,
    });

    if (!res.ok) {
      setError(`Upload failed: ${await res.text()}`);
      setStatus("");
      return;
    }

    // Always reload from shared source
    const again = await fetch("/api/org");
    const text = await again.text();
    const parsed = parseCsvTextToRows(text);

    if (parsed.error) {
      setError(parsed.error);
      setRows([]);
      setStatus("");
      return;
    }

    setRows(parsed.rows);
    setStatus(`Loaded ${parsed.rows.length} people`);
  }

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 14px 0" }}>
        Aspora Organisational Chart
      </h1>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
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

              await uploadCsvToServer(file);

              // reset input (normal)
              e.currentTarget.value = "";
            }}
          />
        )}

        <button
          onClick={() => setLayout("hierarchy")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: layout === "hierarchy" ? "2px solid #6D28D9" : "1px solid rgba(0,0,0,0.12)",
            background: layout === "hierarchy" ? "#F5F3FF" : "white",
            fontWeight: 900,
          }}
        >
          Hierarchy
        </button>

        <button
          onClick={() => setLayout("pods")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: layout === "pods" ? "2px solid #6D28D9" : "1px solid rgba(0,0,0,0.12)",
            background: layout === "pods" ? "#F5F3FF" : "white",
            fontWeight: 900,
          }}
        >
          Pods
        </button>

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

      {status ? (
        <div style={{ marginBottom: 10, fontSize: 12, fontWeight: 800, color: "#4B5563" }}>
          {status}
        </div>
      ) : null}

      {error ? (
        <div style={{ color: "#b00020", fontWeight: 900, marginBottom: 12 }}>
          {error}
        </div>
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

      <div style={{ marginTop: 10, opacity: 0.75, fontSize: 12 }}>
        CSV should include at least Name + Work Email + Manager Email + Team + Location + Photo URL. Pod is optional.
      </div>
    </div>
  );
}
