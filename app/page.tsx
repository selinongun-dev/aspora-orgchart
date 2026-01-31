"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type RawRow = Record<string, string | undefined>;

type PersonNode = {
  id: string;
  parentId: string | null;
  name: string;
  email: string;
  team: string;
  location: string;
  pod: string;
  photoUrl: string;
  isPod?: false;
  // d3-org-chart uses this for expansion state
  _expanded?: boolean;
};

type PodNode = {
  id: string; // e.g. "pod:Engineering"
  parentId: string | null;
  name: string; // e.g. "Engineering"
  isPod: true;
  podKey: string; // same as name but stable
  _expanded?: boolean;
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

// --- CSV header helpers (aliases) ---
function pick(row: RawRow, keys: string[]) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined) return v;
  }
  return "";
}

const COL = {
  name: ["Name", "Full Name", "Employee Name"],
  email: ["Work Email", "Email", "Work email", "Work Email Address"],
  mgrEmail: ["Manager Email", "Manager Work Email", "Manager email", "Reports To Email"],
  team: ["Team", "Department", "Function"],
  location: ["Location", "Country", "Office"],
  photo: ["Photo URL", "Photo", "PhotoURL", "Avatar", "Image"],
  pod: ["Pod", "POD", "Squad", "Tribe"],
};

