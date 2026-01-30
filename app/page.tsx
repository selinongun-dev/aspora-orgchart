"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type NormalizedRow = {
  name: string;
  workEmail: string;     // optional
  managerEmail: string;  // optional value (blank => root)
  team: string;
  pod: string;           // optional
  location: string;
  photoUrl: string;
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

function pick(row: Record<string, any>, keys: string[]) {
  for (const k of keys) {
    const v = row?.[k];
    if (v !== undefined && v !== null) return String(v);
  }
  return "";
}

// Header kontrolünde alias kabul edelim
const HEADER_ALIASES = {
  name: ["Name"],
  workEmail: ["Work Email", "WorkEmail", "Work_Email"],
  managerEmail: ["Manager Email", "ManagerEmail", "Manager_Email"],
  team: ["Team"],
  location: ["Location", "Country"],
  photoUrl: ["Photo URL", "PhotoURL", "Photo_Url", "Photo"],
  pod: ["Pod", "POD"],
};

// Header zorunluluğu: Name, Manager Email, Team, Location, Photo URL
// Work Email header optional (value zaten optional)
function requiredHeaderMissing(headers: string[]) {
  const set = new Set(headers);
  const needGroups: Array<{ label: string; aliases: string[] }> = [
    { label: "Name", aliases: HEADER_ALIASES.name },
    { label: "Manager Email", aliases: HEADER_ALIASES.managerEmail },
    { label: "Team", aliases: HEADER_ALIASES.team },
    { label: "Location", aliases: HEADER_ALIASES.location },
    { label: "Photo URL", aliases: HEADER_ALIASES.photoUrl },
  ];

  const missing: string[] = [];
  for (const g of needGroups) {
    const ok = g.aliases.some((a) => set.has(a));
    if (!ok) missing.push(g.label);
  }
  return missing;
}

type LayoutMode = "hierarchy" | "pod";

