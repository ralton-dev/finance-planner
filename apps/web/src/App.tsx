import { useEffect, useState } from "react";

interface ServiceStatus {
  name: string;
  ok: boolean;
}

/**
 * Phase 0 placeholder shell. Confirms the SPA builds and can reach the API BFF.
 * Real screens (overview, accounts, plan) arrive in later phases — see
 * plan/05-frontend.md and plan/08-roadmap.md.
 */
export function App() {
  const [api, setApi] = useState<ServiceStatus>({ name: "api", ok: false });

  useEffect(() => {
    fetch("/api/healthz")
      .then((res) => setApi({ name: "api", ok: res.ok }))
      .catch(() => setApi({ name: "api", ok: false }));
  }, []);

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 640,
        margin: "4rem auto",
        padding: "0 1rem",
      }}
    >
      <h1>Finance Planner</h1>
      <p>Plan your savings toward upcoming payments.</p>
      <p style={{ color: "#666" }}>
        Phase 0 foundation. API health:{" "}
        <strong style={{ color: api.ok ? "green" : "crimson" }}>
          {api.ok ? "reachable" : "unreachable"}
        </strong>
      </p>
    </main>
  );
}