export default function Page() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [layout, setLayout] = useState<"hierarchy" | "pod">("hierarchy");
  const [rows, setRows] = useState<RawRow[]>([]);
  const [error, setError] = useState<string>("");

  // edit mode: ?edit=1
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
    setLayout((params.get("view") as any) === "pod" ? "pod" : "hierarchy");
  }, []);

  // load CSV from server on first load
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
        // first run: no file yet (ok)
      });
  }, []);

  // build PERSON nodes (pure hierarchy)
  const personNodes: PersonNode[] = useMemo(() => {
    const built: PersonNode[] = rows.map((r, i) => {
      const name = String(pick(r, COL.name) || "").trim();
      const emailRaw = String(pick(r, COL.email) || "").trim();
      const mgrEmailRaw = String(pick(r, COL.mgrEmail) || "").trim();

      const team = String(pick(r, COL.team) || "").trim();
      const location = String(pick(r, COL.location) || "").trim();

      // IMPORTANT: pod only from Pod column (not team/title)
      const pod = String(pick(r, COL.pod) || "").trim() || "No Pod";

      const photoUrl =
        ensureHttps(String(pick(r, COL.photo) || "")) ||
        `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
          name || "User"
        )}`;

      const id = emailRaw
        ? normalizeEmail(emailRaw)
        : `name:${(name || "unknown").toLowerCase()}:${i}`;

      return {
        id,
        parentId: mgrEmailRaw ? normalizeEmail(mgrEmailRaw) : null,
        name: name || emailRaw || "(no name)",
        email: emailRaw,
        team,
        location,
        pod,
        photoUrl,
        isPod: false,
      };
    });

    // if managerId not found, make root
    const ids = new Set(built.map((n) => n.id));
    return built.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));
  }, [rows]);

  // --- counts for pod label on expand button ---
  const podCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of personNodes) {
      const key = p.pod || "No Pod";
      m.set(key, (m.get(key) || 0) + 1);
    }
    return m;
  }, [personNodes]);

  // POD view transform:
  // Create pod nodes under the top root (Parth),
  // then attach the "top-of-pod" people to pod node,
  // while keeping manager chains inside same pod intact.
  const podViewNodes: AnyNode[] = useMemo(() => {
    if (!personNodes.length) return [];

    const roots = personNodes.filter((p) => p.parentId === null);
    const topRoot = roots[0] || personNodes[0];

    // pod nodes
    const uniquePods = Array.from(
      new Set(personNodes.map((p) => p.pod || "No Pod"))
    ).sort((a, b) => a.localeCompare(b));

    const podNodes: PodNode[] = uniquePods.map((pod) => ({
      id: `pod:${pod}`,
      parentId: topRoot.id,
      name: pod,
      podKey: pod,
      isPod: true,
      _expanded: false, // start collapsed
    }));

    const idToPerson = new Map(personNodes.map((p) => [p.id, p]));
    const personIdToPodNodeId = (pod: string) => `pod:${pod || "No Pod"}`;

    const transformedPeople: PersonNode[] = personNodes.map((p) => {
      const myPod = p.pod || "No Pod";
      const mgr = p.parentId ? idToPerson.get(p.parentId) : null;

      // If no manager -> keep root as-is (Parth stays on top)
      if (!p.parentId) return p;

      // If manager exists AND manager is in SAME pod -> keep hierarchy link
      if (mgr && (mgr.pod || "No Pod") === myPod) {
        return p;
      }

      // Otherwise, attach this person under its pod node (top-of-pod)
      return {
        ...p,
        parentId: personIdToPodNodeId(myPod),
      };
    });

    // Ensure pod nodes exist even if topRoot itself has some pod
    // (topRoot stays root; pod nodes are under topRoot)
    return [...transformedPeople, ...podNodes];
  }, [personNodes]);

  // final nodes shown
  const nodes: AnyNode[] = useMemo(() => {
    return layout === "pod" ? podViewNodes : personNodes;
  }, [layout, podViewNodes, personNodes]);

  // helper: expand/collapse entire subtree for a node id
  function setExpandedSubtree(rootId: string, expanded: boolean) {
    const parentMap = new Map<string, string | null>();
    for (const n of nodes) parentMap.set(n.id, n.parentId ?? null);

    // build children map
    const children = new Map<string, string[]>();
    for (const n of nodes) {
      const pid = n.parentId ?? null;
      if (!pid) continue;
      if (!children.has(pid)) children.set(pid, []);
      children.get(pid)!.push(n.id);
    }

    const stack = [rootId];
    const desc = new Set<string>([rootId]);
    while (stack.length) {
      const cur = stack.pop()!;
      const kids = children.get(cur) || [];
      for (const k of kids) {
        if (!desc.has(k)) {
          desc.add(k);
          stack.push(k);
        }
      }
    }

    const newData = nodes.map((n) =>
      desc.has(n.id) ? { ...(n as any), _expanded: expanded } : n
    );

    const chart = chartObjRef.current;
    if (chart) {
      chart.data(newData).render();
    }
  }

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

      // expose a global handler for pod clicks (because nodeContent is HTML string)
      (window as any).__ocPodClick = (podNodeId: string) => {
        // toggle: if already expanded -> collapse subtree, else expand subtree
        // we detect current state by reading node in chart state
        const st = chartObjRef.current?.getChartState?.();
        const found = st?.allNodes?.find((x: any) => x.data?.id === podNodeId);
        const isExpanded = !!found?.data?._expanded;

        setExpandedSubtree(podNodeId, !isExpanded);
      };

      const LILAC = "#5B2CE6";
      const LILAC_BG = "#F4F1FF";

      const chart = new OrgChart()
        .container(chartRef.current)
        .data(nodes)
        .nodeWidth(() => (layout === "pod" ? 360 : 340))
        .nodeHeight((d: any) => (d.data.isPod ? 92 : 120))
        .childrenMargin(() => 50)
        .compactMarginBetween(() => 35)
        .compactMarginPair(() => 80)
        // customize expand button text: for pod nodes show TOTAL people in pod
        .buttonContent((d: any) => {
          const data = d.node.data;
          if (data?.isPod) {
            const podName = data.name as string;
            const total = podCounts.get(podName) || 0;
            return `<div style="
              padding:2px 8px;border-radius:8px;
              border:1px solid rgba(0,0,0,0.12);
              background:#fff;font-weight:800;font-size:12px;color:#111827;
            ">${total}</div>`;
          }

          // default-ish: show hidden descendants count
          const cnt = d.node.descendants().length - 1;
          if (cnt <= 0) return "";
          return `<div style="
            padding:2px 8px;border-radius:8px;
            border:1px solid rgba(0,0,0,0.12);
            background:#fff;font-weight:800;font-size:12px;color:#111827;
          ">${cnt}</div>`;
        })
        .nodeContent((d: any) => {
          const p = d.data as AnyNode;

          // POD node (clickable box, no "x people" text)
          if ((p as any).isPod) {
            const podId = p.id;
            return `
              <div onclick="window.__ocPodClick('${podId}')"
                style="
                  cursor:pointer;
                  width:360px;height:92px;background:${LILAC_BG};
                  border:1px solid rgba(0,0,0,0.10);
                  border-radius:18px;box-shadow:0 6px 18px rgba(0,0,0,0.06);
                  display:flex;align-items:center;justify-content:center;
                  position:relative; overflow:hidden;
                ">
                <div style="position:absolute;left:0;top:0;bottom:0;width:6px;background:${LILAC};"></div>
                <div style="
                  font-weight:900;font-size:20px;color:#111827;
                  padding:0 16px; text-align:center;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px;
                ">
                  ${(p as any).name}
                </div>
              </div>
            `;
          }

          // PERSON node
          const person = p as PersonNode;

          const img = person.photoUrl
            ? `<img src="${person.photoUrl}" crossorigin="anonymous"
                 style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid rgba(0,0,0,0.12)" />`
            : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                 display:flex;align-items:center;justify-content:center;font-weight:900;">
                 ${String(person.name).trim().slice(0, 1).toUpperCase()}
               </div>`;

          // NOTE: Pod badge removed from person card (you wanted only 4 lines)
          return `
            <div style="
              width:340px;height:120px;background:#fff;border:1px solid rgba(0,0,0,0.14);
              border-radius:18px;box-shadow:0 6px 18px rgba(0,0,0,0.06);
              padding:12px;display:flex;gap:12px;align-items:center;
              position:relative; overflow:hidden;
            ">
              <div style="position:absolute;left:0;top:0;bottom:0;width:6px;background:${LILAC};"></div>

              ${img}

              <div style="display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;">
                <div style="
                  font-weight:900;font-size:16px;line-height:1.15;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${person.name}
                </div>

                <div style="
                  font-size:13px;font-weight:800;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${person.team}
                </div>

                <div style="
                  font-size:12px;font-weight:800;color:#374151;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${person.location}
                </div>

                <div style="
                  font-size:12px;font-weight:800;color:#6B7280;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${person.email}
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
  }, [nodes, layout, podCounts]);

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
    Papa.parse<RawRow>(csv, {
      header: true,
      skipEmptyLines: true,
      complete: (r) => setRows((r.data || []) as RawRow[]),
      error: (err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
    });
  }

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 16px 0" }}>
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
          onClick={() => setLayout("hierarchy")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.15)",
            background: layout === "hierarchy" ? "#F4F1FF" : "#fff",
            fontWeight: 800,
          }}
        >
          Hierarchy
        </button>

        <button
          onClick={() => setLayout("pod")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.15)",
            background: layout === "pod" ? "#F4F1FF" : "#fff",
            fontWeight: 800,
          }}
        >
          Pod View
        </button>

        <span style={{ width: 10 }} />

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
        CSV columns supported: Name, Work Email, Manager Email, Team, Location, Photo URL, Pod (optional but recommended).
      </div>
    </div>
  );
}

