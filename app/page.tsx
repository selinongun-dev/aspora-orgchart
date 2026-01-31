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

type NodeT = {
  id: string;
  parentId: string | null;
  name: string;
  email: string;
  team: string;
  location: string;
  photoUrl: string;
  pod: string;
  isPod?: boolean;
};

const LILAC = "#5B21B6";
const LILAC_BG = "#F5F3FF";

function normalizeEmail(v: string) {
  return (v || "").trim().toLowerCase();
}
function ensureHttps(url: string) {
  const u = (url || "").trim();
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  return `https://${u}`;
}

/** Case-insensitive getter for CSV headers */
function getField(raw: Record<string, any>, candidates: string[]): string {
  const lowerMap = new Map<string, string>();
  for (const k of Object.keys(raw || {})) lowerMap.set(k.trim().toLowerCase(), k);

  for (const c of candidates) {
    const key = lowerMap.get(c.trim().toLowerCase());
    if (key != null) return String(raw[key] ?? "").trim();
  }
  return "";
}

/** Normalize any CSV row into our Row shape (supports header aliases) */
function normalizeRow(raw: Record<string, any>): Row {
  const Name = getField(raw, ["Name", "Full Name"]);
  const workEmail = getField(raw, ["Work Email", "Email", "WorkEmail", "Work e-mail"]);
  const managerEmail = getField(raw, ["Manager Email", "ManagerEmail", "Manager e-mail"]);
  const Team = getField(raw, ["Team", "Department"]);
  const Location = getField(raw, ["Location", "Country", "Office"]);
  const photo = getField(raw, ["Photo URL", "Photo", "PhotoURL", "Photo Url"]);
  const pod = getField(raw, ["Pod", "POD", "pod"]);

  return {
    Name,
    "Work Email": workEmail,
    "Manager Email": managerEmail,
    Team,
    Location,
    "Photo URL": photo,
    Pod: pod || "",
  };
}

/** We only require headers to exist; values optional except Name. */
function requiredColsMissing(headers: string[]) {
  const required = ["name", "work email", "manager email", "team", "location", "photo url"];
  const lower = new Set((headers || []).map((h) => h.trim().toLowerCase()));
  return required.filter((c) => !lower.has(c));
}

/** compute descendant counts for buttonContent */
function computeDescCounts(nodes: NodeT[]): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    if (!children.has(n.parentId)) children.set(n.parentId, []);
    children.get(n.parentId)!.push(n.id);
  }

  const memo = new Map<string, number>();
  const dfs = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    const kids = children.get(id) || [];
    let sum = 0;
    for (const k of kids) sum += 1 + dfs(k);
    memo.set(id, sum);
    return sum;
  };

  for (const n of nodes) dfs(n.id);
  return memo;
}

