"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type RawRow = Record<string, string>;

type Person = {
  id: string;
  parentId: string | null;
  name: string;
  email: string;
  team: string;
  location: string;
  photoUrl: string;
  pod: string;
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

/**
 * CSV header esneklikleri:
 * - Name / Full Name
 * - Work Email / Email
 * - Manager Email / Manager Work Email
 * - Team / Department
 * - Location / Country
 * - Photo URL / Photo
 * - Pod / POD
 */
function pick(row: RawRow, keys: string[]) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return "";
}

function avatarFallback(name: string) {
  return `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
    name || "User"
  )}`;
}

type LayoutMode = "hierarchy" | "pod";

const LILAC = "#6D28D9";
const LILAC_BG = "#F5F3FF";

export default function Page() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [rows, setRows] = useState<RawRow[]>([]);
  const [error, setError] = useState<string>("");

  const [mode, setMode] = useState<LayoutMode>("hierarchy");
  const [selectedPod, setSelectedPod] = useState<string>(""); // pod view filter

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  // initial load shared CSV
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
          error: (err: unknown) =>
            setError(err instanceof Error ? err.message : String(err)),
        });
      })
      .catch(() => {
        // first run: no CSV uploaded yet
      });
  }, []);

  const people: Person[] = useMemo(() => {
    const built: Person[] = (rows || [])
      .map((r, i) => {
        const name = pick(r, ["Name", "Full Name"]).trim();
        const emailRaw = pick(r, ["Work Email", "Email"]).trim();
        const managerEmailRaw = pick(r, ["Manager Email", "Manager Work Email"]).trim();

        const email = emailRaw;
        const id = email ? normalizeEmail(email) : `row:${i}:${name.toLowerCase()}`;

        const team = pick(r, ["Team", "Department"]).trim();
        const location = pick(r, ["Location", "Country"]).trim();
        const pod = pick(r, ["Pod", "POD"]).trim();

        const photo = ensureHttps(pick(r, ["Photo URL", "Photo"]).trim());

        return {
          id,
          parentId: managerEmailRaw ? normalizeEmail(managerEmailRaw) : null,
          name: name || email || "(no name)",
          email,
          team,
          location,
          pod,
          photoUrl: photo || avatarFallback(name || email),
        };
      })
      .filter((p) => p.name.trim() !== "");

    // Fix invalid parentId -> null (root)
    const ids = new Set(built.map((p) => p.id));
    return built.map((p) => ({
      ...p,
      parentId: p.parentId && ids.has(p.parentId) ? p.parentId : null,
    }));
  }, [rows]);

  // pod list
  const pods = useMemo(() => {
    const set = new Set<string>();
    for (const p of people) {
      if (p.pod && p.pod.trim()) set.add(p.pod.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [people]);

  /**
   * Helper: build quick lookups for hierarchy traversal
   */
  const hierarchyIndex = useMemo(() => {
    const children = new Map<string, string[]>();
    const byId = new Map<string, Person>();

    for (const p of people) byId.set(p.id, p);

    for (const p of people) {
      if (!p.parentId) continue;
      const arr = children.get(p.parentId) || [];
      arr.push(p.id);
      children.set(p.parentId, arr);
    }

    function getDescendants(startId: string): string[] {
      const out: string[] = [];
      const stack = [...(children.get(startId) || [])];
      while (stack.length) {
        const id = stack.pop()!;
        out.push(id);
        const ch = children.get(id);
        if (ch?.length) stack.push(...ch);
      }
      return out;
    }

    return { byId, children, getDescendants };
  }, [people]);

  /**
   * Pod mode behavior:
   * - We do NOT insert pod nodes.
   * - We keep full hierarchy, but we let user choose a pod,
   *   and we auto-expand everyone in that pod (leaders + their subtrees),
   *   and visually show Pod as a badge.
   */
  const chartData = useMemo(() => {
    // same data for both modes (keep real hierarchy always)
    return people.map((p) => ({
      ...p,
      // d3-org-chart expects fields named id/parentId
      // we keep rest in data for nodeContent
    }));
  }, [people]);

  /**
   * Upload CSV (edit mode)
   */
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
      error: (err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
    });
  }

  /**
   * Render chart
   */
  useEffect(() => {
    if (!chartRef.current) return;

    if (!chartData.length) {
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
        .data(chartData)
        .nodeWidth(() => 360)
        .nodeHeight(() => 150) // prevent overlap with button
        .childrenMargin(() => 60)
        .compactMarginBetween(() => 40)
        .compactMarginPair(() => 90)
        // Button number = TOTAL descendants (not just direct children)
        .buttonContent((d: any) => {
          // d has .data.id
          const id = d?.data?.id as string;
          if (!id) return "";
          const allDesc = hierarchyIndex.getDescendants(id);

          if (mode === "pod" && selectedPod) {
            // count only descendants within selected pod
            const inPod = allDesc.filter((x) => hierarchyIndex.byId.get(x)?.pod === selectedPod);
            return `${inPod.length}`;
          }

          return `${allDesc.length}`;
        })
        // Fix button overlap a bit (move it down)
        .nodeUpdate(function (this: any, d: any) {
          // `this` is node group
          try {
            // move the expand button group slightly down
            // (safe: if selection/class names change, this just no-ops)
            const g = this.querySelector?.(".node-button-g");
            if (g) g.setAttribute("transform", "translate(0, 22)");
          } catch {}
        })
        .nodeContent((d: any) => {
          const p = d.data as any;

          const podBadge =
            p.pod && p.pod.trim()
              ? `
                <div style="
                  position:absolute; right:14px; top:12px;
                  font-size:12px;font-weight:900;
                  color:${LILAC}; background:${LILAC_BG};
                  border:1px solid rgba(109,40,217,0.25);
                  padding:4px 10px;border-radius:999px;
                  max-width:160px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
                ">
                  ${p.pod}
                </div>
              `
              : "";

          const img = p.photoUrl
            ? `<img src="${p.photoUrl}" crossorigin="anonymous"
                 style="width:72px;height:72px;border-radius:18px;object-fit:cover;border:1px solid rgba(0,0,0,0.10)" />`
            : `<div style="width:72px;height:72px;border-radius:18px;background:rgba(0,0,0,0.06);
                 display:flex;align-items:center;justify-content:center;font-weight:900;">
                 ${String(p.name).trim().slice(0, 1).toUpperCase()}
               </div>`;

          return `
            <div style="
              width:360px;height:150px;background:#fff;
              border:1px solid rgba(0,0,0,0.12);
              border-radius:22px;
              box-shadow:0 10px 26px rgba(0,0,0,0.07);
              padding:14px 14px 14px 14px;
              display:flex;gap:14px;align-items:center;
              position:relative;
              overflow:hidden;
            ">
              <div style="position:absolute;left:0;top:0;bottom:0;width:7px;background:${LILAC};"></div>
              ${podBadge}
              ${img}
              <div style="display:flex;flex-direction:column;gap:8px;min-width:0;flex:1;padding-right:10px;">
                <div style="
                  font-weight:950;font-size:22px;line-height:1.1;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.name}
                </div>

                <div style="
                  font-size:14px;font-weight:900;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.team || ""}
                </div>

                <div style="
                  font-size:14px;font-weight:800;color:#374151;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.location || ""}
                </div>

                <div style="
                  font-size:14px;font-weight:800;color:#6B7280;
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

      // POD MODE: auto-expand everyone in selected pod
      if (mode === "pod" && selectedPod) {
        try {
          // Expand all nodes that are in selected pod AND their ancestors (to make reachable)
          const inPodIds = people.filter((p) => p.pod === selectedPod).map((p) => p.id);
          const toExpand = new Set<string>();

          // Expand all ancestors of in-pod nodes
          for (const id of inPodIds) {
            let cur = hierarchyIndex.byId.get(id);
            while (cur?.parentId) {
              toExpand.add(cur.parentId);
              cur = hierarchyIndex.byId.get(cur.parentId);
            }
          }

          // Expand the in-pod managers too (so their children open)
          for (const id of inPodIds) toExpand.add(id);

          // best-effort API (depends on d3-org-chart version)
          if (typeof chart.setExpanded === "function") {
            for (const id of toExpand) chart.setExpanded(id, true);
            chart.render();
          } else if (typeof chart.expand === "function") {
            for (const id of toExpand) chart.expand(id);
          } else {
            // fallback
            chart.expandAll?.();
          }
        } catch {
          // ignore
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chartData, mode, selectedPod, hierarchyIndex, people]);

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
          onClick={() => setMode("hierarchy")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.12)",
            background: mode === "hierarchy" ? LILAC_BG : "white",
            fontWeight: 900,
          }}
        >
          Hierarchy
        </button>

        <button
          onClick={() => setMode("pod")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.12)",
            background: mode === "pod" ? LILAC_BG : "white",
            fontWeight: 900,
          }}
        >
          Pod
        </button>

        {mode === "pod" && (
          <select
            value={selectedPod}
            onChange={(e) => setSelectedPod(e.target.value)}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.12)",
              fontWeight: 800,
            }}
          >
            <option value="">Select pod…</option>
            {pods.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
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
        CSV headers accepted: Name/Full Name, Work Email/Email, Manager Email/Manager Work Email, Team/Department,
        Location/Country, Photo URL/Photo, Pod/POD.
      </div>
    </div>
  );
}
