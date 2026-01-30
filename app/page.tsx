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

type PersonNode = {
  type: "person";
  id: string;
  parentId: string | null;
  name: string;
  email: string;
  team: string;
  location: string;
  photoUrl: string;
  pod: string;
};

type PodNode = {
  type: "pod";
  id: string;
  parentId: string | null;
  pod: string;
  count: number;
};

type AnyNode = PersonNode | PodNode;

function normalizeEmail(v: string) {
  return (v || "").trim().toLowerCase();
}

function ensureHttps(url: string) {
  const u = (url || "").trim();
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  return `https://${u}`;
}

function requiredColsMissing(headers: string[]) {
  // Pod opsiyonel
  const required = ["Name", "Work Email", "Manager Email", "Team", "Location", "Photo URL"];
  const set = new Set(headers);
  return required.filter((c) => !set.has(c));
}

function safeKey(s: string) {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "");
}

export default function ClientPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>("");

  // View mode: hierarchy vs pod grouping
  const [viewMode, setViewMode] = useState<"hierarchy" | "pods">("hierarchy");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  // Load shared CSV from server
  useEffect(() => {
    fetch("/api/org")
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.text();
      })
      .then((text) => {
        Papa.parse<Row>(text, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => setRows((res.data || []) as Row[]),
          error: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
        });
      })
      .catch(() => {
        // first run: no CSV uploaded yet (normal)
      });
  }, []);

  const basePeople: PersonNode[] = useMemo(() => {
    return rows.map((r, i) => {
      const workEmail = String(r["Work Email"] || "").trim();
      const name = String(r.Name || "").trim();

      const id = workEmail ? normalizeEmail(workEmail) : `name:${name.toLowerCase()}:${i}`;
      const parentIdRaw = normalizeEmail(r["Manager Email"]) || null;

      const podVal = String(r.Pod || "").trim();

      return {
        type: "person",
        id,
        parentId: parentIdRaw,
        name: name || workEmail || "(no name)",
        email: workEmail,
        team: String(r.Team || "").trim(),
        location: String(r.Location || "").trim(),
        pod: podVal,
        photoUrl:
          ensureHttps(r["Photo URL"] || "") ||
          `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(name || "User")}`,
      };
    });
  }, [rows]);

  // Fix parentId: if manager not in dataset => null (root)
  const peopleWithValidParents: PersonNode[] = useMemo(() => {
    const ids = new Set(basePeople.map((n) => n.id));
    return basePeople.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));
  }, [basePeople]);

  // POD VIEW TRANSFORM:
  // For each manager node, group its DIRECT reports by Pod, inserting a Pod group node under that manager.
  const nodes: AnyNode[] = useMemo(() => {
    if (viewMode === "hierarchy") return peopleWithValidParents;

    const byParent = new Map<string | null, PersonNode[]>();
    for (const p of peopleWithValidParents) {
      const k = p.parentId;
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k)!.push(p);
    }

    const out: AnyNode[] = [];
    const podNodes: PodNode[] = [];
    const rewrittenPeople: PersonNode[] = [];

    // helper: process one manager's direct reports
    function processParent(parentId: string | null) {
      const children = byParent.get(parentId) || [];
      if (!children.length) return;

      // group direct reports by pod (only if pod is non-empty)
      const groups = new Map<string, PersonNode[]>();
      const noPod: PersonNode[] = [];

      for (const c of children) {
        const pod = (c.pod || "").trim();
        if (!pod) {
          noPod.push(c);
          continue;
        }
        const key = pod; // keep original casing for label
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(c);
      }

      // keep "no pod" people directly under manager
      for (const c of noPod) rewrittenPeople.push(c);

      // create a pod node for each pod group and re-parent those children
      for (const [podLabel, members] of groups.entries()) {
        const podId = `pod:${parentId ?? "root"}:${safeKey(podLabel)}`;

        podNodes.push({
          type: "pod",
          id: podId,
          parentId,
          pod: podLabel,
          count: members.length,
        });

        for (const m of members) {
          rewrittenPeople.push({
            ...m,
            parentId: podId,
          });
        }
      }
    }

    // We need to process all possible parentIds (including null/root and all people ids)
    processParent(null);
    for (const p of peopleWithValidParents) processParent(p.id);

    // IMPORTANT: also include all people who are NOT direct reports anywhere? (they are already included)
    // The rewrittenPeople currently contains everyone once, because every person is a child of exactly one parentId key.
    // But to be safe, ensure uniqueness:
    const seen = new Set<string>();
    for (const p of rewrittenPeople) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
      }
    }

    // add pod nodes at the end (doesn't matter)
    for (const pn of podNodes) out.push(pn);

    return out;
  }, [peopleWithValidParents, viewMode]);

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
          .data(nodes as any)
          .nodeWidth((d: any) => (d.data.type === "pod" ? 220 : 320))
          .nodeHeight((d: any) => (d.data.type === "pod" ? 70 : 118))
          .childrenMargin(() => 50)
          .compactMarginBetween(() => 30)
          .compactMarginPair(() => 70)
          .nodeContent((d: any) => {
            const p: AnyNode = d.data;

            // POD GROUP NODE
            if (p.type === "pod") {
              return `
                <div style="
                  width:220px;height:70px;
                  background:${LILAC_BG};
                  border:1px solid rgba(0,0,0,0.10);
                  border-left:6px solid ${LILAC};
                  border-radius:16px;
                  box-shadow:0 2px 10px rgba(0,0,0,0.06);
                  display:flex;align-items:center;justify-content:center;
                  padding:10px;
                ">
                  <div style="display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0;">
                    <div style="
                      font-weight:900;font-size:14px;color:#111827;
                      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;
                    ">
                      ${p.pod}
                    </div>
                    <div style="
                      font-weight:800;font-size:11px;color:#4B5563;
                      background:white;border:1px solid rgba(0,0,0,0.08);
                      padding:2px 8px;border-radius:999px;
                    ">
                      ${p.count} people
                    </div>
                  </div>
                </div>
              `;
            }

            // PERSON NODE (ONLY 4 lines: Name / Team / Location / Email)
            const img = p.photoUrl
              ? `<img src="${p.photoUrl}" crossorigin="anonymous"
                     style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid rgba(0,0,0,0.12)" />`
              : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                     display:flex;align-items:center;justify-content:center;font-weight:900;">
                   ${String(p.name).trim().slice(0, 1).toUpperCase()}
                 </div>`;

            return `
              <div style="
                width:320px;height:118px;background:#fff;border:1px solid rgba(0,0,0,0.12);
                border-left:6px solid ${LILAC};
                border-radius:16px;box-shadow:0 2px 10px rgba(0,0,0,0.06);
                padding:12px;display:flex;gap:12px;align-items:center;
              ">
                ${img}
                <div style="display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;">
                  <div style="
                    font-weight:950;font-size:16px;line-height:1.15;color:#111827;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  ">
                    ${p.name}
                  </div>

                  <div style="
                    font-size:13px;font-weight:800;color:#111827;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  ">
                    ${p.team}
                  </div>

                  <div style="
                    font-size:12px;font-weight:750;color:#374151;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  ">
                    ${p.location}
                  </div>

                  <div style="
                    font-size:11px;font-weight:750;color:#6B7280;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  ">
                    ${p.email}
                  </div>
                </div>
              </div>
            `;
          })
          .render();

        chartObjRef.current = chart;
      } catch (e: any) {
        setError(e?.message || String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nodes]);

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

    // Reload
    const csv = await (await fetch("/api/org")).text();
    Papa.parse<Row>(csv, {
      header: true,
      skipEmptyLines: true,
      complete: (r) => setRows((r.data || []) as Row[]),
      error: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    });
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
            }}
          />
        )}

        <button
          onClick={() => setViewMode("hierarchy")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.12)",
            background: viewMode === "hierarchy" ? "#F5F3FF" : "white",
            fontWeight: 800,
          }}
        >
          Hierarchy view
        </button>

        <button
          onClick={() => setViewMode("pods")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.12)",
            background: viewMode === "pods" ? "#F5F3FF" : "white",
            fontWeight: 800,
          }}
        >
          Pod view
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
        <div style={{ color: "#b00020", fontWeight: 800, marginBottom: 12 }}>{error}</div>
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
