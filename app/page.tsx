"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type Row = {
  Name: string;
  "Work Email"?: string;
  "Manager Email"?: string;
  Team?: string;
  Pod?: string;
  Location?: string; // we will also accept "Country" as alias
  Country?: string;  // alias
  "Photo URL"?: string;
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

function slugify(s: string) {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "");
}

// Required headers: Pod optional, Country optional (Location OR Country must exist)
function requiredColsMissing(headers: string[]) {
  const baseRequired = ["Name", "Work Email", "Manager Email", "Team", "Photo URL"];
  const set = new Set(headers);

  const missingBase = baseRequired.filter((c) => !set.has(c));

  const hasLocationOrCountry = set.has("Location") || set.has("Country");
  const missingLocation = hasLocationOrCountry ? [] : ["Location (or Country)"];

  return [...missingBase, ...missingLocation];
}

export default function ClientPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>("");

  // Determine edit mode from querystring (?edit=1) on client only
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  // Load shared CSV from server on first load (works for view-only users)
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
          error: (err: unknown) =>
            setError(err instanceof Error ? err.message : String(err)),
        });
      })
      .catch(() => {
        // normal on first run (no CSV uploaded yet)
      });
  }, []);

  const nodes = useMemo(() => {
    // 1) Build person nodes
    const people = rows
      .map((r, i) => {
        const name = String((r as any)["Name"] ?? "").trim();
        const workEmail = String((r as any)["Work Email"] ?? "").trim();
        const managerEmail = String((r as any)["Manager Email"] ?? "").trim();
        const team = String((r as any)["Team"] ?? "").trim();
        const pod = String((r as any)["Pod"] ?? "").trim();
        const country = String((r as any)["Country"] ?? (r as any)["Location"] ?? "").trim();
        const photoRaw = String((r as any)["Photo URL"] ?? "").trim();

        // Skip totally empty rows (prevents d3-org-chart crash)
        if (!name && !workEmail) return null;

        const id =
          workEmail ? normalizeEmail(workEmail) : `person:${slugify(name)}:${i}`;

        const parentId = managerEmail ? normalizeEmail(managerEmail) : null;

        return {
          id,
          parentId,
          type: "person" as const,
          name: name || workEmail || "(no name)",
          email: workEmail,
          team,
          pod,
          country,
          photoUrl:
            ensureHttps(photoRaw) ||
            `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
              name || "User"
            )}`,
        };
      })
      .filter(Boolean) as any[];

    // Ensure unique IDs (duplicates can break chart)
    const seen = new Map<string, number>();
    for (const p of people) {
      const count = (seen.get(p.id) || 0) + 1;
      seen.set(p.id, count);
      if (count > 1) p.id = `${p.id}__${count}`;
    }

    // 2) Fix parent references (if manager not found, treat as root)
    const idSet = new Set(people.map((p) => p.id));
    const normalizedPeople = people.map((p) => ({
      ...p,
      parentId: p.parentId && idSet.has(p.parentId) ? p.parentId : null,
    }));

    // 3) Pod grouping: create synthetic "pod" nodes under each manager
    // For each person with a pod + has a manager, we:
    // manager -> podNode -> person
    const podNodes: any[] = [];
    const podNodeIdByKey = new Map<string, string>();

    function getPodNodeId(managerId: string | null, podName: string) {
      const key = `${managerId || "root"}::${podName}`;
      if (podNodeIdByKey.has(key)) return podNodeIdByKey.get(key)!;

      const podId = `pod:${managerId || "root"}:${slugify(podName) || "unknown"}`;
      podNodeIdByKey.set(key, podId);

      podNodes.push({
        id: podId,
        parentId: managerId, // null for root-level pods
        type: "pod" as const,
        name: podName,
      });

      return podId;
    }

    const withPods = normalizedPeople.map((p) => {
      const podName = String(p.pod || "").trim();
      if (!podName) return p;

      // group under pod node
      const podId = getPodNodeId(p.parentId ?? null, podName);
      return { ...p, parentId: podId };
    });

    return [...podNodes, ...withPods];
  }, [rows]);

  // Render chart whenever nodes change
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
        .nodeWidth((d: any) => (d.data.type === "pod" ? 220 : 320))
        .nodeHeight((d: any) => (d.data.type === "pod" ? 56 : 120))
        .childrenMargin(() => 50)
        .compactMarginBetween(() => 35)
        .compactMarginPair(() => 80)
        .nodeContent((d: any) => {
          const p = d.data;

          // POD GROUP NODE (sanal node)
          if (p.type === "pod") {
            return `
              <div style="
                width:220px;height:56px;background:#F3F4F6;border:1px solid rgba(0,0,0,0.10);
                border-radius:14px;display:flex;align-items:center;justify-content:center;
                font-weight:900;font-size:14px;color:#111827;
                box-shadow:0 2px 10px rgba(0,0,0,0.05);
              ">
                ${p.name}
              </div>
            `;
          }

          // PERSON NODE (sadece 4 satır: name, team, country, email)
          const img = p.photoUrl
            ? `<img src="${p.photoUrl}" crossorigin="anonymous"
                   style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid rgba(0,0,0,0.12)" />`
            : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                   display:flex;align-items:center;justify-content:center;font-weight:900;">
                 ${String(p.name).trim().slice(0, 1).toUpperCase()}
               </div>`;

          return `
            <div style="
              width:320px;height:120px;background:#fff;border:1px solid rgba(0,0,0,0.14);
              border-radius:16px;box-shadow:0 4px 14px rgba(0,0,0,0.08);
              padding:12px;display:flex;gap:12px;align-items:center;
            ">
              ${img}
              <div style="display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;">
                <div style="
                  font-weight:900;font-size:16px;line-height:1.15;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.name}
                </div>

                <div style="
                  font-size:13px;font-weight:800;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.team || ""}
                </div>

                <div style="
                  font-size:12px;font-weight:800;color:#374151;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.country || ""}
                </div>

                <div style="
                  font-size:12px;font-weight:800;color:#6B7280;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.email || ""}
                </div>
              </div>
            </div>
          `;
        })
        .render();

      chartObjRef.current = chart;
    })();

    return () => {
      cancelled = true;
    };
  }, [nodes]);

  async function uploadCsvToServer(file: File) {
    setError("");

    const pw = prompt("Admin password?");
    if (!pw) return;

    // (Optional) quick header validation before upload
    const text = await file.text();
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    const headers = ((parsed as any).meta?.fields || []) as string[];
    const missing = requiredColsMissing(headers);
    if (missing.length) {
      setError(`Missing required columns: ${missing.join(", ")}`);
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
      return;
    }

    // Reload from shared source
    const csv = await (await fetch("/api/org")).text();
    Papa.parse<Row>(csv, {
      header: true,
      skipEmptyLines: true,
      complete: (r) => setRows((r.data || []) as Row[]),
      error: (err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
    });
  }

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 16px 0" }}>
        Aspora Organisational Chart
      </h1>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
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
        CSV headers expected: Name, Work Email, Manager Email, Team, Photo URL, Location (or Country), optional: Pod
      </div>
    </div>
  );
}
