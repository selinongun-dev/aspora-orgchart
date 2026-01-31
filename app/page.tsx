"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type RawRow = Record<string, string>;

type Row = {
  name: string;
  workEmail: string;
  managerEmail: string;
  team: string;
  location: string;
  photoUrl: string;
  pod: string;
};

type NodeData = {
  id: string;
  parentId: string | null;

  name: string;
  email: string;
  team: string;
  location: string;
  photoUrl: string;
  pod: string;

  isPod?: boolean;
  // for pod nodes
  podKey?: string;
  podTotal?: number;

  // org-chart internal toggles (works in d3-org-chart)
  _expanded?: boolean;
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
 * CSV header aliases:
 * - Name
 * - Work Email
 * - Manager Email
 * - Team
 * - Location
 * - Photo URL
 * - Pod (optional but supported)
 *
 * Senin sheet’te bazen şu kolonlar da olabiliyor:
 * - Job Title (biz kullanmıyoruz)
 * - Manager Name (biz kullanmıyoruz)
 */
function pick(row: RawRow, keys: string[]) {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== "") return String(row[k]);
  }
  return "";
}

function parseRows(raw: RawRow[]): Row[] {
  return raw.map((r) => {
    const name = pick(r, ["Name"]).trim();
    const workEmail = pick(r, ["Work Email", "Work email", "Email", "WorkEmail"]).trim();
    const managerEmail = pick(r, ["Manager Email", "Manager email", "ManagerEmail"]).trim();
    const team = pick(r, ["Team"]).trim();
    const location = pick(r, ["Location", "Country"]).trim();
    const photoUrl = pick(r, ["Photo URL", "Photo Url", "Photo", "Avatar"]).trim();
    const pod = pick(r, ["Pod", "POD"]).trim();

    return {
      name,
      workEmail,
      managerEmail,
      team,
      location,
      photoUrl,
      pod,
    };
  });
}

const LILAC = "#6D28D9";
const LILAC_BG = "#F5F3FF";