export default function ClientPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [view, setView] = useState<"hierarchy" | "pods">("hierarchy");

  // client-side only query param (no Suspense needed)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  // Load shared CSV from server on first load
  useEffect(() => {
    fetch("/api/org")
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.text();
      })
      .then((text) => {
        Papa.parse<Record<string, any>>(text, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => {
            const data = (res.data || []).map((raw) => normalizeRow(raw));
            setRows(data);
          },
          error: (err: unknown) =>
            setError(err instanceof Error ? err.message : String(err)),
        });
      })
      .catch(() => {
        // First run: no CSV uploaded yet (normal)
      });
  }, []);

  // Build base PEOPLE nodes from rows (real hierarchy)
  const peopleNodes: NodeT[] = useMemo(() => {
    const built = rows.map((r, i) => {
      const workEmail = String(r["Work Email"] || "").trim();
      const name = String(r.Name || "").trim();

      const id = workEmail
        ? normalizeEmail(workEmail)
        : `name:${name.toLowerCase()}:${i}`;

      const pod = (r.Pod || "").trim() || "No Pod";

      return {
        id,
        parentId: normalizeEmail(r["Manager Email"]) || null,
        name: name || workEmail || "(no name)",
        email: workEmail,
        team: String(r.Team || "").trim(),
        location: String(r.Location || "").trim(),
        pod,
        photoUrl:
          ensureHttps(r["Photo URL"] || "") ||
          `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
            name || "User"
          )}`,
      };
    });

    // If manager id is not present in data, treat as root
    const ids = new Set(built.map((n) => n.id));
    return built.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));
  }, [rows]);

  // Find CEO/top root if exists (single top). If multiple roots, we keep them as-is.
  const ceoId: string | null = useMemo(() => {
    const roots = peopleNodes.filter((n) => n.parentId === null);
    if (!roots.length) return null;
    // Prefer a root whose title/team might be CEO; otherwise first root
    const byEmail = roots.find((r) => r.email && r.email.includes("@"));
    return (byEmail || roots[0]).id;
  }, [peopleNodes]);

  /** POD VIEW nodes:
   * - Create one pod node under CEO (if CEO exists), else as its own root.
   * - Inside pod: preserve hierarchy when manager is in same pod.
   * - If manager is outside pod (or null), attach to pod node.
   */
  const podNodes: NodeT[] = useMemo(() => {
    if (!peopleNodes.length) return [];

    const peopleById = new Map(peopleNodes.map((p) => [p.id, p]));
    const pods = Array.from(new Set(peopleNodes.map((p) => p.pod || "No Pod")));

    // Create pod header nodes
    const podHeaderNodes: NodeT[] = pods.map((pod) => ({
      id: `pod:${pod}`,
      parentId: ceoId ? ceoId : null,
      name: pod,
      email: "",
      team: "",
      location: "",
      photoUrl: "",
      pod,
      isPod: true,
    }));

    const adjustedPeople: NodeT[] = peopleNodes.map((p) => {
      // keep CEO at top (do not re-parent under pod)
      if (ceoId && p.id === ceoId) return p;

      const manager = p.parentId ? peopleById.get(p.parentId) : null;
      const samePod = manager && manager.pod === p.pod;

      return {
        ...p,
        parentId: samePod ? p.parentId : `pod:${p.pod || "No Pod"}`,
      };
    });

    return [...podHeaderNodes, ...adjustedPeople];
  }, [peopleNodes, ceoId]);

  // Choose nodes based on view
  const nodes = view === "pods" ? podNodes : peopleNodes;

  // Precompute descendant counts for buttonContent (fixes "Engineering 4 but 2 nodes")
  const descCounts = useMemo(() => computeDescCounts(nodes), [nodes]);

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
      const mod = await import("d3-org-chart");
      const OrgChart = (mod as any).OrgChart;

      if (cancelled || !chartRef.current) return;

      const chart = new OrgChart()
        .container(chartRef.current)
        .data(nodes)
        .nodeWidth(() => (view === "pods" ? 340 : 360))
        .nodeHeight(() => (view === "pods" ? 90 : 120))
        .childrenMargin(() => 60)
        .compactMarginBetween(() => 40)
        .compactMarginPair(() => 90)
        // custom button: show descendant count; for pod nodes shows total people in pod
        .buttonContent((d: any) => {
          const id = d?.data?.id as string;
          const c = descCounts.get(id) || 0;
          if (!c) return "";
          return `
            <div style="
              background:#fff;border:1px solid rgba(0,0,0,0.12);
              border-radius:8px;padding:2px 6px;font-weight:800;font-size:12px;
              color:#111827; box-shadow:0 2px 8px rgba(0,0,0,0.06);
            ">${c}</div>
          `;
        })
        // clicking a pod: open everything (closest to "pod click => full hierarchy opens")
        .onNodeClick((d: any) => {
          if (d?.data?.isPod) {
            chart.expandAll();
            chart.fit();
          }
        })
        .nodeContent((d: any) => {
          const p = d.data as NodeT;

          // POD HEADER NODE
          if (p.isPod) {
            return `
              <div style="
                width:340px;height:90px;background:${LILAC_BG};
                border:1px solid rgba(0,0,0,0.10);
                border-radius:18px;box-shadow:0 6px 18px rgba(0,0,0,0.06);
                display:flex;align-items:center;justify-content:center;
                position:relative; overflow:hidden;
              ">
                <div style="position:absolute;left:0;top:0;bottom:0;width:6px;background:${LILAC};"></div>
                <div style="
                  font-weight:900;font-size:18px;color:#111827;
                  padding:0 16px; text-align:center;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px;
                ">
                  ${p.name}
                </div>
              </div>
            `;
          }

          // PERSON NODE (lilac theme, 4 lines: name/team/country/email)
          const img = p.photoUrl
            ? `<img src="${p.photoUrl}" crossorigin="anonymous"
                 style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid rgba(0,0,0,0.12)" />`
            : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                 display:flex;align-items:center;justify-content:center;font-weight:900;">
                 ${String(p.name).trim().slice(0, 1).toUpperCase()}
               </div>`;

          return `
            <div style="
              width:360px;height:120px;background:#fff;border:1px solid rgba(0,0,0,0.12);
              border-radius:18px;box-shadow:0 6px 18px rgba(0,0,0,0.06);
              padding:12px;display:flex;gap:12px;align-items:center;position:relative;
              overflow:hidden;
            ">
              <div style="position:absolute;left:0;top:0;bottom:0;width:6px;background:${LILAC};"></div>
              ${img}
              <div style="display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;">
                <div style="font-weight:900;font-size:16px;line-height:1.1;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${p.name}
                </div>

                <div style="font-size:13px;font-weight:800;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${p.team}
                </div>

                <div style="font-size:12px;font-weight:800;color:#374151;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${p.location}
                </div>

                <div style="font-size:12px;font-weight:800;color:#6B7280;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${p.email}
                </div>
              </div>
            </div>
          `;
        })
        .render();

      chartObjRef.current = chart;

      // In pods view, default to expanded so "pod click opens all" feels natural
      if (view === "pods") {
        chart.expandAll();
        chart.fit();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nodes, view, descCounts]);

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

    // Reload from shared source
    const csv = await (await fetch("/api/org")).text();
    Papa.parse<Record<string, any>>(csv, {
      header: true,
      skipEmptyLines: true,
      complete: (r) => {
        const data = (r.data || []).map((raw) => normalizeRow(raw));
        setRows(data);
      },
      error: (err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
    });
  }

  function validateCsvLocally(file: File) {
    setError("");
    Papa.parse<Record<string, any>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const headers = (res.meta.fields || []) as string[];
        const missing = requiredColsMissing(headers);
        if (missing.length) {
          setError(`Missing required columns: ${missing.join(", ")}`);
          return;
        }

        const data = (res.data || []).map((raw, idx) => {
          const row = normalizeRow(raw);
          if (!row.Name?.trim()) {
            throw new Error(`Row ${idx + 2} has empty Name`);
          }
          return row;
        });

        setRows(data);
      },
      error: (err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
    });
  }

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 12px 0" }}>
        Aspora Organisational Chart
      </h1>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <button
          onClick={() => setView("hierarchy")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.12)",
            background: view === "hierarchy" ? LILAC_BG : "#fff",
            fontWeight: 900,
            color: "#111827",
          }}
        >
          Hierarchy
        </button>
        <button
          onClick={() => setView("pods")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.12)",
            background: view === "pods" ? LILAC_BG : "#fff",
            fontWeight: 900,
            color: "#111827",
          }}
        >
          Pods
        </button>

        <div style={{ width: 1, height: 26, background: "rgba(0,0,0,0.12)" }} />

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
              // quick local parse (so you can see immediately)
              validateCsvLocally(file);
              // upload shared
              await uploadCsvToServer(file);
            }}
          />
        )}

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
        <div style={{ color: "#b00020", fontWeight: 900, marginBottom: 12 }}>{error}</div>
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