export default function ClientPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [layout, setLayout] = useState<LayoutMode>("hierarchy");

  const [rows, setRows] = useState<NormalizedRow[]>([]);
  const [error, setError] = useState<string>("");

  // edit mode only with ?edit=1
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  // load shared CSV from /api/org
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
            const headers = (res.meta.fields || []) as string[];
            const missing = requiredHeaderMissing(headers);
            if (missing.length) {
              setError(
                `CSV headers missing: ${missing.join(
                  ", "
                )}. (Work Email header is optional)`
              );
              return;
            }

            const normalized: NormalizedRow[] = (res.data || []).map((r, i) => {
              const name = pick(r, HEADER_ALIASES.name).trim();
              if (!name) {
                throw new Error(`Row ${i + 2} is missing Name`);
              }

              const workEmail = pick(r, HEADER_ALIASES.workEmail).trim();
              const managerEmail = pick(r, HEADER_ALIASES.managerEmail).trim();
              const team = pick(r, HEADER_ALIASES.team).trim();
              const pod = pick(r, HEADER_ALIASES.pod).trim();
              const location = pick(r, HEADER_ALIASES.location).trim();
              const photoUrl = ensureHttps(pick(r, HEADER_ALIASES.photoUrl).trim());

              return {
                name,
                workEmail,
                managerEmail,
                team,
                pod,
                location,
                photoUrl:
                  photoUrl ||
                  `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
                    name
                  )}`,
              };
            });

            setError("");
            setRows(normalized);
          },
          error: (err: unknown) =>
            setError(err instanceof Error ? err.message : String(err)),
        });
      })
      .catch(() => {
        // first run: no CSV uploaded yet
      });
  }, []);

  const nodes = useMemo(() => {
    // build nodes
    const built = rows.map((r, i) => {
      const id = r.workEmail
        ? normalizeEmail(r.workEmail)
        : `name:${r.name.toLowerCase()}:${i}`;

      return {
        id,
        parentId: normalizeEmail(r.managerEmail) || null,
        name: r.name,
        email: r.workEmail,
        team: r.team,
        pod: r.pod,
        location: r.location,
        photoUrl: r.photoUrl,
      };
    });

    // fix parentId if manager isn't in dataset
    const ids = new Set(built.map((n) => n.id));
    let fixed = built.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));

    // layout option: keep hierarchy but reorder siblings so same-pod sits together
    if (layout === "pod") {
      fixed = [...fixed].sort((a, b) => {
        const pa = a.parentId || "";
        const pb = b.parentId || "";
        if (pa !== pb) return pa.localeCompare(pb);
        const poda = (a.pod || "").toLowerCase();
        const podb = (b.pod || "").toLowerCase();
        if (poda !== podb) return poda.localeCompare(podb);
        return a.name.localeCompare(b.name);
      });
    }

    return fixed;
  }, [rows, layout]);

  // render chart
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
        .nodeWidth(() => 320)
        .nodeHeight(() => 120)
        .childrenMargin(() => 50)
        .compactMarginBetween(() => 35)
        .compactMarginPair(() => 80)
        .nodeContent((d: any) => {
          const p = d.data;

          // lila theme (single color)
          const accent = "#6D28D9"; // purple-700
          const bg = "#F5F3FF";     // purple-50
          const border = "rgba(17,24,39,0.12)";

          const img = p.photoUrl
            ? `<img src="${p.photoUrl}" crossorigin="anonymous"
                 style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid ${border}" />`
            : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                 display:flex;align-items:center;justify-content:center;font-weight:800;">
               ${String(p.name).trim().slice(0, 1).toUpperCase()}
             </div>`;

          // Pod is NOT a 5th line. If exists, show as a small corner pill.
          const podPill =
            p.pod
              ? `<div style="
                  position:absolute;top:10px;right:12px;
                  font-size:11px;font-weight:800;color:${accent};
                  background:white;border:1px solid rgba(109,40,217,0.20);
                  padding:2px 8px;border-radius:999px;
                  max-width:130px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">${p.pod}</div>`
              : "";

          // 4 lines: Name / Team / Location / Email
          return `
            <div style="
              width:320px;height:120px;background:${bg};
              border:1px solid ${border};border-left:6px solid ${accent};
              border-radius:16px;box-shadow:0 4px 14px rgba(0,0,0,0.06);
              padding:12px;display:flex;gap:12px;align-items:center;
              position:relative;
            ">
              ${podPill}
              ${img}
              <div style="display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;">
                <div style="font-weight:900;font-size:16px;line-height:1.1;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${p.name}
                </div>
                <div style="font-size:13px;font-weight:800;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${p.team || ""}
                </div>
                <div style="font-size:12px;font-weight:700;color:#374151;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${p.location || ""}
                </div>
                <div style="font-size:11px;font-weight:700;color:#6B7280;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
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
      complete: () => window.location.reload(),
      error: (err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
    });
  }

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 16px 0" }}>
        Aspora Organisational Chart
      </h1>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
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

        <div style={{ marginLeft: 8, display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, opacity: 0.7, fontWeight: 700 }}>Layout:</span>
          <button
            onClick={() => setLayout("hierarchy")}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid rgba(0,0,0,0.12)",
              background: layout === "hierarchy" ? "#EDE9FE" : "white",
              fontWeight: 800,
            }}
          >
            Hierarchy
          </button>
          <button
            onClick={() => setLayout("pod")}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid rgba(0,0,0,0.12)",
              background: layout === "pod" ? "#EDE9FE" : "white",
              fontWeight: 800,
            }}
          >
            Pod-cluster
          </button>
        </div>
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
        Accepted headers: Name, Manager Email, Team, Location, Photo URL (Work Email optional).<br />
        Aliases supported: WorkEmail / Work Email, PhotoURL / Photo URL, etc. Pod optional.
      </div>
    </div>
  );
}