export default function Page() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [layout, setLayout] = useState<"hierarchy" | "pod">("hierarchy");
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");

  // edit mode: ?edit=1
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  // load CSV from /api/org
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
          complete: (res) => {
            const raw = (res.data || []) as RawRow[];
            const parsed = parseRows(raw);

            // basic validation: Name required
            const badIdx = parsed.findIndex((x) => !x.name);
            if (badIdx >= 0) {
              setError(`Row ${badIdx + 2} has empty values for: Name`);
              return;
            }

            setError("");
            setRows(parsed);
          },
          error: (err: unknown) =>
            setError(err instanceof Error ? err.message : String(err)),
        });
      })
      .catch(() => {
        // no CSV uploaded yet
      });
  }, []);

  // base hierarchy nodes (no pod grouping)
  const baseNodes = useMemo<NodeData[]>(() => {
    const built: NodeData[] = rows.map((r, i) => {
      const email = normalizeEmail(r.workEmail);
      const name = (r.name || "").trim();

      const id = email ? email : `name:${name.toLowerCase()}:${i}`;
      const parentId = normalizeEmail(r.managerEmail) || null;

      return {
        id,
        parentId,
        name: name || r.workEmail || "(no name)",
        email: r.workEmail || "",
        team: r.team || "",
        location: r.location || "",
        pod: r.pod || "",
        photoUrl:
          ensureHttps(r.photoUrl) ||
          `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
            name || "User"
          )}`,
      };
    });

    // If manager email not in dataset -> parentId null
    const ids = new Set(built.map((n) => n.id));
    return built.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));
  }, [rows]);

  // helper: find single root; if multiple roots create a super root
  const { hierarchyRootId, hierarchyNodesNormalized } = useMemo(() => {
    if (!baseNodes.length) return { hierarchyRootId: "", hierarchyNodesNormalized: [] as NodeData[] };

    const roots = baseNodes.filter((n) => !n.parentId);
    if (roots.length === 1) {
      return { hierarchyRootId: roots[0].id, hierarchyNodesNormalized: baseNodes };
    }

    const superRootId = "__root__";
    const superRoot: NodeData = {
      id: superRootId,
      parentId: null,
      name: "Aspora",
      email: "",
      team: "",
      location: "",
      pod: "",
      photoUrl: `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
        "Aspora"
      )}`,
    };

    const rewired = baseNodes.map((n) => (n.parentId ? n : { ...n, parentId: superRootId }));
    return { hierarchyRootId: superRootId, hierarchyNodesNormalized: [superRoot, ...rewired] };
  }, [baseNodes]);

  /**
   * POD VIEW:
   * - Pod nodes are children of the root.
   * - A person attaches to:
   *   - their manager if manager is in same pod
   *   - otherwise attaches to the pod node
   * This preserves hierarchy INSIDE the pod but groups by pod at top.
   * Also:
   * - NO "No Pod" node: we skip empty pod values.
   * - podTotal counts ALL people in that pod (not just direct children).
   */
  const podNodes = useMemo<NodeData[]>(() => {
    if (!hierarchyNodesNormalized.length) return [];

    const rootId = hierarchyRootId;

    // Only consider people nodes (exclude super root etc) as "non-pod nodes"
    const people = hierarchyNodesNormalized.filter((n) => !n.isPod && n.id !== "__root__");

    // map person id -> pod key
    const podOf = new Map<string, string>();
    for (const p of people) {
      const key = (p.pod || "").trim();
      podOf.set(p.id, key);
    }

    // build unique pods (non-empty only)
    const pods = Array.from(
      new Set(
        people
          .map((p) => (p.pod || "").trim())
          .filter((x) => x.length > 0)
      )
    ).sort((a, b) => a.localeCompare(b));

    // pod totals: total people per pod
    const podTotals = new Map<string, number>();
    for (const p of people) {
      const key = (p.pod || "").trim();
      if (!key) continue;
      podTotals.set(key, (podTotals.get(key) || 0) + 1);
    }

    // create pod nodes under root
    const podHeaderNodes: NodeData[] = pods.map((pod) => ({
      id: `pod:${pod.toLowerCase()}`,
      parentId: rootId,
      name: pod,
      email: "",
      team: "",
      location: "",
      pod,
      photoUrl: "",
      isPod: true,
      podKey: pod,
      podTotal: podTotals.get(pod) || 0,
      _expanded: false,
    }));

    // rewrite parentId for people nodes according to rule
    const peopleRewired: NodeData[] = people.map((p) => {
      const myPod = (p.pod || "").trim();
      if (!myPod) {
        // pod empty => keep original hierarchy (no pod grouping)
        return { ...p };
      }

      const mgrId = p.parentId;
      if (mgrId && (podOf.get(mgrId) || "").trim() === myPod) {
        // manager same pod => keep manager relationship
        return { ...p };
      }

      // manager different pod or null => attach to pod node
      return { ...p, parentId: `pod:${myPod.toLowerCase()}` };
    });

    // Also include root/super root nodes as-is (but not duplicated)
    const nonPeople = hierarchyNodesNormalized.filter((n) => !people.some((p) => p.id === n.id));
    const combined = [...nonPeople, ...podHeaderNodes, ...peopleRewired];

    // Ensure parentId references exist
    const ids = new Set(combined.map((n) => n.id));
    return combined.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));
  }, [hierarchyNodesNormalized, hierarchyRootId]);

  const activeNodes = layout === "pod" ? podNodes : hierarchyNodesNormalized;

  // Upload CSV (edit only)
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

    // reload
    const csv = await (await fetch("/api/org")).text();
    Papa.parse<RawRow>(csv, {
      header: true,
      skipEmptyLines: true,
      complete: (r) => {
        const parsed = parseRows((r.data || []) as RawRow[]);
        setRows(parsed);
      },
      error: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    });
  }

  // Render chart
  useEffect(() => {
    if (!chartRef.current) return;

    if (!activeNodes.length) {
      chartRef.current.innerHTML = "";
      return;
    }

    let cancelled = false;
    chartRef.current.innerHTML = "";

    (async () => {
      const mod = await import("d3-org-chart");
      const OrgChart = (mod as any).OrgChart;

      if (cancelled || !chartRef.current) return;

      const chart = new OrgChart()
        .container(chartRef.current)
        .data(activeNodes)
        .nodeWidth(() => 360)
        // IMPORTANT: extra height to prevent button badge overlapping text
        .nodeHeight((d: any) => (d.data?.isPod ? 110 : 160))
        .childrenMargin(() => 60)
        .compactMarginBetween(() => 40)
        .compactMarginPair(() => 90)
        // Custom expand/collapse button content:
        // - pod nodes show TOTAL people in pod
        // - others default behavior
        .nodeButtonContent((d: any) => {
          const isPod = !!d.data?.isPod;
          const total = isPod ? Number(d.data?.podTotal || 0) : null;

          // d3-org-chart passes "d" with children info; fallback to descendants count if available
          const defaultCount =
            typeof d?.childrenCount === "number"
              ? d.childrenCount
              : Array.isArray(d?.children)
              ? d.children.length
              : 0;

          const countToShow = isPod ? total : defaultCount;

          // show nothing if 0
          if (!countToShow) return "";

          return `
            <div style="
              background:#fff;border:1px solid rgba(0,0,0,0.15);
              border-radius:8px;padding:2px 7px;
              font-size:12px;font-weight:800;color:#111827;
              box-shadow:0 1px 6px rgba(0,0,0,0.06);
              transform: translateY(8px); /* push badge slightly down */
            ">
              ${countToShow}
            </div>
          `;
        })
        .nodeContent((d: any) => {
          const p: NodeData = d.data;

          // POD NODE
          if (p.isPod) {
            return `
              <div style="
                width:360px;height:110px;
                display:flex;align-items:center;justify-content:center;
              ">
                <div style="
                  width:360px;height:90px;background:${LILAC_BG};
                  border:1px solid rgba(0,0,0,0.10);
                  border-radius:18px;
                  box-shadow:0 6px 18px rgba(0,0,0,0.06);
                  display:flex;align-items:center;justify-content:center;
                  position:relative; overflow:hidden;
                ">
                  <div style="position:absolute;left:0;top:0;bottom:0;width:7px;background:${LILAC};"></div>
                  <div style="
                    font-weight:900;font-size:20px;color:#111827;
                    padding:0 16px; text-align:center;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:330px;
                  ">
                    ${p.name}
                  </div>
                </div>
              </div>
            `;
          }

          // PERSON NODE
          const img = p.photoUrl
            ? `<img src="${p.photoUrl}" crossorigin="anonymous"
                 style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid rgba(0,0,0,0.12)" />`
            : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                 display:flex;align-items:center;justify-content:center;font-weight:900;">
                 ${String(p.name).trim().slice(0, 1).toUpperCase()}
               </div>`;

          // Reserve bottom space for badge: outer 160px, inner card 135px
          return `
            <div style="width:360px;height:160px;display:flex;align-items:flex-start;justify-content:center;">
              <div style="
                width:360px;height:135px;background:#fff;border:1px solid rgba(0,0,0,0.12);
                border-radius:18px;box-shadow:0 4px 14px rgba(0,0,0,0.08);
                padding:14px;display:flex;gap:12px;align-items:center;
                position:relative; overflow:hidden;
              ">
                <div style="position:absolute;left:0;top:0;bottom:0;width:7px;background:${LILAC};opacity:0.95;"></div>

                <div style="margin-left:6px;">${img}</div>

                <div style="display:flex;flex-direction:column;gap:8px;min-width:0;flex:1;">

                  <div style="
                    font-weight:950;font-size:18px;line-height:1.15;color:#111827;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  ">
                    ${p.name}
                  </div>

                  <div style="
                    font-size:14px;font-weight:800;color:#111827;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  ">
                    ${p.team}
                  </div>

                  <div style="
                    font-size:13px;font-weight:800;color:#374151;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  ">
                    ${p.location}
                  </div>

                  <div style="
                    font-size:12px;font-weight:800;color:#6B7280;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  ">
                    ${p.email}
                  </div>

                </div>
              </div>
            </div>
          `;
        })
        .render();

      // POD click: toggle open/close WHOLE subtree at once
      // (engineering -> deep + everyone under deep opens automatically)
      chart.onNodeClick((d: any) => {
        const data: NodeData = d?.data;
        if (!data?.isPod) return;

        // Build adjacency from current activeNodes
        const byParent = new Map<string, string[]>();
        for (const n of activeNodes) {
          if (!n.parentId) continue;
          byParent.set(n.parentId, [...(byParent.get(n.parentId) || []), n.id]);
        }

        const collectDescendants = (startId: string) => {
          const out: string[] = [];
          const stack = [startId];
          while (stack.length) {
            const cur = stack.pop()!;
            const kids = byParent.get(cur) || [];
            for (const k of kids) {
              out.push(k);
              stack.push(k);
            }
          }
          return out;
        };

        const descendants = collectDescendants(data.id);

        // toggle state
        const nextExpanded = !data._expanded;

        // apply expanded state to pod node + all descendants
        const applyExpanded = (id: string, expanded: boolean) => {
          if (typeof (chart as any).setExpanded === "function") {
            (chart as any).setExpanded(id, expanded);
          } else {
            // fallback: mutate data
            const node = activeNodes.find((x) => x.id === id);
            if (node) node._expanded = expanded;
          }
        };

        applyExpanded(data.id, nextExpanded);
        for (const id of descendants) applyExpanded(id, nextExpanded);

        chart.render();
      });

      chartObjRef.current = chart;
    })();

    return () => {
      cancelled = true;
    };
  }, [activeNodes, layout, hierarchyRootId]);

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 12px 0" }}>
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

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={() => setLayout("hierarchy")}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.12)",
              background: layout === "hierarchy" ? LILAC_BG : "#fff",
              fontWeight: 900,
            }}
          >
            Hierarchy
          </button>
          <button
            onClick={() => setLayout("pod")}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.12)",
              background: layout === "pod" ? LILAC_BG : "#fff",
              fontWeight: 900,
            }}
          >
            Pod view
          </button>
        </div>

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

      <div style={{ marginTop: 10, opacity: 0.75, fontSize: 12 }}>
        CSV headers expected: Name, Work Email, Manager Email, Team, Location, Photo URL (optional: Pod)
      </div>
    </div>
  );
}
